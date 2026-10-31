import { dashboardDrainReceipt } from '../../../../../../runtime-resource-participant.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request): Promise<Response> {
  try {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: 'Invalid drain request' }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return Response.json({ error: 'Invalid drain request' }, { status: 413 }); }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const receipt = await dashboardDrainReceipt(JSON.parse(body), request.headers.get('x-resource-drain-key') ?? '');
    return Response.json(receipt, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ error: 'Drain proof unavailable' }, { status: 403, headers: { 'cache-control': 'no-store' } });
  }
}
