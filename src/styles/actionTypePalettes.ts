import * as d3 from 'd3'
import type { ActionType } from '../types/opencode'

/** Matches `ActionType` union order — keeps D3 scheme lookups index-aligned */
export const ACTION_TYPE_ORDER: readonly ActionType[] = [
  'UserRequest',
  'Think',
  'Clarify',
  'Plan',
  'Permission',
  'Subagent',
  'Response',
  'Read',
  'SkillRouter',
  'Write',
  'Shell',
  'Search',
  'Skill',
  'Compaction',
] as const

export type ActionTypePaletteId =
  | 'pastelPaired7'
  | 'contrast'
  | 'spectrum'
  | 'd3PairedVivid7'
  | 'd3Paired'
  | 'd3PairedVivid'
  | 'd3Observable'
  | 'd3ObservableVivid'
  | 'customUserA'

export const ACTION_TYPE_PALETTE_LABELS: Record<ActionTypePaletteId, string> = {
  pastelPaired7: 'Pastel 7 — paired fill + icon',
  contrast: 'High contrast — hand-tuned',
  spectrum: 'Hue spread — hand-tuned (soft yellow / magenta)',
  d3PairedVivid7: 'd3 schemePaired — vivid 7-group',
  d3Paired: 'd3 schemePaired — soft',
  d3PairedVivid: 'd3 schemePaired — vivid',
  d3Observable: 'd3 Observable10 + Tableau — soft',
  d3ObservableVivid: 'd3 Observable10 + Tableau — vivid',
  customUserA: 'Custom palette A (10 base + 2 fill-ins)',
}

export type ActionTypeTriad = { fill: string; stroke: string; accent: string }

/**
 * Pastel 7 uses the literal fill/icon strings below — no d3 pass, no alpha, no `triadFromD3`.
 * `stroke` / `accent` equal the icon color (ActionFlow block stroke matches the icon).
 *
 * Grouping matches legacy `PAIRED_VIVID_7` / “vivid 7-group” (same hue bucket per action family):
 * | Group | action types |
 * |-------|--------------|
 * | 0 | Think, Plan |
 * | 1 | Clarify, Permission |
 * | 2 | Read, Shell, Search |
 * | 3 | Write, Response |
 * | 4 | Skill |
 * | 5 | Subagent |
 * | 6 | Compaction |
 * UserRequest is separate: white fill + neutral gray icon (outside Pastel 7).
 */
const PASTEL7_FILL = ['#b3e2cd', '#fdcdac', '#cbd5e8', '#f4cae4', '#e6f5c9', '#fff2ae', '#f1e2cc'] as const
const PASTEL7_ICON = ['#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3', '#a6d854', '#ffd92f', '#e5c494'] as const

/** Group index 0..6; UserRequest uses -1 for standalone styling */
const PASTEL7_GROUP_INDEX: Record<ActionType, number> = {
  UserRequest: -1,
  Think: 0,
  Plan: 0,
  Clarify: 1,
  Permission: 1,
  Read: 2,
  SkillRouter: 2,
  Shell: 2,
  Search: 2,
  Write: 4,
  Response: 4,
  Skill: 5,
  Subagent: 3,
  Compaction: 6,
}

function buildPastelPaired7(): Record<ActionType, ActionTypeTriad> {
  const out = {} as Record<ActionType, ActionTypeTriad>
  for (const t of ACTION_TYPE_ORDER) {
    const g = PASTEL7_GROUP_INDEX[t]
    if (g < 0) {
      out[t] = { fill: '#FFFFFF', stroke: '#3D4F63', accent: '#3D4F63' }
      continue
    }
    const fill = PASTEL7_FILL[g]!
    const icon = PASTEL7_ICON[g]!
    out[t] = { fill, stroke: icon, accent: icon }
  }
  return out
}

