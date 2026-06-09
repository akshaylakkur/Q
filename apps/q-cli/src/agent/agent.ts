/**
 * Agent — Agent class, turn loop, tool execution, sub-agent host
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
