/**
 * ToolManager — Registry of ToolDefinition objects.
 *
 * Manages built-in, user-registered, and MCP tools.
 * Provides the loopTools getter that builds the tool list for LLM consumption.
 *
 * Built-in tools are backed by the agent's `runtime.qmain` and the high-level
 * `FileConnector` / `ShellConnector` / `WebConnector` from `@q/qmain`.
 */

import { dirname } from "node:path";
import { FileConnector, ShellConnector, WebConnector, ConnectorNotAvailableError } from "@q/qmain";
import type { Qmain } from "@q/qmain";
import { type ExecutableTool, ToolAccesses } from "../../loop/index.js";
import type { ExecutableToolContext, ExecutableToolResult, ExecutableToolSuccessResult } from "../../loop/types.js";
import type { Agent } from "../agent.js";

export type ToolSource = "builtin" | "user" | "mcp";

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly active: boolean;
  readonly source: ToolSource;
}

export interface UserToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** Maximum tool output size in bytes (matches tool-call.ts). */
const TOOL_OUTPUT_CAP = 100_000;
/** Maximum body size for WebFetch responses. */
const WEB_FETCH_CAP = 50_000;

export class ToolManager {
  protected builtinTools: Map<string, ExecutableTool> = new Map();
  protected readonly userTools: Map<string, ExecutableTool> = new Map();
  protected readonly mcpTools: Map<string, ExecutableTool> = new Map();
  protected enabledTools: Set<string> = new Set();
  protected readonly store: Record<string, unknown> = {};

  /** Connectors captured from agent.runtime.qmain on first init. */
  private fileConnector: FileConnector;
  private shellConnector: ShellConnector;
  private webConnector: WebConnector;
  private qmain: Qmain;

  constructor(protected readonly agent: Agent) {
    // Capture the Kaos runtime and instantiate connectors.
    // Built-in tools are provider-agnostic, so we always initialize them
    // (the previous guard `if (agent.config.hasProvider)` was an init-order
    // hazard that prevented tools from being available in tests / early init).
    this.qmain = agent.runtime.qmain;
    this.fileConnector = new FileConnector(this.qmain);
    this.shellConnector = new ShellConnector(this.qmain, { cwd: agent.config.cwd });
    this.webConnector = new WebConnector();
    this.initializeBuiltinTools();
  }

  /** Force re-initialize builtin tools (used when subagent host changes) */
  reinitializeBuiltinTools(): void {
    this.initializeBuiltinTools();
  }

  /** Update the shell connector's default working directory */
  setShellCwd(cwd: string): void {
    this.shellConnector.setCwd(cwd);
  }

  setActiveTools(names: readonly string[]): void {
    this.enabledTools = new Set(names);
  }

  registerUserTool(input: UserToolRegistration): void {
    const { name, description, parameters } = input;
    const tool: ExecutableTool = {
      name,
      description,
      parameters,
      resolveExecution: (_args: unknown) => {
        return {
          approvalRule: name,
          execute: async (_context: ExecutableToolContext): Promise<ExecutableToolResult> => {
            return { output: JSON.stringify(_args), isError: false };
          },
        };
      },
    };
    this.userTools.set(name, tool);
    this.enabledTools.add(name);
  }

  unregisterUserTool(name: string): void {
    this.userTools.delete(name);
    this.enabledTools.delete(name);
  }

  updateStore(key: string, value: unknown): void {
    this.store[key] = value;
  }

  *toolInfos(): Iterable<ToolInfo> {
    for (const tool of this.builtinTools.values()) {
      yield {
        name: tool.name,
        description: tool.description,
        active: this.enabledTools.has(tool.name),
        source: "builtin",
      };
    }
    for (const tool of this.userTools.values()) {
      yield {
        name: tool.name,
        description: tool.description,
        active: this.enabledTools.has(tool.name),
        source: "user",
      };
    }
    for (const [name, tool] of this.mcpTools.entries()) {
      yield {
        name,
        description: tool.description,
        active: this.enabledTools.has(name),
        source: "mcp",
      };
    }
  }

  data(): readonly ToolInfo[] {
    return Array.from(this.toolInfos());
  }

  get loopTools(): readonly ExecutableTool[] {
    const names = Array.from(this.enabledTools);
    names.sort((a: string, b: string) => a.localeCompare(b));
    return names
      .map((name: string) =>
        this.userTools.get(name) ??
        this.mcpTools.get(name) ??
        this.builtinTools.get(name),
      )
      .filter((tool: ExecutableTool | undefined): tool is ExecutableTool => tool !== undefined);
  }

