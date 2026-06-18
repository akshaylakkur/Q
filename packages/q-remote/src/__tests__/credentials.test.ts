import { describe, it, expect } from "vitest";
import { encryptCredentials, decryptCredentials, validatePayload } from "../credentials.js";
import type { CredentialPayload } from "@qode-agent/protocol";

describe("credentials encrypt/decrypt", () => {
  it("round-trips a valid payload", () => {
    const payload: CredentialPayload = {
      provider: "openai",
      model: "gpt-4",
      apiKey: "sk-test-12345",
      baseUrl: "https://api.openai.com/v1",
      thinkingLevel: "medium",
    };
    const passphrase = "my-secret-pass";
    const blob = encryptCredentials(payload, passphrase);
    expect(blob.length).toBeGreaterThan(50);
    const back = decryptCredentials(blob, passphrase);
    expect(back.provider).toBe("openai");
    expect(back.model).toBe("gpt-4");
    expect(back.apiKey).toBe("sk-test-12345");
    expect(back.thinkingLevel).toBe("medium");
  });

  it("rejects wrong passphrase", () => {
    const payload: CredentialPayload = {
      provider: "anthropic",
      model: "claude-3",
      apiKey: "sk-ant-test",
    };
    const blob = encryptCredentials(payload, "correct-pass");
    expect(() => decryptCredentials(blob, "wrong-pass")).toThrow(/decryption failed|tampered/);
  });

  it("rejects malformed blob", () => {
    expect(() => decryptCredentials(Buffer.from("garbage"), "pass")).toThrow(/too short|magic/);
  });

  it("rejects local ollama with localhost base URL", () => {
    const payload: CredentialPayload = {
      provider: "ollama",
      model: "llama3",
      apiKey: "",
      baseUrl: "http://localhost:11434",
    };
    expect(() => validatePayload(payload)).toThrow(/Local Ollama/);
  });

  it("rejects local ollama with 127.0.0.1 base URL", () => {
    const payload: CredentialPayload = {
      provider: "ollama",
      model: "llama3",
      apiKey: "",
      baseUrl: "http://127.0.0.1:11434",
    };
    expect(() => validatePayload(payload)).toThrow(/Local Ollama/);
  });

  it("accepts cloud ollama with remote base URL", () => {
    const payload: CredentialPayload = {
      provider: "ollama",
      model: "llama3",
      apiKey: "",
      baseUrl: "https://my-ollama.cloud.example.com",
    };
    expect(() => validatePayload(payload)).not.toThrow();
  });

  it("rejects missing API key for non-ollama providers", () => {
    const payload: CredentialPayload = {
      provider: "openai",
      model: "gpt-4",
      apiKey: "",
    };
    expect(() => validatePayload(payload)).toThrow(/API key/);
  });

  it("rejects missing provider or model", () => {
    expect(() => validatePayload({ provider: "", model: "x", apiKey: "y" } as CredentialPayload)).toThrow(/provider/);
    expect(() => validatePayload({ provider: "x", model: "", apiKey: "y" } as CredentialPayload)).toThrow(/provider|model/);
  });
});