/**
 * Agent — Agent class, turn loop, tool execution, sub-agent host.
 *
 * @deprecated Use the Agent class from @q/agent-core instead.
 * This file is a legacy stub and will be removed in a future version.
 */

export interface Message {
  role: string;
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export class VAgent {
  readonly id: string;

  constructor() {
    this.id = crypto.randomUUID();
  }
}