  initializeBuiltinTools(): void {
    this.builtinTools = new Map(
      [
        createReadTool(this.fileConnector),
        createWriteTool(this.qmain, this.fileConnector),
        createStrReplaceTool(this.fileConnector),
        createGlobTool(this.qmain),
        createGrepTool(this.fileConnector),
        createBashTool(this.shellConnector),
        createAgentTool(this.agent),
        createTaskListTool(this.agent),
        createTaskOutputTool(this.agent),
        createTaskStopTool(this.agent, this.shellConnector),
        createWebSearchTool(this.webConnector),
        createWebFetchTool(this.webConnector),
      ].map((tool) => [tool.name, tool] as const),
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate a string to a max length, appending a marker if cut. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated ${s.length - max} bytes]`;
}

/** Build a success result. */
function ok(output: string): ExecutableToolSuccessResult {
  return { output, isError: false };
}

/** Build an error result. */
function err(message: string, opts?: { stopTurn?: boolean }): ExecutableToolResult {
  return { output: message, isError: true, message, stopTurn: opts?.stopTurn };
}

// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------

function createReadTool(fileConnector: FileConnector): ExecutableTool {
  return {
    name: "Read",
    description: "Read the contents of a file at the given path. Returns the file content as a string.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to read." },
        offset: { type: "number", description: "Optional line number to start reading from (0-indexed)." },
        limit: { type: "number", description: "Optional maximum number of lines to read." },
      },
      required: ["path"],
    },
    resolveExecution: (args: unknown) => {
      const a = args as { path?: string; offset?: number; limit?: number };
      const path = a?.path ?? "";
      return {
        approvalRule: "Read",
        accesses: ToolAccesses.readFile(path),
        execute: async (_ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
          try {
            const content = await fileConnector.read(path);
            if (typeof content !== "string") {
              return err(`File is not a text file: ${path}`);
            }
            if (a?.offset !== undefined || a?.limit !== undefined) {
              const lines = content.split("\n");
              const start = a.offset ?? 0;
              const end = a.limit !== undefined ? start + a.limit : lines.length;
              return ok(lines.slice(start, end).join("\n"));
            }
            return ok(truncate(content, TOOL_OUTPUT_CAP));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return err(`Failed to read ${path}: ${msg}`);
          }
        },
      };
    },
  };
}

function createWriteTool(qmain: Qmain, fileConnector: FileConnector): ExecutableTool {
  return {
    name: "Write",
    description: "Write content to a file, creating parent directories as needed. Overwrites the file if it already exists.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to write." },
        content: { type: "string", description: "The full content to write to the file." },
      },
      required: ["path", "content"],
    },
    resolveExecution: (args: unknown) => {
      const a = args as { path?: string; content?: string };
      const path = a?.path ?? "";
      const content = a?.content ?? "";
      return {
        approvalRule: "Write",
        accesses: ToolAccesses.writeFile(path),
        execute: async (_ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
          try {
            // Ensure parent directory exists.
            const parent = dirname(path);
            if (parent && parent !== "." && parent !== "/") {
              await qmain.mkdir(parent, { recursive: true }).catch(() => {
                // ignore — mkdir of existing dir is fine
              });
            }
            await fileConnector.write(path, content);
            return ok(`Wrote ${content.length} bytes to ${path}`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return err(`Failed to write ${path}: ${msg}`);
          }
        },
      };
    },
  };
}

function createStrReplaceTool(fileConnector: FileConnector): ExecutableTool {
  return {
    name: "StrReplace",
    description: "Replace a literal string in an existing file with a new string. Fails if the old string is not found.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to edit." },
        old: { type: "string", description: "The exact string to find (must match uniquely)." },
        new: { type: "string", description: "The replacement string." },
        replaceAll: { type: "boolean", description: "If true, replace every occurrence; if false (default), fail on multiple matches." },
      },
      required: ["path", "old", "new"],
    },
    resolveExecution: (args: unknown) => {
      const a = args as { path?: string; old?: string; new?: string; replaceAll?: boolean };
      const path = a?.path ?? "";
      return {
        approvalRule: "StrReplace",
        accesses: ToolAccesses.readWriteFile(path),
        execute: async (_ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
          try {
            const oldStr = a?.old ?? "";
            const newStr = a?.new ?? "";
            const content = await fileConnector.read(path);
            if (typeof content !== "string") {
              return err(`File is not a text file: ${path}`);
            }

            if (a?.replaceAll) {
              if (!content.includes(oldStr)) {
                return err(`String not found in ${path}`);
              }
              const occurrences = content.split(oldStr).length - 1;
              const updated = content.split(oldStr).join(newStr);
              await fileConnector.write(path, updated);
              return ok(`Replaced ${occurrences} occurrence(s) in ${path}`);
            }

            // Single replace (default) — must be unique
            const firstIdx = content.indexOf(oldStr);
            if (firstIdx === -1) {
              return err(`String not found in ${path}`);
            }
            const lastIdx = content.lastIndexOf(oldStr);
            if (firstIdx !== lastIdx) {
              return err(
                `String occurs ${content.split(oldStr).length - 1} times in ${path}. ` +
                  `Pass a more specific 'old' string or set replaceAll=true.`,
              );
            }
            const updated = content.slice(0, firstIdx) + newStr + content.slice(firstIdx + oldStr.length);
            await fileConnector.write(path, updated);
            return ok(`Replaced 1 occurrence in ${path}`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return err(`Failed to edit ${path}: ${msg}`);
          }
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Search tools
// ---------------------------------------------------------------------------

function createGlobTool(qmain: Qmain): ExecutableTool {
  return {
    name: "Glob",
    description: "Find files matching a glob pattern (e.g. '**/*.ts'). Returns matching paths, one per line.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts'." },
        cwd: { type: "string", description: "Optional directory to search in (defaults to agent cwd)." },
      },
      required: ["pattern"],
    },
    resolveExecution: (args: unknown) => {
      const a = args as { pattern?: string; cwd?: string };
      const pattern = a?.pattern ?? "";
      return {
        approvalRule: "Glob",
        accesses: ToolAccesses.searchTree(pattern),
        execute: async (_ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
          try {
            const matches = await qmain.glob(pattern, { cwd: a?.cwd });
            if (matches.length === 0) {
              return ok(`(no files matched ${pattern})`);
            }
            return ok(truncate(matches.join("\n"), TOOL_OUTPUT_CAP));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return err(`Glob failed: ${msg}`);
          }
        },
      };
    },
  };
}

function createGrepTool(fileConnector: FileConnector): ExecutableTool {
  return {
    name: "Grep",
    description: "Search for a regex pattern across files. Returns matches in 'file:line:content' format.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for." },
        path: { type: "string", description: "File or directory to search in." },
        include: { type: "string", description: "Optional glob filter for file paths (e.g. '*.ts')." },
        ignoreCase: { type: "boolean", description: "Case-insensitive search." },
        maxMatches: { type: "number", description: "Maximum number of matches to return." },
        context: { type: "number", description: "Lines of context around each match." },
      },
      required: ["pattern", "path"],
    },
    resolveExecution: (args: unknown) => {
      const a = args as {
        pattern?: string;
        path?: string;
        include?: string;
        ignoreCase?: boolean;
        maxMatches?: number;
        context?: number;
      };
      const pattern = a?.pattern ?? "";
      const path = a?.path ?? "";
      return {
        approvalRule: "Grep",
        accesses: ToolAccesses.searchTree(path),
        execute: async (_ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
          try {
            // If `path` is a file, search just that file. Otherwise, glob-expand the include
            // pattern under the path and search the resulting files.
            let files: string[] = [];
            const stat = await fileConnector.stat(path).catch(() => null);
            if (stat?.isFile) {
              files = [path];
            } else {
              // Treat as a directory; use `path/**` (or the include pattern) as the glob
              const include = a?.include ?? "**/*";
              const globPattern = path.endsWith("/") ? `${path}${include}` : `${path}/${include}`;
              files = await fileConnector.glob(globPattern);
            }

