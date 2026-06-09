/**
 * MCP tool-call result → output pipeline.
 *
 * Owns the full path from "MCP protocol content blocks" to "what the agent
 * loop feeds back to the model":
 *  1. Convert each MCPContentBlock to a content part
 *     (dropping unsupported shapes).
 *  2. Apply size limits: text parts share a 100K character budget; binary
 *     parts (image/audio/video) each carry an independent 10 MB cap and
 *     collapse to a notice when oversize.
 *  3. Collapse a single-text-part result to a plain string output; otherwise
 *     emit the ContentPart[] as-is.
 *
 * `mcpResultToOutput` is the single entry point; the per-step helpers stay
 * private so callers cannot bypass the limits.
 */

import type { MCPContentBlock, MCPToolResult } from './types';

// ─── Content Part Types ──────────────────────────────────────────────────

/**
 * A processed content part suitable for agent loop consumption.
 * Mirrors the qprovs ContentPart shape without pulling in the dependency.
 */
export type OutputContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; imageUrl: { url: string } }
  | { type: 'audio_url'; audioUrl: { url: string } }
  | { type: 'video_url'; videoUrl: { url: string } };

// ─── Size Limits ─────────────────────────────────────────────────────────

/**
 * MCP servers can produce arbitrarily large outputs; cap what we feed back
 * so a single chatty server does not blow up the context window.
 */
export const MCP_MAX_OUTPUT_CHARS = 100_000;
const MCP_OUTPUT_TRUNCATED_TEXT = `\n\n[Output truncated: exceeded ${String(
  MCP_MAX_OUTPUT_CHARS,
)} character limit. Use pagination or more specific queries to get remaining content.]`;

/**
 * Binary parts (image_url / audio_url / video_url) have an independent per-part
 * byte cap and do NOT share the text character budget.
 */
export const MCP_MAX_BINARY_PART_BYTES = 10 * 1024 * 1024;
const MCP_MAX_BINARY_PART_CHARS = Math.ceil((MCP_MAX_BINARY_PART_BYTES * 4) / 3);

function binaryPartTooLargeNotice(kind: 'image' | 'audio' | 'video', urlLength: number): string {
  const approxMb = ((urlLength * 3) / 4 / (1024 * 1024)).toFixed(1);
  const capMb = String(MCP_MAX_BINARY_PART_BYTES / (1024 * 1024));
  return `[${kind}_url dropped: ~${approxMb} MB exceeds ${capMb} MB per-part limit. Try a smaller resource.]`;
}

// ─── Converters ──────────────────────────────────────────────────────────

/**
 * Convert a single MCP content block into an OutputContentPart.
 * Returns `null` for block types that cannot be represented.
 */
export function convertMCPContentBlock(block: MCPContentBlock): OutputContentPart | null {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }

  if (block.type === 'image' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'image/png';
    return {
      type: 'image_url',
      imageUrl: { url: `data:${mimeType};base64,${block.data}` },
    };
  }

  if (block.type === 'audio' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'audio/mpeg';
    return {
      type: 'audio_url',
      audioUrl: { url: `data:${mimeType};base64,${block.data}` },
    };
  }

  // EmbeddedResource: payload is nested under `resource`.
  if (block.type === 'resource' && typeof block.resource === 'object' && block.resource !== null) {
    const res = block.resource;
    if (typeof res.text === 'string') {
      return { type: 'text', text: res.text };
    }
    if (typeof res.blob === 'string') {
      const mimeType = res.mimeType ?? 'application/octet-stream';
      if (mimeType.startsWith('image/')) {
        return {
          type: 'image_url',
          imageUrl: { url: `data:${mimeType};base64,${res.blob}` },
        };
      }
      if (mimeType.startsWith('audio/')) {
        return {
          type: 'audio_url',
          audioUrl: { url: `data:${mimeType};base64,${res.blob}` },
        };
      }
      if (mimeType.startsWith('video/')) {
        return {
          type: 'video_url',
          videoUrl: { url: `data:${mimeType};base64,${res.blob}` },
        };
      }
      return null;
    }
    return null;
  }

  // ResourceLink: URL reference, not an inline blob.
  if (block.type === 'resource_link' && typeof block.uri === 'string') {
    const mimeType = block.mimeType ?? 'application/octet-stream';
    if (mimeType.startsWith('image/')) {
      return { type: 'image_url', imageUrl: { url: block.uri } };
    }
    if (mimeType.startsWith('audio/')) {
      return { type: 'audio_url', audioUrl: { url: block.uri } };
    }
    if (mimeType.startsWith('video/')) {
      return { type: 'video_url', videoUrl: { url: block.uri } };
    }
    return null;
  }

  return null;
}

