/* @jsx h */
import type {
  EngineInterface,
  Register,
  SessionContextBreakdown,
  ContextCategory,
} from 'claude-code'

import { fit, filledCells, right, signed, tokens } from './format'

// context-lens: a live /context.
//
// A pinned line under the prompt carries the window fill and what the last turn added;
// `/context-lens` opens a pane with the same figures broken down by category. Every
// reading comes from `$.session.usage`, asked with `breakdown: "summary"` (free, local)
// after each turn, and with `"full"` only when the user runs `/context-lens refresh`.

const PANE_ID = 'context-lens'
const COMMAND = 'context-lens'
const HISTORY_MAX = 24
const AVERAGE_OVER = 5
const STATUS_MAX = 70
const BAR_MAX = 48

type Snapshot = {
  used: number
  window: number
  percent: number
  /** The token count the headroom is measured against. */
  threshold: number
  /** Where that figure came from: the engine's own threshold, the compaction window, or the plain window. */
  limit: 'auto-compact' | 'compaction-window' | 'window'
  breakdown: SessionContextBreakdown | null
  detail: 'summary' | 'full'
}

let snap: Snapshot | null = null
/** Tokens in the window after each finished turn, since the last compaction. */
let history: number[] = []
let paneOpen = false
/** True from a compaction or /clear until the next answer gives a fresh reading. */
let awaitingReading = false

/** Reads the window. Keeps the last good snapshot when the call fails. */
async function read($: EngineInterface, detail: 'summary' | 'full'): Promise<void> {
  let context
  try {
    context = (await $.session.usage({ breakdown: detail })).context
  } catch {
    return
  }
  const breakdown = context.breakdown ?? snap?.breakdown ?? null
  const used = context.tokens ?? breakdown?.totalTokens
  const window = context.window || breakdown?.rawMaxTokens || 0
  if (used === undefined || window <= 0) return
  const auto =
    breakdown && breakdown.isAutoCompactEnabled ? breakdown.autoCompactThreshold : undefined
  snap = {
    used,
    window,
    percent: context.percent ?? Math.round((used / window) * 100),
    threshold: auto ?? breakdown?.rawMaxTokens ?? window,
    limit: auto !== undefined ? 'auto-compact' : breakdown ? 'compaction-window' : 'window',
    breakdown,
    detail: context.breakdown ? detail : (snap?.detail ?? detail),
  }
}

/** What the last turn added, and the average of the recent turns that grew. */
function growth(): { last?: number; average?: number; over: number } {
  const deltas: number[] = []
  for (let i = 1; i < history.length; i++) deltas.push((history[i] ?? 0) - (history[i - 1] ?? 0))
  const rising = deltas.filter(d => d > 0).slice(-AVERAGE_OVER)
  const average = rising.length
    ? rising.reduce((a, b) => a + b, 0) / rising.length
    : undefined
  return { last: deltas.at(-1), average, over: rising.length }
}

/** Turns of the recent average that still fit before the threshold. */
function turnsLeft(average: number | undefined): number | undefined {
  if (!snap || average === undefined || average <= 0) return undefined
  return Math.max(0, Math.floor((snap.threshold - snap.used) / average))
}

/** `3 turns`, and `99+ turns` past a hundred: a five-digit count says nothing useful. */
function turnCount(n: number): string {
  return n > 99 ? '99+ turns' : `${n} turn${n === 1 ? '' : 's'}`
}

function statusText(): string {
  // The line is pinned from the session's first moment, even before a reading exists.
  if (!snap) return awaitingReading ? 'ctx waiting for the next answer' : 'ctx waiting for the first answer'
  const parts = [`ctx ${snap.percent}%`, `${tokens(snap.used)}/${tokens(snap.window)}`]
  const { last, average } = growth()
  if (last !== undefined) parts.push(`${signed(last)} last turn`)
  const left = turnsLeft(average)
  const edge = snap.limit === 'auto-compact' ? 'compact' : 'full'
  if (left !== undefined) {
    parts.push(left === 0 ? `${edge} next turn` : `${turnCount(left)} to ${edge}`)
  }
  const line = parts.join(' · ')
  return line.length > STATUS_MAX ? `${line.slice(0, STATUS_MAX - 1)}…` : line
}

/** Pins the line and redraws the pane, if it is open. Never throws. */
function show($: EngineInterface): void {
  try {
    $.ui.status(statusText())
  } catch {
    /* a status line that will not pin costs nothing else */
  }
  if (!paneOpen) return
  try {
    $.ui.invalidate('ui.render')
  } catch {
    /* the next turn redraws it */
  }
}

/** Used rows biggest first, then the compaction buffer, then the free space. */
function rowsOf(breakdown: SessionContextBreakdown): ContextCategory[] {
  const rank = (c: ContextCategory) => (c.kind === 'free' ? 2 : c.kind === 'buffer' ? 1 : 0)
  return breakdown.categories
    .filter(c => !c.isDeferred && c.tokens > 0)
    .sort((a, b) => rank(a) - rank(b) || b.tokens - a.tokens)
}

/**
 * After a compaction or /clear the window was rewritten: the old reading and the
 * old per-turn growth say nothing about the new one. The engine reports no token
 * count until the next answer, so the line says it is waiting rather than showing
 * the stale figures as current.
 */
