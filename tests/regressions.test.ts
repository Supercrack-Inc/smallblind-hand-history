/**
 * One test per finding from the adversarial review. Each case is the
 * counter-example that used to produce a wrong answer.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CURRENCY_MINOR_UNITS, chipUnitForCurrency } from '../src/currency'
import { preflopOrder } from '../src/positions'
import {
  applyAction,
  currentBet,
  HandReplayError,
  initialState,
  replay,
  replayAll,
  totalPot,
} from '../src/replay'
import type { HandAction, HandRecord } from '../src/types'
import {
  legalActions,
  validateAction,
  validateRecord,
  validateRecordStatic,
} from '../src/validate'

const FIXTURE_NAMES = [
  'pokerbase-aa-vs-55',
  'preflop-3way-sidepot',
  'heads-up-button-first',
  'fold-out-uncalled-bet',
  'split-pot-board-plays',
  'straddle-each-ante',
  'unknown-cards-manual-winners',
  'decimal-stakes-split',
  'short-bb-allin',
]

function loadFixture(name: string): HandRecord {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url))
  return (JSON.parse(readFileSync(path, 'utf8')) as { hand: HandRecord }).hand
}

/** Three-handed table, button on seat 0: 0 = BTN, 1 = SB, 2 = BB. */
function threeHanded(overrides: Partial<HandRecord> = {}): HandRecord {
  return {
    v: 1,
    id: '100',
    playedAt: 1787961600000,
    game: 'NLHE',
    currency: 'USD',
    blinds: { sb: '5', bb: '10' },
    seats: 3,
    button: 0,
    players: [
      { seat: 0, stack: '1000', cards: 'AhKh', hero: true },
      { seat: 1, stack: '1000', cards: 'QsQd' },
      { seat: 2, stack: '1000', cards: '7c7d' },
    ],
    actions: [],
    ...overrides,
  }
}

function walk(record: HandRecord, actions: HandAction[]) {
  const full: HandRecord = { ...record, actions }

  return actions.reduce(
    (state, action) => applyAction(state, action, full),
    initialState(full),
  )
}

const posts: HandAction[] = [
  { t: 'post', seat: 1, kind: 'sb', amount: '5' },
  { t: 'post', seat: 2, kind: 'bb', amount: '10' },
]

describe('1 · manual winners are checked against the pots', () => {
  const base = loadFixture('unknown-cards-manual-winners')

  it('refuses to pay a seat that folded', () => {
    const hand: HandRecord = { ...base, winners: [{ seat: 1, amount: '235' }] }

    expect(validateRecord(hand).map((problem) => problem.code)).toContain(
      'bad-winners',
    )
    expect(() => replay(hand)).toThrow(/folded and cannot be paid/)
  })

  it('refuses a payout that does not add up to the pot', () => {
    const hand: HandRecord = { ...base, winners: [{ seat: 0, amount: '100' }] }

    expect(validateRecord(hand).map((problem) => problem.code)).toContain(
      'bad-winners',
    )

    try {
      replay(hand)
      expect.unreachable()
    } catch (cause) {
      expect(cause).toBeInstanceOf(HandReplayError)
      expect((cause as HandReplayError).code).toBe('bad-winners')
    }
  })

  it('caps a short all-in at the pots it is eligible for', () => {
    // Same three-way all-in as the side-pot fixture, but with no cards shown:
    // the 100 stack can only ever win the 300 main pot.
    const sidePot: HandRecord = {
      ...loadFixture('preflop-3way-sidepot'),
      players: [
        { seat: 0, name: 'Big', stack: '300', hero: true },
        { seat: 1, name: 'Short', stack: '100' },
        { seat: 2, name: 'Mid', stack: '200' },
      ],
      winners: [{ seat: 1, amount: '500' }],
    }

    expect(validateRecord(sidePot).map((problem) => problem.code)).toContain(
      'bad-winners',
    )
    expect(() => replay(sidePot)).toThrow(/can win at most 300/)

    const legalSplit: HandRecord = {
      ...sidePot,
      winners: [
        { seat: 1, amount: '300' },
        { seat: 2, amount: '200' },
      ],
    }

    expect(validateRecord(legalSplit)).toEqual([])
    expect(replay(legalSplit).result?.winners).toEqual([
      { seat: 1, amount: '300' },
      { seat: 2, amount: '200' },
    ])
  })
})

describe('2 · an all-in raise still needs a reopened action', () => {
  const record = threeHanded({
    players: [
      { seat: 0, stack: '1000', cards: 'AhKh', hero: true },
      { seat: 1, stack: '1000', cards: 'QsQd' },
      { seat: 2, stack: '140', cards: '7c7d' },
    ],
  })
  const closedAction: HandAction[] = [
    ...posts,
    { t: 'call', seat: 0, amount: '10' },
    { t: 'call', seat: 1, amount: '10' },
    { t: 'check', seat: 2 },
    { t: 'street', street: 'flop', cards: '2c5d9s' },
    { t: 'bet', seat: 1, to: '100' },
    { t: 'allin', seat: 2, to: '130' },
    { t: 'call', seat: 0, amount: '130' },
  ]

  it('rejects an all-in over the top when the betting stayed closed', () => {
    const state = walk(record, closedAction)

    expect(state.actingSeat).toBe(1)
    expect(legalActions(state, record)?.minRaiseTo).toBeUndefined()
    expect(
      validateAction(state, { t: 'allin', seat: 1, to: '990' }, record)?.code,
    ).toBe('illegal-action')
  })

  it('still allows an all-in that only calls', () => {
    const short = threeHanded({
      players: [
        { seat: 0, stack: '1000', cards: 'AhKh', hero: true },
        { seat: 1, stack: '150', cards: 'QsQd' },
        { seat: 2, stack: '1000', cards: '7c7d' },
      ],
    })
    const state = walk(short, [
      ...posts,
      { t: 'call', seat: 0, amount: '10' },
      { t: 'call', seat: 1, amount: '10' },
      { t: 'check', seat: 2 },
      { t: 'street', street: 'flop', cards: '2c5d9s' },
      { t: 'bet', seat: 1, to: '50' },
      { t: 'raise', seat: 2, to: '300' },
      { t: 'fold', seat: 0 },
    ])

    expect(state.actingSeat).toBe(1)
    // 140 behind against a 300 bet: the all-in cannot get past it, so it is a
    // call and no reopening is required.
    expect(
      validateAction(state, { t: 'allin', seat: 1, to: '140' }, short),
    ).toBeNull()
  })
})

describe('3 · undersized all-ins that add up to a full raise reopen it', () => {
  const record = threeHanded({
    players: [
      { seat: 0, stack: '210', cards: 'AhKh' },
      { seat: 1, stack: '1000', cards: 'QsQd', hero: true },
      { seat: 2, stack: '140', cards: '7c7d' },
    ],
  })

  it('lets the original bettor raise once the bet climbs 100 over its bet', () => {
    const state = walk(record, [
      ...posts,
      { t: 'call', seat: 0, amount: '10' },
      { t: 'call', seat: 1, amount: '10' },
      { t: 'check', seat: 2 },
      { t: 'street', street: 'flop', cards: '2c5d9s' },
      { t: 'bet', seat: 1, to: '100' },
      { t: 'allin', seat: 2, to: '130' },
      { t: 'allin', seat: 0, to: '200' },
    ])
    const legal = legalActions(state, record)

    expect(state.actingSeat).toBe(1)
    expect(legal?.callAmount).toBe('100')
    // 100 → 130 → 200 is 100 over the 100 it matched: a full raise.
    expect(legal?.minRaiseTo).toBe('300')
    expect(
      validateAction(state, { t: 'raise', seat: 1, to: '300' }, record),
    ).toBeNull()
  })
})

