#!/usr/bin/env node
import { createInterface } from 'node:readline';

if (process.argv.includes('--version')) { console.log('codex-cli 0.157.1'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let model;
let effort;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!message.id) continue;
  const reply = result => send({ id: message.id, result });
  if (process.env.NODE_MANAGER_SECRET || process.env.RESULT_SIGNING_SECRET || process.env.COMMAND_RECONCILIATION_SECRET)
    throw new Error('Agent credentials reached the owner fixture');
  if (message.method === 'initialize') reply({ userAgent: 'synthetic-context-fixture' });
  else if (message.method === 'account/read') reply({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
  else if (message.method === 'model/list') reply({ data: [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: null });
  else if (message.method === 'config/read') reply({ config: { mcp_servers: {}, features: Object.fromEntries([
    'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'image_generation',
    'in_app_browser', 'multi_agent', 'multi_agent_v2', 'view_image'].map(key => [key, false])) } });
  else if (message.method === 'thread/start') {
    if (message.params.dynamicTools?.length) throw new Error('Acceptance advertised tools');
    model = message.params.model; effort = message.params.config?.model_reasoning_effort;
    reply({ thread: { id: 'fixture-thread' } });
  } else if (message.method === 'thread/read') reply({ thread: { model, reasoningEffort: effort } });
  else if (message.method === 'turn/start') {
    const prompt = message.params.input.find(part => part.type === 'text').text;
    const input = JSON.parse(prompt);
    const answer = input.exchanges ? { items: [{ kind: 'correction', text: 'Reference Ω-42 uses the monthly schedule. Verification is pending. Delivery is unknown.',
      source_message_ids: [input.exchanges[0].user.id], historical_status: 'historical_unverified' }] }
      : { reference: 'Ω-42', schedule: 'monthly', verification: 'pending', delivery: 'unknown' };
    reply({ turn: { id: 'fixture-turn' } });
    send({ method: 'item/completed', params: { threadId: 'fixture-thread', turnId: 'fixture-turn',
      item: { type: 'agentMessage', id: 'fixture-answer', text: JSON.stringify(answer), phase: 'final_answer' } } });
    send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed', error: null } } });
  } else send({ id: message.id, error: { code: -32601, message: 'Unsupported fixture operation' } });
}
