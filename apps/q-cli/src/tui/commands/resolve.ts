/**
 * Resolve — Resolve the intent of a slash command input.
 *
 * Determines whether the input is:
 * - A builtin slash command (dispatched)
 * - A skill command (forwarded to skill system)
 * - A message (sent as normal user input)
 * - Blocked (cannot run while streaming)
 * - Invalid (unknown command)
 */

import { findSlashCommand, resolveSlashCommandAvailability } from "./registry.js";
import { parseSlashInput } from "./parse.js";
import type { SlashCommandBusyReason, SlashCommandInvalidReason } from "./types.js";
import type { AllSlashCommand, AllSlashCommandName } from "./registry.js";

export type SlashCommandIntent =
  | { readonly kind: "not-command" }
  | {
      readonly kind: "builtin";
      readonly command: AllSlashCommand;
      readonly name: AllSlashCommandName;
      readonly args: string;
    }
  | {
      readonly kind: "skill";
      readonly commandName: string;
      readonly skillName: string;
      readonly args: string;
    }
  | { readonly kind: "message"; readonly input: string }
  | {
      readonly kind: "blocked";
      readonly commandName: string;
      readonly reason: SlashCommandBusyReason;
    }
  | {
      readonly kind: "invalid";
      readonly commandName: string;
      readonly reason: SlashCommandInvalidReason;
    };

export interface ResolveSlashCommandOptions {
  readonly input: string;
  readonly skillCommandMap: ReadonlyMap<string, string>;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
}

/**
 * Resolve the intent of a user input.
 */
export function resolveSlashCommandInput(
  options: ResolveSlashCommandOptions,
): SlashCommandIntent {
  const parsed = parseSlashInput(options.input);
  if (parsed === null) return { kind: "not-command" };

  const command = findSlashCommand(parsed.name);
  if (command !== undefined) {
    const busyReason = slashCommandBusyReason(options);
    if (
      busyReason !== undefined &&
      resolveSlashCommandAvailability(command, parsed.args) === "idle-only"
    ) {
      return {
        kind: "blocked",
        commandName: parsed.name,
        reason: busyReason,
      };
    }
    return {
      kind: "builtin",
      command,
      name: command.name as AllSlashCommandName,
      args: parsed.args,
    };
  }

  // Check if it's a skill command
  const skillName = resolveSkillCommand(options.skillCommandMap, parsed.name);
  if (skillName !== undefined) {
    const busyReason = slashCommandBusyReason(options);
    if (busyReason !== undefined) {
      return {
        kind: "blocked",
        commandName: parsed.name,
        reason: busyReason,
      };
    }
    return {
      kind: "skill",
      commandName: parsed.name,
      skillName,
      args: parsed.args.trim(),
    };
  }

  // Fall through — treat as a normal message (or invalid)
  return {
    kind: "message",
    input: options.input,
  };
}

/**
 * Check if the input matches a skill command name.
 */
export function resolveSkillCommand(
  skillCommandMap: ReadonlyMap<string, string>,
  commandName: string,
): string | undefined {
  return skillCommandMap.get(commandName) ?? skillCommandMap.get(`skill:${commandName}`);
}

/**
 * Determine if a command is blocked because the agent is busy.
 */
export function slashCommandBusyReason(
  options: Pick<ResolveSlashCommandOptions, "isStreaming" | "isCompacting">,
): SlashCommandBusyReason | undefined {
  if (options.isStreaming) return "streaming";
  if (options.isCompacting) return "compacting";
  return undefined;
}

/**
 * Human-readable block reason message.
 */
export function slashBusyMessage(
  commandName: string,
  reason: SlashCommandBusyReason,
): string {
  if (reason === "streaming") {
    return `Cannot /${commandName} while streaming — press Ctrl+C first.`;
  }
  return `Cannot /${commandName} while compacting — wait for compaction to finish first.`;
}