async function forget($: EngineInterface): Promise<void> {
  snap = null
  history = []
  awaitingReading = true
  await read($, 'summary')
  // read() may have set snap again; the cast tells the type checker so. The
  // growth history restarts from the next finished turn, as at session start.
  if ((snap as Snapshot | null) !== null) awaitingReading = false
  show($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Live /context: the window by category, growth per turn, turns to compaction',
        argumentHint: '[refresh]',
      })
    } catch (error) {
      $.ui.log(`context-lens: /${COMMAND} not registered: ${String(error)}`)
    }
    // The reading at start is the engine's estimate of the window; the growth
    // history starts from the first finished turn, so a real count is never
    // compared against an estimate.
    await read($, 'summary')
    show($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's turn is answered over its own window, not this one.
    if (e.agentId !== undefined) return result
    await read($, 'summary')
    if (snap) {
      awaitingReading = false
      history.push(snap.used)
      if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX)
    }
    show($)
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await forget($)
    return result
  })

  on('command.run', { command: 'clear' }, async ($, e, next) => {
    const result = await next(e)
    await forget($)
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    if (e.args.trim().toLowerCase() === 'refresh') {
      await read($, 'full')
      if (!paneOpen) {
        try {
          await $.ui.open({ id: PANE_ID, title: 'Context lens', rows: 18 })
          paneOpen = true
        } catch {
          /* fall through: the counted figures still land on the status line */
        }
      }
      show($)
      return { text: 'counted with the token-count API' }
    }
    if (paneOpen) {
      try {
        await $.ui.close({ id: PANE_ID })
      } catch {
        return { text: 'the pane would not close' }
      }
      paneOpen = false
      return { text: 'pane closed' }
    }
    if (!snap) await read($, 'summary')
    try {
      await $.ui.open({ id: PANE_ID, title: 'Context lens', rows: 18 })
    } catch (error) {
      return { text: `the pane would not open (${String(error)})` }
    }
    paneOpen = true
    show($)
    return { text: 'pane open - /context-lens closes it, /context-lens refresh counts exactly' }
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    paneOpen = false
    return result
  })

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    // Being asked to draw is proof the pane is open: after a hot reload this is how the
    // module learns it again, so the toggle and the per-turn redraw stay in step.
    paneOpen = true
    const { Box, Text } = $.ui.resolve(e)
    const columns = Math.max(24, e.props.bodyColumns)

    if (!snap) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No reading of the context window yet. It arrives with the first answer.</Text>
        </Box>
      )
    }

    // label, bar, tokens, percent. The bar takes what is left, and stops growing past
    // BAR_MAX so a docked pane on a wide screen does not draw a bar the width of the screen.
    const labelW = Math.min(19, Math.max(7, columns - 26))
    const barW = Math.min(BAR_MAX, Math.max(4, columns - labelW - 14))
    const { last, average, over } = growth()
    const left = turnsLeft(average)
    const breakdown = snap.breakdown
    const base = breakdown?.rawMaxTokens || snap.window
    const spare = Math.max(0, snap.threshold - snap.used)

    const row = (key: string, label: string, share: number, count: number, color: string) => {
      const lit = filledCells(share, barW)
      return (
        <Box key={key} flexDirection="row">
          <Text wrap="truncate-end">{fit(label, labelW)}</Text>
          <Text color={color}>{'█'.repeat(lit)}</Text>
          <Text color="inactive">{'░'.repeat(barW - lit)}</Text>
          <Text>{right(tokens(count), 7)}</Text>
          <Text dimColor>{right(`${Math.round(share * 100)}%`, 5)}</Text>
        </Box>
      )
    }

    const note = (label: string, text: string, dim?: true) => (
      <Box flexDirection="row">
        <Text dimColor>{fit(label, labelW)}</Text>
        <Text dimColor={dim} wrap="truncate-end">{text}</Text>
      </Box>
    )

    const limitText =
      snap.limit === 'auto-compact'
        ? `${tokens(snap.threshold)}, where auto-compaction runs`
        : snap.limit === 'compaction-window'
          ? `${tokens(snap.threshold)}, the compaction window (auto-compaction is off)`
          : `${tokens(snap.threshold)}, the window itself - this build reports no compaction threshold`

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          {`${tokens(snap.used)} of ${tokens(snap.window)} used · ${snap.percent}%${breakdown ? ` · ${breakdown.model}` : ''}`}
        </Text>
        {row('total', 'window', snap.used / snap.window, snap.used, 'success')}
        <Text> </Text>
        {breakdown ? (
          <Box flexDirection="column">
            {rowsOf(breakdown).map(c =>
              row(`cat:${c.name}`, c.name.toLowerCase(), c.tokens / base, c.tokens, c.color),
            )}
          </Box>
        ) : (
          <Text dimColor wrap="truncate-end">
            This build of Claude Code answers $.session.usage with no category breakdown, so only the window bar is drawn.
          </Text>
        )}
        <Text> </Text>
        {note(
          'growth',
          last === undefined
            ? 'nothing measured yet - it arrives with the second answer'
            : `${signed(last)} last turn${average === undefined ? '' : `, ${signed(average)} average over ${over} turn${over === 1 ? '' : 's'}`}`,
        )}
        {note(
          'headroom',
          left === undefined
            ? `${tokens(spare)} left, no growth rate yet`
            : `${turnCount(left)} at that rate, ${tokens(spare)} left`,
        )}
        {note('limit', limitText)}
        {note(
          'counted',
          snap.detail === 'full'
            ? 'exactly, with the token-count API'
            : 'locally, as an estimate - /context-lens refresh counts exactly',
          true,
        )}
      </Box>
    )
  })
}
