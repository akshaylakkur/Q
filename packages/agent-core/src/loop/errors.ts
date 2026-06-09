/**
 * Loop-specific error types and helpers.
 */

export class LoopError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LoopError";
    this.code = code;
  }
}

export class MaxStepsExceededError extends LoopError {
  readonly maxSteps: number;
  constructor(maxSteps: number) {
    super("MAX_STEPS_EXCEEDED", `Max steps (${maxSteps}) exceeded`);
    this.name = "MaxStepsExceededError";
    this.maxSteps = maxSteps;
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

export function isMaxStepsExceededError(error: unknown): boolean {
  return error instanceof MaxStepsExceededError;
}

export function createMaxStepsExceededError(maxSteps: number): MaxStepsExceededError {
  return new MaxStepsExceededError(maxSteps);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
