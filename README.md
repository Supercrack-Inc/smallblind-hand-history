# @smallblind/hand-history

Poker hand history engine for no-limit hold'em: a versioned domain model
(`HandRecord` v1) plus the card and hand-evaluation core it is built on.

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
| Positions | `PositionLabel`, `OrderOptions`, `PreflopOrderOptions`, `positionLabels`, `blindSeats`, `seatOrderFromButton`, `preflopOrder`, `postflopOrder` |
| Replay | `initialState`, `applyAction`, `replay`, `replayAll`, `stepCount`, `currentBet`, `totalPot`, `finalStacks`, `parseCards`, `seatedSeats`, `straddleSeats`, `HandReplayError`, `HAND_CATEGORY_NAMES` |
| Validation | `validateRecordStatic`, `validateRecord`, `validateAction`, `legalActions`, `ValidationError`, `ValidationErrorCode` |
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
  blind, then the big blind, then the straddle chain. A straddle never jumps the
  blinds — otherwise a short stack could empty itself on one and be excused from
  a blind it never posted.
- **Antes come off the stack first.** A seat that owes an ante posts it before
  its blind, and a stack the ante swallows whole owes nothing further — a big
  blind all-in for its ante is not a missing big blind. With `anteType: 'bb'`
  only the big blind antes; with `'each'` every seat does.
- **Recorded winners must be payable.** `HandRecord.winners` is checked against
  the settled pots as a flow problem, so a payout that no real split of the main
  and side pots could produce is rejected — per-seat ceilings alone would let
  two seats claim the same pot.

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

`HandRecord` carries an explicit `v` field. **Format v1 is the 1.x major line**:
any breaking change to the recorded shape ships as a new major version of this
package and a new format version. Consumers should depend on `^1`.

## License

MIT © Supercrack Inc.
