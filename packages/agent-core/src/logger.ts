/**
 * Minimal logger interface matching the shape used by the loop.
 */
export interface Logger {
  info?: (msg: string, ctx?: unknown) => void;
  warn?: (msg: string, ctx?: unknown) => void;
  error?: (msg: string, ctx?: unknown) => void;
}
