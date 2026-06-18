/**
 * q-remote credentials — decrypts the uploaded `.qcred.enc` blob into a
 * {@link CredentialPayload} using AES-256-GCM with a passphrase-derived key.
 *
 * Security properties:
 *  - AES-256-GCM (authenticated encryption).
 *  - Key derived via scrypt (memory-hard) from a per-session passphrase.
 *  - The passphrase is transmitted out-of-band via a separate SSH exec and
 *    is never persisted to disk on the remote in plaintext.
 *  - Local Ollama instances (provider === "ollama" with a localhost base URL)
 *    are explicitly rejected — they cannot be reached from the cloud.
 */

import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from "node:crypto";
import type { CredentialPayload } from "@qode-agent/protocol";

// ─── Constants ─────────────────────────────────────────────────────────────

const ALGO = "aes-256-gcm";
const KEY_LEN = 32; // 256 bits
const IV_LEN = 12; // 96 bits (GCM standard)
const TAG_LEN = 16; // 128 bits
const SALT_LEN = 16;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

/** Magic header so we can detect/validate our own format. */
const MAGIC = Buffer.from("QCRE1");

// ─── Helpers ───────────────────────────────────────────────────────────────

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, SCRYPT_PARAMS);
}

// ─── Encrypt / Decrypt ──────────────────────────────────────────────────────

/**
 * Encrypt a credential payload. Returns a binary blob:
 *   MAGIC(5) | salt(16) | iv(12) | ciphertext(N) | tag(16)
 *
 * This runs on the LOCAL side before upload.
 */
export function encryptCredentials(payload: CredentialPayload, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf-8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, ciphertext, tag]);
}

/**
 * Decrypt a credential blob. Runs on the REMOTE side after download.
 * Throws on tamper (GCM auth tag mismatch) or malformed input.
 */
export function decryptCredentials(blob: Buffer, passphrase: string): CredentialPayload {
  if (blob.length < MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error("Credential blob too short — possibly corrupted or truncated");
  }
  if (blob.subarray(0, MAGIC.length).toString("ascii") !== MAGIC.toString("ascii")) {
    throw new Error("Credential blob has invalid magic header — not a Q credential file");
  }
  let offset = MAGIC.length;
  const salt = blob.subarray(offset, offset + SALT_LEN);
  offset += SALT_LEN;
  const iv = blob.subarray(offset, offset + IV_LEN);
  offset += IV_LEN;
  const tagStart = blob.length - TAG_LEN;
  const ciphertext = blob.subarray(offset, tagStart);
  const tag = blob.subarray(tagStart);

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Credential decryption failed — wrong passphrase or tampered data");
  }
  const payload = JSON.parse(plaintext.toString("utf-8")) as CredentialPayload;
  validatePayload(payload);
  return payload;
}

/**
 * Validate a credential payload and reject local Ollama instances.
 */
export function validatePayload(p: CredentialPayload): void {
  if (!p.provider || !p.model) {
    throw new Error("Credential payload missing provider or model");
  }
  if (p.provider === "ollama" && (p.baseUrl === undefined || isLocalhost(p.baseUrl))) {
    throw new Error(
      "Local Ollama instances cannot be used for remote execution. " +
        "Configure a cloud-accessible Ollama base URL or use a different provider.",
    );
  }
  if (p.provider !== "ollama" && !p.apiKey) {
    throw new Error(`Credential payload missing API key for provider "${p.provider}"`);
  }
}

function isLocalhost(baseUrl: string): boolean {
  const lower = baseUrl.toLowerCase();
  return (
    lower.startsWith("http://localhost") ||
    lower.startsWith("http://127.0.0.1") ||
    lower.startsWith("http://0.0.0.0") ||
    lower.startsWith("https://localhost") ||
    lower.startsWith("https://127.0.0.1") ||
    lower.startsWith("https://0.0.0.0")
  );
}