describe('4 · a record that stops mid-street stays in progress', () => {
  const unfinished = threeHanded({
    actions: [...posts, { t: 'raise', seat: 0, to: '30' }],
  })

  it('does not settle, refund or pay anything', () => {
    const state = replay(unfinished)

    expect(state.isComplete).toBe(false)
    expect(state.result).toBeUndefined()
    expect(state.actingSeat).toBe(1)
    // The raise is still on the table, not swept and not returned.
    expect(state.streetBets[0]).toBe('30')
    expect(state.stacks[0]).toBe('970')
    expect(totalPot(state)).toBe('45')
    const states = replayAll(unfinished)
    expect(states[states.length - 1]).toEqual(state)
  })

  it('is reported as an unfinished street', () => {
    expect(validateRecord(unfinished)).toEqual([
      {
        code: 'street-not-closed',
        message: 'The record ends while seat 1 still has to act',
        step: 3,
        seat: 1,
      },
    ])
  })

  it('leaves a hand with no actions at all untouched', () => {
    const empty = threeHanded()
    const state = replay(empty)

    expect(state.isComplete).toBe(false)
    expect(state.pots).toEqual([])
    expect(state.result).toBeUndefined()
  })
})

describe('5 · the chip size comes from the action amounts too', () => {
  it('splits an 8.4 pot into 4.2 and 4.2', () => {
    const hand = loadFixture('decimal-stakes-split')

    expect(replay(hand).result?.winners).toEqual([
      { seat: 0, amount: '4.2', handName: 'Straight' },
      { seat: 1, amount: '4.2', handName: 'Straight' },
    ])
  })
})

describe('8 · a short big blind does not lower the bring-in', () => {
  const hand = loadFixture('short-bb-allin')

  it('keeps the call at the full big blind', () => {
    const state = replay(hand, 2)
    const legal = legalActions(state, hand)

    expect(state.actingSeat).toBe(0)
    expect(state.streetBets[2]).toBe('0.5')
    expect(state.betting.bringIn).toBe('2')
    expect(legal?.callAmount).toBe('2')
    expect(legal?.minRaiseTo).toBe('4')
    expect(
      validateAction(state, { t: 'call', seat: 0, amount: '2' }, hand),
    ).toBeNull()
    expect(
      validateAction(state, { t: 'raise', seat: 0, to: '3' }, hand)?.code,
    ).toBe('illegal-amount')
  })

  it('drops the bring-in after the preflop', () => {
    expect(replay(hand, 5).betting.bringIn).toBe('0')
  })
})

describe('9 · the straddle chain anchors on the last straddle', () => {
  const six = [0, 1, 2, 3, 4, 5]

  it('follows a chain that wraps past the button', () => {
    // Button 3, so BB is seat 5 and the straddles run 0 then 1.
    expect(preflopOrder(6, 3, six, { straddles: [0, 1] })).toEqual([
      2, 3, 4, 5, 0, 1,
    ])
  })

  it('rejects straddles recorded out of order or with a gap', () => {
    expect(() => preflopOrder(6, 3, six, { straddles: [1, 0] })).toThrow(
      /must be posted from seat 0/,
    )
    expect(() => preflopOrder(6, 3, six, { straddles: [1] })).toThrow(
      /must be posted from seat 0/,
    )
  })

  it('still starts left of the big blind with no straddle', () => {
    expect(preflopOrder(6, 3, six)).toEqual([0, 1, 2, 3, 4, 5])
  })
})

describe('R2-1 · manual payouts must be feasible across the pots', () => {
  // Four all-ins for 100 / 200 / 300 / 300 build three pots:
  // 400 for everyone, 300 for seats 1-3, 200 for seats 2-3.
  const ladder: HandRecord = {
    v: 1,
    id: '200',
    playedAt: 1787961600000,
    game: 'NLHE',
    currency: 'USD',
    blinds: { sb: '5', bb: '10' },
    seats: 4,
    button: 0,
    players: [
      { seat: 0, stack: '100', hero: true },
      { seat: 1, stack: '200' },
      { seat: 2, stack: '300' },
      { seat: 3, stack: '300' },
    ],
    actions: [
      { t: 'post', seat: 1, kind: 'sb', amount: '5' },
      { t: 'post', seat: 2, kind: 'bb', amount: '10' },
      { t: 'allin', seat: 3, to: '300' },
      { t: 'allin', seat: 0, to: '100' },
      { t: 'allin', seat: 1, to: '200' },
      { t: 'allin', seat: 2, to: '300' },
    ],
  }

  it('builds the three pots the payout has to fit', () => {
    expect(replay(ladder).pots).toEqual([
      { amount: '400', eligible: [0, 1, 2, 3] },
      { amount: '300', eligible: [1, 2, 3] },
      { amount: '200', eligible: [2, 3] },
    ])
  })

  it('rejects a payout where two seats need the same pot', () => {
    // Both seats stay under their own ceiling (400 ≤ 400, 500 ≤ 700) and the
    // total is exactly 900, yet seat 1 can only reach 300 once seat 0 has
    // taken the main pot.
    const hand: HandRecord = {
      ...ladder,
      winners: [
        { seat: 0, amount: '400' },
        { seat: 1, amount: '500' },
      ],
    }

    expect(validateRecord(hand).map((problem) => problem.code)).toContain(
      'bad-winners',
    )
    expect(() => replay(hand)).toThrow(/cannot be split across these pots/)
  })

  it('accepts a payout that a real split could produce', () => {
    const hand: HandRecord = {
      ...ladder,
      winners: [
        { seat: 0, amount: '400' },
        { seat: 1, amount: '300' },
        { seat: 2, amount: '200' },
      ],
    }

    expect(validateRecord(hand)).toEqual([])
    expect(replay(hand).result?.winners).toEqual([
      { seat: 0, amount: '400' },
      { seat: 1, amount: '300' },
      { seat: 2, amount: '200' },
    ])
  })
})

