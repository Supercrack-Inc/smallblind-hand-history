/**
 * Legality checks for the recording UI and for whole records.
 *
 * `validateRecordStatic` answers "is this shape sane?" without replaying — the
 * URL codec runs it on everything it decodes. `legalActions` answers "what may
 * this seat do right now?", `validateAction` answers "may this exact action be
 * appended?", and `validateRecord` = static checks plus a full replay. All of
 * them are pure and free of I/O.
 */

import Big from 'big.js'

import { chipUnitForCurrency, isSupportedCurrency } from './currency'
import { blindSeats, seatOrderFromButton } from './positions'
import {
  applyAction,
  currentBet,
  HandReplayError,
  initialState,
  missingForcedBets,
  replay,
  seatedSeats,
} from './replay'
import type {
  HandAction,
  HandRecord,
  LegalActions,
  PostedBlind,
  TableState,
} from './types'

/** Machine-readable reason a hand or action was rejected. */
export type ValidationErrorCode =
  | 'bad-version'
  | 'bad-table-size'
  | 'bad-button'
  | 'bad-seat'
  | 'duplicate-seat'
  | 'bad-blinds'
  | 'bad-currency'
  | 'bad-stack'
  | 'bad-cards'
  | 'duplicate-card'
  | 'not-your-turn'
  | 'illegal-action'
  | 'illegal-amount'
  | 'street-not-closed'
  | 'bad-street'
  | 'bad-board'
  | 'bad-winners'
  | 'replay-failed'

/** One problem found in a hand record or a proposed action. */
export type ValidationError = {
  /** Stable code, safe to switch on. */
  code: ValidationErrorCode
  /** English description; callers localize by `code` if they need to. */
  message: string
  /** Index into `HandRecord.actions`, when the problem belongs to an action. */
  step?: number
  /** Seat the problem belongs to, when it has one. */
  seat?: number
}

const ZERO = new Big(0)

/** Non-negative decimal string: the only money format the record allows. */
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/

function big(value: string | undefined) {
  return new Big(value ?? '0')
}

function money(value: Big) {
  return value.toFixed()
}

function error(
  code: ValidationErrorCode,
  message: string,
  extra?: { step?: number; seat?: number },
): ValidationError {
  const result: ValidationError = { code, message }

  if (extra?.step !== undefined) {
    result.step = extra.step
  }

  if (extra?.seat !== undefined) {
    result.seat = extra.seat
  }

  return result
}

/** The one spelling the format accepts: `"Ah"`, never `"AH"` or `"ah"`. */
const CARD_PATTERN = /^([2-9TJQKA][shdc])+$/

function isValidCards(value: string, expectedCards: number) {
  return (
    typeof value === 'string' &&
    value.length === expectedCards * 2 &&
    CARD_PATTERN.test(value)
  )
}

/** Any card string in the record: hole cards, a street's cards, the board. */
function isCardString(value: string) {
  return typeof value === 'string' && CARD_PATTERN.test(value)
}

function isAmount(value: string | undefined) {
  return typeof value === 'string' && AMOUNT_PATTERN.test(value)
}

/** Stacks after the forced bets in `posted` came out of them. */
function stacksAfter(hand: HandRecord, posted: readonly PostedBlind[]) {
  const stacks: Record<number, string> = {}

  hand.players.forEach((player) => {
    const spent = posted
      .filter((post) => post.seat === player.seat)
      .reduce((sum, post) => sum.plus(post.amount), ZERO)

    stacks[player.seat] = big(player.stack).minus(spent).toFixed()
  })

  return stacks
}

/** The chip this hand plays in, or `null` when the currency is not one we know. */
function unitOf(hand: HandRecord) {
  const unit = chipUnitForCurrency(hand.currency)
  return unit === undefined ? null : new Big(unit)
}

/** Whether an amount can be made from whole chips of `unit`. */
function isWholeChips(value: string | undefined, unit: Big) {
  return isAmount(value) && big(value).mod(unit).eq(ZERO)
}

