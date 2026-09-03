# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-09-03

### Added

- Button (Mississippi) straddles: the button may post a `straddle` on its own,
  which moves the preflop action to start with the small blind and leaves the
  button to act last. Chain straddles are unchanged, and the two cannot be
  mixed — a button straddle closes straddling for the hand.
- `availableStraddleSeats(state, hand)` for recorders that offer the button as
  a straddle spot, plus `straddleAnchorSeat` and `nextStraddleSeats` in the
  positions module.
- Contract fixture `tests/fixtures/button-straddle.json`.

### Notes

- `HandRecord` v1 is unchanged: a button straddle is an ordinary
  `post`/`straddle` action from the button seat. Records written with one are
  rejected by 1.0.x, so consumers that read them should depend on `^1.1`.

## [1.0.0] - 2026-08-31

First release. Format `HandRecord` v1 is frozen for the 1.x line.

### Added

- `HandRecord` v1 domain types: `HandRecord`, `HandAction`, `HandPlayer`,
  `Blinds`, `Street`, `TableState`, `StreetBetting`, `PostedBlind`, `Pot`,
  `HandResult`, `LegalActions`.
- Card core (`@smallblind/hand-history/cards`) and hand evaluator
  (`@smallblind/hand-history/evaluator`).
- Positions: labels for 2–10-max tables, preflop/postflop action order,
  straddle chains.
- Replay engine: incremental reducer (`initialState` / `applyAction`) and
  full replay (`replay` / `replayAll`) with side pots, uncalled-bet refunds,
  showdown evaluation, manual winners validated as a flow problem, and
  currency-based chip units (ISO 4217 minor units).
- Validation: `validateRecordStatic`, `validateRecord`, `validateAction`,
  `legalActions` — forced-bet order and amounts, short blinds and straddles,
  minimum raise and reopen rules, board/street consistency.
- Text formatter (`formatHandText`, English and Korean labels).
- URL fragment codec (`encodeHand` / `decodeHand`, `buildHandUrl` /
  `parseHandUrl`) with size limits and full record validation on decode.
- Contract fixtures under `tests/fixtures/` shared with the SmallBlind app
  and web replayer.
- ESM + CJS builds with type declarations, ESLint, Vitest, CI and
  npm trusted-publishing workflows.
