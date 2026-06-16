/**
 * Profiles — Agent profile loading, resolution, and rendering.
 *
 * Available profiles:
 *   - auto:      Default general-purpose agent
 *   - editius:   Code editing agent (StrReplace specialist)
 *   - rewritius: Code rewriting agent (Write specialist)
 *   - searchius: Codebase search agent (Read/Glob/Grep specialist)
 *
 * Profiles are registered both as filesystem YAML files (for dev mode)
 * and as embedded TypeScript strings (for SEA binary mode).
 */

import { registerEmbeddedProfile } from "./loader.js";
import { autoYaml } from "./auto.js";
import { editiusYaml } from "./editius.js";
import { rewritiusYaml } from "./rewritius.js";
import { searchiusYaml } from "./searchius.js";

// Register all profiles in the embedded registry so they work
// in SEA binary mode where there is no filesystem.
registerEmbeddedProfile("auto", autoYaml);
registerEmbeddedProfile("editius", editiusYaml);
registerEmbeddedProfile("rewritius", rewritiusYaml);
registerEmbeddedProfile("searchius", searchiusYaml);

export { loadAllProfiles, resolveAgentProfile, resolveAgentProfiles, SystemPromptRenderer, renderTemplate, registerEmbeddedProfile } from "./loader.js";
export type { RawProfile, ResolvedProfile, RenderContext } from "./loader.js";
