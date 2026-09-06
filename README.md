# @smallblind/hand-history

Poker hand history engine for no-limit hold'em: a versioned domain model
(`HandRecord` v1/v2) plus the card and hand-evaluation core it is built on.

Pure TypeScript — no React, React Native, Expo, DOM, or Node-only APIs — so the
same build runs in a browser, in Node, and in a React Native app. It is the
shared engine behind the SmallBlind mobile app and the SmallBlind web replayer.

## Installation

```sh
npm install @smallblind/hand-history
```

Requires Node 20 or newer when run on the server. Ships both ESM and CommonJS
builds with TypeScript declarations.

## API surface

```ts
import { replay, formatHandText } from '@smallblind/hand-history'
import type { HandRecord, TableState } from '@smallblind/hand-history'
import { parseCard } from '@smallblind/hand-history/cards'
import { evaluateBestHand } from '@smallblind/hand-history/evaluator'
```

Three entry points. The package root re-exports everything; `/cards` and
`/evaluator` are subpaths for consumers that only want the poker core.

| Entry point | Contents |
| --- | --- |
| `@smallblind/hand-history` | Everything in the table below. |
| `@smallblind/hand-history/cards` | The card module only. |
| `@smallblind/hand-history/evaluator` | The hand evaluator only. |

| Module | Exports |
| --- | --- |
| Format types | `HandRecord`, `HandAction`, `HandPlayer`, `Blinds`, `Street`, `TableState`, `StreetBetting`, `PostedBlind`, `Pot`, `HandResult`, `LegalActions` |
| `cards` | `Card`, `CardRank`, `CardSuit`, `CARD_RANKS`, `CARD_SUITS`, `CARD_RANK_VALUES`, `CARD_SUIT_SYMBOLS`, `parseCard`, `cardKey`, `cardLabel`, `cardToNativeId`, `cardFromNativeId`, `createDeck`, `deckWithout`, `uniqueCards`, `assertUniqueCards`, `seedFromText`, `createSeededRandom` |
| `evaluator` | `HandCategory`, `HandScore`, `evaluateFiveCardHand`, `evaluateBestHand`, `compareHandScores`, `rankValue` |
| Currency | `chipUnitForCurrency`, `isSupportedCurrency`, `CURRENCY_MINOR_UNITS` |
| Positions | `PositionLabel`, `OrderOptions`, `PreflopOrderOptions`, `positionLabels`, `blindSeats`, `seatOrderFromButton`, `preflopOrder`, `postflopOrder`, `straddleAnchorSeat`, `nextStraddleSeats` |
| Replay | `initialState`, `applyAction`, `replay`, `replayAll`, `stepCount`, `currentBet`, `totalPot`, `finalStacks`, `parseCards`, `seatedSeats`, `straddleSeats`, `HandReplayError`, `HAND_CATEGORY_NAMES` |
| Validation | `validateRecordStatic`, `validateRecord`, `validateAction`, `legalActions`, `availableStraddleSeats`, `ValidationError`, `ValidationErrorCode` |
| Text | `formatHandText`, `formatAmount`, `formatCards`, `TextLabels`, `FormatHandTextOptions`, `EN_LABELS`, `KO_LABELS`, `TEXT_LABELS` |
| URL codec | `encodeHand`, `decodeHand`, `buildHandUrl`, `parseHandUrl`, `minifyHand`, `expandHand`, `assertHandRecord`, `HandCodecError`, `HandCodecErrorCode`, `HAND_URL_MAX_LENGTH`, `HAND_PAYLOAD_MAX_LENGTH`, `HAND_INFLATED_MAX_BYTES`, `HAND_CODEC_KEY_MAP`, `HAND_CODEC_ACTION_TYPE_MAP` |

### Replaying a hand

`replay(hand)` returns the `TableState` after the whole record, `replay(hand, n)`
the state after `n` actions, and `replayAll(hand)` every state in between — that
is what a step-by-step replayer renders. `initialState` + `applyAction` are the
same reducer one action at a time, for a UI that is still recording the hand.

