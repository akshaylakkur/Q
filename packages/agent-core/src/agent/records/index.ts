/**
 * AgentRecords — Central record-and-replay system.
 *
 * Wires all state mutations through recorded events for persistence
 * and later replay/restore.
 */

import type { Agent } from "../agent.js";
import { type AgentRecord, type AgentRecordPersistence } from "./types.js";
import { InMemoryAgentRecordPersistence } from "./persistence.js";

export * from "./types.js";
export { InMemoryAgentRecordPersistence, FileSystemAgentRecordPersistence } from "./persistence.js";
export { BlobStore, isBlobRef } from "./blobref.js";
export type { BlobStoreOptions } from "./blobref.js";

const AGENT_WIRE_PROTOCOL_VERSION = "1.0";

export class AgentRecords {
  private _restoring = false;
  private metadataInitialized = false;

  constructor(
    private readonly agent: Agent,
    private readonly persistence: AgentRecordPersistence = new InMemoryAgentRecordPersistence(),
  ) {}

  get restoring(): boolean {
    return this._restoring;
  }

  logRecord(record: AgentRecord): void {
    if (this._restoring) return;
    const stamped: AgentRecord =
      "time" in record && record.time !== undefined
        ? record
        : { ...record, time: Date.now() };
    if (!this.metadataInitialized && stamped.type !== "metadata") {
      this.persistence.append({
        type: "metadata",
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: Date.now(),
        time: Date.now(),
      });
      this.metadataInitialized = true;
    }
    if (stamped.type === "metadata") {
      this.metadataInitialized = true;
    }
    this.persistence.append(stamped);
  }

  restore(record: AgentRecord): void {
    this._restoring = true;
    try {
      restoreAgentRecord(this.agent, record);
    } finally {
      this._restoring = false;
    }
  }

  async replay(): Promise<{ warning?: string }> {
    let hasMetadata = false;
    for await (const record of this.persistence.read()) {
      if (!hasMetadata) {
        if (record.type !== "metadata") {
          throw new Error("AgentRecords replay expected metadata as the first record");
        }
        hasMetadata = true;
        this.metadataInitialized = true;
      }
      this.restore(record);
    }
    return {};
  }

  async flush(): Promise<void> {
    await this.persistence.flush();
  }
}

function restoreAgentRecord(agent: Agent, input: AgentRecord): void {
  switch (input.type) {
    case "metadata":
      return;
    case "turn.prompt": {
      // Reconstruct user message in context from the recorded prompt
      const prompt = Array.isArray(input.input) ? input.input.join("\n") : String(input.input);
      agent.context.appendUserMessage(prompt);
      return;
    }
    case "turn.steer":
      return;
    case "turn.cancel":
      return;
    case "background.stop":
      return;
    case "config.update":
      agent.config.update(input as Record<string, string>);
      return;
    case "permission.set_mode":
      agent.permission.setMode(input.mode as "manual" | "yolo" | "auto");
      return;
    case "permission.record_approval_result":
      return;
    case "usage.record":
      agent.usage.record(input.model, input.usage, "session");
      return;
    case "plan_mode.enter":
      agent.planMode.restoreEnter(input);
      return;
    case "plan_mode.cancel":
      agent.planMode.cancel(input.id);
      return;
    case "plan_mode.exit":
      agent.planMode.exit(input.id);
      return;
    case "context.append_message": {
      // Reconstruct a context message from the recorded event
      const msg = (input as any).message as Record<string, unknown> | undefined;
      if (msg && typeof msg === "object") {
        const content = typeof msg.content === "string" ? msg.content : String(msg.content ?? "");
        agent.context.appendMessage({
          role: (msg.role as "user" | "assistant" | "tool" | "system") ?? "user",
          content,
          ...(msg.toolCallId ? { toolCallId: msg.toolCallId as string } : {}),
          ...(msg.isError !== undefined ? { isError: msg.isError as boolean } : {}),
        });
      }
      return;
    }
    case "context.append_loop_event":
      agent.context.appendLoopEvent(input.event);
      return;
    case "context.clear":
      agent.context.clear();
      return;
    case "context.apply_compaction":
      agent.context.applyCompaction(input);
      return;
    case "tools.register_user_tool":
      agent.toolManager.registerUserTool({
        name: input.name,
        description: input.description,
        parameters: input.parameters as Record<string, unknown>,
      });
      return;
    case "tools.unregister_user_tool":
      agent.toolManager.unregisterUserTool(input.name);
      return;
    case "tools.set_active_tools":
      agent.toolManager.setActiveTools(input.names);
      return;
    case "tools.update_store":
      agent.toolManager.updateStore(input.key, input.value);
      return;
  }
}
