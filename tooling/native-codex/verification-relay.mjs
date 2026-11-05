// Ephemeral verification transport, never an inference service. The selected
// external HTTPS provider owns generation. No native tool call can cross back.
import { createServer } from 'node:http';
import { request } from 'node:https';
import { rootCertificates } from 'node:tls';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
const limit = 1024 * 1024;
const eventTypes = new Set(['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed', 'response.reasoning_summary_part.added', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_summary_part.done']);
export function safeVerificationEvent(event) {
  const safeItem = item => item && (item.type === 'reasoning' || item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content) && item.content.every(part => part.type === 'output_text' && typeof part.text === 'string'));
  return event && eventTypes.has(event.type) && (!event.item || safeItem(event.item)) && (!event.response?.output || Array.isArray(event.response.output) && event.response.output.every(safeItem)) && (!event.part || ['output_text', 'summary_text'].includes(event.part.type));
}
export async function verificationRelay({ selected, env, expected }) {
  const capability = randomBytes(32).toString('hex'), ca = [...rootCertificates];
  for (const path of new Set(['CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'].map(name => env[name]).filter(Boolean))) ca.push(await readFile(path, 'utf8'));
  const requests = new Set(); let closed = false;
  let attempts = 0, deltas = '', completed = false, failure = false;
  const server = createServer(async (incoming, outgoing) => {
    let upstream;
    const fail = () => { if (closed) return; failure = true; upstream?.destroy(); if (!outgoing.headersSent) outgoing.writeHead(502).end(); else outgoing.destroy(); };
    try {
      if (incoming.method !== 'POST' || incoming.url !== '/v1/responses' || incoming.headers.authorization !== 'Bearer ' + capability || attempts !== 0) { outgoing.writeHead(403).end(); return; }
      attempts++;
      const chunks = []; let size = 0;
      for await (const bytes of incoming) { size += bytes.length; if (size > limit) throw Error('bounded request'); chunks.push(bytes); }
      let raw = Buffer.concat(chunks);
      if (incoming.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw, { maxOutputLength: limit });
      else if (incoming.headers['content-encoding'] === 'zstd') raw = zstdDecompressSync(raw, { maxOutputLength: limit });
      else if (incoming.headers['content-encoding']) throw Error('unsupported encoding');
      const body = JSON.parse(raw.toString());
      if (body.model !== selected.model || body.stream !== true) throw Error('unexpected model request');
      body.tools = []; body.tool_choice = 'none'; body.parallel_tool_calls = false; body.max_output_tokens = 128;
      const target = new URL(selected.baseURL.replace(/\/$/, '') + '/responses');
      const data = JSON.stringify(body);
      upstream = request(target, { method: 'POST', ca, rejectUnauthorized: true, headers: { Authorization: 'Bearer ' + env[selected.envKey], 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(data) } }, response => {
        if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('text/event-stream')) { response.resume(); fail(); return; }
        const decoder = new StringDecoder('utf8'); let buffered = '', received = 0;
        response.on('data', bytes => {
          try {
            received += bytes.length; if (received > limit) throw Error('bounded response'); buffered += decoder.write(bytes);
            let separator;
            while ((separator = /\r?\n\r?\n/.exec(buffered))) {
              const rawEvent = buffered.slice(0, separator.index); buffered = buffered.slice(separator.index + separator[0].length);
              const payload = rawEvent.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (!payload || payload === '[DONE]' && completed) continue;
              const event = JSON.parse(payload); if (!safeVerificationEvent(event) || completed) throw Error('unsafe model event');
              if (event.type === 'response.output_text.delta') { if (typeof event.delta !== 'string') throw Error('invalid text delta'); deltas += event.delta; if (deltas.length > 128) throw Error('unbounded answer'); }
              if (event.type === 'response.completed') {
                const output = event.response?.output?.filter(item => item.type === 'message') ?? [];
                if (output.length !== 1 || output[0].content.map(part => part.text).join('') !== expected || deltas !== expected || event.response.status !== 'completed') throw Error('unexpected completion'); completed = true;
              }
              if (!outgoing.headersSent) outgoing.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
              outgoing.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
            }
          } catch { fail(); }
        });
        response.on('error', fail);
        response.on('end', () => { if (!completed || failure || buffered.trim()) fail(); else outgoing.end(); });
      });
      requests.add(upstream); upstream.once('close', () => requests.delete(upstream));
      upstream.setTimeout(10000, fail); upstream.on('error', fail); upstream.end(data);
    } catch { fail(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 2;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, capability,
    verified: () => attempts === 1 && completed && deltas === expected && !failure,
    close: async () => { closed = true; for (const request of requests) request.destroy(); server.closeAllConnections(); await new Promise(done => server.close(done)); } };
}
