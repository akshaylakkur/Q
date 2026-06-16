/**
 * WorkingMemory — Priority retention, fact extraction, graduated compaction.
 *
 * Step 23: Enhanced ContextMemory.
 *
 * Full working memory implementation that supports priority-retention
 * tagging, automatic fact extraction during compaction, and a three-tier
 * graduated compaction protocol.
 *
 * Configuration (via config.memory):
 *   compactionTriggerRatio: number (default 0.75)
 *   reservedContextSize: number (default 4000)
 *   contextLimit: number (default 128_000)
 */

import type { Agent, AgentContextData } from "@q/agent-core";
import type { ContextMessage, PromptOrigin } from "@q/agent-core";
import type { LoopRecordedEvent } from "@q/agent-core";
import type { RetentionPriority, ExtractedFact, CompactionRecord } from "./types.js";

// =========================================================================
// Priority-tagged message
// =========================================================================

/**
 * A context message with an attached retention priority.
 */
export interface PrioritizedMessage extends ContextMessage {
  /** Retention priority for compaction decisions */
  priority: RetentionPriority;
  /** Monotonically increasing message ID for cross-referencing in fact extraction */
  messageId: string;
}

// =========================================================================
// Compaction context config
// =========================================================================

export interface CompactionConfig {
  /** Ratio of context limit that triggers compaction (default 0.75) */
  triggerRatio: number;
  /** Tokens to reserve for the model's response after compaction (default 4000) */
  reservedContextSize: number;
  /** Maximum tokens for the context window (default 128_000) */
  contextLimit: number;
}

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  triggerRatio: 0.75,
  reservedContextSize: 4000,
  contextLimit: 128_000,
};

// =========================================================================
// FactExtractor
// =========================================================================

/** Regex patterns for detecting factual statements in message content. */
const FACT_PATTERNS: RegExp[] = [
  // Module dependency patterns: "X depends on Y", "X relies on Y"
  /\b(\w+(?:\.\w+)?)\s+(?:depends?\s+(?:on|upon)|relies?\s+on|uses?|imports?)\s+(\w+(?:\.\w+)?)\b/gi,
  // API / interface patterns: "the API is Z", "the interface is Z"
  /\b(?:the\s+)?(?:API|interface|type|class|function|method|module)\s+(?:is|returns|takes|accepts|produces)\s+(.+?)[.!\n]/gi,
  // Export patterns: "X exports Y", "X defines Y"
  /\b(\w+(?:\.\w+)?)\s+(?:exports?|defines?|declares?|implements?)\s+(\w+)\b/gi,
  // Decision patterns: "we chose X", "selected X", "decided to use X"
  /\b(?:we\s+)?(?:chose|selected|decided\s+to\s+use|opted\s+for)\s+(\w+(?:\s+\w+)?)\b/gi,
  // Architectural patterns: "X is responsible for Y", "X manages Y"
  /\b(\w+(?:\.\w+)?)\s+(?:is\s+responsible\s+for|manages?|handles?|owns?|provides?)\s+(\w+(?:\s+\w+)?)\b/gi,
  // Constraint patterns: "X must not Y", "X should Y", "X cannot Y"
  /\b(\w+(?:\.\w+)?)\s+(?:must\s+not|should\s+not|should|cannot|can\s+not|must)\s+(\w+(?:\s+\w+)?)\b/gi,
];

/**
 * Extracts factual statements from message content.
 *
 * Uses regex patterns and NLP-lite heuristics to identify statements
 * that should be preserved as facts across compaction cycles.
 */
export class FactExtractor {
  /**
   * Extract facts from a batch of messages being compacted.
   *
   * @param messages - The messages to scan for facts
   * @returns Structured ExtractedFact objects
   */
  extract(messages: PrioritizedMessage[]): ExtractedFact[] {
    const facts: ExtractedFact[] = [];
    const seenClaims = new Set<string>();

    for (const msg of messages) {
      const content = msg.content;
      if (!content || content.length < 20) continue; // Skip very short messages

      const matches = this.matchPatterns(content);
      for (const match of matches) {
        const claim = match.trim();
        // Deduplicate similar claims (case-insensitive, trimmed)
        const normalized = claim.toLowerCase().replace(/\s+/g, " ");
        if (seenClaims.has(normalized)) continue;
        seenClaims.add(normalized);

        // Compute confidence based on:
        // - Source type: user messages get higher confidence
        // - Pattern specificity: longer, more specific matches get higher confidence
        let confidence = 0.6; // baseline
        if (msg.role === "user") confidence += 0.15;
        if (msg.role === "assistant") confidence += 0.1;
        if (claim.length > 60) confidence += 0.1; // More specific claim
        if (claim.length < 30) confidence -= 0.1; // Very short, potentially vague

        facts.push({
          claim,
          confidence: Math.min(1, Math.max(0.1, confidence)),
          sourceMessageIds: [msg.messageId],
        });
      }
    }

    return facts;
  }

