import { vi } from "vitest";
import type { Agent } from "@q/agent-core";

/**
 * Create a minimal Mock Agent for testing.
 */
export function createMockAgent(): Agent {
  return {
    emitStatusUpdated: vi.fn(),
    emitEvent: vi.fn(),
    id: "test-agent",
    config: { update: vi.fn(), data: () => ({}) },
  } as unknown as Agent;
}