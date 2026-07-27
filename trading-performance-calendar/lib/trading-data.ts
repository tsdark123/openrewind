export type DayStats = {
  /** net profit in dollars, negative = loss */
  profit: number
  trades: number
  winRate: number
  /** R multiple for the day */
  rMultiple: number
}

export type Metric = 'dollar' | 'percent' | 'rmultiple' | 'trades'

export const METRICS: { id: Metric; label: string }[] = [
  { id: 'dollar', label: 'Dollar profit' },
  { id: 'percent', label: 'Win rate' },
  { id: 'rmultiple', label: 'R multiple' },
  { id: 'trades', label: 'Trade count' },
]

/**
 * Hand-authored July 2021 tape so the reference month always renders the same
 * mix of wins, losses and break-even sessions.
 */
const JULY_2021: Record<number, DayStats> = {
  1: { profit: 2430, trades: 2, winRate: 100, rMultiple: 2.4 },
  2: { profit: 2430, trades: 2, winRate: 100, rMultiple: 2.1 },
  5: { profit: 2430, trades: 2, winRate: 100, rMultiple: 2.6 },
  6: { profit: -2430, trades: 2, winRate: 0, rMultiple: -1.8 },
  8: { profit: 12, trades: 2, winRate: 50, rMultiple: 0.02 },
  9: { profit: -18, trades: 2, winRate: 50, rMultiple: -0.03 },
  12: { profit: 24, trades: 2, winRate: 50, rMultiple: 0.04 },
  13: { profit: -9, trades: 2, winRate: 50, rMultiple: -0.01 },
  14: { profit: 6, trades: 2, winRate: 50, rMultiple: 0.01 },
  15: { profit: 240, trades: 2, winRate: 50, rMultiple: 0.3 },
  16: { profit: 2430, trades: 2, winRate: 100, rMultiple: 2.2 },
  19: { profit: -14, trades: 2, winRate: 50, rMultiple: -0.02 },
  20: { profit: 11, trades: 2, winRate: 50, rMultiple: 0.02 },
  21: { profit: 1180, trades: 2, winRate: 100, rMultiple: 1.2 },
  22: { profit: -2430, trades: 2, winRate: 0, rMultiple: -1.9 },
  23: { profit: 8, trades: 2, winRate: 50, rMultiple: 0.01 },
  26: { profit: 310, trades: 2, winRate: 50, rMultiple: 0.4 },
  27: { profit: -2430, trades: 2, winRate: 0, rMultiple: -2.1 },
  28: { profit: -7, trades: 2, winRate: 50, rMultiple: -0.01 },
  29: { profit: 15, trades: 2, winRate: 50, rMultiple: 0.03 },
  30: { profit: 21, trades: 2, winRate: 50, rMultiple: 0.03 },
}

/** tiny deterministic PRNG so every month always looks identical between renders */
function seeded(y: number, m: number, d: number) {
  let h = (y * 10000 + (m + 1) * 100 + d) * 2654435761
  h = (h ^ (h >>> 15)) * 2246822507
  h = (h ^ (h >>> 13)) * 3266489909
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

export function getDayStats(y: number, m: number, d: number): DayStats | null {
  const weekday = new Date(y, m, d).getDay()
  if (weekday === 0 || weekday === 6) return null // no trading on weekends

  if (y === 2021 && m === 6) return JULY_2021[d] ?? null

  const r = seeded(y, m, d)
  if (r < 0.32) return null // flat / no trades taken

  const r2 = seeded(y, m, d + 40)
  const r3 = seeded(y, m, d + 80)
  const win = r2 > 0.42
  const size = r3 < 0.18 ? 0.03 : r3 < 0.55 ? 0.25 : 1
  const profit = Math.round((win ? 1 : -1) * (600 + r3 * 2400) * size)

  return {
    profit,
    trades: 1 + Math.floor(r * 5),
    winRate: win ? 55 + Math.round(r3 * 45) : Math.round(r3 * 45),
    rMultiple: Number((((win ? 1 : -1) * (0.4 + r3 * 2.4)) as number).toFixed(2)),
  }
}

export function getMonthStats(y: number, m: number) {
  const days = new Date(y, m + 1, 0).getDate()
  let profit = 0
  let trades = 0
  let wins = 0
  let sessions = 0
  let rMultiple = 0
  for (let d = 1; d <= days; d++) {
    const s = getDayStats(y, m, d)
    if (!s) continue
    profit += s.profit
    trades += s.trades
    rMultiple += s.rMultiple
    sessions++
    if (s.profit > 0) wins++
  }
  return {
    profit,
    trades,
    sessions,
    rMultiple: Number(rMultiple.toFixed(2)),
    winRate: sessions ? Math.round((wins / sessions) * 100) : 0,
  }
}

export function formatMoney(value: number, withSign = false) {
  const abs = Math.abs(value)
  const sign = withSign && value !== 0 ? (value > 0 ? '+' : '-') : ''
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}K`
  return `${sign}$${abs.toFixed(0)}`
}

export function formatMetric(metric: Metric, s: DayStats) {
  switch (metric) {
    case 'percent':
      return `${s.winRate}%`
    case 'rmultiple':
      return `${s.rMultiple > 0 ? '' : ''}${s.rMultiple.toFixed(2)}R`
    case 'trades':
      return `${s.trades}`
    default:
      return formatMoney(s.profit)
  }
}

/** how strongly a day should be tinted: 0 = flat, 1 = mild, 2 = strong */
export function intensity(profit: number): 0 | 1 | 2 {
  const abs = Math.abs(profit)
  if (abs < 100) return 0
  if (abs < 1500) return 1
  return 2
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Monday-first grid of dates covering the given month */
export function buildMonthGrid(y: number, m: number) {
  const first = new Date(y, m, 1)
  const offset = (first.getDay() + 6) % 7 // Monday = 0
  const start = new Date(y, m, 1 - offset)
  const total = Math.ceil((offset + new Date(y, m + 1, 0).getDate()) / 7) * 7
  return Array.from({ length: total }, (_, i) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    return { date, outside: date.getMonth() !== m }
  })
}
