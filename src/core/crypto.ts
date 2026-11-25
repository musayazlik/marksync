/**
 * End-to-end encryption of the files Marksync keeps in Google Drive.
 *
 * - A passphrase becomes a 256-bit key with PBKDF2-SHA-256 and a random salt.
 * - Every file is encrypted with AES-256-GCM and a fresh 96-bit IV, so a
 *   changed or swapped file fails to decrypt instead of being read.
 * - The key's ID is bound into each file as additional data: a file made
 *   with another key (after encryption was turned off and on again) is told
 *   apart from a wrong passphrase.
 *
 * Only WebCrypto is used, so this runs in the extension and in tests alike.
 */

/** Recommended by OWASP for PBKDF2-HMAC-SHA256 (2023). */
export const PBKDF2_ITERATIONS = 600_000;
/** Passphrases shorter than this are refused. */
export const MIN_PASSPHRASE = 10;
const CHECK_TEXT = 'marksync-key-check';

/** Kept in Drive next to the encrypted files: everything needed to derive the key again, nothing secret. */
export interface EncryptionInfo {
  schema: 1;
  keyId: string;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  /** A known text encrypted with the key, to tell a wrong passphrase at once. */
  check: Envelope;
  createdAt: string;
  createdBy?: string;
}

/** An encrypted file's content. */
export interface Envelope {
  marksyncEncrypted: 1;
  keyId: string;
  iv: string;
  data: string;
}

/**
 * Rough strength of a passphrase: 0 too short, 1 weak, 2 fair, 3 strong.
 * Estimated from length and the kinds of characters used; it only guides,
 * the minimum length is the only rule.
 */
export function passphraseStrength(p: string): 0 | 1 | 2 | 3 {
  if (p.length < MIN_PASSPHRASE) return 0;
  let pool = 0;
  if (/[a-zçğıöşü]/.test(p)) pool += 26;
  if (/[A-ZÇĞİÖŞÜ]/.test(p)) pool += 26;
  if (/\d/.test(p)) pool += 10;
  if (/[^\p{L}\d]/u.test(p)) pool += 33;
  // Repeated characters add little.
  const distinct = new Set(p).size;
  const bits = Math.min(p.length, distinct * 2) * Math.log2(Math.max(pool, 10));
  return bits >= 120 ? 3 : bits >= 60 ? 2 : 1;
}

export class WrongPassphraseError extends Error {
  override name = 'WrongPassphraseError';
}

/** The data was made with another key, or was changed. */
export class DecryptError extends Error {
  override name = 'DecryptError';
}

const subtle = () => globalThis.crypto.subtle;

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function isEnvelope(value: unknown): value is Envelope {
  const v = value as Partial<Envelope> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    v.marksyncEncrypted === 1 &&
    typeof v.keyId === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.data === 'string'
  );
}

export function isEncryptionInfo(value: unknown): value is EncryptionInfo {
  const v = value as Partial<EncryptionInfo> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    v.schema === 1 &&
    typeof v.keyId === 'string' &&
    v.kdf?.name === 'PBKDF2' &&
    v.kdf.hash === 'SHA-256' &&
    Number.isInteger(v.kdf.iterations) &&
    v.kdf.iterations >= 100_000 &&
    v.kdf.iterations <= 10_000_000 &&
    typeof v.kdf.salt === 'string' &&
    isEnvelope(v.check)
  );
}

/** Raw 32-byte key from a passphrase. Takes about a second, on purpose. */
export async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256);
  return new Uint8Array(bits);
}

const aesKey = (raw: Uint8Array<ArrayBuffer>) => subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function encryptJson(data: unknown, raw: Uint8Array<ArrayBuffer>, keyId: string): Promise<Envelope> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(data));
  const sealed = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(keyId) },
    await aesKey(raw),
    plain,
  );
  return { marksyncEncrypted: 1, keyId, iv: toBase64(iv), data: toBase64(new Uint8Array(sealed)) };
}

export async function decryptJson<T>(envelope: Envelope, raw: Uint8Array<ArrayBuffer>, keyId: string): Promise<T> {
  if (envelope.keyId !== keyId) throw new DecryptError('This file was encrypted with another key.');
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: new TextEncoder().encode(keyId) },
      await aesKey(raw),
      fromBase64(envelope.data),
    );
  } catch {
    throw new DecryptError('The file could not be decrypted (wrong key or changed data).');
  }
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** Sets up a new key: returns the info to keep in Drive and the raw key to keep in this browser. */
export async function createKey(
  passphrase: string,
  opts: { iterations?: number; createdBy?: string; now?: Date } = {},
): Promise<{ info: EncryptionInfo; raw: Uint8Array<ArrayBuffer> }> {
  if (passphrase.length < MIN_PASSPHRASE) throw new WrongPassphraseError('Passphrase too short.');
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS;
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const keyId = globalThis.crypto.randomUUID();
  const raw = await deriveKey(passphrase, salt, iterations);
  const info: EncryptionInfo = {
    schema: 1,
    keyId,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(salt) },
    check: await encryptJson(CHECK_TEXT, raw, keyId),
    createdAt: (opts.now ?? new Date()).toISOString(),
    ...(opts.createdBy ? { createdBy: opts.createdBy.slice(0, 60) } : {}),
  };
  return { info, raw };
}

/** The raw key for `info`, or WrongPassphraseError. */
export async function unlockKey(passphrase: string, info: EncryptionInfo): Promise<Uint8Array<ArrayBuffer>> {
  const raw = await deriveKey(passphrase, fromBase64(info.kdf.salt), info.kdf.iterations);
  try {
    if ((await decryptJson<string>(info.check, raw, info.keyId)) === CHECK_TEXT) return raw;
  } catch {
    // Falls through to the error below.
  }
  throw new WrongPassphraseError('Wrong passphrase.');
}
