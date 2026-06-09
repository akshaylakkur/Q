/**
 * PlanMode — Manages plan mode state for structured implementation planning.
 */

import { randomUUID } from "node:crypto";

import type { Agent } from "../agent.js";

export type PlanData = null | {
  id: string;
  content: string;
  path: string;
};

export class PlanMode {
  protected _isActive = false;
  protected _planId: string | null = null;
  protected _planFilePath: string | null = null;

  constructor(protected readonly agent: Agent) {}

  async enter(id = randomUUID(), _createFile = false): Promise<void> {
    if (this._isActive) {
      throw new Error("Already in plan mode");
    }
    this._isActive = true;
    this._planId = id;
    this._planFilePath = null;
    this.agent.emitStatusUpdated();
  }

  restoreEnter(data: { id: string }): void {
    this._isActive = true;
    this._planId = data.id;
  }

  cancel(_id?: string): void {
    this._isActive = false;
    this._planId = null;
    this._planFilePath = null;
    this.agent.emitStatusUpdated();
  }

  async clear(): Promise<void> {
    // Clear plan file content
  }

  exit(_id?: string): void {
    this._isActive = false;
    this._planId = null;
    this._planFilePath = null;
    this.agent.emitStatusUpdated();
  }

  get isActive(): boolean {
    return this._isActive;
  }

  get planFilePath(): string | null {
    return this._planFilePath;
  }

  async data(): Promise<PlanData> {
    if (!this._planId) return null;
    return {
      id: this._planId,
      content: "",
      path: this._planFilePath ?? "",
    };
  }
}
