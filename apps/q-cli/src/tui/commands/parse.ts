/**
 * Parse — Parse "/command args" from user input.
 */

import type { ParsedSlashInput } from "./types.js";

/**
 * Parse a text input that starts with "/".
 * Returns null if it's not a valid slash command.
 */
export function parseSlashInput(input: string): ParsedSlashInput | null {
  if (!input.startsWith("/")) return null;
  const trimmed = input.slice(1).trim();
  if (trimmed.length === 0) return null;
  const spaceIdx = trimmed.indexOf(" ");
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  // Disallow nested slashes in the command name
  if (name.includes("/")) return null;
  return { name, args };
}