A record whose actions run out while a seat still has to act is *unfinished*:
the state comes back with `isComplete: false` and no `result`, nothing is swept
into the pots and no uncalled bet is returned. `validateRecord` reports that as
`street-not-closed`.

`state.stacks` holds the chips in front of each seat **before** the pot is
pushed; `finalStacks(state)` adds the award in.

`applyAction` derives the next state from the state alone — it never reads back
`hand.actions`, and never reads `hand.board` either — so a recorder that
validates and applies an action *before* appending it to the record gets exactly
the state `replay` produces for that step. Only the hand's setup (players,
blinds, currency, winners) is read from the record. `validateAction` works the
same way and answers exactly what `applyAction` will accept.

### Rules the engine holds you to

- **Forced bets are preflop only, and all of them are required.** `sb`, `bb`,
  `ante` and `straddle` posts have to come before the first voluntary action,
  from the seat that owes them (straddles in a chain left of the big blind); a
  post later in the hand is rejected rather than allowed to revive the preflop
  bring-in. By the time someone acts voluntarily, the small blind, the big blind
  and whatever ante the game charges must all be on the table — a record that
  has not got that far is simply still being written, and is reported as an
  unfinished street instead.
- **A short blind does not shrink the bet.** When the big blind is all-in for
  less than a full blind the table still plays for the full one: the bring-in,
  not the chips that made it in, sets the call and the minimum raise.
- **An all-in under a full bet or raise does not reopen the action.** It also
  never lowers the minimum raise — an opening all-in below the big blind leaves
  the next raise measured from the blind. Undersized all-ins that *add up* to a
  full raise over what a seat matched do reopen it for that seat.
- **The chip comes from the currency**, never from the amounts a record happens
  to contain: `''` is a chip game and plays in whole chips, everything else
  follows ISO 4217 minor units (`chipUnitForCurrency`). Only codes the package
  carries are accepted — precious metals and fund codes are not currencies a
  game is played in. Every amount in a record has to be a whole number of those
  chips, and an odd one left over in a split pot goes to the first winning seat
  left of the button.
- **The board is exactly what the streets dealt.** `HandRecord.board` is a
  convenience copy of the `street` actions' cards joined in order, and
  `validateRecordStatic` rejects it when it says anything else. The reducer
  never reads it at all — it deals what the actions deal — so an all-in runout
  has to be recorded as `street` actions like any other, and a showdown with
  fewer than five community cards asks for `winners` rather than judging itself
  on cards nobody saw dealt.
- **Cards have one spelling.** Rank uppercase, suit lowercase, no separators:
  `"AhKd"`. `"AH"` and `"ah"` are rejected outright, before anything looks for
  duplicates.
- **Blinds are posted for what they owe.** A `post` has to carry exactly the
  configured small blind, big blind or ante — or the poster's whole stack when
  that is less — and a straddle at least double what it sits behind, never more
  than the stack behind it — counting everything the straddler has on the
  street, which heads-up includes the small blind it already posted. A straddle
  all-in for less than that double raises what everyone has to call, but not the
  raise increment: a 15 straddle in a 5/10 game is called for 15 while the next
  raise is still measured from the blind, so the minimum is 25. One that cannot
  even reach the blind leaves the stakes where they were.
- **Forced bets are posted in one order:** the ante a seat owes, then the small
  blind, then the big blind, then the straddles. A straddle never jumps the
  blinds — otherwise a short stack could empty itself on one and be excused from
  a blind it never posted.
