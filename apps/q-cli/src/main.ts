import { program, type Command } from "commander";
import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { discoverConfig } from "./cli/config-discover.js";
import { parseCliOptions, type CliOptions } from "./cli/types.js";
import { validateOptions } from "./cli/validator.js";
import { StartupError, StartupErrorCodes, formatStartupError } from "./cli/errors.js";
import { registerInitCommand } from "./cli/init.js";
import { registerSessionCommand } from "./cli/session.js";
import { registerConfigCommand } from "./cli/config.js";
import { registerDoctorCommand } from "./cli/doctor.js";
import { registerMigrateCommand } from "./cli/migrate.js";
import { registerUpdateCommand } from "./cli/update.js";
import { registerCompletionsCommand } from "./cli/completions.js";
import { registerDaemonCommand } from "./cli/daemon.js";
import { registerConnectCommand } from "./cli/connect.js";
import { registerProfileCommand } from "./cli/profile.js";
import { registerPluginCommand } from "./cli/plugin.js";
import { OrchestratorCore } from "./orchestrator/core.js";
import { PluginManager } from "./plugins/plugin-manager.js";
import { SkillRegistry } from "./skills/registry.js";
import { McpConnectionManager } from "./mcp/manager.js";
import { createAgent, resolveProviderConfig } from "./agent/wiring.js";
import { checkFirstRun, OnboardingWizard, clearOnboardingComplete } from "./onboarding/index.js";
import { startTui } from "./tui/index.js";

/**
 * Startup sequence:
 * 1. Parse CLI args
 * 2. Validate options (no conflicting flags)
 * 3. Discover .q/ directory by walking up from cwd
 * 4. Load config
 * 5. Detect TUI capability
 * 6. Launch TUI, interactive session, or run prompt mode
 */
async function main(): Promise<void> {
  const prog = createProgram();
  registerAllCommands(prog);

  prog.action(async () => {
    const rawOpts = prog.opts() as Record<string, unknown>;
    const opts = parseAndValidateOptions(rawOpts);
    const startup = await runStartupSequence(opts);

    // ── First-run onboarding gate ────────────────────────────────────
    if (opts.setup) {
      clearOnboardingComplete();
    }

    const hasEnvConfig = !!(process.env.Q_PROVIDER && process.env.Q_MODEL && process.env.Q_API_KEY);
    const isCi = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
    const isInteractive = process.stdout.isTTY && process.stdin.isTTY && !isCi;

    const onboardingGate = checkFirstRun(startup.projectRoot, opts, {
      vDir: startup.vDir,
      projectRoot: startup.projectRoot,
      initialized: startup.initialized,
    });

    if (onboardingGate.needed && !hasEnvConfig) {
      if (!isInteractive) {
        if (isCi) {
          process.stderr.write(
            "[Q] First-run setup skipped (CI mode). Set Q_PROVIDER, Q_MODEL, Q_API_KEY env vars.\n",
          );
        } else {
          console.log(chalk.cyan("Qode needs initial setup."));
          console.log(chalk.dim("  Run 'q-cli' without --prompt to launch the interactive setup wizard."));
          console.log(chalk.dim("  Or set Q_PROVIDER, Q_MODEL, and Q_API_KEY environment variables."));
        }
      } else {
        const wizard = new OnboardingWizard();
        const success = await wizard.run();
        if (!success) {
          process.exit(0);
        }
      }
    }

    if (opts.prompt) {
      await runPromptMode(opts, startup);
    } else if (opts.tui !== false && isInteractive) {
      await startTuiSession(opts, startup);
    } else {
      await startInteractiveSession(startup);
    }
  });

  await prog.parseAsync(process.argv);
}

function createProgram(): Command {
  const prog = program
    .name("q-cli")
    .description("Qode — Autonomous Coding Agent")
    .version("0.1.0");

  prog
    .option("-S, --session <id>", "Resume a specific session")
    .option("-C, --continue", "Continue the last session")
    .option("-y, --yolo", "Auto-approve all actions")
    .option("-m, --model <name>", "Override the LLM model")
    .option("-p, --prompt <text>", "Non-interactive prompt mode")
    .option("--plan", "Enter plan mode on startup")
    .option("--auto", "Auto permission mode")
    .option("--setup", "Re-run the initial setup wizard")
    .option("--output-format <format>", "Output format for non-interactive mode (text|json|stream-json)", "text")
    .option("--skills-dir <dir>", "Additional skill directories (repeatable)", collectDirs, [] as string[])
    .option("--cwd <path>", "Set the working directory")
    .option("--tui", "Force TUI mode (default when interactive)")
    .option("--no-tui", "Disable TUI, use readline mode instead");

  prog.addHelpText("after", () => {
    return `\n${chalk.dim("Learn more at: https://qode.sh/docs")}`;
  });

  return prog;
}

