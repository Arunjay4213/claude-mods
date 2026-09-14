import type { SessionRateLimit } from 'claude-code'

// The numbers behind the meter: keeping samples, the burn rate over them, and
// the text both surfaces draw. Nothing here touches `$`, so a failure in the
// engine can never reach it.

/** One reading of one window: when it was taken and what it read. */
export type Sample = { atMs: number; percentUsed: number; resetsAt?: string }

/** Every window's kept readings, by `kind` (`five_hour`, `seven_day`, ...). */
export type Samples = Record<string, Sample[]>

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** How long a window lasts, so samples from before it can be dropped. */
export const windowMsOf = (kind: string): number =>
  kind === 'five_hour' ? 5 * HOUR_MS : 7 * DAY_MS

const LONG_LABEL: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: '7-day limit',
  spend_limit: 'spend limit',
}

const SHORT_LABEL: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'spend',
}

const ORDER = ['five_hour', 'seven_day', 'spend_limit']

/** Readings older than this many per window are dropped, oldest first. */
const MAX_SAMPLES = 240

/**
 * A slope needs the samples to span this much of the window before it means
 * anything. The percent is reported as a whole number, so a single point of
 * movement over a few minutes reads as a huge rate per hour; a fifth of an
 * hour into the 5-hour window, or 8.4 hours into the 7-day one, is enough for
 * one tick to be a small part of the span instead of all of it.
 */
const PROJECTION_SPAN_FRACTION = 0.05

/** A percent that fell by more than this says the window reset. */
const RESET_DROP = 0.5

