/**
 * Hand replay: a pure reducer over `HandRecord.actions`.
 *
 * `initialState` + `applyAction` are the primitives — the recording UI appends
 * one action at a time — and `replay` / `replayAll` / `stepCount` are the
 * conveniences built on them.
 *
 * Money rules:
 * - Every amount is a decimal string, computed with big.js. No `number` math.
 * - `call.amount` and `bet | raise | allin.to` are **cumulative street totals**
 *   (the Pokerbase convention), not the chips added by that action.
 * - Antes go straight to the pot; blinds and straddles sit in `streetBets` and
 *   are matched by preflop callers.
 * - `pots` holds chips already swept in. Chips still in front of the players
 *   live in `streetBets` until the street closes. `totalPot` adds both.
 */

import Big from 'big.js'

import { parseCard, type Card } from './cards'
import { chipUnitForCurrency } from './currency'
import {
  compareHandScores,
  evaluateBestHand,
  HandCategory,
  type HandScore,
} from './hand-evaluator'
import { blindSeats, postflopOrder, preflopOrder } from './positions'
import type {
  HandAction,
  HandRecord,
  HandResult,
  PostedBlind,
  Pot,
  StreetBetting,
  TableState,
} from './types'

/** Thrown when a hand record cannot be replayed at all. */
export class HandReplayError extends Error {
  /** Index of the offending action within `HandRecord.actions`. */
  readonly step: number
  /** The action that could not be applied, when the failure has one. */
  readonly action: HandAction | undefined
  /**
   * Category of the failure so `validateRecord` can report it with the right
   * code. `'bad-winners'` marks an impossible manual payout.
   */
  readonly code: 'replay-failed' | 'bad-winners'

  constructor(
    message: string,
    step: number,
    action?: HandAction,
    code: 'replay-failed' | 'bad-winners' = 'replay-failed',
  ) {
    super(message)
    this.name = 'HandReplayError'
    this.step = step
    this.action = action
    this.code = code
  }
}

/** Short English names for evaluated hands, used in `HandResult.winners`. */
export const HAND_CATEGORY_NAMES: Record<HandCategory, string> = {
  [HandCategory.HighCard]: 'High Card',
  [HandCategory.OnePair]: 'Pair',
  [HandCategory.TwoPair]: 'Two Pair',
  [HandCategory.ThreeOfAKind]: 'Three of a Kind',
  [HandCategory.Straight]: 'Straight',
  [HandCategory.Flush]: 'Flush',
  [HandCategory.FullHouse]: 'Full House',
  [HandCategory.FourOfAKind]: 'Four of a Kind',
  [HandCategory.StraightFlush]: 'Straight Flush',
}

const ZERO = new Big(0)

function big(value: string | undefined) {
  return new Big(value ?? '0')
}

function money(value: Big) {
  return value.toFixed()
}

function minBig(left: Big, right: Big) {
  return left.lt(right) ? left : right
}

function sameSeats(left: readonly number[], right: readonly number[]) {
  return (
    left.length === right.length && left.every((seat, i) => seat === right[i])
  )
}

/** Parse a concatenated card string such as `"8d4d3h"`. */
export function parseCards(value: string): Card[] {
  if (value.length % 2 !== 0) {
    throw new Error(`Card string has a dangling character: ${value}`)
  }

  const cards: Card[] = []

  for (let index = 0; index < value.length; index += 2) {
    cards.push(parseCard(value.slice(index, index + 2)))
  }

  return cards
}

/** Occupied seats, ascending. */
export function seatedSeats(hand: HandRecord): number[] {
  return hand.players.map((player) => player.seat).sort((a, b) => a - b)
}

/** Seats that posted a straddle in a finished record, in posting order. */
export function straddleSeats(hand: HandRecord): number[] {
  return hand.actions
    .filter((action) => action.t === 'post' && action.kind === 'straddle')
    .map((action) => (action.t === 'post' ? action.seat : -1))
}

/** Chips in every pot plus the chips still in front of the players. */
export function totalPot(state: TableState): string {
  const pots = state.pots.reduce((sum, pot) => sum.plus(pot.amount), ZERO)
  const bets = Object.values(state.streetBets).reduce(
    (sum, bet) => sum.plus(bet),
    ZERO,
  )

  return money(pots.plus(bets))
}

/** Stacks including the award, once the hand is complete. */
export function finalStacks(state: TableState): Record<number, string> {
  const stacks: Record<number, string> = { ...state.stacks }

  state.result?.winners.forEach((winner) => {
    stacks[winner.seat] = money(big(stacks[winner.seat]).plus(winner.amount))
  })

  return stacks
}

