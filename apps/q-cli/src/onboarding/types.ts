/**
 * Shared types for the Onboarding Wizard system.
 *
 * Simplified state model for the revamped Q setup flow.
 * Steps: Welcome → Select Provider → Enter & Validate Model → Confirmation
 */

/** Mutable state accumulated across all wizard steps */
export interface OnboardingState {
  provider: { type: string; name: string } | null;
  credentials: { apiKey?: string } | null;
  model: string | null;
  /** Result of the model validation ping */
  validationResult: "untested" | "success" | "failure";
  validationLatencyMs: number | null;
  validationError: string | null;
}

/** Result of a single wizard step */
export type StepResult = "next" | "prev" | "stay" | "exit";

/** Result of step validation */
export interface StepValidation {
  valid: boolean;
  error?: string;
}

/** Interface every wizard step must implement */
export interface WizardStep {
  id: string;
  title: string;
  render(state: OnboardingState): string;
  handleInput(key: string, state: OnboardingState): StepResult | Promise<StepResult>;
  validate(state: OnboardingState): StepValidation;
  /** Optional: reset internal state when the step is re-entered via backtracking */
  reset?: () => void;
}

/** Result from the first-run detector */
export interface OnboardingGate {
  needed: boolean;
  reason?: "no_provider" | "no_model" | "both";
}

/** Provider entry shown in the provider picker */
export interface ProviderEntry {
  type: string;
  name: string;
  description: string;
  badges: string;
}

/** The built-in providers list — curated for the new simple flow */
export const PROVIDERS: ProviderEntry[] = [
  {
    type: "anthropic",
    name: "Anthropic",
    description: "Claude models — best-in-class for coding with extended thinking.",
    badges: "🧠📡",
  },
  {
    type: "openai",
    name: "OpenAI",
    description: "GPT-4o, o-series — versatile with structured outputs.",
    badges: "🧠📡",
  },
  {
    type: "google",
    name: "Google Gemini",
    description: "Gemini 2.5 Pro/Flash — multi-modal with native thinking.",
    badges: "🧠📡",
  },
  {
    type: "ollama",
    name: "Ollama (Local)",
    description: "Local models via Ollama. Requires Ollama on localhost:11434.",
    badges: "📡",
  },
  {
    type: "ollama-cloud",
    name: "Ollama Cloud",
    description: "Cloud-hosted Ollama models via API key. Uses api.ollama.com.",
    badges: "🧠📡",
  },
  {
    type: "openai-compatible",
    name: "OpenAI-Compatible",
    description: "Groq, Together, Fireworks, or any OpenAI-compatible endpoint.",
    badges: "📡",
  },
];

/** Default onboarding state */
export function createDefaultState(): OnboardingState {
  return {
    provider: null,
    credentials: null,
    model: null,
    validationResult: "untested",
    validationLatencyMs: null,
    validationError: null,
  };
}

/** Make a deep clone of the onboarding state (for checkpoints) */
export function cloneState(state: OnboardingState): OnboardingState {
  return {
    provider: state.provider ? { ...state.provider } : null,
    credentials: state.credentials ? { ...state.credentials } : null,
    model: state.model,
    validationResult: state.validationResult,
    validationLatencyMs: state.validationLatencyMs,
    validationError: state.validationError,
  };
}