/**
 * MCP server configuration loader.
 *
 * Loads MCP server declarations from a two-layer merge:
 * 1. User-global: $HOME/.Q/mcp.json
 * 2. Project-local: .q/mcp.json (relative to cwd)
 *
 * Project-local entries override user-global entries with the same key,
 * so a repo can specialise or replace a shared definition.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'pathe';
import { z } from 'zod/v4';

import { McpServerConfigSchema, type McpServerConfig } from '../config/schema';

const McpJsonFileSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
});

export interface McpJsonPaths {
  readonly user: string;
  readonly project: string;
}

export interface ResolveMcpJsonPathsInput {
  readonly cwd: string;
  readonly homeDir?: string;
}

export function resolveMcpJsonPaths(input: ResolveMcpJsonPathsInput): McpJsonPaths {
  const home = input.homeDir ?? homedir();
  return {
    user: join(home, '.Q', 'mcp.json'),
    project: join(input.cwd, '.v', 'mcp.json'),
  };
}

export interface LoadMcpServersInput {
  readonly cwd: string;
  readonly homeDir?: string;
}

/**
 * Load MCP server declarations from the user-global `~/.Q/mcp.json`
 * and the project-local `.q/mcp.json`. Entries in the project file
 * override user-global entries with the same key.
 *
 * Note: project-local entries may spawn stdio commands at session start, so
 * opening a session inside an untrusted checkout will execute whatever its
 * `mcp.json` declares. Only enable this in repos you trust.
 */
export async function loadMcpServers(
  input: LoadMcpServersInput,
): Promise<Record<string, McpServerConfig>> {
  const paths = resolveMcpJsonPaths({ cwd: input.cwd, homeDir: input.homeDir });
  const [user, project] = await Promise.all([readMcpJson(paths.user), readMcpJson(paths.project)]);
  return { ...user, ...project };
}

async function readMcpJson(filePath: string): Promise<Record<string, McpServerConfig>> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf-8');
  } catch (error: unknown) {
    if (isFileNotFound(error)) return {};
    throw new Error(`Failed to read MCP config at ${filePath}: ${describeError(error)}`);
  }

  if (text.trim().length === 0) return {};

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error(`Invalid JSON in MCP config at ${filePath}: ${describeError(error)}`);
  }

  try {
    return McpJsonFileSchema.parse(data).mcpServers;
  } catch (error: unknown) {
    throw new Error(`Invalid MCP server config in ${filePath}: ${describeError(error)}`);
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
