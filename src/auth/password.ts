import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const CURRENT = { N: 2 ** 17, r: 8, p: 1, keyLength: 64 } as const;

function derive(passcode: string, salt: Buffer, N: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passcode, salt, keyLength, { N, r, p, maxmem: 256 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

function assertPasscode(passcode: string): void {
  if (!/^\d{6}$/.test(passcode)) throw new RangeError('Passcode must contain exactly six digits');
}

export async function hashPasscode(passcode: string): Promise<string> {
  assertPasscode(passcode);
  const salt = randomBytes(16);
  const hash = await derive(passcode, salt, CURRENT.N, CURRENT.r, CURRENT.p, CURRENT.keyLength);
  return `scrypt$${CURRENT.N}$${CURRENT.r}$${CURRENT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPasscode(passcode: string, encoded: string): Promise<boolean> {
  if (!/^\d{6}$/.test(passcode)) return false;
  const [scheme, nText, rText, pText, saltText, hashText] = encoded.split('$');
  if (scheme !== 'scrypt' || !nText || !rText || !pText || !saltText || !hashText) return false;

  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(hashText, 'base64url');
  if (!Number.isInteger(N) || N < 16_384 || N > 262_144 || !Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4 || salt.length < 16 || expected.length !== CURRENT.keyLength) {
    return false;
  }

  const actual = await derive(passcode, salt, N, r, p, expected.length);
  return timingSafeEqual(actual, expected);
}

export function passcodeNeedsRehash(encoded: string): boolean {
  const [scheme, nText, rText, pText] = encoded.split('$');
  return scheme !== 'scrypt' || Number(nText) !== CURRENT.N || Number(rText) !== CURRENT.r || Number(pText) !== CURRENT.p;
}