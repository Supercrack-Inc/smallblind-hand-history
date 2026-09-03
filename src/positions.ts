/**
 * Seat → position mapping and action order.
 *
 * Every function here works on **seat indexes**: `seats` is the table size,
 * `button` the seat holding the button, and `occupiedSeats` the seats that
 * actually have a player. Empty seats are skipped entirely, so a 9-max table
 * with four players uses the four-handed position table.
 */

/** Position names used for 2- to 10-handed tables. */
export type PositionLabel =
  | 'BTN'
  | 'SB'
  | 'BB'
  | 'UTG'
  | 'UTG+1'
  | 'UTG+2'
  | 'MP'
  | 'LJ'
  | 'HJ'
  | 'CO'

/**
 * Labels in clockwise order starting from the button, keyed by the number of
 * players actually seated. Heads-up folds SB into the button.
 */
const LABELS_BY_PLAYER_COUNT: Record<number, readonly PositionLabel[]> = {
  2: ['BTN', 'BB'],
  3: ['BTN', 'SB', 'BB'],
  4: ['BTN', 'SB', 'BB', 'UTG'],
  5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
  6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
  7: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'HJ', 'CO'],
  8: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO'],
  9: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO'],
  10: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'MP', 'LJ', 'HJ', 'CO'],
}

/** Options accepted by {@link preflopOrder} and {@link postflopOrder}. */
export type OrderOptions = {
  /** Seats to leave out, e.g. folded or all-in players. */
  exclude?: readonly number[]
}

/** Options accepted by {@link preflopOrder}. */
export type PreflopOrderOptions = OrderOptions & {
  /** Seats that posted a straddle; action starts left of the last one. */
  straddles?: readonly number[]
}

function normalizeSeats(seats: number, occupiedSeats: readonly number[]) {
  if (!Number.isInteger(seats) || seats < 2 || seats > 10) {
    throw new Error(`Table size must be an integer 2..10, got ${seats}`)
  }

  const unique = [...new Set(occupiedSeats)].sort((left, right) => left - right)

  unique.forEach((seat) => {
    if (!Number.isInteger(seat) || seat < 0 || seat >= seats) {
      throw new Error(`Seat ${seat} is outside a ${seats}-seat table`)
    }
  })

  if (unique.length < 2) {
    throw new Error('At least two players must be seated')
  }

  return unique
}

/**
 * Occupied seats in clockwise order, starting at the button.
 * Clockwise means ascending seat index, wrapping at the table size.
 */
export function seatOrderFromButton(
  seats: number,
  button: number,
  occupiedSeats: readonly number[],
): number[] {
  const seated = normalizeSeats(seats, occupiedSeats)

  if (!seated.includes(button)) {
    throw new Error(`Button seat ${button} is not occupied`)
  }

  const buttonIndex = seated.indexOf(button)
  return [...seated.slice(buttonIndex), ...seated.slice(0, buttonIndex)]
}

/** Position label for every occupied seat. */
export function positionLabels(
  seats: number,
  button: number,
  occupiedSeats: readonly number[],
): Record<number, PositionLabel> {
  const order = seatOrderFromButton(seats, button, occupiedSeats)
  const labels = LABELS_BY_PLAYER_COUNT[order.length]

  if (!labels) {
    throw new Error(`Unsupported player count: ${order.length}`)
  }

  const result: Record<number, PositionLabel> = {}

  order.forEach((seat, index) => {
    result[seat] = labels[index]!
  })

  return result
}

/**
 * Small and big blind seats. Heads-up the button posts the small blind, so
 * `sb === button`.
 */
export function blindSeats(
  seats: number,
  button: number,
  occupiedSeats: readonly number[],
): { sb: number; bb: number } {
  const order = seatOrderFromButton(seats, button, occupiedSeats)

  return order.length === 2
    ? { sb: order[0]!, bb: order[1]! }
    : { sb: order[1]!, bb: order[2]! }
}

function rotateAfter(order: readonly number[], seat: number) {
  const index = order.indexOf(seat)

  if (index < 0) {
    return [...order]
  }

  return [...order.slice(index + 1), ...order.slice(0, index + 1)]
}

