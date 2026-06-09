/**
 * Profiles — Agent profile loading, resolution, and rendering.
 */

export { loadAllProfiles, resolveAgentProfile, resolveAgentProfiles, SystemPromptRenderer, renderTemplate } from "./loader.js";
export type { RawProfile, ResolvedProfile, RenderContext } from "./loader.js";