/** Cards visible in the record: every player's hole cards plus the board. */
function recordCards(hand: HandRecord) {
  const cards: string[] = []

  hand.players.forEach((player) => {
    if (player.cards) {
      cards.push(player.cards)
    }
  })

  hand.actions.forEach((action) => {
    if (action.t === 'show') {
      const player = hand.players.find((entry) => entry.seat === action.seat)

      if (player?.cards !== action.cards) {
        cards.push(action.cards)
      }
    }

    if (action.t === 'street') {
      cards.push(action.cards)
    }
  })

  if (hand.board) {
    const dealt = hand.actions
      .filter((action) => action.t === 'street')
      .map((action) => (action.t === 'street' ? action.cards : ''))
      .join('')

    if (!dealt.startsWith(hand.board) && !hand.board.startsWith(dealt)) {
      cards.push(hand.board)
    } else if (hand.board.length > dealt.length) {
      cards.push(hand.board.slice(dealt.length))
    }
  }

  return cards.join('')
}

/**
 * Everything about a record that can be judged without replaying it: shape,
 * seating, money formats, card legality and street structure.
 *
 * Decoders run this over untrusted input before handing the record on. It never
 * throws and never touches the replay engine.
 */
export function validateRecordStatic(hand: HandRecord): ValidationError[] {
  const errors: ValidationError[] = []

  if (hand.v !== 1) {
    errors.push(error('bad-version', `Unsupported record version: ${hand.v}`))
  }

  if (!/^[A-Z]{3}$/.test(hand.currency) || !isSupportedCurrency(hand.currency)) {
    if (hand.currency !== '') {
      errors.push(
        error(
          'bad-currency',
          `Currency must be an active ISO 4217 code or '' for chips, got "${hand.currency}"`,
        ),
      )
    }
  }

  // Every amount has to be payable in whole chips of this currency.
  const unit = unitOf(hand)
  const chipCheck = (
    value: string,
    message: string,
    extra?: { step?: number; seat?: number },
  ) => {
    if (unit && isAmount(value) && !isWholeChips(value, unit)) {
      errors.push(
        error(
          'illegal-amount',
          `${message} is not a whole number of ${money(unit)} chips: ${value}`,
          extra,
        ),
      )
    }
  }

  const seatsValid =
    Number.isInteger(hand.seats) && hand.seats >= 2 && hand.seats <= 10

  if (!seatsValid) {
    errors.push(
      error('bad-table-size', `Table size must be 2..10, got ${hand.seats}`),
    )
  }

  if (!Array.isArray(hand.players) || hand.players.length < 2) {
    errors.push(error('bad-seat', 'At least two players must be seated'))
    return errors
  }

  if (seatsValid && hand.players.length > hand.seats) {
    errors.push(
      error(
        'bad-table-size',
        `${hand.players.length} players will not fit in ${hand.seats} seats`,
      ),
    )
  }

  const seats = new Set<number>()

  hand.players.forEach((player) => {
    if (
      !Number.isInteger(player.seat) ||
      player.seat < 0 ||
      (seatsValid && player.seat >= hand.seats)
    ) {
      errors.push(
        error('bad-seat', `Seat ${player.seat} is off the table`, {
          seat: player.seat,
        }),
      )
    }

    if (seats.has(player.seat)) {
      errors.push(
        error('duplicate-seat', `Seat ${player.seat} is occupied twice`, {
          seat: player.seat,
        }),
      )
    }

    seats.add(player.seat)

    if (!isAmount(player.stack) || big(player.stack).lte(ZERO)) {
      errors.push(
        error('bad-stack', `Seat ${player.seat} has an invalid stack`, {
          seat: player.seat,
        }),
      )
    }

    chipCheck(player.stack, `The stack of seat ${player.seat}`, {
      seat: player.seat,
    })

    if (player.cards !== undefined && !isValidCards(player.cards, 2)) {
      errors.push(
        error('bad-cards', `Hole cards must be two cards: ${player.cards}`, {
          seat: player.seat,
        }),
      )
    }
  })

  if (!seats.has(hand.button)) {
    errors.push(error('bad-button', `Button seat ${hand.button} is empty`))
  }

  if (
    !isAmount(hand.blinds.sb) ||
    !isAmount(hand.blinds.bb) ||
    big(hand.blinds.sb).lte(ZERO) ||
    big(hand.blinds.bb).lte(ZERO)
  ) {
    errors.push(error('bad-blinds', 'Blinds must be positive amounts'))
  }

  if (
    hand.blinds.ante !== undefined &&
    (!isAmount(hand.blinds.ante) || big(hand.blinds.ante).lte(ZERO))
  ) {
    errors.push(error('bad-blinds', 'The ante must be a positive amount'))
  }

  chipCheck(hand.blinds.sb, 'The small blind')
  chipCheck(hand.blinds.bb, 'The big blind')

  if (hand.blinds.ante !== undefined) {
    chipCheck(hand.blinds.ante, 'The ante')
  }

  // A board is three, four or five cards — six, eight or ten characters.
  if (
    hand.board !== undefined &&
    (![0, 6, 8, 10].includes(hand.board.length) ||
      (hand.board !== '' && !isCardString(hand.board)))
  ) {
    errors.push(error('bad-board', `Invalid board: ${hand.board}`))
  }

  // `board` is a copy of what the street actions dealt, never a source of extra
  // cards: an unrecorded runout is a missing action, not a longer board.
  const dealtBoard = hand.actions
    .filter((action) => action.t === 'street')
    .map((action) => (action.t === 'street' ? action.cards : ''))
    .join('')

  if (hand.board !== undefined && hand.board !== dealtBoard) {
    errors.push(
      error(
        'bad-board',
        `The board ${hand.board || '(empty)'} is not what the streets dealt (${dealtBoard || 'nothing'})`,
      ),
    )
  }

  const dealtStreets: Array<'flop' | 'turn' | 'river'> = []

  hand.actions.forEach((action, step) => {
    if (action.t === 'street') {
      const expectedCards = action.street === 'flop' ? 3 : 1
      const expectedPrevious =
        action.street === 'flop'
          ? undefined
          : action.street === 'turn'
            ? 'flop'
            : 'turn'
      const previous = dealtStreets[dealtStreets.length - 1]

      if (previous !== expectedPrevious) {
        errors.push(
          error(
            'bad-street',
            `The ${action.street} cannot follow ${previous ?? 'the preflop'}`,
            { step },
          ),
        )
      }

      if (!isValidCards(action.cards, expectedCards)) {
        errors.push(
          error(
            'bad-board',
            `The ${action.street} needs ${expectedCards} card(s), got "${action.cards}"`,
            { step },
          ),
        )
      }

      dealtStreets.push(action.street)
      return
    }

    if (!seats.has(action.seat)) {
      errors.push(
        error('bad-seat', `Seat ${action.seat} is not seated`, {
          step,
          seat: action.seat,
        }),
      )
    }

    if (action.t === 'show' && !isValidCards(action.cards, 2)) {
      errors.push(
        error('bad-cards', `Shown cards must be two cards: ${action.cards}`, {
          step,
          seat: action.seat,
        }),
      )
    }

    if (action.t === 'post' || action.t === 'call') {
      if (!isAmount(action.amount) || big(action.amount).lte(ZERO)) {
        errors.push(
          error('illegal-amount', `Invalid amount: ${action.amount}`, {
            step,
            seat: action.seat,
          }),
        )
      }

      chipCheck(action.amount, 'The amount', { step, seat: action.seat })
    }

    if (action.t === 'bet' || action.t === 'raise' || action.t === 'allin') {
      if (!isAmount(action.to) || big(action.to).lte(ZERO)) {
        errors.push(
          error('illegal-amount', `Invalid amount: ${action.to}`, {
            step,
            seat: action.seat,
          }),
        )
      }

      chipCheck(action.to, 'The amount', { step, seat: action.seat })
    }
  })

  ;(hand.winners ?? []).forEach((winner) => {
    if (!seats.has(winner.seat)) {
      errors.push(
        error('bad-winners', `Winner seat ${winner.seat} is empty`, {
          seat: winner.seat,
        }),
      )
    }

    if (!isAmount(winner.amount) || big(winner.amount).lte(ZERO)) {
      errors.push(
        error('bad-winners', `Invalid award: ${winner.amount}`, {
          seat: winner.seat,
        }),
      )
    }

    chipCheck(winner.amount, `The award to seat ${winner.seat}`, {
      seat: winner.seat,
    })
  })

  // Duplicates are only meaningful once every card is spelled the one way, so
  // a malformed card is reported as such and the scan is left for next time.
  if (errors.some((problem) => problem.code === 'bad-cards')) {
    return errors
  }

  const cards = recordCards(hand).match(/../g) ?? []
  const uniqueCards = new Set<string>()

  cards.forEach((card) => {
    if (!isCardString(card)) {
      errors.push(error('bad-cards', `Invalid card: ${card}`))
      return
    }

    if (uniqueCards.has(card)) {
      errors.push(error('duplicate-card', `Card ${card} appears twice`))
    }

    uniqueCards.add(card)
  })

  return errors
}