/** Reads back what the store holds, dropping anything that is not a sample. */
export function samplesOf(stored: unknown): Samples {
  if (typeof stored !== 'object' || stored === null) return {}
  const out: Samples = {}
  for (const [kind, rows] of Object.entries(stored as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue
    const kept = rows.filter(
      (row): row is Sample =>
        typeof row === 'object' &&
        row !== null &&
        Number.isFinite((row as Sample).atMs) &&
        Number.isFinite((row as Sample).percentUsed) &&
        ((row as Sample).resetsAt === undefined || typeof (row as Sample).resetsAt === 'string'),
    )
    if (kept.length > 0) out[kind] = kept
  }
  return out
}

/**
 * Adds a reading to a window's kept samples. A percent that dropped means the
 * window reset, so the older samples belong to a window that is gone; samples
 * from before the current window started are dropped too.
 */
export function addSample(
  kept: readonly Sample[],
  next: Sample,
  windowMs: number,
): Sample[] {
  const last = kept[kept.length - 1]
  // Two signs of a new window: the reset time moved, or the percent fell. The
  // first catches a reset that happened while Claude Code was closed and the
  // new window already reads higher than the old one did.
  const isReset =
    last !== undefined &&
    ((last.resetsAt !== undefined && next.resetsAt !== undefined && last.resetsAt !== next.resetsAt) ||
      next.percentUsed < last.percentUsed - RESET_DROP)
  const floor = next.atMs - windowMs
  const fresh = isReset ? [] : kept.filter(s => s.atMs >= floor && s.atMs < next.atMs)
  const rows = [...fresh, next]
  return rows.slice(Math.max(0, rows.length - MAX_SAMPLES))
}

/** The burn rate: the straight first-to-last slope over the kept samples. */
export type Burn = { percentPerHour: number; spanMs: number }

export function burnOf(samples: readonly Sample[], windowMs: number): Burn | null {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (first === undefined || last === undefined || samples.length < 2) return null
  const spanMs = last.atMs - first.atMs
  if (spanMs < windowMs * PROJECTION_SPAN_FRACTION) return null
  return {
    percentPerHour: ((last.percentUsed - first.percentUsed) / spanMs) * HOUR_MS,
    spanMs,
  }
}

/** One window, ready to draw. */
export type Row = {
  kind: string
  title: string
  short: string
  percentUsed: number
  resetMs: number | null
  untilResetMs: number | null
  burn: Burn | null
  fullInMs: number | null
}

const parsedMs = (iso: string | undefined): number | null => {
  if (typeof iso !== 'string') return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

export function rowsOf(
  limits: readonly SessionRateLimit[],
  samples: Samples,
  nowMs: number,
): Row[] {
  const rows = limits.map((limit): Row => {
    // the API reports whole percent, but not always exactly (7.000000000000001)
    const percentUsed = Math.round(limit.percentUsed)
    const burn = burnOf(samples[limit.kind] ?? [], windowMsOf(limit.kind))
    const resetMs = parsedMs(limit.resetsAt)
    const left = 100 - percentUsed
    return {
      kind: limit.kind,
      title: LONG_LABEL[limit.kind] ?? limit.kind,
      short: SHORT_LABEL[limit.kind] ?? limit.kind,
      percentUsed,
      resetMs,
      untilResetMs: resetMs === null ? null : Math.max(0, resetMs - nowMs),
      burn,
      fullInMs:
        burn === null || burn.percentPerHour <= 0
          ? null
          : Math.max(0, (left / burn.percentPerHour) * HOUR_MS),
    }
  })
  const rank = (kind: string) => {
    const at = ORDER.indexOf(kind)
    return at === -1 ? ORDER.length : at
  }
  return rows.sort((a, b) => rank(a.kind) - rank(b.kind))
}

/** `1h12m`, `42m`, `2d 3h`: a length of time, never negative. */
export function durationOf(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${minutes}m`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `15:30`, or `Sun 02:00` when the moment is far enough off to need the day. */
export function clockOf(ms: number, withDay = false): string {
  const at = new Date(ms)
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return withDay ? `${DAYS[at.getDay()] ?? ''} ${time}`.trim() : time
}

/** The filled bar for a percent, exactly `cells` characters wide. */
export function barOf(percent: number, cells: number): string {
  const width = Math.max(4, Math.floor(cells))
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.max(0, Math.min(width, Math.round((clamped / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Green while there is room, yellow past half, red near the limit. */
export const colorOf = (percent: number): string =>
  percent >= 80 ? 'red' : percent >= 50 ? 'yellow' : 'green'

/** The window that fills first at this pace, if any fills before it resets. */
function soonestFull(rows: readonly Row[]): Row | null {
  let best: Row | null = null
  for (const row of rows) {
    if (row.fullInMs === null) continue
    if (row.untilResetMs !== null && row.fullInMs >= row.untilResetMs) continue
    if (best === null || row.fullInMs < (best.fullInMs ?? Infinity)) best = row
  }
  return best
}

export const NO_LIMITS_STATUS = 'no plan limits reported yet'

const STATUS_MAX = 80

/** The one line pinned under the prompt. */
export function statusOf(rows: readonly Row[]): string {
  if (rows.length === 0) return NO_LIMITS_STATUS
  const parts = rows.map((row, at) => {
    const percent = `${row.short} ${row.percentUsed}%`
    const resets =
      at === 0 && row.untilResetMs !== null
        ? ` (resets ${durationOf(row.untilResetMs)})`
        : ''
    return `${percent}${resets}`
  })
  const full = soonestFull(rows)
  // a window still collecting is left out of the tail rather than hiding the
  // windows that do have a rate: the 7-day one collects for hours, and the
  // 5-hour projection is the line's whole point
  const isCollecting = rows.every(row => row.burn === null)
  const tail = full
    ? `${full.short} full in ~${durationOf(full.fullInMs ?? 0)}`
    : isCollecting
      ? 'collecting burn rate'
      : 'nothing hits 100% before reset'
  const line = [...parts, tail].join(' · ')
  if (line.length <= STATUS_MAX) return line
  const short = parts.join(' · ')
  return short.length <= STATUS_MAX ? short : `${short.slice(0, STATUS_MAX - 1)}…`
}

/** The three detail lines a pane block draws under its bar. */
export function detailOf(row: Row): [string, string, string] {
  const reset =
    row.resetMs === null
      ? 'no reset time reported'
      : `resets ${clockOf(row.resetMs, (row.untilResetMs ?? 0) > DAY_MS - 4 * HOUR_MS)}, in ${durationOf(row.untilResetMs ?? 0)}`
  const burn =
    row.burn === null
      ? `burn rate: collecting (needs samples over ${durationOf(windowMsOf(row.kind) * PROJECTION_SPAN_FRACTION)})`
      : `burn ${row.burn.percentPerHour.toFixed(1)}%/h over the last ${durationOf(row.burn.spanMs)}`
  const projection =
    row.burn === null
      ? 'projection: collecting'
      : row.fullInMs === null
        ? 'projection: steady, not rising'
        : row.untilResetMs !== null && row.fullInMs >= row.untilResetMs
          ? 'projection: resets first'
          : `projection: 100% in ~${durationOf(row.fullInMs)}`
  return [reset, burn, projection]
}

/** Rows the pane asks for while it sits inline above the prompt. */
export const paneRowsOf = (count: number): number =>
  Math.max(7, Math.min(26, count * 6 + 2))
