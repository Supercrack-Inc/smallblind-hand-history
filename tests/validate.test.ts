import { describe, expect, it } from 'vitest'

import { applyAction, HandReplayError, initialState, replay } from '../src/replay'
import type { HandAction, HandRecord } from '../src/types'
import { legalActions, validateAction, validateRecord } from '../src/validate'

function hand(overrides: Partial<HandRecord> = {}): HandRecord {
  return {
    v: 1,
    id: '1',
    playedAt: 1787961600000,
    game: 'NLHE',
    currency: 'USD',
    blinds: { sb: '5', bb: '10' },
    seats: 3,
    button: 0,
    players: [
      { seat: 0, stack: '1000', cards: 'AhKh', hero: true },
      { seat: 1, stack: '1000', cards: 'QsQd' },
      { seat: 2, stack: '140', cards: '7c7d' },
    ],
    actions: [],
    ...overrides,
  }
}

/** Replay a list of actions against a record, returning the resulting state. */
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

describe('legalActions', () => {
  it('offers a check to the big blind after limps', () => {
    const record = hand()
    const state = walk(record, [
      ...posts,
      { t: 'call', seat: 0, amount: '10' },
      { t: 'call', seat: 1, amount: '10' },
    ])

    expect(state.actingSeat).toBe(2)
    expect(legalActions(state, record)).toEqual({
      canFold: false,
      canCheck: true,
      canAllIn: true,
      minRaiseTo: '20',
      maxRaiseTo: '140',
    })
  })

  it('sets the minimum raise from the last full raise', () => {
    const record = hand()
    const state = walk(record, [...posts, { t: 'raise', seat: 0, to: '25' }])

    // The raise was 15 over the big blind, so the next one must reach 40.
    expect(legalActions(state, record)?.minRaiseTo).toBe('40')
    expect(legalActions(state, record)?.callAmount).toBe('20')
  })

  it('caps the minimum raise at the stack when the player is short', () => {
    const record = hand()
    const state = walk(record, [...posts, { t: 'raise', seat: 0, to: '80' }])

    expect(state.actingSeat).toBe(1)

    const short = walk(record, [
      ...posts,
      { t: 'raise', seat: 0, to: '80' },
      { t: 'fold', seat: 1 },
    ])

    // Seat 2 has 140 behind: it can only get to 140, below the 150 minimum.
    expect(legalActions(short, record)?.minRaiseTo).toBe('140')
    expect(legalActions(short, record)?.maxRaiseTo).toBe('140')
  })

  it('does not reopen the betting after an undersized all-in', () => {
    const record = hand()
    const preflop: HandAction[] = [
      ...posts,
      { t: 'call', seat: 0, amount: '10' },
      { t: 'call', seat: 1, amount: '10' },
      { t: 'check', seat: 2 },
      { t: 'street', street: 'flop', cards: '2c5d9s' },
      { t: 'bet', seat: 1, to: '100' },
      { t: 'allin', seat: 2, to: '130' },
    ]

    // Seat 0 has not acted on this street, so it may still raise.
    const beforeCall = walk(record, preflop)
    expect(beforeCall.actingSeat).toBe(0)
    expect(legalActions(beforeCall, record)?.minRaiseTo).toBe('230')

    // Seat 1 already acted and faces only a 30 raise: call or fold.
    const afterCall = walk(record, [
      ...preflop,
      { t: 'call', seat: 0, amount: '130' },
    ])
    const legal = legalActions(afterCall, record)

    expect(afterCall.actingSeat).toBe(1)
    expect(legal?.callAmount).toBe('30')
    expect(legal?.minRaiseTo).toBeUndefined()
    expect(legal?.maxRaiseTo).toBeUndefined()
    expect(
      validateAction(afterCall, { t: 'raise', seat: 1, to: '300' }, record)
        ?.code,
    ).toBe('illegal-action')
  })

  it('returns null once the hand is over', () => {
    const record = hand({
      actions: [
        ...posts,
        { t: 'raise', seat: 0, to: '30' },
        { t: 'fold', seat: 1 },
        { t: 'fold', seat: 2 },
      ],
    })

    expect(legalActions(replay(record), record)).toBeNull()
  })
})

