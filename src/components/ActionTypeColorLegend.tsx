import type { CSSProperties } from 'react'
import type { ActionTypePaletteId } from '../styles/actionTypePalettes'
import { getActionTypeTriad } from '../styles/actionTypePalettes'
import {
  ACTION_LEGEND_ROWS,
  ACTION_TYPE_DISPLAY_LABELS,
} from '../config/actionCategories'
import type { ActionType } from '../types/opencode'
import { getActionFlowIconSvg } from './actionFlowIcons'

const fontSans =
  "'PingFang SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"

const LEGEND_COLUMNS = 7

const labelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: '#2B2B2B',
  textAlign: 'center',
  fontFamily: fontSans,
  whiteSpace: 'nowrap',
  lineHeight: '14px',
  letterSpacing: 0,
  textTransform: 'none',
}

const swatchBoxStyle: CSSProperties = {
  width: 18,
  height: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
}

type Props = {
  paletteId: ActionTypePaletteId
}

/**
 * Two-row legend: 7 columns × 2 rows (`ACTION_LEGEND_ROWS`).
 * UserRequest is a hollow ring; other types use swatch + icon.
 */
export default function ActionTypeColorLegend({ paletteId }: Props) {
  const buildIconMarkup = (type: ActionType): string => {
    const raw = getActionFlowIconSvg(type)
    return raw.replace(/<svg\b/, '<svg width="12" height="12"')
  }

  const itemRows = ACTION_LEGEND_ROWS.map((rowTypes) =>
    rowTypes.map((type) => {
      const c = getActionTypeTriad(paletteId, type)
      return {
        key: type,
        label: ACTION_TYPE_DISPLAY_LABELS[type],
        fill: c.fill,
        stroke: c.stroke,
        icon: buildIconMarkup(type),
        iconColor: c.accent,
      }
    }),
  )

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '2px 0 8px',
      }}
    >
      {itemRows.map((row, rowIndex) => (
        <div
          key={`legend-row-${rowIndex}`}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${LEGEND_COLUMNS}, minmax(0, 1fr))`,
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
                minWidth: 0,
              }}
            >
              <div title={item.label} style={labelStyle}>
                {item.label}
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                {item.key === 'UserRequest' ? (
                  <span style={swatchBoxStyle}>
                    <span
                      title={`${item.label} · ${item.stroke}`}
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: '50%',
                        boxSizing: 'border-box',
                        background: 'transparent',
                        border: `2px solid ${item.stroke}`,
                        display: 'inline-block',
                      }}
                    />
                  </span>
                ) : (
                  <span
                    title={`${item.label} · ${item.fill}`}
                    style={{
                      ...swatchBoxStyle,
                      borderRadius: 3,
                      boxSizing: 'border-box',
                      background: item.fill,
                      border: `1.5px solid ${item.stroke}`,
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
