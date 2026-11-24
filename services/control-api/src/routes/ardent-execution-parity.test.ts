import { describe, expect, it } from 'vitest';
import { parseExecutionContext } from '@hivemagnus/hive-common/execution';
import { parseArdentExecutionContext } from '@hivemagnus/magnus-contracts';

// The node agent reads execution contexts with the contracts' copy of hive-common's rules; both must agree.
describe('execution context parity between hive-common and the contracts', () => {
  const root = 'hx1:studio:inst-1:request:req-1';
  const cases: unknown[] = [
    { v: 1, root },
    { v: 1, root, request_id: 'req@1/+=', parent: 'hx1:ardent:node-1.lead:task:00000000-0000-4000-8000-000000000001', self: 'hx1:studio:inst-1:step:req-1/2',
      inputs: [root], attempt: 3, deadline_ms: 4_102_444_800_000, extra: 'dropped' },
    { v: 1, root, inputs: [] },
    { v: 1, root, attempt: 0 }, { v: 1, root, attempt: 1_000_001 }, { v: 1, root, attempt: 1.5 }, { v: 1, root, deadline_ms: -1 },
    { v: 1, root, inputs: Array(17).fill(root) }, { v: 1, root, inputs: ['nope'] },
    { v: 1, root: 'hx1:studio:inst-1:bogus:id' }, { v: 1, root: `hx1:studio:inst-1:request:${'x'.repeat(129)}` },
    { v: 1, root: 'hx1:Studio:inst-1:request:req-1' }, { v: 1, root: 'hx1:studio:inst 1:request:req-1' },
    { v: 1, root, request_id: 'bad id' }, { v: 1, root, request_id: 'x'.repeat(129) },
    { v: 2, root }, { v: '1', root }, { root }, null, 'text', 7, [], { v: 1, root, self: 'nope' },
  ];
  it.each(cases.map(value => [JSON.stringify(value)?.slice(0, 80), value]))('%s', (_label, value) => {
    expect(parseArdentExecutionContext(value)).toEqual(parseExecutionContext(value));
  });
});
