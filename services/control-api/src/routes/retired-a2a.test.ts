import { describe, expect, it } from 'vitest';
import { app } from '../server.js';
import { executeAiTool } from '../services/ai-tools.js';

describe('retired Control API A2A', () => {
  it.each([
    ['POST', '/a2a/tasks/send'],
    ['GET', '/a2a/tasks/old-task'],
    ['GET', '/a2a/tasks/old-task/stream'],
    ['GET', '/.well-known/agent.json'],
    ['GET', '/.well-known/agent-card.json'],
  ])('does not serve %s %s', async (method, path) => {
    const response = await app.request(path!, { method });
    expect(response.status).toBe(404);
  });

  it('cannot dispatch the retired outbound tool', async () => {
    const result = await executeAiTool({ name: 'delegateToAgent', arguments: {} });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown tool: delegateToAgent');
  });
});
