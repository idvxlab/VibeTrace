/**
 * Action 流：状态色、终点、箭头（与 Figma 大体对齐；已完成/运行中不再使用绿色以免与 type 盘混淆）
 */
export const actionFlowPalette = {
  /** 已完成（中性灰蓝） */
  completed: {
    fill: '#EEF2F6',
    stroke: '#9CA8B8',
    icon: '#3D4F63',
  },
  /** 运行中（冷蓝，区别于 pending 黄） */
  running: {
    fill: '#E3F0FA',
    stroke: '#6AB0E0',
    icon: '#1E6BA8',
  },
  /** 错误（大红：高饱和实心红，远距离也醒目） */
  red: {
    fill: '#FF2D2D',
    stroke: '#AA0000',
    icon: '#FFFFFF',
  },
  /** 待处理（大黄：高饱和琥珀黄，与红色形成强对比） */
  pending: {
    fill: '#FFD600',
    stroke: '#B87700',
    icon: '#4A2E00',
  },
  /** 终点圆（最终产出） */
  end: {
    fill: '#FFE082',
    stroke: '#D8A40A',
  },
  /** 折线与箭头 */
  arrow: '#5B6F82',
} as const
