import { describe, expect, it } from 'vitest'
import {
  applyAction, assertHandRecord, decodeHand, encodeHand, finalStacks,
  formatHandText, initialState, replay, replayAll, validateAction, validateRecord,
  type HandRecord,
} from '../src/index'

function hand(): HandRecord {
  return {
    v: 2, id: '1', playedAt: 1788645731000, game: 'NLHE', currency: '',
    seats: 2, button: 0, blinds: { sb: '50', bb: '100' },
    players: [
      { seat: 0, stack: '1000', hero: true, cards: 'AsAd' },
      { seat: 1, stack: '1000', cards: 'KhKd' },
    ],
    actions: [
      { t: 'post', seat: 0, kind: 'sb', amount: '50' },
      { t: 'post', seat: 1, kind: 'bb', amount: '100' },
      { t: 'allin', seat: 0, to: '1000' },
      { t: 'call', seat: 1, amount: '1000' },
      { t: 'street', street: 'flop', cards: '2h4s8c' },
      { t: 'street', street: 'turn', cards: '9d' },
      { t: 'street', street: 'river', cards: 'Tc' },
    ],
    board: '2h4s8c9dTc',
  }
}
const live = (record: HandRecord) => record.actions.reduce(
  (state, action) => applyAction(state, action, record), initialState(record),
)

