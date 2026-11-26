import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as root from '../dist/index.js';
import * as browser from '../dist/browser.js';

test('the root and browser entry points export one definition of each shared server shape', () => {
  for (const name of ['apiErrorSchema', 'dependencyHealthSchema', 'fleetReadinessNodeSchema', 'incidentSummarySchema', 'timelineItemSchema'])
    assert.equal(root[name], browser[name], name);
  assert.equal(root.dependencyHealthItemSchema, browser.dependencyHealthCheckSchema);
});

test('the shared shapes accept what the server sends', () => {
  // ops routes send errors without a code; HttpError adds details.
  assert.ok(root.apiErrorSchema.safeParse({ success: false, error: { message: 'Not configured' } }).success);
  assert.deepEqual(root.apiErrorSchema.parse({ success: false, error: { code: 'X', message: 'm', details: { a: 1 } } }).error.details, { a: 1 });
  // Timeline items name no node for deploys and null for a missing source column.
  assert.ok(root.timelineItemSchema.safeParse({ type: 'deploy', severity: 'info', title: 't', timestamp: '2026-01-01T00:00:00Z', href: '/x' }).success);
  assert.ok(root.timelineItemSchema.safeParse({ type: 'log', severity: 'info', title: 't', node: null, timestamp: '2026-01-01T00:00:00Z', href: '/x' }).success);
  assert.equal(root.timelineItemSchema.safeParse({ type: 'unknown', severity: 'info', title: 't', timestamp: 'x', href: '/x' }).success, false);
});
