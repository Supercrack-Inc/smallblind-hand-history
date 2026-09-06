/**
 * HandRecord v1/v2 — the wire and storage contract shared by the SmallBlind app,
 * the web replayer, and this engine.
 *
 * Conventions used throughout:
 * - Every money amount is a decimal **string** (parsed with big.js). Never a
 *   JavaScript number, so chip counts stay exact.
 * - Seats are 0-based `number` indexes into the table, not position labels.
 * - Cards are 2-character codes concatenated without separators: `"AhKd"`.
 */

/** Betting round of a no-limit hold'em hand. */
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'

/** Forced bets in play for the hand. */
export type Blinds = {
  /** Small blind amount. */
  sb: string
  /** Big blind amount. */
  bb: string
  /** Ante amount, omitted when the game has no ante. */
  ante?: string
  /** `'bb'` = single big-blind ante, `'each'` = every player antes. */
  anteType?: 'bb' | 'each'
}

/** A seated player at the moment the hand starts. */
export type HandPlayer = {
  /** 0-based seat index. */
  seat: number
  /** Display name; omitted for anonymous villains. */
  name?: string
  /** Stack in front of the player before any forced bet is posted. */
  stack: string
  /** Hole cards, e.g. `"AhAs"`; omitted when unknown. */
  cards?: string
  /** True for the player whose perspective the hand was recorded from. */
  hero?: boolean
}

/**
 * One entry in the hand's action list, discriminated by `t`.
 * The list is ordered and includes `street` markers for board runouts.
 */
export type HandAction =
  /** A forced or voluntary blind/ante/straddle posting. */
  | {
      t: 'post'
      seat: number
      kind: 'sb' | 'bb' | 'ante' | 'straddle'
      amount: string
    }
  /** Fold or check — no chips move. */
  | { t: 'fold' | 'check'; seat: number }
  /** Call; `amount` is the player's total wager for the current street. */
  | { t: 'call'; seat: number; amount: string }
  /** Bet or raise; `to` is the cumulative street wager being raised to. */
  | { t: 'bet' | 'raise'; seat: number; to: string }
  /** All-in; `to` is the cumulative street wager after committing the stack. */
  | { t: 'allin'; seat: number; to: string }
  /** Street marker carrying the newly dealt board cards, e.g. `"8d4d3h"`. */
  | { t: 'street'; street: 'flop' | 'turn' | 'river'; cards: string }
  /** A showdown reveal, e.g. `"5c5d"`. */
  | { t: 'show'; seat: number; cards: string }
  /** Discard at showdown (v2); preserves the originally recorded hole cards. */
  | { t: 'muck'; seat: number }

/** A recorded hand. v1 remains readable; muck actions require v2. */
export type HandRecord = {
  /** Format version. Bumped only by a breaking change to this shape. */
  v: 1 | 2
  /** Stable identifier (63-bit integer as a decimal string). */
  id: string
  /** When the hand was played, epoch milliseconds (UTC). */
  playedAt: number
  /** Game variant. Only no-limit hold'em is supported in v1. */
  game: 'NLHE'
  /** ISO 4217 code, or `''` for a chip-denominated hand. */
  currency: string
  /** Forced bets in play. */
  blinds: Blinds
  /** Table size, 2..10. */
  seats: number
  /** 0-based seat holding the button. */
  button: number
  /** Seated players; empty seats are simply absent. */
  players: HandPlayer[]
  /** Ordered action list including street markers. */
  actions: HandAction[]
  /**
   * Full board as dealt, e.g. `"8d4d3h5hTd"` (at most 10 characters).
   *
   * When present it must be **exactly** the `street` actions' cards joined in
   * order — it is a convenience copy, never a source of cards the actions do
   * not carry. A runout dealt to all-in players is recorded as `street`
   * actions like any other, and showdowns are judged from those alone.
   */
  board?: string
  /** Manually chosen winners; only needed when cards are unknown. */
  winners?: Array<{ seat: number; amount: string }>
  /** Free-form note attached by the recorder. */
  note?: string
  /** Bankroll session this hand belongs to, if any. */
  sessionId?: string
  /** Venue name for cash games. */
  venue?: string
  /** Tournament name, when the hand was played in one. */
  tournamentName?: string
}

