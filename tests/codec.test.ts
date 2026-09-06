import { describe, expect, it } from 'vitest'

import {
  HAND_CODEC_ACTION_TYPE_MAP,
  HAND_CODEC_KEY_MAP,
  HAND_INFLATED_MAX_BYTES,
  HAND_PAYLOAD_MAX_LENGTH,
  HAND_URL_MAX_LENGTH,
  HandCodecError,
  buildHandUrl,
  decodeHand,
  encodeHand,
  expandHand,
  minifyHand,
  parseHandUrl,
} from '../src/codec'
import type { HandRecord } from '../src/types'
import { validateRecord } from '../src/validate'

/** A realistic 9-max cash hand: 9 players, 25 actions, note, venue, showdown. */
const fullHand: HandRecord = {
  v: 1,
  id: '9007199254740993',
  playedAt: 1_756_000_000_000,
  game: 'NLHE',
  currency: 'KRW',
  blinds: { sb: '1000', bb: '2000', ante: '2000', anteType: 'bb' },
  seats: 9,
  button: 4,
  players: [
    { seat: 0, name: 'Mia', stack: '198000' },
    { seat: 1, name: 'Noah', stack: '243500' },
    { seat: 2, name: 'Olivia', stack: '75000' },
    { seat: 3, name: 'Liam', stack: '312000' },
    { seat: 4, name: 'Hero', stack: '204000', cards: 'AhKd', hero: true },
    { seat: 5, name: 'Emma', stack: '96500' },
    { seat: 6, name: 'Ava', stack: '158000' },
    { seat: 7, name: 'Lucas', stack: '121000' },
    { seat: 8, name: 'Sofia', stack: '267500' },
  ],
  actions: [
    { t: 'post', seat: 6, kind: 'ante', amount: '2000' },
    { t: 'post', seat: 5, kind: 'sb', amount: '1000' },
    { t: 'post', seat: 6, kind: 'bb', amount: '2000' },
    { t: 'fold', seat: 7 },
    { t: 'fold', seat: 8 },
    { t: 'raise', seat: 0, to: '5000' },
    { t: 'fold', seat: 1 },
    { t: 'call', seat: 2, amount: '5000' },
    { t: 'fold', seat: 3 },
    { t: 'raise', seat: 4, to: '19000' },
    { t: 'fold', seat: 5 },
    { t: 'fold', seat: 6 },
    { t: 'call', seat: 0, amount: '19000' },
    { t: 'fold', seat: 2 },
    { t: 'street', street: 'flop', cards: 'Kh7d2c' },
    { t: 'check', seat: 0 },
    { t: 'bet', seat: 4, to: '24000' },
    { t: 'call', seat: 0, amount: '24000' },
    { t: 'street', street: 'turn', cards: '9s' },
    { t: 'check', seat: 0 },
    { t: 'bet', seat: 4, to: '58000' },
    { t: 'allin', seat: 0, to: '155000' },
    { t: 'call', seat: 4, amount: '155000' },
    { t: 'street', street: 'river', cards: 'Qc' },
    { t: 'show', seat: 0, cards: '9d9c' },
    { t: 'show', seat: 4, cards: 'AhKd' },
  ],
  board: 'Kh7d2c9sQc',
  note: 'Turn jam was thin against a check-raise range this deep.',
  venue: 'Paradise City Poker Room',
  sessionId: '4410293',
}

/** The smallest complete hand the format allows: heads-up, blinds and a fold. */
const minimalHand: HandRecord = {
  v: 1,
  id: '1',
  playedAt: 1_700_000_000_000,
  game: 'NLHE',
  // Chip-denominated, so every amount stays a whole number of chips.
  currency: '',
  blinds: { sb: '5', bb: '10' },
  seats: 2,
  button: 0,
  players: [
    { seat: 0, stack: '1000' },
    { seat: 1, stack: '1000' },
  ],
  actions: [
    { t: 'post', seat: 0, kind: 'sb', amount: '5' },
    { t: 'post', seat: 1, kind: 'bb', amount: '10' },
    { t: 'fold', seat: 0 },
  ],
}

