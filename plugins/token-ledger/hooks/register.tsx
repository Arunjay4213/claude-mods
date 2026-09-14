/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type {
  EngineInterface,
  Register,
  RenderElement,
  TurnCompleteInput,
} from 'claude-code'

import { fmtUsd, rowOf, shortModel, statusText, table, type Row } from './format'

// The ledger keeps one row per finished turn in memory and mirrors it into
// $.store, so /ledger still has the history after a /resume.
//
// Per-turn cost is the change in $.session.usage().cost.usd between two
// turn.complete events. No pricing table lives here: rates change, and a
// guessed rate would be wrong quietly.

const PANE_ID = 'ledger'
const PANE_TITLE = 'Token ledger'
const STORE_KEY = 'ledger'
/** The store caps at 4 MiB for the whole plugin; 200 rows is far under it. */
const MAX_ROWS = 200
/** Rows drawn at once, newest first; older turns still count in the totals. */
const MAX_DRAWN = 40

/** Oldest first; the status line reads the last, the pane draws them reversed. */
let rows: Row[] = []
let sessionId: string | null = null
/** cost.usd as last read: the baseline the next turn's delta is taken from. */
let lastTotal: number | null = null
let sessionUsd: number | null = null
let turnNo = 0
let isOpen = false
/** Turns are recorded one at a time: two finishing together must not share a cost delta. */
let recording: Promise<void> = Promise.resolve()

/** The session's cost so far, or null where the host prices nothing. */
async function costOf($: EngineInterface): Promise<number | null> {
  try {
    return (await $.session.usage()).cost?.usd ?? null
  } catch {
    return null
  }
}

/** Pins the one-line summary. A status line that will not pin costs nothing. */
function showStatus($: EngineInterface): void {
  try {
    $.ui.status(statusText(rows, sessionUsd))
  } catch {
    // nothing to do: the next turn tries again
  }
}

/** Mirrors the ledger so /ledger still has it after a /resume. */
async function save($: EngineInterface): Promise<void> {
  try {
    await $.store.set(STORE_KEY, { sessionId, rows })
  } catch {
    // the in-memory ledger is unaffected
  }
}

/** Reads back this session's rows, or leaves the ledger empty. */
async function restore($: EngineInterface): Promise<void> {
  rows = []
  turnNo = 0

  try {
    sessionId = await $.session.id()
  } catch {
    sessionId = null
  }

  let saved: unknown
  try {
    saved = await $.store.get(STORE_KEY)
  } catch {
    return
  }

  if (typeof saved !== 'object' || saved === null) return
  const held = saved as Record<string, unknown>
  const list = held['rows']

  // Only this session's own rows: a new session starts empty, a resumed one
  // (the same transcript id) picks its history back up.
  if (sessionId === null || held['sessionId'] !== sessionId) return
  if (!Array.isArray(list)) return

  rows = list.map(rowOf).filter((r): r is Row => r !== null)
  turnNo = rows.at(-1)?.n ?? 0
}

/** Adds the finished turn as a row, priced by what the session total moved. */
async function record($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  const total = await costOf($)
  if (total !== null) sessionUsd = total

  const usage = e.usage

  if (usage) {
    const usd =
      total !== null && lastTotal !== null ? Math.max(0, total - lastTotal) : null
    if (total !== null) lastTotal = total

    turnNo += 1
    rows.push({
      n: turnNo,
      model: shortModel(usage.model),
      inTok: usage.input_tokens,
      outTok: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      ms: e.durationMs,
      usd,
      sub: e.agentId !== undefined,
    })

    if (rows.length > MAX_ROWS) rows = rows.slice(rows.length - MAX_ROWS)

    await save($)
  }
  // A turn with no usage (aborted before an answer) keeps the baseline where it
  // was, so whatever it cost lands in the next row and the totals still add up.

  showStatus($)

  if (isOpen) {
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // the pane redraws at the next turn instead
    }
  }
}

/** After /clear or /resume the transcript is another one: start its ledger over. */
async function reset($: EngineInterface): Promise<void> {
  await restore($)
  lastTotal = await costOf($)
  sessionUsd = lastTotal
  showStatus($)
  if (isOpen) {
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // the pane redraws at the next turn instead
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    await restore($)

    // The cost so far is the baseline the first turn's delta is measured from,
    // so that figure is real even on a resumed session.
    lastTotal = await costOf($)
    sessionUsd = lastTotal

    try {
      await $.command.register({
        name: 'ledger',
        description: 'What each turn cost: tokens, cache, time and dollars',
      })
    } catch (error) {
      $.ui.log(`token-ledger: /ledger not registered: ${error}`)
    }

    showStatus($)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // Parallel subagents can finish in the same instant. Queue the bookkeeping so
    // every row's cost is measured from the total the previous row left behind.
    recording = recording.then(() => record($, e)).catch(() => undefined)
    await recording

    return result
  })

  on('command.run', { command: 'clear' }, async ($, e, next) => {
    const result = await next(e)
    await reset($)
    return result
  })

  on('command.run', { command: 'resume' }, async ($, e, next) => {
    const result = await next(e)
    await reset($)
    return result
  })

  on('command.run', { command: 'ledger' }, async ($, e, next) => {
    if (isOpen) {
      try {
        await $.ui.close({ id: PANE_ID })
      } catch {
        // a pane that will not close is one a hook is holding open
      }

      isOpen = false

      return { text: 'Ledger closed. /ledger opens it again.' }
    }

    const drawn = Math.min(rows.length, MAX_DRAWN)

    try {
      await $.ui.open({
        id: PANE_ID,
        title: PANE_TITLE,
        rows: Math.max(4, Math.min(drawn + 4, 20)),
      })
    } catch {
      return { text: 'The ledger pane would not open.' }
    }

    isOpen = true
    const turns = `${rows.length} turn${rows.length === 1 ? '' : 's'}`

    return {
      text:
        rows.length === 0
          ? 'Ledger open. It fills in when a turn finishes.'
          : `Ledger open with ${turns}. /ledger closes it.`,
    }
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) isOpen = false
    return result
  })

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const columns = Math.max(12, e.props.bodyColumns)

    if (rows.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor wrap="truncate-end">
            No turns yet. Send a prompt and the first row lands here.
          </Text>
        </Box>
      ) as RenderElement
    }

    const shown = rows.slice(-MAX_DRAWN).reverse()
    const laid = table(rows, shown, columns)
    const hidden = rows.length - shown.length
    const notes = [
      sessionUsd === null
        ? 'session cost unknown'
        : `session total ${fmtUsd(sessionUsd)}`,
      ...(hidden > 0 ? [`${hidden} older in the totals`] : []),
      ...(shown.some(r => r.sub) ? ['* subagent turn'] : []),
    ]

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          {laid.head}
        </Text>
        {laid.body.map((line, i) => (
          <Text
            key={String(i)}
            dimColor={shown[i]?.sub === true}
            wrap="truncate-end"
          >
            {line}
          </Text>
        ))}
        <Text dimColor wrap="truncate-end">
          {'-'.repeat(Math.min(columns, laid.head.length))}
        </Text>
        <Text bold wrap="truncate-end">
          {laid.totals}
        </Text>
        <Text dimColor wrap="truncate-end">
          {notes.join(' · ')}
        </Text>
      </Box>
    ) as RenderElement
  })
}
