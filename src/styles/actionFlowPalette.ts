/**
 * Action-flow status colors, end node, and arrows (roughly aligned with Figma design).
 * Completed/running avoids green so it stays distinct from the action-type palette.
 */
export const actionFlowPalette = {
  /** Completed (neutral gray-blue) */
  completed: {
    fill: '#EEF2F6',
    stroke: '#9CA8B8',
    icon: '#3D4F63',
  },
  /** Running (cool blue, distinct from pending yellow) */
  running: {
    fill: '#E3F0FA',
    stroke: '#6AB0E0',
    icon: '#1E6BA8',
  },
  /** Error (high-saturation red for visibility at a glance) */
  red: {
    fill: '#FF2D2D',
    stroke: '#AA0000',
    icon: '#FFFFFF',
  },
  /** Pending (high-saturation amber-yellow, strong contrast to red) */
  pending: {
    fill: '#FFD600',
    stroke: '#B87700',
    icon: '#4A2E00',
  },
  /** End node (terminal output) */
  end: {
    fill: '#FFE082',
    stroke: '#D8A40A',
  },
  /** Connector lines and arrowheads */
  arrow: '#5B6F82',
} as const
