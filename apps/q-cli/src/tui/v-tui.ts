/**
 * Qode TUI — The main Terminal User Interface for the Qode Agent.
 *
 * Completely revamped rendering pipeline:
 * 1. Uses pi-tui's Markdown component for full markdown support
 * 2. Streaming with fixed-interval flush-based updates (smooth ~25fps text flow)
 * 3. Rich tool call rendering with inline diff previews
 * 4. Polling fallback that catches context-committed messages so tool calls
 *    and results are NEVER missed even if streaming events don't arrive.
 * 5. Waiting indicator so the user sees something immediately.
 * 6. Readable color palette (cyan primary, not hard-to-see purple)
 * 7. Thinking section collapses after turn completes; Ctrl+I to expand/inspect,
 *    Ctrl+O to toggle the thinking card visibility on/off.
 * 8. Full slash command suite: /help, /status, /session, /clear, /exit, /version
 *    with autocomplete and interactive dashboards.
 */

import {
  TUI,
  Container,
  Editor,
  ProcessTerminal,
  type Terminal,
  type MarkdownTheme,
  type SlashCommand,
  CombinedAutocompleteProvider,
} from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import chalk from "chalk";

import type { Agent } from "@q/agent-core";
import type {
  TuiAppState,
  TuiOptions,
  ColorPalette,
  TranscriptEntry,
  AgentEvent,
  ToolCallBlockData,
} from "./types.js";
import { DEFAULT_COLORS } from "./types.js";
import { createMarkdownTheme } from "./theme.js";
import { WelcomeComponent } from "./components/welcome.js";
import { UserMessageComponent } from "./components/user-message.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { ToolCallComponent } from "./components/tool-call.js";
import { StatusMessageComponent } from "./components/status-message.js";
import { FileExplorerComponent } from "./components/file-explorer.js";
import { StreamingController } from "./streaming-controller.js";
import { HelpPanelComponent } from "./components/help-panel.js";
import { StatusDashboardComponent } from "./components/status-dashboard.js";

// ── Slash command system ────────────────────────────────────────────
import { dispatchInput, ALL_SLASH_COMMANDS, sortSlashCommands, type SlashCommandHost, type QSlashCommand } from "./commands/index.js";
import { ConfirmationDropdownComponent } from "./components/confirmation-dropdown.js";
import { RevisionInputComponent } from "./components/revision-input.js";

// ── Constants ──────────────────────────────────────────────────────────

const VERSION = "0.1.0";

/**
 * Interval at which we poll agent.context.messages to catch tool calls
 * and results that the streaming event pipeline may have missed.
 * This is the key fallback that makes the TUI robust.
 */
const CONTEXT_POLL_INTERVAL_MS = 250;

// ── Qode TUI Class ───────────────────────────────────────────────────────

export class QTui {
  // Core
  private agent: Agent;
  private workDir: string;
  private sessionId: string;
  private colors: ColorPalette;
  private markdownTheme: MarkdownTheme;

  // TUI Framework
  private terminal: Terminal;
  private ui: TUI;
  private editor: Editor;
  private running: boolean = false;

  // Containers
  private transcriptContainer: Container;
  private editorContainer: Container;
  private fileExplorerContainer: Container;
  private statusBarContainer: Container;

  // Components
  private fileExplorer: FileExplorerComponent;
  private welcomeRendered: boolean = false;

  // Streaming
  private streaming: StreamingController;

  // Context polling fallback
  private contextPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastContextMessageCount: number = 0;
  /** Messages we've already processed from context (to avoid duplicates) */
  private seenContextToolCallIds: Set<string> = new Set();

  // State
  private appState: TuiAppState;
  private transcriptEntries: TranscriptEntry[] = [];
  private currentTurnId: number | undefined;
  private currentStep: number = 0;
  private isProcessing: boolean = false;
  private abortController: AbortController | null = null;
  /** Waiting phase start time so we can show a "thinking" indicator */
  private waitingStartTime: number = 0;
  /** Start time of the TUI session for uptime tracking */
  private startTime: number = Date.now();
  /** Turn counter */
  private turnCount: number = 0;

  // Dialog management
  private activeDialog: "help" | "status" | "confirmation" | "revision" | null = null;
  private dialogComponent: (Container & import("@earendil-works/pi-tui").Focusable) | null = null;
  private savedEditorContent: string = "";

  // Modus Maximus state
  private modusMaximusCurrentStepIndex: number = -1;
  private modusMaximusPlanStatus: StatusMessageComponent | null = null;
  private modusMaximusStepCount: number = 0;
  private modusMaximusPlanContent: string = "";

  // Orchestrator reference
  private orchestratorHost?: {
    setCurrentMode(mode: string): void;
    getCurrentMode(): string;
    resolveModusMaximusConfirmation?(response: { choice: "looks-good" | "needs-revision" | "redo"; revisionText?: string }): void;
    submitPrompt?(prompt: string): Promise<import("../orchestrator/modes/types.js").ExecutionResult>;
    cancel?(): void;
  };

  // Event handlers
  private onExit?: () => Promise<void>;
  /** Dispose function for the global keyboard input listener */
  private disposeInputListener?: () => void;

