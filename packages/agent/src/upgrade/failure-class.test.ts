import { describe, expect, it } from 'vitest';
import { cleanPackageText, npmFailureCode } from './self-upgrade.js';

describe('npm failure class comes only from npm itself', () => {
  it.each([
    ['a script that prints permission denied', 'npm error code 1\nnpm error path /x\nnpm error command failed\nnpm error command sh -c node install.js\nnpm error sh: 1: ./install: Permission denied'],
    ['a script that dies fetching a prebuilt', 'npm error code 1\nnpm error command sh -c node fetch.js\nnpm error Error: getaddrinfo ENOTFOUND example.invalid'],
    ['a script that says ENOSPC', 'npm error code 1\nnpm error ENOSPC: lol'],
    ['ELIFECYCLE with EACCES in its output', 'npm error code ELIFECYCLE\nEACCES: permission denied'],
    ['a script that forges npm\'s own line after the real one', 'npm error code 1\nnpm error command sh -c x\nnpm error code ENOSPC'],
    ['text with no npm code at all', 'ENOSPC: no space left on device\nECONNRESET\npermission denied'],
    ['a package fault', 'npm error code EINTEGRITY'],
    ['an unresolvable tree', 'npm error code ERESOLVE'],
    ['nothing', ''],
  ])('%s is a package fault', (_name, output) => expect(npmFailureCode(output)).toBe('SELF_UPGRADE_FAILED'));

  it.each([
    ['npm error code ENOSPC', 'SELF_UPGRADE_ENV_DISK'],
    ['npm ERR! code ENOSPC', 'SELF_UPGRADE_ENV_DISK'],
    ['npm warn tar TAR_ENTRY_ERROR ENOSPC: no space left on device, write', 'SELF_UPGRADE_ENV_DISK'],
    ['npm error code EIO', 'SELF_UPGRADE_ENV_DISK'],
    ['npm error code EACCES', 'SELF_UPGRADE_ENV_ACCESS'],
    ['npm error code ECONNRESET', 'SELF_UPGRADE_ENV_NETWORK'],
    ['npm error code EAI_FAIL', 'SELF_UPGRADE_ENV_NETWORK'],
    ['npm error network request to x failed, reason: read ECONNRESET', 'SELF_UPGRADE_ENV_NETWORK'],
    ['npm error code CERT_NOT_YET_VALID\nnpm error request to https://registry.example.com failed', 'SELF_UPGRADE_ENV_TLS'],
    ['npm error code CERT_HAS_EXPIRED', 'SELF_UPGRADE_ENV_TLS'],
    ['npm error code SELF_SIGNED_CERT_IN_CHAIN', 'SELF_UPGRADE_ENV_TLS'],
    ['npm error code UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_UPGRADE_ENV_TLS'],
    ['npm error code ENOMEM', 'SELF_UPGRADE_ENV_RESOURCE'],
    ['npm error code EBUSY', 'SELF_UPGRADE_ENV_RESOURCE'],
    ['npm error code E401', 'SELF_UPGRADE_ENV_AUTH'],
    ['npm error code E403', 'SELF_UPGRADE_ENV_AUTH'],
  ])('%s is the node', (output, code) => expect(npmFailureCode(output)).toBe(code));

  it('reads the first code line only: npm prints its own before any script output', () => {
    expect(npmFailureCode('npm error code ENOSPC\nnpm error code 1')).toBe('SELF_UPGRADE_ENV_DISK');
    expect(npmFailureCode('npm error code ENOSPC\nnpm error command sh -c x')).toBe('SELF_UPGRADE_FAILED');
  });

  it('recognises a killed npm by how the process ended, never by its output', () => {
    expect(npmFailureCode('Killed', {})).toBe('SELF_UPGRADE_FAILED');
    expect(npmFailureCode('', { signal: 'SIGKILL' })).toBe('SELF_UPGRADE_ENV_RESOURCE');
    expect(npmFailureCode('', { exitCode: 137 })).toBe('SELF_UPGRADE_ENV_RESOURCE');
    expect(npmFailureCode('npm error code E404', { signal: 'SIGKILL' })).toBe('SELF_UPGRADE_ENV_RESOURCE');
    expect(npmFailureCode('', { exitCode: 1 })).toBe('SELF_UPGRADE_FAILED');
  });

  it('lets a full disk beat tar and JSON parse errors, by measuring it and not by reading text', () => {
    const output = 'npm error code EJSONPARSE\nENOSPC: no space left on device';
    expect(npmFailureCode(output)).toBe('SELF_UPGRADE_FAILED');
    expect(npmFailureCode(output, { diskLow: true })).toBe('SELF_UPGRADE_ENV_DISK');
    expect(npmFailureCode('npm error code TAR_BAD_ARCHIVE', { diskLow: true })).toBe('SELF_UPGRADE_ENV_DISK');
    expect(npmFailureCode('npm error code EINTEGRITY', { diskLow: true })).toBe('SELF_UPGRADE_ENV_DISK');
    // A script failure stays the package's, whatever the disk says.
    expect(npmFailureCode('npm error code 1\nnpm error command sh -c x', { diskLow: true })).toBe('SELF_UPGRADE_FAILED');
  });
});

describe('package text', () => {
  it('strips control characters and clips', () => {
    expect(cleanPackageText('a\u001b[31mred\u0007\r\nb\tc', 100)).toBe('a[31mred b c');
    expect(cleanPackageText('x'.repeat(50), 10)).toHaveLength(10);
  });
});