function registerAllCommands(prog: Command): void {
  registerInitCommand(prog);
  registerSessionCommand(prog);
  registerConfigCommand(prog);
  registerDoctorCommand(prog);
  registerMigrateCommand(prog);
  registerUpdateCommand(prog);
  registerCompletionsCommand(prog);
  registerDaemonCommand(prog);
  registerConnectCommand(prog);
  registerProfileCommand(prog);
  registerPluginCommand(prog);
}

function parseAndValidateOptions(rawOpts: Record<string, unknown>): CliOptions {
  const mapped: Record<string, unknown> = {
    session: rawOpts.session,
    continue: Boolean(rawOpts.continue),
    yolo: Boolean(rawOpts.yolo),
    auto: Boolean(rawOpts.auto),
    setup: Boolean(rawOpts.setup),
    model: rawOpts.model,
    prompt: rawOpts.prompt,
    plan: Boolean(rawOpts.plan),
    outputFormat: rawOpts.outputFormat ?? "text",
    skillsDirs: Array.isArray(rawOpts.skillsDirs) ? rawOpts.skillsDirs : [],
    cwd: rawOpts.cwd,
    tui: rawOpts.tui !== undefined ? Boolean(rawOpts.tui) : undefined,
  };

  const opts = parseCliOptions(mapped);
  const validation = validateOptions(opts);
  if (!validation.valid) {
    throw new StartupError(
      StartupErrorCodes.VALIDATION_ERROR,
      "Invalid CLI options:\n" + validation.errors.map((e) => `  - ${e}`).join("\n"),
      "Check your flags and try again.",
    );
  }
  return opts;
}

async function runStartupSequence(opts: CliOptions): Promise<{
  opts: CliOptions;
  projectRoot: string;
  vDir: string | null;
  initialized: boolean;
}> {
  const explicitCwd = opts.cwd ?? null;
  if (explicitCwd) {
    const configDiscovery = discoverConfig(explicitCwd);
    return {
      opts,
      projectRoot: explicitCwd,
      vDir: configDiscovery.vDir,
      initialized: configDiscovery.initialized,
    };
  }
  const configDiscovery = discoverConfig(process.cwd());
  return {
    opts,
    projectRoot: process.cwd(),
    vDir: configDiscovery.vDir,
    initialized: configDiscovery.initialized,
  };
}

