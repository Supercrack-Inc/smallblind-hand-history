import { describe, expect, it } from 'vitest'

import {
  CARD_RANKS,
  CARD_SUITS,
  cardFromNativeId,
  cardKey,
  cardLabel,
  cardToNativeId,
  createDeck,
  createSeededRandom,
  deckWithout,
  parseCard,
  seedFromText,
  uniqueCards,
} from '../src/cards'

function cards(value: string) {
  return value.split(/\s+/).map(parseCard)
}

describe('poker cards', () => {
  it('builds a unique 52-card deck', () => {
    const deck = createDeck()
    expect(deck).toHaveLength(52)
    expect(new Set(deck.map(cardKey)).size).toBe(52)
  })

  it('removes known cards from the deck and rejects duplicates', () => {
    const known = cards('As Kh Qd')
    const remaining = deckWithout(known)

    expect(remaining).toHaveLength(49)
    known.forEach((card) => {
      expect(remaining.map(cardKey)).not.toContain(cardKey(card))
    })
    expect(() => deckWithout(cards('As As'))).toThrow('Cards must be unique')
  })

  it('round-trips every card through parseCard and cardKey', () => {
    for (const rank of CARD_RANKS) {
      for (const suit of CARD_SUITS) {
        const card = { rank, suit }
        expect(parseCard(cardKey(card))).toEqual(card)
      }
    }
  })

  it('round-trips every card through the native id', () => {
    for (const card of createDeck()) {
      const id = cardToNativeId(card)
      expect(id).toBeGreaterThanOrEqual(0)
      expect(id).toBeLessThan(52)
      expect(cardFromNativeId(id)).toEqual(card)
    }
  })

  it('rejects invalid card text and native ids', () => {
    expect(() => parseCard('Xs')).toThrow('Invalid card: Xs')
    expect(() => parseCard('Az')).toThrow('Invalid card: Az')
    expect(() => cardFromNativeId(52)).toThrow('Invalid native card ID: 52')
    expect(() => cardFromNativeId(-1)).toThrow('Invalid native card ID: -1')
  })

  it('accepts lower-case rank and upper-case suit input', () => {
    expect(parseCard('tH')).toEqual({ rank: 'T', suit: 'hearts' })
  })

  it('labels cards with suit symbols', () => {
    expect(cardLabel(parseCard('Ah'))).toBe('A♥')
    expect(cardLabel(parseCard('Ts'))).toBe('T♠')
  })

  it('detects duplicate cards', () => {
    expect(uniqueCards(cards('As Kh'))).toBe(true)
    expect(uniqueCards(cards('As As'))).toBe(false)
  })

  it('produces a deterministic random stream from a text seed', () => {
    const seed = seedFromText('smallblind')
    const first = createSeededRandom(seed)
    const second = createSeededRandom(seed)
    const drawA = [first(), first(), first()]
    const drawB = [second(), second(), second()]

    expect(drawA).toEqual(drawB)
    drawA.forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    })
  })
})
