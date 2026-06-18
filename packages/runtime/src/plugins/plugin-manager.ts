/**
 * PluginManager — Central runtime singleton for the plugin system.
 *
 * Responsibilities:
 * - Discover plugin manifests from user-global (~/.Q/plugins/) and project-local
 *   (.q/plugins/) directories with dedup (project-local wins).
 * - Validate manifests via PluginValidator.
 * - Activate plugins: import entryPoint module, register skills/tools/MCP servers,
 *   subscribe lifecycle hooks.
 * - Deactivate plugins: unsubscribe hooks, deregister tools, disconnect MCP servers.
 * - ActivateAll: discover + topological-sort + activate.
 */

import { readdirSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, glob } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, basename, extname } from "node:path";
import { pathToFileURL } from "node:url";

import type { ToolManager } from "@q/agent-core";
import type { McpConnectionManager } from "../mcp/manager.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { SkillDefinition } from "../skills/types.js";
import { PluginValidator } from "./validator.js";
import { PluginHookEngine } from "./lifecycle.js";
import type {
  PluginManifest,
  PluginInstance,
  PluginStatus,
  PluginContext,
} from "./types.js";

const USER_PLUGIN_DIR = () => resolve(homedir(), ".Q", "plugins");
const PROJECT_PLUGIN_DIR = ".v" + "/plugins";

export class PluginManager {
  /** All discovered plugin instances, keyed by plugin name. */
  private readonly plugins = new Map<string, PluginInstance>();

  /** The hook engine for lifecycle events. */
  readonly hookEngine: PluginHookEngine;

  /** The manifest validator. */
  private readonly validator: PluginValidator;

  /** External subsystem references. */
  private readonly skillRegistry: SkillRegistry;
  private readonly mcpManager: McpConnectionManager;
  private readonly toolManager: ToolManager;

  /** Logger for warnings and errors. */
  private readonly logger: Console;

  /** Read-only config snapshot for plugins. */
  private readonly config: Record<string, unknown>;

  /** Work directory (for resolving project-local plugin dir). */
  private readonly workDir: string;

  constructor(
    skillRegistry: SkillRegistry,
    mcpManager: McpConnectionManager,
    toolManager: ToolManager,
    config: Record<string, unknown> = {},
    workDir?: string,
    logger?: Console,
  ) {
    this.hookEngine = new PluginHookEngine();
    this.validator = new PluginValidator();
    this.skillRegistry = skillRegistry;
    this.mcpManager = mcpManager;
    this.toolManager = toolManager;
    this.config = config;
    this.workDir = workDir ?? process.cwd();
    this.logger = logger ?? console;
  }

  // =======================================================================
  // Discovery
  // =======================================================================

  /**
   * Scan plugin directories and return discovered manifests.
   * Dedups: project-local plugins override user-global plugins with the same name.
   * Excludes: node_modules/, dotfiles, dotdirs. Max scan depth: 2.
   */
  async discover(): Promise<PluginManifest[]> {
    const allManifests = new Map<string, PluginManifest>();

    // Scan user-global directory first (lower priority)
    const userDir = USER_PLUGIN_DIR();
    if (existsSync(userDir)) {
      const userPlugins = this.scanDirectory(userDir, "user");
      for (const [name, manifest] of userPlugins) {
        allManifests.set(name, manifest);
      }
    }

    // Scan project-local directory second (higher priority — overrides)
    const projectDir = resolve(this.workDir, PROJECT_PLUGIN_DIR);
    if (existsSync(projectDir)) {
      const projectPlugins = this.scanDirectory(projectDir, "project");
      for (const [name, manifest] of projectPlugins) {
        if (allManifests.has(name)) {
          this.logger.info(
            `[Plugins] Project plugin '${name}' overriding user-global plugin`,
          );
        }
        allManifests.set(name, manifest);
      }
    }

    // Validate dependencies across the full set
    const manifests = Array.from(allManifests.values());
    for (const manifest of manifests) {
      for (const dep of manifest.dependencies) {
        if (!allManifests.has(dep)) {
          this.logger.warn(
            `[Plugins] Plugin '${manifest.name}' depends on missing plugin '${dep}'`,
          );
        }
      }
    }

    // Detect tool name conflicts
    const conflicts = this.validator.detectToolNameConflicts(manifests);
    for (const c of conflicts) {
      this.logger.warn(
        `[Plugins] Tool '${c.toolName}' registered by both '${c.owner}' and '${c.conflict}'. '${c.owner}' wins.`,
      );
    }

    // Create PluginInstance entries for all discovered manifests
    for (const manifest of manifests) {
      if (!this.plugins.has(manifest.name)) {
        const pluginDir = this.resolvePluginDir(manifest.name);
        if (pluginDir) {
          this.plugins.set(manifest.name, {
            manifest,
            pluginDir,
            status: "inactive",
            toolCount: 0,
            skillCount: 0,
            mcpServerCount: 0,
            mcpServerNames: [],
          });
        }
      }
    }

    return manifests;
  }

