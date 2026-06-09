/**
 * Context projector — filters and merges messages for LLM consumption.
 * Strips non-transcript messages, merges adjacent user messages.
 */

import type { ContextMessage } from "./types.js";

export function project(messages: readonly ContextMessage[]): ContextMessage[] {
  const result: ContextMessage[] = [];
  for (const message of messages) {
    // Merge consecutive user messages
    const last = result[result.length - 1];
    if (last && last.role === "user" && message.role === "user") {
      last.content = last.content + "\n" + message.content;
      continue;
    }
    result.push({ ...message });
  }
  return result;
}

/**
 * Estimate token count for a list of messages using a simple heuristic.
 * Roughly 4 characters per token.
 */
export function estimateTokenCount(messages: readonly ContextMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    // Count role tokens (~2 tokens)
    total += 2;
    // Count content tokens
    if (typeof msg.content === "string") {
      total += Math.ceil(msg.content.length / 4);
    }
    // Count tool call id / name overhead
    if (msg.toolCallId) total += Math.ceil(msg.toolCallId.length / 4);
  }
  return total;
}
