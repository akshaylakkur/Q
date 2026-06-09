/**
 * Context types — Prompt origins and context message definitions.
 */

export interface UserPromptOrigin {
  readonly kind: "user";
  readonly blockedByHook?: string | undefined;
}

export const USER_PROMPT_ORIGIN: UserPromptOrigin = { kind: "user" };

export interface SkillActivationOrigin {
  readonly kind: "skill_activation";
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string | undefined;
  readonly trigger: "user-slash" | "model-tool" | "nested-skill";
}

export interface InjectionOrigin {
  readonly kind: "injection";
  readonly variant: string;
}

export interface CompactionSummaryOrigin {
  readonly kind: "compaction_summary";
}

export interface SystemTriggerOrigin {
  readonly kind: "system_trigger";
  readonly name: string;
}

export interface BackgroundTaskOrigin {
  readonly kind: "background_task";
  readonly taskId: string;
  readonly status: string;
  readonly notificationId: string;
}

export interface HookResultOrigin {
  readonly kind: "hook_result";
  readonly event: string;
  readonly blocked?: boolean;
}

export type PromptOrigin =
  | UserPromptOrigin
  | SkillActivationOrigin
  | InjectionOrigin
  | CompactionSummaryOrigin
  | SystemTriggerOrigin
  | BackgroundTaskOrigin
  | HookResultOrigin;

export interface ContextMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  /** Tool calls made by the assistant (for assistant-role messages). */
  toolCalls?: ReadonlyArray<{
    readonly id: string;
    readonly type?: string;
    readonly function: {
      readonly name: string;
      readonly arguments: string;
    };
  }>;
  readonly origin?: PromptOrigin | undefined;
  readonly isError?: boolean;
}

export interface AgentContextData {
  history: readonly ContextMessage[];
  tokenCount: number;
}
