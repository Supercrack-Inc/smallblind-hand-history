/**
 * Plain-text rendering of a hand, for chat apps and clipboards.
 *
 * The package ships English and Korean label tables; anything else is injected
 * by the caller through `opts.labels`, so this module never depends on an i18n
 * runtime. Templates use `{name}` placeholders.
 */

import Big from 'big.js'

import { CARD_SUIT_SYMBOLS } from './cards'
import { positionLabels, type PositionLabel } from './positions'
import { parseCards, replayAll, totalPot } from './replay'
import type { HandAction, HandRecord, TableState } from './types'

/** Every string the formatter can emit. All fields are required in a table. */
export type TextLabels = {
  /** First words of the header line. */
  title: string
  /** Table size suffix, e.g. `"{n}-max"`. */
  tableSize: string
  /** Label in front of the hero line. */
  hero: string
  /** Pot annotation in a street header, e.g. `"pot {amount}"`. */
  pot: string
  /** Label starting the result line. */
  result: string
  /** Street names, used as line prefixes. */
  streets: Record<'preflop' | 'flop' | 'turn' | 'river', string>
  /** Names of the forced bets, used in the preflop line. */
  posts: Record<'sb' | 'bb' | 'ante' | 'straddle', string>
  /** Action templates. */
  actions: {
    /** `"{label} {amount}"` for a blind, ante or straddle. */
    post: string
    /** `"{pos} folds"`. */
    fold: string
    /** `"{n} folds"`, used for a run of consecutive folds. */
    manyFolds: string
    /** `"{pos} checks"`. */
    check: string
    /** `"{pos} calls {amount}"`. */
    call: string
    /** `"{pos} bets {amount}"`. */
    bet: string
    /** `"{pos} raises to {amount}"`. */
    raise: string
    /** `"{pos} all-in {amount}"`. */
    allin: string
    /** `"{pos} shows {cards}"`. */
    show: string
  }
  /** `"{pos} wins {amount}"`. */
  wins: string
  /** Appended to a winner when the hand could be named, e.g. `"— {hand}"`. */
  handSuffix: string
  /** Localized hand names, keyed by the English name in `HandResult`. */
  handNames: Record<string, string>
  /** Joins actions within a line. */
  separator: string
}

/** Default English labels. */
export const EN_LABELS: TextLabels = {
  title: 'SmallBlind Hand',
  tableSize: '{n}-max',
  hero: 'Hero',
  pot: 'pot {amount}',
  result: 'Result',
  streets: {
    preflop: 'Preflop',
    flop: 'Flop',
    turn: 'Turn',
    river: 'River',
  },
  posts: { sb: 'SB', bb: 'BB', ante: 'ante', straddle: 'straddle' },
  actions: {
    post: '{label} {amount}',
    fold: '{pos} folds',
    manyFolds: '{n} folds',
    check: '{pos} checks',
    call: '{pos} calls {amount}',
    bet: '{pos} bets {amount}',
    raise: '{pos} raises to {amount}',
    allin: '{pos} all-in {amount}',
    show: '{pos} shows {cards}',
  },
  wins: '{pos} wins {amount}',
  handSuffix: '— {hand}',
  handNames: {
    'High Card': 'High Card',
    Pair: 'Pair',
    'Two Pair': 'Two Pair',
    'Three of a Kind': 'Three of a Kind',
    Straight: 'Straight',
    Flush: 'Flush',
    'Full House': 'Full House',
    'Four of a Kind': 'Four of a Kind',
    'Straight Flush': 'Straight Flush',
  },
  separator: ' · ',
}

/** Default Korean labels. */
export const KO_LABELS: TextLabels = {
  title: 'SmallBlind 핸드',
  tableSize: '{n}맥스',
  hero: '히어로',
  pot: '팟 {amount}',
  result: '결과',
  streets: {
    preflop: '프리플랍',
    flop: '플랍',
    turn: '턴',
    river: '리버',
  },
  posts: { sb: 'SB', bb: 'BB', ante: '앤티', straddle: '스트래들' },
  actions: {
    post: '{label} {amount}',
    fold: '{pos} 폴드',
    manyFolds: '{n}명 폴드',
    check: '{pos} 체크',
    call: '{pos} 콜 {amount}',
    bet: '{pos} 벳 {amount}',
    raise: '{pos} 레이즈 {amount}',
    allin: '{pos} 올인 {amount}',
    show: '{pos} 오픈 {cards}',
  },
  wins: '{pos} {amount} 승리',
  handSuffix: '— {hand}',
  handNames: {
    'High Card': '하이카드',
    Pair: '원페어',
    'Two Pair': '투페어',
    'Three of a Kind': '트립스',
    Straight: '스트레이트',
    Flush: '플러시',
    'Full House': '풀하우스',
    'Four of a Kind': '포카드',
    'Straight Flush': '스트레이트 플러시',
  },
  separator: ' · ',
}