describe('R2-2 · an opening all-in below the big blind is not a full bet', () => {
  const record = threeHanded({
    players: [
      { seat: 0, stack: '1000', cards: 'AhKh', hero: true },
      { seat: 1, stack: '1000', cards: 'QsQd' },
      { seat: 2, stack: '15', cards: '7c7d' },
    ],
  })
  const openShove: HandAction[] = [
    ...posts,
    { t: 'call', seat: 0, amount: '10' },
    { t: 'call', seat: 1, amount: '10' },
    { t: 'check', seat: 2 },
    { t: 'street', street: 'flop', cards: '2c5d9s' },
    { t: 'check', seat: 1 },
    { t: 'allin', seat: 2, to: '5' },
  ]

  it('keeps the minimum raise at the big blind', () => {
    const state = walk(record, openShove)

    expect(state.betting.lastRaiseSize).toBe('10')
    expect(state.actingSeat).toBe(0)
    // 5 on the table, so a real raise still has to reach 15, not 10.
    expect(legalActions(state, record)?.minRaiseTo).toBe('15')
    expect(
      validateAction(state, { t: 'raise', seat: 0, to: '10' }, record)?.code,
    ).toBe('illegal-amount')
  })

  it('does not reopen the action for a seat that already checked', () => {
    const state = walk(record, [
      ...openShove,
      { t: 'call', seat: 0, amount: '5' },
    ])
    const legal = legalActions(state, record)

    expect(state.actingSeat).toBe(1)
    expect(legal?.callAmount).toBe('5')
    expect(legal?.minRaiseTo).toBeUndefined()
    expect(
      validateAction(state, { t: 'raise', seat: 1, to: '100' }, record)?.code,
    ).toBe('illegal-action')
  })
})

describe('R2-4 · forced bets belong to the preflop', () => {
  const flopPost = threeHanded({
    actions: [
      ...posts,
      { t: 'call', seat: 0, amount: '10' },
      { t: 'call', seat: 1, amount: '10' },
      { t: 'check', seat: 2 },
      { t: 'street', street: 'flop', cards: '2c5d9s' },
      { t: 'post', seat: 2, kind: 'bb', amount: '10' },
    ],
  })

  it('rejects a blind posted on the flop', () => {
    expect(validateRecord(flopPost)[0]).toMatchObject({
      code: 'illegal-action',
      seat: 2,
    })
    expect(() => replay(flopPost)).toThrow(/only be posted preflop/)
  })

  it('rejects a blind posted after the action has started', () => {
    const lateStraddle = threeHanded({
      actions: [
        ...posts,
        { t: 'call', seat: 0, amount: '10' },
        { t: 'post', seat: 0, kind: 'straddle', amount: '20' },
      ],
    })

    expect(validateRecord(lateStraddle)[0]?.code).toBe('illegal-action')
  })

  it('rejects a blind posted by the wrong seat', () => {
    const wrongSeat = threeHanded({
      actions: [{ t: 'post', seat: 2, kind: 'sb', amount: '5' }],
    })

    expect(validateRecord(wrongSeat)[0]).toMatchObject({
      code: 'illegal-action',
      seat: 2,
    })
  })
})

// R2-5 first inferred the chip from the amounts a hand happened to contain.
// R3-5 replaced that with the currency, which is what these now check.
describe('R2-5 · a decimal game still splits into real chips', () => {
  // 0.20 / 0.40 dollars: the chip is a cent, so a 1.00 pot halves exactly.
  const cents: HandRecord = {
    v: 1,
    id: '201',
    playedAt: 1787961600000,
    game: 'NLHE',
    currency: 'USD',
    blinds: { sb: '0.2', bb: '0.4' },
    seats: 3,
    button: 0,
    players: [
      { seat: 0, stack: '20', cards: '2c3d', hero: true },
      { seat: 1, stack: '20' },
      { seat: 2, stack: '20', cards: '2h3s' },
    ],
    board: 'AsKsQdJhTh',
    actions: [
      { t: 'post', seat: 1, kind: 'sb', amount: '0.2' },
      { t: 'post', seat: 2, kind: 'bb', amount: '0.4' },
      { t: 'call', seat: 0, amount: '0.4' },
      { t: 'fold', seat: 1 },
      { t: 'check', seat: 2 },
      { t: 'street', street: 'flop', cards: 'AsKsQd' },
      { t: 'check', seat: 2 },
      { t: 'check', seat: 0 },
      { t: 'street', street: 'turn', cards: 'Jh' },
      { t: 'check', seat: 2 },
      { t: 'check', seat: 0 },
      { t: 'street', street: 'river', cards: 'Th' },
      { t: 'check', seat: 2 },
      { t: 'check', seat: 0 },
    ],
  }

  it('splits a 1.00 dollar pot into 0.50 and 0.50', () => {
    const final = replay(cents)

    expect(validateRecord(cents)).toEqual([])
    expect(final.pots).toEqual([{ amount: '1', eligible: [0, 2] }])
    expect(final.result?.winners).toEqual([
      { seat: 0, amount: '0.5', handName: 'Straight' },
      { seat: 2, amount: '0.5', handName: 'Straight' },
    ])
  })

  it('refuses the same amounts in a chip game, where 0.2 is not a chip', () => {
    const chips: HandRecord = { ...cents, currency: '' }

    expect(validateRecord(chips).map((problem) => problem.code)).toContain(
      'illegal-amount',
    )
  })

  it('still splits the 8.4 decimal-stakes pot evenly', () => {
    expect(replay(loadFixture('decimal-stakes-split')).result?.winners).toEqual([
      { seat: 0, amount: '4.2', handName: 'Straight' },
      { seat: 1, amount: '4.2', handName: 'Straight' },
    ])
  })
})

describe('R3-1 · the reducer never reads back the record', () => {
  // A recording UI validates and applies an action *before* appending it, so
  // `hand.actions` is always one behind. Nothing in the reducer may consult it.
  const straddled: HandRecord = {
    v: 1,
    id: '300',
    playedAt: 1787961600000,
    game: 'NLHE',
    currency: 'USD',
    blinds: { sb: '5', bb: '10' },
    seats: 6,
    button: 0,
    players: [
      { seat: 0, stack: '1000', hero: true },
      { seat: 1, stack: '1000' },
      { seat: 2, stack: '1000' },
      { seat: 3, stack: '1000' },
      { seat: 4, stack: '1000' },
      { seat: 5, stack: '1000' },
    ],
    actions: [
      { t: 'post', seat: 1, kind: 'sb', amount: '5' },
      { t: 'post', seat: 2, kind: 'bb', amount: '10' },
      { t: 'post', seat: 3, kind: 'straddle', amount: '20' },
    ],
  }

  it('puts the action left of the straddle while the record is still empty', () => {
    const beingRecorded: HandRecord = { ...straddled, actions: [] }
    const state = straddled.actions.reduce(
      (current, action) => applyAction(current, action, beingRecorded),
      initialState(beingRecorded),
    )

    expect(state.betting.posts.map((post) => post.kind)).toEqual([
      'sb',
      'bb',
      'straddle',
    ])
    expect(state.actingSeat).toBe(4)
    expect(state.actingSeat).toBe(replay(straddled, 3).actingSeat)
  })

  it('agrees with replay() at every step of every fixture', () => {
    FIXTURE_NAMES.forEach((name) => {
      const hand = loadFixture(name)
      // The reducer only ever sees a record with no actions in it.
      const bare: HandRecord = { ...hand, actions: [] }
      let state = initialState(bare)

      expect(state, `${name} @ 0`).toEqual(replay(hand, 0))

      // The last step is where `replay` settles the hand, which the bare
      // reducer cannot know to do, so it is compared up to there.
      hand.actions.slice(0, -1).forEach((action, index) => {
        state = applyAction(state, action, bare)
        expect(state, `${name} @ ${index + 1}`).toEqual(replay(hand, index + 1))
      })
    })
  })
})

