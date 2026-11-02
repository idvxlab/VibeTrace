/** Ensures only one click-pinned action-flow tip is open across all trajectory panels. */

const EVENT = 'vt-action-flow-pinned-tip'

type Detail = { ownerId: string }

export function claimActionFlowPinnedTip(ownerId: string): void {
  if (typeof document === 'undefined') return
  document.dispatchEvent(
    new CustomEvent<Detail>(EVENT, { detail: { ownerId } }),
  )
}

export function subscribeActionFlowPinnedTip(
  ownerId: string,
  onForeignClaim: () => void,
): () => void {
  if (typeof document === 'undefined') return () => {}
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent<Detail>).detail
    if (!detail || detail.ownerId === ownerId) return
    onForeignClaim()
  }
  document.addEventListener(EVENT, handler)
  return () => document.removeEventListener(EVENT, handler)
}
