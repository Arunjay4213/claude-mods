import type { SessionRateLimit } from 'claude-code'

// The rules behind the guard: what the settings are, what level each guarded
// figure sits at, and the text every surface shows. Nothing here touches `$`,
// so a failure in the engine can never reach it.

/** How close a figure is to its limit. */
export type Level = 'ok' | 'warn' | 'over'

/** What the guard does once a figure is over: refuse work, or only say so. */
export type Mode = 'block' | 'warn'

/** The three guarded figures. */
export type FigureKey = 'cost' | '5h' | '7d'

/** The fields of `userConfig`, the same names the settings are stored under. */
export type Field = keyof Settings

export type Settings = {
  costLimitUsd: number
  fiveHourLimitPercent: number
  sevenDayLimitPercent: number
  warnAtPercent: number
  mode: Mode
  enabled: boolean
}

/** The same defaults `userConfig` declares, so the module works without it. */
export const DEFAULTS: Settings = {
  costLimitUsd: 0,
  fiveHourLimitPercent: 90,
  sevenDayLimitPercent: 95,
  warnAtPercent: 80,
  mode: 'block',
  enabled: true,
}

/** Lays `raw` over `base`, keeping `base` wherever a value does not fit. */
export function settingsOf(base: Settings, raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return base
  const held = raw as Record<string, unknown>

  const num = (field: Field, was: number): number => {
    const value = held[field]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : was
  }

  const mode = held['mode']
  const enabled = held['enabled']

  return {
    costLimitUsd: num('costLimitUsd', base.costLimitUsd),
    fiveHourLimitPercent: num('fiveHourLimitPercent', base.fiveHourLimitPercent),
    sevenDayLimitPercent: num('sevenDayLimitPercent', base.sevenDayLimitPercent),
    warnAtPercent: Math.min(100, Math.max(1, num('warnAtPercent', base.warnAtPercent))),
    mode: mode === 'block' || mode === 'warn' ? mode : base.mode,
    enabled: typeof enabled === 'boolean' ? enabled : base.enabled,
  }
}

/** Dollars as the guard prints them, always two decimals. */
export const usd = (value: number): string => `$${value.toFixed(2)}`

/** One guarded figure with a limit and a reading, ready to show. */
export type Figure = {
  key: FigureKey
  /** `session cost`, `5-hour window`. */
  label: string
  value: number
  limit: number
  /** `$4.10` or `76%`. */
  valueText: string
  /** `$5.00` or `90%`. */
  limitText: string
  /** How far along the limit the reading is, as a whole percent. */
  percentOfLimit: number
  level: Level
}

export function levelOf(value: number, limit: number, warnAtPercent: number): Level {
  if (limit <= 0) return 'ok'
  if (value >= limit) return 'over'
  return (value / limit) * 100 >= warnAtPercent ? 'warn' : 'ok'
}

/** The two plan windows: what the API calls them, and what guards them here. */
export const WINDOWS = {
  '5h': { kind: 'five_hour', label: '5-hour window', field: 'fiveHourLimitPercent' },
  '7d': { kind: 'seven_day', label: '7-day window', field: 'sevenDayLimitPercent' },
} as const satisfies Record<'5h' | '7d', { kind: string; label: string; field: Field }>

/** The limit set for one window, in percent; 0 means the guard is off. */
export const windowLimitOf = (settings: Settings, key: '5h' | '7d'): number =>
  settings[WINDOWS[key].field]

/** The percent a window reads now, or null when the plan reports none. */
export function windowPercentOf(
  limits: readonly SessionRateLimit[],
  key: '5h' | '7d',
): number | null {
  const found = limits.find(limit => limit.kind === WINDOWS[key].kind)
  if (found === undefined || !Number.isFinite(found.percentUsed)) return null
  // the API means whole percent, but does not always send it that way
  return Math.round(found.percentUsed)
}

/**
 * The figures that are guarded right now: a limit of 0 turns one off, and a
 * reading the session does not have (no cost ledger, no plan windows) leaves
 * its figure out rather than guessing a zero.
 */
