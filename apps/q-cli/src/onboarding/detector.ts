/**
 * First-Run Detector — decides whether the onboarding wizard is needed.
 *
 * Runs during the startup sequence in main.ts, before the TUI launches
 * and before the orchestrator is created. Checks several conditions to
 * determine if the user needs to go through the setup flow.
 *
 * NOTE: This is a pure function that checks config state only.
 * TTY/CI/interactivity checks are the caller's responsibility (main.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CliOptions } from "../cli/types.js";
import type { ConfigDiscovery } from "../cli/config-discover.js";
import type { OnboardingGate } from "./types.js";

/** Helper to extract a TOML string value by key within a specific section.
 * If section is empty, extracts from the top-level (before any [section] header). */
function extractTomlValue(content: string, section: string, key: string, _nested?: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (!section) {
    // Top-level: extract key = "value" before any [section] header
    const valueRegex = new RegExp(`^\\s*${escapedKey}\\s*=\\s*"([^"]*)"`, "m");
    const valueMatch = content.match(valueRegex);
    return valueMatch?.[1] ?? null;
  }

  const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Find the section: [section]\n then capture body up to \n[ or EOF
  // Also handle \r\n line endings (Windows).
  const sectionRegex = new RegExp(
    `\\[${escapedSection}\\]\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\[|$)`,
  );
  const match = content.match(sectionRegex);
  if (!match) return null;

  const sectionBody: string = match[1] ?? "";
  const valueRegex = new RegExp(`^\\s*${escapedKey}\\s*=\\s*"([^"]*)"`, "m");
  const valueMatch = sectionBody.match(valueRegex);
  return valueMatch?.[1] ?? null;
}

/** Check if a TOML config file has a valid provider configuration */
function hasValidProvider(content: string): boolean {
  // Check for [providers] section with at least one named provider sub-section
  // Pattern: [providers.<name>] followed by type = "..." and (apiKey = "..." or oauth)
  const providerSectionRegex = /\[providers\.([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = providerSectionRegex.exec(content)) !== null) {
    const providerName: string = match[1] ?? "";
    const type = extractTomlValue(content, `providers.${providerName}`, "type");
    if (!type) continue;
    // Ollama (local): no API key needed — any provider with type="ollama" is valid
    if (type === "ollama") return true;
    // Ollama Cloud: needs an API key like any cloud provider
    // Must have either apiKey or oauth config
    const apiKey = extractTomlValue(content, `providers.${providerName}`, "apiKey");
    const oauthSection = new RegExp(
      `\\[providers\\.${providerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.oauth\\]`,
      "m",
    );
    if (apiKey || oauthSection.test(content)) {
      return true;
    }
  }
  return false;
}

/** Check if a config file has a [models] section with at least one alias */
function hasValidModel(content: string): boolean {
  const modelsSection = /\[models\.([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = modelsSection.exec(content)) !== null) {
    const modelName = match[1];
    const name = extractTomlValue(content, `models.${modelName}`, "name");
    if (name) return true;
  }
  return false;
}

/** Load config file content if it exists */
function loadConfigFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Get the user's home directory, respecting process.env.HOME for testing.
 */
function getUserHome(): string {
  return process.env.HOME ?? require("node:os").homedir();
}

/**
 * Check whether the onboarding wizard is needed.
 */
export function checkFirstRun(
  _projectRoot: string,
  opts: CliOptions,
  configDiscovery: ConfigDiscovery,
): OnboardingGate {
  // Skip if user explicitly provided config via flags or env vars
  if (opts.yolo || opts.auto || opts.prompt || opts.session) {
    return { needed: false };
  }

  // Skip if environment variables provide a provider + model (+ key for non-Ollama/local)
  if (process.env.Q_PROVIDER && process.env.Q_MODEL && (process.env.Q_API_KEY !== undefined || process.env.Q_PROVIDER === "ollama")) {
    return { needed: false };
  }

  // Skip if already completed
  const semaphore = resolve(getUserHome(), ".Q", ".onboarding-complete");
  if (existsSync(semaphore)) {
    return { needed: false };
  }

  // Check user-global config: $HOME/.Q/config.toml
  const globalConfigPath = resolve(getUserHome(), ".Q", "config.toml");
  const globalConfig = loadConfigFile(globalConfigPath);

  if (globalConfig) {
    const hasProvider = hasValidProvider(globalConfig);
    const hasModel = hasValidModel(globalConfig);
    // Also check the flat format (provider, model, apiKey at top level)
    const flatProvider = extractTomlValue(globalConfig, "", "provider");
    const flatModel = extractTomlValue(globalConfig, "", "model");
    const flatApiKey = extractTomlValue(globalConfig, "", "apiKey");

    const effectiveHasProvider = hasProvider || (!!flatProvider && (!!flatApiKey || flatProvider === "ollama"));
    const effectiveHasModel = hasModel || !!flatModel;

    if (effectiveHasProvider && effectiveHasModel) {
      return { needed: false };
    }

    if (!effectiveHasProvider && !effectiveHasModel) {
      return { needed: true, reason: "both" };
    }
    if (!effectiveHasProvider) {
      return { needed: true, reason: "no_provider" };
    }
    return { needed: true, reason: "no_model" };
  }

  // Check project-level config: .q/config.toml
  if (configDiscovery.vDir) {
    const projectConfigPath = resolve(configDiscovery.vDir, "config.toml");
    const projectConfig = loadConfigFile(projectConfigPath);
    if (projectConfig) {
      const hasProvider = hasValidProvider(projectConfig);
      const hasModel = hasValidModel(projectConfig);
      const flatProvider = extractTomlValue(projectConfig, "", "provider");
      const flatModel = extractTomlValue(projectConfig, "", "model");
      const flatApiKey = extractTomlValue(projectConfig, "", "apiKey");

      const effectiveHasProvider = hasProvider || (!!flatProvider && (!!flatApiKey || flatProvider === "ollama"));
      const effectiveHasModel = hasModel || !!flatModel;

      if (effectiveHasProvider && effectiveHasModel) {
        return { needed: false };
      }

      if (!effectiveHasProvider && !effectiveHasModel) {
        return { needed: true, reason: "both" };
      }
      if (!effectiveHasProvider) {
        return { needed: true, reason: "no_provider" };
      }
      return { needed: true, reason: "no_model" };
    }
  }

  // No config exists at all — onboarding needed
  return { needed: true, reason: "both" };
}