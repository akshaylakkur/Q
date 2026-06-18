/**
 * QollabEncryption — AES-256-GCM encryption layer for Qollab.
 *
 * Provides:
 * - Key derivation from session key via HKDF
 * - AES-256-GCM encrypt/decrypt for messages
 * - Snapshot encryption at rest
 * - Session key hashing and verification
 * - No plaintext keys stored server-side
 */

import { randomBytes, createHash, createCipheriv, createDecipheriv, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import type { DerivedKeyMaterial, EncryptedPayload, SnapshotEncryptionKey } from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const KEY_LENGTH = 32;        // AES-256
const IV_LENGTH = 12;         // 96-bit IV for GCM
const TAG_LENGTH = 16;        // 128-bit authentication tag
const SALT_LENGTH = 16;
const PBKDF2_ITERATIONS = 600_000;
const HASH_ALGORITHM = "sha256";
const CIPHER_ALGORITHM = "aes-256-gcm";

// ─── Session Key Hashing ─────────────────────────────────────────────────────

/**
 * Hash a session key for server-side storage using SHA-256.
 * The server stores only this hash, never the plaintext key.
 * SHA-256 is sufficient here because session keys are high-entropy
 * (256-bit random) and not user-chosen passwords.
 */
export function hashSessionKey(sessionKey: string): string {
  return createHash(HASH_ALGORITHM).update(sessionKey, "utf-8").digest("hex");
}

/**
 * Verify a session key against a stored hash using constant-time comparison.
 */
export function verifySessionKey(sessionKey: string, storedHash: string): boolean {
  const computedHash = hashSessionKey(sessionKey);
  if (computedHash.length !== storedHash.length) return false;
  const buf1 = Buffer.from(computedHash, "utf-8");
  const buf2 = Buffer.from(storedHash, "utf-8");
  return timingSafeEqual(buf1, buf2);
}

// ─── Key Derivation ──────────────────────────────────────────────────────────

/**
 * Derive an AES-256-GCM key material from a session key and salt.
 * Uses PBKDF2 to stretch the key.
 */
export function deriveKey(sessionKey: string, salt?: Buffer): DerivedKeyMaterial {
  const keySalt = salt ?? randomBytes(SALT_LENGTH);
  const key = pbkdf2Sync(sessionKey, keySalt, PBKDF2_ITERATIONS, KEY_LENGTH, HASH_ALGORITHM);
  return {
    sessionKey: key,
    salt: keySalt,
    hkdfSalt: keySalt,
  };
}

/**
 * Generate a cryptographic session key (32 random bytes, base64url-encoded).
 */
export function generateSessionKey(): string {
  const key = randomBytes(32);
  return "qs-" + key.toString("base64url");
}

// ─── Encrypt / Decrypt ───────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns the IV + ciphertext + auth tag as separate buffers.
 */
export function encrypt(plaintext: string | Buffer, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv);
  const input = typeof plaintext === "string" ? Buffer.from(plaintext, "utf-8") : plaintext;
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted,
    iv,
    tag,
    algorithm: "AES-256-GCM",
  };
}

/**
 * Decrypt a ciphertext encrypted with AES-256-GCM.
 * Returns the original plaintext as a Buffer.
 */
export function decrypt(payload: EncryptedPayload, key: Buffer): Buffer {
  const decipher = createDecipheriv(CIPHER_ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.tag);
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
}

/**
 * Serialize an encrypted payload to a single base64-encoded string (for transport).
 */
export function serializeEncrypted(payload: EncryptedPayload): string {
  const combined = Buffer.concat([payload.iv, payload.tag, payload.ciphertext]);
  return combined.toString("base64");
}

/**
 * Deserialize a base64-encoded encrypted payload back to its components.
 */
export function deserializeEncrypted(serialized: string): EncryptedPayload {
  const combined = Buffer.from(serialized, "base64");
  const iv = combined.subarray(0, IV_LENGTH);
  const tag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + TAG_LENGTH);
  return { ciphertext, iv, tag, algorithm: "AES-256-GCM" };
}

// ─── Snapshot Key Management ─────────────────────────────────────────────────

/**
 * Generate a new snapshot encryption key.
 */
export function generateSnapshotKey(): SnapshotEncryptionKey {
  return {
    key: randomBytes(KEY_LENGTH),
    keyId: randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString(),
  };
}

// ─── Color Assignment ────────────────────────────────────────────────────────

/**
 * Assign a deterministic color from the palette based on userId hash.
 */
export function assignColor(userId: string, palette: string[]): string {
  const hash = createHash(HASH_ALGORITHM).update(userId, "utf-8").digest();
  const index = hash[0] % palette.length;
  return palette[index];
}
