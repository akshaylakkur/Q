/**
 * PluginValidator — validates plugin manifests and dependency graphs.
 *
 * Responsible for:
 * - Validating manifest JSON against the Zod PluginManifestSchema
 * - Checking dependency resolution (all deps present in plugin set or user-global)
 * - Detecting name conflicts between plugins (tool name collisions → first wins)
 * - Verifying entryPoint files exist on disk
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PluginManifestSchema, type PluginManifest } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  manifest?: PluginManifest;
  errors: string[];
}

export class PluginValidator {
  /**
   * Validate a single plugin manifest file.
   * Returns the parsed manifest on success, or error messages on failure.
   */
  validateManifest(
    manifestData: unknown,
    pluginDir: string,
    allManifests: Map<string, PluginManifest>,
  ): ValidationResult {
    const errors: string[] = [];

    // 1. Zod schema validation
    const parsed = PluginManifestSchema.safeParse(manifestData);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push(`${issue.path.join(".")}: ${issue.message}`);
      }
      return { valid: false, errors };
    }

    const manifest = parsed.data;

    // 2. Verify entryPoint exists
    const entryPath = resolve(pluginDir, manifest.entryPoint);
    if (!existsSync(entryPath)) {
      errors.push(`Entry point not found: ${manifest.entryPoint} (resolved: ${entryPath})`);
    }

    // 3. Verify dependencies are met
    for (const dep of manifest.dependencies) {
      if (!allManifests.has(dep)) {
        errors.push(`Dependency not found: '${dep}' (required by '${manifest.name}')`);
      }
    }

    // 4. Verify skill globs resolve (at least check directory exists)
    for (const skillGlob of manifest.skills) {
      // We just check that the glob doesn't point outside the plugin dir
      // Full glob resolution happens at activation time
      if (skillGlob.startsWith("..")) {
        errors.push(`Skill glob '${skillGlob}' points outside the plugin directory`);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true, manifest, errors: [] };
  }

  /**
   * Detect tool name conflicts across a set of discovered manifests.
   * Returns warnings for duplicate tool names (first plugin's tool wins).
   */
  detectToolNameConflicts(
    manifests: PluginManifest[],
  ): { toolName: string; owner: string; conflict: string }[] {
    const conflicts: { toolName: string; owner: string; conflict: string }[] = [];
    const seen = new Map<string, string>(); // toolName -> owning plugin

    for (const manifest of manifests) {
      for (const tool of manifest.tools) {
        if (seen.has(tool.name)) {
          conflicts.push({
            toolName: tool.name,
            owner: seen.get(tool.name)!,
            conflict: manifest.name,
          });
        } else {
          seen.set(tool.name, manifest.name);
        }
      }
    }

    return conflicts;
  }

  /**
   * Check for dependency cycles in the plugin set.
   * Returns the cycle path if found, or null if no cycles.
   */
  detectCycle(
    plugins: Map<string, PluginManifest>,
  ): string[] | null {
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const path: string[] = [];

    function dfs(name: string): string[] | null {
      if (inStack.has(name)) {
        // Found cycle — return from the start of the cycle
        const cycleStart = path.indexOf(name);
        return [...path.slice(cycleStart), name];
      }
      if (visited.has(name)) return null;

      visited.add(name);
      inStack.add(name);
      path.push(name);

      const manifest = plugins.get(name);
      if (manifest) {
        for (const dep of manifest.dependencies) {
          const cycle = dfs(dep);
          if (cycle) return cycle;
        }
      }

      path.pop();
      inStack.delete(name);
      return null;
    }

    for (const name of plugins.keys()) {
      const cycle = dfs(name);
      if (cycle) return cycle;
    }

    return null;
  }

  /**
   * Topological sort of plugin dependency graph.
   * Returns ordered array of plugin names, or throws if cycle detected.
   */
  topologicalSort(plugins: Map<string, PluginManifest>): string[] {
    const visited = new Set<string>();
    const sorted: string[] = [];

    function visit(name: string, stack: Set<string>): void {
      if (stack.has(name)) {
        throw new Error(
          `Dependency cycle detected: ${Array.from(stack).join(" → ")} → ${name}`,
        );
      }
      if (visited.has(name)) return;

      const manifest = plugins.get(name);
      if (!manifest) return;

      stack.add(name);
      for (const dep of manifest.dependencies) {
        if (plugins.has(dep)) {
          visit(dep, stack);
        }
      }
      stack.delete(name);

      visited.add(name);
      sorted.push(name);
    }

    for (const name of plugins.keys()) {
      if (!visited.has(name)) {
        visit(name, new Set());
      }
    }

    return sorted;
  }
}