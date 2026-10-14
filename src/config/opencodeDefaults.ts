/**
 * VibeTrace composer default model (`providerID/modelID`).
 * Every outbound user message sends an explicit model.
 * Priority: dropdown selection → this default.
 */
export const VIBETRACE_DEFAULT_MODEL_REF = 'opencode/big-pickle'

/** Model used when the composer dropdown has no selection. */
export function resolveVibeTraceDefaultModelRef(): string {
  return VIBETRACE_DEFAULT_MODEL_REF
}
