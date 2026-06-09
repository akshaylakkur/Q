import type { CapabilityCatalog, ModelEntry } from "./types.js";

/**
 * Built-in model capability catalog.
 *
 * Maps provider type strings to arrays of model entries with their
 * known capabilities. This serves as the baseline; users can extend
 * or override entries via config.
 */
export const BUILTIN_CAPABILITIES: CapabilityCatalog = {
  ollama: [
    {
      name: "qwen3:1.7b",
      maxContextSize: 32768,
      maxOutputSize: 8192,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: false,
      supportsMedia: false,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: false,
      pattern: "qwen3",
    },
    {
      name: "qwen3:4b",
      maxContextSize: 32768,
      maxOutputSize: 8192,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: false,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: false,
      pattern: "qwen3",
    },
    {
      name: "qwen3.5",
      maxContextSize: 131072,
      maxOutputSize: 32768,
      supportsThinking: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: false,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: false,
      pattern: "qwen3\\.5",
    },
    {
      name: "llama3",
      maxContextSize: 8192,
      maxOutputSize: 4096,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: false,
      supportsMedia: false,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: false,
      pattern: "llama3",
    },
    {
      name: "codestral",
      maxContextSize: 256000,
      maxOutputSize: 65536,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: false,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: true,
      pattern: "codestral",
    },
    {
      name: "deepseek-v4",
      maxContextSize: 128000,
      maxOutputSize: 32768,
      supportsThinking: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: false,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: true,
      pattern: "deepseek",
    },
    {
      name: "gemma3",
      maxContextSize: 32768,
      maxOutputSize: 8192,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: false,
      supportsMedia: true,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: false,
      pattern: "gemma3",
    },
    {
      name: "mistral",
      maxContextSize: 32768,
      maxOutputSize: 8192,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: false,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: false,
      pattern: "mistral",
    },
    {
      name: "smollm2",
      maxContextSize: 8192,
      maxOutputSize: 4096,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: false,
      supportsMedia: false,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: false,
      pattern: "smollm2",
    },
  ],

  openai: [
    {
      name: "gpt-4o",
      maxContextSize: 128000,
      maxOutputSize: 16384,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: true,
      supportsParallelToolCalls: true,
      pattern: "gpt-4o",
    },
    {
      name: "gpt-4o-mini",
      maxContextSize: 128000,
      maxOutputSize: 16384,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: true,
      supportsParallelToolCalls: true,
      pattern: "gpt-4o-mini",
    },
    {
      name: "gpt-4.1",
      maxContextSize: 1048576,
      maxOutputSize: 32768,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: true,
      supportsParallelToolCalls: true,
      pattern: "gpt-4\\.1",
    },
    {
      name: "o3-mini",
      maxContextSize: 200000,
      maxOutputSize: 100000,
      supportsThinking: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: true,
      supportsParallelToolCalls: true,
      pattern: "o3-mini",
    },
    {
      name: "o4-mini",
      maxContextSize: 200000,
      maxOutputSize: 100000,
      supportsThinking: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: true,
      supportsParallelToolCalls: true,
      pattern: "o4-mini",
    },
    {
      name: "gpt-4.5-preview",
      maxContextSize: 128000,
      maxOutputSize: 16384,
      supportsThinking: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: true,
      supportsParallelToolCalls: true,
      pattern: "gpt-4\\.5",
    },
  ],

  anthropic: [
    {
      name: "claude-sonnet-4-20250514",
      maxContextSize: 200000,
      maxOutputSize: 8192,
      supportsThinking: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: true,
      pattern: "claude-sonnet-4",
    },
    {
      name: "claude-sonnet-4.5-20250612",
      maxContextSize: 200000,
      maxOutputSize: 65536,
      supportsThinking: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: true,
      pattern: "claude-sonnet-4\\.5",
    },
    {
      name: "claude-3.5-haiku-20241022",
      maxContextSize: 200000,
      maxOutputSize: 8192,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: true,
      pattern: "claude-3\\.5-haiku",
    },
    {
      name: "claude-3-5-sonnet-20241022",
      maxContextSize: 200000,
      maxOutputSize: 8192,
      supportsThinking: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: true,
      pattern: "claude-3\\.5-sonnet",
    },
    {
      name: "claude-opus-4-20250514",
      maxContextSize: 200000,
      maxOutputSize: 65536,
      supportsThinking: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: true,
      pattern: "claude-opus-4",
    },
  ],

  google: [
    {
      name: "gemini-2.5-flash",
      maxContextSize: 1048576,
      maxOutputSize: 65536,
      supportsThinking: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: true,
      supportsParallelToolCalls: true,
      pattern: "gemini-2\\.5-flash",
    },
    {
      name: "gemini-2.5-pro",
      maxContextSize: 1048576,
      maxOutputSize: 65536,
      supportsThinking: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: true,
      supportsParallelToolCalls: true,
      pattern: "gemini-2\\.5-pro",
    },
    {
      name: "gemini-2.0-flash",
      maxContextSize: 1048576,
      maxOutputSize: 8192,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: true,
      supportsParallelToolCalls: true,
      pattern: "gemini-2\\.0-flash",
    },
  ],

  kimi: [
    {
      name: "kimi-k2",
      maxContextSize: 128000,
      maxOutputSize: 16384,
      supportsThinking: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: true,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: true,
      pattern: "kimi-k2",
    },
    {
      name: "moonshot-v1-8k",
      maxContextSize: 8192,
      maxOutputSize: 4096,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: false,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: false,
      pattern: "moonshot-v1",
    },
    {
      name: "moonshot-v1-32k",
      maxContextSize: 32768,
      maxOutputSize: 4096,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: false,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: false,
      pattern: "moonshot-v1-32k",
    },
    {
      name: "moonshot-v1-128k",
      maxContextSize: 128000,
      maxOutputSize: 4096,
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolUse: true,
      supportsMedia: false,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: false,
      pattern: "moonshot-v1-128k",
    },
  ],
};

/** Fallback capabilities for unknown models */
export const FALLBACK_CAPABILITY: ModelEntry = {
  name: "*",
  maxContextSize: 32768,
  maxOutputSize: 8192,
  supportsThinking: false,
  supportsStreaming: true,
  supportsToolUse: false,
  supportsMedia: false,
  supportsStructuredOutput: false,
  supportsParallelToolCalls: false,
};

/**
 * Look up a model's capabilities from the built-in catalog.
 * Matches by exact name first, then by regex pattern.
 * Returns the fallback if no match is found.
 */
export function lookupModelCapability(
  providerType: string,
  modelName: string,
): ModelEntry {
  const catalog = BUILTIN_CAPABILITIES[providerType];
  if (!catalog) return FALLBACK_CAPABILITY;

  // Try exact match first
  const exact = catalog.find((e) => e.name === modelName);
  if (exact) return exact;

  // Try pattern match
  for (const entry of catalog) {
    if (entry.pattern) {
      try {
        const regex = new RegExp(entry.pattern);
        if (regex.test(modelName)) {
          return entry;
        }
      } catch {
        // Invalid regex in catalog entry, skip
      }
    }
  }

  return FALLBACK_CAPABILITY;
}