/** A main or side pot and the seats entitled to contest it. */
export type Pot = {
  /** Chips in this pot. */
  amount: string
  /** 0-based seats still eligible to win it. */
  eligible: number[]
}

/** Outcome of a hand once it is complete. */
export type HandResult = {
  /** Seats that won chips, with the amount awarded to each. */
  winners: Array<{
    seat: number
    amount: string
    /** Human-readable hand name, when the hand could be evaluated. */
    handName?: string
  }>
  /** Net chip change per seat, keyed by seat index. */
  net: Record<number, string>
}

/** A forced bet that has been posted, as recorded on the table state. */
export type PostedBlind = {
  /** Seat that posted it. */
  seat: number
  /** Which forced bet this was. */
  kind: 'sb' | 'bb' | 'ante' | 'straddle'
  /** Chips actually posted — less than the blind when the stack was short. */
  amount: string
}

/**
 * Betting bookkeeping for the street currently being played.
 *
 * Kept on `TableState` because the reducer is pure: `applyAction` derives the
 * next state from this alone, and `legalActions` needs the same numbers.
 */
export type StreetBetting = {
  /**
   * Size of the last full raise on this street, the basis for the minimum
   * raise. Reset to the big blind at the start of every street.
   */
  lastRaiseSize: string
  /**
   * Preflop bring-in: the full big blind, or the largest straddle, even when
   * its poster is all-in for less. `'0'` on every later street. Callers must
   * match this much, not merely the chips a short blind managed to put up.
   */
  bringIn: string
  /**
   * Forced bets posted this hand, in posting order: what the blinds, antes and
   * straddles actually put in. Preflop action starts left of the last straddle,
   * and the required posts are checked against this list. Empty on every later
   * street.
   */
  posts: PostedBlind[]
  /**
   * Seats that have acted since the last **full** raise. Such a seat may call
   * or fold but not raise — unless undersized all-ins have since pushed the
   * bet a full raise past what it last matched, which reopens the action.
   */
  actedSeats: number[]
  /** Seat of the last bet/raise on this street, or `null`. */
  aggressorSeat: number | null
}

/** The table as it stands at one step of a replay. Produced by `replay()`. */
export type TableState = {
  /** Index of the replayed action, 0 = before any action. */
  step: number
  /** Street currently being played. */
  street: Street
  /** Board cards visible at this step, e.g. `"8d4d3h"`. */
  board: string
  /** Chips remaining in front of each seat. */
  stacks: Record<number, string>
  /** Chips wagered by each seat on the current street only. */
  streetBets: Record<number, string>
  /** Chips wagered by each seat across the whole hand. */
  committed: Record<number, string>
  /** Main pot first, then side pots. */
  pots: Pot[]
  /** Seats that have folded. */
  folded: number[]
  /** Showdown discards in action order. Uncontested pots already won are retained. */
  mucked: number[]
  /** Seats that are all-in. */
  allIn: number[]
  /** Hole cards turned face up by a `show` action, keyed by seat. */
  revealed: Record<number, string>
  /** Betting bookkeeping for the current street. */
  betting: StreetBetting
  /** Seat to act next, or `null` when no one can act. */
  actingSeat: number | null
  /** The action that produced this state; absent at step 0. */
  lastAction?: HandAction
  /** True once the hand has been fully replayed. */
  isComplete: boolean
  /**
   * Present only when the hand is complete. Note that `stacks` is **not**
   * increased by the award — use `finalStacks()` for post-payout stacks.
   */
  result?: HandResult
  /**
   * True when the hand reached showdown but cannot be judged: a contender's
   * cards or a board card is missing and `HandRecord.winners` was not
   * supplied. `result` is absent in that case.
   */
  needsWinners?: boolean
}

/** What the seat to act is allowed to do, given the current state. */
export type LegalActions = {
  /** Folding is always legal while facing a bet; false when nothing is owed. */
  canFold: boolean
  /** True when nothing is owed and the player may check. */
  canCheck: boolean
  /** Chips needed to call, omitted when there is nothing to call. */
  callAmount?: string
  /** Smallest legal raise, as a cumulative street total. */
  minRaiseTo?: string
  /** Largest legal raise (the player's full stack), as a street total. */
  maxRaiseTo?: string
  /** True when the player has chips to move all-in with. */
  canAllIn: boolean
}
