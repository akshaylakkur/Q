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
      campaignProgress: 0,
      campaignPhase: undefined,
      campaignSubTaskCount: 0,
      campaignCompletedCount: 0,
      campaignConvergenceCount: 0,
      campaignGateStatus: undefined,
      campaignFilesChanged: 0,
      campaignVerificationStatus: undefined,
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

      // ── Campaign Events (handled via prefix matching) ─────────────
      default:
        this.routeCampaignEvent(event);
        break;
    }
  }

  /**
   * Route campaign events by namespace prefix to the appropriate handler.
   * This is called from the `default` branch of the event switch,
   * catching all campaign events that don't match earlier cases.
   */
  private routeCampaignEvent(event: AgentEvent): void {
    if (event.type.startsWith("speed-campaign.")) {
      this.handleSpeedCampaignEvent(event);
    } else if (event.type.startsWith("medium-campaign.")) {
      this.handleMediumCampaignEvent(event);
    } else if (event.type.startsWith("high-campaign.")) {
      this.handleHighCampaignEvent(event);
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
    // ── Campaign mode guard ────────────────────────────────────────────
    // When a campaign mode (speed-campaign, medium-campaign, high-campaign,
    // or modus-maximus) is active, the turn.ended event fires when plan
    // generation finishes (Phase 1). But subsequent phases (dispatch,
    // convergence, verification) are still running within the same
    // orchestrator submitPrompt() call. Do NOT reset isProcessing since
    // the outer sendToAgent manages that lifecycle.
    // We DO need to end streaming to stop the flush timer, and we DO need
    // to stop context polling since plan output was already streamed.
    const isCampaignMode =
      this.appState.executionMode === "speed-campaign" ||
      this.appState.executionMode === "medium-campaign" ||
      this.appState.executionMode === "high-campaign" ||
      this.appState.executionMode === "modus-maximus";

    if (!isCampaignMode) {
      this.isProcessing = false;
    }
    this.appState.streamingPhase = "idle";

    // Stop context polling
    this.stopContextPolling();

    // Finalize streaming — flushes all remaining buffers, stops timer
    this.streaming.endTurn();

    // ── Fallback: only render missed context if NOT a campaign mode
    // (plan output was streamed directly via assistant.delta events)
    if (!isCampaignMode) {
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

    // ── Campaign modes: route through orchestrator for mode-aware execution ──
    // When a campaign mode (speed-campaign, medium-campaign, high-campaign,
    // or modus-maximus) is active, the orchestrator handles the full pipeline
    // including decomposition, parallel dispatch, convergence, verification,
    // and sub-agent orchestration. The agent's normal turn events still stream
    // (turn.started, assistant.delta, turn.ended) for visibility.
    const isCampaignMode =
      this.appState.executionMode === "speed-campaign" ||
      this.appState.executionMode === "medium-campaign" ||
      this.appState.executionMode === "high-campaign" ||
      this.appState.executionMode === "modus-maximus";

    if (isCampaignMode && this.orchestratorHost?.submitPrompt) {
      this.isProcessing = true;

      try {
        const result = await this.orchestratorHost.submitPrompt(text);

        // ── Show the final campaign summary ──────────────────────────────
        // During campaign execution, individual sub-tasks stream their
        // content (thinking, tool calls, text) via normal turn events.
        // Additionally, the final LLM summary (if generated) also streams
        // naturally through the turn event system. We only need to render
        // the result output as a static component if streaming did NOT
        // deliver any content (fallback for the structured summary).
        const streamingDelivered = this.streaming.hasDeliveredContent;
        if (!streamingDelivered && result.output) {
          const summaryLabel =
            this.appState.executionMode === "speed-campaign" ? "⚡ Speed Campaign Results" :
            this.appState.executionMode === "medium-campaign" ? "◈ Medium Campaign Results" :
            this.appState.executionMode === "high-campaign" ? "⟁ High Campaign Results" :
            "Campaign Results";

          const summaryContent = `**${summaryLabel}**\n\n${result.output}`;
          const summaryComp = new AssistantMessageComponent(this.colors);
          summaryComp.setContent(summaryContent);
          this.transcriptContainer.addChild(summaryComp);
        }

        if (!result.success && result.error) {
          const modeLabel = this.appState.executionMode ?? "campaign";
          this.showError(`${modeLabel} error: ${result.error}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const modeLabel = this.appState.executionMode ?? "campaign";
        this.showError(`${modeLabel} error: ${msg}`);
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
    // During campaign modes, cancel via the orchestrator
    const isCampaignMode =
      this.appState.executionMode === "speed-campaign" ||
      this.appState.executionMode === "medium-campaign" ||
      this.appState.executionMode === "high-campaign" ||
      this.appState.executionMode === "modus-maximus";

    if (isCampaignMode) {
      const modeLabel = this.appState.executionMode ?? "campaign";
      this.showStatus(`Cancelling ${modeLabel}...`);
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

  // ── Campaign Event Handlers ───────────────────────────────────────

  /**
   * Handle speed-campaign.* events.
   *
   * Speed Campaign uses a "fire-and-forget" parallel dispatch model:
   *   - speed-campaign.started         → campaign started with N sub-tasks
   *   - speed-campaign.subtask.started  → individual sub-task dispatched
   *   - speed-campaign.subtask.completed→ individual sub-task succeeded
   *   - speed-campaign.subtask.failed   → individual sub-task failed
   *   - speed-campaign.completed        → campaign finished (success or failure)
   *   - speed-campaign.syntax-diagnostics → syntax validation diagnostics
   *   - speed-campaign.file-conflict    → file write conflict between sub-tasks
   *
   * Updates:
   *   - appState.executionMode
   *   - appState.campaignProgress (percentage based on completed/total)
   *   - appState.campaignPhase
   *   - appState.campaignSubTaskCount
   *   - appState.campaignCompletedCount
   *   - Transcript with status messages
   */
  private handleSpeedCampaignEvent(event: AgentEvent): void {
    // Ensure execution mode is set
    this.appState.executionMode = "speed-campaign";

    switch (event.type) {
      case "speed-campaign.started": {
        const subTaskCount = (event as any).subTaskCount ?? 0;
        this.appState.campaignPhase = "dispatching";
        this.appState.campaignSubTaskCount = subTaskCount;
        this.appState.campaignCompletedCount = 0;
        this.appState.campaignProgress = 0;

        this.showStatus(
          `🚀 Speed Campaign started — ${subTaskCount} sub-task${subTaskCount !== 1 ? "s" : ""} dispatched in parallel`,
          "info",
        );
        break;
      }

      case "speed-campaign.subtask.started": {
        const subTaskId = (event as any).subTaskId ?? "?";
        const description = (event as any).description ?? "";
        const desc = description ? `: ${description.slice(0, 60)}` : "";
        this.showStatus(`  ⚡ Sub-task ${subTaskId} started${desc}`, "info");
        break;
      }

      case "speed-campaign.subtask.completed": {
        const subTaskId = (event as any).subTaskId ?? "?";
        const completed = (this.appState.campaignCompletedCount ?? 0) + 1;
        this.appState.campaignCompletedCount = completed;

        // Update progress percentage
        const total = this.appState.campaignSubTaskCount ?? 1;
        this.appState.campaignProgress = Math.round((completed / total) * 100);

        this.showStatus(
          `  ✅ Sub-task ${subTaskId} completed (${completed}/${total})`,
          "success",
        );
        break;
      }

      case "speed-campaign.subtask.failed": {
        const subTaskId = (event as any).subTaskId ?? "?";
        const error = (event as any).error ?? "unknown error";
        this.showStatus(
          `  ❌ Sub-task ${subTaskId} failed — ${error}`,
          "error",
        );
        break;
      }

      case "speed-campaign.completed": {
        const success = (event as any).success === true;
        const subTaskCount = (event as any).subTaskCount ?? 0;
        const duration = (event as any).duration ?? 0;

        this.appState.campaignPhase = success ? "completed" : "failed";
        this.appState.campaignProgress = success ? 100 : this.appState.campaignProgress ?? 0;

        if (success) {
          this.showStatus(
            `✅ Speed Campaign complete — ${subTaskCount} sub-task${subTaskCount !== 1 ? "s" : ""} finished in ${(duration / 1000).toFixed(1)}s`,
            "success",
          );
        } else {
          this.showStatus(
            `❌ Speed Campaign failed after ${(duration / 1000).toFixed(1)}s`,
            "error",
          );
        }
        break;
      }

      case "speed-campaign.syntax-diagnostics": {
        const count = (event as any).count ?? 0;
        if (count > 0) {
          this.showStatus(
            `  ⚠️  ${count} syntax diagnostic${count !== 1 ? "s" : ""} found`,
            "warning",
          );
        }
        break;
      }

      case "speed-campaign.file-conflict": {
        const file = (event as any).file ?? "unknown";
        const subTasks = (event as any).subTasks ?? [];
        this.showStatus(
          `  🔀 File conflict detected in ${file} between sub-tasks: ${subTasks.join(", ")}`,
          "warning",
        );
        break;
      }
    }

    this.ui.requestRender();
  }

  /**
   * Handle medium-campaign.* events.
   *
   * Medium Campaign uses a wave-based orchestration model with convergence:
   *   - medium-campaign.started              → campaign started
   *   - medium-campaign.decomposing           → generating task graph
   *   - medium-campaign.graph-ready           → task graph generated (totalWaves, totalNodes)
   *   - medium-campaign.wave-execution-starting→ starting wave execution
   *   - medium-campaign.wave.started          → individual wave started (waveIndex, phase, taskCount)
   *   - medium-campaign.wave.completed        → individual wave completed
   *   - medium-campaign.subtask.started       → sub-task within wave dispatched
   *   - medium-campaign.subtask.completed/... → sub-task result
   *   - medium-campaign.convergence.starting  → convergence starting after wave
   *   - medium-campaign.convergence.complete  → convergence finished
   *   - medium-campaign.verification.*        → verification phase events
   *   - medium-campaign.gate.*                → quality gate results
   *   - medium-campaign.correction.*          → self-correction events
   *   - medium-campaign.completed             → campaign finished
   *
   * Updates:
   *   - appState.executionMode
   *   - appState.campaignPhase (wave index / phase name)
   *   - appState.campaignProgress
   *   - appState.campaignGateStatus
   *   - appState.campaignConvergenceCount
   *   - Transcript with wave progress and gate status
   */
  private handleMediumCampaignEvent(event: AgentEvent): void {
    // Ensure execution mode is set
    this.appState.executionMode = "medium-campaign";

    switch (event.type) {
      case "medium-campaign.started": {
        this.appState.campaignPhase = "decomposing";
        this.appState.campaignProgress = 0;
        this.appState.campaignConvergenceCount = 0;
        this.appState.campaignGateStatus = "pending";

        this.showStatus("◈ Medium Campaign started — decomposing task...", "info");
        break;
      }

      case "medium-campaign.decomposing": {
        this.appState.campaignPhase = "decomposing";
        this.showStatus("  ◈ Generating task dependency graph...", "info");
        break;
      }

      case "medium-campaign.graph-ready": {
        const totalWaves = (event as any).totalWaves ?? 0;
        const totalNodes = (event as any).totalNodes ?? 0;
        this.appState.campaignPhase = "graph-ready";
        this.appState.campaignSubTaskCount = totalNodes;

        this.showStatus(
          `  📊 Task graph ready — ${totalWaves} wave${totalWaves !== 1 ? "s" : ""}, ${totalNodes} task${totalNodes !== 1 ? "s" : ""}`,
          "info",
        );
        break;
      }

      case "medium-campaign.wave-execution-starting": {
        const totalWaves = (event as any).totalWaves ?? 0;
        this.appState.campaignPhase = "executing-waves";
        this.appState.campaignProgress = 0;

        this.showStatus(
          `  🌊 Executing ${totalWaves} wave${totalWaves !== 1 ? "s" : ""} sequentially`,
          "info",
        );
        break;
      }

      case "medium-campaign.wave.started": {
        const waveIndex = (event as any).waveIndex ?? 0;
        const phase = (event as any).phase ?? "";
        const taskCount = (event as any).taskCount ?? 0;

        this.appState.campaignPhase = `wave-${waveIndex}`;

        if (taskCount > 0) {
          this.showStatus(
            `  🌊 Wave ${waveIndex} (${phase}) started — ${taskCount} task${taskCount !== 1 ? "s" : ""}`,
            "info",
          );
        }
        break;
      }

      case "medium-campaign.wave.completed": {
        const waveIndex = (event as any).waveIndex ?? 0;
        const waveSuccess = (event as any).success === true;
        const errors = (event as any).errors ?? [];

        // Update rough progress based on wave completion
        const completed = waveIndex + 1;
        const total = this.appState.campaignSubTaskCount ?? completed;
        this.appState.campaignProgress = Math.min(
          80,
          Math.round((completed / Math.max(total, completed)) * 80),
        );

        if (waveSuccess) {
          this.showStatus(
            `  ✅ Wave ${waveIndex} completed`,
            "success",
          );
        } else {
          this.showStatus(
            `  ⚠️  Wave ${waveIndex} completed with ${errors.length} error${errors.length !== 1 ? "s" : ""}`,
            "warning",
          );
        }
        break;
      }

      case "medium-campaign.subtask.started": {
        const description = (event as any).description ?? "";
        const desc = description ? `: ${description.slice(0, 60)}` : "";
        this.showStatus(`    📋 Sub-task started${desc}`, "info");
        break;
      }

      case "medium-campaign.subtask.completed": {
        this.showStatus(`    ✅ Sub-task completed`, "success");
        break;
      }

      case "medium-campaign.subtask.failed": {
        const error = (event as any).error ?? "unknown error";
        this.showStatus(`    ❌ Sub-task failed — ${error}`, "error");
        break;
      }

      case "medium-campaign.convergence.starting": {
        this.appState.campaignPhase = "converging";
        this.showStatus("  🔄 Running convergence on wave results...", "info");
        break;
      }

      case "medium-campaign.convergence.complete": {
        const convergenceCount = (this.appState.campaignConvergenceCount ?? 0) + 1;
        this.appState.campaignConvergenceCount = convergenceCount;
        this.showStatus(
          `  ✅ Convergence cycle ${convergenceCount} complete`,
          "success",
        );
        break;
      }

      case "medium-campaign.convergence.error": {
        const errMsg = (event as any).error ?? "unknown convergence error";
        this.showStatus(`  ⚠️  Convergence error — ${errMsg}`, "warning");
        break;
      }

      case "medium-campaign.wave-execution-complete": {
        this.appState.campaignPhase = "wave-execution-complete";
        this.appState.campaignProgress = 80;
        this.showStatus("  ✅ All wave executions complete — running verification...", "success");
        break;
      }

      case "medium-campaign.verification.started": {
        this.appState.campaignPhase = "verifying";
        this.showStatus("  🔍 Running verification...", "info");
        break;
      }

      case "medium-campaign.verification.passed": {
        this.appState.campaignPhase = "verification-passed";
        this.appState.campaignGateStatus = "pass";
        const fileCount = (event as any).fileCount ?? 0;
        this.showStatus(
          `  ✅ Verification passed — ${fileCount} file${fileCount !== 1 ? "s" : ""} checked`,
          "success",
        );
        break;
      }

      case "medium-campaign.verification.failed": {
        this.appState.campaignPhase = "verification-failed";
        this.appState.campaignGateStatus = "fail";
        this.showStatus("  ❌ Verification failed — initiating correction...", "error");
        break;
      }

      case "medium-campaign.verification.skipped": {
        this.showStatus("  ⏭️  Verification skipped (no files changed)", "info");
        break;
      }

      case "medium-campaign.gate.passed": {
        this.appState.campaignGateStatus = "pass";
        this.showStatus("  ✅ Quality gate: PASSED", "success");
        break;
      }

      case "medium-campaign.gate.failed": {
        this.appState.campaignGateStatus = "fail";
        this.showStatus("  ❌ Quality gate: FAILED", "error");
        break;
      }

      case "medium-campaign.correction.started": {
        this.appState.campaignPhase = "correcting";
        this.showStatus("  🔧 Self-correction in progress...", "warning");
        break;
      }

      case "medium-campaign.correction.complete": {
        const success = (event as any).success === true;
        const attempts = (event as any).attempts ?? 1;
        if (success) {
          this.showStatus(
            `  ✅ Self-correction succeeded (${attempts} attempt${attempts !== 1 ? "s" : ""})`,
            "success",
          );
        } else {
          this.showStatus(
            `  ⚠️  Self-correction exhausted after ${attempts} attempt${attempts !== 1 ? "s" : ""}`,
            "warning",
          );
        }
        break;
      }

      case "medium-campaign.completed": {
        const success = (event as any).success === true;
        this.appState.campaignPhase = success ? "completed" : "failed";
        this.appState.campaignProgress = success ? 100 : this.appState.campaignProgress ?? 0;

        if (success) {
          this.showStatus(
            `✅ Medium Campaign complete — ${this.appState.campaignConvergenceCount ?? 0} convergence cycle${(this.appState.campaignConvergenceCount ?? 0) !== 1 ? "s" : ""}`,
            "success",
          );
        } else {
          this.showStatus(
            "❌ Medium Campaign failed",
            "error",
          );
        }
        break;
      }

      case "medium-campaign.aborted": {
        this.appState.campaignPhase = "aborted";
        const reason = (event as any).reason ?? "Cancelled";
        this.showStatus(`⏹️  Medium Campaign aborted — ${reason}`, "warning");
        break;
      }
    }

    this.ui.requestRender();
  }

  /**
   * Handle high-campaign.* events.
   *
   * High Campaign uses a continuous convergence model with phases,
   * verification, checkpoints, and self-correction:
   *   - high-campaign.started                → campaign started
   *   - high-campaign.planning               → generating phase plan
   *   - high-campaign.plan-ready             → phase plan ready
   *   - high-campaign.phase.started          → phase began (phase, phaseIndex)
   *   - high-campaign.phase.completed        → phase finished
   *   - high-campaign.phase.failed           → phase exhausted attempts
   *   - high-campaign.convergence-cycle.started → convergence cycle began
   *   - high-campaign.convergence-cycle.passed  → cycle passed verification
   *   - high-campaign.convergence-cycle.failed  → cycle failed
   *   - high-campaign.convergence-cycle.retrying→ cycle retrying
   *   - high-campaign.convergence-cycle.skipped-verification → no files changed
   *   - high-campaign.convergence-cycle.exhausted → max retries reached
   *   - high-campaign.convergence.starting    → convergence engine starting
   *   - high-campaign.convergence.cycle       → convergence cycle completed
   *   - high-campaign.convergence.complete    → convergence finished
   *   - high-campaign.verification.*          → verification events
   *   - high-campaign.gate.*                  → quality gate results
   *   - high-campaign.correction.*            → self-correction events
   *   - high-campaign.checkpoint.*            → checkpoint save/restore
   *   - high-campaign.completed               → campaign finished
   *   - high-campaign.paused / resumed        → pause/resume lifecycle
   *   - high-campaign.progress-checkpoint     → periodic progress updates
   *   - high-campaign.all-phases-completed    → all phases done
   *
   * Updates:
   *   - appState.executionMode
   *   - appState.campaignPhase (phase name / cycle info)
   *   - appState.campaignProgress
   *   - appState.campaignConvergenceCount
   *   - appState.campaignFilesChanged
   *   - appState.campaignVerificationStatus
   *   - appState.campaignGateStatus
   *   - Transcript with detailed convergence and verification status
   */
  private handleHighCampaignEvent(event: AgentEvent): void {
    // Ensure execution mode is set
    this.appState.executionMode = "high-campaign";

    switch (event.type) {
      // ── Lifecycle ──────────────────────────────────────────────────
      case "high-campaign.started": {
        this.appState.campaignPhase = "planning";
        this.appState.campaignProgress = 0;
        this.appState.campaignConvergenceCount = 0;
        this.appState.campaignFilesChanged = 0;
        this.appState.campaignVerificationStatus = "running";

        const campaignId = (event as any).campaignId ?? "";
        this.showStatus(
          `⟁ High Campaign started${campaignId ? ` (${campaignId.slice(0, 12)}…)` : ""} — generating phase plan...`,
          "info",
        );
        break;
      }

      case "high-campaign.planning": {
        this.appState.campaignPhase = "planning";
        this.showStatus("  ⟁ Generating phase convergence plan...", "info");
        break;
      }

      case "high-campaign.plan-ready": {
        const totalPhases = (event as any).totalPhases ?? 0;
        this.appState.campaignPhase = "plan-ready";

        this.showStatus(
          `  📋 Phase plan ready — ${totalPhases} phase${totalPhases !== 1 ? "s" : ""} to execute`,
          "info",
        );
        break;
      }

      case "high-campaign.all-phases-completed": {
        this.appState.campaignPhase = "all-phases-completed";
        this.showStatus("  ✅ All phases already completed (checkpoint restored)", "success");
        break;
      }

      // ── Phase execution ────────────────────────────────────────────
      case "high-campaign.phase.started": {
        const phase = (event as any).phase ?? "";
        const phaseIndex = (event as any).phaseIndex ?? 0;
        const totalPhases = (event as any).totalPhases ?? 0;

        this.appState.campaignPhase = `phase-${phase}`;

        // Update progress: each phase is roughly (100 / totalPhases)%
        const phaseProgress = Math.round((phaseIndex / Math.max(totalPhases, 1)) * 70);
        this.appState.campaignProgress = Math.max(this.appState.campaignProgress ?? 0, phaseProgress);

        this.showStatus(
          `  📌 Phase ${phaseIndex + 1}/${totalPhases}: ${phase}`,
          "info",
        );
        break;
      }

      case "high-campaign.phase.completed": {
        const phaseName = (event as any).phaseName ?? (event as any).phase ?? "";
        this.appState.campaignPhase = `${phaseName}-completed`;

        // Update progress based on completed phases
        const progress = Math.min(85, (this.appState.campaignProgress ?? 0) + 10);
        this.appState.campaignProgress = progress;

        this.showStatus(
          `  ✅ Phase "${phaseName}" completed`,
          "success",
        );
        break;
      }

      case "high-campaign.phase.failed": {
        const phaseId = (event as any).phaseId ?? "";
        const phaseName = (event as any).phaseName ?? "";
        const reason = (event as any).reason ?? "Max attempts reached";

        this.appState.campaignPhase = `${phaseName}-failed`;

        this.showStatus(
          `  ❌ Phase "${phaseName || phaseId}" failed — ${reason}`,
          "error",
        );

        // Check if escalation was recommended
        if (event.type.includes("escalation")) {
          this.showStatus("  🔄 Escalating to re-classification...", "warning");
        }
        break;
      }

      case "high-campaign.escalation.recommended": {
        this.showStatus("  ⬆️ Escalation recommended — re-classifying task", "warning");
        break;
      }

      // ── Convergence cycles ─────────────────────────────────────────
      case "high-campaign.convergence-cycle.started": {
        const attempt = (event as any).attempt ?? 1;
        const maxAttempts = (event as any).maxAttempts ?? 3;
        const convergenceCount = (event as any).convergenceCount ?? 0;

        this.appState.campaignPhase = `convergence-cycle-${convergenceCount}`;
        this.appState.campaignConvergenceCount = convergenceCount;

        this.showStatus(
          `  🔄 Convergence cycle ${convergenceCount} (attempt ${attempt}/${maxAttempts})`,
          "info",
        );
        break;
      }

      case "high-campaign.convergence-cycle.passed": {
        const attempt = (event as any).attempt ?? 1;
        const convergenceCount = (event as any).convergenceCount ?? 0;
        const changedFiles = (event as any).changedFiles ?? 0;

        // Track files changed
        this.appState.campaignFilesChanged = (this.appState.campaignFilesChanged ?? 0) + changedFiles;
        this.appState.campaignPhase = `convergence-passed-${convergenceCount}`;

        this.showStatus(
          `  ✅ Convergence cycle ${convergenceCount} passed (attempt ${attempt}, ${changedFiles} file${changedFiles !== 1 ? "s" : ""} changed)`,
          "success",
        );
        break;
      }

      case "high-campaign.convergence-cycle.failed": {
        const attempt = (event as any).attempt ?? 1;
        const reason = (event as any).reason ?? "No sub-tasks completed";
        this.showStatus(
          `  ❌ Convergence cycle failed (attempt ${attempt}) — ${reason}`,
          "error",
        );
        break;
      }

      case "high-campaign.convergence-cycle.retrying": {
        const nextAttempt = (event as any).nextAttempt ?? 1;
        const maxAttempts = (event as any).maxAttempts ?? 3;
        this.showStatus(
          `  🔄 Retrying convergence cycle (attempt ${nextAttempt}/${maxAttempts})...`,
          "warning",
        );
        break;
      }

      case "high-campaign.convergence-cycle.skipped-verification": {
        this.showStatus("  ⏭️  Skipping verification (no files changed this cycle)", "info");
        break;
      }

      case "high-campaign.convergence-cycle.exhausted": {
        this.showStatus("  ⛔ Convergence cycles exhausted — max retries reached", "error");
        break;
      }

      case "high-campaign.passed-after-correction":
      case "high-campaign.convergence-cycle.passed-after-correction": {
        const convCount = (event as any).convergenceCount ?? this.appState.campaignConvergenceCount ?? 0;
        this.showStatus(
          `  ✅ Convergence cycle ${convCount} passed after self-correction`,
          "success",
        );
        break;
      }

      // ── Convergence engine events ──────────────────────────────────
      case "high-campaign.convergence.starting": {
        this.appState.campaignPhase = "converging";
        this.showStatus("  🔄 Running convergence engine...", "info");
        break;
      }

      case "high-campaign.convergence.cycle": {
        const convergenceNumber = (event as any).convergenceNumber ?? 0;
        const totalConflicts = (event as any).totalConflicts ?? 0;

        if (totalConflicts > 0) {
          this.showStatus(
            `  🔄 Convergence round ${convergenceNumber} — ${totalConflicts} conflict${totalConflicts !== 1 ? "s" : ""} resolved`,
            "info",
          );
        }
        break;
      }

      case "high-campaign.convergence.complete": {
        this.showStatus("  ✅ Convergence engine cycle complete", "success");
        break;
      }

      case "high-campaign.convergence.error": {
        const errMsg = (event as any).error ?? "convergence error";
        this.showStatus(`  ⚠️  Convergence error — ${errMsg}`, "warning");
        break;
      }

      // ── Verification events ────────────────────────────────────────
      case "high-campaign.verification.started": {
        this.appState.campaignVerificationStatus = "running";
        this.appState.campaignPhase = "verifying";
        const fileCount = (event as any).fileCount ?? 0;
        this.showStatus(
          `  🔍 Running verification on ${fileCount} file${fileCount !== 1 ? "s" : ""}...`,
          "info",
        );
        break;
      }

      case "high-campaign.verification.complete": {
        const passed = (event as any).passed === true;
        this.appState.campaignVerificationStatus = passed ? "passing" : "failing";

        if (passed) {
          this.showStatus("  ✅ Verification passed", "success");
        } else {
          this.showStatus("  ❌ Verification failed — attempting correction...", "error");
        }
        break;
      }

      case "high-campaign.verification.failed": {
        this.appState.campaignVerificationStatus = "failing";
        this.showStatus("  ❌ Verification failed", "error");
        break;
      }

      case "high-campaign.verification.skipped": {
        this.showStatus("  ⏭️  Verification skipped (no files changed)", "info");
        break;
      }

      case "high-campaign.verification.diagnostics": {
        const diagCount = (event as any).diagnostics?.length ?? 0;
        if (diagCount > 0) {
          this.showStatus(
            `  📋 ${diagCount} diagnostic${diagCount !== 1 ? "s" : ""} from verification`,
            "info",
          );
        }
        break;
      }

      // ── Self-correction events ─────────────────────────────────────
      case "high-campaign.verification.self-correction.started":
      case "high-campaign.correction.started": {
        this.appState.campaignPhase = "correcting";
        this.showStatus("  🔧 Self-correction in progress...", "warning");
        break;
      }

      case "high-campaign.verification.self-correction.succeeded":
      case "high-campaign.correction.succeeded": {
        this.appState.campaignPhase = "correction-applied";
        this.showStatus("  ✅ Self-correction applied successfully", "success");
        break;
      }

      case "high-campaign.verification.self-correction.failed":
      case "high-campaign.correction.failed": {
        this.showStatus("  ❌ Self-correction failed — escalating...", "error");
        break;
      }

      case "high-campaign.correction.progress": {
        const progress = (event as any).progress ?? "";
        if (progress) {
          this.showStatus(`  🔧 Correction progress: ${progress}`, "info");
        }
        break;
      }

      case "high-campaign.correction.result": {
        const success = (event as any).success === true;
        this.showStatus(
          success ? "  ✅ Correction result: success" : "  ❌ Correction result: failed",
          success ? "success" : "error",
        );
        break;
      }

      case "high-campaign.correction.error": {
        const errMsg = (event as any).error ?? "correction error";
        this.showStatus(`  ❌ Correction error — ${errMsg}`, "error");
        break;
      }

      case "high-campaign.correction.skipped": {
        this.showStatus("  ⏭️  Correction skipped — no self-correction needed", "info");
        break;
      }

      // ── Re-verification events ─────────────────────────────────────
      case "high-campaign.re-verification.failed": {
        this.showStatus("  ❌ Re-verification failed after correction", "error");
        break;
      }

      // ── Escalation events ──────────────────────────────────────────
      case "high-campaign.verification.escalation.failed": {
        this.showStatus("  ❌ Escalation failed — all correction paths exhausted", "error");
        break;
      }

      case "high-campaign.verification.escalation.succeeded": {
        this.showStatus("  ✅ Escalation succeeded — issue resolved", "success");
        break;
      }

      case "high-campaign.escalation.evaluated": {
        this.showStatus("  ⬆️ Escalation evaluated — continuing...", "info");
        break;
      }

      // ── Quality gates ──────────────────────────────────────────────
      case "high-campaign.gate.passed": {
        this.appState.campaignGateStatus = "pass";
        this.showStatus("  ✅ Quality gate: PASSED", "success");
        break;
      }

      case "high-campaign.gate.failed": {
        this.appState.campaignGateStatus = "fail";
        this.showStatus("  ❌ Quality gate: FAILED", "error");
        break;
      }

      case "high-campaign.gate.skipped": {
        this.appState.campaignGateStatus = "pending";
        this.showStatus("  ⏭️  Quality gate: SKIPPED", "info");
        break;
      }

      // ── Checkpoint events ──────────────────────────────────────────
      case "high-campaign.checkpoint.restored": {
        const completedPhases = (event as any).completedPhases ?? [];
        const convergenceCount = (event as any).convergenceCount ?? 0;

        this.appState.campaignConvergenceCount = convergenceCount;
        this.appState.campaignPhase = "checkpoint-restored";

        this.showStatus(
          `  📦 Checkpoint restored — ${completedPhases.length} phase${completedPhases.length !== 1 ? "s" : ""} already completed, ${convergenceCount} convergence cycle${convergenceCount !== 1 ? "s" : ""} done`,
          "info",
        );
        break;
      }

      case "high-campaign.checkpoint.saved": {
        this.showStatus("  💾 Checkpoint saved", "success");
        break;
      }

      case "high-campaign.checkpoint.skipped": {
        this.showStatus("  ⏭️  Checkpoint skipped (nothing to save)", "info");
        break;
      }

      case "high-campaign.checkpoint.error": {
        const errMsg = (event as any).error ?? "checkpoint error";
        this.showStatus(`  ⚠️  Checkpoint error — ${errMsg}`, "warning");
        break;
      }

      case "high-campaign.checkpoint.invalid": {
        this.showStatus("  ⚠️  Checkpoint data invalid — starting fresh", "warning");
        break;
      }

      case "high-campaign.checkpoint.restore-error": {
        const errMsg = (event as any).error ?? "restore error";
        this.showStatus(`  ⚠️  Checkpoint restore error — ${errMsg}`, "warning");
        break;
      }

      // ── Pause / Resume ─────────────────────────────────────────────
      case "high-campaign.paused": {
        this.appState.campaignPhase = "paused";
        const phase = (event as any).phase ?? "";
        this.showStatus(
          `⏸️  Campaign paused${phase ? ` (phase: ${phase})` : ""}`,
          "warning",
        );
        break;
      }

      case "high-campaign.pausing": {
        this.appState.campaignPhase = "pausing";
        this.showStatus("⏸️  Campaign pausing...", "warning");
        break;
      }

      case "high-campaign.resumed": {
        this.appState.campaignPhase = "resumed";
        this.showStatus("▶️  Campaign resumed", "success");
        break;
      }

      // ── Progress checkpoints ───────────────────────────────────────
      case "high-campaign.progress-checkpoint": {
        const filesChanged = (event as any).filesChanged ?? 0;
        const pct = (event as any).progress ?? this.appState.campaignProgress ?? 0;

        this.appState.campaignFilesChanged = filesChanged;
        this.appState.campaignProgress = Math.max(this.appState.campaignProgress ?? 0, pct);

        this.showStatus(
          `  📊 Progress: ${pct}% — ${filesChanged} file${filesChanged !== 1 ? "s" : ""} changed`,
          "info",
        );
        break;
      }

      // ── Sub-task events ────────────────────────────────────────────
      case "high-campaign.subtask.started": {
        const description = (event as any).description ?? "";
        const desc = description ? `: ${description.slice(0, 80)}` : "";
        this.showStatus(`    📋 Sub-task started${desc}`, "info");
        break;
      }

      case "high-campaign.subtask.completed": {
        this.appState.campaignCompletedCount = (this.appState.campaignCompletedCount ?? 0) + 1;
        this.showStatus(`    ✅ Sub-task completed`, "success");
        break;
      }

      case "high-campaign.subtask.failed": {
        const error = (event as any).error ?? "unknown error";
        this.showStatus(`    ❌ Sub-task failed — ${error}`, "error");
        break;
      }

      // ── Cycle decomposition events ─────────────────────────────────
      case "high-campaign.cycle.executing": {
        this.showStatus("  🔄 Executing convergence cycle tasks...", "info");
        break;
      }

      case "high-campaign.cycle.no-tasks": {
        this.showStatus("  ⏭️  No tasks to execute this cycle", "info");
        break;
      }

      case "high-campaign.cycle.decomposed": {
        const taskCount = (event as any).taskCount ?? 0;
        this.showStatus(
          `  📊 Cycle decomposed into ${taskCount} task${taskCount !== 1 ? "s" : ""}`,
          "info",
        );
        break;
      }

      case "high-campaign.cycle.collected": {
        this.showStatus("  📥 Collecting cycle results...", "info");
        break;
      }

      case "high-campaign.cycle.completed": {
        this.showStatus("  ✅ Convergence cycle execution complete", "success");
        break;
      }

      // ── Verification pipeline errors ───────────────────────────────
      case "high-campaign.verification.pipeline-error": {
        const errMsg = (event as any).error ?? "pipeline error";
        this.showStatus(`  ❌ Verification pipeline error — ${errMsg}`, "error");
        break;
      }

      // ── Completion ─────────────────────────────────────────────────
      case "high-campaign.completed": {
        const success = (event as any).success === true;

        this.appState.campaignPhase = success ? "completed" : "failed";
        this.appState.campaignProgress = success ? 100 : this.appState.campaignProgress ?? 0;
        this.appState.campaignVerificationStatus = success ? "passing" : "failing";

        const filesChanged = this.appState.campaignFilesChanged ?? 0;
        const convergenceCount = this.appState.campaignConvergenceCount ?? 0;

        if (success) {
          this.showStatus(
            `✅ High Campaign complete — ${convergenceCount} convergence cycle${convergenceCount !== 1 ? "s" : ""}, ${filesChanged} file${filesChanged !== 1 ? "s" : ""} changed`,
            "success",
          );
        } else {
          this.showStatus(
            `❌ High Campaign failed — ${convergenceCount} convergence cycle${convergenceCount !== 1 ? "s" : ""} completed`,
            "error",
          );
        }
        break;
      }
    }

    this.ui.requestRender();
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