/** A cash hand in a real currency, to keep sub-unit amounts covered. */
const decimalHand: HandRecord = {
  v: 1,
  id: '2',
  playedAt: 1_700_000_000_000,
  game: 'NLHE',
  currency: 'USD',
  blinds: { sb: '0.5', bb: '1' },
  seats: 2,
  button: 0,
  players: [
    { seat: 0, stack: '100.25' },
    { seat: 1, stack: '100' },
  ],
  actions: [
    { t: 'post', seat: 0, kind: 'sb', amount: '0.5' },
    { t: 'post', seat: 1, kind: 'bb', amount: '1' },
    { t: 'raise', seat: 0, to: '2.5' },
    { t: 'fold', seat: 1 },
  ],
}

/** Encode a deliberately broken record; `encodeHand` itself never validates. */
function encodeRaw(record: unknown): string {
  return encodeHand(record as HandRecord)
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(HandCodecError)
    expect((error as HandCodecError).code).toBe(code)
    return
  }
  throw new Error(`Expected a HandCodecError with code ${code}, but nothing was thrown.`)
}

describe('round trip', () => {
  it('uses fixtures the replay engine accepts outright', () => {
    // Guards the tests below: if a fixture were illegal, every round-trip
    // assertion here would be testing the rejection path by accident.
    expect(validateRecord(fullHand)).toEqual([])
    expect(validateRecord(minimalHand)).toEqual([])
    expect(validateRecord(decimalHand)).toEqual([])
  })

  it('restores sub-unit amounts in a real currency exactly', () => {
    expect(decodeHand(encodeHand(decimalHand))).toEqual(decimalHand)
  })

  it('restores a full 9-max hand exactly', () => {
    expect(decodeHand(encodeHand(fullHand))).toEqual(fullHand)
  })

  it('restores a minimal heads-up hand exactly', () => {
    expect(decodeHand(encodeHand(minimalHand))).toEqual(minimalHand)
  })

  it('round trips through a URL', () => {
    const url = buildHandUrl(fullHand)
    expect(url.startsWith('https://smallblind.app/hand#v1.')).toBe(true)
    expect(parseHandUrl(url)).toEqual(fullHand)
  })

  it('honours a custom base URL', () => {
    const url = buildHandUrl(minimalHand, 'https://example.test/h')
    expect(url).toContain('https://example.test/h#v1.')
    expect(parseHandUrl(url)).toEqual(minimalHand)
  })

  it('round trips non-ASCII notes', () => {
    const hand: HandRecord = {
      ...fullHand,
      note: '턴에서 올인은 과했다 🃏🔥 — 다음엔 체크 뒤 콜.',
      venue: '파라다이스 시티 포커룸',
    }
    expect(decodeHand(encodeHand(hand))).toEqual(hand)
  })

  it('drops optional fields that are absent rather than emitting null', () => {
    const decoded = decodeHand(encodeHand(minimalHand))
    expect('note' in decoded).toBe(false)
    expect('board' in decoded).toBe(false)
    expect('winners' in decoded).toBe(false)
  })

  it('round trips a hand carrying manual winners that match the pots', () => {
    // Seat 0 folds after posting 5, so seat 1's uncalled 5 comes back and the
    // settled pot is 10 — the payout the record has to agree with.
    const hand: HandRecord = {
      ...minimalHand,
      winners: [{ seat: 1, amount: '10' }],
      tournamentName: 'Sunday Major',
    }
    expect(validateRecord(hand)).toEqual([])
    expect(decodeHand(encodeHand(hand))).toEqual(hand)
  })

  it('rejects manual winners that contradict the pots', () => {
    const hand: HandRecord = { ...minimalHand, winners: [{ seat: 1, amount: '15' }] }
    expectCode(() => decodeHand(encodeHand(hand)), 'INVALID_RECORD')
  })

  it('rejects a payout awarded to the player who folded', () => {
    const hand: HandRecord = { ...minimalHand, winners: [{ seat: 0, amount: '10' }] }
    expectCode(() => decodeHand(encodeHand(hand)), 'INVALID_RECORD')
  })
})

