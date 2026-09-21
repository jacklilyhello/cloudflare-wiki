import { Buffer } from "node:buffer";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { AuthError } from "../../shared/auth";

// OWASP's 16 MiB profile avoids using an isolate's entire 128 MiB budget.
const SCRYPT = { N: 16_384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 };
let activeKdfs = 0;

async function derive(password: string, salt: Uint8Array): Promise<Buffer> {
  if (activeKdfs >= 2)
    throw new AuthError(429, "Authentication is busy. Try again shortly.");
  activeKdfs++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 32, SCRYPT, (error, key) => {
        if (error) reject(new AuthError(503, "Authentication is unavailable."));
        else resolve(key);
      });
    });
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(503, "Authentication is unavailable.");
  } finally {
    activeKdfs--;
  }
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
export async function sha256(value: string): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("hex");
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `scrypt$16384$8$5$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  // Only the reviewed profile is supported. Stored data cannot select work factors.
  const match =
    /^scrypt\$16384\$8\$5\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/.exec(
      encoded,
    );
  if (!match?.[1] || !match[2])
    throw new AuthError(503, "Authentication is unavailable.");
  const salt = Buffer.from(match[1], "base64url");
  const expected = Buffer.from(match[2], "base64url");
  if (
    salt.length !== 16 ||
    expected.length !== 32 ||
    salt.toString("base64url") !== match[1] ||
    expected.toString("base64url") !== match[2]
  )
    throw new AuthError(503, "Authentication is unavailable.");
  return timingSafeEqual(await derive(password, salt), expected);
}
