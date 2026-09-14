// Plain formatting helpers for the status line and the pane. No engine calls here,
// so nothing in this file can fail a session.

/** `68412` as `68.4k`, `1240000` as `1.2M`; small numbers as they are. */
export function tokens(n: number): string {
  const v = Math.round(n)
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (Math.abs(v) >= 100_000) return `${Math.round(v / 1000)}k`
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`
  return String(v)
}

/** The same, with a sign kept: `+4.2k`, `-1.1k`, `0`. */
export function signed(n: number): string {
  if (Math.round(n) === 0) return '0'
  return n > 0 ? `+${tokens(n)}` : `-${tokens(-n)}`
}

/** Pads or clips `text` to exactly `width` cells. */
export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length === width) return text
  if (text.length < width) return text + ' '.repeat(width - text.length)
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`
}

/** Right-aligns `text` in `width` cells. */
export function right(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

/** How many of `width` cells a share of `0..1` fills; a non-zero share always shows one. */
export function filledCells(share: number, width: number): number {
  if (!(share > 0) || width <= 0) return 0
  return Math.min(width, Math.max(1, Math.round(share * width)))
}