            if (files.length === 0) {
              return ok(`(no files to search in ${path})`);
            }

            const matches = await fileConnector.grep(pattern, files, {
              ignoreCase: a?.ignoreCase,
              maxMatches: a?.maxMatches,
              context: a?.context,
            });

            if (matches.length === 0) {
              return ok(`(no matches for ${pattern} in ${path})`);
            }

            const lines = matches.map((m) => {
              const ctxBefore = m.beforeContext?.length
                ? m.beforeContext.map((l) => `  ${l}`).join("\n") + "\n"
                : "";
              const ctxAfter = m.afterContext?.length
                ? "\n" + m.afterContext.map((l) => `  ${l}`).join("\n")
                : "";
              return `${ctxBefore}${m.file}:${m.line}:${m.content}${ctxAfter}`;
            });

            return ok(truncate(lines.join("\n"), TOOL_OUTPUT_CAP));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return err(`Grep failed: ${msg}`);
          }
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Shell tool
// ---------------------------------------------------------------------------

function createBashTool(shellConnector: ShellConnector): ExecutableTool {
  return {
    name: "Bash",
    description:
      "Execute a shell command and return its combined stdout/stderr. " +
      "Use the `cwd` and `timeout` parameters to control execution. " +
      "Returns a non-zero exit code as an error result.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute." },
        cwd: { type: "string", description: "Optional working directory." },
        timeout: { type: "number", description: "Optional timeout in milliseconds." },
        env: { type: "object", description: "Optional additional environment variables.", additionalProperties: { type: "string" } },
      },
      required: ["command"],
    },
    resolveExecution: (args: unknown) => {
      const a = args as { command?: string; cwd?: string; timeout?: number; env?: Record<string, string> };
      const command = a?.command ?? "";
      return {
        approvalRule: "Bash",
        accesses: ToolAccesses.all(),
        execute: async (_ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
          try {
            const result = await shellConnector.exec(command, {
              cwd: a?.cwd,
              timeout: a?.timeout,
              env: a?.env,
            });
            const stdout = truncate(result.stdout ?? "", TOOL_OUTPUT_CAP);
            const stderr = truncate(result.stderr ?? "", TOOL_OUTPUT_CAP);
            let output = stdout;
            if (stderr) output += (output ? "\n\n" : "") + `[stderr]\n${stderr}`;
            if (result.exitCode !== 0) {
              return err(`Command exited with code ${result.exitCode}\n${output}`);
            }
            return ok(output || `(command succeeded, no output)`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return err(`Bash failed: ${msg}`);
          }
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Sub-agent / background tools
// ---------------------------------------------------------------------------

function createAgentTool(agent: Agent): ExecutableTool {
  return {
    name: "Agent",
    description:
      "Spawn a sub-agent for focused tasks. Pass a description and prompt to delegate work to a specialized agent.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "A short (3-5 word) description of the task" },
        prompt: { type: "string", description: "The task for the sub-agent to perform" },
        subagentType: { type: "string", description: "Optional profile name (explore, plan, coder, etc.)" },
      },
      required: ["description", "prompt"],
    },
    resolveExecution: (input: unknown) => {
      const args = input as { description?: string; prompt?: string; subagentType?: string };
      return {
        approvalRule: "Agent",
        accesses: ToolAccesses.all(),
        execute: async (ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
          const subagentHost = agent.subagentHost;
          if (!subagentHost.spawnSubagent) {
            return err(
              "Sub-agent spawning is not available in this context. " +
                "Use this tool from an orchestrator-driven session, or call tools directly.",
            );
          }
          try {
            const result = await subagentHost.spawnSubagent(args.prompt ?? "", {
              description: args.description,
              profileName: args.subagentType,
              signal: ctx.signal,
            });
            return ok(result.result ?? `Sub-agent completed (ID: ${result.id})`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return err(`Sub-agent failed: ${msg}`);
          }
        },
      };
    },
  };
}

function createTaskListTool(agent: Agent): ExecutableTool {
  return {
    name: "TaskList",
    description: "List all background tasks (running, completed, failed).",
    parameters: {
      type: "object",
      properties: {
        activeOnly: { type: "boolean", description: "If true, only return running tasks." },
      },
    },
    resolveExecution: () => ({
      approvalRule: "TaskList",
      accesses: ToolAccesses.none(),
      execute: async (_ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
        const tasks = agent.backgroundManager.list();
        if (tasks.length === 0) {
          return ok("(no background tasks)");
        }
        const lines = tasks.map(
          (t) =>
            `${t.taskId}  ${t.status.padEnd(10)}  ${t.description}  ` +
            `(started: ${new Date(t.startedAt).toISOString()})`,
        );
        return ok(lines.join("\n"));
      },
    }),
  };
}

function createTaskOutputTool(agent: Agent): ExecutableTool {
  return {
    name: "TaskOutput",
    description: "Get the captured output of a background task. Returns the most recent output lines.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID." },
        tail: { type: "number", description: "How many recent lines to return (default 100)." },
        block: { type: "boolean", description: "If true, wait for the task to finish before returning." },
      },
      required: ["taskId"],
    },
    resolveExecution: (args: unknown) => {
      const a = args as { taskId?: string; tail?: number; block?: boolean };
      const taskId = a?.taskId ?? "";
      return {
        approvalRule: "TaskOutput",
        accesses: ToolAccesses.none(),
        execute: async (ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
          if (a?.block) {
            // Wait for the task to finish; we re-use the existing tail-line API.
            // BackgroundManager doesn't expose a `wait(taskId)` yet; fall back to a short poll.
            const deadline = Date.now() + 60_000;
            while (Date.now() < deadline) {
              if (ctx.signal.aborted) return err("Aborted", { stopTurn: true });
              const t = agent.backgroundManager.list().find((x) => x.taskId === taskId);
              if (t && t.status !== "running") break;
              await new Promise((r) => setTimeout(r, 200));
            }
          }
          const result = await agent.backgroundManager.readOutput(taskId, a?.tail ?? 100);
          if (!result.preview) {
            const t = agent.backgroundManager.list().find((x) => x.taskId === taskId);
            if (!t) return err(`No such task: ${taskId}`);
            return ok(`Task ${taskId} (${t.status}) — no output captured yet.`);
          }
          return ok(result.preview);
        },
      };
    },
  };
}

