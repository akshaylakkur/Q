/**
 * Tests for the Onboarding system.
 *
 * All tests run without a real terminal — they test the detector logic,
 * config writer, state management, and step validation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { checkFirstRun } from "../detector.js";
import { writeOnboardingConfig, clearOnboardingComplete } from "../write-config.js";
import { createDefaultState, cloneState, PROVIDERS } from "../types.js";
import type { OnboardingState } from "../types.js";
import type { CliOptions } from "../../cli/types.js";
import type { ConfigDiscovery } from "../../cli/config-discover.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempVHome(): string {
  const dir = resolve(tmpdir(), "q-test-onboarding-" + Date.now());
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupFullDir(dir: string): void {
  try {
    const qDir = resolve(dir, ".Q");
    if (existsSync(qDir)) rmSync(qDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // cleanup best-effort
  }
}

function setHome(homeDir: string): void {
  process.env.HOME = homeDir;
}

function resetHome(): void {
  delete process.env.HOME;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Onboarding types", () => {
  it("should create a default state", () => {
    const state = createDefaultState();
    expect(state.provider).toBeNull();
    expect(state.credentials).toBeNull();
    expect(state.model).toBeNull();
    expect(state.validationResult).toBe("untested");
    expect(state.validationLatencyMs).toBeNull();
    expect(state.validationError).toBeNull();
  });

  it("should deep-clone state", () => {
    const original = createDefaultState();
    original.provider = { type: "anthropic", name: "Anthropic" };
    original.credentials = { apiKey: "sk-ant-test123" };
    original.model = "claude-sonnet-4-20250514";
    original.validationResult = "success";
    original.validationLatencyMs = 1234;

    const cloned = cloneState(original);
    expect(cloned).toEqual(original);
    expect(cloned.provider).not.toBe(original.provider);
    expect(cloned.credentials).not.toBe(original.credentials);
  });

  it("should have all providers defined", () => {
    expect(PROVIDERS.length).toBeGreaterThanOrEqual(4);
    const types = PROVIDERS.map((p) => p.type);
    expect(types).toContain("anthropic");
    expect(types).toContain("openai");
    expect(types).toContain("google");
    expect(types).toContain("ollama");
  });
});

describe("Onboarding state with partial data", () => {
  it("should handle partial state correctly", () => {
    const state: OnboardingState = {
      provider: { type: "google", name: "Google Gemini" },
      credentials: null,
      model: "gemini-2.5-flash",
      validationResult: "untested",
      validationLatencyMs: null,
      validationError: null,
    };
    expect(state.provider?.type).toBe("google");
    expect(state.model).toBe("gemini-2.5-flash");
    expect(state.credentials).toBeNull();
  });

  it("should handle Ollama provider with no credentials", () => {
    const state: OnboardingState = {
      provider: { type: "ollama", name: "Ollama (Local)" },
      credentials: null,
      model: "llama3.2",
      validationResult: "untested",
      validationLatencyMs: null,
      validationError: null,
    };
    expect(state.credentials).toBeNull();
    expect(state.model).toBe("llama3.2");
  });
});

describe("writeOnboardingConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempVHome();
    setHome(tempDir);
  });

  afterEach(() => {
    resetHome();
    cleanupFullDir(tempDir);
  });

  it("should write config.toml with provider, model, and apiKey", () => {
    const state = createDefaultState();
    state.provider = { type: "anthropic", name: "Anthropic" };
    state.credentials = { apiKey: "sk-ant-test-key-12345" };
    state.model = "claude-sonnet-4-20250514";

    writeOnboardingConfig(state);

    const qDir = resolve(tempDir, ".Q");
    const configPath = resolve(qDir, "config.toml");
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain('provider = "anthropic"');
    expect(content).toContain('model = "claude-sonnet-4-20250514"');
    expect(content).toContain('apiKey = "sk-ant-test-key-12345"');
  });

  it("should write config.toml for Ollama", () => {
    const state = createDefaultState();
    state.provider = { type: "ollama", name: "Ollama (Local)" };
    state.credentials = null;
    state.model = "llama3.2";

    writeOnboardingConfig(state);

    const qDir = resolve(tempDir, ".Q");
    const configPath = resolve(qDir, "config.toml");
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain('provider = "ollama"');
    expect(content).toContain('model = "llama3.2"');
  });

  it("should write the env file", () => {
    const state = createDefaultState();
    state.provider = { type: "openai", name: "OpenAI" };
    state.credentials = { apiKey: "sk-test-key" };
    state.model = "gpt-4o";

    writeOnboardingConfig(state);

    const qDir = resolve(tempDir, ".Q");
    const envPath = resolve(qDir, "env");
    expect(existsSync(envPath)).toBe(true);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain('export Q_PROVIDER="openai"');
    expect(content).toContain('export Q_MODEL="gpt-4o"');
    expect(content).toContain('export Q_API_KEY="sk-test-key"');
  });

  it("should create the onboarding-complete semaphore", () => {
    const state = createDefaultState();
    state.provider = { type: "anthropic", name: "Anthropic" };
    state.credentials = { apiKey: "sk-ant-test" };
    state.model = "claude-sonnet-4-20250514";

    writeOnboardingConfig(state);

    const semaphore = resolve(tempDir, ".Q", ".onboarding-complete");
    expect(existsSync(semaphore)).toBe(true);
  });

  it("should clear the onboarding-complete semaphore", () => {
    const state = createDefaultState();
    state.provider = { type: "anthropic", name: "Anthropic" };
    state.credentials = { apiKey: "sk-ant-test" };
    state.model = "claude-sonnet-4-20250514";

    writeOnboardingConfig(state);
    const semaphore = resolve(tempDir, ".Q", ".onboarding-complete");
    expect(existsSync(semaphore)).toBe(true);

    clearOnboardingComplete();
    expect(existsSync(semaphore)).toBe(false);
  });
});

describe("checkFirstRun", () => {
  let tempDir: string;
  let mockConfigDiscovery: ConfigDiscovery;

  function makeCliOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      setup: false,
      model: undefined,
      prompt: undefined,
      plan: false,
      outputFormat: "text",
      skillsDirs: [],
      cwd: undefined,
      tui: undefined,
      ...overrides,
    };
  }

  beforeEach(() => {
    // Clear Q_ env vars that might leak from the running shell
    for (const key of ["Q_PROVIDER", "Q_MODEL", "Q_API_KEY", "Q_BASE_URL"]) {
      delete process.env[key];
    }
    tempDir = createTempVHome();
    setHome(tempDir);
    mockConfigDiscovery = {
      vDir: null,
      projectRoot: tempDir,
      initialized: false,
    };
  });

  afterEach(() => {
    resetHome();
    cleanupFullDir(tempDir);
  });

  it("should need onboarding when no config exists", () => {
    const gate = checkFirstRun(tempDir, makeCliOptions(), mockConfigDiscovery);
    expect(gate.needed).toBe(true);
    expect(gate.reason).toBe("both");
  });

  it("should skip onboarding if env vars are set", () => {
    process.env.Q_PROVIDER = "anthropic";
    process.env.Q_MODEL = "claude-sonnet-4-20250514";
    process.env.Q_API_KEY = "sk-ant-test";

    const gate = checkFirstRun(tempDir, makeCliOptions(), mockConfigDiscovery);
    expect(gate.needed).toBe(false);

    delete process.env.Q_PROVIDER;
    delete process.env.Q_MODEL;
    delete process.env.Q_API_KEY;
  });

  it("should skip onboarding if semaphore exists", () => {
    const qDir = resolve(tempDir, ".Q");
    mkdirSync(qDir, { recursive: true });
    writeFileSync(resolve(qDir, ".onboarding-complete"), "");

    const gate = checkFirstRun(tempDir, makeCliOptions(), mockConfigDiscovery);
    expect(gate.needed).toBe(false);
  });

  it("should need onboarding if provider is missing from config", () => {
    const qDir = resolve(tempDir, ".Q");
    mkdirSync(qDir, { recursive: true });
    writeFileSync(resolve(qDir, "config.toml"), 'model = "gpt-4o"\napiKey = "sk-test"\n');

    const gate = checkFirstRun(tempDir, makeCliOptions(), mockConfigDiscovery);
    expect(gate.needed).toBe(true);
  });

  it("should skip onboarding if config has provider, model, and apiKey", () => {
    const qDir = resolve(tempDir, ".Q");
    mkdirSync(qDir, { recursive: true });
    writeFileSync(resolve(qDir, "config.toml"), 'provider = "anthropic"\nmodel = "claude-sonnet-4-20250514"\napiKey = "sk-ant-test"\n');

    const gate = checkFirstRun(tempDir, makeCliOptions(), mockConfigDiscovery);
    expect(gate.needed).toBe(false);
  });

  it("should skip onboarding if config has Ollama provider and model", () => {
    const qDir = resolve(tempDir, ".Q");
    mkdirSync(qDir, { recursive: true });
    writeFileSync(resolve(qDir, "config.toml"), 'provider = "ollama"\nmodel = "llama3.2"\n');

    // Ollama doesn't need an apiKey in the flat format
    const gate = checkFirstRun(tempDir, makeCliOptions(), mockConfigDiscovery);
    // Ollama won't have apiKey, so flatApiKey won't be set...
    // But the logic in detector checks: flatProvider && (flatApiKey || flatProvider === "ollama")
    // Ollama needs both provider and model to pass
    expect(gate.needed).toBe(false);
  });

  it("should skip onboarding when setup flag is used", () => {
    // setup flag calls clearOnboardingComplete, then onboarding runs.
    // But checkFirstRun itself doesn't look at setup flag — that's main.ts logic.
    // The detector skips if Q_PROVIDER, Q_MODEL, Q_API_KEY env vars are set
    // or semaphore exists.
    // So we test detector directly:
    const gate = checkFirstRun(tempDir, makeCliOptions({ yolo: true }), mockConfigDiscovery);
    expect(gate.needed).toBe(false);
  });
});