  constructor(options: TuiOptions) {
    this.agent = options.agent;
    this.workDir = options.workDir;
    this.sessionId = options.sessionId;
    this.colors = { ...DEFAULT_COLORS };
    this.markdownTheme = createMarkdownTheme(this.colors);
    this.orchestratorHost = options.orchestrator;

    // App state
    this.appState = {
      workDir: this.workDir,
      sessionId: this.sessionId,
      model: this.agent.config.model || "",
      version: VERSION,
      permissionMode: options.permissionMode,
      planMode: options.planMode,
      thinking: false,
      streamingPhase: "idle",
      streamingStartTime: 0,
      contextTokens: 0,
      maxContextTokens: 128000,
      contextUsage: 0,
      isCompacting: false,
      isReplaying: false,
      executionMode: "not set",
      modusMaximusPhase: "idle",
    };

    // Create terminal
    this.terminal = new ProcessTerminal();

    // Create TUI
    this.ui = new TUI(this.terminal, true);

    // Create containers
    this.transcriptContainer = new Container();
    this.fileExplorerContainer = new Container();
    this.editorContainer = new Container();
    this.statusBarContainer = new Container();

    // Create file explorer (hidden by default)
    this.fileExplorer = new FileExplorerComponent(this.workDir, this.colors);

    // Create streaming controller
    this.streaming = new StreamingController(
      this.transcriptContainer,
      this.colors,
    );

    // Create editor
    const editorTheme = {
      borderColor: (s: string) => chalk.hex(this.colors.primary)(s),
      selectList: {
        selectedPrefix: (s: string) => chalk.hex(this.colors.primary)(s),
        selectedText: (s: string) =>
          chalk.bgHex(this.colors.surface)(
            chalk.hex(this.colors.primary)(s),
          ),
        description: (s: string) => chalk.hex(this.colors.textDim)(s),
        scrollInfo: (s: string) => chalk.hex(this.colors.textDim)(s),
        noMatch: (s: string) => chalk.hex(this.colors.textDim)(s),
      },
    };

    this.editor = new Editor(this.ui, editorTheme, {
      paddingX: 2,
      autocompleteMaxVisible: 8,
    });

    // Editor submit handler
    this.editor.onSubmit = (text: string) => {
      this.handleUserInput(text);
    };

    this.editor.onChange = (text: string) => {
      this.updateEditorBorderHighlight(text);
    };

    // Setup slash command autocomplete
    this.setupAutocomplete();

    // Build layout
    this.buildLayout();

    // Wire up agent event bridge
    this.setupAgentEventBridge();
  }

  setOnExit(handler: () => Promise<void>): void {
    this.onExit = handler;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.running = true;

    // Render welcome banner
    this.renderWelcome();

    // Add editor
    this.editorContainer.addChild(this.editor);

    // Set focus to editor
    this.ui.setFocus(this.editor);

    // Register global keyboard shortcuts (Ctrl+I, Ctrl+O)
    this.registerGlobalShortcuts();

    // Start the event loop
    this.ui.start();
  }

  async stop(exitCode?: number): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Remove global input listener
    this.disposeInputListener?.();

    // Stop context polling
    this.stopContextPolling();

    // Cancel any active turn
    this.abortController?.abort();

    // Stop the UI
    this.ui.stop();

    // Restore terminal
    this.terminal.showCursor();

    if (this.onExit) {
      await this.onExit();
    }

