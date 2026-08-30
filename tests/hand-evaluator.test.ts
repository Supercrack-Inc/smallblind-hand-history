import { describe, expect, it } from 'vitest'

import { parseCard } from '../src/cards'
import {
  compareHandScores,
  evaluateBestHand,
  evaluateFiveCardHand,
  HandCategory,
  rankValue,
} from '../src/hand-evaluator'

function cards(value: string) {
  return value.split(/\s+/).map(parseCard)
}

describe('Texas Hold’em hand evaluator', () => {
  it.each([
    ['As Kd 9c 6h 3s', HandCategory.HighCard],
    ['As Ad Kc 9h 3s', HandCategory.OnePair],
    ['As Ad Kc Kh 3s', HandCategory.TwoPair],
    ['As Ad Ah Kc 3s', HandCategory.ThreeOfAKind],
    ['9s 8d 7c 6h 5s', HandCategory.Straight],
    ['As Js 8s 5s 2s', HandCategory.Flush],
    ['As Ad Ah Kc Ks', HandCategory.FullHouse],
    ['As Ad Ah Ac Ks', HandCategory.FourOfAKind],
    ['As Ks Qs Js Ts', HandCategory.StraightFlush],
  ])('classifies %s', (value, category) => {
    expect(evaluateFiveCardHand(cards(value)).category).toBe(category)
  })

  it('recognizes an ace-low wheel as five-high', () => {
    const score = evaluateFiveCardHand(cards('As 2d 3c 4h 5s'))
    expect(score.category).toBe(HandCategory.Straight)
    expect(score.kickers).toEqual([5])
  })

  it('uses kickers and pair ranks to break ties', () => {
    const aceKicker = evaluateFiveCardHand(cards('Qs Qd Ac 9h 3s'))
    const kingKicker = evaluateFiveCardHand(cards('Qh Qc Ks 9d 3c'))
    expect(compareHandScores(aceKicker, kingKicker)).toBe(1)

    const lowerTwoPair = evaluateFiveCardHand(cards('As Ad 2c 2h Ks'))
    const higherTwoPair = evaluateFiveCardHand(cards('Ah Ac 3s 3d 2c'))
    expect(compareHandScores(higherTwoPair, lowerTwoPair)).toBe(1)
  })

  it('treats identical hands as a tie', () => {
    expect(
      compareHandScores(
        evaluateFiveCardHand(cards('As Ks Qd Jh 9c')),
        evaluateFiveCardHand(cards('Ah Kh Qc Jd 9s')),
      ),
    ).toBe(0)
  })

  it('selects the best five cards from seven', () => {
    const score = evaluateBestHand(cards('As Ks Qs Js Ts 2d 2c'))
    expect(score).toEqual({
      category: HandCategory.StraightFlush,
      kickers: [14],
    })
  })

  it('evaluates the Pokerbase sample board: 55 beats AA', () => {
    const board = '8d 4d 3h 5h Td'
    const aces = evaluateBestHand(cards(`As Ah ${board}`))
    const fives = evaluateBestHand(cards(`5c 5d ${board}`))

    expect(aces.category).toBe(HandCategory.OnePair)
    expect(fives.category).toBe(HandCategory.ThreeOfAKind)
    expect(compareHandScores(fives, aces)).toBe(1)
  })

  it('rejects hands with the wrong number of cards', () => {
    expect(() => evaluateFiveCardHand(cards('As Ks Qs Js'))).toThrow(
      'A five-card hand is required',
    )
    expect(() => evaluateBestHand(cards('As Ks Qs Js'))).toThrow(
      'Best-hand evaluation requires five to seven cards',
    )
  })

  it('maps ranks to numeric values', () => {
    expect(rankValue('A')).toBe(14)
    expect(rankValue('T')).toBe(10)
    expect(rankValue('2')).toBe(2)
  })
})