type Draft = {
  step: number
  street: TableState['street']
  board: string
  stacks: Record<number, string>
  streetBets: Record<number, string>
  committed: Record<number, string>
  pots: Pot[]
  folded: number[]
  mucked: number[]
  allIn: number[]
  revealed: Record<number, string>
  betting: StreetBetting
  actingSeat: number | null
  lastAction: HandAction | undefined
  isComplete: boolean
  result: HandResult | undefined
  needsWinners: boolean
}

function toDraft(state: TableState): Draft {
  return {
    step: state.step,
    street: state.street,
    board: state.board,
    stacks: { ...state.stacks },
    streetBets: { ...state.streetBets },
    committed: { ...state.committed },
    pots: state.pots.map((pot) => ({ ...pot, eligible: [...pot.eligible] })),
    folded: [...state.folded],
    mucked: [...state.mucked],
    allIn: [...state.allIn],
    revealed: { ...state.revealed },
    betting: {
      lastRaiseSize: state.betting.lastRaiseSize,
      bringIn: state.betting.bringIn,
      posts: state.betting.posts.map((post) => ({ ...post })),
      actedSeats: [...state.betting.actedSeats],
      aggressorSeat: state.betting.aggressorSeat,
    },
    actingSeat: state.actingSeat,
    lastAction: state.lastAction,
    isComplete: state.isComplete,
    result: state.result,
    needsWinners: state.needsWinners === true,
  }
}

function toState(draft: Draft): TableState {
  const state: TableState = {
    step: draft.step,
    street: draft.street,
    board: draft.board,
    stacks: draft.stacks,
    streetBets: draft.streetBets,
    committed: draft.committed,
    pots: draft.pots,
    folded: [...draft.folded].sort((a, b) => a - b),
    mucked: [...draft.mucked],
    allIn: [...draft.allIn].sort((a, b) => a - b),
    revealed: draft.revealed,
    betting: draft.betting,
    actingSeat: draft.actingSeat,
    isComplete: draft.isComplete,
  }

  if (draft.lastAction) {
    state.lastAction = draft.lastAction
  }

  if (draft.result) {
    state.result = draft.result
  }

  if (draft.needsWinners) {
    state.needsWinners = true
  }

  return state
}

function contenders(draft: Draft, hand: HandRecord) {
  return seatedSeats(hand).filter((seat) => !draft.folded.includes(seat))
}

/**
 * The wager everyone has to match: the highest cumulative street bet (folded
 * seats included) or, preflop, the bring-in when it is higher.
 *
 * The bring-in matters when the big blind is all-in for less than a full blind:
 * the table still plays for the full big blind, so a call is 2 in a 1/2 game
 * even if the blind itself only put in 0.5.
 */
export function currentBet(
  state: Pick<TableState, 'streetBets' | 'betting'>,
): string {
  return money(
    Object.values(state.streetBets).reduce(
      (high, bet) => (big(bet).gt(high) ? big(bet) : high),
      big(state.betting.bringIn),
    ),
  )
}

function streetOrder(draft: Draft, hand: HandRecord) {
  const seated = seatedSeats(hand)

  return draft.street === 'preflop'
    ? preflopOrder(hand.seats, hand.button, seated, {
        // Straddles come from the state, never from `hand.actions`: a recording
        // UI validates and applies an action *before* it appends it, so reading
        // the record here would order the table off a stale action list.
        straddles: draft.betting.posts
          .filter((post) => post.kind === 'straddle')
          .map((post) => post.seat),
      })
    : postflopOrder(hand.seats, hand.button, seated)
}

function nextActingSeat(draft: Draft, hand: HandRecord, fromSeat?: number) {
  const live = contenders(draft, hand)

  if (live.length <= 1) {
    return null
  }

  const high = big(currentBet(draft))
  const owes = (seat: number) => big(draft.streetBets[seat]).lt(high)
  const actors = live.filter((seat) => !draft.allIn.includes(seat))

  if (actors.length === 0 || (actors.length === 1 && !actors.some(owes))) {
    return null
  }

  const pending = actors.filter(
    (seat) => owes(seat) || !draft.betting.actedSeats.includes(seat),
  )

  if (pending.length === 0) {
    return null
  }

  const order = streetOrder(draft, hand)
  const rotated =
    fromSeat == null || order.indexOf(fromSeat) < 0
      ? order
      : [
          ...order.slice(order.indexOf(fromSeat) + 1),
          ...order.slice(0, order.indexOf(fromSeat) + 1),
        ]

  return rotated.find((seat) => pending.includes(seat)) ?? null
}

