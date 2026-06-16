/**
 * Plan — Plan mode module for the Qode TUI.
 *
 * This module implements the /plan command lifecycle:
 * 1. User enters plan mode via /plan
 * 2. User sends a prompt
 * 3. System generates a plan using the LLM
 * 4. Plan is written to ~/.Q/plan/<session_id>.md
 * 5. A dropdown with "Looks good!", "Needs revision", "Redo", "Exit" is shown
 * 6. User selects an option
 * 7. On accept: plan is executed step by step
 * 8. On revision: user provides revision text, plan is updated
 * 9. On redo: plan is regenerated from scratch
 * 10. On exit: plan mode is exited, task is executed directly
 */

export { PlanModeController } from "./plan-mode.js";
export type { PlanPhase, PlanChoice, PlanState } from "./plan-mode.js";
export { PlanDropdownComponent } from "./plan-dropdown.js";
export { PlanRevisionInputComponent } from "./plan-revision-input.js";
export { handlePlanCommand } from "./plan-handler.js";
