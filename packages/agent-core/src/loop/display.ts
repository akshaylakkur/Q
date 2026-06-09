/**
 * Tool input display types for rendering tool call info in the UI.
 */

export type ToolInputDisplay =
  | {
      readonly kind: "read";
      readonly path: string;
      readonly summary?: string;
    }
  | {
      readonly kind: "edit";
      readonly path: string;
      readonly summary?: string;
    }
  | {
      readonly kind: "write";
      readonly path: string;
      readonly summary?: string;
    }
  | {
      readonly kind: "run";
      readonly command: string;
    }
  | {
      readonly kind: "search";
      readonly pattern: string;
    }
  | {
      readonly kind: "web_search";
      readonly query: string;
    }
  | {
      readonly kind: "generic";
      readonly summary: string;
      readonly detail: unknown;
    };
