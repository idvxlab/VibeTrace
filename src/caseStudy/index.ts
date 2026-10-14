import type { SessionDemoOverride } from './types'

const OVERRIDES: SessionDemoOverride[] = []

const BY_SESSION = new Map(OVERRIDES.map((o) => [o.sessionId, o]))

export function getSessionDemoOverride(sessionId: string | undefined): SessionDemoOverride | undefined {
  if (!sessionId) return undefined
  return BY_SESSION.get(sessionId)
}

export function isCaseStudyDemoEnabled(): boolean {
  return import.meta.env.VITE_CASE_STUDY_DEMO === '1'
}