describe('v2 showdown discards', () => {
  it('preserves the stronger original cards but awards the shown opponent, including manual confirmation', () => {
    const record = hand()
    record.actions.push({ t: 'show', seat: 1, cards: 'KhKd' }, { t: 'muck', seat: 0 })
    record.winners = [{ seat: 1, amount: '2000' }]
    expect(validateRecord(record)).toEqual([])
    const state = replay(record)
    expect(state.result?.winners).toEqual([{ seat: 1, amount: '2000', handName: 'Pair' }])
    expect(state.result?.net).toEqual({ 0: '-1000', 1: '1000' })
    expect(finalStacks(state)).toEqual({ 0: '0', 1: '2000' })
    expect(record.players[0]!.cards).toBe('AsAd')
    expect(state.mucked).toEqual([0])
    expect(state.revealed).toEqual({ 1: 'KhKd' })
    expect(formatHandText(record)).toContain('mucks')
    expect(formatHandText(record, { locale: 'ko' })).toContain('머크')
    expect(validateRecord({ ...record, winners: [{ seat: 0, amount: '2000' }] })[0]?.code).toBe('bad-winners')
  })

  it('undo and playback restore eligibility at the actual discard step', () => {
    const record = hand()
    record.actions.push({ t: 'show', seat: 1, cards: 'KhKd' }, { t: 'muck', seat: 0 })
    const states = replayAll(record)
    expect(states[states.length - 2]?.mucked).toEqual([])
    expect(states[states.length - 1]?.mucked).toEqual([0])
    record.actions.pop()
    expect(replay(record).result?.winners[0]?.seat).toBe(0)
  })

  it('settles unknown last hands by discard order without creating or losing chips', () => {
    for (const order of [[0, 1], [1, 0]]) {
      const record = hand()
      record.players.forEach((player) => { delete player.cards })
      record.actions.push(...order.map((seat) => ({ t: 'muck' as const, seat })))
      expect(validateRecord(record)).toEqual([])
      expect(replay(record).result?.winners).toEqual([{ seat: order[1], amount: '2000' }])
    }
  })

  it('retains an uncontested side pot when its last claimant later discards the main pot', () => {
    const record: HandRecord = {
      ...hand(), seats: 3, button: 2,
      players: [
        { seat: 0, stack: '300', cards: 'AsAd' },
        { seat: 1, stack: '300', cards: 'KhKd' },
        { seat: 2, stack: '100', cards: 'QhQd' },
      ],
      actions: [
        { t: 'post', seat: 0, kind: 'sb', amount: '50' },
        { t: 'post', seat: 1, kind: 'bb', amount: '100' },
        { t: 'allin', seat: 2, to: '100' },
        { t: 'allin', seat: 0, to: '300' },
        { t: 'call', seat: 1, amount: '300' },
        ...hand().actions.slice(4),
        { t: 'muck', seat: 0 }, { t: 'muck', seat: 1 },
        { t: 'show', seat: 2, cards: 'QhQd' },
      ],
    }
    expect(validateRecord(record)).toEqual([])
    expect(replay(record).pots).toEqual([
      { amount: '300', eligible: [2] }, { amount: '400', eligible: [1] },
    ])
    expect(replay(record).result?.winners).toEqual([
      { seat: 1, amount: '400' }, { seat: 2, amount: '300', handName: 'Pair' },
    ])
  })

  it('splits an odd pot among the remaining tied hands in button order', () => {
    const record: HandRecord = {
      ...hand(), seats: 3, button: 2, blinds: { sb: '1', bb: '1' },
      players: [0, 1, 2].map((seat) => ({
        seat, stack: '3', cards: ['2s2d', '3s3d', '4s4d'][seat]!,
      })),
      actions: [
        { t: 'post', seat: 0, kind: 'sb', amount: '1' },
        { t: 'post', seat: 1, kind: 'bb', amount: '1' },
        { t: 'allin', seat: 2, to: '3' },
        { t: 'allin', seat: 0, to: '3' },
        { t: 'call', seat: 1, amount: '3' },
        { t: 'street', street: 'flop', cards: 'AhKhQh' },
        { t: 'street', street: 'turn', cards: 'Jh' },
        { t: 'street', street: 'river', cards: 'Th' },
        { t: 'muck', seat: 0 },
      ],
      board: 'AhKhQhJhTh',
    }
    expect(validateRecord(record)).toEqual([])
    expect(replay(record).result?.winners).toEqual([
      { seat: 1, amount: '5', handName: 'Straight Flush' },
      { seat: 2, amount: '4', handName: 'Straight Flush' },
    ])
  })

  it('rejects premature, duplicate and already revealed discards, and reveal after discard', () => {
    const record = hand()
    expect(validateAction(initialState(record), { t: 'muck', seat: 0 }, record)?.code).toBe('illegal-action')
    expect(() => applyAction(initialState(record), { t: 'muck', seat: 0 }, record)).toThrow()
    record.actions.push({ t: 'muck', seat: 0 })
    expect(validateAction(live(record), { t: 'muck', seat: 0 }, record)?.code).toBe('illegal-action')
    expect(validateAction(live(record), { t: 'show', seat: 0, cards: 'AsAd' }, record)?.code).toBe('illegal-action')
    expect(() => applyAction(live(record), { t: 'show', seat: 0, cards: 'AsAd' }, record)).toThrow()
    record.actions.pop()
    record.actions.push({ t: 'show', seat: 0, cards: 'AsAd' }, { t: 'muck', seat: 0 })
    expect(validateRecord(record)[0]?.code).toBe('illegal-action')
  })
})

describe('format compatibility', () => {
  it('round trips v1 and v2 with matching envelopes', () => {
    for (const v of [1, 2] as const) {
      const record = { ...hand(), v }
      if (v === 2) record.actions.push({ t: 'muck', seat: 0 })
      const encoded = encodeHand(record)
      expect(encoded.startsWith(`v${v}.`)).toBe(true)
      expect(decodeHand(encoded)).toEqual(record)
      expect(assertHandRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
      expect(() => decodeHand(encoded.replace(/^v\d/, v === 1 ? 'v2' : 'v1'))).toThrow(/versions do not match/)
    }
  })
  it('requires v2 for muck and rejects future versions', () => {
    const record = hand()
    record.actions.push({ t: 'muck', seat: 0 })
    expect(validateRecord({ ...record, v: 1 })[0]?.code).toBe('bad-version')
    expect(() => assertHandRecord({ ...record, v: 1 })).toThrow(/require record v2/)
    expect(() => assertHandRecord({ ...record, v: 3 })).toThrow()
    expect(() => decodeHand(encodeHand(record).replace('v2.', 'v3.'))).toThrow(/Unsupported/)
  })
})
