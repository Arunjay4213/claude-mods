// Numbers into the short strings the status line and the /ledger table show,
// plus the table layout that drops columns when the pane is narrow.

/** One finished turn, as the ledger keeps it (and mirrors into `$.store`). */
export type Row = {
  /** Turn number within this session, 1 upwards. */
  n: number
  /** Short model name, e.g. "opus-4-5". */
  model: string
  inTok: number
  outTok: number
  cacheRead: number
  cacheWrite: number
  /** Wall clock length of the turn, milliseconds. */
  ms: number
  /** Dollars this turn added to the session cost; null when unknown. */
  usd: number | null
  /** True for a subagent's turn (`e.agentId` was set). */
  sub: boolean
}

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0

/** Rebuilds a Row from whatever the store gave back, or null if it is not one. */
export function rowOf(value: unknown): Row | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Record<string, unknown>
  if (typeof r['n'] !== 'number') return null
  const usd = r['usd']
  return {
    n: r['n'],
    model: typeof r['model'] === 'string' ? r['model'] : '?',
    inTok: num(r['inTok']),
    outTok: num(r['outTok']),
    cacheRead: num(r['cacheRead']),
    cacheWrite: num(r['cacheWrite']),
    ms: num(r['ms']),
    usd: typeof usd === 'number' && Number.isFinite(usd) ? usd : null,
    sub: r['sub'] === true,
  }
}

/** "claude-opus-4-5-20251101" -> "opus-4-5"; anything unexpected is left alone. */
export function shortModel(id: string): string {
  const at = id.lastIndexOf('claude-')
  const base = at >= 0 ? id.slice(at + 'claude-'.length) : id
  const cut = base.replace(/-\d{6,8}$/, '').replace(/-v\d+(:\d+)?$/, '')
  return cut === '' ? id : cut
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-'
  if (n < 1000) return String(Math.round(n))
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1e6) return `${Math.round(n / 1000)}k`
  return `${(n / 1e6).toFixed(1)}M`
}

/** Dollars, with enough decimals that a cheap turn is not shown as $0.00. */
export function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '-'
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}m${String(s).padStart(2, '0')}s`
}

/** cache_read over everything the request was answered from; null when nothing was. */
export function hitOf(inTok: number, read: number, write: number): number | null {
  const total = inTok + read + write
  return total > 0 ? Math.round((read / total) * 100) : null
}

const pct = (v: number | null): string => (v === null ? '-' : `${v}%`)

const sum = (rows: readonly Row[], of: (r: Row) => number): number =>
  rows.reduce((total, r) => total + of(r), 0)

const sumUsd = (rows: readonly Row[]): number | null => {
  const priced = rows.filter(r => r.usd !== null)
  return priced.length === 0 ? null : sum(priced, r => r.usd ?? 0)
}

/** The one line pinned under the prompt. Parts that have no figure are left out. */
export function statusText(
  rows: readonly Row[],
  sessionUsd: number | null,
): string {
  const last = rows.at(-1)
  const parts: string[] = []

  if (sessionUsd !== null) parts.push(`${fmtUsd(sessionUsd)} session`)

  if (!last) {
    parts.push('no turns yet - /ledger')
    return parts.join(' · ')
  }

  if (last.usd !== null) parts.push(`last turn ${fmtUsd(last.usd)}`)

  // "in" here is everything the answer was read over - fresh input, cache
  // reads and cache writes - which is the figure the cache share is of.
  const readOver = last.inTok + last.cacheRead + last.cacheWrite
  parts.push(`${fmtTokens(readOver)} in / ${fmtTokens(last.outTok)} out`)

  const hit = hitOf(last.inTok, last.cacheRead, last.cacheWrite)
  if (hit !== null) parts.push(`cache ${hit}%`)

  const line = parts.join(' · ')
  return line.length <= 78 ? line : `${line.slice(0, 77)}…`
}

type ColDef = {
  key: string
  head: string
  /** Higher is kept longer when the pane is too narrow for every column. */
  pri: number
  left?: true
  cell: (r: Row) => string
  total: (rows: readonly Row[]) => string
}

const COLS: readonly ColDef[] = [
  { key: 'n', head: '#', pri: 3, cell: r => `${r.n}${r.sub ? '*' : ''}`, total: () => 'all' },
  { key: 'model', head: 'model', pri: 4, left: true, cell: r => r.model, total: () => '' },
  { key: 'in', head: 'in', pri: 9, cell: r => fmtTokens(r.inTok), total: rs => fmtTokens(sum(rs, r => r.inTok)) },
  { key: 'out', head: 'out', pri: 8, cell: r => fmtTokens(r.outTok), total: rs => fmtTokens(sum(rs, r => r.outTok)) },
  { key: 'cread', head: 'cache r', pri: 6, cell: r => fmtTokens(r.cacheRead), total: rs => fmtTokens(sum(rs, r => r.cacheRead)) },
  { key: 'cwrite', head: 'cache w', pri: 2, cell: r => fmtTokens(r.cacheWrite), total: rs => fmtTokens(sum(rs, r => r.cacheWrite)) },
  { key: 'hit', head: 'hit', pri: 5, cell: r => pct(hitOf(r.inTok, r.cacheRead, r.cacheWrite)), total: rs => pct(hitOf(sum(rs, r => r.inTok), sum(rs, r => r.cacheRead), sum(rs, r => r.cacheWrite))) },
  { key: 'time', head: 'time', pri: 1, cell: r => fmtMs(r.ms), total: rs => fmtMs(sum(rs, r => r.ms)) },
  { key: 'cost', head: 'cost', pri: 10, cell: r => fmtUsd(r.usd), total: rs => fmtUsd(sumUsd(rs)) },
]

const pad = (text: string, width: number, left: boolean): string =>
  left ? text.padEnd(width) : text.padStart(width)

export type Table = {
  head: string
  body: string[]
  totals: string
}

/**
 * Lays the rows out as fixed-width columns inside `columns` cells, newest
 * first, dropping the least important column until the widest line fits.
 *
 * @param rows every turn kept, oldest first
 * @param shown the newest turns to draw
 * @param columns the pane body's width
 */
export function table(
  rows: readonly Row[],
  shown: readonly Row[],
  columns: number,
): Table {
  const sized = COLS.map(c => {
    const cells = shown.map(c.cell)
    const tot = c.total(rows)
    const w = Math.max(c.head.length, tot.length, ...cells.map(s => s.length), 1)
    return { def: c, w, cells, tot }
  })

  const kept = new Set(sized.map(c => c.def.key))
  const widthOf = () =>
    sized
      .filter(c => kept.has(c.def.key))
      .reduce((total, c, i) => total + c.w + (i === 0 ? 0 : 1), 0)

  for (const c of [...sized].sort((a, b) => a.def.pri - b.def.pri)) {
    if (kept.size <= 1 || widthOf() <= columns) break
    kept.delete(c.def.key)
  }

  const drawn = sized.filter(c => kept.has(c.def.key))

  const line = (of: (c: (typeof drawn)[number], i: number) => string) =>
    drawn.map((c, i) => pad(of(c, i), c.w, c.def.left === true)).join(' ')

  return {
    head: line(c => c.def.head),
    body: shown.map((_, row) => line(c => c.cells[row] ?? '')),
    totals: line((c, i) => (c.tot === '' && i === 0 ? 'all' : c.tot)),
  }
}
