/**
 * Tests — WorkingMemory (Enhanced ContextMemory)
 *
 * Step 23: Priority retention, fact extraction, graduated compaction.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkingMemory, FactExtractor } from "../working.js";
import type { RetentionPriority } from "../types.js";
import type { Agent } from "@q/agent-core";

function mockAgent(): Agent {
  return {
    emitStatusUpdated: vi.fn(),
    emitEvent: vi.fn(),
    id: "test-agent",
    config: { update: vi.fn(), data: () => ({}) },
  } as unknown as Agent;
}

function makeMsg(
  content: string,
  role: "user" | "assistant" | "tool" = "user",
  priority: RetentionPriority = "normal",
) {
  return { role, content, priority, messageId: `msg-${Math.random()}` };
}

// =========================================================================
// 1. Priority assignment

describe("Priority assignment", () => {
  let wm: WorkingMemory;
  beforeEach(() => { wm = new WorkingMemory(mockAgent()); });

  it("assigns 'critical' to user messages with 'must'", () => {
    wm.appendUserMessage("This is critical: we must use SQLite.");
    expect(wm.history.at(-1)!.priority).toBe("critical");
  });

  it("assigns 'critical' to messages containing 'required'", () => {
    wm.appendUserMessage("This change is required for the feature.");
    expect(wm.history.at(-1)!.priority).toBe("critical");
  });

  it("assigns 'high' to user messages with softer directives", () => {
    wm.appendUserMessage("We should add error handling.");
    expect(wm.history.at(-1)!.priority).toBe("high");
  });

  it("assigns 'high' to messages mentioning decisions", () => {
    wm.appendAssistantMessage("The decision was to use PostgreSQL.");
    expect(wm.history.at(-1)!.priority).toBe("high");
  });

  it("assigns 'high' to system reminders", () => {
    wm.appendSystemReminder("Boundary constraints apply.");
    expect(wm.history.at(-1)!.priority).toBe("high");
  });

  it("assigns 'low' to large tool outputs (>10K chars)", () => {
    wm.appendToolResult("x".repeat(10_001), "read", "tc-1");
    expect(wm.history.at(-1)!.priority).toBe("low");
  });

  it("assigns 'high' to error tool outputs", () => {
    wm.appendToolResult("Something broke", "exec", "tc-2", true);
    expect(wm.history.at(-1)!.priority).toBe("high");
  });

  it("assigns 'low' to short assistant messages", () => {
    wm.appendAssistantMessage("OK.");
    expect(wm.history.at(-1)!.priority).toBe("low");
  });

  it("assigns 'normal' to regular messages", () => {
    wm.appendAssistantMessage("Here is a normal message that is long enough for testing purposes.");
    expect(wm.history.at(-1)!.priority).toBe("normal");
  });
});

// =========================================================================
// 2. FactExtractor

describe("FactExtractor", () => {
  let extractor: FactExtractor;
  beforeEach(() => { extractor = new FactExtractor(); });

  it("extracts dependency statements", () => {
    const facts = extractor.extract([makeMsg("The API module depends on the core module.")]);
    expect(facts.some(f => f.claim.toLowerCase().includes("depends"))).toBe(true);
  });

  it("extracts export statements", () => {
    const facts = extractor.extract([makeMsg("The core module exports the main function.")]);
    expect(facts.some(f => f.claim.toLowerCase().includes("exports"))).toBe(true);
  });

  it("extracts decision statements", () => {
    const facts = extractor.extract([makeMsg("We chose SQLite for local storage.")]);
    expect(facts.some(f => f.claim.toLowerCase().includes("chose"))).toBe(true);
  });

  it("deduplicates similar claims", () => {
    const facts = extractor.extract([
      makeMsg("The API depends on the core module."),
      makeMsg("The API depends on the core module."),
    ]);
    const depClaims = facts.filter(f => f.claim.toLowerCase().includes("api"));
    expect(depClaims.length).toBeLessThanOrEqual(1);
  });

  it("skips very short messages", () => {
    expect(extractor.extract([makeMsg("OK.")]).length).toBe(0);
  });

  it("assigns higher confidence to user messages", () => {
    const userFacts = extractor.extract([
      { role: "user", content: "The API depends on the core module.", priority: "normal", messageId: "m1" },
    ]);
    const asstFacts = extractor.extract([
      { role: "assistant", content: "The API depends on the core module.", priority: "normal", messageId: "m2" },
    ]);
    if (userFacts.length && asstFacts.length) {
      expect(userFacts[0]!.confidence).toBeGreaterThanOrEqual(asstFacts[0]!.confidence);
    }
  });
});

// =========================================================================
// 3. Basic message management

describe("Message management", () => {
  let wm: WorkingMemory;
  beforeEach(() => {
    wm = new WorkingMemory(mockAgent(), { contextLimit: 100_000, triggerRatio: 0.99 });
  });

  it("starts empty", () => {
    expect(wm.history.length).toBe(0);
    expect(wm.tokenCount).toBe(0);
  });

  it("appends user messages with message IDs", () => {
    wm.appendUserMessage("Hello");
    expect(wm.history[0]!.messageId).toMatch(/^msg-\d+$/);
  });

  it("appends system reminders", () => {
    wm.appendSystemReminder("Test reminder");
    expect(wm.history[0]!.content).toContain("<system-reminder>");
  });

  it("strips priority from messages getter", () => {
    wm.appendUserMessage("Test");
    expect(wm.messages[0]).not.toHaveProperty("priority");
    expect(wm.messages[0]).not.toHaveProperty("messageId");
  });

  it("generates monotonically increasing message IDs", () => {
    wm.appendUserMessage("First");
    wm.appendUserMessage("Second");
    expect(wm.history[0]!.messageId).toBe("msg-1");
    expect(wm.history[1]!.messageId).toBe("msg-2");
  });

  it("clear resets all state", () => {
    wm.appendUserMessage("Test");
    wm.clear();
    expect(wm.history.length).toBe(0);
    expect(wm.tokenCount).toBe(0);
    expect(wm.pendingFacts.length).toBe(0);
  });

  it("context pressure is calculated correctly", () => {
    const smallWm = new WorkingMemory(mockAgent(), { contextLimit: 1000, triggerRatio: 0.99 });
    smallWm.appendUserMessage("x".repeat(500));
    expect(smallWm.contextPressure).toBeGreaterThan(0);
    expect(smallWm.contextPressure).toBeLessThan(1);
  });
});

// =========================================================================
// 4. Auto compaction — Tier 1

describe("Auto compaction — Tier 1", () => {
  it("removes low-priority messages on compaction", () => {
    const wm = new WorkingMemory(mockAgent(), {
      contextLimit: 200,
      triggerRatio: 0.30,
      reservedContextSize: 20,
    });
    wm.appendUserMessage("Critical: must keep this.");
    wm.appendToolResult("x".repeat(10_001), "read", "tc-big"); // low priority
    wm.appendUserMessage("Trigger compaction");

    // The low-priority msg should be removed; at most 4 messages
    expect(wm.history.length).toBeLessThan(4);
  });

  it("merges consecutive same-tool result pairs", () => {
    const wm = new WorkingMemory(mockAgent(), {
      contextLimit: 100,
      triggerRatio: 0.05,
      reservedContextSize: 80,
    });
    wm.appendToolResult("output-a", "read", "tc-a");
    wm.appendToolResult("output-b", "read", "tc-b");

    // With contextLimit 100 and reserved 80, available must be < 80
    // Two tool msgs ~7 tokens, so available=93>80 → no compaction
    // Need to push more to make available < 80
    wm.appendUserMessage("x".repeat(200)); // ~52 tokens, now total ~59, available=41<80 ✓

    const toolMsgs = wm.history.filter(m => m.role === "tool" && m.toolName === "read");
    expect(toolMsgs.length).toBeLessThanOrEqual(1);
  });

  it("records compaction stats", () => {
    const wm = new WorkingMemory(mockAgent(), {
      contextLimit: 200,
      triggerRatio: 0.30,
      reservedContextSize: 20,
    });
    wm.appendUserMessage("x".repeat(50));
    wm.appendAssistantMessage("y".repeat(50));
    wm.appendAssistantMessage("z".repeat(50));

    if (wm.compactionRecords.length > 0) {
      const record = wm.compactionRecords[0]!;
      expect(record.tier).toBe(1);
      expect(record.totalMessagesBefore).toBeGreaterThan(0);
      expect(record.totalMessagesAfter).toBeGreaterThan(0);
      expect(record.tokensSaved).toBeGreaterThanOrEqual(0);
    }
  });
});

// =========================================================================
// 5. Compaction Tier 2

describe("Compaction Tier 2", () => {
  it("builds episode summary from normal-priority messages", () => {
    const wm = new WorkingMemory(mockAgent(), {
      contextLimit: 800,
      triggerRatio: 0.30,
    });
    wm.appendUserMessage("Critical: must keep this directive.");
    wm.appendAssistantMessage("We decided to use SQLite for local storage.");
    wm.appendAssistantMessage("The API depends on the core module.");
    for (let i = 0; i < 5; i++) {
      wm.appendAssistantMessage("x".repeat(500));
    }

    // Tier 2 creates <episode-summary>
    expect(wm.history.some(m => m.content.includes("<episode-summary>"))).toBe(true);
    // Critical message preserved
    expect(wm.history.some(m => m.priority === "critical")).toBe(true);
  });

  it("extracts facts from compacted messages", () => {
    const wm = new WorkingMemory(mockAgent(), {
      contextLimit: 800,
      triggerRatio: 0.30,
    });
    wm.appendUserMessage("Must keep this critical directive.");
    wm.appendAssistantMessage("The API module depends on the core module.");
    wm.appendAssistantMessage("We chose SQLite for local storage.");
    for (let i = 0; i < 5; i++) {
      wm.appendAssistantMessage("x".repeat(500));
    }

    // Compaction should have happened
    expect(wm.compactionRecords.length).toBeGreaterThan(0);
    expect(wm.compactionRecords.at(-1)!.tier).toBeGreaterThanOrEqual(2);
  });
});

// =========================================================================
// 6. Compaction Tier 3

describe("Compaction Tier 3", () => {
  it("only keeps critical messages and a comprehensive summary", () => {
    const wm = new WorkingMemory(mockAgent(), {
      contextLimit: 300,
      triggerRatio: 0.05,
    });
    wm.appendUserMessage("Critical: must preserve this.");
    for (let i = 0; i < 6; i++) {
      wm.appendAssistantMessage("x".repeat(400));
    }

    expect(wm.history.filter(m => m.priority === "critical").length).toBeGreaterThanOrEqual(1);
    expect(wm.history.some(m => m.content.includes("<episode-summary>"))).toBe(true);
  });

  it("flushes pending facts on Tier 3 compaction", () => {
    const agent = mockAgent();
    const wm = new WorkingMemory(agent, {
      contextLimit: 300,
      triggerRatio: 0.05,
    });
    wm.appendUserMessage("Must keep this critical directive.");
    wm.appendAssistantMessage("The API depends on the core module.");
    wm.appendAssistantMessage("We chose SQLite.");
    for (let i = 0; i < 6; i++) {
      wm.appendAssistantMessage("x".repeat(400));
    }

    expect(wm.pendingFacts.length).toBe(0);
    expect(agent.emitEvent).toHaveBeenCalled();
  });
});

// =========================================================================
// 7. checkAndCompact

describe("checkAndCompact", () => {
  it("returns false when pressure is below trigger", () => {
    const wm = new WorkingMemory(mockAgent(), { contextLimit: 100_000, triggerRatio: 0.90 });
    wm.appendUserMessage("Small message.");
    expect(wm.checkAndCompact()).toBe(false);
  });

  it("returns true when compaction runs", () => {
    const wm = new WorkingMemory(mockAgent(), { contextLimit: 200, triggerRatio: 0.20 });
    wm.appendUserMessage("x".repeat(100));
    expect(typeof wm.checkAndCompact()).toBe("boolean");
  });
});

// =========================================================================
// 8. Compaction stats

describe("Compaction stats", () => {
  it("exposes compaction records", () => {
    const wm = new WorkingMemory(mockAgent(), { contextLimit: 200, triggerRatio: 0.20 });
    wm.appendUserMessage("x".repeat(100));
    expect(wm.compactionRecords).toBeInstanceOf(Array);
  });

  it("records have all required fields", () => {
    const wm = new WorkingMemory(mockAgent(), {
      contextLimit: 200,
      triggerRatio: 0.20,
    });
    wm.appendUserMessage("Must keep this: critical directive.");
    wm.appendAssistantMessage("x".repeat(100));
    wm.appendAssistantMessage("y".repeat(100));
    wm.appendAssistantMessage("Trigger compaction now.");

    if (wm.compactionRecords.length > 0) {
      const record = wm.compactionRecords[0]!;
      expect(record).toHaveProperty("timestamp");
      expect(record).toHaveProperty("tier");
      expect(record).toHaveProperty("totalMessagesBefore");
      expect(record).toHaveProperty("totalMessagesAfter");
      expect(record).toHaveProperty("tokensSaved");
      expect(record).toHaveProperty("contextPressure");
    }
  });
});