/**
 * Split the collected chips into a main pot and side pots.
 *
 * Standard layering: sort the per-seat contributions ascending and cut a pot at
 * every distinct level. Folded players' chips stay in the pot but their seats
 * drop out of `eligible`. Adjacent layers with the same eligible seats are
 * merged so a hand without all-ins yields exactly one pot.
 */
function computePots(draft: Draft, hand: HandRecord): Pot[] {
  const seated = seatedSeats(hand)
  const collected = new Map<number, Big>()

  seated.forEach((seat) => {
    collected.set(
      seat,
      big(draft.committed[seat]).minus(big(draft.streetBets[seat])),
    )
  })

  const levels = [...new Set([...collected.values()].map(money))]
    .map((value) => new Big(value))
    .filter((value) => value.gt(0))
    .sort((left, right) => (left.lt(right) ? -1 : left.gt(right) ? 1 : 0))

  const layers: Pot[] = []
  let previous = ZERO

  levels.forEach((level) => {
    let amount = ZERO

    collected.forEach((value) => {
      amount = amount.plus(minBig(value, level).minus(minBig(value, previous)))
    })

    // A live player who has not matched this level yet is still eligible: only
    // an all-in short of it is locked out of the layer.
    const eligible = seated.filter(
      (seat) =>
        !draft.folded.includes(seat) &&
        ((collected.get(seat) ?? ZERO).gte(level) ||
          !draft.allIn.includes(seat)),
    )

    previous = level

    if (amount.gt(0)) {
      layers.push({ amount: money(amount), eligible })
    }
  })

  const merged: Pot[] = []

  layers.forEach((layer) => {
    const last = merged[merged.length - 1]

    if (
      last &&
      (layer.eligible.length === 0 || sameSeats(last.eligible, layer.eligible))
    ) {
      last.amount = money(big(last.amount).plus(layer.amount))
      return
    }

    merged.push({ amount: layer.amount, eligible: [...layer.eligible] })
  })

  // Dead money with nobody eligible (everyone at that level folded) rolls
  // forward into the next pot rather than becoming an unwinnable pot.
  while (merged.length > 1 && merged[0]!.eligible.length === 0) {
    const dead = merged.shift()!
    merged[0]!.amount = money(big(merged[0]!.amount).plus(dead.amount))
  }

  // Once a pot has a sole claimant it is won without requiring a reveal.
  // Later discards cannot destroy it. Preserve discard order for side pots.
  draft.mucked.forEach((seat) => {
    merged.forEach((pot) => {
      if (pot.eligible.length > 1)
        pot.eligible = pot.eligible.filter((candidate) => candidate !== seat)
    })
  })
  return merged
}

function commitChips(draft: Draft, seat: number, delta: Big) {
  draft.stacks[seat] = money(big(draft.stacks[seat]).minus(delta))
  draft.streetBets[seat] = money(big(draft.streetBets[seat]).plus(delta))
  draft.committed[seat] = money(big(draft.committed[seat]).plus(delta))

  if (big(draft.stacks[seat]).lte(0) && !draft.allIn.includes(seat)) {
    draft.allIn.push(seat)
  }
}

/**
 * Close the current street: return the uncalled portion of the largest bet to
 * its owner, then sweep every remaining street bet into the pots.
 */
function closeBetting(draft: Draft, hand: HandRecord) {
  const bets = seatedSeats(hand).map((seat) => ({
    seat,
    amount: big(draft.streetBets[seat]),
  }))
  const sorted = [...bets].sort((left, right) =>
    right.amount.cmp(left.amount),
  )
  const top = sorted[0]
  const second = sorted[1]

  if (top && second && top.amount.gt(second.amount)) {
    const refund = top.amount.minus(second.amount)
    draft.stacks[top.seat] = money(big(draft.stacks[top.seat]).plus(refund))
    draft.streetBets[top.seat] = money(second.amount)
    draft.committed[top.seat] = money(
      big(draft.committed[top.seat]).minus(refund),
    )

    if (big(draft.stacks[top.seat]).gt(0)) {
      draft.allIn = draft.allIn.filter((seat) => seat !== top.seat)
    }
  }

  seatedSeats(hand).forEach((seat) => {
    draft.streetBets[seat] = '0'
  })

  draft.betting = {
    lastRaiseSize: hand.blinds.bb,
    // The bring-in and the forced bets only exist preflop; postflop the high
    // bet stands alone and the order runs from the button.
    bringIn: '0',
    posts: [],
    actedSeats: [],
    aggressorSeat: null,
  }
  draft.pots = computePots(draft, hand)
}

