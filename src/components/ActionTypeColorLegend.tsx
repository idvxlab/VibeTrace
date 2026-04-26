import type { ActionTypePaletteId } from '../styles/actionTypePalettes'
import {
  getActionTypeTriad,
} from '../styles/actionTypePalettes'
import type { ActionType } from '../types/opencode'
import { getActionFlowIconSvg } from './actionFlowIcons'

const fontSans =
  "'PingFang SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"

type Props = {
  paletteId: ActionTypePaletteId
}

/**
 * 两行图例：第一行 action_type，第二行颜色方块。
 */
export default function ActionTypeColorLegend({
  paletteId,
}: Props) {
  const buildIconMarkup = (type: ActionType): string => {
    const raw = getActionFlowIconSvg(type)
    return raw.replace(/<svg\b/, '<svg width="12" height="12"')
  }
  const typeOrder: ActionType[] = [
    'Think',
    'Plan',
    'Clarify',
    'Permission',
    'Read',
    'Search',
    'Shell',
    'Write',
    'Response',
    'Skill',
    'Compaction',
    'Subagent',
  ]
  const typeItems = typeOrder.map((type) => {
    const c = getActionTypeTriad(paletteId, type)
    return {
      key: type,
      label: type,
      fill: c.fill,
      stroke: c.stroke,
      icon: buildIconMarkup(type),
      iconColor: c.accent,
    }
  })
  const items = typeItems

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '6px 0 8px',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: '#6A6A6A',
            fontFamily: fontSans,
            whiteSpace: 'nowrap',
          }}
        >
          Legend (Action Type)
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`,
          columnGap: 4,
          rowGap: 2,
          alignItems: 'center',
          width: '100%',
        }}
      >
        {items.map((item) => (
          <div
            key={`${item.key}-label`}
            title={item.label}
            style={{
              fontSize: 9,
              fontWeight: 600,
              color: '#2B2B2B',
              textAlign: 'center',
              fontFamily: fontSans,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              lineHeight: '12px',
            }}
          >
            {item.label}
          </div>
        ))}
        {items.map((item) => (
          <div
            key={`${item.key}-color`}
            style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}
          >
            <span
              title={`${item.label} · ${item.fill}`}
              style={{
                width: 18,
                height: 18,
                borderRadius: 3,
                boxSizing: 'border-box',
                background: item.fill,
                border: `1.5px solid ${item.stroke}`,
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {item.icon ? (
                <span
                  style={{
                    width: 12,
                    height: 12,
                    lineHeight: 0,
                    color: item.iconColor,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'none',
                  }}
                  dangerouslySetInnerHTML={{ __html: item.icon }}
                />
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