async function runPromptMode(
  opts: CliOptions,
  startup: { projectRoot: string; vDir: string | null; initialized: boolean },
): Promise<void> {
  console.log(chalk.cyan("Qode — Autonomous Coding Agent v0.1.0"));
  const providerCfg = resolveProviderConfig(startup.projectRoot);
  if (!providerCfg) {
    console.log(chalk.red("✗ No provider configured. Set Q_PROVIDER, Q_MODEL, Q_API_KEY env vars."));
    process.exit(1);
  }
  const agent = createAgent({ workDir: startup.projectRoot, resolvedProvider: providerCfg, yolo: opts.yolo, auto: opts.auto });
  if (!agent) {
    console.log(chalk.red("✗ Failed to create agent."));
    process.exit(1);
  }
  try {
    const pluginSkillRegistry = new SkillRegistry({ cwd: startup.projectRoot });
    const pluginMcpManager = new McpConnectionManager();
    const pluginManager = new PluginManager(pluginSkillRegistry, pluginMcpManager, agent.tools, {}, startup.projectRoot);
    pluginManager.activateAll().catch((err) => console.error("[Startup] Plugin activation error (non-fatal):", err));
  } catch (err) {
    console.error("[Startup] Plugin system initialization error (non-fatal):", err);
  }
  const sessionId = opts.session ?? randomUUID();
  const orch = new OrchestratorCore({ convergenceTimeout: 60_000, taskTimeout: 300_000, workspaceRoot: startup.projectRoot });
  orch.setAgent(agent);
  orch.setSessionId(sessionId);
  try {
    await orch.initMemorySystem(sessionId);
  } catch (err) {
    console.error("[Startup] Memory system initialization failed (non-fatal):", err);
  }
  const outputFormat = opts.outputFormat ?? "text";
  if (outputFormat === "json") {
    console.log(JSON.stringify({ sessionId, status: "started", prompt: opts.prompt }));
  }
  const startedAt = Date.now();
  try {
    const turnId = agent.turn.prompt(opts.prompt!);
    if (turnId === null) {
      console.error(chalk.red("✗ Could not launch turn (another turn is active)."));
      process.exit(1);
    }
    await agent.turn.waitForCurrentTurn();
    const messages = agent.context.messages;
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    const output = lastAssistant?.content ?? "";
    const durationMs = Date.now() - startedAt;
    const toolCalls = messages.filter((m) => m.role === "tool").length;
    if (outputFormat === "json") {
      console.log(JSON.stringify({ sessionId, status: "completed", output, toolCalls, durationMs }));
    } else if (outputFormat === "stream-json") {
      console.log(JSON.stringify({ sessionId, status: "completed", output, toolCalls, durationMs }));
    } else {
      if (output) {
        console.log("\n" + output);
      } else if (toolCalls > 0) {
        console.log(chalk.hex("#64748B")(`\n  (${toolCalls} tool call${toolCalls > 1 ? "s" : ""} executed — no text response)`));
      } else {
        console.log(chalk.hex("#64748B")("\n  (no response)"));
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (outputFormat === "json") {
      console.log(JSON.stringify({ sessionId, status: "error", error: msg }));
    } else {
      console.error(chalk.red(`✗ Error: ${msg}`));
    }
    process.exit(1);
  }
}

async function startTuiSession(
  opts: CliOptions,
  startup: { projectRoot: string; vDir: string | null; initialized: boolean },
): Promise<void> {
  const providerCfg = resolveProviderConfig(startup.projectRoot);
  if (!providerCfg) {
    console.log(chalk.yellow("⚠ No provider configured."));
    console.log(chalk.dim("  Set Q_PROVIDER, Q_MODEL, Q_API_KEY env vars, or run 'q-cli setup'."));
    console.log();
    return;
  }
  const agent = createAgent({ workDir: startup.projectRoot, resolvedProvider: providerCfg, yolo: opts.yolo, auto: opts.auto });
  if (!agent) {
    console.log(chalk.red("✗ Failed to create agent."));
    return;
  }
  try {
    const pluginSkillRegistry = new SkillRegistry({ cwd: startup.projectRoot });
    const pluginMcpManager = new McpConnectionManager();
    const pluginManager = new PluginManager(pluginSkillRegistry, pluginMcpManager, agent.tools, {}, startup.projectRoot);
    pluginManager.activateAll().catch((err) => console.error("[Startup] Plugin activation error (non-fatal):", err));
  } catch (err) {
    console.error("[Startup] Plugin system initialization error (non-fatal):", err);
  }
  const sessionId = opts.session ?? randomUUID();
  const orch = new OrchestratorCore({ convergenceTimeout: 60_000, taskTimeout: 300_000, workspaceRoot: startup.projectRoot });
  orch.setAgent(agent);
  orch.setSessionId(sessionId);
  try {
    await orch.initMemorySystem(sessionId);
  } catch (err) {
    console.error("[Startup] Memory system initialization failed (non-fatal):", err);
  }
  const tui = await startTui({
    agent,
    workDir: startup.projectRoot,
    sessionId,
    model: providerCfg.model,
    version: "0.1.0",
    permissionMode: opts.yolo ? "yolo" : opts.auto ? "auto" : "manual",
    planMode: opts.plan ?? false,
    yolo: opts.yolo ?? false,
    auto: opts.auto ?? false,
    orchestrator: {
      setCurrentMode: (mode: string) => {
        orch.currentMode = mode as any;
      },
      getCurrentMode: () => orch.currentMode ?? "not set",
    },
  });
  tui.setOnExit(async () => {
    try { orch.cancel(); } catch { /* ignore */ }
  });
  await new Promise<void>(() => {});
}

async function startInteractiveSession(startup: {
  opts: CliOptions;
  projectRoot: string;
  vDir: string | null;
  initialized: boolean;
}): Promise<void> {
  console.log(chalk.cyan("Qode — Autonomous Coding Agent v0.1.0"));
  console.log(chalk.dim("  Interactive mode. Type /help for commands, /exit to quit."));
  console.log();
  const providerCfg = resolveProviderConfig(startup.projectRoot);
  if (!providerCfg) {
    console.log(chalk.yellow("⚠ No provider configured."));
    console.log(chalk.dim("  Set Q_PROVIDER, Q_MODEL, Q_API_KEY env vars, or run 'q-cli setup'."));
    console.log();
    return;
  }
  const agent = createAgent({ workDir: startup.projectRoot, resolvedProvider: providerCfg, yolo: startup.opts.yolo, auto: startup.opts.auto });
  if (!agent) {
    console.log(chalk.red("✗ Failed to create agent."));
    return;
  }
  try {
    const pluginSkillRegistry = new SkillRegistry({ cwd: startup.projectRoot });
    const pluginMcpManager = new McpConnectionManager();
    const pluginManager = new PluginManager(pluginSkillRegistry, pluginMcpManager, agent.tools, {}, startup.projectRoot);
    pluginManager.activateAll().catch((err) => console.error("[Startup] Plugin activation error (non-fatal):", err));
  } catch (err) {
    console.error("[Startup] Plugin system initialization error (non-fatal):", err);
  }
  const sessionId = startup.opts.session ?? randomUUID();
  const orch = new OrchestratorCore({ convergenceTimeout: 60_000, taskTimeout: 300_000, workspaceRoot: startup.projectRoot });
  orch.setAgent(agent);
  orch.setSessionId(sessionId);
  try {
    await orch.initMemorySystem(sessionId);
  } catch (err) {
    console.error("[Startup] Memory system initialization failed (non-fatal):", err);
  }
  let running = true;
  while (running) {
    process.stdout.write(chalk.green("q> "));
    const prompt = await readLine();
    if (prompt === null) break;
    const trimmed = prompt.trim();
    if (trimmed.startsWith("/")) {
      const cmd = trimmed.toLowerCase();
      switch (cmd) {
        case "/exit": case "/quit": running = false; continue;
        case "/help":
          console.log(chalk.cyan("Qode Commands:"));
          console.log(chalk.dim("  /help          Show this help"));
          console.log(chalk.dim("  /exit, /quit   Exit the session"));
          console.log(chalk.dim("  /clear         Clear screen"));
          console.log(chalk.dim("  /session       Show session info"));
          console.log(chalk.dim("  /yolo          Toggle yolo mode"));
          console.log();
          continue;
        case "/clear": console.clear(); continue;
        case "/session":
          console.log(chalk.dim(`  Session: ${sessionId}`));
          console.log(chalk.dim(`  CWD: ${startup.projectRoot}`));
          continue;
        case "/yolo":
          agent.permission.setMode("yolo");
          console.log(chalk.green("✓ YOLO mode enabled"));
          continue;
        default: console.log(chalk.yellow(`Unknown command: ${trimmed}`)); continue;
      }
    }
    if (!trimmed) continue;
    const startedAt = Date.now();
    try {
      const turnId = agent.turn.prompt(trimmed);
      if (turnId === null) { console.log(chalk.red("✗ Could not launch turn (another turn is active).")); continue; }
      await agent.turn.waitForCurrentTurn();
      const messages = agent.context.messages;
      const assistantMessages = messages.filter((m) => m.role === "assistant");
      const lastAssistant = assistantMessages[assistantMessages.length - 1];
      const output = lastAssistant?.content ?? "";
      const toolCalls = messages.filter((m) => m.role === "tool").length;
      if (output) {
        console.log("\n" + output);
      } else if (toolCalls > 0) {
        console.log(chalk.hex("#64748B")(`  (${toolCalls} tool call${toolCalls > 1 ? "s" : ""} executed — no text response)`));
      } else if (assistantMessages.length === 0) {
        console.log(chalk.hex("#64748B")("  (no response received)"));
      }
      console.log();
    } catch (err) {
      console.log(chalk.red(`✗ Error: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}

function readLine(): Promise<string | null> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    let line = "";
    const onData = (chunk: Buffer) => {
      const str = chunk.toString();
      for (const char of str) {
        if (char === "\n" || char === "\r") { cleanup(); resolve(line); return; }
        if (char === "\x7f" || char === "\b") { if (line.length > 0) { line = line.slice(0, -1); stdout.write("\b \b"); } }
        else if (char === "\x03") { cleanup(); resolve(null); return; }
        else { line += char; }
      }
    };
    const cleanup = () => { stdin.removeListener("data", onData); stdin.removeListener("end", onEnd); stdin.setRawMode?.(false); };
    const onEnd = () => { cleanup(); resolve(null); };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    try { stdin.setRawMode?.(true); } catch { /* not a TTY */ }
  });
}

function collectDirs(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

main().catch((err) => {
  console.error(formatStartupError(err));
  process.exit(1);
});