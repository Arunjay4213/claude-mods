/* @jsx h */
import type { EngineInterface, PluginOptions, Register, SessionRateLimit } from 'claude-code'

import {
  actionOf,
  DEFAULTS,
  denyReasonOf,
  dropReasonOf,
  figuresOf,
  firstOver,
  overTextOf,
  settingsOf,
  stateTextOf,
  statusOf,
  usd,
  warnModeTextOf,
  warnTextOf,
  WINDOWS,
  type Field,
  type Figure,
  type FigureKey,
  type Level,
  type Settings,
} from './guard'

// budget-guard: three figures with a limit each - the session's cost in
// dollars, and how much of the 5-hour and 7-day plan windows is used.
//
// It says nothing while everything is fine. Once a figure reaches the warn
// mark it pins a status line and toasts once; once a figure passes its limit
// it refuses tool calls and asks before sending a new prompt, unless the mode
// is "warn" or the user set an override for the turn.
//
// The readings come from `$.session.usage()` with no argument, which is the
// free form: it reports what the last API response already carried.

// The engine draws the plugin's name in front of every toast, status line,
// `$.ui.log` line and command output, so none of those texts names itself. A
// deny and a drop reach the model and the transcript unnamed, so those two do.
const COMMAND = 'guard'
const STORE_KEY = 'settings'
/** A usage read slower than this is worth caching instead of repeating. */
const SLOW_READ_MS = 30
/** How long a cached reading stands, when caching is on. */
const CACHE_MS = 3_000
/** `$.ui.ask` label the user picks to send the prompt anyway. */
const SEND_ANYWAY = 'Send anyway'
const DO_NOT_SEND = 'Do not send'

let settings: Settings = DEFAULTS
let costUsd: number | null = null
let limits: SessionRateLimit[] = []
/** The level each figure was last announced at, so a toast is not repeated. */
let announced: Partial<Record<FigureKey, Level>> = {}
/** Set by `/guard override` or by answering the ask: one turn runs anyway. */
let isOverridden = false
/** The fields held in `$.store` because `$.config.set` would not take them. */
let storedFields: Record<string, unknown> = {}
let isStoreUsed = false
/** How long the last usage read took, and when it was taken. */
let readMs = 0
let readAtMs = 0
/** The running main turn, so a refusal can end it instead of leaving the model to retry. */
let turnId: string | null = null
/** The turn already being stopped, so several refusals in one turn stop it once. */
let stoppingTurnId: string | null = null

/** Runs `work`, and on a failure keeps whatever the guard already had. */
const quietly = async <T,>(work: () => Promise<T>): Promise<T | null> => {
  try {
    return await work()
  } catch {
    return null
  }
}

/** `session cost` -> `Session cost`, for a line that starts with a label. */
const sentenceCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** Shows `text`, or does nothing where the toast will not draw. */
function toast($: EngineInterface, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // a toast is a courtesy, never a reason to fail a hook
  }
}

/**
 * Takes a reading. `mayCache` is honoured only once a read has measured slower
 * than 30 ms, so a fast host always sees the live figures.
 */
async function sample($: EngineInterface, mayCache = false): Promise<void> {
  if (mayCache && readMs > SLOW_READ_MS && Date.now() - readAtMs < CACHE_MS) return

  const startedAt = Date.now()
  const usage = await quietly(() => $.session.usage())
  if (usage === null) return

  readMs = Date.now() - startedAt
  readAtMs = Date.now()
  costUsd = usage.cost?.usd ?? null
  limits = usage.rateLimits ?? []
}

/** The figures as they read now. */
const figures = (): Figure[] => figuresOf(costUsd, limits, settings)

/** Pins the status line while a figure needs watching, and clears it after. */
function paint($: EngineInterface, shown: readonly Figure[]): void {
  try {
    $.ui.status(settings.enabled ? statusOf(shown) : undefined)
  } catch {
    // the next sample tries again
  }
}