/**
 * Smallest chip the hand deals in, taken from its currency: `''` is a chip
 * game and plays in whole chips, everything else follows ISO 4217 minor units.
 * `validateRecordStatic` rejects any amount that is not a multiple of it.
 */
function chipUnit(hand: HandRecord, step: number): Big {
  const unit = chipUnitForCurrency(hand.currency)

  if (unit === undefined) {
    throw new HandReplayError(
      `Unknown currency: ${hand.currency}`,
      step,
      undefined,
      'replay-failed',
    )
  }

  return new Big(unit)
}

/**
 * Can the recorded payout actually be paid out of these pots?
 *
 * Per-seat ceilings are not enough: two seats can each stay under their own
 * ceiling while competing for the same pot. Feasibility is exactly a bipartite
 * flow — source → pot (capacity: the pot) → eligible seat (unbounded) → sink
 * (capacity: that seat's award) — so run Edmonds-Karp and check it saturates
 * the pots. Everything is counted in whole chips as `bigint`, so a pot larger
 * than 2^53 is still exact.
 */
function isPayoutFeasible(
  pots: Pot[],
  declared: Map<number, Big>,
  unit: Big,
): boolean {
  const chips = (value: Big) => BigInt(value.div(unit).round(0, Big.roundDown).toFixed(0))
  const seats = [...declared.keys()]

  const source = 0
  const potNode = (index: number) => 1 + index
  const seatNode = (index: number) => 1 + pots.length + index
  const sink = 1 + pots.length + seats.length
  const size = sink + 1
  const capacity = Array.from({ length: size }, () =>
    new Array<bigint>(size).fill(0n),
  )
  const target = pots.reduce((sum, pot) => sum + chips(big(pot.amount)), 0n)

  pots.forEach((pot, index) => {
    capacity[source]![potNode(index)] = chips(big(pot.amount))

    seats.forEach((seat, seatIndex) => {
      if (pot.eligible.includes(seat)) {
        // No edge of its own can bind: the pot and the award do the limiting.
        capacity[potNode(index)]![seatNode(seatIndex)] = target
      }
    })
  })

  seats.forEach((seat, index) => {
    capacity[seatNode(index)]![sink] = chips(declared.get(seat) ?? ZERO)
  })

  let flow = 0n

  for (;;) {
    const parent = new Array<number>(size).fill(-1)
    parent[source] = source

    const queue = [source]

    while (queue.length > 0 && parent[sink] === -1) {
      const node = queue.shift()!

      for (let next = 0; next < size; next += 1) {
        if (parent[next] === -1 && capacity[node]![next]! > 0n) {
          parent[next] = node
          queue.push(next)
        }
      }
    }

    if (parent[sink] === -1) {
      break
    }

    let added = target

    for (let node = sink; node !== source; node = parent[node]!) {
      const available = capacity[parent[node]!]![node]!
      added = available < added ? available : added
    }

    for (let node = sink; node !== source; node = parent[node]!) {
      capacity[parent[node]!]![node]! -= added
      capacity[node]![parent[node]!]! += added
    }

    flow += added
  }

  return flow === target
}

function knownCards(hand: HandRecord, draft: Draft, seat: number) {
  const player = hand.players.find((entry) => entry.seat === seat)
  return draft.revealed[seat] ?? player?.cards
}

/**
 * The board as the `street` actions dealt it. `hand.board` is only ever a copy
 * of this, so cards it may carry beyond what was dealt never reach a showdown.
 */
function boardCards(draft: Draft) {
  return draft.board
}

function netResult(
  draft: Draft,
  hand: HandRecord,
  awards: Map<number, Big>,
): Record<number, string> {
  const net: Record<number, string> = {}

  hand.players.forEach((player) => {
    const award = awards.get(player.seat) ?? ZERO
    net[player.seat] = money(
      big(draft.stacks[player.seat]).plus(award).minus(player.stack),
    )
  })

  return net
}

/**
 * Pay out `hand.winners` as recorded, but only where the pots allow it: a
 * folded seat can never be paid, a seat can win at most the pots it is eligible
 * for, every pot needs a claimant, and the declared total must be the pot total.
 */
