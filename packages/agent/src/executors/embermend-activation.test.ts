import { describe, it, expect } from 'vitest';
import { packageActivation, type ActivationSystem } from './embermend-activation.js';

const path = '/usr/lib/libfixture.so.1';
const mapping = (inode = '22', suffix = '', device = '08:01', file = path): string => `7f0000-7f1000 r-xp 00000000 ${device} ${inode} ${file}${suffix}\n`;
function fixture(): ActivationSystem {
  return { metadata: async () => ({ version: '1.0-2', paths: ['/lib/libfixture.so.1'] }), file: async () => ({ path, device: '8:1', inode: '22' }), pids: async () => [42], identity: async () => '100', maps: async () => mapping(), now: () => 0 };
}
describe('bounded userspace package mapping evidence', () => {
  it('binds mappings to canonical installed file identity and stable process start time', async () => {
    const host = fixture(); host.maps = async () => mapping() + mapping();
    const result = await packageActivation(['fixture-library', 'fixture-library'], host);
    expect(result.coverage).toBe('complete'); expect(result.state).toBe('no-stale-mappings-observed');
    expect(result.requestedPackages).toEqual(['fixture-library']); expect(result.packages[0]?.consumers).toEqual([{ pid: 42, processStartTicks: '100', path, mappedDevice: '8:1', mappedInode: '22', installedDevice: '8:1', installedInode: '22', state: 'current' }]);
    expect(result.scope).toContain('not kernel, firmware, cached interpreted code');
  });
  it('accepts actual anonymous map rows whose empty pathname is one trailing space', async () => {
    const host = fixture(); host.maps = async () => mapping() + '77fe7c111000-77fe7c114000 rw-p 00000000 00:00 0 \n' + '77fe7c111000-77fe7c114000 rw-p 00000000 00:00 0\n';
    const result = await packageActivation(['fixture-library'], host); expect(result.coverage).toBe('complete'); expect(result.packages[0]?.consumers).toHaveLength(1);
  });
  it.each([mapping('21', ' (deleted)'), mapping('21'), mapping('22', '', '08:02')])('detects old/deleted mappings and inode/device changes', async maps => {
    const host = fixture(); host.maps = async () => maps;
    const result = await packageActivation(['fixture-library'], host); expect(result.coverage).toBe('complete'); expect(result.state).toBe('stale-mappings-observed'); expect(result.packages[0]?.consumers[0]?.state).toBe('stale');
  });
  it('does not attribute a removed old path to a guessed package or expose unrelated private paths', async () => {
    const host = fixture(); host.maps = async () => mapping('21', ' (deleted)', '08:01', '/home/operator/private-fixture.bin');
    const result = await packageActivation(['fixture-library'], host); expect(result.coverage).toBe('partial'); expect(result.state).toBe('unknown'); expect(result.failures).toContain('UNATTRIBUTED_DELETED_MAPPING:42'); expect(JSON.stringify(result)).not.toContain('/home/operator');
  });
  it('keeps unreadable or malformed process coverage partial without returning error text', async () => {
    for (const mode of ['denied', 'malformed', 'truncated']) {
      const host = fixture(); host.maps = async () => { if (mode === 'denied') throw Object.assign(new Error('private fixture detail'), { code: 'EACCES' }); return mode === 'malformed' ? 'unsupported map row' : 'a'.repeat(262145); };
      const result = await packageActivation(['fixture-library'], host); expect(result.coverage).toBe('partial'); expect(result.state).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('private fixture detail');
    }
  });
  it('tolerates exited processes but refuses PID replacement and new unexamined processes', async () => {
    const exited = fixture(); let calls = 0; exited.pids = async () => ++calls === 1 ? [42] : []; exited.maps = async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
    const gone = await packageActivation(['fixture-library'], exited); expect(gone.coverage).toBe('complete'); expect(gone.disappearedProcesses).toBe(1);
    const replaced = fixture(); let reads = 0; replaced.identity = async () => String(++reads); expect((await packageActivation(['fixture-library'], replaced)).coverage).toBe('partial');
    const added = fixture(); let inventories = 0; added.pids = async () => ++inventories === 1 ? [42] : [42, 43]; expect((await packageActivation(['fixture-library'], added)).failures).toContain('NEW_UNEXAMINED_PROCESS');
    const recycled = fixture(); let identities = 0; recycled.identity = async () => ++identities < 3 ? '100' : '101'; expect((await packageActivation(['fixture-library'], recycled)).failures).toContain('PROCESS_IDENTITY_CHANGED:42');
  });
  it('refuses a snapshot whose installed package identity changes during observation', async () => {
    const host = fixture(); let reads = 0; host.metadata = async () => ({ version: ++reads === 1 ? '1.0-2' : '1.0-3', paths: [path] });
    const result = await packageActivation(['fixture-library'], host); expect(result.coverage).toBe('partial'); expect(result.failures).toContain('PACKAGE_CHANGED_DURING_OBSERVATION:fixture-library');
  });
  it('bounds process/consumer output and declares incomplete or absent requested coverage', async () => {
    const host = fixture(); host.pids = async () => Array.from({ length: 300 }, (_, index) => index + 1);
    const result = await packageActivation(['fixture-library'], host); expect(result.coverage).toBe('partial'); expect(result.packages[0]?.consumers).toHaveLength(256); expect(result.failures).toContain('CONSUMER_EVIDENCE_LIMIT');
    const empty = await packageActivation([], fixture()); expect(empty.coverage).toBe('partial'); expect(empty.failures).toContain('NO_PACKAGES_REQUESTED');
    const missing = fixture(); missing.metadata = async () => { throw new Error('missing package'); }; expect((await packageActivation(['fixture-library'], missing)).state).toBe('unknown');
    const malformed = fixture(); malformed.metadata = async () => ({ version: 'untrusted\nmetadata', paths: [path] }); expect((await packageActivation(['fixture-library'], malformed)).failures).toContain('PACKAGE_METADATA_UNAVAILABLE:fixture-library');
    const limited = fixture(); let time = 0; limited.now = () => time += 6000; expect((await packageActivation(['fixture-library'], limited)).failures).toContain('ACTIVATION_TIME_LIMIT');
  });
  it('retains requested package scope when package, file or process bounds truncate examination', async () => {
    const many = await packageActivation(Array.from({ length: 33 }, (_, index) => `fixture-${index}`), fixture()); expect(many.requestedPackages).toHaveLength(33); expect(many.packages).toHaveLength(32); expect(many.failures).toContain('PACKAGE_COUNT_LIMIT');
    const files = fixture(); files.metadata = async () => ({ version: '1.0', paths: Array.from({ length: 4097 }, (_, index) => `/usr/lib/fixture-${index}`) }); expect((await packageActivation(['fixture-library'], files)).failures).toContain('PACKAGE_FILE_LIMIT:fixture-library');
    const processes = fixture(); processes.pids = async () => Array.from({ length: 8193 }, (_, index) => index + 1); expect((await packageActivation(['fixture-library'], processes)).failures).toContain('PROCESS_COUNT_LIMIT');
    const bytes = fixture(); const longPath = '/usr/lib/' + 'a'.repeat(490); bytes.file = async () => ({ path: longPath, device: '8:1', inode: '22' }); bytes.maps = async () => mapping('22', '', '08:01', longPath); bytes.pids = async () => Array.from({ length: 200 }, (_, index) => index + 1); const limited = await packageActivation(['fixture-library'], bytes); expect(limited.failures).toContain('CONSUMER_EVIDENCE_LIMIT'); expect(limited.packages[0]?.consumers.length).toBeLessThan(200);
  });
  it('keeps ambiguous procfs path encodings unsupported instead of hiding stale consumers', async () => {
    for (const file of ['/usr/lib/fixture\\012.so', '/usr/lib/fixture (deleted)', '/usr/lib/fixture\n.so']) {
      const host = fixture(); host.metadata = async () => ({ version: '1.0-2', paths: [file] });
      const result = await packageActivation(['fixture-library'], host); expect(result.coverage).toBe('partial'); expect(result.failures).toContain('UNSUPPORTED_PACKAGE_PATH:fixture-library');
    }
  });
});