export function figuresOf(
  costUsd: number | null,
  limits: readonly SessionRateLimit[],
  settings: Settings,
): Figure[] {
  const out: Figure[] = []

  if (costUsd !== null && settings.costLimitUsd > 0) {
    out.push({
      key: 'cost',
      label: 'session cost',
      value: costUsd,
      limit: settings.costLimitUsd,
      valueText: usd(costUsd),
      limitText: usd(settings.costLimitUsd),
      percentOfLimit: Math.round((costUsd / settings.costLimitUsd) * 100),
      level: levelOf(costUsd, settings.costLimitUsd, settings.warnAtPercent),
    })
  }

  for (const key of ['5h', '7d'] as const) {
    const limit = windowLimitOf(settings, key)
    const value = windowPercentOf(limits, key)
    if (value === null || limit <= 0) continue
    out.push({
      key,
      label: WINDOWS[key].label,
      value,
      limit,
      valueText: `${value}%`,
      limitText: `${limit}%`,
      percentOfLimit: Math.round((value / limit) * 100),
      level: levelOf(value, limit, settings.warnAtPercent),
    })
  }

  return out
}

/** The figure a deny or a drop speaks for: cost first, then 5h, then 7d. */
export const firstOver = (figures: readonly Figure[]): Figure | undefined =>
  figures.find(figure => figure.level === 'over')

/**
 * The one line pinned under the prompt while a figure is at warn or over, and
 * `undefined` while everything is fine, which clears the line.
 */
export function statusOf(figures: readonly Figure[]): string | undefined {
  if (!figures.some(figure => figure.level !== 'ok')) return undefined
  const parts = figures.map(figure =>
    figure.key === 'cost'
      ? `cost ${figure.valueText}/${figure.limitText} ${figure.percentOfLimit}%`
      : `${figure.key} ${figure.value}/${figure.limit}%`,
  )
  const tail = figures.some(figure => figure.level === 'over') ? ' · over limit' : ''
  return `${parts.join(' · ')}${tail}`
}

/**
 * `session cost $4.10 of $5.00 (82%)`.
 *
 * The engine puts the plugin's name in front of every toast, status line and
 * command output it draws, so none of these texts carries one of its own.
 */
export const warnTextOf = (figure: Figure): string =>
  figure.key === 'cost'
    ? `session cost ${figure.valueText} of ${figure.limitText} (${figure.percentOfLimit}%)`
    : `${figure.label} ${figure.valueText} of the ${figure.limitText} limit (${figure.percentOfLimit}%)`

/** A limit worth raising to, given how far past the reading already is. */
export function raiseHintOf(figure: Figure): string {
  if (figure.key === 'cost') {
    return `/guard cost ${Math.max(1, Math.ceil(figure.value * 1.5))}`
  }
  const next = Math.min(100, Math.max(figure.limit + 5, Math.ceil(figure.value / 5) * 5))
  return `/guard ${figure.key} ${next}`
}

/** What a figure being over says, without a plugin name in front. */
export const overTextOf = (figure: Figure, what: string): string =>
  `${figure.label} ${figure.valueText} passed the ${figure.limitText} limit. ` +
  `${what} ${raiseHintOf(figure)} raises the limit.`

/**
 * A deny and a drop reach the model and the transcript unnamed, so these two
 * carry the plugin's name themselves.
 */
export const denyReasonOf = (figure: Figure): string =>
  `budget-guard: ${figure.label} ${figure.valueText} passed the ${figure.limitText} limit, so the turn was stopped. ` +
  `/guard override allows the next turn; ${raiseHintOf(figure)} raises the limit.`

export const dropReasonOf = (figure: Figure): string =>
  `budget-guard: ${overTextOf(figure, 'The prompt was not sent. /guard override sends the next one;')}`

/** The toast shown once a turn in warn mode, where nothing is ever refused. */
export const warnModeTextOf = (figure: Figure): string =>
  `${figure.label} ${figure.valueText} is past the ${figure.limitText} limit (warn mode, nothing is blocked)`

/** What `/guard <args>` asked for. */
export type Action =
  | { kind: 'show' }
  | { kind: 'override' }
  | { kind: 'mode'; mode: Mode }
  | { kind: 'enabled'; enabled: boolean }
  | { kind: 'limit'; key: FigureKey; field: Field; value: number }
  | { kind: 'error'; text: string }

