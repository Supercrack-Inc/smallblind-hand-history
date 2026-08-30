import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Big from 'big.js'
import { describe, expect, it } from 'vitest'

import { replay, replayAll, stepCount, totalPot } from '../src/replay'
import type { HandRecord, Pot } from '../src/types'
import { validateRecord } from '../src/validate'

/**
 * Contract fixture shared with the app and the web replayer: the recorded hand
 * plus the values every implementation must reproduce.
 */
type Fixture = {
  name: string
  description?: string
  hand: HandRecord
  expect: {
    finalPots: Pot[]
    potAfterStreet?: Record<string, string>
    stacksAtEnd?: Record<string, string>
    netBySeat: Record<string, string>
    winners: Array<{ seat: number; amount: string; handName?: string }>
    actingSeatAtStep?: Record<string, number | null>
  }
}

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url))

const fixtures: Fixture[] = readdirSync(fixturesDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map(
    (file) =>
      JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as Fixture,
  )

function stringKeys(record: Record<number | string, string>) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [String(key), value]),
  )
}

/** Pot total at the end of each street, keyed by the street it belongs to. */
function potByStreet(hand: HandRecord) {
  const states = replayAll(hand)
  const pots: Record<string, string> = {}
  let street = 'preflop'

  hand.actions.forEach((action, index) => {
    if (action.t === 'street') {
      pots[street] = totalPot(states[index + 1]!)
      street = action.street
    }
  })

  pots[street] = totalPot(states[states.length - 1]!)

  return pots
}

describe('contract fixtures', () => {
  it('loads every fixture', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(7)
  })

  fixtures.forEach((fixture) => {
    describe(fixture.name, () => {
      it('is a valid record', () => {
        expect(validateRecord(fixture.hand)).toEqual([])
      })

      it('replays to the expected pots and result', () => {
        const final = replay(fixture.hand)

        expect(final.isComplete).toBe(true)
        expect(final.pots).toEqual(fixture.expect.finalPots)
        expect(final.result?.winners).toEqual(fixture.expect.winners)
        expect(stringKeys(final.result?.net ?? {})).toEqual(
          fixture.expect.netBySeat,
        )

        if (fixture.expect.stacksAtEnd) {
          expect(stringKeys(final.stacks)).toEqual(fixture.expect.stacksAtEnd)
        }
      })

      it('conserves chips', () => {
        const final = replay(fixture.hand)
        const net = Object.values(final.result?.net ?? {}).reduce(
          (sum, value) => sum.plus(value),
          new Big(0),
        )

        expect(net.toFixed()).toBe('0')
      })

      it('tracks the pot street by street', () => {
        if (!fixture.expect.potAfterStreet) {
          return
        }

        const actual = potByStreet(fixture.hand)

        Object.entries(fixture.expect.potAfterStreet).forEach(
          ([street, amount]) => {
            expect(actual[street], `pot after ${street}`).toBe(amount)
          },
        )
      })

      it('puts the action on the expected seat', () => {
        if (!fixture.expect.actingSeatAtStep) {
          return
        }

        Object.entries(fixture.expect.actingSeatAtStep).forEach(
          ([step, seat]) => {
            expect(
              replay(fixture.hand, Number(step)).actingSeat,
              `acting seat at step ${step}`,
            ).toBe(seat)
          },
        )
      })

      it('replays step by step exactly like replay()', () => {
        const states = replayAll(fixture.hand)

        expect(states).toHaveLength(stepCount(fixture.hand) + 1)
        states.forEach((state, index) => {
          expect(replay(fixture.hand, index)).toEqual(state)
        })
      })
    })
  })
})