/**
 * What the seat to act may legally do, or `null` when nobody is to act.
 *
 * Minimum raise is the last full raise increment on top of the current bet (the
 * big blind when nothing has been raised yet). A seat that already acted cannot
 * raise again while the action stays closed — but undersized all-ins that add
 * up to a full raise over what it matched reopen it — so `minRaiseTo` and
 * `maxRaiseTo` are omitted only while it is closed.
 */
export function legalActions(
  state: TableState,
  hand: HandRecord,
): LegalActions | null {
  const seat = state.actingSeat

  if (seat == null || state.isComplete) {
    return null
  }

  const stack = big(state.stacks[seat])
  const wagered = big(state.streetBets[seat])
  const high = big(currentBet(state))
  const owed = high.minus(wagered)
  const canCheck = owed.lte(0)
  const recorded = big(state.betting.lastRaiseSize)
  const floor = big(hand.blinds.bb)
  // An opening bet is never smaller than the big blind.
  const minIncrement = high.lte(0) && floor.gt(recorded) ? floor : recorded
  // Either the seat has not acted since the last full raise, or the raises it
  // has not answered yet add up to one.
  const canReopen =
    !state.betting.actedSeats.includes(seat) || owed.gte(minIncrement)

  const result: LegalActions = {
    canFold: owed.gt(0),
    canCheck,
    canAllIn: stack.gt(0),
  }

  if (owed.gt(0)) {
    result.callAmount = money(owed.gt(stack) ? stack : owed)
  }

  if (stack.gt(owed) && (canReopen || canCheck)) {
    const wanted = high.plus(minIncrement)
    const maxRaiseTo = wagered.plus(stack)

    result.minRaiseTo = money(wanted.gt(maxRaiseTo) ? maxRaiseTo : wanted)
    result.maxRaiseTo = money(maxRaiseTo)
  }

  return result
}

