import { useEffect, useState } from 'react'
import type { OcComposerModelOption } from '../services/opencodeApi'

type SavedModels = { backgroundModel: string; skillEvolutionModel: string }
const endpoint = '/__vibetrace/model-config'

export default function BackgroundModelSettings({ models }: { models: OcComposerModelOption[] }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [backgroundModel, setBackgroundModel] = useState('')
  const [skillModel, setSkillModel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setSaved(false)
    void fetch(endpoint, { signal: controller.signal })
      .then(async response => {
        const body = await response.json() as SavedModels & { error?: string }
        if (!response.ok) throw new Error(body.error || `Settings unavailable (HTTP ${response.status})`)
        setBackgroundModel(body.backgroundModel || '')
        setSkillModel(body.skillEvolutionModel || '')
      })
      .catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [open])

  const save = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          backgroundModel: backgroundModel.trim() || null,
          skillEvolutionModel: skillModel.trim() || null,
        }),
      })
      const body = await response.json() as SavedModels & { error?: string }
      if (!response.ok) throw new Error(body.error || `Could not save settings (HTTP ${response.status})`)
      setBackgroundModel(body.backgroundModel || '')
      setSkillModel(body.skillEvolutionModel || '')
      setSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return <>
    <button type="button" title="Background model settings" aria-label="Background model settings" onClick={() => setOpen(true)}
      style={{ width: 32, height: 32, flexShrink: 0, border: '1px solid #E8E8E8', borderRadius: 6, background: '#FFFFFF', color: '#555', cursor: 'pointer', fontSize: 18 }}>
      ⚙
    </button>
    {open && <div role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false) }}
      style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <section role="dialog" aria-modal="true" aria-label="Background model settings"
        onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}
        style={{ width: 'min(460px, 100%)', borderRadius: 12, background: '#FFFFFF', padding: 20, boxShadow: '0 16px 48px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: 15 }}>Background model settings</strong>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close settings" style={{ border: 0, background: 'transparent', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>
        <p style={{ margin: 0, color: '#666', lineHeight: 1.5 }}>These models run VibeTrace internal tasks. Your chat model is selected separately.</p>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          Background analysis model <span style={{ color: '#777' }}>Task switch, error diagnosis and feedback</span>
          <input value={backgroundModel} onChange={event => { setBackgroundModel(event.target.value); setSaved(false) }} list="vibetrace-background-models"
            placeholder="Default: opencode/big-pickle" disabled={loading || saving} aria-label="Background analysis model"
            style={{ padding: '8px 10px', border: '1px solid #D8D8D8', borderRadius: 6, fontSize: 12 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          Skill evolution model <span style={{ color: '#777' }}>Optional; blank follows the background model</span>
          <input value={skillModel} onChange={event => { setSkillModel(event.target.value); setSaved(false) }} list="vibetrace-background-models"
            placeholder="Follow background model" disabled={loading || saving} aria-label="Skill evolution model"
            style={{ padding: '8px 10px', border: '1px solid #D8D8D8', borderRadius: 6, fontSize: 12 }} />
        </label>
        <datalist id="vibetrace-background-models">{models.map(model => <option key={model.ref} value={model.ref}>{model.label}</option>)}</datalist>
        <p style={{ margin: 0, color: '#777', lineHeight: 1.45 }}>Use a model already available in OpenCode, in providerID/modelID form. Saving applies to new internal tasks; tasks already running keep their model.</p>
        {error && <div role="alert" style={{ color: '#B91C1C' }}>{error}</div>}
        {saved && <div role="status" style={{ color: '#15803D' }}>Saved for new internal tasks.</div>}
        <button type="button" onClick={() => void save()} disabled={loading || saving}
          style={{ alignSelf: 'flex-end', padding: '7px 18px', border: 0, borderRadius: 6, background: '#8445BC', color: '#FFFFFF', cursor: loading || saving ? 'wait' : 'pointer' }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </section>
    </div>}
  </>
}
