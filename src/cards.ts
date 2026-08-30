export const CARD_RANKS = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'T',
  'J',
  'Q',
  'K',
  'A',
] as const

export const CARD_SUITS = ['spades', 'hearts', 'diamonds', 'clubs'] as const
const CARD_SUITS_BY_NATIVE_INDEX = [
  'clubs',
  'diamonds',
  'hearts',
  'spades',
] as const

export type CardRank = (typeof CARD_RANKS)[number]
export type CardSuit = (typeof CARD_SUITS)[number]

export type Card = Readonly<{
  rank: CardRank
  suit: CardSuit
}>

export const CARD_SUIT_SYMBOLS: Record<CardSuit, string> = {
  spades: '♠',
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
}

const SUIT_CODES: Record<CardSuit, string> = {
  spades: 's',
  hearts: 'h',
  diamonds: 'd',
  clubs: 'c',
}

const SUITS_BY_CODE: Record<string, CardSuit> = {
  s: 'spades',
  h: 'hearts',
  d: 'diamonds',
  c: 'clubs',
}

export const CARD_RANK_VALUES: Record<CardRank, number> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
}

export function cardKey(card: Card) {
  return `${card.rank}${SUIT_CODES[card.suit]}`
}

export function cardLabel(card: Card) {
  return `${card.rank}${CARD_SUIT_SYMBOLS[card.suit]}`
}

export function cardToNativeId(card: Card) {
  return (
    CARD_RANKS.indexOf(card.rank) * 4 +
    CARD_SUITS_BY_NATIVE_INDEX.indexOf(card.suit)
  )
}

export function cardFromNativeId(id: number): Card {
  if (!Number.isInteger(id) || id < 0 || id >= 52) {
    throw new Error(`Invalid native card ID: ${id}`)
  }

  return {
    rank: CARD_RANKS[Math.floor(id / 4)]!,
    suit: CARD_SUITS_BY_NATIVE_INDEX[id % 4]!,
  }
}

export function parseCard(value: string): Card {
  const rank = value.slice(0, -1).toUpperCase()
  const suit = SUITS_BY_CODE[value.slice(-1).toLowerCase()]

  if (!CARD_RANKS.includes(rank as CardRank) || !suit) {
    throw new Error(`Invalid card: ${value}`)
  }

  return { rank: rank as CardRank, suit }
}

export function createDeck(): Card[] {
  return CARD_SUITS.flatMap((suit) =>
    CARD_RANKS.map((rank) => ({ rank, suit })),
  )
}

export function uniqueCards(cards: readonly Card[]) {
  return new Set(cards.map(cardKey)).size === cards.length
}

export function assertUniqueCards(cards: readonly Card[]) {
  if (!uniqueCards(cards)) {
    throw new Error('Cards must be unique')
  }
}

export function deckWithout(cards: readonly Card[]) {
  assertUniqueCards(cards)
  const excluded = new Set(cards.map(cardKey))
  return createDeck().filter((card) => !excluded.has(cardKey(card)))
}

export function seedFromText(value: string) {
  let hash = 2166136261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

export function createSeededRandom(seed: number) {
  let state = seed >>> 0

  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
