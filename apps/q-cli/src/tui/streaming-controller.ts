/**
 * Streaming Controller — Manages the flush-based streaming of agent output.
 *
 * Key improvements over previous version:
 * - Uses a fixed-interval timer (not re-scheduled on every delta) so the
 *   UI updates at a consistent ~25fps even under heavy delta pressure.
 * - Maintains a "have flushed at least once" flag so the fallback renderer
 *   in VTui can know whether streaming delivered any content.
 * - All flush state properly managed so endTurn() + isActive() work correctly.
 * - Thinking content and tool calls are placed inside a ThinkingSectionComponent
 *   that collapses after the turn completes.
 * - Supports a custom label (e.g. "step-001") for sub-agent streaming.
 */

import type { Container } from "@earendil-works/pi-tui";
import type { ColorPalette, ToolCallBlockData, ToolResultBlockData } from "./types.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { ToolCallComponent } from "./components/tool-call.js";
import { ThinkingSectionComponent } from "./components/thinking-section.js";

const FLUSH_INTERVAL_MS = 40; // ~25fps for smooth streaming

/**
 * Manages streaming state and flush scheduling for a single turn.
 */
export class StreamingController {
  private textBuffer = "";
  private thinkingBuffer = "";
  private toolCallBuffers = new Map<string, string>();

  private textComponent: AssistantMessageComponent | null = null;
  private thinkingSection: ThinkingSectionComponent | null = null;
  private thinkingComponent: AssistantMessageComponent | null = null;
  private toolCallComponents = new Map<string, ToolCallComponent>();

  /** Fixed-interval timer — never cancelled/rescheduled; runs every ~40ms while active */
  private fixedTimer: ReturnType<typeof setTimeout> | null = null;

  private pendingTextFlush = false;
  private pendingThinkingFlush = false;
  private pendingToolCallFlush = new Set<string>();

  private transcriptContainer: Container;
  private colors: ColorPalette;
  private streaming: boolean = false;
  private turnActive: boolean = false;

  /** Tracks whether any content has been flushed this turn */
  private hasFlushedContent: boolean = false;

  /** Custom label for the assistant component (e.g. "step-001") */
  private stepLabel: string | null = null;

  constructor(transcriptContainer: Container, colors: ColorPalette) {
    this.transcriptContainer = transcriptContainer;
    this.colors = colors;
  }

  // ── Turn Lifecycle ──────────────────────────────────────────────────

  beginTurn(label?: string): void {
    this.turnActive = true;
    this.streaming = true;
    this.hasFlushedContent = false;
    this.textBuffer = "";
    this.thinkingBuffer = "";
    this.toolCallBuffers.clear();
    this.textComponent = null;
    this.thinkingSection = null;
    this.thinkingComponent = null;
    this.stepLabel = label ?? null;

    // Start the fixed-interval flush timer
    this.startFixedTimer();
  }

  endTurn(): void {
    this.turnActive = false;

    // Stop the fixed timer
    this.stopFixedTimer();

    // One final flush to push all remaining content
    this.flushNow();

    // Mark components as no longer streaming
    if (this.textComponent) {
      this.textComponent.setStreaming(false);
    }
    if (this.thinkingComponent) {
      this.thinkingComponent.setStreaming(false);
    }

    // Collapse the thinking section so it shows just a summary
    if (this.thinkingSection) {
      this.thinkingSection.collapse();
    }

    this.streaming = false;
  }

  /**
   * Returns true if streaming is still live (content may still arrive).
   * After endTurn(), returns false.
   */
  isActive(): boolean {
    return this.turnActive;
  }

  /**
   * Returns true if any content was actually flushed to the UI during
   * this turn. Used by VTui to decide whether to fall back to context
   * polling when streaming produced no visible output.
   */
  get hasDeliveredContent(): boolean {
    return this.hasFlushedContent;
  }

  /** Get the thinking section component (for keyboard shortcut toggling) */
  getThinkingSection(): ThinkingSectionComponent | null {
    return this.thinkingSection;
  }

  // ── Text Deltas ─────────────────────────────────────────────────────

  appendText(delta: string): void {
    if (!this.turnActive) return;
    this.textBuffer += delta;
    this.pendingTextFlush = true;
  }

  appendThinking(delta: string): void {
    if (!this.turnActive) return;
    this.thinkingBuffer += delta;
    this.pendingThinkingFlush = true;
  }

  // ── Tool Calls ──────────────────────────────────────────────────────

