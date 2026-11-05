import { describe, expect, it } from 'vitest';
import { cronJobForRole, environmentKeys, hermesProfileForRole, mergeEnvironmentEdit, nodeForRole, nodeMetadataForRole } from './secret-views.js';

describe('secret views', () => {
  it('reads key names from malformed or non-object input safely', () => {
    expect(environmentKeys('{"B":"1","A":"2"}')).toEqual(['A', 'B']);
    expect(environmentKeys('not json')).toEqual([]);
    expect(environmentKeys('["A"]')).toEqual([]);
  });

  it('merges a redacted edit without losing a value', () => {
    expect(mergeEnvironmentEdit('{"A":"1","B":"2"}', {})).toEqual({ A: '1', B: '2' });
    expect(mergeEnvironmentEdit('{"A":"1"}', { A: '' })).toEqual({ A: '1' });
    expect(mergeEnvironmentEdit('{"A":"1"}', { A: 'x', C: '' })).toEqual({ A: 'x', C: '' });
    expect(mergeEnvironmentEdit('not json', { A: 'x' })).toEqual({ A: 'x' });
  });

  it.each(['VIEWER', 'OPERATOR'] as const)('removes the fingerprint and keeps the state for %s', (role) => {
    const metadata = JSON.stringify({ nodeManagerSecretFingerprint: 'fp', nodeManagerSecretState: 'previous', other: 1 });
    expect(JSON.parse(nodeMetadataForRole(metadata, role))).toEqual({ nodeManagerSecretState: 'previous', other: 1 });
  });

  it('leaves ADMIN metadata unchanged', () => {
    const metadata = '{"nodeManagerSecretFingerprint":"fp"}';
    expect(nodeMetadataForRole(metadata, 'ADMIN')).toBe(metadata);
  });

  it.each(['VIEWER', 'OPERATOR', 'ADMIN'] as const)('never carries a node token for %s', (role) => {
    expect(nodeForRole({ id: 'n', token: 'secret', metadata: '{}' }, role)).toEqual({ id: 'n', metadata: '{}' });
  });

  it('shows cron values to ADMIN only', () => {
    const job = { id: 'c', environment: '{"K":"v"}' };
    expect(cronJobForRole(job, 'ADMIN')).toEqual({ id: 'c', environment: '{"K":"v"}', environmentKeys: ['K'] });
    expect(cronJobForRole(job, 'OPERATOR')).toEqual({ id: 'c', environmentKeys: ['K'] });
  });

  it('shows a Hermes key fingerprint to ADMIN only', () => {
    expect(hermesProfileForRole({ id: 'p', apiServerKeyFingerprint: 'fp' }, 'VIEWER')).toEqual({ id: 'p', apiServerKeyConfigured: true });
    expect(hermesProfileForRole({ id: 'p', apiServerKeyFingerprint: 'fp' }, 'ADMIN')).toEqual({ id: 'p', apiServerKeyFingerprint: 'fp', apiServerKeyConfigured: true });
    expect(hermesProfileForRole({ id: 'p', apiServerKeyFingerprint: null }, 'VIEWER')).toEqual({ id: 'p', apiServerKeyConfigured: false });
  });
});