/** High-contrast hand-tuned palette — darker strokes so blocks separate clearly */
const CONTRAST: Record<ActionType, ActionTypeTriad> = {
  UserRequest: { fill: '#FFFFFF', stroke: '#3D4F63', accent: '#3D4F63' },
  Think: { fill: '#E8E6FF', stroke: '#6350C9', accent: '#342A78' },
  Clarify: { fill: '#FFF0DC', stroke: '#C78339', accent: '#744A1F' },
  Plan: { fill: '#DAF8EF', stroke: '#1C9A7F', accent: '#0E5C4C' },
  Permission: { fill: '#F4E3FF', stroke: '#9750C7', accent: '#582C75' },
  Subagent: { fill: '#FFEADA', stroke: '#C46D31', accent: '#7B4320' },
  Response: { fill: '#E6F6D8', stroke: '#5F9B35', accent: '#395E21' },
  Read: { fill: '#DCF6FB', stroke: '#2F9AB3', accent: '#1B5E6D' },
  /** 与 Read 同色带：`skill_router` 等「取数」类工具 */
  SkillRouter: { fill: '#DCF6FB', stroke: '#2F9AB3', accent: '#1B5E6D' },
  Write: { fill: '#EAF3FF', stroke: '#4E78C0', accent: '#2D4770' },
  Shell: { fill: '#EFEFF3', stroke: '#6A7082', accent: '#3F4450' },
  Search: { fill: '#FFE8F0', stroke: '#C05D86', accent: '#73364F' },
  Skill: { fill: '#FFF1DF', stroke: '#C6933C', accent: '#785921' },
  Compaction: { fill: '#E1ECF6', stroke: '#467FA8', accent: '#284A61' },
}

/** Hue-spread hand-tuned palette with soft yellow / magenta tones, kept low-sat vs pending/error */
const SPECTRUM: Record<ActionType, ActionTypeTriad> = {
  UserRequest: { fill: '#FFFFFF', stroke: '#3D4F63', accent: '#3D4F63' },
  Think: { fill: '#EEE7FF', stroke: '#7B61D4', accent: '#4A3494' },
  Clarify: { fill: '#FFF3E2', stroke: '#C89247', accent: '#765624' },
  Plan: { fill: '#E2FBF4', stroke: '#3CB89A', accent: '#1F6B58' },
  Permission: { fill: '#F5E8FF', stroke: '#9B59C4', accent: '#5E2D7A' },
  Subagent: { fill: '#E8F0FF', stroke: '#5A7FD4', accent: '#344F8F' },
  Response: { fill: '#F3F8E6', stroke: '#8BAF3C', accent: '#536622' },
  Read: { fill: '#E5FAFF', stroke: '#42AFC4', accent: '#276877' },
  SkillRouter: { fill: '#E5FAFF', stroke: '#42AFC4', accent: '#276877' },
  Write: { fill: '#ECF8E8', stroke: '#62B04E', accent: '#3A682F' },
  Shell: { fill: '#ECEEF3', stroke: '#6D7A90', accent: '#414A59' },
  Search: { fill: '#FFEEF4', stroke: '#C75A8A', accent: '#763552' },
  Skill: { fill: '#FFF6E5', stroke: '#C9A03D', accent: '#7A6125' },
  Compaction: { fill: '#E6F2F7', stroke: '#508AA3', accent: '#305462' },
}

/**
 * Map a d3 scheme swatch into UI `{fill,stroke,accent}`: bright low-sat fill, deeper strokes.
 * Extra desaturation on red/yellow hues so we do not collide with error (red) or pending (amber).
 */