    process.exit(exitCode ?? 0);
  }

  // ── Global Keyboard Shortcuts ───────────────────────────────────────

  private registerGlobalShortcuts(): void {
    this.disposeInputListener = this.ui.addInputListener((data) => {
      // ── If a dialog is active, route input directly to it ─────────
      // We consume the event here rather than relying on pi-tui's focus
      // routing, which can be unreliable for custom Focusable components
      // mounted as editor replacements.
      if (this.activeDialog === "confirmation" || this.activeDialog === "revision") {
        // Allow Ctrl+Q (exit), Ctrl+C (interrupt with empty input) through
        if (matchesKey(data, "ctrl+q")) {
          void this.handleExitCommand();
          return { consume: true };
        }

        const dd = this.dialogComponent as any;
        if (dd && typeof dd.handleInput === "function") {
          dd.handleInput(data);
          this.ui.requestRender();
        }
        return { consume: true };
      }
      if (this.activeDialog === "help" || this.activeDialog === "status") {
        // Existing dialogs handle their own input via pi-tui focus routing
        return undefined;
      }

      // Ctrl+I — expand/collapse the thinking section
      if (matchesKey(data, "ctrl+i")) {
        const section = this.streaming.getThinkingSection();
        if (section) {
          section.toggleExpanded();
          this.ui.requestRender();
        }
        return { consume: true };
      }

      // Ctrl+O — toggle the thinking section visibility on/off
      if (matchesKey(data, "ctrl+o")) {
        const section = this.streaming.getThinkingSection();
        if (section) {
          section.toggleVisibility();
          this.ui.requestRender();
        }
        return { consume: true };
      }

      // Ctrl+C — if there is text in the input bar, clear it
      if (matchesKey(data, "ctrl+c")) {
        const currentText = this.editor.getText();
        if (currentText.trim().length > 0) {
          this.editor.setText("");
          this.editor.borderColor = (s: string) =>
            chalk.hex(this.colors.border)(s);
          this.ui.requestRender();
          return { consume: true };
        }
        // If no text, let the default behavior pass through (e.g. SIGINT)
        return undefined;
      }

      // Ctrl+Q — equivalent to /exit, quits the TUI gracefully
      if (matchesKey(data, "ctrl+q")) {
        // Run exit asynchronously without blocking the input listener
        void this.handleExitCommand();
        return { consume: true };
      }

      // Let other input pass through
      return undefined;
    });
  }

  /**
   * Gracefully exit the TUI — equivalent to the /exit command.
   */
  private async handleExitCommand(): Promise<void> {
    this.showStatus("Goodbye!");
    await new Promise((r) => setTimeout(r, 100));
    await this.stop(0);
  }

  // ── Autocomplete Setup ─────────────────────────────────────────────

  /**
   * Setup slash command autocomplete using pi-tui's CombinedAutocompleteProvider.
   * This provides fuzzy matching on command names with descriptions.
   */
  private setupAutocomplete(): void {
    const slashCommands: SlashCommand[] = (ALL_SLASH_COMMANDS as unknown as QSlashCommand[]).map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      argumentHint: cmd.usage ? cmd.usage.split(/\s+/).slice(1).join(" ") : undefined,
      getArgumentCompletions: cmd.getArgumentCompletions,
    }));
    const provider = new CombinedAutocompleteProvider(slashCommands, this.workDir);
    this.editor.setAutocompleteProvider(provider);
  }

  // ── Dialog Management ──────────────────────────────────────────────

  /**
   * Mount a dialog component as a replacement for the editor.
   * The dialog takes over the editor container and captures focus.
   */
  private mountDialog(component: Container & import("@earendil-works/pi-tui").Focusable, dialogType?: string): void {
    this.activeDialog = (dialogType as any) ?? "help";
    this.dialogComponent = component;

    // Save editor state
    this.savedEditorContent = this.editor.getText();

    // Clear editor container
    this.editorContainer.clear();
    this.editorContainer.addChild(component);
    this.ui.setFocus(component);
    this.ui.requestRender();
  }

  /**
   * Restore the editor after a dialog closes.
   */
  private restoreEditor(): void {
    this.activeDialog = null;
    this.dialogComponent = null;

    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  // ── Help Panel ─────────────────────────────────────────────────────

  showHelpPanel(): void {
    const panel = new HelpPanelComponent({
      colors: this.colors,
      onClose: () => {
        this.restoreEditor();
      },
      maxVisible: Math.max(10, this.terminal.rows - 6),
    });
    this.activeDialog = "help";
    this.mountDialog(panel);
  }

  // ── Status Dashboard ───────────────────────────────────────────────

  showStatusDashboard(): void {
    const dashboard = new StatusDashboardComponent({
      state: this.appState,
      turnCount: this.turnCount,
      uptimeMs: Date.now() - this.startTime,
      colors: this.colors,
      onClose: () => {
        this.restoreEditor();
      },
      maxVisible: Math.max(10, this.terminal.rows - 6),
    });
    this.activeDialog = "status";
    this.mountDialog(dashboard);
  }

  // ── Layout ──────────────────────────────────────────────────────────

  private buildLayout(): void {
    this.ui.clear();

    // Simple vertical layout: transcript on top, editor at the bottom
    this.ui.addChild(this.transcriptContainer);
    this.ui.addChild(this.editorContainer);
  }

  // ── Input Handling ──────────────────────────────────────────────────

  private handleUserInput(text: string): void {
    if (!text.trim()) return;

    // If a dialog is active, input goes there, not here
    if (this.activeDialog !== null) return;

    if (this.isProcessing) {
      this.showError(
        "Already processing a request. Please wait or press Ctrl+C to cancel.",
      );
      return;
    }

    // Try to dispatch as a slash command via the command system
    const host = this.createSlashCommandHost();
    const handled = dispatchInput(host, text);
    if (handled) return;

    // Not a command — send to agent
    this.sendToAgent(text);
  }

  /**
   * Create the SlashCommandHost interface for the dispatch system.
   */
  private createSlashCommandHost(): SlashCommandHost {
    const agent = this.agent;
    const orchHost = this.orchestratorHost;
    return {
      appState: this.appState,
      agent: {
        config: {
          update: (cfg: Record<string, unknown>) => agent.config.update(cfg),
          get model() {
            return agent.config.model;
          },
        },
        permission: {
          setMode: (mode: string) => (agent.permission.setMode as (m: string) => void)(mode),
        },
        context: {
          get messages() {
            return agent.context.messages;
          },
        },
      },
      orchestrator: orchHost
        ? {
            setCurrentMode: (mode: string) => orchHost.setCurrentMode(mode),
            getCurrentMode: () => orchHost.getCurrentMode(),
          }
        : undefined,
      showStatus: (message: string, colorOrType?: string) => this.showStatus(message, colorOrType),
      showError: (message: string) => this.showError(message),
      showNotice: (title: string, detail?: string) => {
        const component = new StatusMessageComponent(
          title + (detail ? ` — ${detail}` : ""),
          this.colors,
          "info",
        );
        this.transcriptContainer.addChild(component);
        this.ui.requestRender();
      },
      clearTranscript: () => this.clearTranscript(),
      stop: (exitCode?: number) => this.stop(exitCode),
      showHelpPanel: () => this.showHelpPanel(),
      showStatusDashboard: () => this.showStatusDashboard(),
      track: (_event: string, _props?: Record<string, unknown>) => {
        // Future: telemetry integration
      },
      requestRender: () => this.ui.requestRender(),
    };
  }

  // ── Agent Integration ───────────────────────────────────────────────

  private setupAgentEventBridge(): void {
    // Use setRpcChannel to properly wire the event bridge via the Agent's
    // official channel, rather than monkey-patching emitEvent.
    // This is more robust and won't break if other code wraps emitEvent.
    this.agent.setRpcChannel({
      emitEvent: (event: unknown) => {
        this.handleAgentEvent(event as AgentEvent);
      },
    });
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "turn.started":
        this.handleTurnStarted(event);
        break;
      case "turn.ended":
        this.handleTurnEnded(event);
        break;
      case "assistant.delta":
        this.handleTextDelta(event);
        break;
      case "thinking.delta":
        this.handleThinkingDelta(event);
        break;
      case "tool.call.started":
        this.handleToolCallStarted(event);
        break;
      case "tool.call.delta":
        this.handleToolCallDelta(event);
        break;
      case "tool.result":
        this.handleToolResult(event);
        break;
      case "tool.progress":
        // Progress updates — could show a progress bar
        break;
      case "turn.step.started":
        this.currentStep = event.step ?? 0;
        break;
      case "turn.step.completed":
        // Step completed — nothing special needed
        break;
      case "turn.step.retrying":
        this.showStatus(
          `Retrying step ${event.step}...`,
        );
        break;
      case "turn.step.interrupted":
        this.showError(
          event.message ?? event.reason ?? "Turn interrupted",
        );
        break;
      case "error":
        this.showError(event.message ?? "Unknown error");
        break;

      // ── Modus Maximus Events ───────────────────────────────────────
      case "modus-maximus.plan.started":
        this.handleModusMaximusPlanStarted(event);
        break;
      case "modus-maximus.plan.completed":
        this.handleModusMaximusPlanCompleted(event);
        break;
      case "modus-maximus.confirmation.request":
        this.handleModusMaximusConfirmationRequest(event);
        break;
      case "modus-maximus.step.started":
        this.handleModusMaximusStepStarted(event);
        break;
      case "modus-maximus.step.completed":
        this.handleModusMaximusStepCompleted(event);
        break;
      case "modus-maximus.step.failed":
        this.handleModusMaximusStepFailed(event);
        break;
      case "modus-maximus.summary":
        this.handleModusMaximusSummary(event);
        break;

      // ── Sub-agent streaming events ──────────────────────────────────
      case "subagent.event":
        this.handleSubagentEvent(event);
        break;
    }
  }

  private handleTurnStarted(event: AgentEvent): void {
    this.isProcessing = true;
    this.currentTurnId = event.turnId;
    this.currentStep = 0;
    this.turnCount++;

    this.appState.streamingPhase = "waiting";
    this.appState.streamingStartTime = Date.now();
    this.waitingStartTime = Date.now();

    // Record the current context message count so polling knows
    // where to start looking for new messages.
    this.lastContextMessageCount = this.agent.context.messages.length;

    // Begin streaming for this turn
    this.streaming.beginTurn();

    // Show an immediate waiting indicator so the user sees something
    this.showStatus("Thinking...", "info");

    // Start context polling fallback
    this.startContextPolling();

    this.ui.requestRender();
  }

  private handleTurnEnded(_event: AgentEvent): void {
    // ── Modus Maximus guard ───────────────────────────────────────────
    // When modus-maximus mode is active, the turn.ended event fires when
    // plan generation finishes (Phase 1). But Phases 2-4 are still running
    // within the same orchestrator submitPrompt() call. Do NOT reset
    // isProcessing since the outer sendToAgent manages that lifecycle.
    // We DO need to end streaming to stop the flush timer, and we DO need
    // to stop context polling since plan output was already streamed.
    const isModusMaximus = this.appState.executionMode === "modus-maximus";
    if (!isModusMaximus) {
      this.isProcessing = false;
    }
    this.appState.streamingPhase = "idle";

    // Stop context polling
    this.stopContextPolling();

    // Finalize streaming — flushes all remaining buffers, stops timer
    this.streaming.endTurn();

    // ── Fallback: only render missed context if NOT modus-maximus
    // (plan output was streamed directly via assistant.delta events)
    if (!isModusMaximus) {
      const streamingDelivered = this.streaming.hasDeliveredContent;
      if (!streamingDelivered) {
        this.renderMissedContextMessages();
      }
    }

    this.ui.requestRender();
  }

  /**
   * Scans agent.context.messages for assistant messages (text + tool calls)
   * and tool results that were NOT captured by the streaming event pipeline.
   * This is the robust fallback that guarantees nothing is missed.
   */
  private renderMissedContextMessages(): void {
    const messages = this.agent.context.messages;

    // Start from where we left off
    const startIdx = Math.max(0, this.lastContextMessageCount);

    for (let i = startIdx; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;

      if (msg.role === "assistant") {
        const content = typeof msg.content === "string" ? msg.content : "";

        // Render text content
        if (content.trim()) {
          const comp = new AssistantMessageComponent(this.colors);
          comp.setContent(content);
          this.transcriptContainer.addChild(comp);
        }

        // Render tool calls from this assistant message
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            // Avoid rendering the same tool call twice
            if (this.seenContextToolCallIds.has(tc.id)) continue;
            this.seenContextToolCallIds.add(tc.id);

            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            } catch {
              parsedArgs = { raw: tc.function.arguments };
            }

            const toolCallData: ToolCallBlockData = {
              id: tc.id,
              name: tc.function.name,
              args: parsedArgs,
              step: this.currentStep,
              turnId: String(this.currentTurnId),
            };

            const comp = new ToolCallComponent(toolCallData, this.colors);
            this.transcriptContainer.addChild(comp);
          }
        }
      } else if (msg.role === "tool") {
        // Match tool results with the corresponding tool call
        // We search backwards through tool calls we've seen
        const toolCallId = msg.toolCallId;
        if (toolCallId && !this.seenContextToolCallIds.has(toolCallId)) {
          this.seenContextToolCallIds.add(toolCallId);

          // Find the matching tool call in context to get the name and args
          let toolName = "unknown";
          let toolArgs: Record<string, unknown> = {};
          // Look for the tool call in assistant messages' toolCalls
          for (const m of messages) {
            if (m.role === "assistant" && m.toolCalls) {
              const found = m.toolCalls.find((tc) => tc.id === toolCallId);
              if (found) {
                toolName = found.function.name;
                try {
                  toolArgs = JSON.parse(found.function.arguments) as Record<string, unknown>;
                } catch {
                  toolArgs = { raw: found.function.arguments };
                }
                break;
              }
            }
          }

          const resultOutput = typeof msg.content === "string" ? msg.content : String(msg.content ?? "");

          const toolCallData: ToolCallBlockData = {
            id: toolCallId,
            name: toolName,
            args: toolArgs,
            step: this.currentStep,
            turnId: String(this.currentTurnId),
            result: {
              tool_call_id: toolCallId,
              output: resultOutput,
              is_error: msg.isError === true,
            },
          };

          const comp = new ToolCallComponent(toolCallData, this.colors);
          comp.setResult({
            tool_call_id: toolCallId,
            output: resultOutput,
            is_error: msg.isError === true,
          });
          this.transcriptContainer.addChild(comp);
        }
      }
    }

    // Update the last seen count
    this.lastContextMessageCount = messages.length;
  }

  private handleTextDelta(event: AgentEvent): void {
    if (!event.delta) return;
    this.appState.streamingPhase = "composing";
    this.streaming.appendText(event.delta);
    this.ui.requestRender();
  }

  private handleThinkingDelta(event: AgentEvent): void {
    if (!event.delta) return;
    this.appState.streamingPhase = "thinking";
    this.streaming.appendThinking(event.delta);
    this.ui.requestRender();
  }

  private handleToolCallStarted(event: AgentEvent): void {
    const toolCallId = event.toolCallId ?? `tc-${Date.now()}`;
    const toolCallData: ToolCallBlockData = {
      id: toolCallId,
      name: event.name ?? "unknown",
      args: (event.args as Record<string, unknown>) ?? {},
      description: event.description,
      step: this.currentStep,
      turnId: String(this.currentTurnId),
    };

    this.appState.streamingPhase = "tool";
    this.streaming.startToolCall(toolCallData);

    // Track this tool call as "seen" so the context poller doesn't duplicate it
    this.seenContextToolCallIds.add(toolCallId);

    this.ui.requestRender();
  }

  private handleToolCallDelta(event: AgentEvent): void {
    if (!event.toolCallId || !event.argumentsPart) return;
    this.streaming.appendToolCallDelta(
      event.toolCallId,
      event.argumentsPart,
    );
    this.ui.requestRender();
  }

  private handleToolResult(event: AgentEvent): void {
    if (!event.toolCallId) return;
    this.streaming.completeToolCall(event.toolCallId, {
      tool_call_id: event.toolCallId,
      output: String(event.output ?? ""),
      is_error: event.isError,
    });
    this.ui.requestRender();
  }

  // ── Context Polling Fallback ─────────────────────────────────────────

  /**
   * Start polling agent.context.messages for new assistant messages
   * and tool results that the streaming event pipeline may have missed.
   *
   * This is the KEY robustness mechanism — the experiment runner works
   * exactly this way (polling on setInterval), and it never misses output.
   */
  private startContextPolling(): void {
    this.stopContextPolling(); // Ensure no duplicate timers

    this.contextPollTimer = setInterval(() => {
      this.pollContextForMissedContent();
    }, CONTEXT_POLL_INTERVAL_MS);
  }

  private stopContextPolling(): void {
    if (this.contextPollTimer !== null) {
      clearInterval(this.contextPollTimer);
      this.contextPollTimer = null;
    }
  }

  /**
   * Check if new messages have appeared in context memory and render them.
   */
  private pollContextForMissedContent(): void {
    const messages = this.agent.context.messages;
    if (messages.length <= this.lastContextMessageCount) return;

    // Only poll when we're in an active turn
    if (!this.isProcessing) return;

    const startIdx = Math.max(0, this.lastContextMessageCount);
    let changed = false;

    for (let i = startIdx; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;

      if (msg.role === "assistant") {
        // Check for tool calls that were committed but not streamed
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            if (this.seenContextToolCallIds.has(tc.id)) continue;
            this.seenContextToolCallIds.add(tc.id);

            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            } catch {
              parsedArgs = { raw: tc.function.arguments };
            }

            const toolCallData: ToolCallBlockData = {
              id: tc.id,
              name: tc.function.name,
              args: parsedArgs,
              step: this.currentStep,
              turnId: String(this.currentTurnId),
            };

            this.streaming.startToolCall(toolCallData);
            changed = true;
          }
        }
      } else if (msg.role === "tool") {
        const toolCallId = msg.toolCallId;
        if (toolCallId && !this.seenContextToolCallIds.has(toolCallId)) {
          this.seenContextToolCallIds.add(toolCallId);

          this.streaming.completeToolCall(toolCallId, {
            tool_call_id: toolCallId,
            output: typeof msg.content === "string" ? msg.content : String(msg.content ?? ""),
            is_error: msg.isError === true,
          });
          changed = true;
        }
      }
    }

    this.lastContextMessageCount = messages.length;

    if (changed) {
      this.ui.requestRender();
    }
  }

  // ── Send to Agent ──────────────────────────────────────────────────

  private async sendToAgent(text: string): Promise<void> {
    // Create and add user message component to transcript
    const userMsg = new UserMessageComponent(text, this.colors);
    this.transcriptContainer.addChild(userMsg);
    this.ui.requestRender();

    // ── Route through orchestrator for mode-aware execution ──────────
    // When modus-maximus mode is active, the orchestrator handles the
    // full pipeline (plan generation, confirmation, sub-agent execution).
    // The plan generation streams via normal agent events (turn.started,
    // assistant.delta, turn.ended) so the streaming controller is managed
    // by the existing handleTurnStarted/handleTurnEnded handlers.
    const isModusMaximus = this.appState.executionMode === "modus-maximus";
    if (isModusMaximus && this.orchestratorHost?.submitPrompt) {
      this.isProcessing = true;

      try {
        const result = await this.orchestratorHost.submitPrompt(text);

        // Check if streaming delivered the summary or if we need a fallback
        const streamingDelivered = this.streaming.hasDeliveredContent;
        if (!streamingDelivered && result.output) {
          const summaryComp = new AssistantMessageComponent(this.colors);
          summaryComp.setContent(result.output);
          this.transcriptContainer.addChild(summaryComp);
        }

        if (!result.success && result.error) {
          this.showError(`Modus Maximus error: ${result.error}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.showError(`Modus Maximus error: ${msg}`);
      } finally {
        this.isProcessing = false;
      }
      return;
    }

    // ── Standard direct agent execution ───────────────────────────────
    this.abortController = new AbortController();

    try {
      const turnId = this.agent.turn.prompt(text);
      if (turnId === null) {
        this.showError("Could not launch turn (another turn is active)");
        this.isProcessing = false;
        return;
      }
      await this.agent.turn.waitForCurrentTurn(this.abortController.signal);
    } catch (err) {
      if (this.abortController?.signal.aborted) {
        this.showStatus("Cancelled");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.showError(`Error: ${msg}`);
      }
    } finally {
      this.isProcessing = false;
      this.abortController = null;
    }
  }

  cancelCurrentTurn(): void {
    // During modus-maximus, cancel via the orchestrator
    if (this.appState.executionMode === "modus-maximus") {
      this.showStatus("Cancelling Modus Maximus...");
      if (this.orchestratorHost?.cancel) {
        this.orchestratorHost.cancel();
      } else if (this.abortController) {
        this.abortController.abort();
      }
      return;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.showStatus("Cancelling...");
    }
  }

  // ── Transcript Management ──────────────────────────────────────────

  private renderWelcome(): void {
    if (this.welcomeRendered) return;
    this.welcomeRendered = true;

    const welcome = new WelcomeComponent(this.appState, this.colors);
    this.transcriptContainer.addChild(welcome);

    this.appendTranscriptEntry({
      id: `welcome-${Date.now()}`,
      kind: "welcome",
      renderMode: "plain",
      content: "",
    });
  }

  private appendTranscriptEntry(entry: TranscriptEntry): void {
    this.transcriptEntries.push(entry);
  }

  private clearTranscript(): void {
    this.transcriptEntries = [];
    this.transcriptContainer.clear();
    this.welcomeRendered = false;
    this.streaming.reset();
    this.renderWelcome();
    this.ui.requestRender();
  }

  showStatus(message: string, colorOrType?: string): void {
    // Determine type: if it's a known StatusType string, use it; otherwise default to "info"
    const type = colorOrType === "info" || colorOrType === "success" || colorOrType === "warning" || colorOrType === "error" || colorOrType === "plain"
      ? (colorOrType as "info" | "success" | "warning" | "error" | "plain")
      : "info";
    const component = new StatusMessageComponent(
      message,
      this.colors,
      type,
    );
    this.transcriptContainer.addChild(component);
    this.ui.requestRender();
  }

  showError(message: string): void {
    const component = new StatusMessageComponent(
      message,
      this.colors,
      "error",
    );
    this.transcriptContainer.addChild(component);
    this.ui.requestRender();
  }

  // ── Modus Maximus Handlers ─────────────────────────────────────────

  /**
   * Handle plan.started event — show a status message.
   */
  private handleModusMaximusPlanStarted(_event: AgentEvent): void {
    this.appState.modusMaximusPhase = "planning";

    const status = new StatusMessageComponent(
      "📋 Generating Modus Maximus plan...",
      this.colors,
      "info",
    );
    this.transcriptContainer.addChild(status);
    this.modusMaximusPlanStatus = status;
    this.ui.requestRender();
  }

  /**
   * Handle plan.completed event — show plan stats and trigger confirmation.
   */
  private handleModusMaximusPlanCompleted(event: AgentEvent): void {
    this.appState.modusMaximusPhase = "confirming";
    this.modusMaximusStepCount = event.stepCount ?? 0;
    this.modusMaximusPlanContent = event.planContent ?? "";

    // Replace plan status with completion message
    if (this.modusMaximusPlanStatus) {
      // Already shown; just update
    }

    const status = new StatusMessageComponent(
      `✅ Plan generated — ${this.modusMaximusStepCount} steps`,
      this.colors,
      "success",
      event.planFilePath ?? "",
    );
    this.transcriptContainer.addChild(status);
    this.ui.requestRender();
  }

  /**
   * Handle confirmation.request event — show confirmation dropdown.
   */
  private handleModusMaximusConfirmationRequest(_event: AgentEvent): void {
    this.appState.modusMaximusPhase = "confirming";

    // Show the confirmation dropdown as a dialog
    const dropdown = new ConfirmationDropdownComponent(this.colors);
    dropdown.setStepCount(this.modusMaximusStepCount);

    dropdown.setOnChoice((choice) => {
      if (choice === "needs-revision") {
        // Transition to revision input
        this.restoreEditor();
        this.showRevisionInput();
      } else {
        // Looks good or Redo — resolve the confirmation
        this.restoreEditor();
        if (this.orchestratorHost?.resolveModusMaximusConfirmation) {
          this.orchestratorHost.resolveModusMaximusConfirmation({ choice });
        }
      }
    });

    dropdown.setOnCancel(() => {
      // Cancel = choose Redo
      this.restoreEditor();
      if (this.orchestratorHost?.resolveModusMaximusConfirmation) {
        this.orchestratorHost.resolveModusMaximusConfirmation({ choice: "redo" });
      }
    });

    this.mountDialog(dropdown, "confirmation");
  }

  /**
   * Show the revision text input dialog.
   */
  private showRevisionInput(): void {
    const revisionInput = new RevisionInputComponent(this.colors);

    revisionInput.setOnSubmit((text) => {
      this.restoreEditor();
      if (this.orchestratorHost?.resolveModusMaximusConfirmation) {
        this.orchestratorHost.resolveModusMaximusConfirmation({
          choice: "needs-revision",
          revisionText: text,
        });
      }
    });

    revisionInput.setOnCancel(() => {
      // Cancel revision → go back to confirmation dropdown
      this.restoreEditor();
      this.handleModusMaximusConfirmationRequest({
        type: "modus-maximus.confirmation.request",
      });
    });

    this.mountDialog(revisionInput, "revision");
  }

  /**
   * Handle step.started event — begin a streaming turn for the step.
   * Shows the step instructions as a status message, then starts a new
   * streaming "turn" that uses the exact same pipeline as the main agent
   * (streaming controller + tool call components + thinking section).
   * The only difference is the agent label becomes "step-XXX".
   */
  private handleModusMaximusStepStarted(event: AgentEvent): void {
    this.appState.modusMaximusPhase = "executing";

    const stepIndex = event.stepIndex ?? 0;
    const stepTitle = event.stepTitle ?? "";
    const instructions = event.instructions ?? "";

    this.modusMaximusCurrentStepIndex = stepIndex;

    // Show step header as a status message
    const stepLabel = `step-${String(stepIndex).padStart(3, "0")}`;
    const header = stepTitle
      ? `Step ${stepIndex}: ${stepTitle}`
      : `Step ${stepIndex}`;
    const status = new StatusMessageComponent(header, this.colors, "info");
    this.transcriptContainer.addChild(status);

    // Show the instructions as a user-like message
    if (instructions.trim()) {
      // We use a styled text block to show the instructions
      const instructionsStatus = new StatusMessageComponent(
        instructions.trim().slice(0, 200) + (instructions.trim().length > 200 ? "…" : ""),
        this.colors,
        "info",
      );
      this.transcriptContainer.addChild(instructionsStatus);
    }

    // Start a streaming "turn" with the step label so all subsequent
    // text.delta, thinking.delta, tool.call.* events flow through the
    // exact same streaming pipeline as the main agent.
    this.streaming.beginTurn(stepLabel);

    this.ui.requestRender();
  }

  /**
   * Handle step.completed event — end the streaming turn, mark completed.
   */
  private handleModusMaximusStepCompleted(event: AgentEvent): void {
    const stepIndex = event.stepIndex ?? 0;

    // End the streaming turn for this step — flushes buffers, collapses thinking
    this.streaming.endTurn();

    // Reset streaming state so subsequent steps start fresh
    this.streaming.reset();

    const status = new StatusMessageComponent(
      `✅ Step ${stepIndex} completed`,
      this.colors,
      "success",
    );
    this.transcriptContainer.addChild(status);
    this.ui.requestRender();
  }

  /**
   * Handle step.failed event — end the streaming turn, show error.
   */
  private handleModusMaximusStepFailed(event: AgentEvent): void {
    const stepIndex = event.stepIndex ?? 0;

    // End the streaming turn for this step
    this.streaming.endTurn();
    this.streaming.reset();

    const errorMsg = event.error ?? "unknown error";
    const status = new StatusMessageComponent(
      `❌ Step ${stepIndex} failed — ${errorMsg}`,
      this.colors,
      "error",
    );
    this.transcriptContainer.addChild(status);
    this.ui.requestRender();
  }

  /**
   * Handle summary event — final project summary.
   */
  private handleModusMaximusSummary(event: AgentEvent): void {
    this.appState.modusMaximusPhase = "summarizing";

    const summaryText = event.summary ?? "Modus Maximus execution complete.";

    // Show final summary as assistant message
    const summaryComponent = new AssistantMessageComponent(this.colors);
    summaryComponent.setContent(summaryText);
    this.transcriptContainer.addChild(summaryComponent);

    // Show completion status
    const status = new StatusMessageComponent(
      `🏆 Modus Maximus complete: ${event.completedSteps ?? 0}/${event.totalSteps ?? 0} steps succeeded`,
      this.colors,
      "success",
    );
    this.transcriptContainer.addChild(status);

    this.ui.requestRender();
  }

  /**
   * Handle sub-agent streaming events during modus-maximus execution.
   * Sub-agents emit raw LoopEvents wrapped in "subagent.event" type.
   * We map each raw LoopEvent type to the same format as the main agent's
   * event stream and call the exact same handlers, so the pipeline
   * (streaming controller → tool call components → thinking section)
   * is identical. The only difference is the label becomes "step-XXX".
   */
  private handleSubagentEvent(event: AgentEvent): void {
    // The inner event is nested in the "event" field
    const innerEvent = (event as any).event as Record<string, unknown> | undefined;
    if (!innerEvent || typeof innerEvent !== "object") return;

    const innerType = innerEvent.type as string | undefined;

    // ── text.delta → handleTextDelta ──────────────────────────────────
    if (innerType === "text.delta" && typeof innerEvent.delta === "string") {
      this.handleTextDelta({ type: "assistant.delta", delta: innerEvent.delta } as AgentEvent);
      return;
    }

    // ── thinking.delta → handleThinkingDelta ──────────────────────────
    if (innerType === "thinking.delta" && typeof innerEvent.delta === "string") {
      this.handleThinkingDelta({ type: "thinking.delta", delta: innerEvent.delta } as AgentEvent);
      return;
    }

    // ── tool.call → handleToolCallStarted ─────────────────────────────
    if (innerType === "tool.call" && typeof innerEvent.toolCallId === "string") {
      this.handleToolCallStarted({
        type: "tool.call.started",
        toolCallId: innerEvent.toolCallId,
        name: innerEvent.name as string,
        args: innerEvent.args as Record<string, unknown>,
        description: innerEvent.description as string | undefined,
      } as AgentEvent);
      return;
    }

    // ── tool.call.delta → handleToolCallDelta ─────────────────────────
    if (innerType === "tool.call.delta" && typeof innerEvent.toolCallId === "string") {
      this.handleToolCallDelta({
        type: "tool.call.delta",
        toolCallId: innerEvent.toolCallId,
        argumentsPart: innerEvent.argumentsPart as string,
      } as AgentEvent);
      return;
    }

    // ── tool.result → handleToolResult ────────────────────────────────
    if (innerType === "tool.result" && typeof innerEvent.toolCallId === "string") {
      // The raw LoopToolResultEvent nests result in a `result` field
      const rawResult = innerEvent.result as Record<string, unknown> | undefined;
      const output = rawResult?.output ?? innerEvent.output ?? "(no output)";
      const isError = rawResult?.isError === true;
      this.handleToolResult({
        type: "tool.result",
        toolCallId: innerEvent.toolCallId,
        output,
        isError,
      } as AgentEvent);
      return;
    }

    // ── tool.progress → handleToolResult (show as output update) ──────
    if (innerType === "tool.progress" && typeof innerEvent.toolCallId === "string") {
      const update = innerEvent.update as { text?: string } | undefined;
      if (update?.text) {
        this.handleToolResult({
          type: "tool.result",
          toolCallId: innerEvent.toolCallId,
          output: update.text,
          isError: false,
        } as AgentEvent);
      }
      return;
    }

    // ── content.part → compound text/think parts ─────────────────────
    if (innerType === "content.part" && typeof innerEvent.part === "object" && innerEvent.part !== null) {
      const part = innerEvent.part as { type?: string; text?: string };
      if (part.type === "think" && typeof part.text === "string") {
        this.handleThinkingDelta({ type: "thinking.delta", delta: part.text } as AgentEvent);
      } else if (part.type === "text" && typeof part.text === "string") {
        this.handleTextDelta({ type: "assistant.delta", delta: part.text } as AgentEvent);
      }
      return;
    }
  }

  // ── UI Helpers ─────────────────────────────────────────────────────

  private updateEditorBorderHighlight(text?: string): void {
    const trimmed = (
      text ?? this.editor.getText()
    ).trimStart();
    const colorToken =
      this.appState.planMode || trimmed.startsWith("/")
        ? this.colors.primary
        : this.colors.border;
    this.editor.borderColor = (s: string) =>
      chalk.hex(colorToken)(s);
    this.ui.requestRender();
  }
}

// ── Factory ────────────────────────────────────────────────────────────

/**
 * Create and start a Qode TUI session.
 */
export async function startTui(options: TuiOptions): Promise<QTui> {
  const tui = new QTui(options);
  await tui.start();
  return tui;
}