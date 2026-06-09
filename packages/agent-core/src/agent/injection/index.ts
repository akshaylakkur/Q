/**
 * InjectionManager — Manages dynamic system reminders injected before steps.
 */

import type { Agent } from "../agent.js";

export class InjectionManager {
  constructor(protected readonly agent: Agent) {}

  async inject(): Promise<void> {
    // Future: inject plan mode reminders, permission mode reminders, etc.
  }

  onContextClear(): void {
    // Reset injector states
  }

  onContextCompacted(_compactedCount: number): void {
    // Adjust injected positions
  }
}