function awardManualWinners(draft: Draft, hand: HandRecord) {
  const declared = hand.winners ?? []
  const step = draft.step
  const fail = (message: string): never => {
    throw new HandReplayError(message, step, undefined, 'bad-winners')
  }
  const potTotal = draft.pots.reduce((sum, pot) => sum.plus(pot.amount), ZERO)
  const awards = new Map<number, Big>()

  declared.forEach((winner) => {
    if (draft.folded.includes(winner.seat)) {
      fail(`Seat ${winner.seat} folded and cannot be paid`)
    }

    if (!draft.pots.some((pot) => pot.eligible.includes(winner.seat))) {
      fail(`Seat ${winner.seat} is not eligible for any pot`)
    }

    if (big(winner.amount).lte(0)) {
      fail(`Seat ${winner.seat} was awarded a non-positive amount`)
    }

    awards.set(
      winner.seat,
      (awards.get(winner.seat) ?? ZERO).plus(winner.amount),
    )
  })

  awards.forEach((amount, seat) => {
    const claimable = draft.pots
      .filter((pot) => pot.eligible.includes(seat))
      .reduce((sum, pot) => sum.plus(pot.amount), ZERO)

    if (amount.gt(claimable)) {
      fail(
        `Seat ${seat} was awarded ${money(amount)} but can win at most ${money(claimable)}`,
      )
    }
  })

  const total = [...awards.values()].reduce((sum, value) => sum.plus(value), ZERO)

  if (!total.eq(potTotal)) {
    fail(
      `Winners are awarded ${money(total)} but the pots hold ${money(potTotal)}`,
    )
  }

  if (!isPayoutFeasible(draft.pots, awards, chipUnit(hand, draft.step))) {
    fail(
      'The recorded payout cannot be split across these pots: some pot has no eligible winner left to claim it',
    )
  }

  draft.result = {
    winners: [...awards.entries()].map(([seat, amount]) => ({
      seat,
      amount: money(amount),
    })),
    net: netResult(draft, hand, awards),
  }
}

function awardShowdown(
  draft: Draft,
  hand: HandRecord,
  scores: Map<number, HandScore>,
) {
  const unit = chipUnit(hand, draft.step)
  const oddChipOrder = postflopOrder(hand.seats, hand.button, seatedSeats(hand))
  const awards = new Map<number, Big>()

  draft.pots.forEach((pot) => {
    if (pot.eligible.length === 1) {
      const seat = pot.eligible[0]!
      awards.set(seat, (awards.get(seat) ?? ZERO).plus(pot.amount))
      return
    }
    const eligible = pot.eligible.filter((seat) => scores.has(seat))

    if (eligible.length === 0) {
      return
    }

    const best = eligible.reduce((leader, seat) =>
      compareHandScores(scores.get(seat)!, scores.get(leader)!) > 0
        ? seat
        : leader,
    )
    const winners = eligible.filter(
      (seat) => compareHandScores(scores.get(seat)!, scores.get(best)!) === 0,
    )
    const amount = big(pot.amount)
    const units = amount.div(unit).round(0, Big.roundDown)
    const perWinner = units
      .div(winners.length)
      .round(0, Big.roundDown)
      .times(unit)
    let remainder = amount.minus(perWinner.times(winners.length))

    winners.forEach((seat) => {
      awards.set(seat, (awards.get(seat) ?? ZERO).plus(perWinner))
    })

    // Odd chips go one at a time starting from the seat left of the button.
    oddChipOrder
      .filter((seat) => winners.includes(seat))
      .forEach((seat) => {
        if (remainder.lte(0)) {
          return
        }

        const chip = minBig(unit, remainder)
        awards.set(seat, (awards.get(seat) ?? ZERO).plus(chip))
        remainder = remainder.minus(chip)
      })
  })

  draft.result = {
    winners: [...awards.entries()]
      .sort(([left], [right]) => left - right)
      .map(([seat, amount]) => {
        const score = scores.get(seat)
        const entry: HandResult['winners'][number] = {
          seat,
          amount: money(amount),
        }

        if (score) {
          entry.handName = HAND_CATEGORY_NAMES[score.category]
        }

        return entry
      }),
    net: netResult(draft, hand, awards),
  }
}

function finalize(draft: Draft, hand: HandRecord) {
  closeBetting(draft, hand)
  draft.actingSeat = null
  draft.isComplete = true

  const live = contenders(draft, hand)
  const potTotal = draft.pots.reduce((sum, pot) => sum.plus(pot.amount), ZERO)

  if (live.length <= 1) {
    const winner = live[0]

    if (winner == null) {
      draft.result = { winners: [], net: netResult(draft, hand, new Map()) }
      return
    }

    const awards = new Map<number, Big>([[winner, potTotal]])
    draft.result = {
      winners: [{ seat: winner, amount: money(potTotal) }],
      net: netResult(draft, hand, awards),
    }
    return
  }

  draft.street = 'showdown'

  const board = boardCards(draft)
  const holes = new Map<number, string>()

  live.filter((seat) => !draft.mucked.includes(seat)).forEach((seat) => {
    const cards = knownCards(hand, draft, seat)

    if (cards && cards.length === 4) {
      holes.set(seat, cards)
    }
  })

  const contested = draft.pots.filter((pot) => pot.eligible.length > 1)
  if (board.length < 10 || contested.some((pot) =>
    pot.eligible.some((seat) => !holes.has(seat)))) {
    if (hand.winners && hand.winners.length > 0) {
      awardManualWinners(draft, hand)
      return
    }

    draft.needsWinners = true
    return
  }

  const community = parseCards(board)
  const scores = new Map<number, HandScore>()

  holes.forEach((cards, seat) => {
    scores.set(seat, evaluateBestHand([...community, ...parseCards(cards)]))
  })

  awardShowdown(draft, hand, scores)
}