function triadFromD3SchemeColor(hex: string): ActionTypeTriad {
  const base = d3.color(hex)
  if (!base) return { fill: '#F0F0F0', stroke: '#888888', accent: '#333333' }
  const hsl = d3.hsl(base)
  const h = Number.isFinite(hsl.h) ? hsl.h : 220

  let fillS = Math.min(hsl.s * 0.32 + 0.06, 0.38)
  let fillL = 0.91
  let strokeS = Math.min(hsl.s * 0.48 + 0.08, 0.52)
  let strokeL = 0.52
  let accentS = Math.min(hsl.s * 0.55 + 0.1, 0.58)
  let accentL = 0.34

  // Red band: lighten + desaturate vs error reds
  if ((h >= 0 && h < 32) || h >= 348) {
    fillS *= 0.55
    strokeS *= 0.6
    accentS *= 0.65
    fillL = Math.max(fillL, 0.9)
  }
  // Yellow band: nudge hue toward amber, lower saturation vs pending yellows
  if (h >= 38 && h < 72) {
    hsl.h = h + 6
    fillS *= 0.5
    strokeS *= 0.55
    fillL = Math.max(fillL, 0.92)
  }

  const fill = d3.hsl(hsl.h, fillS, fillL).formatHex()
  const stroke = d3.hsl(hsl.h, strokeS, strokeL).formatHex()
  const accent = d3.hsl(hsl.h, accentS, accentL).formatHex()
  return { fill, stroke, accent }
}

/** Brighter d3-derived variant — preserves chroma instead of muddy darkening */
function triadFromD3SchemeColorVivid(hex: string): ActionTypeTriad {
  const base = d3.color(hex)
  if (!base) return { fill: '#F0F0F0', stroke: '#888888', accent: '#333333' }
  const hsl = d3.hsl(base)
  const h = Number.isFinite(hsl.h) ? hsl.h : 220

  let fillS = Math.min(hsl.s * 0.62 + 0.1, 0.72)
  let fillL = 0.86
  let strokeS = Math.min(hsl.s * 0.76 + 0.12, 0.85)
  let strokeL = 0.58
  let accentS = Math.min(hsl.s * 0.84 + 0.12, 0.9)
  let accentL = 0.42

  if ((h >= 0 && h < 32) || h >= 348) {
    fillS *= 0.72
    strokeS *= 0.78
    accentS *= 0.82
    fillL = Math.max(fillL, 0.88)
  }
  if (h >= 38 && h < 72) {
    hsl.h = h + 4
    fillS *= 0.68
    strokeS *= 0.72
    fillL = Math.max(fillL, 0.9)
  }

  return {
    fill: d3.hsl(hsl.h, fillS, fillL).formatHex(),
    stroke: d3.hsl(hsl.h, strokeS, strokeL).formatHex(),
    accent: d3.hsl(hsl.h, accentS, accentL).formatHex(),
  }
}

const PAIRED_BASE_BY_TYPE: Record<ActionType, string> = {
  UserRequest: '#3D4F63',
  Think: '#6a3d9a',
  Clarify: '#a6cee3',
  Plan: '#33a02c',
  Permission: '#cab2d6',
  Subagent: '#ff7f00',
  Response: '#1f78b4',
  Read: '#b2df8a',
  SkillRouter: '#b2df8a',
  Write: '#b15928',
  Shell: '#ffff99',
  Search: '#e31a1c',
  Skill: '#fdbf6f',
  Compaction: '#fb9a99',
}

const PAIRED_VIVID_7: Record<ActionType, string> = {
  UserRequest: '#FFFFFF',
  Think: CONTRAST.Think.fill,
  Plan: CONTRAST.Think.fill,
  Clarify: '#FFE2B3',
  Permission: '#FFE2B3',
  Read: CONTRAST.Plan.fill,
  SkillRouter: CONTRAST.Plan.fill,
  Search: CONTRAST.Plan.fill,
  Shell: CONTRAST.Plan.fill,
  Write: CONTRAST.Write.fill,
  Response: CONTRAST.Write.fill,
  Skill: '#E7C9A8',
  Compaction: CONTRAST.Shell.fill,
  Subagent: '#FFE8F0',
}

