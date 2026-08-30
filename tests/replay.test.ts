import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  applyAction,
  currentBet,
  finalStacks,
  HAND_CATEGORY_NAMES,
  initialState,
  replay,
  replayAll,
  totalPot,
} from '../src/replay'
import { HandCategory } from '../src/hand-evaluator'
import { EN_LABELS, formatHandText } from '../src/text'
import type { HandRecord } from '../src/types'

function loadFixture(name: string): HandRecord {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url))
  return (JSON.parse(readFileSync(path, 'utf8')) as { hand: HandRecord }).hand
}

const pokerbase = loadFixture('pokerbase-aa-vs-55')
const unknownCards = loadFixture('unknown-cards-manual-winners')

describe('replay', () => {
  it('starts with untouched stacks and the action on UTG', () => {
    const state = initialState(pokerbase)

    expect(state.step).toBe(0)
    expect(state.street).toBe('preflop')
    expect(state.board).toBe('')
    expect(state.pots).toEqual([])
    expect(state.stacks[0]).toBe('1200000')
    expect(state.actingSeat).toBe(8)
    expect(state.isComplete).toBe(false)
  })

  it('never mutates the state it is given', () => {
    const state = initialState(pokerbase)
    const snapshot = JSON.stringify(state)

    applyAction(state, pokerbase.actions[0]!, pokerbase)

    expect(JSON.stringify(state)).toBe(snapshot)
  })

  it('keeps the ante out of the street bets but inside the pot', () => {
    const state = replay(pokerbase, 1)

    expect(state.streetBets[7]).toBe('0')
    expect(state.committed[7]).toBe('10000')
    expect(state.pots).toEqual([{ amount: '10000', eligible: [0, 1, 2, 3, 4, 5, 6, 7, 8] }])
    expect(totalPot(state)).toBe('10000')
  })

  it('treats bet and call amounts as cumulative street totals', () => {
    // Villain raises to 22,000 and calls the 65,000 three-bet: 65,000 total.
    const state = replay(pokerbase, 13)

    expect(state.streetBets[8]).toBe('65000')
    expect(state.committed[8]).toBe('65000')
    expect(currentBet(state)).toBe('65000')
    expect(state.actingSeat).toBeNull()
  })

  it('reports the final stacks including the award', () => {
    const final = replay(pokerbase)

    expect(final.stacks[8]).toBe('600000')
    expect(finalStacks(final)[8]).toBe('1825000')
    expect(finalStacks(final)[0]).toBe('600000')
  })

  it('caps a call at the caller’s stack and marks the all-in', () => {
    const hand: HandRecord = {
      v: 1,
      id: '10',
      playedAt: 1787961600000,
      game: 'NLHE',
      currency: '',
      blinds: { sb: '5', bb: '10' },
      seats: 2,
      button: 0,
      players: [
        { seat: 0, stack: '1000', cards: 'AhAd' },
        { seat: 1, stack: '60', cards: 'KsKd' },
      ],
      board: '2c7d9hJs4c',
      actions: [
        { t: 'post', seat: 0, kind: 'sb', amount: '5' },
        { t: 'post', seat: 1, kind: 'bb', amount: '10' },
        { t: 'raise', seat: 0, to: '200' },
        { t: 'call', seat: 1, amount: '200' },
        { t: 'street', street: 'flop', cards: '2c7d9h' },
        { t: 'street', street: 'turn', cards: 'Js' },
        { t: 'street', street: 'river', cards: '4c' },
      ],
    }
    const afterCall = replay(hand, 4)

    expect(afterCall.stacks[1]).toBe('0')
    expect(afterCall.allIn).toEqual([1])

    const final = replay(hand)

    // Seat 0 only ever risked 60: the other 140 comes back.
    expect(final.pots).toEqual([{ amount: '120', eligible: [0, 1] }])
    expect(final.stacks[0]).toBe('940')
    expect(final.result?.net).toEqual({ 0: '60', 1: '-60' })
  })

  it('returns an uncalled bet before paying the last player standing', () => {
    const headsUp = loadFixture('heads-up-button-first')
    const final = replay(headsUp)

    expect(final.result?.winners).toEqual([{ seat: 0, amount: '180' }])
    expect(final.stacks[0]).toBe('910')
    expect(final.street).toBe('flop')
  })

  it('falls back to the recorded winners when a villain never showed', () => {
    const final = replay(unknownCards)

    expect(final.needsWinners).toBeUndefined()
    expect(final.result?.winners).toEqual([{ seat: 0, amount: '235' }])
  })

  it('asks for winners when the cards cannot decide the pot', () => {
    const withoutWinners: HandRecord = { ...unknownCards }
    delete withoutWinners.winners

    const final = replay(withoutWinners)

    expect(final.isComplete).toBe(true)
    expect(final.needsWinners).toBe(true)
    expect(final.result).toBeUndefined()
  })

  it('picks up hole cards from a show action', () => {
    const shown: HandRecord = {
      ...unknownCards,
      actions: [
        ...unknownCards.actions,
        { t: 'show', seat: 2, cards: 'KdKc' },
      ],
    }
    delete shown.winners

    const final = replay(shown)

    expect(final.revealed[2]).toBe('KdKc')
    expect(final.result?.winners).toEqual([
      { seat: 2, amount: '235', handName: 'Pair' },
    ])
  })

  it('exposes a state for every step', () => {
    const states = replayAll(pokerbase)

    expect(states).toHaveLength(pokerbase.actions.length + 1)
    expect(states[states.length - 1]!.isComplete).toBe(true)
    states.slice(0, -1).forEach((state) => {
      expect(state.isComplete).toBe(false)
    })
  })

  it('names every hand category', () => {
    expect(HAND_CATEGORY_NAMES[HandCategory.ThreeOfAKind]).toBe(
      'Three of a Kind',
    )
    expect(Object.keys(HAND_CATEGORY_NAMES)).toHaveLength(9)
  })
})

