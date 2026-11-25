import { describe, expect, it } from 'vitest';
import {
  createKey,
  decryptJson,
  DecryptError,
  encryptJson,
  isEncryptionInfo,
  isEnvelope,
  passphraseStrength,
  unlockKey,
  WrongPassphraseError,
} from '../src/core/crypto';

// Fewer PBKDF2 rounds keep the tests fast; the format is the same.
const FAST = { iterations: 100_000 };

describe('encryption', () => {
  it('round-trips JSON and never stores the plain text', async () => {
    const { info, raw } = await createKey('correct horse battery', FAST);
    expect(isEncryptionInfo(info)).toBe(true);
    const data = { schema: 1, records: { a: { title: 'Gizli yer imi', url: 'https://secret.example/' } } };
    const env = await encryptJson(data, raw, info.keyId);
    expect(isEnvelope(env)).toBe(true);
    expect(JSON.stringify(env)).not.toContain('secret.example');
    expect(await decryptJson(env, raw, info.keyId)).toEqual(data);
    // A fresh IV every time.
    expect((await encryptJson(data, raw, info.keyId)).iv).not.toBe(env.iv);
  });

  it('unlocks with the right passphrase only', async () => {
    const { info, raw } = await createKey('correct horse battery', FAST);
    expect(await unlockKey('correct horse battery', info)).toEqual(raw);
    await expect(unlockKey('wrong horse battery', info)).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(createKey('short', FAST)).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('rejects changed data and files made with another key', async () => {
    const a = await createKey('first passphrase!', FAST);
    const b = await createKey('second passphrase!', FAST);
    const env = await encryptJson({ x: 1 }, a.raw, a.info.keyId);
    const flipped = { ...env, data: env.data.slice(0, -4) + (env.data.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
    await expect(decryptJson(flipped, a.raw, a.info.keyId)).rejects.toBeInstanceOf(DecryptError);
    await expect(decryptJson(env, b.raw, b.info.keyId)).rejects.toBeInstanceOf(DecryptError);
    // The key ID is bound to the data: relabelling a file does not help.
    await expect(decryptJson({ ...env, keyId: b.info.keyId }, a.raw, b.info.keyId)).rejects.toBeInstanceOf(DecryptError);
  });

  it('only accepts sane key info from Drive', async () => {
    const { info } = await createKey('correct horse battery', FAST);
    expect(isEncryptionInfo({ ...info, kdf: { ...info.kdf, iterations: 10 } })).toBe(false);
    expect(isEncryptionInfo({ ...info, schema: 2 })).toBe(false);
    expect(isEnvelope({ marksyncEncrypted: 1, keyId: 'k', iv: 'x' })).toBe(false);
    expect(isEnvelope({ schema: 1, records: {} })).toBe(false);
  });
});

describe('passphraseStrength', () => {
  it('grades length and variety', () => {
    expect(passphraseStrength('short')).toBe(0);
    expect(passphraseStrength('aaaaaaaaaaaa')).toBe(1);
    expect(passphraseStrength('yer imleri guvende')).toBe(2);
    expect(passphraseStrength('Mavi-Kedi 42 bulut ucuyor!')).toBe(3);
  });
});