function applyExclude(order: readonly number[], options?: OrderOptions) {
  const exclude = new Set(options?.exclude ?? [])
  return order.filter((seat) => !exclude.has(seat))
}

type StraddleResolution = {
  /** Seat the preflop action runs up to. */
  anchor: number
  /** True once a button straddle has closed straddling for the hand. */
  closed: boolean
}

function resolveStraddles(
  seats: number,
  button: number,
  occupiedSeats: readonly number[],
  straddles: readonly number[],
): StraddleResolution {
  const order = seatOrderFromButton(seats, button, occupiedSeats)
  const { bb } = blindSeats(seats, button, occupiedSeats)
  const leftOf = (seat: number) =>
    order[(order.indexOf(seat) + 1) % order.length]!

  let anchor = bb
  let closed = false

  straddles.forEach((seat) => {
    if (closed) {
      throw new Error(
        `Seat ${seat} cannot straddle behind the button straddle at seat ${anchor}`,
      )
    }

    if (seat === leftOf(anchor)) {
      // The ordinary chain: each straddle sits left of the one before it.
      anchor = seat
      return
    }

    if (anchor === bb && seat === button) {
      // A Mississippi straddle from the button, posted on its own.
      anchor = seat
      closed = true
      return
    }

    const alternative =
      anchor === bb && button !== leftOf(anchor)
        ? ` or from the button (seat ${button})`
        : ''

    throw new Error(
      `Straddle at seat ${seat} must be posted from seat ${leftOf(anchor)}${alternative}`,
    )
  })

  return { anchor, closed }
}

/**
 * Seat the preflop action runs up to — the big blind, or the last straddle.
 * Throws when the straddles are not a legal chain or button straddle.
 */
export function straddleAnchorSeat(
  seats: number,
  button: number,
  occupiedSeats: readonly number[],
  straddles: readonly number[] = [],
): number {
  return resolveStraddles(seats, button, occupiedSeats, straddles).anchor
}

/**
 * Seats that may post the next straddle: the seat left of the current anchor,
 * plus the button while no straddle has been posted yet (a Mississippi
 * straddle). Empty once a button straddle has closed straddling, or when the
 * straddles posted so far are not legal in the first place.
 */
export function nextStraddleSeats(
  seats: number,
  button: number,
  occupiedSeats: readonly number[],
  straddles: readonly number[] = [],
): number[] {
  let resolution: StraddleResolution

  try {
    resolution = resolveStraddles(seats, button, occupiedSeats, straddles)
  } catch {
    return []
  }

  if (resolution.closed) {
    return []
  }

  const order = seatOrderFromButton(seats, button, occupiedSeats)
  const chain =
    order[(order.indexOf(resolution.anchor) + 1) % order.length]!

  return straddles.length === 0 && button !== chain ? [chain, button] : [chain]
}

/**
 * Preflop action order: starts left of the big blind, or left of the last
 * straddle when straddles are in play — including a button straddle, which
 * puts the small blind in first and leaves the button to act last. Heads-up
 * the button (small blind) is first to act.
 */
export function preflopOrder(
  seats: number,
  button: number,
  occupiedSeats: readonly number[],
  options?: PreflopOrderOptions,
): number[] {
  const order = seatOrderFromButton(seats, button, occupiedSeats)
  const straddles = (options?.straddles ?? []).filter((seat) =>
    order.includes(seat),
  )
  const anchor = straddleAnchorSeat(seats, button, occupiedSeats, straddles)

  return applyExclude(rotateAfter(order, anchor), options)
}

/**
 * Postflop action order: starts left of the button. Heads-up that is the big
 * blind, leaving the button to act last.
 */
export function postflopOrder(
  seats: number,
  button: number,
  occupiedSeats: readonly number[],
  options?: OrderOptions,
): number[] {
  const order = seatOrderFromButton(seats, button, occupiedSeats)
  return applyExclude(rotateAfter(order, button), options)
}