describe('formatHandText', () => {
  it('renders the Pokerbase hand in English', () => {
    expect(
      formatHandText(pokerbase, { link: 'https://smallblind.app/hand/abc' }),
    ).toBe(
      [
        'SmallBlind Hand · 5,000/10,000 NLHE 9-max · 2026-08-29',
        'Hero UTG+1 1,200,000 A♦A♣',
        'Preflop: ante 10,000 · SB 5,000 · BB 10,000 · UTG raises to 22,000 · UTG+1 raises to 65,000 · 7 folds · UTG calls 65,000',
        'Flop 8♦4♦3♥ (pot 155,000): UTG checks · UTG+1 bets 50,000 · UTG calls 50,000',
        'Turn 5♥ (pot 255,000): UTG bets 110,000 · UTG+1 calls 110,000',
        'River T♦ (pot 475,000): UTG bets 375,000 · UTG+1 calls 375,000',
        'Result: UTG wins 1,225,000 — Three of a Kind',
        'https://smallblind.app/hand/abc',
      ].join('\n'),
    )
  })

  it('renders the same hand in Korean', () => {
    const text = formatHandText(pokerbase, { locale: 'ko' })

    expect(text.split('\n')[0]).toBe(
      'SmallBlind 핸드 · 5,000/10,000 NLHE 9맥스 · 2026-08-29',
    )
    expect(text).toContain('프리플랍: 앤티 10,000 · SB 5,000 · BB 10,000')
    expect(text).toContain('7명 폴드')
    expect(text).toContain('결과: UTG 1,225,000 승리 — 트립스')
  })

  it('accepts injected label overrides', () => {
    const text = formatHandText(loadFixture('fold-out-uncalled-bet'), {
      labels: {
        title: 'Hand',
        actions: { ...EN_LABELS.actions, manyFolds: '{n}명 다이' },
      },
    })

    expect(text.startsWith('Hand · ')).toBe(true)
    expect(text).toContain('5명 다이')
  })

  it('prefixes amounts with the currency symbol', () => {
    const text = formatHandText(loadFixture('preflop-3way-sidepot'))

    expect(text).toContain('$5/$10')
    expect(text).toContain('$300')
  })
})