function createTaskStopTool(agent: Agent, shellConnector: ShellConnector): ExecutableTool {
  return {
    name: "TaskStop",
    description: "Stop a running background task.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID." },
      },
      required: ["taskId"],
    },
    resolveExecution: (args: unknown) => {
      const a = args as { taskId?: string };
      const taskId = a?.taskId ?? "";
      return {
        approvalRule: "TaskStop",
        accesses: ToolAccesses.none(),
        execute: async (_ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
          const t = agent.backgroundManager.list().find((x) => x.taskId === taskId);
          if (!t) return err(`No such task: ${taskId}`);
          await agent.backgroundManager.stop(taskId);
          // Best-effort: ask the shell connector to kill anything it has for this id.
          try {
            // The shell connector doesn't index by taskId, so this is a no-op in the
            // current implementation. We still mark the task killed above.
            void shellConnector;
          } catch {
            // ignore
          }
          return ok(`Stopped task ${taskId}`);
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Web tools
// ---------------------------------------------------------------------------

function createWebSearchTool(webConnector: WebConnector): ExecutableTool {
  return {
    name: "WebSearch",
    description:
      "Search the web. Requires a configured search provider. " +
      "Returns a list of results with title, url, and snippet.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        limit: { type: "number", description: "Max results to return (default 10)." },
      },
      required: ["query"],
    },
    resolveExecution: (args: unknown) => {
      const a = args as { query?: string; limit?: number };
      const query = a?.query ?? "";
      return {
        approvalRule: "WebSearch",
        accesses: ToolAccesses.all(),
        execute: async (_ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
          try {
            const results = await webConnector.webSearch(query, { limit: a?.limit ?? 10 });
            if (results.length === 0) {
              return ok(`(no results for ${query})`);
            }
            const lines = results.map(
              (r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`,
            );
            return ok(truncate(lines.join("\n\n"), TOOL_OUTPUT_CAP));
          } catch (e) {
            if (e instanceof ConnectorNotAvailableError) {
              return err(
                "Web search is not configured. Set up a WebSearchProvider " +
                  "via WebConnector.setWebSearchProvider().",
              );
            }
            const msg = e instanceof Error ? e.message : String(e);
            return err(`WebSearch failed: ${msg}`);
          }
        },
      };
    },
  };
}

function createWebFetchTool(webConnector: WebConnector): ExecutableTool {
  return {
    name: "WebFetch",
    description: "Fetch the contents of a URL. Returns extracted text (HTML stripped).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch (http or https)." },
      },
      required: ["url"],
    },
    resolveExecution: (args: unknown) => {
      const a = args as { url?: string };
      const url = a?.url ?? "";
      return {
        approvalRule: "WebFetch",
        accesses: ToolAccesses.all(),
        execute: async (_ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
          try {
            const body = await webConnector.fetchUrl(url);
            return ok(truncate(body, WEB_FETCH_CAP));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return err(`WebFetch failed for ${url}: ${msg}`);
          }
        },
      };
    },
  };
}