  startToolCall(data: ToolCallBlockData): void {
    // Flush any pending text/thinking before showing the tool call
    this.flushNow();
    const component = new ToolCallComponent(data, this.colors);
    this.toolCallComponents.set(data.id, component);

    // Ensure thinking section exists and add tool call to it
    this.ensureThinkingSection();
    this.thinkingSection!.addChild(component);
    this.hasFlushedContent = true;
  }

  appendToolCallDelta(toolCallId: string, argumentsPart: string): void {
    if (!this.turnActive) return;
    const existing = this.toolCallBuffers.get(toolCallId) ?? "";
    this.toolCallBuffers.set(toolCallId, existing + argumentsPart);
    this.pendingToolCallFlush.add(toolCallId);
  }

  completeToolCall(toolCallId: string, result: ToolResultBlockData): void {
    const component = this.toolCallComponents.get(toolCallId);
    if (component) {
      component.setResult(result);
      this.toolCallComponents.delete(toolCallId);
      this.toolCallBuffers.delete(toolCallId);
    }
    // Also flush immediately so the result appears right away
    this.flushNow();
    this.hasFlushedContent = true;
  }

  // ── Thinking Section Helpers ────────────────────────────────────────

  private ensureThinkingSection(): void {
    if (this.thinkingSection) return;
    this.thinkingSection = new ThinkingSectionComponent(this.colors);
    this.transcriptContainer.addChild(this.thinkingSection);
  }

  // ── Fixed-Interval Timer ────────────────────────────────────────────

  /**
   * Start a fixed-interval timer that flushes on every tick.
   * Unlike the old approach (cancelling + rescheduling), this timer
   * runs at a steady ~25fps, ensuring the UI updates smoothly even
   * when deltas arrive faster than the interval.
   */
  private startFixedTimer(): void {
    if (this.fixedTimer) return;
    this.fixedTimer = setInterval(() => {
      this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  private stopFixedTimer(): void {
    if (this.fixedTimer !== null) {
      clearInterval(this.fixedTimer);
      this.fixedTimer = null;
    }
  }

  flushNow(): void {
    this.flush();
  }

  // ── Flush ───────────────────────────────────────────────────────────

  private flush(): void {
    // Flush thinking
    if (this.pendingThinkingFlush && this.thinkingBuffer) {
      this.pendingThinkingFlush = false;

      // Ensure thinking section exists
      this.ensureThinkingSection();

      if (!this.thinkingComponent) {
        this.thinkingComponent = new AssistantMessageComponent(
          this.colors,
          { kind: "thinking" },
        );
        this.thinkingSection!.addChild(this.thinkingComponent);
      }
      this.thinkingComponent.appendContent(this.thinkingBuffer);
      this.thinkingBuffer = "";
      this.thinkingSection!.setHadThinking(true);
      this.hasFlushedContent = true;
    }

    // Flush text (final answer — goes outside thinking section)
    if (this.pendingTextFlush && this.textBuffer) {
      this.pendingTextFlush = false;
      if (!this.textComponent) {
        this.textComponent = new AssistantMessageComponent(
          this.colors,
          { kind: "assistant", label: this.stepLabel ?? undefined },
        );
        this.textComponent.setStreaming(true);
        this.transcriptContainer.addChild(this.textComponent);
      }
      this.textComponent.appendContent(this.textBuffer);
      this.textBuffer = "";
      this.hasFlushedContent = true;
    }

    // Flush tool call argument deltas
    if (this.pendingToolCallFlush.size > 0) {
      for (const id of this.pendingToolCallFlush) {
        const buffer = this.toolCallBuffers.get(id);
        const component = this.toolCallComponents.get(id);
        if (buffer !== undefined && component) {
          component.updateStreamingArgs(buffer);
        }
      }
      this.pendingToolCallFlush.clear();
      this.hasFlushedContent = true;
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  reset(): void {
    this.stopFixedTimer();
    this.textBuffer = "";
    this.thinkingBuffer = "";
    this.toolCallBuffers.clear();
    this.pendingTextFlush = false;
    this.pendingThinkingFlush = false;
    this.pendingToolCallFlush.clear();
    this.textComponent = null;
    this.thinkingSection = null;
    this.thinkingComponent = null;
    this.toolCallComponents.clear();
    this.turnActive = false;
    this.streaming = false;
    this.hasFlushedContent = false;
    this.stepLabel = null;
  }
}