/**
 * Toasts each figure that has just risen to a new level, and in warn mode says
 * once a turn that a figure is over, since nothing is refused there.
 */
function announce($: EngineInterface, shown: readonly Figure[], isTurnEnd: boolean): void {
  for (const figure of shown) {
    const before = announced[figure.key] ?? 'ok'
    if (figure.level === before) continue
    announced[figure.key] = figure.level
    if (figure.level === 'warn') toast($, warnTextOf(figure))
    else if (figure.level === 'over' && settings.mode === 'block')
      toast($, overTextOf(figure, '/guard override allows the next turn;'))
  }

  // a figure that fell back to ok may rise again and should toast again
  for (const key of Object.keys(announced) as FigureKey[]) {
    if (!shown.some(figure => figure.key === key)) delete announced[key]
  }

  if (!isTurnEnd || settings.mode !== 'warn') return
  const over = firstOver(shown)
  if (over !== undefined) toast($, warnModeTextOf(over))
}

/** Samples, repaints and announces: everything one observation point does. */
async function refresh($: EngineInterface, isTurnEnd: boolean): Promise<void> {
  await sample($)
  const shown = figures()
  paint($, shown)
  if (settings.enabled) announce($, shown, isTurnEnd)
}

/** Reads the settings: the manifest's defaults, then anything the store holds. */
async function load($: EngineInterface, options: PluginOptions): Promise<void> {
  settings = settingsOf(DEFAULTS, options)
  const stored = await quietly(() => $.store.get(STORE_KEY))
  if (typeof stored !== 'object' || stored === null) return
  storedFields = { ...(stored as Record<string, unknown>) }
  isStoreUsed = Object.keys(storedFields).length > 0
  settings = settingsOf(settings, storedFields)
}

/**
 * Writes one field so it survives a restart. The plugin's own `userConfig` row
 * is the right home; where the engine will not let a plugin write its own row,
 * `$.store` holds it instead and `/guard` says which was used.
 */
type Saved = 'settings' | 'store' | 'nowhere'

async function save(
  $: EngineInterface,
  field: Field,
  value: string | number | boolean,
): Promise<Saved> {
  const written = await quietly(() =>
    $.config.set({ key: `budget-guard.${field}`, value }),
  )

  if (written !== null && written.deny === undefined) {
    if (field in storedFields) {
      delete storedFields[field]
      await quietly(() => $.store.set(STORE_KEY, storedFields))
    }
    return 'settings'
  }

  storedFields[field] = value
  isStoreUsed = true
  return (await quietly(() => $.store.set(STORE_KEY, storedFields))) === null ? 'nowhere' : 'store'
}

