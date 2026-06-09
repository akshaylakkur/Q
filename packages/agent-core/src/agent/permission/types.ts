/**
 * Permission types.
 */

export type PermissionRuleDecision = "allow" | "deny" | "ask";

export type PermissionRuleScope = "session-runtime" | "project" | "user";

export type PermissionMode = "manual" | "yolo" | "auto";

export interface PermissionRule {
  readonly decision: PermissionRuleDecision;
  readonly scope: PermissionRuleScope;
  readonly pattern: string;
  readonly reason?: string;
}

export interface ApprovalResponse {
  decision: "approved" | "rejected" | "cancelled";
  scope?: "session";
  feedback?: string;
}

export interface PermissionApprovalResultRecord {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: ApprovalResponse;
}

export interface PermissionData {
  mode: PermissionMode;
  rules: PermissionRule[];
}

export type PermissionDecision = "approve" | "deny" | "ask";

export interface PermissionPolicyContext {
  readonly turnId: string;
  readonly toolCall: { id: string; name: string; args: Record<string, unknown> };
}

export type PermissionPolicyResult =
  | {
      readonly kind: "approve";
      readonly executionMetadata?: unknown;
    }
  | {
      readonly kind: "deny";
      readonly message?: string;
    }
  | {
      readonly kind: "ask";
    };