describe('validateAction', () => {
  const record = hand()
  const afterPosts = walk(record, posts)

  it('rejects a seat acting out of turn', () => {
    expect(
      validateAction(afterPosts, { t: 'call', seat: 2, amount: '10' }, record),
    ).toMatchObject({ code: 'not-your-turn', seat: 2 })
  })

  it('rejects an undersized raise but allows a short all-in', () => {
    const state = walk(record, [...posts, { t: 'raise', seat: 0, to: '80' }, { t: 'fold', seat: 1 }])

    expect(
      validateAction(state, { t: 'raise', seat: 2, to: '100' }, record)?.code,
    ).toBe('illegal-amount')
    expect(
      validateAction(state, { t: 'allin', seat: 2, to: '140' }, record),
    ).toBeNull()
  })

  it('rejects a call for the wrong amount', () => {
    expect(
      validateAction(afterPosts, { t: 'call', seat: 0, amount: '8' }, record)
        ?.code,
    ).toBe('illegal-amount')
  })

  it('rejects a check while facing a bet', () => {
    expect(
      validateAction(afterPosts, { t: 'check', seat: 0 }, record)?.code,
    ).toBe('illegal-action')
  })

  it('rejects a street marker while a seat still has to act', () => {
    expect(
      validateAction(
        afterPosts,
        { t: 'street', street: 'flop', cards: '2c5d9s' },
        record,
      ),
    ).toMatchObject({ code: 'street-not-closed', seat: 0 })
  })

  it('rejects a flop that is not three cards, and a duplicate board card', () => {
    const closed = walk(record, [
      ...posts,
      { t: 'call', seat: 0, amount: '10' },
      { t: 'call', seat: 1, amount: '10' },
      { t: 'check', seat: 2 },
    ])

    expect(
      validateAction(closed, { t: 'street', street: 'flop', cards: '2c5d' }, record)
        ?.code,
    ).toBe('bad-board')
    expect(
      validateAction(
        closed,
        { t: 'street', street: 'flop', cards: '2cAhKh' },
        record,
      )?.code,
    ).toBe('duplicate-card')
    expect(
      validateAction(closed, { t: 'street', street: 'turn', cards: '2c' }, record)
        ?.code,
    ).toBe('bad-street')
  })
})

describe('validateRecord', () => {
  it('accepts a sound record', () => {
    expect(
      validateRecord(
        hand({
          actions: [
            ...posts,
            { t: 'raise', seat: 0, to: '30' },
            { t: 'fold', seat: 1 },
            { t: 'fold', seat: 2 },
          ],
        }),
      ),
    ).toEqual([])
  })

  it('reports a button on an empty seat', () => {
    expect(
      validateRecord(hand({ button: 2, players: [
        { seat: 0, stack: '100' },
        { seat: 1, stack: '100' },
      ] })).map((problem) => problem.code),
    ).toContain('bad-button')
  })

  it('reports a card dealt twice', () => {
    expect(
      validateRecord(
        hand({
          players: [
            { seat: 0, stack: '100', cards: 'AhKh' },
            { seat: 1, stack: '100', cards: 'AhQd' },
            { seat: 2, stack: '100', cards: '7c7d' },
          ],
        }),
      ).map((problem) => problem.code),
    ).toContain('duplicate-card')
  })

  it('reports a seat off the table and a duplicated seat', () => {
    const codes = validateRecord(
      hand({
        seats: 3,
        players: [
          { seat: 0, stack: '100' },
          { seat: 0, stack: '100' },
          { seat: 9, stack: '100' },
        ],
      }),
    ).map((problem) => problem.code)

    expect(codes).toContain('duplicate-seat')
    expect(codes).toContain('bad-seat')
  })

  it('reports a showdown with unknown cards and no winners', () => {
    const codes = validateRecord(
      hand({
        players: [
          { seat: 0, stack: '1000', cards: 'AhKh', hero: true },
          { seat: 1, stack: '1000' },
          { seat: 2, stack: '1000' },
        ],
        actions: [
          ...posts,
          { t: 'call', seat: 0, amount: '10' },
          { t: 'call', seat: 1, amount: '10' },
          { t: 'check', seat: 2 },
          { t: 'street', street: 'flop', cards: '2c5d9s' },
          { t: 'check', seat: 1 },
          { t: 'check', seat: 2 },
          { t: 'check', seat: 0 },
          { t: 'street', street: 'turn', cards: 'Jh' },
          { t: 'check', seat: 1 },
          { t: 'check', seat: 2 },
          { t: 'check', seat: 0 },
          { t: 'street', street: 'river', cards: '3h' },
          { t: 'check', seat: 1 },
          { t: 'check', seat: 2 },
          { t: 'check', seat: 0 },
        ],
      }),
    ).map((problem) => problem.code)

    expect(codes).toContain('bad-winners')
  })

  it('reports winners that do not add up to the pot', () => {
    const codes = validateRecord(
      hand({
        winners: [{ seat: 0, amount: '999' }],
        actions: [
          ...posts,
          { t: 'raise', seat: 0, to: '30' },
          { t: 'fold', seat: 1 },
          { t: 'fold', seat: 2 },
        ],
      }),
    ).map((problem) => problem.code)

    expect(codes).toContain('bad-winners')
  })
})

describe('HandReplayError', () => {
  it('refuses an action from a folded seat', () => {
    const record = hand()
    const state = walk(record, [...posts, { t: 'fold', seat: 0 }])

    expect(() =>
      applyAction(state, { t: 'call', seat: 0, amount: '10' }, record),
    ).toThrow(HandReplayError)
  })

  it('refuses an unseated player and an oversized raise', () => {
    const record = hand()
    const state = walk(record, posts)

    expect(() =>
      applyAction(state, { t: 'call', seat: 7, amount: '10' }, record),
    ).toThrow(/not seated/)
    expect(() =>
      applyAction(state, { t: 'raise', seat: 0, to: '5000' }, record),
    ).toThrow(/stack/)
  })

  it('carries the step of the offending action', () => {
    const record = hand()
    const state = walk(record, posts)

    try {
      applyAction(state, { t: 'call', seat: 7, amount: '10' }, record)
      expect.unreachable()
    } catch (cause) {
      expect(cause).toBeInstanceOf(HandReplayError)
      expect((cause as HandReplayError).step).toBe(2)
    }
  })
})
