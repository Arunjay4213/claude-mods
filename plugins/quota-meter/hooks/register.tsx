/* @jsx h */
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import {
  addSample,
  barOf,
  colorOf,
  detailOf,
  NO_LIMITS_STATUS,
  paneRowsOf,
  rowsOf,
  samplesOf,
  statusOf,
  windowMsOf,
  type Samples,
} from './quota'

// quota-meter: the plan's rate-limit windows as a pinned status line, and
// `/quota` for a pane with a bar, the reset clock and the burn rate per window.
//
// `$.session.usage()` reports the windows the last API response carried, so the
// readings are sampled after every turn and on a 60 second tick (the tick also
// keeps the countdown moving while the session sits idle). The readings live in
// `$.store`, so the burn rate survives a restart inside the same window.

const PANE_ID = 'quota'
const PANE_TITLE = 'Quota'
const COMMAND = 'quota'
const STORE_KEY = 'samples'
const TICK_MS = 60_000

let limits: SessionRateLimit[] = []
let samples: Samples = {}
let isPaneOpen = false
let tick: Timer | null = null

/** Runs `work`, and on a failure keeps whatever the meter already had. */
const quietly = async <T,>(work: () => Promise<T>): Promise<T | null> => {
  try {
    return await work()
  } catch {
    return null
  }
}

/** Reads the windows, keeps the reading, and repaints both surfaces. */
async function sample($: EngineInterface): Promise<void> {
  const usage = await quietly(() => $.session.usage())
  if (usage) limits = usage.rateLimits ?? []

  const nowMs = await quietly(() => $.clock.now())
  if (nowMs !== null && limits.length > 0) {
    for (const limit of limits) {
      if (!Number.isFinite(limit.percentUsed)) continue
      samples[limit.kind] = addSample(
        samples[limit.kind] ?? [],
        // whole percent is all the API means, and all the store should hold
        { atMs: nowMs, percentUsed: Math.round(limit.percentUsed), resetsAt: limit.resetsAt },
        windowMsOf(limit.kind),
      )
    }
    await quietly(() => $.store.set(STORE_KEY, samples))
  }

  paint($, nowMs ?? Date.now())
}

/** Pins the status line, and asks the pane for a redraw while it is open. */
function paint($: EngineInterface, nowMs: number): void {
  try {
    $.ui.status(limits.length === 0 ? NO_LIMITS_STATUS : statusOf(rowsOf(limits, samples, nowMs)))
  } catch {
    // the status line is a courtesy, never a reason to fail
  }
  if (!isPaneOpen) return
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // the next tick redraws
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    samples = samplesOf(await quietly(() => $.store.get(STORE_KEY)))

    await quietly(() =>
      $.command.register({
        name: COMMAND,
        description: 'Plan limit windows: percent used, reset countdown and burn rate (quota-meter)',
      }),
    )

    await sample($)

    try {
      tick?.cancel()
      tick = $.clock.every(TICK_MS, () => {
        void sample($)
      })
    } catch {
      // without the tick the meter still updates after every turn
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void sample($)
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    if (isPaneOpen) {
      await quietly(() => $.ui.close({ id: PANE_ID }))
      isPaneOpen = false
      return { text: 'quota pane closed' }
    }

    const opened = await quietly(() =>
      $.ui.open({
        id: PANE_ID,
        title: PANE_TITLE,
        rows: paneRowsOf(Math.max(1, limits.length)),
      }).then(() => true),
    )

    if (opened === null) return { text: 'quota-meter: the pane did not open' }

    isPaneOpen = true
    void sample($)
    return { text: 'quota pane open. /quota closes it.' }
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) isPaneOpen = false
    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)

    // a reload of the module loses the flag while the pane stays open; the pane
    // drawing itself is the proof that it is, so `/quota` still toggles
    isPaneOpen = true

    const { Box, Text } = await $.ui.resolve(e)
    const nowMs = (await quietly(() => $.clock.now())) ?? Date.now()
    const rows = rowsOf(limits, samples, nowMs)

    // the bar fills the pane's body, less the one column of padding each side
    const cells = Math.max(8, e.props.bodyColumns - 2)

    if (rows.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>Quota</Text>
          <Text dimColor wrap="truncate-end">
            No plan limits reported yet.
          </Text>
          <Text dimColor wrap="truncate-end">
            Subscription sessions report them once Claude has answered; API-key sessions never do.
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {rows.map(row => {
          const [reset, burn, projection] = detailOf(row)
          return (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold wrap="truncate-end">
                {`${row.title} · ${row.percentUsed}% used`}
              </Text>
              <Text color={colorOf(row.percentUsed)} wrap="truncate-end">
                {barOf(row.percentUsed, cells)}
              </Text>
              <Text dimColor wrap="truncate-end">
                {reset}
              </Text>
              <Text dimColor wrap="truncate-end">
                {burn}
              </Text>
              <Text dimColor wrap="truncate-end">
                {projection}
              </Text>
            </Box>
          )
        })}
        <Text dimColor wrap="truncate-end">
          Sampled after each turn and every 60s. /quota closes this pane.
        </Text>
      </Box>
    )
  })
}
