import { useRef, useEffect, useMemo } from 'react'
import * as d3 from 'd3'
import type { OcMessage } from '../types/opencode'
import type { FlowEvent } from '../types/opencode'

interface EventFlowChartProps {
  messages: OcMessage[]
  todoContent: string
}

type BarDatum = FlowEvent & { x: number; width: number }

// Classify tool names into event categories
function classifyTool(toolName: string): FlowEvent['type'] {
  const t = toolName.toLowerCase()
  if (t.includes('write') || t.includes('edit') || t.includes('replace') || t.includes('create')) return 'file-write'
  if (t.includes('bash') || t.includes('execute') || t.includes('sh')) return 'bash'
  return 'tool'
}

// Extract flow events from all messages
function extractEvents(messages: OcMessage[]): FlowEvent[] {
  const events: FlowEvent[] = []

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === 'reasoning') {
        events.push({
          type: 'thinking',
          label: '思考',
          timestamp: part.time?.start || msg.info.time.created,
          duration: part.time ? (part.time.end - part.time.start) / 1000 : undefined,
        })
      } else if (part.type === 'tool') {
        events.push({
          type: classifyTool(part.tool),
          label: part.tool,
          timestamp: msg.info.time.created,
          toolName: part.tool,
        })
      } else if (part.type === 'text' && msg.info.role === 'assistant') {
        events.push({
          type: 'text',
          label: '回复',
          timestamp: msg.info.time.created,
        })
      } else if (part.type === 'step-start') {
        events.push({
          type: 'step',
          label: 'step',
          timestamp: msg.info.time.created,
        })
      }
    }
  }

  return events
}

const colorMap: Record<FlowEvent['type'], string> = {
  thinking: 'var(--color-event-thinking)',
  tool: 'var(--color-event-tool)',
  'file-write': 'var(--color-event-file-write)',
  bash: 'var(--color-event-bash)',
  error: 'var(--color-event-error)',
  text: 'var(--color-event-text)',
  step: 'var(--color-border)',
}

export default function EventFlowChart({ messages, todoContent: _todoContent }: EventFlowChartProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const events = useMemo(() => extractEvents(messages), [messages])

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || events.length === 0) return

    const container = containerRef.current
    const width = container.clientWidth
    const height = 28

    // Clear previous
    d3.select(svgRef.current).selectAll('*').remove()

    const svg = d3.select(svgRef.current)
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`)

    const barHeight = 20
    const barY = (height - barHeight) / 2
    const gap = 1.5

    // Calculate bar widths proportional to duration or fixed
    let totalDuration = 0
    const durations = events.map(e => {
      if (e.duration && e.duration > 0) {
        return e.duration
      }
      return 1 // default unit
    })
    totalDuration = durations.reduce((a, b) => a + b, 0)

    const availableWidth = width - (events.length - 1) * gap

    let x = 0
    const bars: BarDatum[] = events.map((event, i) => {
      const w = Math.max(2, (durations[i]! / totalDuration) * availableWidth)
      const bar: BarDatum = { ...event, x, width: w }
      x += w + gap
      return bar
    })

    // Draw bars
    const g = svg.append('g')

    g.selectAll('rect')
      .data(bars)
      .join('rect')
      .attr('x', d => d.x)
      .attr('y', barY)
      .attr('width', d => d.width)
      .attr('height', barHeight)
      .attr('rx', 2)
      .attr('fill', d => colorMap[d.type] || 'var(--color-border)')
      .attr('opacity', d => d.type === 'step' ? 0.3 : 0.85)
      .style('cursor', 'pointer')

    // Tooltip on hover
    const tooltip = d3.select(container)
      .append('div')
      .style('position', 'absolute')
      .style('background', 'var(--color-bg-tertiary)')
      .style('border', '1px solid var(--color-border)')
      .style('border-radius', '6px')
      .style('padding', '4px 8px')
      .style('font-size', '11px')
      .style('font-family', 'var(--font-mono)')
      .style('color', 'var(--color-text-primary)')
      .style('pointer-events', 'none')
      .style('opacity', 0)
      .style('z-index', 50)

    g.selectAll<SVGRectElement, BarDatum>('rect')
      .on('mouseenter', (_event, d) => {
        tooltip
          .style('opacity', 1)
          .html(`<strong>${d.label}</strong>${d.duration ? ` · ${d.duration.toFixed(1)}s` : ''}`)
      })
      .on('mousemove', (event) => {
        tooltip
          .style('left', `${event.offsetX}px`)
          .style('top', `${event.offsetY - 32}px`)
      })
      .on('mouseleave', () => {
        tooltip.style('opacity', 0)
      })

    return () => {
      tooltip.remove()
    }
  }, [events])

  if (events.length === 0) {
    return (
      <div className="text-[10px] text-text-muted italic">
        暂无事件数据
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: 28 }}>
      <svg ref={svgRef} className="w-full" />
    </div>
  )
}