describe('R3-3 · forced bets are posted for the right amount', () => {
  const record = threeHanded()
  const start = initialState(record)

  it('rejects a blind posted for less than it owes', () => {
    expect(
      validateAction(start, { t: 'post', seat: 1, kind: 'sb', amount: '1' }, record),
    ).toMatchObject({ code: 'illegal-amount', seat: 1 })
  })

  it('rejects a blind posted for more than it owes', () => {
    const afterSb = applyAction(
      start,
      { t: 'post', seat: 1, kind: 'sb', amount: '5' },
      record,
    )

    expect(
      validateAction(afterSb, { t: 'post', seat: 2, kind: 'bb', amount: '20' }, record),
    ).toMatchObject({ code: 'illegal-amount', seat: 2 })
  })

  it('accepts a short stack posting everything it has', () => {
    const short = threeHanded({
      players: [
        { seat: 0, stack: '1000', cards: 'AhKh', hero: true },
        { seat: 1, stack: '1000', cards: 'QsQd' },
        { seat: 2, stack: '3', cards: '7c7d' },
      ],
    })
    const afterSb = applyAction(
      initialState(short),
      { t: 'post', seat: 1, kind: 'sb', amount: '5' },
      short,
    )

    expect(
      validateAction(afterSb, { t: 'post', seat: 2, kind: 'bb', amount: '3' }, short),
    ).toBeNull()
    expect(
      validateAction(afterSb, { t: 'post', seat: 2, kind: 'bb', amount: '10' }, short),
    ).toMatchObject({ code: 'illegal-amount' })
  })

  it('rejects an ante in a game that has none', () => {
    expect(
      validateAction(start, { t: 'post', seat: 1, kind: 'ante', amount: '1' }, record),
    ).toMatchObject({ code: 'illegal-action' })
  })

  it('rejects a big-blind ante posted by anyone but the big blind', () => {
    const anted = threeHanded({
      blinds: { sb: '5', bb: '10', ante: '10', anteType: 'bb' },
    })

    expect(
      validateAction(
        initialState(anted),
        { t: 'post', seat: 1, kind: 'ante', amount: '10' },
        anted,
      ),
    ).toMatchObject({ code: 'illegal-action', seat: 1 })
    expect(
      validateAction(
        initialState(anted),
        { t: 'post', seat: 2, kind: 'ante', amount: '10' },
        anted,
      ),
    ).toBeNull()
  })

  it('reports the seats that never anted when everyone must', () => {
    const missing = threeHanded({
      blinds: { sb: '5', bb: '10', ante: '1', anteType: 'each' },
      actions: [
        { t: 'post', seat: 0, kind: 'ante', amount: '1' },
        ...posts,
        { t: 'raise', seat: 0, to: '30' },
        { t: 'fold', seat: 1 },
        { t: 'fold', seat: 2 },
      ],
    })

    expect(validateRecord(missing).map((problem) => problem.code)).toContain(
      'bad-blinds',
    )
  })

  it('rejects a straddle smaller than double the big blind', () => {
    const withStraddle = threeHanded({ seats: 6 })
    const state = applyAction(
      applyAction(
        initialState(withStraddle),
        { t: 'post', seat: 1, kind: 'sb', amount: '5' },
        withStraddle,
      ),
      { t: 'post', seat: 2, kind: 'bb', amount: '10' },
      withStraddle,
    )

    expect(
      validateAction(
        state,
        { t: 'post', seat: 0, kind: 'straddle', amount: '15' },
        withStraddle,
      ),
    ).toMatchObject({ code: 'illegal-amount' })
    expect(
      validateAction(
        state,
        { t: 'post', seat: 0, kind: 'straddle', amount: '20' },
        withStraddle,
      ),
    ).toBeNull()
  })
})

describe('R3-4 · payouts stay exact past 2^53', () => {
  it('settles a pot far beyond what a double can hold', () => {
    const huge: HandRecord = {
      v: 1,
      id: '301',
      playedAt: 1787961600000,
      game: 'NLHE',
      currency: '',
      blinds: { sb: '1', bb: '2' },
      seats: 2,
      button: 0,
      players: [
        { seat: 0, stack: '10000000000000000000', hero: true },
        { seat: 1, stack: '10000000000000000000' },
      ],
      winners: [{ seat: 0, amount: '20000000000000000000' }],
      actions: [
        { t: 'post', seat: 0, kind: 'sb', amount: '1' },
        { t: 'post', seat: 1, kind: 'bb', amount: '2' },
        { t: 'allin', seat: 0, to: '10000000000000000000' },
        { t: 'allin', seat: 1, to: '10000000000000000000' },
      ],
    }

    expect(validateRecord(huge)).toEqual([])
    expect(replay(huge).result?.winners).toEqual([
      { seat: 0, amount: '20000000000000000000' },
    ])

    const overpaid: HandRecord = {
      ...huge,
      winners: [{ seat: 0, amount: '20000000000000000001' }],
    }

    expect(validateRecord(overpaid).map((problem) => problem.code)).toContain(
      'bad-winners',
    )
  })

  it('handles a three-decimal currency in the flow', () => {
    const dinar: HandRecord = {
      v: 1,
      id: '302',
      playedAt: 1787961600000,
      game: 'NLHE',
      currency: 'KWD',
      blinds: { sb: '0.001', bb: '0.002' },
      seats: 2,
      button: 0,
      players: [
        { seat: 0, stack: '0.05', hero: true },
        { seat: 1, stack: '0.05' },
      ],
      winners: [{ seat: 1, amount: '0.1' }],
      actions: [
        { t: 'post', seat: 0, kind: 'sb', amount: '0.001' },
        { t: 'post', seat: 1, kind: 'bb', amount: '0.002' },
        { t: 'allin', seat: 0, to: '0.05' },
        { t: 'allin', seat: 1, to: '0.05' },
      ],
    }

    expect(validateRecord(dinar)).toEqual([])
    expect(replay(dinar).result?.winners).toEqual([{ seat: 1, amount: '0.1' }])
  })
})

