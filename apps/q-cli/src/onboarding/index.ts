/**
 * Onboarding — Barrel export for the first-run setup wizard.
 */

export { OnboardingWizard } from "./onboarding.js";
export { checkFirstRun } from "./detector.js";
export { writeOnboardingConfig, clearOnboardingComplete } from "./write-config.js";
export type { OnboardingState, OnboardingGate, WizardStep, StepResult, StepValidation } from "./types.js";
export { createDefaultState, PROVIDERS } from "./types.js";