/** Label tables shipped with the package. */
export const TEXT_LABELS: Record<'en' | 'ko', TextLabels> = {
  en: EN_LABELS,
  ko: KO_LABELS,
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  KRW: '₩',
  JPY: '¥',
  EUR: '€',
  GBP: '£',
  PHP: '₱',
  VND: '₫',
  CNY: '¥',
  AUD: 'A$',
  CAD: 'C$',
}

/** Options for {@link formatHandText}. */
export type FormatHandTextOptions = {
  /** Overrides merged over the locale's label table. */
  labels?: Partial<TextLabels>
  /** Appended as the last line when present. */
  link?: string
  /** Which shipped label table to start from. Defaults to English. */
  locale?: 'en' | 'ko'
}

function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? values[key]! : match,
  )
}

function groupDigits(value: string) {
  const [whole = '0', fraction] = value.split('.')
  const sign = whole.startsWith('-') ? '-' : ''
  const digits = sign ? whole.slice(1) : whole
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  return `${sign}${grouped}${fraction ? `.${fraction}` : ''}`
}

/** `"1225000"` → `"$1,225,000"`, honouring the record's currency. */
export function formatAmount(value: string, currency: string): string {
  const digits = groupDigits(new Big(value).toFixed())

  if (!currency) {
    return digits
  }

  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()]
  return symbol ? `${symbol}${digits}` : `${currency} ${digits}`
}

/** `"Ah8d"` → `"A♥8♦"`. */
export function formatCards(cards: string): string {
  return parseCards(cards)
    .map((card) => `${card.rank}${CARD_SUIT_SYMBOLS[card.suit]}`)
    .join('')
}

