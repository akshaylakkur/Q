/**
 * Profiles — Agent profile loading, resolution, and rendering.
 *
 * Available profiles:
 *   - auto:      Default general-purpose agent
 *   - editius:   Code editing agent (StrReplace specialist)
 *   - rewritius: Code rewriting agent (Write specialist)
 *   - searchius: Codebase search agent (Read/Glob/Grep specialist)
 */

export { loadAllProfiles, resolveAgentProfile, resolveAgentProfiles, SystemPromptRenderer, renderTemplate } from "./loader.js";
export type { RawProfile, ResolvedProfile, RenderContext } from "./loader.js";