describe('payload size', () => {
  it('keeps a full 9-max hand URL under the advisory maximum', () => {
    const url = buildHandUrl(fullHand)
    // Reported so a regression in the key table is visible in the test output.
    console.log(`full 9-max hand URL length: ${url.length} characters`)
    expect(url.length).toBeLessThanOrEqual(HAND_URL_MAX_LENGTH)
    expect(HAND_URL_MAX_LENGTH).toBe(2000)
  })

  it('is smaller than the uncompressed JSON it represents', () => {
    expect(encodeHand(fullHand).length).toBeLessThan(JSON.stringify(fullHand).length)
  })
})

describe('base64url alphabet', () => {
  it('never emits +, / or =', () => {
    for (const hand of [fullHand, minimalHand]) {
      const body = encodeHand(hand).slice('v1.'.length)
      expect(body).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('stays url-safe for a payload with a long non-ASCII note', () => {
    const hand: HandRecord = { ...fullHand, note: '뒤늦은 후회 😵‍💫'.repeat(20) }
    expect(encodeHand(hand).slice('v1.'.length)).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeHand(encodeHand(hand))).toEqual(hand)
  })
})

describe('size limits', () => {
  /** A hand whose minified JSON is exactly `bytes` long, padded through `note`. */
  function handOfExactJsonSize(bytes: number): HandRecord {
    const base = JSON.stringify(minifyHand({ ...minimalHand, note: '' })).length
    const padding = bytes - base
    expect(padding).toBeGreaterThan(0)
    // ASCII only, so JSON character count and UTF-8 byte count are identical.
    return { ...minimalHand, note: 'a'.repeat(padding) }
  }

  it('exports the two hard limits', () => {
    expect(HAND_PAYLOAD_MAX_LENGTH).toBe(8192)
    expect(HAND_INFLATED_MAX_BYTES).toBe(65_536)
  })

  it('accepts a payload that inflates to exactly the limit', () => {
    const hand = handOfExactJsonSize(HAND_INFLATED_MAX_BYTES)
    expect(JSON.stringify(minifyHand(hand)).length).toBe(HAND_INFLATED_MAX_BYTES)
    expect(decodeHand(encodeHand(hand))).toEqual(hand)
  })

  it('rejects a payload that inflates to one byte past the limit', () => {
    const hand = handOfExactJsonSize(HAND_INFLATED_MAX_BYTES + 1)
    expect(JSON.stringify(minifyHand(hand)).length).toBe(HAND_INFLATED_MAX_BYTES + 1)
    expectCode(() => decodeHand(encodeHand(hand)), 'TOO_LARGE')
  })

  it('rejects a compression bomb that the length limit alone would let through', () => {
    // The reported repro: a small URL that expands to about a megabyte.
    const bomb = encodeHand({ ...minimalHand, note: 'a'.repeat(1_000_000) })
    expect(bomb.length).toBeLessThan(HAND_PAYLOAD_MAX_LENGTH)
    expectCode(() => decodeHand(bomb), 'TOO_LARGE')
  })

  it('rejects a far larger bomb without materializing it', () => {
    // About 5 MB unbounded, still under the body limit; the pre-allocated
    // buffer caps the expansion at 64 KiB + 1 bytes.
    const bomb = encodeHand({ ...minimalHand, note: 'a'.repeat(5_000_000) })
    expect(bomb.length).toBeLessThan(HAND_PAYLOAD_MAX_LENGTH)
    const before = process.memoryUsage().heapUsed
    expectCode(() => decodeHand(bomb), 'TOO_LARGE')
    const grown = process.memoryUsage().heapUsed - before
    // Generous slack for test-runner noise, still far below the 10 MB payload.
    expect(grown).toBeLessThan(4_000_000)
  })

  it('rejects an oversized body before it decodes or decompresses it', () => {
    // 'A' repeated is valid base64url, so reaching the decompressor would raise
    // MALFORMED. Getting TOO_LARGE proves the length check runs first.
    const body = 'A'.repeat(HAND_PAYLOAD_MAX_LENGTH + 1)
    expectCode(() => decodeHand(`v1.${body}`), 'TOO_LARGE')
    expectCode(() => decodeHand(`v1.${'A'.repeat(HAND_PAYLOAD_MAX_LENGTH)}`), 'MALFORMED')
  })

  it('rejects an oversized fragment through parseHandUrl too', () => {
    const bomb = buildHandUrl({ ...minimalHand, note: 'a'.repeat(1_000_000) })
    expectCode(() => parseHandUrl(bomb), 'TOO_LARGE')
  })

  it('leaves a realistic 9-max hand well inside both limits', () => {
    const body = encodeHand(fullHand).slice('v1.'.length)
    expect(body.length).toBeLessThan(HAND_PAYLOAD_MAX_LENGTH)
    expect(JSON.stringify(minifyHand(fullHand)).length).toBeLessThan(HAND_INFLATED_MAX_BYTES)
    expect(decodeHand(encodeHand(fullHand))).toEqual(fullHand)
  })
})

describe('errors', () => {
  it('rejects a future format version', () => {
    expectCode(() => decodeHand(`v3.${encodeHand(fullHand).slice(3)}`), 'UNSUPPORTED_VERSION')
  })

  it('rejects a payload with no version prefix', () => {
    expectCode(() => decodeHand('AAAA'), 'MALFORMED')
  })

  it('rejects an empty payload and an empty body', () => {
    expectCode(() => decodeHand(''), 'MALFORMED')
    expectCode(() => decodeHand('v1.'), 'MALFORMED')
  })

  it('rejects non-base64url characters', () => {
    expectCode(() => decodeHand('v1.abc!def'), 'MALFORMED')
    expectCode(() => decodeHand('v1.abcd+efg'), 'MALFORMED')
  })

  it('rejects base64url that does not inflate', () => {
    expectCode(() => decodeHand('v1.AAAAAAAAAAAA'), 'MALFORMED')
  })

  it('rejects a URL without a fragment', () => {
    expectCode(() => parseHandUrl('https://smallblind.app/hand'), 'MALFORMED')
  })

  it('rejects a record missing a required field', () => {
    for (const field of ['id', 'actions', 'players', 'blinds', 'button', 'seats']) {
      const partial: Record<string, unknown> = { ...fullHand }
      delete partial[field]
      expectCode(() => decodeHand(encodeRaw(partial)), 'INVALID_RECORD')
    }
  })

  it('rejects a seat outside the table', () => {
    const badPlayer = { ...fullHand, players: [...fullHand.players, { seat: 9, stack: '1000' }] }
    expectCode(() => decodeHand(encodeRaw(badPlayer)), 'INVALID_RECORD')

    const badAction = {
      ...fullHand,
      actions: [...fullHand.actions, { t: 'fold', seat: 12 }],
    }
    expectCode(() => decodeHand(encodeRaw(badAction)), 'INVALID_RECORD')

    expectCode(() => decodeHand(encodeRaw({ ...fullHand, button: 9 })), 'INVALID_RECORD')
  })

  it('rejects amounts that are not plain decimals', () => {
    for (const amount of ['1e5', '-100', '1,000', '', '0x10', '1.']) {
      const hand = { ...fullHand, blinds: { ...fullHand.blinds, sb: amount } }
      expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
    }
  })

  it('rejects numeric amounts', () => {
    const hand = { ...fullHand, blinds: { ...fullHand.blinds, bb: 2000 } }
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('rejects malformed card strings', () => {
    for (const cards of ['1x', 'Ah7', 'AH7D', 'Ahx', '']) {
      const hand = {
        ...fullHand,
        players: fullHand.players.map((player) =>
          player.seat === 4 ? { ...player, cards } : player,
        ),
      }
      expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
    }
  })

  it('rejects a card dealt twice', () => {
    const hand: HandRecord = {
      ...minimalHand,
      players: [
        { seat: 0, stack: '100', cards: 'AhAh' },
        { seat: 1, stack: '100' },
      ],
    }
    expectCode(() => decodeHand(encodeHand(hand)), 'INVALID_RECORD')
  })

  it('rejects an unknown action type and a bad action shape', () => {
    expectCode(
      () => decodeHand(encodeRaw({ ...fullHand, actions: [{ t: 'dance', seat: 0 }] })),
      'INVALID_RECORD',
    )
    expectCode(
      () => decodeHand(encodeRaw({ ...fullHand, actions: [{ t: 'bet', seat: 0 }] })),
      'INVALID_RECORD',
    )
    expectCode(
      () =>
        decodeHand(
          encodeRaw({ ...fullHand, actions: [{ t: 'street', street: 'fifth', cards: 'Kh7d2c' }] }),
        ),
      'INVALID_RECORD',
    )
    expectCode(
      () =>
        decodeHand(
          encodeRaw({ ...fullHand, actions: [{ t: 'post', seat: 0, kind: 'x', amount: '1' }] }),
        ),
      'INVALID_RECORD',
    )
  })

  it('rejects a wrong record version inside the envelope', () => {
    expectCode(() => decodeHand(encodeRaw({ ...fullHand, v: 2 }).replace('v2.', 'v1.')), 'INVALID_RECORD')
  })

  it('rejects out-of-range table sizes and non-integer timestamps', () => {
    expectCode(() => decodeHand(encodeRaw({ ...fullHand, seats: 11 })), 'INVALID_RECORD')
    expectCode(() => decodeHand(encodeRaw({ ...fullHand, seats: 1 })), 'INVALID_RECORD')
    expectCode(() => decodeHand(encodeRaw({ ...fullHand, playedAt: 1.5 })), 'INVALID_RECORD')
    expectCode(() => decodeHand(encodeRaw({ ...fullHand, game: 'PLO' })), 'INVALID_RECORD')
    expectCode(() => decodeHand(encodeRaw({ ...fullHand, players: [] })), 'INVALID_RECORD')
  })

  it('reports HandCodecError as a real Error with a name and code', () => {
    const error = new HandCodecError('MALFORMED', 'boom')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('HandCodecError')
    expect(error.message).toBe('boom')
  })
})

describe('impossible hands', () => {
  // Every record below is shape-valid: correct types, ranges and patterns.
  // Only the static poker rules catch them, so these cases prove decodeHand
  // runs validateRecordStatic and does not hand back nonsense.

  it('rejects two players in the same seat', () => {
    const hand = {
      ...minimalHand,
      seats: 3,
      players: [
        { seat: 0, stack: '100' },
        { seat: 0, stack: '100' },
      ],
    }
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('rejects a button on an empty seat', () => {
    const hand = {
      ...minimalHand,
      seats: 4,
      button: 3,
      players: [
        { seat: 0, stack: '100' },
        { seat: 1, stack: '100' },
      ],
    }
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('rejects the same card held by two players', () => {
    const hand = {
      ...minimalHand,
      players: [
        { seat: 0, stack: '100', cards: 'AhKd' },
        { seat: 1, stack: '100', cards: 'AhQs' },
      ],
    }
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('rejects a card that appears in a hand and on the board', () => {
    const hand = {
      ...fullHand,
      board: 'AhKh7d2c9s',
      actions: fullHand.actions.filter((action) => action.t !== 'street'),
    }
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('rejects a one-card board', () => {
    const hand = {
      ...minimalHand,
      board: 'Kh',
    }
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('rejects a two-card board', () => {
    expectCode(() => decodeHand(encodeRaw({ ...minimalHand, board: 'Kh7d' })), 'INVALID_RECORD')
  })

  it('rejects more players than the table has seats', () => {
    const hand = {
      ...minimalHand,
      seats: 2,
      players: [
        { seat: 0, stack: '100' },
        { seat: 1, stack: '100' },
        { seat: 1, stack: '100' },
      ],
    }
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('rejects a non-positive stack', () => {
    const hand = {
      ...minimalHand,
      players: [
        { seat: 0, stack: '0' },
        { seat: 1, stack: '100' },
      ],
    }
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('names the failing validation code in the error message', () => {
    const hand = {
      ...minimalHand,
      seats: 3,
      players: [
        { seat: 0, stack: '100' },
        { seat: 0, stack: '100' },
      ],
    }
    try {
      decodeHand(encodeRaw(hand))
      throw new Error('Expected decodeHand to reject a duplicated seat.')
    } catch (error) {
      expect(error).toBeInstanceOf(HandCodecError)
      const message = (error as HandCodecError).message
      expect(message).toContain('[duplicate-seat]')
      expect(message.length).toBeGreaterThan('[duplicate-seat]'.length + 10)
    }
  })

  it('still accepts the two well-formed fixtures', () => {
    expect(decodeHand(encodeHand(fullHand))).toEqual(fullHand)
    expect(decodeHand(encodeHand(minimalHand))).toEqual(minimalHand)
  })
})

describe('action semantics', () => {
  /** Heads-up 5/10, button on seat 0, both stacks deep. */
  const headsUp = (actions: HandRecord['actions']): HandRecord => ({
    v: 1,
    id: '77',
    playedAt: 1_756_000_000_000,
    game: 'NLHE',
    currency: 'USD',
    blinds: { sb: '5', bb: '10' },
    seats: 2,
    button: 0,
    players: [
      { seat: 0, stack: '1000', cards: 'AhKd', hero: true },
      { seat: 1, stack: '1000' },
    ],
    actions,
  })

  const blindsPosted: HandRecord['actions'] = [
    { t: 'post', seat: 0, kind: 'sb', amount: '5' },
    { t: 'post', seat: 1, kind: 'bb', amount: '10' },
  ]

  it('rejects calls for more than the chips actually owed', () => {
    // The reported repro: 5/10 heads-up where both sides "call 100". The owed
    // amount is 10. Static checks pass — only the replay catches it, and an
    // unchecked record would have the engine settle a 200 pot.
    const hand = headsUp([
      ...blindsPosted,
      { t: 'call', seat: 0, amount: '100' },
      { t: 'call', seat: 1, amount: '100' },
    ])
    // Pinned so a change that reclassified this as a tolerated code would fail
    // here rather than quietly reopen the hole.
    expect(validateRecord(hand).map((problem) => problem.code)).toEqual(['illegal-amount'])
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('accepts the same hand with the correct call amount', () => {
    const hand = headsUp([
      ...blindsPosted,
      { t: 'call', seat: 0, amount: '10' },
      { t: 'check', seat: 1 },
      { t: 'street', street: 'flop', cards: '8d4d3h' },
      { t: 'check', seat: 1 },
      { t: 'check', seat: 0 },
    ])
    // Unfinished after the flop checks through, which decodeHand tolerates.
    expect(decodeHand(encodeHand(hand))).toEqual(hand)
  })

  it('rejects an out-of-turn action', () => {
    const hand = headsUp([
      ...blindsPosted,
      // Seat 0 is to act preflop; seat 1 jumps the queue.
      { t: 'check', seat: 1 },
      { t: 'call', seat: 0, amount: '10' },
    ])
    expect(validateRecord(hand).map((problem) => problem.code)).toEqual(['not-your-turn'])
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('rejects a raise below the minimum', () => {
    const hand = headsUp([...blindsPosted, { t: 'raise', seat: 0, to: '12' }])
    expect(validateRecord(hand).map((problem) => problem.code)).toEqual(['illegal-amount'])
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('rejects a bet larger than the stack behind', () => {
    const hand = headsUp([
      ...blindsPosted,
      { t: 'call', seat: 0, amount: '10' },
      { t: 'check', seat: 1 },
      { t: 'street', street: 'flop', cards: '8d4d3h' },
      { t: 'bet', seat: 1, to: '5000' },
    ])
    expect(validateRecord(hand).map((problem) => problem.code)).toEqual(['illegal-amount'])
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('rejects a check when chips are owed', () => {
    const hand = headsUp([...blindsPosted, { t: 'check', seat: 0 }])
    expect(validateRecord(hand).map((problem) => problem.code)).toEqual(['illegal-action'])
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('accepts a hand that stops at the decision point', () => {
    // Sharing a spot mid-street is the whole point of these URLs.
    const hand = headsUp([
      ...blindsPosted,
      { t: 'raise', seat: 0, to: '30' },
      { t: 'call', seat: 1, amount: '30' },
      { t: 'street', street: 'flop', cards: '8d4d3h' },
      { t: 'check', seat: 1 },
      { t: 'bet', seat: 0, to: '45' },
    ])
    expect(validateRecord(hand).map((problem) => problem.code)).toEqual(['street-not-closed'])
    expect(decodeHand(encodeHand(hand))).toEqual(hand)
  })

  it('rejects an unfinished hand that smuggles in a payout', () => {
    // validateRecord stops at street-not-closed and returns before it ever
    // compares winners, so tolerating that code on its own would let an
    // invented payout ride along on a hand that never finished.
    const unfinished = headsUp([
      ...blindsPosted,
      { t: 'raise', seat: 0, to: '30' },
      { t: 'call', seat: 1, amount: '30' },
      { t: 'street', street: 'flop', cards: '8d4d3h' },
      { t: 'check', seat: 1 },
      { t: 'bet', seat: 0, to: '45' },
    ])
    const withPayout: HandRecord = { ...unfinished, winners: [{ seat: 0, amount: '999' }] }
    // The engine still reports only street-not-closed; the codec is what refuses.
    expect(validateRecord(withPayout).map((problem) => problem.code)).toEqual(['street-not-closed'])
    expectCode(() => decodeHand(encodeRaw(withPayout)), 'INVALID_RECORD')

    // A plausible-looking payout is refused just the same — an unfinished hand
    // has no settled pot to award.
    const plausible: HandRecord = { ...unfinished, winners: [{ seat: 0, amount: '30' }] }
    expectCode(() => decodeHand(encodeRaw(plausible)), 'INVALID_RECORD')

    // ...while the same hand without winners still decodes.
    expect(decodeHand(encodeHand(unfinished))).toEqual(unfinished)
  })

  it('tolerates an empty winners array on an unfinished hand', () => {
    const hand: HandRecord = {
      ...headsUp([
        ...blindsPosted,
        { t: 'raise', seat: 0, to: '30' },
        { t: 'call', seat: 1, amount: '30' },
        { t: 'street', street: 'flop', cards: '8d4d3h' },
        { t: 'check', seat: 1 },
        { t: 'bet', seat: 0, to: '45' },
      ]),
      winners: [],
    }
    expect(decodeHand(encodeHand(hand))).toEqual(hand)
  })

  it('rejects an unknown-cards showdown that also declares a payout', () => {
    const hand: HandRecord = {
      ...headsUp([
        ...blindsPosted,
        { t: 'raise', seat: 0, to: '30' },
        { t: 'call', seat: 1, amount: '30' },
        { t: 'street', street: 'flop', cards: '8d4d3h' },
        { t: 'check', seat: 1 },
        { t: 'check', seat: 0 },
        { t: 'street', street: 'turn', cards: '5h' },
        { t: 'check', seat: 1 },
        { t: 'check', seat: 0 },
        { t: 'street', street: 'river', cards: 'Td' },
        { t: 'check', seat: 1 },
        { t: 'check', seat: 0 },
      ]),
      board: '8d4d3h5hTd',
      winners: [{ seat: 0, amount: '999' }],
    }
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('accepts a showdown with unknown villain cards and no winners recorded', () => {
    const hand: HandRecord = {
      ...headsUp([
        ...blindsPosted,
        { t: 'raise', seat: 0, to: '30' },
        { t: 'call', seat: 1, amount: '30' },
        { t: 'street', street: 'flop', cards: '8d4d3h' },
        { t: 'check', seat: 1 },
        { t: 'check', seat: 0 },
        { t: 'street', street: 'turn', cards: '5h' },
        { t: 'check', seat: 1 },
        { t: 'check', seat: 0 },
        { t: 'street', street: 'river', cards: 'Td' },
        { t: 'check', seat: 1 },
        { t: 'check', seat: 0 },
      ]),
      board: '8d4d3h5hTd',
    }
    // Seat 1's cards are unknown, so the engine cannot settle the showdown on
    // its own; that is a hand worth sharing, not a broken record.
    expect(validateRecord(hand).map((problem) => problem.code)).toEqual(['bad-winners'])
    expect(decodeHand(encodeHand(hand))).toEqual(hand)
  })

  it('still rejects a contradictory payout on such a hand', () => {
    const base = headsUp([
      ...blindsPosted,
      { t: 'raise', seat: 0, to: '30' },
      { t: 'call', seat: 1, amount: '30' },
      { t: 'street', street: 'flop', cards: '8d4d3h' },
      { t: 'check', seat: 1 },
      { t: 'check', seat: 0 },
      { t: 'street', street: 'turn', cards: '5h' },
      { t: 'check', seat: 1 },
      { t: 'check', seat: 0 },
      { t: 'street', street: 'river', cards: 'Td' },
      { t: 'check', seat: 1 },
      { t: 'check', seat: 0 },
    ])
    const hand: HandRecord = {
      ...base,
      board: '8d4d3h5hTd',
      winners: [{ seat: 0, amount: '999' }],
    }
    expectCode(() => decodeHand(encodeRaw(hand)), 'INVALID_RECORD')
  })

  it('names the failing code and step in the error message', () => {
    const hand = headsUp([
      ...blindsPosted,
      { t: 'call', seat: 0, amount: '100' },
      { t: 'call', seat: 1, amount: '100' },
    ])
    try {
      decodeHand(encodeRaw(hand))
      throw new Error('Expected decodeHand to reject an impossible call.')
    } catch (error) {
      expect(error).toBeInstanceOf(HandCodecError)
      const message = (error as HandCodecError).message
      expect(message).toMatch(/^Record is not a valid hand \[[a-z-]+] at step 2: /)
    }
  })
})

describe('key table', () => {
  it('maps every long key to a unique short key', () => {
    const shorts = Object.values(HAND_CODEC_KEY_MAP)
    expect(new Set(shorts).size).toBe(shorts.length)
    for (const short of shorts) expect(short.length).toBeLessThanOrEqual(2)
  })

  it('maps every action type to a unique single character', () => {
    const shorts = Object.values(HAND_CODEC_ACTION_TYPE_MAP)
    expect(new Set(shorts).size).toBe(shorts.length)
    for (const short of shorts) expect(short).toHaveLength(1)
  })

  it('covers every action type in the union', () => {
    const seen = new Set(fullHand.actions.map((action) => action.t))
    seen.add('allin')
    for (const type of seen) expect(HAND_CODEC_ACTION_TYPE_MAP[type]).toBeDefined()
    expect(Object.keys(HAND_CODEC_ACTION_TYPE_MAP).sort()).toEqual(
      ['allin', 'bet', 'call', 'check', 'fold', 'muck', 'post', 'raise', 'show', 'street'].sort(),
    )
  })

  it('minify and expand are inverse operations', () => {
    for (const hand of [fullHand, minimalHand]) {
      expect(expandHand(minifyHand(hand))).toEqual(hand)
    }
  })

  it('minified output uses only short keys at the top level', () => {
    const minified = minifyHand(fullHand)
    for (const key of Object.keys(minified)) {
      expect(key.length).toBeLessThanOrEqual(2)
    }
    expect(minified[HAND_CODEC_KEY_MAP['playedAt'] as string]).toBe(fullHand.playedAt)
    expect(Array.isArray(minified[HAND_CODEC_KEY_MAP['actions'] as string])).toBe(true)
  })

  it('minifies action types to single characters', () => {
    const minified = minifyHand(minimalHand) as Record<string, Array<Record<string, unknown>>>
    const actions = minified[HAND_CODEC_KEY_MAP['actions'] as string] as Array<
      Record<string, unknown>
    >
    expect(actions[0]?.[HAND_CODEC_KEY_MAP['t'] as string]).toBe('P')
    expect(actions[1]?.[HAND_CODEC_KEY_MAP['t'] as string]).toBe('P')
    expect(actions[2]?.[HAND_CODEC_KEY_MAP['t'] as string]).toBe('F')
  })
})