function formatDate(playedAt: number) {
  const date = new Date(playedAt)
  const pad = (value: number) => String(value).padStart(2, '0')

  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

function mergeLabels(
  base: TextLabels,
  overrides: Partial<TextLabels> | undefined,
): TextLabels {
  if (!overrides) {
    return base
  }

  return {
    ...base,
    ...overrides,
    streets: { ...base.streets, ...overrides.streets },
    posts: { ...base.posts, ...overrides.posts },
    actions: { ...base.actions, ...overrides.actions },
    handNames: { ...base.handNames, ...overrides.handNames },
  }
}

type Segment = { street: 'preflop' | 'flop' | 'turn' | 'river'; header: string; parts: string[] }

function describeAction(
  action: HandAction,
  labels: TextLabels,
  positions: Record<number, PositionLabel>,
  currency: string,
): string | null {
  const pos = action.t === 'street' ? '' : (positions[action.seat] ?? `#${action.seat}`)

  switch (action.t) {
    case 'post':
      return fill(labels.actions.post, {
        label: labels.posts[action.kind],
        amount: formatAmount(action.amount, currency),
        pos,
      })
    case 'fold':
      return fill(labels.actions.fold, { pos })
    case 'check':
      return fill(labels.actions.check, { pos })
    case 'call':
      return fill(labels.actions.call, {
        pos,
        amount: formatAmount(action.amount, currency),
      })
    case 'bet':
      return fill(labels.actions.bet, {
        pos,
        amount: formatAmount(action.to, currency),
      })
    case 'raise':
      return fill(labels.actions.raise, {
        pos,
        amount: formatAmount(action.to, currency),
      })
    case 'allin':
      return fill(labels.actions.allin, {
        pos,
        amount: formatAmount(action.to, currency),
      })
    case 'show':
      return fill(labels.actions.show, { pos, cards: formatCards(action.cards) })
    case 'street':
      return null
  }
}

/**
 * Collapse runs of two or more consecutive folds into `"{n} folds"` so a
 * nine-handed preflop stays on one readable line.
 */
function collapseFolds(
  actions: HandAction[],
  labels: TextLabels,
  positions: Record<number, PositionLabel>,
  currency: string,
) {
  const parts: string[] = []
  let index = 0

  while (index < actions.length) {
    const action = actions[index]!

    if (action.t === 'fold') {
      let run = 1

      while (actions[index + run]?.t === 'fold') {
        run += 1
      }

      parts.push(
        run > 1
          ? fill(labels.actions.manyFolds, { n: String(run) })
          : describeAction(action, labels, positions, currency)!,
      )
      index += run
      continue
    }

    const text = describeAction(action, labels, positions, currency)

    if (text !== null) {
      parts.push(text)
    }

    index += 1
  }

  return parts
}

function resultLine(
  state: TableState,
  labels: TextLabels,
  positions: Record<number, PositionLabel>,
  currency: string,
) {
  if (!state.result || state.result.winners.length === 0) {
    return null
  }

  const parts = state.result.winners.map((winner) => {
    const line = fill(labels.wins, {
      pos: positions[winner.seat] ?? `#${winner.seat}`,
      amount: formatAmount(winner.amount, currency),
    })

    if (!winner.handName) {
      return line
    }

    const name = labels.handNames[winner.handName] ?? winner.handName
    return `${line} ${fill(labels.handSuffix, { hand: name })}`
  })

  return `${labels.result}: ${parts.join(labels.separator)}`
}

/**
 * Render the hand as shareable plain text.
 *
 * ```
 * SmallBlind Hand · 5,000/10,000 NLHE 9-max · 2026-08-29
 * Hero UTG+1 1,200,000 A♦A♣
 * Preflop: SB 5,000 · BB 10,000 · ante 10,000 · UTG raises to 22,000 · …
 * Flop 8♦4♦3♥ (pot 155,000): UTG checks · UTG+1 bets 50,000 · UTG calls 50,000
 * Result: UTG wins 1,225,000 — Three of a Kind
 * ```
 */
export function formatHandText(
  hand: HandRecord,
  opts?: FormatHandTextOptions,
): string {
  const labels = mergeLabels(TEXT_LABELS[opts?.locale ?? 'en'], opts?.labels)
  const currency = hand.currency
  const seated = hand.players.map((player) => player.seat)
  const positions = positionLabels(hand.seats, hand.button, seated)
  const states = replayAll(hand)
  const final = states[states.length - 1]!

  const segments: Segment[] = [
    { street: 'preflop', header: labels.streets.preflop, parts: [] },
  ]
  const buckets: HandAction[][] = [[]]

  hand.actions.forEach((action, index) => {
    if (action.t === 'street') {
      const potHere = formatAmount(totalPot(states[index + 1]!), currency)

      segments.push({
        street: action.street,
        header: `${labels.streets[action.street]} ${formatCards(action.cards)} (${fill(labels.pot, { amount: potHere })})`,
        parts: [],
      })
      buckets.push([])
      return
    }

    buckets[buckets.length - 1]!.push(action)
  })

  segments.forEach((segment, index) => {
    segment.parts = collapseFolds(
      buckets[index] ?? [],
      labels,
      positions,
      currency,
    )
  })

  const stakes = `${formatAmount(hand.blinds.sb, currency)}/${formatAmount(hand.blinds.bb, currency)}`
  const tableSize = fill(labels.tableSize, {
    n: String(hand.players.length),
  })
  const lines: string[] = [
    [
      labels.title,
      `${stakes} ${hand.game} ${tableSize}`,
      formatDate(hand.playedAt),
    ].join(labels.separator),
  ]

  const hero = hand.players.find((player) => player.hero)

  if (hero) {
    const cards = hero.cards ? ` ${formatCards(hero.cards)}` : ''
    lines.push(
      `${labels.hero} ${positions[hero.seat] ?? `#${hero.seat}`} ${formatAmount(hero.stack, currency)}${cards}`,
    )
  }

  segments.forEach((segment) => {
    if (segment.parts.length === 0) {
      return
    }

    lines.push(`${segment.header}: ${segment.parts.join(labels.separator)}`)
  })

  const result = resultLine(final, labels, positions, currency)

  if (result) {
    lines.push(result)
  }

  if (opts?.link) {
    lines.push(opts.link)
  }

  return lines.join('\n')
}