/**
 * Forced bets the hand is still missing, in plain English. Empty when the small
 * blind, the big blind and any configured ante have all been posted.
 *
 * An ante is only required when `anteType` says who owes one: `'bb'` puts it on
 * the big blind, `'each'` on every seat.
 */
export function missingForcedBets(
  hand: HandRecord,
  posted: readonly PostedBlind[],
  stacks: Record<number, string>,
): string[] {
  const seated = seatedSeats(hand)
  const { sb, bb } = blindSeats(hand.seats, hand.button, seated)
  const has = (kind: PostedBlind['kind'], seat: number) =>
    posted.some((post) => post.kind === kind && post.seat === seat)
  // A seat with nothing left owes nothing more: the ante is taken first, and
  // one that swallows the stack leaves no blind to post.
  const broke = (seat: number) => big(stacks[seat]).lte(0)
  const missing: string[] = []

  if (!has('sb', sb) && !broke(sb)) {
    missing.push(`the small blind from seat ${sb}`)
  }

  if (!has('bb', bb) && !broke(bb)) {
    missing.push(`the big blind from seat ${bb}`)
  }

  if (hand.blinds.ante !== undefined) {
    if (hand.blinds.anteType === 'bb' && !has('ante', bb) && !broke(bb)) {
      missing.push(`the big-blind ante from seat ${bb}`)
    }

    if (hand.blinds.anteType === 'each') {
      seated
        .filter((seat) => !has('ante', seat) && !broke(seat))
        .forEach((seat) => missing.push(`the ante from seat ${seat}`))
    }
  }

  return missing
}

/** Table state before any action, including the blinds, has been applied. */
export function initialState(hand: HandRecord): TableState {
  const seated = seatedSeats(hand)

  if (seated.length !== hand.players.length) {
    throw new HandReplayError('Duplicate seats in players', 0)
  }

  const stacks: Record<number, string> = {}
  const streetBets: Record<number, string> = {}
  const committed: Record<number, string> = {}

  hand.players.forEach((player) => {
    stacks[player.seat] = money(big(player.stack))
    streetBets[player.seat] = '0'
    committed[player.seat] = '0'
  })

  const draft: Draft = {
    step: 0,
    street: 'preflop',
    board: '',
    stacks,
    streetBets,
    committed,
    pots: [],
    folded: [],
    mucked: [],
    allIn: [],
    revealed: {},
    betting: {
      lastRaiseSize: hand.blinds.bb,
      // Preflop the table plays for the big blind whether or not anyone was
      // able to post it: a blind all-in for less does not lower the stakes.
      bringIn: hand.blinds.bb,
      posts: [],
      actedSeats: [],
      aggressorSeat: null,
    },
    actingSeat: null,
    lastAction: undefined,
    isComplete: false,
    result: undefined,
    needsWinners: false,
  }

  // Blind seats are validated here so a bad button fails fast.
  blindSeats(hand.seats, hand.button, seated)
  draft.actingSeat = nextActingSeat(draft, hand)

  return toState(draft)
}

function requireSeated(hand: HandRecord, seat: number, step: number, action: HandAction) {
  if (!hand.players.some((player) => player.seat === seat)) {
    throw new HandReplayError(`Seat ${seat} is not seated`, step, action)
  }
}

/**
 * Apply one action and return a new state. Never mutates `state`.
 *
 * Throws {@link HandReplayError} on a structurally impossible action (unseated
 * seat, a folded seat acting, a raise larger than the stack). Amount rules that
 * merely make a hand *illegal* rather than unreplayable — an undersized raise,
 * acting out of turn — are reported by `validateAction` instead.
 */