describe('R3-5 · the chip comes from the currency', () => {
  it('maps currencies to their smallest chip', () => {
    expect(chipUnitForCurrency('')).toBe('1')
    expect(chipUnitForCurrency('USD')).toBe('0.01')
    expect(chipUnitForCurrency('usd')).toBe('0.01')
    expect(chipUnitForCurrency('KRW')).toBe('1')
    expect(chipUnitForCurrency('JPY')).toBe('1')
    expect(chipUnitForCurrency('KWD')).toBe('0.001')
    // HUF is two decimals in ISO 4217 despite the folklore.
    expect(chipUnitForCurrency('HUF')).toBe('0.01')
    expect(chipUnitForCurrency('XYZ')).toBeUndefined()
    expect(CURRENCY_MINOR_UNITS['KRW']).toBe(0)
  })

  it('splits an odd chip-game pot 12 / 13', () => {
    expect(replay(loadFixture('split-pot-board-plays')).result?.winners).toEqual(
      [
        { seat: 0, amount: '12', handName: 'Straight' },
        { seat: 1, amount: '13', handName: 'Straight' },
      ],
    )
  })

  it('rejects an amount smaller than the currency allows', () => {
    const halfCent = threeHanded({
      actions: [
        { t: 'post', seat: 1, kind: 'sb', amount: '5' },
        { t: 'post', seat: 2, kind: 'bb', amount: '10' },
        { t: 'raise', seat: 0, to: '30.005' },
      ],
    })

    expect(validateRecord(halfCent).map((problem) => problem.code)).toContain(
      'illegal-amount',
    )

    const wonCents = threeHanded({ currency: 'KRW', blinds: { sb: '5', bb: '10.5' } })

    expect(validateRecord(wonCents).map((problem) => problem.code)).toContain(
      'illegal-amount',
    )
  })

  it('rejects a currency that is not a code', () => {
    expect(
      validateRecordStatic(threeHanded({ currency: 'usd' })).map(
        (problem) => problem.code,
      ),
    ).toContain('bad-currency')
  })
})

describe('R4-1 · the hand cannot start without its forced bets', () => {
  it('rejects a raise with no small blind on the table', () => {
    const noSb = threeHanded({
      actions: [
        { t: 'post', seat: 2, kind: 'bb', amount: '10' },
        { t: 'raise', seat: 0, to: '30' },
      ],
    })

    expect(validateRecord(noSb).map((problem) => problem.code)).toContain(
      'bad-blinds',
    )
    expect(() => replay(noSb)).toThrow(/without the small blind from seat 1/)
  })

  it('reports every seat that owes an ante, before anything else', () => {
    const partialAntes = threeHanded({
      blinds: { sb: '5', bb: '10', ante: '1', anteType: 'each' },
      actions: [
        { t: 'post', seat: 0, kind: 'ante', amount: '1' },
        ...posts,
        { t: 'raise', seat: 0, to: '30' },
      ],
    })
    const codes = validateRecord(partialAntes).map((problem) => problem.code)

    // The missing antes come first, ahead of any error the walk itself hits:
    // they are collected before the replay is even attempted. The walk then
    // stops on the same action, which is why the unfinished street that
    // follows never gets its own line.
    expect(codes[0]).toBe('bad-blinds')
    expect(validateRecord(partialAntes)[0]?.message).toContain('seat 1')
    expect(validateRecord(partialAntes)[0]?.message).toContain('seat 2')
    // Seat 1 then posts its blind while still owing the ante, which the walk
    // reports in turn — the missing antes are already ahead of it.
    expect(codes).toEqual(['bad-blinds', 'illegal-action'])
  })

  it('says nothing about the blinds when they are all there', () => {
    // The same unfinished hand with its ante posted: only the street it stops
    // in is reported, so the new check adds nothing of its own.
    const unfinished = threeHanded({
      blinds: { sb: '5', bb: '10', ante: '1', anteType: 'bb' },
      actions: [
        { t: 'post', seat: 2, kind: 'ante', amount: '1' },
        ...posts,
        { t: 'raise', seat: 0, to: '30' },
      ],
    })

    expect(validateRecord(unfinished).map((problem) => problem.code)).toEqual([
      'street-not-closed',
    ])
  })

  it('wants the small blind from the button heads-up', () => {
    const headsUp: HandRecord = {
      v: 1,
      id: '400',
      playedAt: 1787961600000,
      game: 'NLHE',
      currency: 'USD',
      blinds: { sb: '5', bb: '10' },
      seats: 2,
      button: 0,
      players: [
        { seat: 0, stack: '1000', hero: true },
        { seat: 1, stack: '1000' },
      ],
      actions: [
        { t: 'post', seat: 1, kind: 'bb', amount: '10' },
        { t: 'fold', seat: 0 },
      ],
    }

    expect(validateRecord(headsUp).map((problem) => problem.code)).toContain(
      'bad-blinds',
    )
    expect(
      validateRecord({
        ...headsUp,
        actions: [
          { t: 'post', seat: 0, kind: 'sb', amount: '5' },
          { t: 'post', seat: 1, kind: 'bb', amount: '10' },
          { t: 'fold', seat: 0 },
        ],
      }),
    ).toEqual([])
  })

  it('says nothing about a record that has not started yet', () => {
    const justPosts = threeHanded({
      actions: [{ t: 'post', seat: 1, kind: 'sb', amount: '5' }],
    })

    expect(validateRecord(justPosts).map((problem) => problem.code)).toEqual([
      'street-not-closed',
    ])
  })

  it('leaves every fixture alone', () => {
    FIXTURE_NAMES.forEach((name) => {
      expect(validateRecord(loadFixture(name)), name).toEqual([])
    })
  })
})

describe('R4-2 · the board is exactly what the streets dealt', () => {
  const base = loadFixture('unknown-cards-manual-winners')

  it('rejects a board that contradicts the street cards', () => {
    const contradiction: HandRecord = { ...base, board: 'Kh8d3c9sQc' }

    expect(validateRecord(contradiction).map((problem) => problem.code)).toContain(
      'bad-board',
    )
    // The reducer itself does not read `hand.board` (see R5-4): it deals what
    // the street actions say and leaves the copy to the static check.
    expect(replay(contradiction).board).toBe('Qs7d2c4s9h')
  })

  it('rejects a board that runs past the recorded streets', () => {
    // An unrecorded runout is a missing `street` action, not a longer board.
    const flopOnly: HandRecord = {
      ...base,
      actions: base.actions.slice(0, 9),
      board: 'Qs7d2c4s9h',
    }

    expect(validateRecord(flopOnly).map((problem) => problem.code)).toContain(
      'bad-board',
    )
  })

  it('judges the showdown on the dealt board alone', () => {
    // Two known hands, all-in, but only the flop was recorded: there is no
    // fifth card to evaluate, so the record has to name the winner itself.
    const noRunout: HandRecord = {
      v: 1,
      id: '401',
      playedAt: 1787961600000,
      game: 'NLHE',
      currency: 'USD',
      blinds: { sb: '5', bb: '10' },
      seats: 2,
      button: 0,
      players: [
        { seat: 0, stack: '100', cards: 'AhAd', hero: true },
        { seat: 1, stack: '100', cards: 'KsKd' },
      ],
      actions: [
        { t: 'post', seat: 0, kind: 'sb', amount: '5' },
        { t: 'post', seat: 1, kind: 'bb', amount: '10' },
        { t: 'allin', seat: 0, to: '100' },
        { t: 'allin', seat: 1, to: '100' },
        { t: 'street', street: 'flop', cards: '2c7d9h' },
      ],
    }
    const final = replay(noRunout)

    expect(final.board).toBe('2c7d9h')
    expect(final.needsWinners).toBe(true)
    expect(final.result).toBeUndefined()
  })
})

