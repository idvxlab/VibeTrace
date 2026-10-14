import { useEffect, useState } from 'react'
import { experimentTelemetry } from './telemetry'
import type { ExperimentSnapshot } from './types'

/** Subscribe to live experiment state for UI chrome. */
export function useExperimentSnapshot(): ExperimentSnapshot | null {
  const [snap, setSnap] = useState<ExperimentSnapshot | null>(() => experimentTelemetry.getSnapshot())
  useEffect(() => experimentTelemetry.subscribe(setSnap), [])
  return snap
}