function buildD3Paired(vivid: boolean): Record<ActionType, ActionTypeTriad> {
  const out = {} as Record<ActionType, ActionTypeTriad>
  ACTION_TYPE_ORDER.forEach((t) => {
    const base = PAIRED_BASE_BY_TYPE[t]
    out[t] = vivid ? triadFromD3SchemeColorVivid(base) : triadFromD3SchemeColor(base)
  })
  return out
}

function buildD3PairedVivid7(): Record<ActionType, ActionTypeTriad> {
  const out = {} as Record<ActionType, ActionTypeTriad>
  ACTION_TYPE_ORDER.forEach((t) => {
    const src = PAIRED_VIVID_7[t]
    const tone = triadFromD3SchemeColorVivid(src)
    out[t] = { fill: src, stroke: tone.stroke, accent: tone.accent }
  })
  return out
}

function buildD3Observable(vivid: boolean): Record<ActionType, ActionTypeTriad> {
  const obs = d3.schemeObservable10
  const tab = d3.schemeTableau10
  const colorsByType: Record<ActionType, string> = {
    UserRequest: '#3D4F63',
    Think: obs[0]!,
    Clarify: obs[3]!,
    Plan: obs[2]!,
    Permission: obs[8]!,
    Subagent: obs[4]!,
    Response: obs[1]!,
    Read: obs[9]!,
    SkillRouter: obs[9]!,
    Write: tab[2]!,
    Shell: tab[7]!,
    Search: obs[6]!,
    Skill: obs[5]!,
    Compaction: tab[0]!,
  }
  const out = {} as Record<ActionType, ActionTypeTriad>
  ACTION_TYPE_ORDER.forEach((t) => {
    const base = colorsByType[t]
    out[t] = vivid ? triadFromD3SchemeColorVivid(base) : triadFromD3SchemeColor(base)
  })
  return out
}

const PALETTES: Record<ActionTypePaletteId, Record<ActionType, ActionTypeTriad>> = {
  pastelPaired7: buildPastelPaired7(),
  contrast: CONTRAST,
  spectrum: SPECTRUM,
  d3PairedVivid7: buildD3PairedVivid7(),
  d3Paired: buildD3Paired(false),
  d3PairedVivid: buildD3Paired(true),
  d3Observable: buildD3Observable(false),
  d3ObservableVivid: buildD3Observable(true),
  customUserA: (() => {
    /**
     * User-provided 10 swatches + 2 fill-ins so all 12 `ActionType`s are covered.
     * Base swatches:
     *  #BEEB9F #79D320 #ADD5F7 #3498DB #00305A
     *  #FFF176 #FA9600 #8B63A6 #9C27B0 #441A19
     * Extra:
     *  #00BFA5 #F06292
     */
    const baseByType: Record<ActionType, string> = {
      UserRequest: '#FFFFFF',
      Think: '#BEEB9F',
      Clarify: '#79D320',
      Plan: '#ADD5F7',
      Permission: '#3498DB',
      Subagent: '#00305A',
      Response: '#FFF176',
      Read: '#FA9600',
      SkillRouter: '#FA9600',
      Write: '#8B63A6',
      Shell: '#9C27B0',
      Search: '#441A19',
      Skill: '#00BFA5',
      Compaction: '#F06292',
    }
    const out = {} as Record<ActionType, ActionTypeTriad>
    ACTION_TYPE_ORDER.forEach((t) => {
      const c = baseByType[t]
      out[t] = { fill: c, stroke: c, accent: c }
    })
    out.UserRequest = CONTRAST.UserRequest
    return out
  })(),
}

export function getActionTypeTriad(paletteId: ActionTypePaletteId, actionType: ActionType): ActionTypeTriad {
  return PALETTES[paletteId][actionType]
}

export function getActionTypePaletteRecord(
  paletteId: ActionTypePaletteId,
): Record<ActionType, ActionTypeTriad> {
  return PALETTES[paletteId]
}

export const DEFAULT_ACTION_TYPE_PALETTE_ID: ActionTypePaletteId = 'pastelPaired7'