export function applyAction(
  state: TableState,
  action: HandAction,
  hand: HandRecord,
): TableState {
  const draft = toDraft(state)
  const step = state.step

  if (draft.isComplete && action.t !== 'show' && action.t !== 'street') {
    throw new HandReplayError('The hand is already complete', step, action)
  }

  if (action.t !== 'street') {
    requireSeated(hand, action.seat, step, action)
  }

  if (
    action.t !== 'street' &&
    action.t !== 'show' &&
    draft.folded.includes(action.seat)
  ) {
    throw new HandReplayError(
      `Seat ${action.seat} has already folded`,
      step,
      action,
    )
  }

  // The first voluntary action closes the posting window: everything the hand
  // owes has to be on the table by now.
  if (
    action.t !== 'post' &&
    action.t !== 'show' &&
    action.t !== 'muck' &&
    action.t !== 'street' &&
    draft.street === 'preflop' &&
    draft.betting.actedSeats.length === 0
  ) {
    const missing = missingForcedBets(hand, draft.betting.posts, draft.stacks)

    if (missing.length > 0) {
      throw new HandReplayError(
        `The action starts without ${missing.join(', ')}`,
        step,
        action,
      )
    }
  }

  let fromSeat: number | undefined

  switch (action.t) {
    case 'post': {
      if (draft.street !== 'preflop') {
        throw new HandReplayError(
          `A ${action.kind} can only be posted preflop, not on the ${draft.street}`,
          step,
          action,
        )
      }

      const stack = big(draft.stacks[action.seat])
      const amount = big(action.amount)

      if (amount.lt(0)) {
        throw new HandReplayError('Posts cannot be negative', step, action)
      }

      // A short stack posts what it has; it never posts chips it does not
      // have, and the engine will not silently trim the amount to fit.
      if (amount.gt(stack)) {
        throw new HandReplayError(
          `Seat ${action.seat} cannot post ${money(amount)} out of ${money(stack)}`,
          step,
          action,
        )
      }

      // Posting order is ante (for the seat that owes one) → SB → BB →
      // straddle chain. Judged **before** the chips move: once they have, the
      // straddler's stack reads as spent and would excuse it from the very
      // blind it is skipping.
      if (action.kind === 'straddle') {
        const owing = missingForcedBets(hand, draft.betting.posts, draft.stacks)

        if (owing.length > 0) {
          throw new HandReplayError(
            `A straddle comes after ${owing.join(', ')}`,
            step,
            action,
          )
        }
      }

      if (action.kind === 'ante') {
        // Antes never join the street bets: they are dead money in the pot.
        draft.stacks[action.seat] = money(stack.minus(amount))
        draft.committed[action.seat] = money(
          big(draft.committed[action.seat]).plus(amount),
        )

        if (big(draft.stacks[action.seat]).lte(0)) {
          if (!draft.allIn.includes(action.seat)) {
            draft.allIn.push(action.seat)
          }
        }
      } else {
        commitChips(draft, action.seat, amount)
      }

      draft.betting.posts.push({
        seat: action.seat,
        kind: action.kind,
        amount: money(amount),
      })

      if (action.kind === 'straddle') {
        const bringIn = big(draft.betting.bringIn)
        // What the straddler now has out on the street — heads-up that
        // includes the small blind it already posted.
        const total = big(draft.streetBets[action.seat])

        draft.betting.bringIn = money(total.gt(bringIn) ? total : bringIn)

        // Only a straddle that doubles what it sits behind is a raise. One
        // all-in for less lifts the amount to call but not the raise
        // increment, so the next raise is still measured from the blind.
        if (total.gte(bringIn.times(2))) {
          draft.betting.lastRaiseSize = money(
            big(draft.betting.lastRaiseSize).gt(total)
              ? big(draft.betting.lastRaiseSize)
              : total,
          )
        }
      }

      break
    }

    case 'fold': {
      draft.folded.push(action.seat)
      draft.betting.actedSeats.push(action.seat)
      fromSeat = action.seat
      break
    }

    case 'check': {
      if (!draft.betting.actedSeats.includes(action.seat)) {
        draft.betting.actedSeats.push(action.seat)
      }

      fromSeat = action.seat
      break
    }

    case 'call': {
      const current = big(draft.streetBets[action.seat])
      const target = big(action.amount)

      if (target.lt(current)) {
        throw new HandReplayError(
          'Call amount is below the chips already wagered on this street',
          step,
          action,
        )
      }

      const stack = big(draft.stacks[action.seat])
      const delta = minBig(target.minus(current), stack)

      commitChips(draft, action.seat, delta)

      if (!draft.betting.actedSeats.includes(action.seat)) {
        draft.betting.actedSeats.push(action.seat)
      }

      fromSeat = action.seat
      break
    }

    case 'bet':
    case 'raise':
    case 'allin': {
      const high = big(currentBet(draft))
      const current = big(draft.streetBets[action.seat])
      const target = big(action.to)
      const stack = big(draft.stacks[action.seat])
      const delta = target.minus(current)

      if (delta.lte(0)) {
        throw new HandReplayError(
          `A ${action.t} must add chips to the pot`,
          step,
          action,
        )
      }

      if (delta.gt(stack)) {
        throw new HandReplayError(
          `Seat ${action.seat} cannot wager more than its stack`,
          step,
          action,
        )
      }

      if (action.t === 'allin' && !delta.eq(stack)) {
        throw new HandReplayError(
          'An all-in must commit the whole remaining stack',
          step,
          action,
        )
      }

      commitChips(draft, action.seat, delta)

      const increment = target.minus(high)
      const bringIn = big(draft.betting.bringIn)
      const blind = big(hand.blinds.bb)
      // Opening a street takes at least a big blind (preflop: the bring-in).
      const minOpen =
        draft.street === 'preflop' && bringIn.gt(blind) ? bringIn : blind
      const isFullRaise = high.lte(0)
        ? target.gte(minOpen)
        : increment.gte(big(draft.betting.lastRaiseSize))

      if (isFullRaise) {
        // A full bet or raise reopens the betting for everyone.
        draft.betting.lastRaiseSize = money(increment)
        draft.betting.actedSeats = [action.seat]
      } else if (!draft.betting.actedSeats.includes(action.seat)) {
        // An all-in short of a full bet or raise does not reopen it, and it
        // must not shrink the minimum raise either.
        draft.betting.actedSeats.push(action.seat)
      }

      draft.betting.aggressorSeat = action.seat
      fromSeat = action.seat
      break
    }

    case 'street': {
      // `hand.board` is deliberately not consulted: the reducer runs off the
      // state alone, and `validateRecordStatic` is where the copy is checked.
      const dealt = draft.board + action.cards

      if (!draft.isComplete) {
        closeBetting(draft, hand)
      }

      draft.street = action.street
      draft.board = dealt
      break
    }

    case 'muck': {
      if (hand.v !== 2 || draft.board.length !== 10 || draft.actingSeat !== null ||
          draft.mucked.includes(action.seat) || draft.revealed[action.seat]) {
        throw new HandReplayError('Muck requires an unrevealed live hand at a closed showdown in v2', step, action)
      }
      draft.mucked.push(action.seat)
      break
    }

    case 'show': {
      if (draft.mucked.includes(action.seat))
        throw new HandReplayError('A mucked hand cannot be shown', step, action)
      draft.revealed[action.seat] = action.cards
      break
    }
  }

  draft.step = step + 1
  draft.lastAction = action

  if (draft.isComplete) {
    return toState(draft)
  }

  draft.pots = computePots(draft, hand)

  if (contenders(draft, hand).length <= 1) {
    finalize(draft, hand)
    return toState(draft)
  }

  draft.actingSeat = nextActingSeat(draft, hand, fromSeat)

  return toState(draft)
}

