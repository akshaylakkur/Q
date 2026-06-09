/**
 * @q/qmain — Execution environment abstraction
 *
 * Qmain interface and LocalQmain implementation for
 * file operations, process execution, and path manipulation.
 *
 * Connectors provide higher-level abstractions:
 * ShellConnector, FileConnector, GitConnector, WebConnector.
 */

export * from "./qmain.js";
export * from "./local-qmain.js";
export * from "./types.js";
export * from "./connectors/index.js";