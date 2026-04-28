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
  variant?: 'default' | 'sankey-bars'
}

/**
 * 两行图例：第一行 action_type，第二行色块 / 符号（UserRequest 为空心圆环，无方框底）。
 */
export default function ActionTypeColorLegend({
  paletteId,
  variant = 'default',
}: Props) {
  const buildIconMarkup = (type: ActionType): string => {
    const raw = getActionFlowIconSvg(type)
    return raw.replace(/<svg\b/, '<svg width="12" height="12"')
  }
  const typeOrder: ActionType[] = [
    'UserRequest',
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
      label: type === 'UserRequest' ? 'user request' : type,
      fill: c.fill,
      stroke: c.stroke,
      icon: buildIconMarkup(type),
      iconColor: c.accent,
      sankeyBarColor: type === 'UserRequest' ? '#8F8F8F' : c.stroke,
    }
  })
  const items = typeItems
  const firstRowOrder: ActionType[] = [
    'UserRequest',
    'Think',
    'Plan',
    'Write',
    'Response',
    'Clarify',
    'Permission',
  ]
  const firstRowSet = new Set<ActionType>(firstRowOrder)
  const firstRowItems = firstRowOrder
    .map((type) => items.find((item) => item.key === type))
    .filter((item): item is (typeof items)[number] => Boolean(item))
  const secondRowItems = items.filter((item) => !firstRowSet.has(item.key))
  const itemRows = [firstRowItems, secondRowItems]

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
      {itemRows.map((row, rowIndex) => (
        <div
          key={`legend-row-${rowIndex}`}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${firstRowItems.length}, minmax(0, 1fr))`,
            columnGap: 8,
            alignItems: 'start',
            width: '100%',
          }}
        >
          {row.map((item) => (
            <div
              key={item.key}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
              }}
            >
              <div
                title={item.label}
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  color: '#2B2B2B',
                  textAlign: 'center',
                  fontFamily: fontSans,
                  whiteSpace: 'nowrap',
                  lineHeight: '12px',
                }}
              >
                {item.label}
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                {variant === 'sankey-bars' ? (
                  <span
                    title={`${item.label} · ${item.sankeyBarColor}`}
                    style={{
                      width: 18,
                      height: 10,
                      borderRadius: 2,
                      boxSizing: 'border-box',
                      background: item.sankeyBarColor,
                      flexShrink: 0,
                      display: 'inline-flex',
                    }}
                  />
                ) : item.key === 'UserRequest' ? (
                  <span
                    title={`${item.label} · ${item.stroke}`}
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      boxSizing: 'border-box',
                      background: 'transparent',
                      border: `2px solid ${item.stroke}`,
                      flexShrink: 0,
                      display: 'inline-block',
                    }}
                  />
                ) : (
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
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