/** Number of replay steps; `replay(hand, stepCount(hand))` is the final state. */
export function stepCount(hand: HandRecord): number {
  return hand.actions.length
}

/**
 * Settle the hand once the action list runs out — but only when it is actually
 * over. A record that stops while a seat still has to act stays in progress:
 * nothing is swept, refunded or paid, and the recording UI renders that state
 * as the hand it is still writing.
 */
function settleIfOver(state: TableState, hand: HandRecord): TableState {
  if (state.isComplete || state.actingSeat !== null) {
    return state
  }

  const draft = toDraft(state)
  finalize(draft, hand)

  return toState(draft)
}

/**
 * Replay the hand up to `step` actions (default: all of them). When the action
 * list is exhausted and nobody is left to act, the state is finalized: pots
 * swept, uncalled bets returned and `result` filled in.
 */
export function replay(hand: HandRecord, step?: number): TableState {
  const target = Math.max(0, Math.min(step ?? hand.actions.length, hand.actions.length))
  let state = initialState(hand)

  for (let index = 0; index < target; index += 1) {
    state = applyAction(state, hand.actions[index]!, hand)
  }

  return target === hand.actions.length ? settleIfOver(state, hand) : state
}

/** Every state from step 0 to the final one, for step-by-step playback. */
export function replayAll(hand: HandRecord): TableState[] {
  const states: TableState[] = [initialState(hand)]

  hand.actions.forEach((action, index) => {
    states.push(applyAction(states[index]!, action, hand))
  })

  states[states.length - 1] = settleIfOver(states[states.length - 1]!, hand)

  return states
}
