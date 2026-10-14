import { useEffect, useState } from 'react'
import {
  flushPendingExperimentReports,
  installExperimentAutoEndOnUnload,
  persistLiveReports,
} from './persistReport'
import { experimentTelemetry } from './telemetry'
import { useExperimentSnapshot } from './useExperimentSnapshot'

type Props = {
  /** Current workspace / folder selection (experiment is folder-scoped). */
  directory: string
}

/** Compact always-on recording indicator pinned to the bottom of the leftmost folder rail. */
export default function ExperimentBar({ directory }: Props) {
  const snap = useExperimentSnapshot()
  const [studyActive, setStudyActive] = useState(() => experimentTelemetry.isStudyActive())
  const [participantId, setParticipantId] = useState(() => experimentTelemetry.getParticipantId() || 'P01')
  const [hint, setHint] = useState<string | null>(null)

  /** Always-on: selecting a folder starts/continues a per-folder bucket. */
  useEffect(() => {
    if (directory.trim()) {
      experimentTelemetry.resumeIfNeeded(directory)
    } else {
      experimentTelemetry.setCurrentDirectory('')
    }
    setStudyActive(experimentTelemetry.isStudyActive())
  }, [directory])

  useEffect(() => {
    return experimentTelemetry.subscribe(() => {
      setStudyActive(experimentTelemetry.isStudyActive())
      const pid = experimentTelemetry.getParticipantId()
      if (pid) setParticipantId(pid)
    })
  }, [])

  /** Autosave installer + pending retry; resume when tab is visible again. */
  useEffect(() => {
    installExperimentAutoEndOnUnload()
    void flushPendingExperimentReports().then((n) => {
      if (n > 0) {
        setHint(`OK ${n}`)
        window.setTimeout(() => setHint(null), 2500)
      }
    })

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (directory.trim()) experimentTelemetry.resumeIfNeeded(directory)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [directory])

  const commitParticipantId = (value: string) => {
    const next = value.trim() || 'P01'
    setParticipantId(next)
    experimentTelemetry.setParticipantId(next)
  }

  const handleSaveNow = async () => {
    setHint(null)
    const n = await persistLiveReports({ downloadOnFail: true })
    setHint(n > 0 ? (n > 1 ? `${n}✓` : 'Saved') : '—')
    window.setTimeout(() => setHint(null), 2500)
  }

  const recording = studyActive && Boolean(directory.trim())

  return (
    <div
      style={{
        flexShrink: 0,
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        padding: '6px 4px 2px',
        borderTop: '1px solid #E8E8E8',
        boxSizing: 'border-box',
      }}
      title={
        recording
          ? `Auto-recording · ${snap?.directory || directory} · saved under vibetrace-behavior/`
          : 'Select a workspace folder — recording starts automatically'
      }
    >
      <span style={{ fontSize: 9, fontWeight: 700, color: '#8A8A8A', letterSpacing: 0.2 }}>Exp</span>

      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: recording ? '#DC2626' : '#D1D5DB',
          flexShrink: 0,
        }}
        title={recording ? 'Recording' : 'Idle'}
      />

      <input
        value={participantId}
        onChange={(e) => setParticipantId(e.target.value)}
        onBlur={(e) => commitParticipantId(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          }
        }}
        placeholder="P01"
        title="Participant ID"
        aria-label="Participant ID"
        style={{
          width: 34,
          border: '1px solid #D8D8D8',
          borderRadius: 5,
          padding: '2px 1px',
          fontSize: 9,
          background: '#fff',
          textAlign: 'center',
          boxSizing: 'border-box',
        }}
      />

      <button
        type="button"
        onClick={() => void handleSaveNow()}
        disabled={!recording}
        style={{
          width: 34,
          border: '1px solid #D8D8D8',
          background: recording ? '#fff' : '#F3F4F6',
          color: recording ? '#374151' : '#9CA3AF',
          borderRadius: 6,
          padding: '3px 0',
          fontSize: 9,
          fontWeight: 600,
          cursor: recording ? 'pointer' : 'not-allowed',
          lineHeight: 1.2,
        }}
        title="Force-save into each workspace's vibetrace-behavior/ folder now"
      >
        Save
      </button>

      {hint ? (
        <span
          title={hint}
          style={{
            color: '#888',
            fontSize: 8,
            maxWidth: 36,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            lineHeight: 1.1,
          }}
        >
          {hint}
        </span>
      ) : null}
    </div>
  )
}
