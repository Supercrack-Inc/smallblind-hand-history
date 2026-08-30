import { describe, expect, it } from 'vitest'

import {
  blindSeats,
  positionLabels,
  postflopOrder,
  preflopOrder,
  seatOrderFromButton,
} from '../src/positions'

const nine = [0, 1, 2, 3, 4, 5, 6, 7, 8]

describe('positionLabels', () => {
  it('labels a full nine-handed table clockwise from the button', () => {
    expect(positionLabels(9, 5, nine)).toEqual({
      5: 'BTN',
      6: 'SB',
      7: 'BB',
      8: 'UTG',
      0: 'UTG+1',
      1: 'UTG+2',
      2: 'LJ',
      3: 'HJ',
      4: 'CO',
    })
  })

  it('uses the six-handed table when only six seats are taken', () => {
    expect(positionLabels(9, 0, [0, 2, 3, 5, 6, 8])).toEqual({
      0: 'BTN',
      2: 'SB',
      3: 'BB',
      5: 'UTG',
      6: 'HJ',
      8: 'CO',
    })
  })

  it('folds the small blind into the button heads-up', () => {
    expect(positionLabels(2, 1, [0, 1])).toEqual({ 1: 'BTN', 0: 'BB' })
    expect(blindSeats(2, 1, [0, 1])).toEqual({ sb: 1, bb: 0 })
  })

  it('covers every table size from two to ten', () => {
    for (let players = 2; players <= 10; players += 1) {
      const seats = Array.from({ length: players }, (_, index) => index)
      const labels = positionLabels(10, 0, seats)

      expect(Object.keys(labels)).toHaveLength(players)
      expect(new Set(Object.values(labels)).size).toBe(players)
      expect(labels[0]).toBe('BTN')
    }
  })

  it('rejects a button on an empty seat', () => {
    expect(() => positionLabels(6, 4, [0, 1, 2])).toThrow('not occupied')
  })
})

describe('action order', () => {
  it('starts preflop left of the big blind and postflop left of the button', () => {
    expect(preflopOrder(9, 5, nine)).toEqual([8, 0, 1, 2, 3, 4, 5, 6, 7])
    expect(postflopOrder(9, 5, nine)).toEqual([6, 7, 8, 0, 1, 2, 3, 4, 5])
  })

  it('puts the button first preflop and last postflop heads-up', () => {
    expect(preflopOrder(2, 0, [0, 1])).toEqual([0, 1])
    expect(postflopOrder(2, 0, [0, 1])).toEqual([1, 0])
  })

  it('starts left of the last straddle', () => {
    expect(preflopOrder(6, 0, [0, 1, 2, 3, 4, 5], { straddles: [3] })).toEqual([
      4, 5, 0, 1, 2, 3,
    ])
    expect(
      preflopOrder(6, 0, [0, 1, 2, 3, 4, 5], { straddles: [3, 4] }),
    ).toEqual([5, 0, 1, 2, 3, 4])
  })

  it('drops excluded seats while keeping the rotation', () => {
    expect(postflopOrder(9, 5, nine, { exclude: [6, 8, 0] })).toEqual([
      7, 1, 2, 3, 4, 5,
    ])
  })

  it('is a rotation of the seat order from the button', () => {
    const order = seatOrderFromButton(6, 2, [0, 1, 2, 3, 4, 5])
    expect(order).toEqual([2, 3, 4, 5, 0, 1])
    expect([...preflopOrder(6, 2, [0, 1, 2, 3, 4, 5])].sort()).toEqual(
      [...order].sort(),
    )
  })
})