describe('R4-3 · only registered currencies are money', () => {
  it('covers the four-decimal and no-decimal corners of ISO 4217', () => {
    expect(chipUnitForCurrency('CLF')).toBe('0.0001')
    expect(chipUnitForCurrency('UYW')).toBe('0.0001')
    expect(chipUnitForCurrency('VUV')).toBe('1')
    expect(chipUnitForCurrency('KRW')).toBe('1')
    expect(chipUnitForCurrency('USD')).toBe('0.01')
    expect(chipUnitForCurrency('BHD')).toBe('0.001')
  })

  it('carries the whole active list, with sane exponents', () => {
    const codes = Object.keys(CURRENCY_MINOR_UNITS)

    expect(codes.length).toBeGreaterThan(150)
    codes.forEach((code) => {
      expect(code, code).toMatch(/^[A-Z]{3}$/)
      expect([0, 2, 3, 4], code).toContain(CURRENCY_MINOR_UNITS[code])
    })
    // Precious metals and fund codes are not currencies a game is played in.
    expect(CURRENCY_MINOR_UNITS['XAU']).toBeUndefined()
    expect(CURRENCY_MINOR_UNITS['XXX']).toBeUndefined()
  })

  it('rejects an unregistered or malformed code', () => {
    expect(chipUnitForCurrency('ZZZ')).toBeUndefined()
    expect(
      validateRecordStatic(threeHanded({ currency: 'ZZZ' })).map(
        (problem) => problem.code,
      ),
    ).toContain('bad-currency')
    expect(
      validateRecordStatic(threeHanded({ currency: 'usd' })).map(
        (problem) => problem.code,
      ),
    ).toContain('bad-currency')
    expect(validateRecordStatic(threeHanded({ currency: '' }))).toEqual([])
  })
})

describe('R5-1 · a straddle is bounded by the stack', () => {
  const table = threeHanded({
    seats: 6,
    players: [
      { seat: 0, stack: '1000', hero: true },
      { seat: 1, stack: '1000' },
      { seat: 2, stack: '1000' },
      { seat: 3, stack: '5' },
      { seat: 4, stack: '1000' },
      { seat: 5, stack: '1000' },
    ],
  })
  const blinds: HandAction[] = [
    { t: 'post', seat: 1, kind: 'sb', amount: '5' },
    { t: 'post', seat: 2, kind: 'bb', amount: '10' },
  ]
  const posted = walk(table, blinds)

  it('refuses a straddle bigger than the stack behind it', () => {
    expect(
      validateAction(
        posted,
        { t: 'post', seat: 3, kind: 'straddle', amount: '1000' },
        table,
      ),
    ).toMatchObject({ code: 'illegal-amount', seat: 3 })
    expect(() =>
      applyAction(
        posted,
        { t: 'post', seat: 3, kind: 'straddle', amount: '1000' },
        table,
      ),
    ).toThrow(/cannot post 1000 out of 5/)
  })

  it('lets the whole stack go in, without lowering the stakes', () => {
    const action: HandAction = {
      t: 'post',
      seat: 3,
      kind: 'straddle',
      amount: '5',
    }

    expect(validateAction(posted, action, table)).toBeNull()

    const state = applyAction(posted, action, table)

    // A straddle short of the blind leaves the table playing for the blind.
    expect(state.betting.bringIn).toBe('10')
    expect(state.betting.lastRaiseSize).toBe('10')
    expect(currentBet(state)).toBe('10')
  })

  it('raises the stakes when the straddle clears the blind', () => {
    const deep: HandRecord = {
      ...table,
      players: table.players.map((player) => ({ ...player, stack: '1000' })),
    }
    const state = applyAction(
      walk(deep, blinds),
      { t: 'post', seat: 3, kind: 'straddle', amount: '20' },
      deep,
    )

    expect(state.betting.bringIn).toBe('20')
    expect(state.betting.lastRaiseSize).toBe('20')
    expect(currentBet(state)).toBe('20')
  })
})

describe('R5-2 · validateAction guards the forced bets too', () => {
  const record = threeHanded()

  it('refuses the first voluntary action while the blinds are missing', () => {
    const start = initialState(record)

    expect(start.actingSeat).toBe(0)
    expect(validateAction(start, { t: 'check', seat: 0 }, record)).toMatchObject(
      { code: 'bad-blinds' },
    )
    expect(
      validateAction(start, { t: 'bet', seat: 0, to: '30' }, record),
    ).toMatchObject({ code: 'bad-blinds' })
    expect(() =>
      applyAction(start, { t: 'bet', seat: 0, to: '30' }, record),
    ).toThrow(/without the small blind/)
  })

  it('is happy once they are posted', () => {
    const posted = walk(record, posts)

    expect(
      validateAction(posted, { t: 'raise', seat: 0, to: '30' }, record),
    ).toBeNull()
  })
})

describe('R5-3 · an ante that empties the stack excuses the blind', () => {
  it('lets a heads-up big blind post only its ante', () => {
    const headsUp: HandRecord = {
      v: 1,
      id: '500',
      playedAt: 1787961600000,
      game: 'NLHE',
      currency: 'USD',
      blinds: { sb: '5', bb: '10', ante: '1', anteType: 'bb' },
      seats: 2,
      button: 0,
      players: [
        { seat: 0, stack: '100', cards: 'AhAd', hero: true },
        { seat: 1, stack: '0.5', cards: 'KsKd' },
      ],
      board: '2c7d9hJs4c',
      actions: [
        { t: 'post', seat: 1, kind: 'ante', amount: '0.5' },
        { t: 'post', seat: 0, kind: 'sb', amount: '5' },
        { t: 'call', seat: 0, amount: '10' },
        { t: 'street', street: 'flop', cards: '2c7d9h' },
        { t: 'street', street: 'turn', cards: 'Js' },
        { t: 'street', street: 'river', cards: '4c' },
      ],
    }
    const final = replay(headsUp)

    expect(validateRecord(headsUp)).toEqual([])
    // Only the ante ever reached the pot, and the uncalled 10 went back.
    expect(final.pots).toEqual([{ amount: '0.5', eligible: [0, 1] }])
    expect(final.result?.winners).toEqual([
      { seat: 0, amount: '0.5', handName: 'Pair' },
    ])
  })

  it('excuses the blind multiway when each seat antes', () => {
    const multiway = threeHanded({
      blinds: { sb: '5', bb: '10', ante: '1', anteType: 'each' },
      players: [
        { seat: 0, stack: '100', cards: 'AhAd', hero: true },
        { seat: 1, stack: '100', cards: 'QsQd' },
        { seat: 2, stack: '1', cards: 'KsKd' },
      ],
      board: '2c7d9hJs4c',
      actions: [
        { t: 'post', seat: 0, kind: 'ante', amount: '1' },
        { t: 'post', seat: 1, kind: 'ante', amount: '1' },
        { t: 'post', seat: 2, kind: 'ante', amount: '1' },
        { t: 'post', seat: 1, kind: 'sb', amount: '5' },
        { t: 'raise', seat: 0, to: '30' },
        { t: 'fold', seat: 1 },
        { t: 'street', street: 'flop', cards: '2c7d9h' },
        { t: 'street', street: 'turn', cards: 'Js' },
        { t: 'street', street: 'river', cards: '4c' },
      ],
    })

    expect(validateRecord(multiway)).toEqual([])
    expect(replay(multiway).result?.winners).toEqual([
      { seat: 0, amount: '13', handName: 'Pair' },
    ])
  })

  it('makes the ante come before the blind', () => {
    const wrongOrder = threeHanded({
      blinds: { sb: '5', bb: '10', ante: '1', anteType: 'each' },
      actions: [{ t: 'post', seat: 0, kind: 'ante', amount: '1' }],
    })
    const state = walk(wrongOrder, [
      { t: 'post', seat: 0, kind: 'ante', amount: '1' },
    ])

    expect(
      validateAction(
        state,
        { t: 'post', seat: 1, kind: 'sb', amount: '5' },
        wrongOrder,
      ),
    ).toMatchObject({ code: 'illegal-action', seat: 1 })
  })
})