- **A straddle comes from the chain or from the button.** The ordinary straddle
  sits immediately left of the big blind, and each further one immediately left
  of the last. The button may also straddle on its own — a *Mississippi*
  straddle — and doing so closes straddling for the hand. Any other seat is
  rejected. See [Straddles](#straddles) for the action order each produces.
- **Antes come off the stack first.** A seat that owes an ante posts it before
  its blind, and a stack the ante swallows whole owes nothing further — a big
  blind all-in for its ante is not a missing big blind. With `anteType: 'bb'`
  only the big blind antes; with `'each'` every seat does.
- **Recorded winners must be payable.** `HandRecord.winners` is checked against
  the settled pots as a flow problem, so a payout that no real split of the main
  and side pots could produce is rejected — per-seat ceilings alone would let
  two seats claim the same pot.

### Straddles

Preflop action begins with the seat **left of the last straddler**, which is
what makes the two kinds of straddle differ:

| Straddle | Action starts | Acts last |
| --- | --- | --- |
| None | Left of the big blind (UTG) | Big blind |
| Chain (UTG, then left of it, …) | Left of the last straddle | Last straddler |
| Button (Mississippi) | Small blind | Button |

The Mississippi straddle is the one live rule worth spelling out: a straddle
from the button moves the whole preflop round, so the small blind is first to
act and the button — having the last raise — closes the action. That is the
standard treatment; action begins with the player to the straddler's left and
proceeds normally around the table, with no skipped or reordered seats.
([PokerNews](https://www.pokernews.com/pokerterms/mississippi-straddle.htm),
[CardPlayer](https://www.cardplayer.com/rules-of-poker/glossary/straddle-in-poker))

Two decisions this package makes, since the live rules vary:

- **Only the chain seat and the button may straddle.** Rooms that allow a
  Mississippi straddle from any non-blind seat exist; supporting that would
  leave the record ambiguous about where action starts when several seats
  straddle, so it is out of scope.
- **A button straddle and a chain cannot coexist.** The two rules point in
  opposite directions — a chain wants action left of the last chain straddle,
  a button straddle wants it on the small blind — and any tie-break would be
  arbitrary. Once the button straddles, straddling is closed; once a chain has
  started, the button can only join it as the next seat in the chain (three-
  handed and heads-up, the chain seat *is* the button, so the two coincide).

`availableStraddleSeats(state, hand)` gives a recorder exactly the seats it may
offer right now, and is empty as soon as anyone acts voluntarily.

### Validating

`validateRecordStatic(hand)` checks everything that does not need a replay —
shape, seating, money formats, cards, street structure — and is what a decoder
should run on untrusted input. `validateRecord(hand)` is that plus a full
replay. Both return an array of `ValidationError`; empty means sound.

`legalActions(state, hand)` drives a betting UI: what the seat to act may do,
including the minimum raise and whether the action is even open to it.

## Conventions

- Every money amount is a decimal **string**, parsed with `big.js`. Chip counts
  never pass through a JavaScript `number`.
- Seats are 0-based indexes, not position labels.
- Cards are two-character codes concatenated without separators: `"AhKd"`.

## Format versioning

`HandRecord.v` is `1 | 2` in package 2.x. Existing v1 records retain their
meaning and continue to decode. New `muck` actions require v2; recorders can
upgrade a v1 record when its first discard is appended. URL envelopes are
`v1.` or `v2.` and must match the record inside. Package 1.x rejects v2 at its
parser/validator boundary, so an older consumer cannot silently ignore a muck.
Consumers of v2 must upgrade to package 2.x before reading or editing it.

When upgrading from 1.x, handle the new `muck` action in exhaustive action
handlers and allow both values of `HandRecord.v`. Custom `TableState` fixtures
need `mucked: []`, and custom `TextLabels` need `actions.muck`. The built-in
state constructors and English/Korean labels already include these fields.
These public type changes make this a major package release.

### Showdown discards

`{ t: 'muck', seat }` records a discard after the river betting closes, before
that seat has shown. Original `players[].cards` remain intact for review;
`TableState.mucked` carries discards in action order. A discarded hand cannot
subsequently show. Undo by removing its action restores its previous eligibility.

Each discard removes its seat from contested pots. A pot with one remaining
claimant is already won without requiring cards, and later discarding those
cards cannot destroy that pot. This is evaluated per pot, including side pots.
For example, with main pot A/B/C and side pot A/B, A then B discarding awards
the main pot to C and the side pot to B. A cannot win either pot with its known
stronger cards. Manual payouts use the same eligibility and chip-flow checks.

The engine records observed outcomes; it does not enforce house-specific
requirements to table cards (such as tournament all-in rules). The last-live-hand
principle is described in [Poker TDA rule 17](https://www.pokertda.com/view-poker-tda-rules/).

## License

MIT © Supercrack Inc.