/** What `/guard` prints after a change, saying where the change was kept. */
const savedNote = (saved: Saved): string =>
  saved === 'settings'
    ? ' Kept in the plugin settings, so it survives a restart.'
    : saved === 'store'
      ? ' Kept in the plugin store, so it survives a restart.'
      : ' It could not be saved, so it lasts only for this session.'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    await load($, options)

    await quietly(() =>
      $.command.register({
        name: COMMAND,
        description: 'Budget guard: session cost and plan window limits (budget-guard)',
        argumentHint: '[cost 5 | 5h 90 | 7d 95 | warn | block | override | off | on]',
      }),
    )

    await refresh($, false)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // the override covers one turn of the main loop; a subagent's turn ending
    // inside it must not take the override away from the turn that set it
    if (e.agentId === undefined) isOverridden = false

    await refresh($, true)

    return result
  })

  on('tool.call', async ($, e, next) => {
    // the dialog `$.ui.ask` opens is itself a tool call of this plugin's, and
    // refusing it would make the question unanswerable
    if (!settings.enabled || settings.mode !== 'block' || e.tool === 'AskUserQuestion') {
      return next(e)
    }

    // cost moves inside a turn as steps finish, so the figure is read here and
    // not only between turns
    await sample($, true)

    const shown = figures()
    paint($, shown)
    announce($, shown, false)

    if (isOverridden) return next(e)

    const over = firstOver(shown)
    if (over === undefined) return next(e)

    // Refusing one call is not enough: the model answers a refusal by trying
    // another tool, and every try is an API call that costs money, so the turn
    // is ended too. The stop waits a moment so the refusal, with its reason, is
    // recorded in the transcript first; stopped at once, the transcript would
    // show only "Interrupted" where the refusal belongs.
    const reason = denyReasonOf(over)
    const running = turnId
    if (running !== null && stoppingTurnId !== running) {
      stoppingTurnId = running
      try {
        $.clock.after(250, () => {
          void quietly(() => $.turn.abort({ turnId: running }))
        })
      } catch {
        void quietly(() => $.turn.abort({ turnId: running }))
      }
    }

    return { deny: reason }
  })

  on('turn.start', async ($, e, next) => {
    turnId = e.turnId
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!settings.enabled || settings.mode !== 'block') return next(e)
    // a slash command must always get through, or /guard override could not be typed
    if (e.text.trimStart().startsWith('/')) return next(e)

    await sample($, true)
    const shown = figures()
    paint($, shown)

    if (isOverridden) return next(e)

    const over = firstOver(shown)
    if (over === undefined) return next(e)

    const answer = await quietly(() =>
      $.ui.ask(`${sentenceCase(over.label)} is ${over.valueText}, past its ${over.limitText} limit. Send this prompt anyway?`, {
        options: [SEND_ANYWAY, DO_NOT_SEND],
        header: 'Budget',
      }),
    )

    if (answer === SEND_ANYWAY) {
      isOverridden = true
      toast($, `override set, this turn runs past the ${over.limitText} limit`)
      return next(e)
    }

    // a dismissed dialog, or a host with no one to ask, comes back as null
    return { drop: dropReasonOf(over) }
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    await sample($)
    const action = actionOf(e.args)

    if (action.kind === 'error') return { text: action.text }

    if (action.kind === 'show') {
      paint($, figures())
      const where = isStoreUsed
        ? '\nSettings are kept in the plugin store.'
        : '\nSettings are kept in the plugin settings (/config shows them).'
      return { text: `${stateTextOf(settings, costUsd, limits, isOverridden)}${where}` }
    }

    if (action.kind === 'override') {
      isOverridden = true
      return {
        text: 'Override set. The next turn runs even if a figure is past its limit. It lasts one turn.',
      }
    }

    // every remaining action changes one field: apply it, keep it, repaint
    const field: Field = action.kind === 'limit' ? action.field : action.kind
    const value: string | number | boolean =
      action.kind === 'limit' ? action.value : action.kind === 'mode' ? action.mode : action.enabled
    settings = { ...settings, [field]: value }
    const saved = await save($, field, value)
    announced = {}
    await refresh($, false)

    if (action.kind === 'mode') {
      const what =
        action.mode === 'block'
          ? 'Tool calls are refused once a figure passes its limit.'
          : 'Nothing is refused; the guard only says so.'
      return { text: `${action.mode} mode. ${what}${savedNote(saved)}` }
    }

    if (action.kind === 'enabled') {
      return {
        text: action.enabled
          ? `on, in ${settings.mode} mode.${savedNote(saved)}`
          : `off. Nothing is watched until /guard on.${savedNote(saved)}`,
      }
    }

    const label = action.key === 'cost' ? 'session cost' : WINDOWS[action.key].label
    if (action.value === 0) return { text: `The ${label} guard is off.${savedNote(saved)}` }

    const reading = figures().find(figure => figure.key === action.key)
    const now =
      reading === undefined
        ? ''
        : ` It reads ${reading.valueText} now (${reading.percentOfLimit}% of the limit).`

    return {
      text: `${sentenceCase(label)} limit is ${action.key === 'cost' ? usd(action.value) : `${action.value}%`}.${now}${savedNote(saved)}`,
    }
  })
}