  /**
   * Scan a single plugin root directory and return discovered manifests.
   * Max depth: root → plugin dir → manifest.
   */
  private scanDirectory(
    root: string,
    _source: "user" | "project",
  ): Map<string, PluginManifest> {
    const result = new Map<string, PluginManifest>();
    let entries;

    try {
      entries = readdirSync(root);
    } catch {
      return result;
    }

    for (const entry of entries) {
      // Skip excluded entries
      if (entry === "node_modules" || entry.startsWith(".")) continue;

      const pluginDir = resolve(root, entry);
      const manifestPath = resolve(pluginDir, "v.plugin.json");

      if (!existsSync(manifestPath)) continue;

      try {
        const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const validation = this.validator.validateManifest(
          raw,
          pluginDir,
          result,
        );

        if (!validation.valid || !validation.manifest) {
          for (const err of validation.errors) {
            this.logger.warn(`[Plugins] Plugin '${entry}' validation error: ${err}`);
          }
          continue;
        }

        const manifest = validation.manifest;

        // Check for duplicate name within this scan
        if (result.has(manifest.name)) {
          this.logger.warn(
            `[Plugins] Duplicate plugin name '${manifest.name}' in ${root}; keeping first`,
          );
          continue;
        }

        result.set(manifest.name, manifest);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[Plugins] Failed to load plugin '${entry}': ${msg}`);
      }
    }

    return result;
  }

  // =======================================================================
  // Activation / Deactivation
  // =======================================================================

  /**
   * Activate a single plugin by name.
   * Dynamically imports the entryPoint module, calls activate(context) if exported,
   * registers skills/tools/MCP servers, subscribes hooks.
   */
  async activate(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin '${pluginId}' not found. Run discover() first.`);
    }
    if (plugin.status === "active") return;

    const manifest = plugin.manifest;

    try {
      // 1. Dynamically import the entryPoint module
      const entryPath = resolve(plugin.pluginDir, manifest.entryPoint);
      const moduleUrl = pathToFileURL(entryPath).href;
      let mod: Record<string, unknown> = {};
      try {
        mod = await import(moduleUrl);
      } catch {
        // If it's a JSON file (MCP config), parse it as module data
        if (extname(manifest.entryPoint).toLowerCase() === ".json") {
          mod = { mcpConfig: JSON.parse(readFileSync(entryPath, "utf-8")) };
        } else {
          throw new Error(`Failed to import module: ${entryPath}`);
        }
      }
      plugin.module = mod;

      // 2. Build PluginContext
      const context: PluginContext = {
        skillRegistry: this.skillRegistry,
        mcpManager: this.mcpManager,
        toolManager: this.toolManager,
        hookEngine: this.hookEngine,
        logger: this.logger,
        config: this.config,
      };

      // 3. Call module.activate() if it exists
      if (typeof mod.activate === "function") {
        await (mod.activate as (ctx: PluginContext) => void | Promise<void>)(context);
      }

      // 4. Register skills (glob patterns resolved relative to plugin dir)
      let skillCount = 0;
      for (const skillGlob of manifest.skills) {
        const fullPattern = resolve(plugin.pluginDir, skillGlob);
        try {
          const matches: string[] = [];
          for await (const entry of glob(fullPattern, { cwd: plugin.pluginDir })) {
            matches.push(entry);
          }
          for (const skillPath of matches) {
            const skillName = basename(skillPath, extname(skillPath));
            const content = readFileSync(skillPath, "utf-8");
            this.skillRegistry.register({
              name: skillName,
              description: `Plugin skill: ${skillName} (from ${manifest.name})`,
              path: skillPath,
              dir: plugin.pluginDir,
              content,
              metadata: { name: skillName },
              source: "plugin",
            } satisfies SkillDefinition);
            skillCount++;
          }
        } catch {
          this.logger.warn(
            `[Plugins] Failed to resolve skill glob '${skillGlob}' for '${manifest.name}'`,
          );
        }
      }
      plugin.skillCount = skillCount;

      // 5. Register MCP servers
      const mcpServerNames: string[] = [];
      let mcpServerCount = 0;
      for (const mcpServer of manifest.mcpServers) {
        const serverName = `${manifest.name}__${mcpServerCount}`;
        try {
          await this.mcpManager.connectAll({
            [serverName]: mcpServer as any,
          });
          mcpServerNames.push(serverName);
          mcpServerCount++;
        } catch (err) {
          this.logger.warn(
            `[Plugins] Failed to connect MCP server for '${manifest.name}': ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      plugin.mcpServerNames = mcpServerNames;
      plugin.mcpServerCount = mcpServerCount;

      // 6. Register tools
      let toolCount = 0;
      for (const toolDef of manifest.tools) {
        try {
          this.toolManager.registerUserTool({
            name: `${manifest.name}__${toolDef.name}`,
            description: `[${manifest.name}] ${toolDef.description}`,
            parameters: toolDef.inputSchema as Record<string, unknown>,
          });
          toolCount++;
        } catch (err) {
          this.logger.warn(
            `[Plugins] Failed to register tool '${toolDef.name}' for '${manifest.name}': ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      plugin.toolCount = toolCount;

      // 7. Subscribe lifecycle hooks from module exports and manifest declarations.
      // The module may export a `hooks` object mapping event names to handler functions,
      // e.g. { 'session:start': (ctx) => { ... }, 'tool:preUse': (ctx) => ({ block: true }) }.
      // We always track manifest-declared events for cleanup, even if no handler is found.
      for (const hookEvent of manifest.hooks) {
        this.hookEngine.declareSubscription(hookEvent as any, pluginId);
      }
      // Then look for handler functions in the module's `hooks` export.
      if (mod.hooks && typeof mod.hooks === "object") {
        const modHookMap = mod.hooks as Record<string, unknown>;
        for (const hookEvent of manifest.hooks) {
          const handler = modHookMap[hookEvent];
          if (typeof handler === "function") {
            this.hookEngine.on(hookEvent as any, pluginId, handler as any);
          }
        }
      }

      plugin.status = "active";
      this.logger.info(
        `[Plugins] Activated '${manifest.name}' v${manifest.version} ` +
        `(${toolCount} tools, ${skillCount} skills, ${mcpServerCount} MCP servers)`,
      );
    } catch (err) {
      plugin.status = "error";
      plugin.error = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[Plugins] Failed to activate '${manifest.name}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Deactivate a plugin.
   * Unsubscribes hooks, unregisters tools, calls module.deactivate() if it exists.
   */
  async deactivate(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin '${pluginId}' not found.`);
    }
    if (plugin.status === "inactive") return;

    try {
      const mod = plugin.module;

      // 1. Unsubscribe all hooks registered by this plugin
      this.hookEngine.removeAllForPlugin(pluginId);

      // 2. Unregister tools
      for (const toolDef of plugin.manifest.tools) {
        try {
          this.toolManager.unregisterUserTool(`${pluginId}__${toolDef.name}`);
        } catch {
          // Tool might not exist — ignore
        }
      }
      plugin.toolCount = 0;

      // 3. Call module.deactivate() if it exists
      if (mod && typeof mod.deactivate === "function") {
        await (mod.deactivate as () => void | Promise<void>)();
      }

      // 4. Clean up MCP connection state
      // Note: McpConnectionManager does not expose a per-server remove()
      // API. Server entries are cleaned up on next connectAll() or on
      // full shutdown(). We clear our tracking and log.
      if (plugin.mcpServerNames.length > 0) {
        this.logger.info(
          `[Plugins] MCP servers from '${pluginId}' were left registered in McpConnectionManager ` +
          `(no per-server cleanup API available). Use 'q-cli config reload' to refresh.`,
        );
      }
      plugin.mcpServerNames = [];
      plugin.mcpServerCount = 0;
      plugin.skillCount = 0;

      plugin.status = "inactive";
      plugin.module = undefined;

      this.logger.info(`[Plugins] Deactivated '${pluginId}'`);
    } catch (err) {
      plugin.status = "error";
      plugin.error = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[Plugins] Failed to deactivate '${pluginId}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Discover all plugins and activate them in dependency order.
   * Plugin activation failures are non-fatal (logged and continue).
   */
  async activateAll(): Promise<void> {
    await this.discover();

    // Build lookup map for topological sort
    const manifestMap = new Map<string, PluginManifest>();
    for (const p of this.plugins.values()) {
      manifestMap.set(p.manifest.name, p.manifest);
    }

    // Check for cycles — remove cyclic plugins and continue with the rest
    const cycle = this.validator.detectCycle(manifestMap);
    if (cycle) {
      this.logger.error(
        `[Plugins] Dependency cycle detected: ${cycle.join(" → ")}. Removing cyclic plugins.`,
      );
      const toRemove = new Set(cycle);
      // Also remove plugins whose dependencies are in the cycle
      for (const [name, manifest] of manifestMap) {
        for (const dep of manifest.dependencies) {
          if (toRemove.has(dep)) {
            toRemove.add(name);
            break;
          }
        }
      }
      for (const name of toRemove) {
        this.plugins.delete(name);
        manifestMap.delete(name);
      }
    }

    // Topological sort on remaining (acyclic) plugins
    // If cycle removal left dangling deps, remove those plugins too
    let order: string[] = [];
    try {
      order = this.validator.topologicalSort(manifestMap);
    } catch (err) {
      this.logger.error(
        `[Plugins] Failed to sort dependencies: ${err instanceof Error ? err.message : String(err)}. Activating without ordering.`,
      );
      order = Array.from(this.plugins.keys());
    }

    // Activate in order
    for (const name of order) {
      try {
        await this.activate(name);
      } catch (err) {
        // Non-fatal: log and continue
        this.logger.warn(
          `[Plugins] Failed to activate '${name}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Deactivate all plugins.
   */
  async deactivateAll(): Promise<void> {
    const names = Array.from(this.plugins.keys());
    for (const name of names) {
      try {
        await this.deactivate(name);
      } catch {
        // Non-fatal
      }
    }
  }

  // =======================================================================
  // Queries
  // =======================================================================

  /**
   * Get a plugin instance by name.
   */
  getPlugin(id: string): PluginInstance | undefined {
    return this.plugins.get(id);
  }

  /**
   * Get all discovered plugin instances.
   */
  listPlugins(): PluginManifest[] {
    return Array.from(this.plugins.values()).map((p) => p.manifest);
  }

  /**
   * Get full status listings for all plugins.
   */
  getStatus(): PluginStatus[] {
    return Array.from(this.plugins.values()).map((p) => ({
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      type: p.manifest.type,
      status: p.status,
      toolCount: p.toolCount,
      skillCount: p.skillCount,
      mcpServerCount: p.mcpServerCount,
    }));
  }

  // =======================================================================
  // Plugin management (install / remove)
  // =======================================================================

  /**
   * Install a plugin from a tarball URL or local directory path.
   * Extracts/copies to $HOME/.Q/plugins/<name>/, validates the manifest,
   * and activates the plugin.
   */
  async install(source: string): Promise<PluginManifest> {
    const urlOrDir = source;

    // Ensure user plugin dir exists
    if (!existsSync(USER_PLUGIN_DIR())) {
      mkdirSync(USER_PLUGIN_DIR(), { recursive: true });
    }

    let pluginDir: string;
    let manifestData: unknown;

    if (existsSync(urlOrDir)) {
      // Local directory — copy into user plugins
      const name = basename(urlOrDir);
      pluginDir = resolve(USER_PLUGIN_DIR(), name);

      // Remove existing if present
      if (existsSync(pluginDir)) {
        await fsRmRf(pluginDir);
      }
      await cp(urlOrDir, pluginDir, { recursive: true });

      // Read manifest
      const manifestPath = resolve(pluginDir, "v.plugin.json");
      if (!existsSync(manifestPath)) {
        throw new Error(`No v.plugin.json found in '${urlOrDir}'`);
      }
      manifestData = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } else {
      // Remote tarball URL
      const tmpDir = resolve(USER_PLUGIN_DIR(), ".tmp-install");
      if (existsSync(tmpDir)) {
        await fsRmRf(tmpDir);
      }
      mkdirSync(tmpDir, { recursive: true });

      try {
        // Download tarball
        const response = await fetch(urlOrDir);
        if (!response.ok) {
          throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const tarPath = resolve(tmpDir, "plugin.tar.gz");
        writeFileSync(tarPath, buffer);
        // Extract (simple extraction — assumes root dir is the plugin dir)
        const { execSync } = await import("child_process");
        execSync(`tar -xzf "${tarPath}" -C "${tmpDir}"`, { stdio: "pipe" });

        // Find the plugin directory (first non-dotfile subdirectory)
        const extracted = readdirSync(tmpDir).filter(
          (e) => !e.startsWith(".") && e !== "plugin.tar.gz",
        );
        if (extracted.length === 0) {
          throw new Error("No plugin directory found in tarball");
        }

        const extractedDir = resolve(tmpDir, extracted[0]!);
        const name = extracted[0]!;
        pluginDir = resolve(USER_PLUGIN_DIR(), name);

        // Move to user plugins
        if (existsSync(pluginDir)) {
          await fsRmRf(pluginDir);
        }
        await cp(extractedDir, pluginDir, { recursive: true });
      } finally {
        // Clean up temp
        if (existsSync(tmpDir)) {
          await fsRmRf(tmpDir);
        }
      }

      const manifestPath = resolve(pluginDir, "v.plugin.json");
      if (!existsSync(manifestPath)) {
        throw new Error(`No v.plugin.json found in downloaded plugin`);
      }
      manifestData = JSON.parse(readFileSync(manifestPath, "utf-8"));
    }

    // Validate the manifest
    const allManifests = new Map<string, PluginManifest>();
    const validation = this.validator.validateManifest(manifestData, pluginDir, allManifests);
    if (!validation.valid || !validation.manifest) {
      // Clean up on failure
      if (existsSync(pluginDir)) {
        await fsRmRf(pluginDir);
      }
      throw new Error(`Plugin manifest validation failed: ${validation.errors.join("; ")}`);
    }

    // Register and activate
    const manifest = validation.manifest;
    const instance: PluginInstance = {
      manifest,
      pluginDir,
      status: "inactive",
      toolCount: 0,
      skillCount: 0,
      mcpServerCount: 0,
      mcpServerNames: [],
    };
    this.plugins.set(manifest.name, instance);

    await this.activate(manifest.name);
    return manifest;
  }

  /**
   * Remove a plugin by name.
   */
  async remove(pluginId: string): Promise<void> {
    await this.deactivate(pluginId);
    this.plugins.delete(pluginId);

    // Remove from user-global plugin directory if present
    const pluginDir = resolve(USER_PLUGIN_DIR(), pluginId);
    if (existsSync(pluginDir)) {
      await fsRmRf(pluginDir);
    }

    // Also remove from project-local if present
    const projectDir = resolve(this.workDir, PROJECT_PLUGIN_DIR, pluginId);
    if (existsSync(projectDir)) {
      await fsRmRf(projectDir);
    }

    this.logger.info(`[Plugins] Removed '${pluginId}'`);
  }

  // =======================================================================
  // Helpers
  // =======================================================================

  /**
   * Resolve which directory a plugin came from.
   * Checks project-local first, then user-global.
   */
  private resolvePluginDir(name: string): string | null {
    const projectDir = resolve(this.workDir, PROJECT_PLUGIN_DIR, name);
    if (existsSync(projectDir)) return projectDir;

    const userDir = resolve(USER_PLUGIN_DIR(), name);
    if (existsSync(userDir)) return userDir;

    return null;
  }
}

// =======================================================================
// Utility — recursive rm -rf
// =======================================================================

/**
 * Recursively remove a directory or file. Uses node:fs/promises.rm
 * (available in Node 14.14+).
 */
async function fsRmRf(target: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(target, { recursive: true, force: true });
}