  /**
   * Run all regex patterns against content and collect unique matches.
   */
  private matchPatterns(content: string): string[] {
    const matches: string[] = [];

    for (const pattern of FACT_PATTERNS) {
      let m: RegExpExecArray | null;
      const re = new RegExp(pattern.source, pattern.flags);
      while ((m = re.exec(content)) !== null) {
        // Use the full match, not just capture groups
        matches.push(m[0].trim());
      }
    }

    return matches;
  }
}

// =========================================================================
// WorkingMemory (Enhanced ContextMemory)
// =========================================================================

/**
 * Enhanced working memory with priority retention, fact extraction,
 * and graduated compaction.
 *
 * Wraps the agent-core ContextMemory and adds:
 * - Automatic priority tagging on message append
 * - Fact extraction during compaction (FactExtractor)
 * - Three-tier graduated compaction protocol
 * - Compaction stats collection
 */
export class WorkingMemory {
  // ── Core state ──────────────────────────────────────────────────────
  private _history: PrioritizedMessage[] = [];
  private _tokenCount = 0;
  private _compactionConfig: CompactionConfig;
  private _contextLimit: number;

  // ── Fact extraction ─────────────────────────────────────────────────
  private _factExtractor = new FactExtractor();
  private _pendingFacts: ExtractedFact[] = [];

  // ── Compaction stats ────────────────────────────────────────────────
  private _compactionRecords: CompactionRecord[] = [];
  private _messageIdCounter = 0;

  // ── Tool-call index ──────────────────────────────────────────────────
  // Maps toolCallId → toolName so a tool.result event can recover the
  // tool name (the result event itself doesn't carry it).
  private _toolCallNames: Map<string, string> = new Map();

  constructor(
    private agent: Agent,
    config?: Partial<CompactionConfig>,
  ) {
    this._compactionConfig = { ...DEFAULT_COMPACTION_CONFIG, ...config };
    this._contextLimit = this._compactionConfig.contextLimit;
  }

  // =====================================================================
  // Message appending (with priority tagging)
  // =====================================================================

  appendUserMessage(content: string, origin?: PromptOrigin): void {
    const priority = this.assignPriority(content, "user");
    this.appendMessage({
      role: "user",
      content,
      origin,
      priority,
      messageId: this.nextMessageId(),
    });
  }

  appendSystemReminder(content: string, origin?: PromptOrigin): void {
    const text = `<system-reminder>\n${content}\n</system-reminder>`;
    this.appendMessage({
      role: "user",
      content: text,
      origin,
      priority: "high", // System reminders are important
      messageId: this.nextMessageId(),
    });
  }

  appendAssistantMessage(content: string, toolCallId?: string): void {
    const priority = this.assignPriority(content, "assistant");
    this.appendMessage({
      role: "assistant",
      content,
      toolCallId,
      priority,
      messageId: this.nextMessageId(),
    });
  }

  appendToolResult(
    content: string,
    toolName: string,
    toolCallId: string,
    isError?: boolean,
  ): void {
    let priority: RetentionPriority = "normal";

    // Large tool outputs get low priority
    if (content.length > 10_000) {
      priority = "low";
    }
    // Error outputs get high priority
    if (isError) {
      priority = "high";
    }

    this.appendMessage({
      role: "tool",
      content,
      toolName,
      toolCallId,
      isError: isError ?? false,
      priority,
      messageId: this.nextMessageId(),
    });
  }

  /** Append a raw message with priority auto-assignment. */
  appendLoopEvent(event: LoopRecordedEvent): void {
    if (event.type === "tool.call") {
      // Index the tool name so the corresponding tool.result can recover it.
      this._toolCallNames.set(event.toolCallId, event.name);
      return;
    }
    if (event.type === "tool.result") {
      const result = event.result;
      const output = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      const toolName = this._toolCallNames.get(event.toolCallId) ?? "unknown";
      this.appendToolResult(
        output,
        toolName,
        event.toolCallId,
        result.isError,
      );
    }
    // Other event types are not recorded in the message history directly
  }