function validateBettingAction(
  state: TableState,
  action: Extract<
    HandAction,
    { t: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin' }
  >,
  hand: HandRecord,
): ValidationError | null {
  const legal = legalActions(state, hand)

  if (!legal || state.actingSeat !== action.seat) {
    return error(
      'not-your-turn',
      `Seat ${action.seat} is not the seat to act`,
      { step: state.step, seat: action.seat },
    )
  }

  const seat = action.seat
  const wagered = big(state.streetBets[seat])
  const stack = big(state.stacks[seat])
  const high = big(currentBet(state))

  switch (action.t) {
    case 'fold':
      return legal.canFold
        ? null
        : error('illegal-action', 'Nothing to fold to; check instead', {
            step: state.step,
            seat,
          })

    case 'check':
      return legal.canCheck
        ? null
        : error('illegal-action', 'Cannot check while facing a bet', {
            step: state.step,
            seat,
          })

    case 'call': {
      if (!legal.callAmount) {
        return error('illegal-action', 'There is nothing to call', {
          step: state.step,
          seat,
        })
      }

      const expected = wagered.plus(legal.callAmount)

      return big(action.amount).eq(expected)
        ? null
        : error(
            'illegal-amount',
            `Call must bring the street wager to ${money(expected)}`,
            { step: state.step, seat },
          )
    }

    case 'bet':
    case 'raise':
    case 'allin': {
      const to = big(action.to)
      const maxTo = wagered.plus(stack)

      if (to.gt(maxTo)) {
        return error(
          'illegal-amount',
          `Seat ${seat} has only ${money(maxTo)} to wager on this street`,
          { step: state.step, seat },
        )
      }

      if (action.t === 'allin' && !to.eq(maxTo)) {
        return error('illegal-amount', `An all-in must be to ${money(maxTo)}`, {
          step: state.step,
          seat,
        })
      }

      // An all-in that does not get past the current bet is a call, not a
      // raise: it needs chips left to move in, not a reopened action.
      if (action.t === 'allin' && to.lte(high)) {
        return stack.gt(0)
          ? null
          : error('illegal-action', 'There are no chips left to move in', {
              step: state.step,
              seat,
            })
      }

      if (action.t === 'bet' && high.gt(0)) {
        return error('illegal-action', 'Facing a bet — raise instead of bet', {
          step: state.step,
          seat,
        })
      }

      if (action.t === 'raise' && high.lte(0)) {
        return error('illegal-action', 'Nothing to raise — bet instead', {
          step: state.step,
          seat,
        })
      }

      if (action.t !== 'allin' && to.lte(high)) {
        return error(
          'illegal-amount',
          `A ${action.t} must get past the current bet of ${money(high)}`,
          { step: state.step, seat },
        )
      }

      // Past this point the action raises the bet, all-in or not, so the seat
      // needs the right to reopen it.
      if (!legal.minRaiseTo) {
        return error(
          'illegal-action',
          'The betting was not reopened for this seat',
          { step: state.step, seat },
        )
      }

      if (to.lt(legal.minRaiseTo) && !to.eq(maxTo)) {
        return error(
          'illegal-amount',
          `Minimum is ${legal.minRaiseTo}; only an all-in may be smaller`,
          { step: state.step, seat },
        )
      }

      return null
    }
  }
}

/** Whether appending `action` to the state is legal. `null` means it is. */
export function validateAction(
  state: TableState,
  action: HandAction,
  hand: HandRecord,
): ValidationError | null {
  if (state.isComplete && action.t !== 'show') {
    return error('illegal-action', 'The hand is already complete', {
      step: state.step,
    })
  }

  if (action.t !== 'street') {
    if (!hand.players.some((player) => player.seat === action.seat)) {
      return error('bad-seat', `Seat ${action.seat} is not seated`, {
        step: state.step,
        seat: action.seat,
      })
    }

    if (action.t !== 'show' && state.folded.includes(action.seat)) {
      return error('illegal-action', `Seat ${action.seat} has folded`, {
        step: state.step,
        seat: action.seat,
      })
    }
  }

  // The first voluntary action closes the posting window — the same judgement
  // `applyAction` makes, so a recorder never gets a legal action it cannot
  // apply.
  if (
    action.t !== 'post' &&
    action.t !== 'show' &&
    action.t !== 'street' &&
    state.street === 'preflop' &&
    state.betting.actedSeats.length === 0
  ) {
    const missing = missingForcedBets(hand, state.betting.posts, state.stacks)

    if (missing.length > 0) {
      return error(
        'bad-blinds',
        `The action cannot start without ${missing.join(', ')}`,
        { step: state.step, seat: action.seat },
      )
    }
  }

  const seen = new Set(
    [
      state.board,
      ...hand.players.map((player) => player.cards ?? ''),
      ...Object.entries(state.revealed)
        .filter(
          ([seat]) =>
            !hand.players.find((entry) => entry.seat === Number(seat))?.cards,
        )
        .map(([, cards]) => cards),
    ]
      .join('')
      .match(/../g) ?? [],
  )

  const duplicate = (cards: string) => {
    const parsed = cards.match(/../g) ?? []
    return (
      new Set(parsed).size !== parsed.length ||
      parsed.some((card) => seen.has(card))
    )
  }

  switch (action.t) {
    case 'post': {
      if (!isAmount(action.amount) || big(action.amount).lte(ZERO)) {
        return error('illegal-amount', 'A post must be a positive amount', {
          step: state.step,
          seat: action.seat,
        })
      }

      // Forced bets belong to the start of the hand. Allowing one later would
      // revive the preflop bring-in and reset the minimum raise.
      if (state.street !== 'preflop') {
        return error(
          'illegal-action',
          `A ${action.kind} cannot be posted on the ${state.street}`,
          { step: state.step, seat: action.seat },
        )
      }

      if (state.betting.actedSeats.length > 0) {
        return error(
          'illegal-action',
          `A ${action.kind} cannot be posted once the action has started`,
          { step: state.step, seat: action.seat },
        )
      }

      const seated = seatedSeats(hand)
      const order = seatOrderFromButton(hand.seats, hand.button, seated)
      const { sb, bb } = blindSeats(hand.seats, hand.button, seated)
      // Straight from the state: a recorder appends the action after applying
      // it, so the record is always one behind here.
      const posted = state.betting.posts
      const already = (kind: 'sb' | 'bb') =>
        posted.some((entry) => entry.kind === kind)

      if (action.kind === 'sb' || action.kind === 'bb') {
        const expected = action.kind === 'sb' ? sb : bb

        if (action.seat !== expected) {
          return error(
            'illegal-action',
            `The ${action.kind} is posted by seat ${expected}, not seat ${action.seat}`,
            { step: state.step, seat: action.seat },
          )
        }

        if (already(action.kind)) {
          return error(
            'illegal-action',
            `The ${action.kind} was already posted`,
            { step: state.step, seat: action.seat },
          )
        }
      }

      if (action.kind === 'ante') {
        const antedTwice = posted.some(
          (entry) => entry.kind === 'ante' && entry.seat === action.seat,
        )

        if (antedTwice) {
          return error(
            'illegal-action',
            `Seat ${action.seat} has already anted`,
            { step: state.step, seat: action.seat },
          )
        }
      }

      // Antes come off the stack before the blinds do, so a seat that still
      // owes one cannot post a blind first.
      if (action.kind !== 'ante' && hand.blinds.ante !== undefined) {
        const owesAnte =
          hand.blinds.anteType === 'each' ||
          (hand.blinds.anteType === 'bb' && action.seat === bb)

        if (
          owesAnte &&
          !posted.some(
            (entry) => entry.kind === 'ante' && entry.seat === action.seat,
          )
        ) {
          return error(
            'illegal-action',
            `Seat ${action.seat} antes before posting the ${action.kind}`,
            { step: state.step, seat: action.seat },
          )
        }
      }

      if (action.kind === 'ante') {
        if (hand.blinds.ante === undefined) {
          return error('illegal-action', 'This game has no ante', {
            step: state.step,
            seat: action.seat,
          })
        }

        if (hand.blinds.anteType === 'bb' && action.seat !== bb) {
          return error(
            'illegal-action',
            `A big-blind ante is posted by seat ${bb}, not seat ${action.seat}`,
            { step: state.step, seat: action.seat },
          )
        }
      }

      const stack = big(state.stacks[action.seat])
      const posting = big(action.amount)

      if (action.kind === 'straddle') {
        // Posting order is ante → SB → BB → straddle chain: a straddle never
        // jumps the blinds, so a short stack cannot empty itself early and be
        // excused from a blind it never posted.
        const owing = missingForcedBets(hand, posted, state.stacks)

        if (owing.length > 0) {
          return error(
            'illegal-action',
            `A straddle comes after ${owing.join(', ')}`,
            { step: state.step, seat: action.seat },
          )
        }

        const straddles = posted.filter((entry) => entry.kind === 'straddle')
        const previous = straddles[straddles.length - 1]
        const anchor = previous ? previous.seat : bb
        const expected = order[(order.indexOf(anchor) + 1) % order.length]!

        if (action.seat !== expected) {
          return error(
            'illegal-action',
            `A straddle is posted from seat ${expected}, left of seat ${anchor}`,
            { step: state.step, seat: action.seat },
          )
        }

        // A straddle is a blind raise: it doubles what it sits behind — the
        // big blind, or the last straddle — counting everything the straddler
        // has on the street, which heads-up includes its small blind. It is
        // never more than the stack, and below the double only an all-in goes.
        const minimum = big(state.betting.bringIn).times(2)
        const total = posting.plus(state.streetBets[action.seat] ?? '0')

        if (posting.gt(stack)) {
          return error(
            'illegal-amount',
            `Seat ${action.seat} has only ${money(stack)} to straddle with`,
            { step: state.step, seat: action.seat },
          )
        }

        if (total.lt(minimum) && !posting.eq(stack)) {
          return error(
            'illegal-amount',
            `A straddle here is to at least ${money(minimum)}, or the whole stack`,
            { step: state.step, seat: action.seat },
          )
        }

        return null
      }

      // Blinds and antes are posted in full, or for the whole short stack.
      const configured = big(
        action.kind === 'sb'
          ? hand.blinds.sb
          : action.kind === 'bb'
            ? hand.blinds.bb
            : (hand.blinds.ante ?? '0'),
      )
      const owed = configured.gt(stack) ? stack : configured

      if (!posting.eq(owed)) {
        return error(
          'illegal-amount',
          `The ${action.kind} from seat ${action.seat} is ${money(owed)}, not ${money(posting)}`,
          { step: state.step, seat: action.seat },
        )
      }

      return null
    }

    case 'show': {
      if (!isValidCards(action.cards, 2)) {
        return error('bad-cards', `Invalid hole cards: ${action.cards}`, {
          step: state.step,
          seat: action.seat,
        })
      }

      const player = hand.players.find((entry) => entry.seat === action.seat)

      if (player?.cards && player.cards !== action.cards) {
        return error(
          'duplicate-card',
          `Seat ${action.seat} was recorded with ${player.cards}`,
          { step: state.step, seat: action.seat },
        )
      }

      return player?.cards === action.cards || !duplicate(action.cards)
        ? null
        : error('duplicate-card', `Card already in play: ${action.cards}`, {
            step: state.step,
            seat: action.seat,
          })
    }

    case 'street': {
      const expectedCards = action.street === 'flop' ? 3 : 1
      const expectedPrevious =
        action.street === 'flop'
          ? ['preflop']
          : action.street === 'turn'
            ? ['flop']
            : ['turn']

      if (!expectedPrevious.includes(state.street)) {
        return error(
          'bad-street',
          `Cannot deal the ${action.street} from ${state.street}`,
          { step: state.step },
        )
      }

      if (state.actingSeat !== null) {
        return error(
          'street-not-closed',
          `Seat ${state.actingSeat} still has to act`,
          { step: state.step, seat: state.actingSeat },
        )
      }

      if (!isValidCards(action.cards, expectedCards)) {
        return error(
          'bad-board',
          `The ${action.street} needs ${expectedCards} card(s), got "${action.cards}"`,
          { step: state.step },
        )
      }

      return duplicate(action.cards)
        ? error('duplicate-card', `Card already in play: ${action.cards}`, {
            step: state.step,
          })
        : null
    }

    default:
      return validateBettingAction(state, action, hand)
  }
}

/**
 * Static checks plus a full replay. An empty array means the record is sound
 * *and* finished: a hand whose actions run out while a seat still has to act is
 * reported as `street-not-closed`.
 */
export function validateRecord(hand: HandRecord): ValidationError[] {
  const errors = validateRecordStatic(hand)

  if (errors.length > 0) {
    return errors
  }

  // Everything the hand owes has to be posted before the first voluntary
  // action. A record that has not got there yet is simply still being written.
  const firstVoluntary = hand.actions.findIndex(
    (action) => action.t !== 'post' && action.t !== 'street',
  )

  if (firstVoluntary >= 0) {
    const posted: PostedBlind[] = hand.actions
      .slice(0, firstVoluntary)
      .flatMap((action) =>
        action.t === 'post'
          ? [{ seat: action.seat, kind: action.kind, amount: action.amount }]
          : [],
      )
    const missing = missingForcedBets(hand, posted, stacksAfter(hand, posted))

    if (missing.length > 0) {
      errors.push(
        error('bad-blinds', `The action starts without ${missing.join(', ')}`, {
          step: firstVoluntary,
        }),
      )
    }
  }

  let state: TableState

  try {
    state = initialState(hand)
  } catch (cause) {
    return [
      error(
        'replay-failed',
        cause instanceof Error ? cause.message : String(cause),
      ),
    ]
  }

  for (let index = 0; index < hand.actions.length; index += 1) {
    const action = hand.actions[index]!
    const problem = validateAction(state, action, hand)

    if (problem) {
      errors.push(problem)
      return errors
    }

    try {
      state = applyAction(state, action, hand)
    } catch (cause) {
      errors.push(
        error(
          cause instanceof HandReplayError ? cause.code : 'replay-failed',
          cause instanceof Error ? cause.message : String(cause),
          { step: index },
        ),
      )
      return errors
    }
  }

  if (!state.isComplete && state.actingSeat !== null) {
    errors.push(
      error(
        'street-not-closed',
        `The record ends while seat ${state.actingSeat} still has to act`,
        { step: hand.actions.length, seat: state.actingSeat },
      ),
    )
    return errors
  }

  // The loop above stops at the last action; the final state also needs the
  // pots swept and the showdown judged.
  try {
    state = replay(hand)
  } catch (cause) {
    errors.push(
      error(
        cause instanceof HandReplayError ? cause.code : 'replay-failed',
        cause instanceof Error ? cause.message : String(cause),
        { step: hand.actions.length },
      ),
    )
    return errors
  }

  // Recorded winners must agree with the settled pots, whether the engine took
  // them at face value (unknown cards) or worked the payout out itself.
  if (hand.winners && hand.winners.length > 0 && state.result) {
    const key = (entries: Array<{ seat: number; amount: string }>) =>
      entries
        .map((entry) => `${entry.seat}:${money(big(entry.amount))}`)
        .sort()
        .join(',')

    if (key(hand.winners) !== key(state.result.winners)) {
      errors.push(
        error(
          'bad-winners',
          `Recorded winners do not match the pots (${key(state.result.winners)})`,
        ),
      )
    }
  }

  if (state.needsWinners === true) {
    errors.push(
      error(
        'bad-winners',
        'The hand reaches showdown with unknown cards and no winners recorded',
      ),
    )
  }

  // Blind seats are derived, so a table with a mis-seated button fails here.
  try {
    blindSeats(hand.seats, hand.button, seatedSeats(hand))
  } catch (cause) {
    errors.push(
      error('bad-button', cause instanceof Error ? cause.message : 'Bad button'),
    )
  }

  return errors
}
