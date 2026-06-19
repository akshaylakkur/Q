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
import { applyAgentProfile } from "@q/agent-core";
import type {
  TuiAppState,
  TuiOptions,
  ColorPalette,
  TranscriptEntry,
  AgentEvent,
  ToolCallBlockData,
} from "./types.js";
import { DEFAULT_COLORS } from "./types.js";
import type { NdjsonEnvelope, RemoteSessionInfo } from "@qode-agent/protocol";
import { InstanceMetadataComponent } from "./components/instance-metadata.js";
import { HeartbeatBarComponent } from "./components/heartbeat-bar.js";
import { AuditLogComponent } from "./components/audit-log.js";
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
import { PlanModeController, PlanDropdownComponent, PlanRevisionInputComponent } from "./plan/index.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { getCliVersion } from "../version.js";

// ── Constants ──────────────────────────────────────────────────────────

const VERSION = getCliVersion();

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

  // Plan Mode state
  private planModeController: PlanModeController;
  /** The prompt that was entered while in plan mode (before plan generation) */
  private planModePendingPrompt: string = "";

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
    submitPrompt?(prompt: string): Promise<import("@qode-agent/runtime").ExecutionResult>;
    cancel?(): void;
  };

  // Event handlers
  private onExit?: () => Promise<void>;
  /** Dispose function for the global keyboard input listener */
  private disposeInputListener?: () => void;

  // Remote mode (QSSH)
  private isRemote = false;
  private remoteSession?: { sendControl: (cmd: unknown) => Promise<void>; stopStream: () => void; shutdown: () => Promise<void> };
  private remoteInfo?: RemoteSessionInfo;
  private heartbeatBar?: HeartbeatBarComponent;
  private auditLog?: AuditLogComponent;
  private instanceMetadata?: InstanceMetadataComponent;

  // Qollab Collaboration
  private collabManager?: import("@qode-agent/qollab").QollabSessionClient;
  private collabServer?: import("@qode-agent/qollab").QollabSessionServer;
  private collabAdmission?: import("@qode-agent/qollab").QollabAdmission;
  private collabSessionId?: string;
  private collabUserId?: string;
  private collabDisplayName?: string;
  private collabRole?: "master" | "attendee";
  private collabPendingCount: number = 0;

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
      activeAgent: "auto",
      isCollab: false,
      collabRole: undefined,
      collabAttendeeCount: 0,
      collabPendingCount: 0,
      collabDisplayName: undefined,
      collabSessionId: undefined,
      collabSnapshotInfo: undefined,
    };

    // ── Qollab Collaboration wiring ──────────────────────────────────
    if (options.collabClient) {
      this.collabManager = options.collabClient;
      this.collabServer = options.collabServer;
      this.collabAdmission = options.collabAdmission;
      this.collabSessionId = options.sessionId;
      this.collabUserId = options.collabUserId;
      this.collabDisplayName = options.collabDisplayName;
      this.collabRole = options.collabRole;

      this.appState.isCollab = true;
      this.appState.collabRole = options.collabRole;
      this.appState.collabDisplayName = options.collabDisplayName;
      this.appState.collabSessionId = options.sessionId;
    }

    // Initialize plan mode controller
    this.planModeController = new PlanModeController();
    this.planModeController.setSessionId(this.sessionId);
    this.setupPlanModeController();

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

  // ── Remote Mode (QSSH) ──────────────────────────────────────────────

  /**
   * Attach a remote session. The TUI switches to remote-streaming mode:
   * events from the remote daemon are fed into the existing handleAgentEvent
   * pipeline, and user prompts are routed to the remote via sendControl.
   */
  attachRemote(
    session: { sendControl: (cmd: unknown) => Promise<void>; stopStream: () => void; shutdown: () => Promise<void> },
    info: RemoteSessionInfo,
    onEvent: (handler: (env: NdjsonEnvelope) => void) => Promise<void>,
  ): void {
    this.isRemote = true;
    this.remoteSession = session;
    this.remoteInfo = info;
    this.appState.isRemote = true;
    this.appState.remoteInfo = info;

    // Create the instance metadata + heartbeat + audit components
    this.instanceMetadata = new InstanceMetadataComponent(info, this.colors);
    this.heartbeatBar = new HeartbeatBarComponent(this.colors);
    this.heartbeatBar.setRenderRequester(() => this.ui.requestRender());
    this.heartbeatBar.start();
    this.auditLog = new AuditLogComponent(this.colors);

    // Render the metadata banner in the transcript
    if (this.instanceMetadata) {
      this.transcriptContainer.addChild(this.instanceMetadata);
    }
    this.ui.requestRender();

    // Start streaming events — route them through the adapter to handleAgentEvent
    void onEvent((env: NdjsonEnvelope) => {
      this.handleRemoteEvent(env);
    });
  }

  /**
   * Handle a raw NDJSON envelope from the remote daemon.
   * Routes system/audit/sync events to the appropriate TUI components,
   * and agent/orchestrator events to the existing handleAgentEvent pipeline.
   */
  private handleRemoteEvent(env: NdjsonEnvelope): void {
    // Heartbeat — update the bar
    if (env.kind === "system" && env.type === "heartbeat") {
      this.heartbeatBar?.noteBeat();
      return;
    }
    // Metadata — already rendered on attach, but update info if needed
    if (env.kind === "system" && env.type === "remote.metadata") {
      return;
    }
    // Shutdown
    if (env.kind === "system" && env.type === "shutdown") {
      this.showStatus(`Remote daemon shutting down: ${String(env.message ?? env.reason ?? "")}`);
      return;
    }
    // System status/warning
    if (env.kind === "system") {
      if (env.type === "warning") {
        this.showError(String(env.message ?? "Remote warning"));
      } else if (env.type === "ready") {
        this.showStatus("Remote agent ready", "success");
      } else if (env.type === "prompt.received") {
        // Show the prompt as a user message
        const text = String(env.text ?? "");
        const userMsg = new UserMessageComponent(text, this.colors);
        this.transcriptContainer.addChild(userMsg);
      }
      return;
    }
    // Audit events — add to the audit log
    if (env.kind === "audit" && env.type.startsWith("file.")) {
      this.auditLog?.addEntry({
        ts: env.ts,
        action: env.type.replace("file.", "") as "create" | "modify" | "delete" | "rename",
        path: String(env.path ?? ""),
        bytesAfter: typeof env.bytesAfter === "number" ? env.bytesAfter : undefined,
        bytesBefore: typeof env.bytesBefore === "number" ? env.bytesBefore : undefined,
      });
      // Also show a status line
      this.showStatus(`[audit] ${env.type.replace("file.", "")} ${String(env.path ?? "")}`, "plain");
      return;
    }
    // Sync progress
    if (env.kind === "sync") {
      this.showStatus(`[sync] ${String(env.phase ?? "")} ${String(env.direction ?? "")} ${String(env.current ?? 0)}/${String(env.total ?? 0)}`, "plain");
      return;
    }
    // Agent + orchestrator events — pass through to the existing handler
    if (env.kind === "agent" || env.kind === "orchestrator") {
      // Strip envelope wrapper fields and pass the rest as an AgentEvent
      const { seq: _s, ts: _t, kind: _k, ...event } = env;
      this.handleAgentEvent(event as AgentEvent);
      return;
    }
  }

  // ── Qollab Collaboration ──────────────────────────────────────────

  /**
   * Attach a collaboration session to the TUI.
   * Called when starting or joining a Qollab session.
   */
  attachCollab(options: {
    client: import("@qode-agent/qollab").QollabSessionClient;
    server?: import("@qode-agent/qollab").QollabSessionServer;
    admission?: import("@qode-agent/qollab").QollabAdmission;
    sessionId: string;
    userId: string;
    displayName: string;
    role: "master" | "attendee";
  }): void {
    this.collabManager = options.client;
    this.collabServer = options.server;
    this.collabAdmission = options.admission;
    this.collabSessionId = options.sessionId;
    this.collabUserId = options.userId;
    this.collabDisplayName = options.displayName;
    this.collabRole = options.role;

    this.appState.isCollab = true;
    this.appState.collabRole = options.role;
    this.appState.collabDisplayName = options.displayName;
    this.appState.collabSessionId = options.sessionId;

    this.showStatus(
      `Qollab session started as ${options.role}. Display name: ${options.displayName}`,
      "success",
    );
    this.ui.requestRender();
  }

  /**
   * Handle an incoming Qollab server event in the TUI.
   */
  handleCollabEvent(event: import("@qode-agent/qollab").QollabServerEvent): void {
    switch (event.type) {
      case "chat.message": {
        const msg = event.message;
        if (msg.type === "system") {
          this.showStatus(`[System] ${msg.text}`, "plain");
        } else if (msg.type === "whisper") {
          this.showStatus(`[Whisper from ${msg.displayName}] ${msg.text}`, "info");
        } else {
          this.showStatus(`[${msg.displayName}] ${msg.text}`, "plain");
        }
        break;
      }
      case "attendee.joined": {
        this.appState.collabAttendeeCount = (this.appState.collabAttendeeCount ?? 0) + 1;
        this.showStatus(`${event.attendee.displayName} joined the session.`, "success");
        break;
      }
      case "attendee.left": {
        this.appState.collabAttendeeCount = Math.max(0, (this.appState.collabAttendeeCount ?? 1) - 1);
        this.showStatus(`Attendee left: ${event.userId.slice(0, 8)}...`, "info");
        break;
      }
      case "attendee.pending": {
        this.appState.collabPendingCount = (this.appState.collabPendingCount ?? 0) + 1;
        this.showStatus(
          `${event.displayName} wants to join. Use /admit ${event.userId}`,
          "warning",
        );
        break;
      }
      case "attendee.admitted": {
        this.showStatus(`Attendee admitted.`, "success");
        break;
      }
      case "attendee.rejected": {
        this.showStatus(`Attendee rejected: ${event.reason ?? "No reason"}`, "error");
        break;
      }
      case "snapshot.created": {
        this.appState.collabSnapshotInfo = `Snapshot: ${event.snapshot.manifest.totalFiles} files`;
        this.showStatus(
          `Snapshot updated: ${event.snapshot.manifest.totalFiles} files, ${event.snapshot.manifest.changedFiles.length} changed`,
          "success",
        );
        break;
      }
      case "snapshot.sync-request": {
        this.showStatus(
          `[Sync Request] ${event.displayName}: ${event.prompt.slice(0, 60)}...`,
          "warning",
        );
        this.showStatus(
          `Approve with /snapshot-approve <id>, reject with /snapshot-reject <reason>`,
          "info",
        );
        break;
      }
      case "snapshot.sync-accepted": {
        this.showStatus(`Snapshot sync accepted by master.`, "success");
        break;
      }
      case "snapshot.sync-rejected": {
        this.showStatus(`Snapshot sync rejected: ${event.reason}`, "error");
        break;
      }
      case "session.state": {
        const session = event.session;
        this.appState.collabAttendeeCount = session.attendees.length;
        this.showStatus(
          `Session active: ${session.metadata.displayName} (${session.attendees.length} attendees)`,
          "success",
        );
        break;
      }
      case "session.expired": {
        this.showStatus("Session has expired.", "error");
        this.appState.isCollab = false;
        break;
      }
      case "error": {
        this.showStatus(`Error: ${event.message}`, "error");
        break;
      }
    }
    this.ui.requestRender();
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

    // Stop remote-mode components
    this.heartbeatBar?.stop();
    this.remoteSession?.stopStream();

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
      if (this.activeDialog === "confirmation" || this.activeDialog === "revision" ||
          this.activeDialog === "plan-confirmation" || this.activeDialog === "plan-revision") {
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

    // ── Plan Mode Interception ──────────────────────────────────────
    // If plan mode is active, generate a plan first before executing.
    if (this.appState.planMode) {
      this.handlePlanModePrompt(text);
      return;
    }

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
        /** Apply a named agent profile to the active agent */
        applyProfile: (profileName: string) => {
          applyAgentProfile(agent, profileName, {
            cwd: this.workDir,
            sessionId: this.sessionId,
          });
        },
        /** Run a single-turn generation with the agent and return the response text */
        runGeneration: async (prompt: string, systemReminder?: string): Promise<string> => {
          // Inject a system reminder if provided
          if (systemReminder) {
            agent.context.appendSystemReminder(systemReminder, { kind: "system_trigger", name: "qmd-generation" });
          }
          const turnId = agent.turn.prompt(prompt);
          if (turnId === null) {
            throw new Error("Could not launch turn (another turn is active)");
          }
          await agent.turn.waitForCurrentTurn();
          const messages = agent.context.messages;
          const assistantMessages = messages.filter((m: any) => m.role === "assistant");
          const lastAssistant = assistantMessages[assistantMessages.length - 1];
          return lastAssistant?.content ?? "";
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

      // ── Qollab Collaboration ──────────────────────────────────────
      collabSendChat: (text: string) => {
        this.collabManager?.sendChat(text);
      },
      collabSendWhisper: (userId: string, text: string) => {
        this.collabManager?.sendWhisper(userId, text);
      },
      collabAdmit: (userId: string) => {
        this.collabManager?.admitAttendee(userId);
      },
      collabReject: (userId: string, reason?: string) => {
        this.collabManager?.rejectAttendee(userId, reason);
      },
      collabKick: (userId: string) => {
        this.collabManager?.kickAttendee(userId);
      },
      collabSnapshotPull: () => {
        this.collabManager?.requestSnapshotPull();
      },
      collabSnapshotSync: (prompt: string) => {
        this.collabManager?.requestSnapshotSync(prompt);
      },
      collabSnapshotApprove: (snapshotId: string) => {
        this.collabManager?.acceptSnapshot(snapshotId);
      },
      collabSnapshotReject: (reason: string) => {
        this.collabManager?.rejectSnapshot(reason);
      },
      collabSnapshotPush: () => {
        this.collabManager?.pushSnapshot();
      },
      collabShowStatus: () => {
        this.collabManager?.showStatus();
      },
      collabShowKey: () => {
        // Read the session key from the saved active session file
        const activeFile = resolve(homedir(), ".Q", "collab", "active-session.json");
        if (existsSync(activeFile)) {
          try {
            const raw = readFileSync(activeFile, "utf-8");
            const config = JSON.parse(raw);
            if (config.sessionKey) {
              this.showStatus(`Session Key: ${config.sessionKey}`, "info");
              this.showStatus(`Server: ws://127.0.0.1:${config.serverPort ?? 19876}`, "info");
              this.showStatus(`Share this key with attendees to let them join.`, "plain");
            } else {
              this.showStatus("No session key found in saved config.", "error");
            }
          } catch {
            this.showStatus("Could not read saved session config.", "error");
          }
        } else {
          this.showStatus("No active session file found.", "error");
        }
      },
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
  private routeCampaignEvent(_event: AgentEvent): void {
    // No campaign modes remain — all events are handled explicitly above.
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
    // ── Modus-maximus mode guard ────────────────────────────────────────
    // When modus-maximus is active, the turn.ended event fires when plan
    // generation finishes (Phase 1). But subsequent phases (dispatch,
    // convergence, verification) are still running within the same
    // orchestrator submitPrompt() call. Do NOT reset isProcessing since
    // the outer sendToAgent manages that lifecycle.
    // We DO need to end streaming to stop the flush timer, and we DO need
    // to stop context polling since plan output was already streamed.
    const isCampaignMode =
      this.appState.executionMode === "modus-maximus";

    if (!isCampaignMode) {
      this.isProcessing = false;
    }
    this.appState.streamingPhase = "idle";

    // Stop context polling
    this.stopContextPolling();

    // Finalize streaming — flushes all remaining buffers, stops timer
    this.streaming.endTurn();

    // ── Fallback: only render missed context if NOT modus-maximus mode
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

    // ── Remote mode: route the prompt to the remote daemon via sendControl ──
    if (this.isRemote && this.remoteSession) {
      this.isProcessing = true;
      this.appState.streamingPhase = "waiting";
      this.showStatus("Sending to remote agent...", "info");
      try {
        const mode = this.appState.executionMode === "modus-maximus" ? "modus_maximus" : "auto";
        await this.remoteSession.sendControl({ cmd: "prompt", text, mode });
        // The remote daemon will process it and stream events back.
        // We set isProcessing=false when the turn.ended event arrives.
      } catch (err) {
        this.showError(`Failed to send to remote: ${err instanceof Error ? err.message : String(err)}`);
        this.isProcessing = false;
      }
      return;
    }

    // ── Modus Maximus: route through orchestrator for mode-aware execution ──
    // When modus-maximus is active, the orchestrator handles the full pipeline
    // including planning, sub-agent orchestration, and review.
    const isCampaignMode =
      this.appState.executionMode === "modus-maximus";

    if (isCampaignMode && this.orchestratorHost?.submitPrompt) {
      this.isProcessing = true;

      try {
        const result = await this.orchestratorHost.submitPrompt(text);

        // ── Show the final summary ──────────────────────────────────────
        // During modus-maximus execution, individual sub-tasks stream their
        // content (thinking, tool calls, text) via normal turn events.
        // Additionally, the final LLM summary (if generated) also streams
        // naturally through the turn event system. We only need to render
        // the result output as a static component if streaming did NOT
        // deliver any content (fallback for the structured summary).
        const streamingDelivered = this.streaming.hasDeliveredContent;
        if (!streamingDelivered && result.output) {
          const summaryLabel = "Modus Maximus Results";

          const summaryContent = `**${summaryLabel}**\n\n${result.output}`;
          const summaryComp = new AssistantMessageComponent(this.colors);
          summaryComp.setContent(summaryContent);
          this.transcriptContainer.addChild(summaryComp);
        }

        if (!result.success && result.error) {
          const modeLabel = this.appState.executionMode ?? "modus-maximus";
          this.showError(`${modeLabel} error: ${result.error}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const modeLabel = this.appState.executionMode ?? "modus-maximus";
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
    // Remote mode: send a cancel control command to the remote daemon
    if (this.isRemote && this.remoteSession) {
      this.showStatus("Cancelling remote task...");
      void this.remoteSession.sendControl({ cmd: "cancel" });
      return;
    }

    // During modus-maximus mode, cancel via the orchestrator
    const isCampaignMode =
      this.appState.executionMode === "modus-maximus";

    if (isCampaignMode) {
      const modeLabel = this.appState.executionMode ?? "modus-maximus";
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

  // ── Plan Mode ──────────────────────────────────────────────────────

  /**
   * Setup the plan mode controller callbacks.
   */
  private setupPlanModeController(): void {
    this.planModeController.setOnPhaseChange((phase) => {
      // Update the editor border to reflect plan mode state
      if (phase === "planning") {
        this.editor.borderColor = (s: string) =>
          chalk.hex(this.colors.warning)(s);
      } else if (phase === "reviewing") {
        this.editor.borderColor = (s: string) =>
          chalk.hex(this.colors.success)(s);
      } else if (phase === "executing") {
        this.editor.borderColor = (s: string) =>
          chalk.hex(this.colors.primary)(s);
      } else {
        this.editor.borderColor = (s: string) =>
          chalk.hex(this.colors.border)(s);
      }
      this.ui.requestRender();
    });

    this.planModeController.setOnShowPlan((content, filePath) => {
      // Show the plan as an assistant message in the transcript
      const planHeader = "**Implementation Plan**";
      const planContent = `${planHeader}\n\n${content}`;
      const planComponent = new AssistantMessageComponent(this.colors);
      planComponent.setContent(planContent);
      this.transcriptContainer.addChild(planComponent);

      // Show a status message with the file path
      const status = new StatusMessageComponent(
        `Plan saved to ${filePath}`,
        this.colors,
        "success",
        filePath,
      );
      this.transcriptContainer.addChild(status);
      this.ui.requestRender();
    });

    this.planModeController.setOnShowDropdown(() => {
      // Show the plan confirmation dropdown
      const dropdown = new PlanDropdownComponent(this.colors);
      dropdown.setPlanFilePath(this.planModeController.currentPlanFilePath);

      dropdown.setOnChoice((choice) => {
        void this.handlePlanChoice(choice);
      });

      dropdown.setOnCancel(() => {
        // Cancel = Exit plan mode
        void this.handlePlanChoice("exit");
      });

      this.mountDialog(dropdown, "plan-confirmation");
    });

    this.planModeController.setOnShowRevisionInput(() => {
      // Show the revision input dialog
      const revisionInput = new PlanRevisionInputComponent(this.colors);

      revisionInput.setOnSubmit((text) => {
        void this.handlePlanRevision(text);
      });

      revisionInput.setOnCancel(() => {
        // Cancel revision → go back to the dropdown
        this.restoreEditor();
        this.planModeController.setOnShowDropdown(() => {
          const dropdown = new PlanDropdownComponent(this.colors);
          dropdown.setPlanFilePath(this.planModeController.currentPlanFilePath);

          dropdown.setOnChoice((choice) => {
            void this.handlePlanChoice(choice);
          });

          dropdown.setOnCancel(() => {
            void this.handlePlanChoice("exit");
          });

          this.mountDialog(dropdown, "plan-confirmation");
        });
        this.planModeController.setOnShowDropdown!();
      });

      this.mountDialog(revisionInput, "plan-revision");
    });

    this.planModeController.setOnRestoreEditor(() => {
      this.restoreEditor();
    });
  }

  /**
   * Handle a prompt entered while in plan mode.
   * Generates a plan, shows it, and presents the confirmation dropdown.
   */
  private async handlePlanModePrompt(text: string): Promise<void> {
    // Create and add user message component to transcript
    const userMsg = new UserMessageComponent(text, this.colors);
    this.transcriptContainer.addChild(userMsg);
    this.ui.requestRender();

    this.planModePendingPrompt = text;

    // Show a status message indicating plan generation
    this.showStatus("Generating plan...", "info");

    // Generate the plan
    const host = this.createSlashCommandHost();
    await this.planModeController.generatePlan(host, text);
  }

  /**
   * Handle the user's choice from the plan confirmation dropdown.
   * Delegates to the plan mode controller for lifecycle management.
   */
  private async handlePlanChoice(choice: import("./plan/index.js").PlanChoice): Promise<void> {
    const host = this.createSlashCommandHost();

    switch (choice) {
      case "looks-good": {
        // Restore editor first
        this.restoreEditor();
        // Delegate to controller (triggers onRestoreEditor callback)
        await this.planModeController.handleChoice(host, choice);
        // Execute the plan
        this.showStatus("Plan accepted. Executing...", "success");
        await this.executePlan();
        break;
      }

      case "needs-revision": {
        // Delegate to controller — it will trigger onShowRevisionInput callback
        await this.planModeController.handleChoice(host, choice);
        break;
      }

      case "redo": {
        // Restore editor
        this.restoreEditor();
        // Delegate to controller
        await this.planModeController.handleChoice(host, choice);
        // Regenerate the plan
        this.showStatus("Regenerating plan...", "info");
        await this.planModeController.generatePlan(host, this.planModePendingPrompt);
        break;
      }

      case "exit": {
        // Restore editor
        this.restoreEditor();
        // Delegate to controller — it will exit plan mode
        await this.planModeController.handleChoice(host, choice);
        this.appState.planMode = false;
        this.showStatus("Exiting plan mode. Executing directly...", "info");
        // Send the original prompt to the agent
        this.sendToAgent(this.planModePendingPrompt);
        break;
      }
    }
  }

  /**
   * Handle a revision submission from the plan revision input.
   */
  private async handlePlanRevision(revisionText: string): Promise<void> {
    this.restoreEditor();
    const host = this.createSlashCommandHost();
    await this.planModeController.applyRevision(host, revisionText);
  }

  /**
   * Execute the approved plan by sending it to the agent.
   */
  private async executePlan(): Promise<void> {
    const prompt = this.planModePendingPrompt;
    const planContent = this.planModeController.currentPlanContent;

    // Exit plan mode
    this.planModeController.exit();
    this.appState.planMode = false;

    // Send the plan as context and execute
    const executionPrompt = `I have an approved plan. Please implement it step by step.

Plan:
${planContent}

Original request: ${prompt}

Follow the plan carefully. Complete each step before moving to the next.`;

    this.sendToAgent(executionPrompt);
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
        if (this.isRemote && this.remoteSession) {
          // Remote mode: send confirmation via control command
          this.remoteSession.sendControl({ cmd: "confirm", choice }).catch((err) => {
            this.showError(`Failed to send confirmation: ${err.message}`);
          });
        } else if (this.orchestratorHost?.resolveModusMaximusConfirmation) {
          this.orchestratorHost.resolveModusMaximusConfirmation({ choice });
        }
      }
    });

    dropdown.setOnCancel(() => {
      // Cancel = choose Redo
      this.restoreEditor();
      if (this.isRemote && this.remoteSession) {
        this.remoteSession.sendControl({ cmd: "confirm", choice: "redo" }).catch((err) => {
          this.showError(`Failed to send confirmation: ${err.message}`);
        });
      } else if (this.orchestratorHost?.resolveModusMaximusConfirmation) {
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
      if (this.isRemote && this.remoteSession) {
        this.remoteSession.sendControl({ cmd: "confirm", choice: "needs-revision", revisionText: text }).catch((err) => {
          this.showError(`Failed to send confirmation: ${err.message}`);
        });
      } else if (this.orchestratorHost?.resolveModusMaximusConfirmation) {
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