  /** Append with explicit priority override. */
  appendMessageWithPriority(
    msg: Omit<PrioritizedMessage, "messageId">,
  ): void {
    this.pushHistory({
      ...msg,
      messageId: this.nextMessageId(),
    });
  }

  // =====================================================================
  // Priority assignment heuristics
  // =====================================================================

  /**
   * Assign a retention priority to a message based on content and role.
   */
  private assignPriority(content: string, role: string): RetentionPriority {
    if (!content || content.length === 0) return "normal";

    const lower = content.toLowerCase();

    // User messages with explicit directives → critical
    if (role === "user") {
      if (
        /\b(must|required?|important|critical|essential|mandatory)\b/i.test(lower)
      ) {
        return "critical";
      }
      if (
        /\b(should|need|want|please|make sure|ensure|goal|objective)\b/i.test(lower)
      ) {
        return "high";
      }
    }

    // Messages tagged with decision metadata → high
    if (
      lower.includes("decision") ||
      lower.includes("rationale") ||
      lower.includes("constraint") ||
      lower.includes("architecture") ||
      lower.includes("design choice")
    ) {
      return "high";
    }

    // Long tool outputs → low
    if (role === "tool" && content.length > 10_000) {
      return "low";
    }

    // Short intermediate reasoning → low
    if (role === "assistant" && content.length < 50) {
      return "low";
    }

    // Messages containing system reminders (compaction summaries, boundary constraints) → high
    if (content.includes("<system-reminder>") || content.includes("</system-reminder>")) {
      return "high";
    }

    return "normal";
  }

  // =====================================================================
  // Queries
  // =====================================================================

  /** Get the full message history ordered by append time. */
  get history(): readonly PrioritizedMessage[] {
    return this._history;
  }

  /** Get raw messages for LLM consumption (strip priority/messageId). */
  get messages(): ContextMessage[] {
    return this._history.map((m) => {
      const { priority: _p, messageId: _id, ...rest } = m;
      return rest;
    });
  }

  /** Get estimated token count of current history. */
  get tokenCount(): number {
    return this._tokenCount;
  }

  /** Get pending facts accumulated since last compaction flush. */
  get pendingFacts(): readonly ExtractedFact[] {
    return this._pendingFacts;
  }

  /** Get compaction history for diagnostics. */
  get compactionRecords(): readonly CompactionRecord[] {
    return this._compactionRecords;
  }

  /** Get the current context pressure ratio (0-1). */
  get contextPressure(): number {
    return this._tokenCount / this._contextLimit;
  }

  /** Get the configured context token limit. */
  get contextLimit(): number {
    return this._contextLimit;
  }

  // =====================================================================
  // Clear / reset
  // =====================================================================

  clear(): void {
    this._history = [];
    this._tokenCount = 0;
    this._pendingFacts = [];
    this.agent.emitStatusUpdated?.();
  }

  /**
   * Remove all messages whose content contains the given substring.
   * Used by the MemoryCoordinator's forget() to scrub items from working memory.
   * Returns the number of messages removed.
   */
  removeContentContaining(substring: string): number {
    const before = this._history.length;
    this._history = this._history.filter(
      (msg) => !msg.content?.includes(substring),
    );
    const removed = before - this._history.length;
    if (removed > 0) {
      this._tokenCount = this.recomputeTokenCount();
    }
    return removed;
  }

  // =====================================================================
  // Compaction trigger check & graduated protocol
  // =====================================================================

  /**
   * Check if compaction is needed and run the appropriate tier.
   *
   * Call this after each message append. Returns true if compaction ran.
   */
  checkAndCompact(): boolean {
    const pressure = this.contextPressure;
    const trigger = this._compactionConfig.triggerRatio;
    const reserved = this._compactionConfig.reservedContextSize;
    const availableTokens = this._contextLimit - this._tokenCount;

    // Only trigger if pressure is above the ratio AND we need more room
    if (pressure < trigger || availableTokens >= reserved) {
      return false;
    }

    // Determine tier based on pressure
    if (pressure >= 0.92) {
      return this.compactTier3();
    }
    if (pressure >= 0.80) {
      return this.compactTier2();
    }
    // pressure >= trigger but < 0.80, and we need more room
    return this.compactTier1();
  }