// ─── Main Entry Point ────────────────────────────────────────────────────

/**
 * Convert an MCPToolResult into the output the agent loop expects.
 *
 * Returns `{ output, isError }` where `output` is either:
 * - a string (when the result is a single text content block)
 * - an `OutputContentPart[]` (for multi-part or media results)
 */
export function mcpResultToOutput(
  result: MCPToolResult,
  qualifiedToolName: string,
): { output: string | OutputContentPart[]; isError: boolean } {
  const converted: OutputContentPart[] = [];
  for (const block of result.content) {
    const part = convertMCPContentBlock(block);
    if (part !== null) {
      converted.push(part);
    }
  }

  const wrapped = wrapMediaOnly(converted, qualifiedToolName);
  const limited = applyOutputLimits(wrapped);
  const output = collapseSingleText(limited);
  return { output, isError: result.isError };
}

// ─── Internal Helpers ────────────────────────────────────────────────────

/**
 * If `parts` contains media but no non-empty text, surround it with
 * `<mcp_tool_result name="…">` text tags so the model can attribute the
 * binary content. Returns the input untouched otherwise.
 */
function wrapMediaOnly(
  parts: readonly OutputContentPart[],
  qualifiedToolName: string,
): OutputContentPart[] {
  const hasMedia = parts.some(
    (p) => p.type === 'image_url' || p.type === 'audio_url' || p.type === 'video_url',
  );
  const hasNonEmptyText = parts.some((p) => p.type === 'text' && p.text.length > 0);
  if (!hasMedia || hasNonEmptyText) return [...parts];
  return [
    { type: 'text', text: `<mcp_tool_result name="${qualifiedToolName}">` },
    ...parts,
    { type: 'text', text: '</mcp_tool_result>' },
  ];
}

/**
 * Apply the 100K text budget and the per-part 10 MB binary cap.
 */
function applyOutputLimits(parts: readonly OutputContentPart[]): OutputContentPart[] {
  let remaining = MCP_MAX_OUTPUT_CHARS;
  let textTruncated = false;
  const out: OutputContentPart[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      if (remaining <= 0) {
        textTruncated = true;
        continue;
      }
      if (part.text.length > remaining) {
        out.push({ type: 'text', text: part.text.slice(0, remaining) });
        remaining = 0;
        textTruncated = true;
      } else {
        out.push(part);
        remaining -= part.text.length;
      }
      continue;
    }

    // image_url / audio_url / video_url: per-part byte cap
    const url =
      part.type === 'image_url'
        ? part.imageUrl.url
        : part.type === 'audio_url'
          ? part.audioUrl.url
          : part.videoUrl.url;
    if (url.length > MCP_MAX_BINARY_PART_CHARS) {
      const kind =
        part.type === 'image_url' ? 'image' : part.type === 'audio_url' ? 'audio' : 'video';
      out.push({ type: 'text', text: binaryPartTooLargeNotice(kind, url.length) });
      continue;
    }
    out.push(part);
  }

  if (textTruncated) {
    appendTruncationNotice(out);
  }
  return out;
}

function appendTruncationNotice(out: OutputContentPart[]): void {
  for (let i = out.length - 1; i >= 0; i--) {
    const candidate = out[i];
    if (candidate?.type === 'text') {
      out[i] = { type: 'text', text: candidate.text + MCP_OUTPUT_TRUNCATED_TEXT };
      return;
    }
  }
  out.push({ type: 'text', text: MCP_OUTPUT_TRUNCATED_TEXT });
}

function collapseSingleText(parts: readonly OutputContentPart[]): string | OutputContentPart[] {
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }
  return [...parts];
}
