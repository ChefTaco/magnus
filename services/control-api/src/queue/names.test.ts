import { expect, it } from 'vitest';
import { bullQueueIdentity } from './names.js';
it('preserves retained job key namespaces while using colon-free BullMQ queue names', () => {
  for (const namespace of ['', 'magnus-', 'magnus:', 'suite:installation:', 'custom'])
    for (const queue of ['commands', 'webhooks']) {
      const identity = bullQueueIdentity(namespace, queue);
      expect(identity.name).not.toContain(':');
      for (const suffix of ['wait', 'active', 'completed', 'failed', 'id', 'synthetic-job'])
        expect(identity.prefix + ':' + identity.name + ':' + suffix).toBe(
          'bull:' + namespace + queue + ':' + suffix,
        );
    }
});