  /**
   * Tier 1 compaction (trigger to <80%).
   * Remove low-priority messages, merge consecutive tool results.
   */
  private compactTier1(): boolean {
    const beforeCount = this._history.length;
    const beforeTokens = this._tokenCount;

    const newHistory: PrioritizedMessage[] = [];
    let i = 0;

    while (i < this._history.length) {
      const msg = this._history[i]!;

      // Remove low-priority messages entirely
      if (msg.priority === "low") {
        i++;
        continue;
      }

      // Merge consecutive tool result pairs from the same tool
      if (
        msg.role === "tool" &&
        i + 1 < this._history.length &&
        this._history[i + 1]!.role === "tool" &&
        this._history[i + 1]!.toolName === msg.toolName &&
        !msg.isError &&
        !this._history[i + 1]!.isError
      ) {
        // Keep only the latest (second) one
        newHistory.push(this._history[i + 1]!);
        i += 2;
        continue;
      }

      newHistory.push(msg);
      i++;
    }

    const afterCount = newHistory.length;
    this._history = newHistory;
    this._tokenCount = this.recomputeTokenCount();

    this._compactionRecords.push({
      timestamp: new Date().toISOString(),
      tier: 1,
      totalMessagesBefore: beforeCount,
      totalMessagesAfter: afterCount,
      tokensSaved: beforeTokens - this._tokenCount,
      contextPressure: beforeTokens / this._contextLimit,
    });

    return afterCount < beforeCount;
  }

  /**
   * Tier 2 compaction (80-92%).
   * Remove low-priority messages, keep high and critical intact,
   * build episode summary from normal-priority messages.
   */
  private compactTier2(): boolean {
    const beforeCount = this._history.length;
    const beforeTokens = this._tokenCount;

    // Extract facts from low and normal priority messages before removing them
    const compactable = this._history.filter(
      (m) => m.priority === "low" || m.priority === "normal",
    );
    const extractedFacts = this._factExtractor.extract(compactable);
    for (const fact of extractedFacts) {
      // Merge into pending facts (dedup by claim)
      const existing = this._pendingFacts.find(
        (f) => f.claim.toLowerCase() === fact.claim.toLowerCase(),
      );
      if (existing) {
        existing.confidence = Math.max(existing.confidence, fact.confidence);
        existing.sourceMessageIds.push(...fact.sourceMessageIds);
      } else {
        this._pendingFacts.push(fact);
      }
    }

    // Keep critical and high priority messages, compress normal to summary
    const kept: PrioritizedMessage[] = [];
    const normalBatch: PrioritizedMessage[] = [];

    for (const msg of this._history) {
      if (msg.priority === "critical" || msg.priority === "high") {
        kept.push(msg);
      } else if (msg.priority === "normal") {
        normalBatch.push(msg);
      }
      // Low-priority messages are dropped
    }

    // Build a structured summary from normal-priority messages
    if (normalBatch.length > 0) {
      const summary = this.buildCompactionSummary(normalBatch);
      kept.push({
        role: "assistant",
        content: `<episode-summary>\n${summary}\n</episode-summary>`,
        priority: "normal",
        messageId: this.nextMessageId(),
        origin: { kind: "compaction_summary" },
      });
    }

    const afterCount = kept.length;
    this._history = kept;
    this._tokenCount = this.recomputeTokenCount();

    this._compactionRecords.push({
      timestamp: new Date().toISOString(),
      tier: 2,
      totalMessagesBefore: beforeCount,
      totalMessagesAfter: afterCount,
      tokensSaved: beforeTokens - this._tokenCount,
      contextPressure: beforeTokens / this._contextLimit,
    });

    return afterCount < beforeCount;
  }

