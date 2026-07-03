import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveKtxConfigReference, resolveKtxHomePath } from '../../../src/context/core/config-reference.js';
import { KtxExpectedError } from '../../../src/errors.js';

describe('ktx config references', () => {
  it('resolves env references without returning empty values', () => {
    expect(resolveKtxConfigReference('env:AI_GATEWAY_API_KEY', { AI_GATEWAY_API_KEY: ' gateway-key ' })).toBe(
      'gateway-key',
    );
    expect(resolveKtxConfigReference('env:AI_GATEWAY_API_KEY', { AI_GATEWAY_API_KEY: '   ' })).toBeUndefined();
    expect(resolveKtxConfigReference('env:AI_GATEWAY_API_KEY', {})).toBeUndefined();
  });

  it('resolves file references and trims file content', async () => {
    const dir = join(tmpdir(), `ktx-config-reference-${process.pid}`);
    await mkdir(dir, { recursive: true });
    const keyPath = join(dir, 'gateway-key.txt');
    await writeFile(keyPath, 'file-gateway-key\n', 'utf8');

    expect(resolveKtxConfigReference(`file:${keyPath}`, {})).toBe('file-gateway-key');
  });

  it('raises an expected error when a file reference is missing', () => {
    const missing = join(tmpdir(), `ktx-config-reference-missing-${process.pid}`, 'absent-password');
    try {
      resolveKtxConfigReference(`file:${missing}`, {});
      expect.unreachable('expected a thrown error for the missing secret file');
    } catch (error) {
      expect(error).toBeInstanceOf(KtxExpectedError);
      expect((error as Error).message).toContain(missing);
    }
  });

  it('returns literal values unchanged after trimming blank-only values', () => {
    expect(resolveKtxConfigReference('provider/model', {})).toBe('provider/model');
    expect(resolveKtxConfigReference('  ', {})).toBeUndefined();
    expect(resolveKtxConfigReference(undefined, {})).toBeUndefined();
  });

  it('resolves home-prefixed paths', () => {
    expect(resolveKtxHomePath('~/ktx/key.txt')).toContain('/ktx/key.txt');
  });
});
