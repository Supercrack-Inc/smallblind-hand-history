import { CARD_RANK_VALUES, type Card, type CardRank } from './cards'

export enum HandCategory {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
}

export type HandScore = Readonly<{
  category: HandCategory
  kickers: readonly number[]
}>

function straightHighCard(ranks: readonly number[]) {
  const unique = [...new Set(ranks)].sort((left, right) => right - left)

  if (unique[0] === 14) {
    unique.push(1)
  }

  for (let index = 0; index <= unique.length - 5; index += 1) {
    if (unique[index]! - unique[index + 4]! === 4) {
      return unique[index]!
    }
  }

  return undefined
}

export function evaluateFiveCardHand(cards: readonly Card[]): HandScore {
  if (cards.length !== 5) {
    throw new Error('A five-card hand is required')
  }

  const ranks = cards.map((card) => CARD_RANK_VALUES[card.rank])
  const rankCounts = new Map<number, number>()

  ranks.forEach((rank) => {
    rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1)
  })

  const groups = [...rankCounts.entries()].sort(
    ([leftRank, leftCount], [rightRank, rightCount]) =>
      rightCount - leftCount || rightRank - leftRank,
  )
  const isFlush = cards.every((card) => card.suit === cards[0]!.suit)
  const straightHigh = straightHighCard(ranks)

  if (isFlush && straightHigh != null) {
    return {
      category: HandCategory.StraightFlush,
      kickers: [straightHigh],
    }
  }

  if (groups[0]![1] === 4) {
    return {
      category: HandCategory.FourOfAKind,
      kickers: [groups[0]![0], groups[1]![0]],
    }
  }

  if (groups[0]![1] === 3 && groups[1]?.[1] === 2) {
    return {
      category: HandCategory.FullHouse,
      kickers: [groups[0]![0], groups[1][0]],
    }
  }

  const descendingRanks = [...ranks].sort((left, right) => right - left)

  if (isFlush) {
    return {
      category: HandCategory.Flush,
      kickers: descendingRanks,
    }
  }

  if (straightHigh != null) {
    return {
      category: HandCategory.Straight,
      kickers: [straightHigh],
    }
  }

  if (groups[0]![1] === 3) {
    return {
      category: HandCategory.ThreeOfAKind,
      kickers: [
        groups[0]![0],
        ...groups
          .slice(1)
          .map(([rank]) => rank)
          .sort((left, right) => right - left),
      ],
    }
  }

  const pairs = groups
    .filter(([, count]) => count === 2)
    .map(([rank]) => rank)
    .sort((left, right) => right - left)

  if (pairs.length >= 2) {
    const kicker = groups.find(([, count]) => count === 1)?.[0]
    return {
      category: HandCategory.TwoPair,
      kickers: [pairs[0]!, pairs[1]!, kicker ?? 0],
    }
  }

  if (pairs.length === 1) {
    return {
      category: HandCategory.OnePair,
      kickers: [
        pairs[0]!,
        ...groups
          .filter(([, count]) => count === 1)
          .map(([rank]) => rank)
          .sort((left, right) => right - left),
      ],
    }
  }

  return {
    category: HandCategory.HighCard,
    kickers: descendingRanks,
  }
}

export function compareHandScores(left: HandScore, right: HandScore) {
  if (left.category !== right.category) {
    return left.category > right.category ? 1 : -1
  }

  const length = Math.max(left.kickers.length, right.kickers.length)

  for (let index = 0; index < length; index += 1) {
    const leftValue = left.kickers[index] ?? 0
    const rightValue = right.kickers[index] ?? 0

    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1
    }
  }

  return 0
}

export function evaluateBestHand(cards: readonly Card[]): HandScore {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error('Best-hand evaluation requires five to seven cards')
  }

  let best: HandScore | undefined

  for (let first = 0; first < cards.length - 4; first += 1) {
    for (let second = first + 1; second < cards.length - 3; second += 1) {
      for (let third = second + 1; third < cards.length - 2; third += 1) {
        for (let fourth = third + 1; fourth < cards.length - 1; fourth += 1) {
          for (let fifth = fourth + 1; fifth < cards.length; fifth += 1) {
            const score = evaluateFiveCardHand([
              cards[first]!,
              cards[second]!,
              cards[third]!,
              cards[fourth]!,
              cards[fifth]!,
            ])

            if (!best || compareHandScores(score, best) > 0) {
              best = score
            }
          }
        }
      }
    }
  }

  if (!best) {
    throw new Error('Unable to evaluate hand')
  }

  return best
}

export function rankValue(rank: CardRank) {
  return CARD_RANK_VALUES[rank]
}
