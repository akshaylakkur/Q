/**
 * Auth-specific types for Qollab admission and encryption.
 */

// ── Credential Payloads ────────────────────────────────────────

export interface AdmissionRequest {
  sessionKey: string;
  displayName: string;
}

export interface AdmissionResult {
  admitted: boolean;
  userId?: string;
  reason?: string;
}

// ── Key Material ──────────────────────────────────────────────

export interface DerivedKeyMaterial {
  sessionKey: Buffer;       // Raw 32-byte key for AES-256-GCM
  salt: Buffer;             // 16-byte random salt
  hkdfSalt: Buffer;         // HKDF salt for key derivation
}

// ── Encryption Metadata ───────────────────────────────────────

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;               // 12-byte IV for AES-256-GCM
  tag: Buffer;              // 16-byte authentication tag
  algorithm: "AES-256-GCM";
}

// ── Snapshot Encryption ───────────────────────────────────────

export interface SnapshotEncryptionKey {
  key: Buffer;              // 32-byte key
  keyId: string;            // UUID for key rotation
  createdAt: string;
}
