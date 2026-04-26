import * as d3 from 'd3'
import type { ActionType } from '../types/opencode'

/** 与 `ActionType` 联合顺序一致，供 D3 scheme 按索引对齐 */
export const ACTION_TYPE_ORDER: readonly ActionType[] = [
  'Think',
  'Clarify',
  'Plan',
  'Permission',
  'Subagent',
  'Response',
  'Read',
  'Write',
  'Shell',
  'Search',
  'Skill',
  'Compaction',
] as const

export type ActionTypePaletteId =
  | 'contrast'
  | 'spectrum'
  | 'd3PairedVivid7'
  | 'd3Paired'
  | 'd3PairedVivid'
  | 'd3Observable'
  | 'd3ObservableVivid'
  | 'customUserA'

export const ACTION_TYPE_PALETTE_LABELS: Record<ActionTypePaletteId, string> = {
  contrast: '高对比 · 手工',
  spectrum: '色谱 · 手工（含柔和黄/玫红）',
  d3PairedVivid7: 'd3 · schemePaired（亮色7分组）',
  d3Paired: 'd3 · schemePaired（柔和版）',
  d3PairedVivid: 'd3 · schemePaired（亮色版）',
  d3Observable: 'd3 · schemeObservable10 + Tableau（柔和版）',
  d3ObservableVivid: 'd3 · schemeObservable10 + Tableau（亮色版）',
  customUserA: '用户色盘 A（10+补2）',
}

export type ActionTypeTriad = { fill: string; stroke: string; accent: string }

/** 高对比手工盘：描边更深，块之间更易区分 */
const CONTRAST: Record<ActionType, ActionTypeTriad> = {
  Think: { fill: '#E8E6FF', stroke: '#6350C9', accent: '#342A78' },
  Clarify: { fill: '#FFF0DC', stroke: '#C78339', accent: '#744A1F' },
  Plan: { fill: '#DAF8EF', stroke: '#1C9A7F', accent: '#0E5C4C' },
  Permission: { fill: '#F4E3FF', stroke: '#9750C7', accent: '#582C75' },
  Subagent: { fill: '#FFEADA', stroke: '#C46D31', accent: '#7B4320' },
  Response: { fill: '#E6F6D8', stroke: '#5F9B35', accent: '#395E21' },
  Read: { fill: '#DCF6FB', stroke: '#2F9AB3', accent: '#1B5E6D' },
  Write: { fill: '#EAF3FF', stroke: '#4E78C0', accent: '#2D4770' },
  Shell: { fill: '#EFEFF3', stroke: '#6A7082', accent: '#3F4450' },
  Search: { fill: '#FFE8F0', stroke: '#C05D86', accent: '#73364F' },
  Skill: { fill: '#FFF1DF', stroke: '#C6933C', accent: '#785921' },
  Compaction: { fill: '#E1ECF6', stroke: '#467FA8', accent: '#284A61' },
}

/** 色谱手工盘：色相拉开，含柔和黄/玫红（与 pending / error 通过低饱和区分） */
const SPECTRUM: Record<ActionType, ActionTypeTriad> = {
  Think: { fill: '#EEE7FF', stroke: '#7B61D4', accent: '#4A3494' },
  Clarify: { fill: '#FFF3E2', stroke: '#C89247', accent: '#765624' },
  Plan: { fill: '#E2FBF4', stroke: '#3CB89A', accent: '#1F6B58' },
  Permission: { fill: '#F5E8FF', stroke: '#9B59C4', accent: '#5E2D7A' },
  Subagent: { fill: '#E8F0FF', stroke: '#5A7FD4', accent: '#344F8F' },
  Response: { fill: '#F3F8E6', stroke: '#8BAF3C', accent: '#536622' },
  Read: { fill: '#E5FAFF', stroke: '#42AFC4', accent: '#276877' },
  Write: { fill: '#ECF8E8', stroke: '#62B04E', accent: '#3A682F' },
  Shell: { fill: '#ECEEF3', stroke: '#6D7A90', accent: '#414A59' },
  Search: { fill: '#FFEEF4', stroke: '#C75A8A', accent: '#763552' },
  Skill: { fill: '#FFF6E5', stroke: '#C9A03D', accent: '#7A6125' },
  Compaction: { fill: '#E6F2F7', stroke: '#508AA3', accent: '#305462' },
}

/**
 * 由 d3 取色后转为 UI 用三色：fill 高明低饱、stroke/accent 加深，
 * 对红/黄色相额外降饱和，避免与 error（红）和 pending（黄）混淆。
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

  // 红区：error 常用浅红底 — 压低饱和、略提亮
  if ((h >= 0 && h < 32) || h >= 348) {
    fillS *= 0.55
    strokeS *= 0.6
    accentS *= 0.65
    fillL = Math.max(fillL, 0.9)
  }
  // 黄区：pending 黄框 — 色相略推向琥珀、降低饱和
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

/** d3 原色更亮的版本：保留辨识度，不做“发灰”压暗。 */
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
  Think: '#6a3d9a',
  Clarify: '#a6cee3',
  Plan: '#33a02c',
  Permission: '#cab2d6',
  Subagent: '#ff7f00',
  Response: '#1f78b4',
  Read: '#b2df8a',
  Write: '#b15928',
  Shell: '#ffff99',
  Search: '#e31a1c',
  Skill: '#fdbf6f',
  Compaction: '#fb9a99',
}

const PAIRED_VIVID_7: Record<ActionType, string> = {
  Think: CONTRAST.Think.fill,
  Plan: CONTRAST.Think.fill,
  Clarify: '#FFE2B3',
  Permission: '#FFE2B3',
  Read: CONTRAST.Plan.fill,
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
    Think: obs[0]!,
    Clarify: obs[3]!,
    Plan: obs[2]!,
    Permission: obs[8]!,
    Subagent: obs[4]!,
    Response: obs[1]!,
    Read: obs[9]!,
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
  contrast: CONTRAST,
  spectrum: SPECTRUM,
  d3PairedVivid7: buildD3PairedVivid7(),
  d3Paired: buildD3Paired(false),
  d3PairedVivid: buildD3Paired(true),
  d3Observable: buildD3Observable(false),
  d3ObservableVivid: buildD3Observable(true),
  customUserA: (() => {
    /**
     * 用户给定 10 色 + 补充 2 色（确保 12 个 ActionType 全覆盖）
     * 给定：
     *  #BEEB9F #79D320 #ADD5F7 #3498DB #00305A
     *  #FFF176 #FA9600 #8B63A6 #9C27B0 #441A19
     * 补充：
     *  #00BFA5 #F06292
     */
    const baseByType: Record<ActionType, string> = {
      Think: '#BEEB9F',
      Clarify: '#79D320',
      Plan: '#ADD5F7',
      Permission: '#3498DB',
      Subagent: '#00305A',
      Response: '#FFF176',
      Read: '#FA9600',
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

export const DEFAULT_ACTION_TYPE_PALETTE_ID: ActionTypePaletteId = 'd3PairedVivid7'
