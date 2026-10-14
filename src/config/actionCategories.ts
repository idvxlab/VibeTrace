import type { ActionType } from '../types/opencode'

/**
 * VibeTrace / OpenCode primitive action taxonomy (7 categories).
 * `UserRequest` is cockpit UI-only and sits outside this schema.
 */
export type ActionCategory =
  | 'planning'
  | 'informationAcquisition'
  | 'codeModification'
  | 'communication'
  | 'skillManagement'
  | 'execution'
  | 'contextManagement'

export const ACTION_CATEGORY_ORDER: readonly ActionCategory[] = [
  'planning',
  'informationAcquisition',
  'codeModification',
  'communication',
  'skillManagement',
  'execution',
  'contextManagement',
] as const

export const ACTION_CATEGORY_LABELS: Record<ActionCategory, string> = {
  planning: 'Planning',
  informationAcquisition: 'Information acquisition',
  codeModification: 'Code modification',
  communication: 'Communication',
  skillManagement: 'Skill management',
  execution: 'Execution',
  contextManagement: 'Context management',
}

/** Palette group index 0..6; `UserRequest` is -1 (outside taxonomy). */
export const ACTION_TYPE_CATEGORY_INDEX: Record<ActionType, number> = {
  UserRequest: -1,
  Think: 0,
  Plan: 0,
  Read: 1,
  Search: 1,
  Write: 2,
  Response: 3,
  Clarify: 3,
  Permission: 3,
  SkillRouter: 4,
  Skill: 4,
  Shell: 5,
  Subagent: 5,
  Compaction: 6,
}

export const ACTION_TYPE_TO_CATEGORY: Record<Exclude<ActionType, 'UserRequest'>, ActionCategory> = {
  Think: 'planning',
  Plan: 'planning',
  Read: 'informationAcquisition',
  Search: 'informationAcquisition',
  Write: 'codeModification',
  Response: 'communication',
  Clarify: 'communication',
  Permission: 'communication',
  SkillRouter: 'skillManagement',
  Skill: 'skillManagement',
  Shell: 'execution',
  Subagent: 'execution',
  Compaction: 'contextManagement',
}

export const ACTION_TYPES_BY_CATEGORY: Record<ActionCategory, readonly ActionType[]> = {
  planning: ['Think', 'Plan'],
  informationAcquisition: ['Read', 'Search'],
  codeModification: ['Write'],
  communication: ['Response', 'Clarify', 'Permission'],
  skillManagement: ['SkillRouter', 'Skill'],
  execution: ['Shell', 'Subagent'],
  contextManagement: ['Compaction'],
}

/** Action types in taxonomy order (legend / optional display; does not replace `ACTION_TYPE_ORDER`). */
export const ACTION_TYPES_IN_CATEGORY_ORDER: readonly ActionType[] = [
  'UserRequest',
  ...ACTION_CATEGORY_ORDER.flatMap((c) => ACTION_TYPES_BY_CATEGORY[c]),
]

/** Human-readable legend labels (Title Case, spaced compounds). */
export const ACTION_TYPE_DISPLAY_LABELS: Record<ActionType, string> = {
  UserRequest: 'User Request',
  Think: 'Think',
  Plan: 'Plan',
  Clarify: 'Clarify',
  Permission: 'Permission',
  Subagent: 'Subagent',
  Response: 'Response',
  Read: 'Read',
  SkillRouter: 'Skill Router',
  Write: 'Write',
  Shell: 'Shell',
  Search: 'Search',
  Skill: 'Skill',
  Compaction: 'Compaction',
}

/**
 * Legend layout: 14 types, 7 per row.
 * Row 1 — User Request, Think, Plan, Response, Clarify, Permission, Write
 * Row 2 — Read, Search, Skill Router, Skill, Shell, Subagent, Compaction
 */
export const ACTION_LEGEND_ROWS: readonly (readonly ActionType[])[] = [
  [
    'UserRequest',
    'Think',
    'Plan',
    'Response',
    'Clarify',
    'Permission',
    'Write',
  ],
  [
    'Read',
    'Search',
    'SkillRouter',
    'Skill',
    'Shell',
    'Subagent',
    'Compaction',
  ],
] as const

export function getActionCategory(actionType: ActionType): ActionCategory | null {
  if (actionType === 'UserRequest') return null
  return ACTION_TYPE_TO_CATEGORY[actionType]
}
