/**
 * Local credential handling — collects the provider config from the local
 * environment / config files, encrypts it for upload, and rejects local
 * Ollama instances (they cannot be reached from the cloud).
 *
 * The actual encrypt/decrypt functions live in @qode-agent/q-remote, but
 * we duplicate the encrypt logic here so q-cli doesn't depend on q-remote
 * at runtime (q-remote is only installed on the remote server). Both sides
 * must agree on the format — the format is defined by @qode-agent/protocol's
 * CredentialPayload type.
 */

import { createCipheriv, scryptSync, randomBytes } from "node:crypto";
import { resolveProviderConfig } from "@qode-agent/runtime";
import type { CredentialPayload } from "@qode-agent/protocol";

// ─── Constants (must match q-remote/src/credentials.ts) ─────────────────────

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT_LEN = 16;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const MAGIC = Buffer.from("QCRE1");

// ─── Encrypt ─────────────────────────────────────────────────────────────────

/**
 * Encrypt a credential payload for upload to the remote.
 * Format: MAGIC(5) | salt(16) | iv(12) | ciphertext(N) | tag(16)
 */
export function encryptCredentials(payload: CredentialPayload, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const key = scryptSync(passphrase, salt, KEY_LEN, SCRYPT_PARAMS);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf-8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, ciphertext, tag]);
}

/**
 * Generate a random per-session passphrase for credential encryption.
 * This is transmitted out-of-band (written to a remote tmp file the daemon
 * reads and deletes). Never written to local disk in plaintext.
 */
export function generatePassphrase(): string {
  return randomBytes(24).toString("base64url");
}

// ─── Collect ─────────────────────────────────────────────────────────────────

/**
 * Collect the local provider configuration and convert it to a
 * CredentialPayload for upload. Rejects local Ollama instances.
 *
 * @throws if no provider is configured, or if the provider is a local Ollama.
 */
export function collectLocalCredentials(workDir: string): CredentialPayload {
  const cfg = resolveProviderConfig(workDir);
  if (!cfg) {
    throw new Error(
      "No LLM provider configured. Set Q_PROVIDER, Q_MODEL, Q_API_KEY env vars, " +
        "or configure .q/config.toml / ~/.Q/config.toml.",
    );
  }

  // Reject local Ollama instances — they cannot be reached from the cloud
  if (cfg.provider === "ollama") {
    const baseUrl = cfg.baseUrl ?? "";
    if (
      !baseUrl ||
      baseUrl.includes("localhost") ||
      baseUrl.includes("127.0.0.1") ||
      baseUrl.includes("0.0.0.0")
    ) {
      throw new Error(
        "Local Ollama instances cannot be used for remote execution. " +
          "The remote server cannot reach your local Ollama. " +
          "Configure a cloud-accessible Ollama base URL (via Q_BASE_URL) or use a different provider.",
      );
    }
  }

  return {
    provider: cfg.provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    thinkingLevel: cfg.thinkingLevel,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a random session ID.
 */
export function generateSessionId(): string {
  return randomBytes(16).toString("hex");
}