const LIMIT_FIELD: Record<FigureKey, Field> = {
  cost: 'costLimitUsd',
  '5h': WINDOWS['5h'].field,
  '7d': WINDOWS['7d'].field,
}

export function actionOf(args: string): Action {
  const words = args.trim().toLowerCase().split(/\s+/).filter(word => word.length > 0)
  const head = words[0]

  if (head === undefined) return { kind: 'show' }
  if (head === 'override') return { kind: 'override' }
  if (head === 'warn' || head === 'block') return { kind: 'mode', mode: head }
  if (head === 'off') return { kind: 'enabled', enabled: false }
  if (head === 'on') return { kind: 'enabled', enabled: true }

  if (head === 'cost' || head === '5h' || head === '7d') {
    const raw = words[1]
    if (raw === undefined) return { kind: 'error', text: `/guard ${head} needs a number, for example /guard ${head} ${head === 'cost' ? '5' : '90'}` }
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) {
      return { kind: 'error', text: `"${raw}" is not a number the guard can use. Give it 0 or more.` }
    }
    if (head !== 'cost' && value > 100) {
      return { kind: 'error', text: `A window limit is a percent, so it cannot be over 100.` }
    }
    return { kind: 'limit', key: head, field: LIMIT_FIELD[head], value }
  }

  return { kind: 'error', text: `/guard does not know "${head}". Run /guard on its own to see what it takes.` }
}

/** One row of the `/guard` state print, padded so the columns line up. */
type Row = { name: string; reading: string; level: string }

const padded = (rows: readonly Row[]): string[] => {
  const nameWidth = Math.max(...rows.map(row => row.name.length))
  const readingWidth = Math.max(...rows.map(row => row.reading.length))
  return rows.map(
    row => `  ${row.name.padEnd(nameWidth)}  ${row.reading.padEnd(readingWidth)}  ${row.level}`,
  )
}

const HELP = [
  'Change it:',
  '  /guard cost 5     dollar limit for this session (0 turns it off)',
  '  /guard 5h 90      percent of the 5-hour plan window',
  '  /guard 7d 95      percent of the 7-day plan window',
  '  /guard warn       only say so, never refuse',
  '  /guard block      refuse tool calls once a limit is passed',
  '  /guard override   allow the next turn even if a figure is over',
  '  /guard off        turn the guard off    (/guard on turns it back)',
]

/** Everything `/guard` on its own prints. */
export function stateTextOf(
  settings: Settings,
  costUsd: number | null,
  limits: readonly SessionRateLimit[],
  isOverridden: boolean,
): string {
  const figures = figuresOf(costUsd, limits, settings)
  const byKey = new Map(figures.map(figure => [figure.key, figure]))

  const rows: Row[] = [
    {
      name: 'session cost',
      reading:
        costUsd === null
          ? 'no cost reported'
          : settings.costLimitUsd <= 0
            ? `${usd(costUsd)}, no limit`
            : `${usd(costUsd)} of ${usd(settings.costLimitUsd)}`,
      level: byKey.get('cost')?.level ?? 'not guarded',
    },
  ]

  for (const key of ['5h', '7d'] as const) {
    const limit = windowLimitOf(settings, key)
    const value = windowPercentOf(limits, key)
    rows.push({
      name: WINDOWS[key].label,
      reading:
        value === null
          ? 'not reported by the plan'
          : limit <= 0
            ? `${value}%, no limit`
            : `${value}% of ${limit}%`,
      level: byKey.get(key)?.level ?? 'not guarded',
    })
  }

  const head = settings.enabled
    ? `on, in ${settings.mode} mode. It warns at ${settings.warnAtPercent}% of a limit.`
    : 'off. Nothing is watched until /guard on.'

  const notes: string[] = []
  if (isOverridden) notes.push('An override is set: the next turn runs even if a figure is over.')
  if (limits.length === 0) {
    notes.push(
      'No plan windows reported. API-key sessions never report them, so the 5h and 7d guards stay inactive.',
    )
  }

  return [head, '', ...padded(rows), '', ...notes, ...(notes.length > 0 ? [''] : []), ...HELP].join(
    '\n',
  )
}