describe('R5-4 · the reducer ignores hand.board entirely', () => {
  const stale = threeHanded({
    board: '2c3d4h',
    actions: [
      ...posts,
      { t: 'call', seat: 0, amount: '10' },
      { t: 'call', seat: 1, amount: '10' },
      { t: 'check', seat: 2 },
      { t: 'street', street: 'flop', cards: '2c3d4h' },
      { t: 'check', seat: 1 },
      { t: 'check', seat: 2 },
      { t: 'check', seat: 0 },
    ],
  })

  it('deals a turn the recorded board does not mention', () => {
    const state = walk(stale, stale.actions)
    const turn: HandAction = { t: 'street', street: 'turn', cards: '5s' }

    expect(state.actingSeat).toBeNull()
    expect(validateAction(state, turn, stale)).toBeNull()
    expect(applyAction(state, turn, stale).board).toBe('2c3d4h5s')
  })

  it('still reports the stale copy statically', () => {
    const dealt: HandRecord = {
      ...stale,
      actions: [
        ...stale.actions,
        { t: 'street', street: 'turn', cards: '5s' },
      ],
    }

    expect(
      validateRecordStatic(dealt).map((problem) => problem.code),
    ).toContain('bad-board')
  })
})

describe('R5-5 · cards have exactly one spelling', () => {
  it('rejects a card that is not in normal form', () => {
    const shouty = threeHanded({
      players: [
        { seat: 0, stack: '100', cards: 'aH', hero: true },
        { seat: 1, stack: '100' },
        { seat: 2, stack: '100' },
      ],
    })

    expect(
      validateRecordStatic(shouty).map((problem) => problem.code),
    ).toContain('bad-cards')
  })

  it('rejects the alternate spelling before calling it a duplicate', () => {
    const both = threeHanded({
      players: [
        { seat: 0, stack: '100', cards: 'AhKd', hero: true },
        { seat: 1, stack: '100', cards: 'aHKs' },
        { seat: 2, stack: '100' },
      ],
    })
    const codes = validateRecordStatic(both).map((problem) => problem.code)

    expect(codes).toContain('bad-cards')
    expect(codes).not.toContain('duplicate-card')
  })

  it('rejects a shouted board and a shouted street', () => {
    expect(
      validateRecordStatic(threeHanded({ board: '2C3D4H' })).map(
        (problem) => problem.code,
      ),
    ).toContain('bad-board')
    expect(
      validateRecordStatic(
        threeHanded({
          actions: [
            ...posts,
            { t: 'call', seat: 0, amount: '10' },
            { t: 'call', seat: 1, amount: '10' },
            { t: 'check', seat: 2 },
            { t: 'street', street: 'flop', cards: '2C3d4h' },
          ],
        }),
      ).map((problem) => problem.code),
    ).toContain('bad-board')
  })
})

describe('R5-6 · a short all-in straddle raises the call, not the increment', () => {
  // TDA: a straddle that cannot double what it sits behind is a call-sized
  // blind. Everyone has to match it, but the raise increment stays the blind.
  const sixMax = (straddlerStack: string): HandRecord =>
    threeHanded({
      seats: 6,
      players: [
        { seat: 0, stack: '1000', hero: true },
        { seat: 1, stack: '1000' },
        { seat: 2, stack: '1000' },
        { seat: 3, stack: straddlerStack },
        { seat: 4, stack: '1000' },
        { seat: 5, stack: '1000' },
      ],
    })
  const blinds: HandAction[] = [
    { t: 'post', seat: 1, kind: 'sb', amount: '5' },
    { t: 'post', seat: 2, kind: 'bb', amount: '10' },
  ]

  it('lifts the bring-in to 15 but leaves the increment at 10', () => {
    const table = sixMax('15')
    const state = walk(table, [
      ...blinds,
      { t: 'post', seat: 3, kind: 'straddle', amount: '15' },
    ])

    expect(state.betting.bringIn).toBe('15')
    expect(state.betting.lastRaiseSize).toBe('10')
    expect(currentBet(state)).toBe('15')

    // Seat 4 is first to act, left of the straddle.
    const legal = legalActions(state, table)

    expect(state.actingSeat).toBe(4)
    expect(legal?.callAmount).toBe('15')
    expect(legal?.minRaiseTo).toBe('25')
    expect(
      validateAction(state, { t: 'raise', seat: 4, to: '20' }, table)?.code,
    ).toBe('illegal-amount')
    expect(
      validateAction(state, { t: 'raise', seat: 4, to: '25' }, table),
    ).toBeNull()
  })

  it('does the same heads-up, where the straddle carries the small blind', () => {
    // Button posts 5, then straddles all-in for 7: 12 on the street, which is
    // over the blind but short of the 20 a real straddle would be.
    const headsUp = threeHanded({
      seats: 2,
      button: 0,
      players: [
        { seat: 0, stack: '12', hero: true },
        { seat: 1, stack: '1000' },
      ],
    })
    const state = walk(headsUp, [
      { t: 'post', seat: 0, kind: 'sb', amount: '5' },
      { t: 'post', seat: 1, kind: 'bb', amount: '10' },
      { t: 'post', seat: 0, kind: 'straddle', amount: '7' },
    ])
    const legal = legalActions(state, headsUp)

    expect(state.betting.bringIn).toBe('12')
    expect(state.betting.lastRaiseSize).toBe('10')
    // The big blind is first to act heads-up once the button straddles.
    expect(state.actingSeat).toBe(1)
    expect(legal?.callAmount).toBe('2')
    expect(legal?.minRaiseTo).toBe('22')
  })

  it('behaves differently from a straddle that does double the blind', () => {
    const table = sixMax('1000')
    const state = walk(table, [
      ...blinds,
      { t: 'post', seat: 3, kind: 'straddle', amount: '20' },
    ])
    const legal = legalActions(state, table)

    expect(state.betting.bringIn).toBe('20')
    expect(state.betting.lastRaiseSize).toBe('20')
    expect(legal?.callAmount).toBe('20')
    expect(legal?.minRaiseTo).toBe('40')
  })

  it('lets a deep button straddle to 20 heads-up', () => {
    // 15 on top of the 5 already posted is a full straddle, not an all-in.
    const headsUp = threeHanded({
      seats: 2,
      button: 0,
      players: [
        { seat: 0, stack: '1000', hero: true },
        { seat: 1, stack: '1000' },
      ],
    })
    const state = walk(headsUp, [
      { t: 'post', seat: 0, kind: 'sb', amount: '5' },
      { t: 'post', seat: 1, kind: 'bb', amount: '10' },
      { t: 'post', seat: 0, kind: 'straddle', amount: '15' },
    ])

    expect(state.betting.bringIn).toBe('20')
    expect(state.betting.lastRaiseSize).toBe('20')
    expect(legalActions(state, headsUp)?.minRaiseTo).toBe('40')
  })
})

