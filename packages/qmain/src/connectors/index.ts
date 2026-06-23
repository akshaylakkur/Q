/**
 * Connector Layer — Higher-level abstractions built on top of Qmain.
 *
 * ShellConnector  — Process execution, background tasks, which, PTY
 * FileConnector   — File read/write/edit/glob/grep/copy/move/delete/snapshot
 * GitConnector    — Git operations via CLI
 * WebConnector    — URL fetching with text extraction, web search abstraction
 */

export { ShellConnector } from "./shell-connector.js";
export type { ShellConnectorOptions, ShellProcessHandle } from "./shell-connector.js";

export { FileConnector } from "./file-connector.js";
export type {
  ReadOptions,
  WriteOptions,
  GrepOptions,
  GrepMatch,
  SnapshotHandle,
} from "./file-connector.js";

export { GitConnector } from "./git-connector.js";
export type {
  GitConnectorOptions,
  GitStatus,
  GitFileStatus,
  GitLogOptions,
  GitCommit,
  GitBlameLine,
} from "./git-connector.js";

export { WebConnector, ConnectorNotAvailableError, HttpFetchError } from "./web-connector.js";
export type {
  WebConnectorOptions,
  SearchResult,
  WebSearchOptions,
  WebSearchProvider,
} from "./web-connector.js";

export { OllamaWebSearchProvider } from "./ollama-web-search-provider.js";