  /**
   * Tier 3 compaction (92%+).
   * Compress everything except critical messages.
   * Flush all pending facts to the coordinator.
   */
  private compactTier3(): boolean {
    const beforeCount = this._history.length;
    const beforeTokens = this._tokenCount;

    // Extract facts from all compactable messages
    const compactable = this._history.filter(
      (m) => m.priority !== "critical",
    );
    const extractedFacts = this._factExtractor.extract(compactable);
    for (const fact of extractedFacts) {
      const existing = this._pendingFacts.find(
        (f) => f.claim.toLowerCase() === fact.claim.toLowerCase(),
      );
      if (existing) {
        existing.confidence = Math.max(existing.confidence, fact.confidence);
        existing.sourceMessageIds.push(...fact.sourceMessageIds);
      } else {
        this._pendingFacts.push(fact);
      }
    }

    // Keep only critical messages
    const kept: PrioritizedMessage[] = this._history.filter(
      (m) => m.priority === "critical",
    );

    // Build a comprehensive summary of everything that was compacted
    if (compactable.length > 0) {
      const summary = this.buildCompactionSummary(compactable);
      kept.push({
        role: "assistant",
        content: `<episode-summary>\n${summary}\n</episode-summary>`,
        priority: "high",
        messageId: this.nextMessageId(),
        origin: { kind: "compaction_summary" },
      });
    }

    // Emit flush event via the agent's RPC for EpisodicRecall (Step 24) to consume
    this.agent.emitEvent?.({
      type: "memory.compaction.flush",
      pendingFacts: [...this._pendingFacts],
      timestamp: new Date().toISOString(),
    } as never);

    // Clear the pending buffer after flushing
    this._pendingFacts = [];

    const afterCount = kept.length;
    this._history = kept;
    this._tokenCount = this.recomputeTokenCount();

    this._compactionRecords.push({
      timestamp: new Date().toISOString(),
      tier: 3,
      totalMessagesBefore: beforeCount,
      totalMessagesAfter: afterCount,
      tokensSaved: beforeTokens - this._tokenCount,
      contextPressure: beforeTokens / this._contextLimit,
    });

    return afterCount < beforeCount;
  }

  // =====================================================================
  // Internals
  // =====================================================================

  private pushHistory(...messages: PrioritizedMessage[]): void {
    this._history.push(...messages);
    this._tokenCount = this.recomputeTokenCount();
    this.checkAndCompact();
  }

  private appendMessage(msg: PrioritizedMessage): void {
    this.pushHistory(msg);
  }

  private nextMessageId(): string {
    return `msg-${++this._messageIdCounter}`;
  }

  /**
   * Recompute token count from current history.
   * Uses a simple heuristic: ~4 chars per token.
   */
  private recomputeTokenCount(): number {
    let total = 0;
    for (const msg of this._history) {
      total += 2; // Role overhead
      total += Math.ceil(msg.content.length / 4);
      if (msg.toolCallId) total += Math.ceil(msg.toolCallId.length / 4);
    }
    return total;
  }

  /**
   * Build a structured compaction summary from a batch of messages.
   *
   * Extracts key facts, decisions, and outcomes from the messages
   * using the FactExtractor, then formats them as structured text.
   */
  private buildCompactionSummary(messages: PrioritizedMessage[]): string {
    const facts = this._factExtractor.extract(messages);
    const lines: string[] = [];

    lines.push(`Compaction Summary (${messages.length} messages)`);
    lines.push(`Compacted at: ${new Date().toISOString()}`);
    lines.push("");

    if (facts.length > 0) {
      lines.push("Key Facts:");
      for (const fact of facts) {
        const indicator = fact.confidence >= 0.7 ? "✓" : "?";
        lines.push(`  ${indicator} ${fact.claim}`);
      }
      lines.push("");
    }

    // Extract any decisions from the messages
    const decisionLines: string[] = [];
    for (const msg of messages) {
      const lower = msg.content.toLowerCase();
      if (
        lower.includes("decision") ||
        lower.includes("decided") ||
        lower.includes("chose") ||
        lower.includes("selected")
      ) {
        // Extract the relevant sentence
        const sentences = msg.content.split(/[.!?\n]+/);
        for (const sent of sentences) {
          if (
            /\b(decision|decided|chose|selected|opted|resolved)\b/i.test(sent)
          ) {
            decisionLines.push(sent.trim());
          }
        }
      }
    }

    if (decisionLines.length > 0) {
      lines.push("Decisions:");
      for (const dl of decisionLines.slice(0, 10)) {
        lines.push(`  - ${dl}`);
      }
      lines.push("");
    }

    // Count outcomes
    const toolErrors = messages.filter((m) => m.role === "tool" && m.isError);
    if (toolErrors.length > 0) {
      lines.push(`Tool Errors: ${toolErrors.length}`);
    }

    return lines.join("\n");
  }
}