describe('R6-1 · a straddle never jumps the blinds', () => {
  const headsUp = (buttonStack: string): HandRecord =>
    threeHanded({
      seats: 2,
      button: 0,
      players: [
        { seat: 0, stack: buttonStack, hero: true },
        { seat: 1, stack: '1000' },
      ],
    })

  it('refuses a straddle posted before the small and big blinds', () => {
    const table = headsUp('1000')
    const start = initialState(table)
    const straddle: HandAction = {
      t: 'post',
      seat: 0,
      kind: 'straddle',
      amount: '20',
    }

    expect(validateAction(start, straddle, table)).toMatchObject({
      code: 'illegal-action',
      seat: 0,
    })
    expect(() => applyAction(start, straddle, table)).toThrow(
      /A straddle comes after the small blind from seat 0, the big blind from seat 1/,
    )
  })

  it('refuses one posted after the small blind but before the big', () => {
    const table = headsUp('1000')
    const state = walk(table, [
      { t: 'post', seat: 0, kind: 'sb', amount: '5' },
    ])

    expect(
      validateAction(
        state,
        { t: 'post', seat: 0, kind: 'straddle', amount: '15' },
        table,
      ),
    ).toMatchObject({ code: 'illegal-action' })
  })

  it('takes it once both blinds are up', () => {
    const table = headsUp('1000')
    const state = walk(table, [
      { t: 'post', seat: 0, kind: 'sb', amount: '5' },
      { t: 'post', seat: 1, kind: 'bb', amount: '10' },
      { t: 'post', seat: 0, kind: 'straddle', amount: '15' },
    ])

    expect(state.betting.bringIn).toBe('20')
    expect(state.betting.lastRaiseSize).toBe('20')
    expect(legalActions(state, table)?.minRaiseTo).toBe('40')
  })

  it('closes the short-stack shortcut around the small blind', () => {
    // A 20 button could straddle all-in first, be left with nothing, and then
    // claim the emptied-stack excuse for the small blind it never posted.
    const table = headsUp('20')
    const shortcut = {
      ...table,
      actions: [
        { t: 'post', seat: 0, kind: 'straddle', amount: '20' },
        { t: 'post', seat: 1, kind: 'bb', amount: '10' },
        { t: 'fold', seat: 1 },
      ] as HandAction[],
    }
    // The emptied-stack excuse would swallow the missing blind — the ordering
    // rule is what closes the door, at the straddle itself.
    expect(validateRecord(shortcut).map((problem) => problem.code)).toEqual([
      'illegal-action',
    ])
    expect(validateRecord(shortcut)[0]?.message).toMatch(
      /straddle comes after the small blind/,
    )
    expect(() => replay(shortcut)).toThrow(/A straddle comes after/)
  })

  it('leaves the fixtures alone', () => {
    FIXTURE_NAMES.forEach((name) => {
      expect(validateRecord(loadFixture(name)), name).toEqual([])
    })
  })
})

describe('R7-1 · the reducer judges a post before the chips move', () => {
  const headsUp = threeHanded({
    seats: 2,
    button: 0,
    players: [
      { seat: 0, stack: '20', hero: true },
      { seat: 1, stack: '1000' },
    ],
  })

  it('does not let a straddle spend the stack that would excuse its blind', () => {
    // Seat 0 owes the small blind. Straddling its whole 20 first would leave
    // it broke — and a broke seat owes nothing — so the check has to happen
    // while the chips are still in front of it.
    const state = walk(headsUp, [
      { t: 'post', seat: 1, kind: 'bb', amount: '10' },
    ])
    const straddle: HandAction = {
      t: 'post',
      seat: 0,
      kind: 'straddle',
      amount: '20',
    }

    expect(validateAction(state, straddle, headsUp)).toMatchObject({
      code: 'illegal-action',
      seat: 0,
    })
    expect(() => applyAction(state, straddle, headsUp)).toThrow(
      /A straddle comes after the small blind from seat 0/,
    )
  })

  it('still takes the straddle in the right order', () => {
    const state = walk(headsUp, [
      { t: 'post', seat: 0, kind: 'sb', amount: '5' },
      { t: 'post', seat: 1, kind: 'bb', amount: '10' },
    ])
    const straddle: HandAction = {
      t: 'post',
      seat: 0,
      kind: 'straddle',
      amount: '15',
    }

    expect(validateAction(state, straddle, headsUp)).toBeNull()
    expect(applyAction(state, straddle, headsUp).betting.bringIn).toBe('20')
  })
})

describe('R7-1 · validateAction and applyAction agree', () => {
  it('never rejects a fixture action, and never fails to apply one', () => {
    FIXTURE_NAMES.forEach((name) => {
      const hand = loadFixture(name)
      let state = initialState(hand)

      hand.actions.forEach((action, index) => {
        expect(validateAction(state, action, hand), `${name} @ ${index}`).toBeNull()
        state = applyAction(state, action, hand)
      })
    })
  })

  it('throws on every forced-bet rejection it reports', () => {
    // Only for the posting rules: elsewhere the reducer is deliberately the
    // looser of the two (it replays an undersized raise that `validateAction`
    // calls illegal), so this pairing is asserted where both must agree.
    const table = threeHanded({
      seats: 2,
      button: 0,
      players: [
        { seat: 0, stack: '20', hero: true },
        { seat: 1, stack: '1000' },
      ],
    })
    const cases: Array<{ before: HandAction[]; action: HandAction }> = [
      // A straddle ahead of the blinds.
      {
        before: [{ t: 'post', seat: 1, kind: 'bb', amount: '10' }],
        action: { t: 'post', seat: 0, kind: 'straddle', amount: '20' },
      },
      // A post for more than the stack behind it.
      {
        before: [],
        action: { t: 'post', seat: 0, kind: 'sb', amount: '5000' },
      },
      // The first voluntary action while a blind is missing.
      {
        before: [{ t: 'post', seat: 0, kind: 'sb', amount: '5' }],
        action: { t: 'raise', seat: 0, to: '30' },
      },
      // A blind posted after the flop.
      {
        before: [
          { t: 'post', seat: 0, kind: 'sb', amount: '5' },
          { t: 'post', seat: 1, kind: 'bb', amount: '10' },
          { t: 'call', seat: 0, amount: '10' },
          { t: 'check', seat: 1 },
          { t: 'street', street: 'flop', cards: '2c7d9h' },
        ],
        action: { t: 'post', seat: 1, kind: 'bb', amount: '10' },
      },
    ]

    cases.forEach(({ before, action }, index) => {
      const state = walk(table, before)

      expect(validateAction(state, action, table), `case ${index}`).not.toBeNull()
      expect(() => applyAction(state, action, table), `case ${index}`).toThrow(
        HandReplayError,
      )
    })
  })
})
