/**
 * URL fragment codec for `HandRecord` v1.
 *
 * A hand is serialized as `v1.<base64url(rawDeflate(utf8(JSON)))>` over a
 * key-minified JSON shape, so a full 9-max hand fits comfortably inside a URL.
 *
 * The implementation is deliberately dependency-light and platform-agnostic:
 * UTF-8 and base64url are hand-rolled (no `Buffer`, `atob`/`btoa`,
 * `TextEncoder`/`TextDecoder`) so the same code runs on Hermes, in browsers and
 * in Node. Compression comes from `fflate`'s raw DEFLATE.
 */

import { deflateSync, inflateSync } from 'fflate'

import type { Blinds, HandAction, HandPlayer, HandRecord } from './types'
import { validateRecord } from './validate'
import type { ValidationError } from './validate'

/** Payload prefix identifying the format version this module reads and writes. */
const VERSION_PREFIX = 'v1.'

/** Matches any `v<digits>.` prefix, used to tell a wrong version from garbage. */
const VERSION_PREFIX_PATTERN = /^v(\d+)\./

/**
 * Advisory maximum length for a hand URL. `encodeHand` never throws on a long
 * payload — the caller decides whether to shorten, split, or fall back.
 */
export const HAND_URL_MAX_LENGTH = 2000

/**
 * Hard limit on the base64url body `decodeHand` will even look at, in
 * characters. Comfortably above any legitimate payload, and checked before any
 * base64 decoding or decompression happens.
 */
export const HAND_PAYLOAD_MAX_LENGTH = 8192

/**
 * Hard limit on the decompressed JSON `decodeHand` will produce, in bytes.
 * Enforced by inflating into a pre-allocated buffer of this size plus one, so a
 * compression bomb can never expand past the limit in memory — it is truncated
 * at the boundary and rejected rather than materialized.
 */
export const HAND_INFLATED_MAX_BYTES = 65_536

/** Why a payload could not be turned back into a `HandRecord`. */
export type HandCodecErrorCode =
  /** The payload carries a format version this build cannot read. */
  | 'UNSUPPORTED_VERSION'
  /** The payload is not a decodable `v1.` envelope at all. */
  | 'MALFORMED'
  /** The payload breaches a size limit before or after decompression. */
  | 'TOO_LARGE'
  /** The envelope decoded, but its contents are not a valid `HandRecord`. */
  | 'INVALID_RECORD'

/** Error thrown by every failing path in this module. */
export class HandCodecError extends Error {
  readonly code: HandCodecErrorCode

  constructor(code: HandCodecErrorCode, message: string) {
    super(message)
    this.name = 'HandCodecError'
    this.code = code
  }
}

/* ------------------------------------------------------------------ *
 * Key minification table
 * ------------------------------------------------------------------ */

/**
 * Long property name to short wire key. Flat and global on purpose: a name that
 * means the same thing at two levels (`seat` in players and in actions) gets one
 * entry, and every short key stays unique across the whole record.
 */
const KEY_MAP = {
  // HandRecord
  v: 'v',
  id: 'i',
  playedAt: 't',
  game: 'g',
  currency: 'y',
  blinds: 'b',
  seats: 'z',
  button: 'u',
  players: 'p',
  actions: 'a',
  board: 'd',
  winners: 'w',
  note: 'e',
  sessionId: 'q',
  venue: 'x',
  tournamentName: 'j',
  // Blinds
  sb: 'B',
  bb: 'D',
  ante: 'E',
  anteType: 'F',
  // HandPlayer
  seat: 's',
  name: 'n',
  stack: 'k',
  cards: 'c',
  hero: 'h',
  // HandAction
  t: 'T',
  kind: 'K',
  amount: 'm',
  to: 'o',
  street: 'r',
} as const satisfies Record<string, string>

/** Short wire key back to the long property name. */
const REVERSE_KEY_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(KEY_MAP).map(([long, short]) => [short, long]),
)

/** Action discriminator value to its single-character wire form. */
const ACTION_TYPE_MAP = {
  post: 'P',
  fold: 'F',
  check: 'X',
  call: 'C',
  bet: 'B',
  raise: 'R',
  allin: 'A',
  street: 'S',
  show: 'W',
} as const satisfies Record<HandAction['t'], string>

/** Single-character action form back to its discriminator value. */
const REVERSE_ACTION_TYPE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(ACTION_TYPE_MAP).map(([long, short]) => [short, long]),
)

/** Same table as {@link ACTION_TYPE_MAP}, typed for lookups by arbitrary string. */
const ACTION_TYPE_LOOKUP: Record<string, string> = ACTION_TYPE_MAP

/** The key table, exposed for tests and tooling. Do not mutate. */
export const HAND_CODEC_KEY_MAP: Readonly<Record<string, string>> = KEY_MAP

/** The action-type table, exposed for tests and tooling. Do not mutate. */
export const HAND_CODEC_ACTION_TYPE_MAP: Readonly<Record<string, string>> = ACTION_TYPE_MAP

/* ------------------------------------------------------------------ *
 * UTF-8
 * ------------------------------------------------------------------ */

function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
        i += 1
      }
    }
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return new Uint8Array(bytes)
}

function utf8Decode(bytes: Uint8Array): string {
  let out = ''
  let chunk: number[] = []
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i] ?? 0
    let code: number
    let size: number
    if (b0 < 0x80) {
      code = b0
      size = 1
    } else if ((b0 & 0xe0) === 0xc0) {
      code = ((b0 & 0x1f) << 6) | ((bytes[i + 1] ?? 0) & 0x3f)
      size = 2
    } else if ((b0 & 0xf0) === 0xe0) {
      code = ((b0 & 0x0f) << 12) | (((bytes[i + 1] ?? 0) & 0x3f) << 6) | ((bytes[i + 2] ?? 0) & 0x3f)
      size = 3
    } else {
      code =
        ((b0 & 0x07) << 18) |
        (((bytes[i + 1] ?? 0) & 0x3f) << 12) |
        (((bytes[i + 2] ?? 0) & 0x3f) << 6) |
        ((bytes[i + 3] ?? 0) & 0x3f)
      size = 4
    }
    i += size
    if (code > 0xffff) {
      const adjusted = code - 0x10000
      chunk.push(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff))
    } else {
      chunk.push(code)
    }
    if (chunk.length >= 0x1000) {
      out += String.fromCharCode(...chunk)
      chunk = []
    }
  }
  if (chunk.length > 0) out += String.fromCharCode(...chunk)
  return out
}

/* ------------------------------------------------------------------ *
 * base64url
 * ------------------------------------------------------------------ */

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const BASE64URL_VALUES: Record<string, number> = Object.fromEntries(
  BASE64URL_ALPHABET.split('').map((char, index) => [char, index]),
)

/** Sextet value to its base64url character. */
function sextet(value: number): string {
  return BASE64URL_ALPHABET.charAt(value)
}

function base64UrlEncode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += sextet(b0 >> 2)
    out += sextet(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4))
    if (b1 === undefined) break
    out += sextet(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6))
    if (b2 === undefined) break
    out += sextet(b2 & 0x3f)
  }
  return out
}

function base64UrlDecode(text: string): Uint8Array {
  if (text.length % 4 === 1) {
    throw new HandCodecError('MALFORMED', 'Payload is not valid base64url.')
  }
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string
    const value = BASE64URL_VALUES[char]
    if (value === undefined) {
      throw new HandCodecError(
        'MALFORMED',
        `Payload contains a character that is not base64url: ${JSON.stringify(char)}.`,
      )
    }
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return new Uint8Array(bytes)
}

/* ------------------------------------------------------------------ *
 * Key minification
 * ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function renameKeys(value: unknown, table: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => renameKeys(item, table))
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[table[key] ?? key] = renameKeys(item, table)
  }
  return out
}

/** Convert a `HandRecord` into its short-key wire shape. */
export function minifyHand(hand: HandRecord): Record<string, unknown> {
  const minified = renameKeys(hand, KEY_MAP) as Record<string, unknown>
  const actions = minified[KEY_MAP.actions]
  if (Array.isArray(actions)) {
    minified[KEY_MAP.actions] = actions.map((action) => {
      if (!isPlainObject(action)) return action
      const type = action[KEY_MAP.t]
      if (typeof type !== 'string') return action
      const short = ACTION_TYPE_LOOKUP[type]
      return short === undefined ? action : { ...action, [KEY_MAP.t]: short }
    })
  }
  return minified
}

/** Convert a short-key wire shape back into long property names. */
export function expandHand(minified: unknown): unknown {
  const expanded = renameKeys(minified, REVERSE_KEY_MAP)
  if (!isPlainObject(expanded)) return expanded
  const actions = expanded['actions']
  if (Array.isArray(actions)) {
    expanded['actions'] = actions.map((action) => {
      if (!isPlainObject(action)) return action
      const type = action['t']
      if (typeof type !== 'string') return action
      const long = REVERSE_ACTION_TYPE_MAP[type]
      return long === undefined ? action : { ...action, t: long }
    })
  }
  return expanded
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const MONEY_PATTERN = /^\d+(\.\d+)?$/
const CARDS_PATTERN = /^([2-9TJQKA][shdc])+$/
const ID_PATTERN = /^\d+$/

function invalid(message: string): never {
  throw new HandCodecError('INVALID_RECORD', message)
}

function requireMoney(value: unknown, path: string): string {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) {
    invalid(`${path} must be a decimal amount string, got ${JSON.stringify(value)}.`)
  }
  return value
}

function requireCards(value: unknown, path: string): string {
  if (typeof value !== 'string' || !CARDS_PATTERN.test(value)) {
    invalid(`${path} must be a card string like "AhKd", got ${JSON.stringify(value)}.`)
  }
  return value
}

function requireSeat(value: unknown, seats: number, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= seats) {
    invalid(`${path} must be a seat index in 0..${seats - 1}, got ${JSON.stringify(value)}.`)
  }
  return value
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') invalid(`${path} must be a string.`)
  return value
}

function validateBlinds(value: unknown): Blinds {
  if (!isPlainObject(value)) invalid('blinds must be an object.')
  const blinds: Blinds = {
    sb: requireMoney(value['sb'], 'blinds.sb'),
    bb: requireMoney(value['bb'], 'blinds.bb'),
  }
  if (value['ante'] !== undefined) blinds.ante = requireMoney(value['ante'], 'blinds.ante')
  const anteType = value['anteType']
  if (anteType !== undefined) {
    if (anteType !== 'bb' && anteType !== 'each') {
      invalid(`blinds.anteType must be "bb" or "each", got ${JSON.stringify(anteType)}.`)
    }
    blinds.anteType = anteType
  }
  return blinds
}

function validatePlayer(value: unknown, seats: number, index: number): HandPlayer {
  const path = `players[${index}]`
  if (!isPlainObject(value)) invalid(`${path} must be an object.`)
  const player: HandPlayer = {
    seat: requireSeat(value['seat'], seats, `${path}.seat`),
    stack: requireMoney(value['stack'], `${path}.stack`),
  }
  const name = optionalString(value['name'], `${path}.name`)
  if (name !== undefined) player.name = name
  if (value['cards'] !== undefined) player.cards = requireCards(value['cards'], `${path}.cards`)
  const hero = value['hero']
  if (hero !== undefined) {
    if (typeof hero !== 'boolean') invalid(`${path}.hero must be a boolean.`)
    player.hero = hero
  }
  return player
}

function validateAction(value: unknown, seats: number, index: number): HandAction {
  const path = `actions[${index}]`
  if (!isPlainObject(value)) invalid(`${path} must be an object.`)
  const type = value['t']
  switch (type) {
    case 'post': {
      const kind = value['kind']
      if (kind !== 'sb' && kind !== 'bb' && kind !== 'ante' && kind !== 'straddle') {
        invalid(`${path}.kind must be sb, bb, ante or straddle, got ${JSON.stringify(kind)}.`)
      }
      return {
        t: 'post',
        seat: requireSeat(value['seat'], seats, `${path}.seat`),
        kind,
        amount: requireMoney(value['amount'], `${path}.amount`),
      }
    }
    case 'fold':
    case 'check':
      return { t: type, seat: requireSeat(value['seat'], seats, `${path}.seat`) }
    case 'call':
      return {
        t: 'call',
        seat: requireSeat(value['seat'], seats, `${path}.seat`),
        amount: requireMoney(value['amount'], `${path}.amount`),
      }
    case 'bet':
    case 'raise':
    case 'allin':
      return {
        t: type,
        seat: requireSeat(value['seat'], seats, `${path}.seat`),
        to: requireMoney(value['to'], `${path}.to`),
      }
    case 'street': {
      const street = value['street']
      if (street !== 'flop' && street !== 'turn' && street !== 'river') {
        invalid(`${path}.street must be flop, turn or river, got ${JSON.stringify(street)}.`)
      }
      return { t: 'street', street, cards: requireCards(value['cards'], `${path}.cards`) }
    }
    case 'show':
      return {
        t: 'show',
        seat: requireSeat(value['seat'], seats, `${path}.seat`),
        cards: requireCards(value['cards'], `${path}.cards`),
      }
    default:
      invalid(`${path}.t is not a known action type: ${JSON.stringify(type)}.`)
  }
}

/**
 * Check that an arbitrary decoded value really is a `HandRecord` v1 and return
 * a freshly built, normalized copy of it. Throws `HandCodecError` with code
 * `INVALID_RECORD` on the first problem found.
 *
 * This is a **shape** guard only — types, ranges and string patterns. Whether
 * the hand makes sense as poker (no duplicate seats or cards, a seated button,
 * a full board) is `validateRecordStatic`'s job, which `decodeHand` runs after
 * this one.
 */
export function assertHandRecord(value: unknown): HandRecord {
  if (!isPlainObject(value)) invalid('Record must be an object.')

  if (value['v'] !== 1) {
    invalid(`Record version must be 1, got ${JSON.stringify(value['v'])}.`)
  }
  const id = value['id']
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    invalid(`id must be a decimal integer string, got ${JSON.stringify(id)}.`)
  }
  const playedAt = value['playedAt']
  if (typeof playedAt !== 'number' || !Number.isInteger(playedAt)) {
    invalid(`playedAt must be an integer epoch in milliseconds, got ${JSON.stringify(playedAt)}.`)
  }
  if (value['game'] !== 'NLHE') {
    invalid(`game must be "NLHE", got ${JSON.stringify(value['game'])}.`)
  }
  const currency = value['currency']
  if (typeof currency !== 'string') invalid('currency must be a string.')
  const seats = value['seats']
  if (typeof seats !== 'number' || !Number.isInteger(seats) || seats < 2 || seats > 10) {
    invalid(`seats must be an integer in 2..10, got ${JSON.stringify(seats)}.`)
  }
  const button = requireSeat(value['button'], seats, 'button')
  const blinds = validateBlinds(value['blinds'])

  const rawPlayers = value['players']
  if (!Array.isArray(rawPlayers)) invalid('players must be an array.')
  if (rawPlayers.length < 2) invalid('players must contain at least two seated players.')
  const players = rawPlayers.map((player, index) => validatePlayer(player, seats, index))

  const rawActions = value['actions']
  if (!Array.isArray(rawActions)) invalid('actions must be an array.')
  const actions = rawActions.map((action, index) => validateAction(action, seats, index))

  const record: HandRecord = {
    v: 1,
    id,
    playedAt,
    game: 'NLHE',
    currency,
    blinds,
    seats,
    button,
    players,
    actions,
  }

  if (value['board'] !== undefined) {
    const board = requireCards(value['board'], 'board')
    if (board.length > 10) invalid('board must be at most five cards.')
    record.board = board
  }
  const rawWinners = value['winners']
  if (rawWinners !== undefined) {
    if (!Array.isArray(rawWinners)) invalid('winners must be an array.')
    record.winners = rawWinners.map((winner, index) => {
      if (!isPlainObject(winner)) invalid(`winners[${index}] must be an object.`)
      return {
        seat: requireSeat(winner['seat'], seats, `winners[${index}].seat`),
        amount: requireMoney(winner['amount'], `winners[${index}].amount`),
      }
    })
  }
  const note = optionalString(value['note'], 'note')
  if (note !== undefined) record.note = note
  const sessionId = optionalString(value['sessionId'], 'sessionId')
  if (sessionId !== undefined) record.sessionId = sessionId
  const venue = optionalString(value['venue'], 'venue')
  if (venue !== undefined) record.venue = venue
  const tournamentName = optionalString(value['tournamentName'], 'tournamentName')
  if (tournamentName !== undefined) record.tournamentName = tournamentName

  return record
}

/* ------------------------------------------------------------------ *
 * Public codec
 * ------------------------------------------------------------------ */

/**
 * Serialize a hand into a URL fragment payload.
 *
 * The result may exceed {@link HAND_URL_MAX_LENGTH} for pathological hands; it
 * is returned regardless so the caller can decide what to do about it.
 */
export function encodeHand(hand: HandRecord): string {
  const json = JSON.stringify(minifyHand(hand))
  const compressed = deflateSync(utf8Encode(json), { level: 9 })
  return VERSION_PREFIX + base64UrlEncode(compressed)
}

/**
 * Decompress with a hard ceiling on the output.
 *
 * `fflate` grows its own buffer without limit when left to itself, and its
 * streaming `Inflate` is no safer here — a single-chunk payload is inflated in
 * one shot before any callback runs, so watching accumulated size cannot stop
 * it. Passing a pre-allocated `out` buffer is the only bound that actually
 * holds: `fflate` fills it and stops, silently truncating anything longer.
 *
 * The buffer is therefore allocated one byte past the limit. A result that
 * reaches that final byte is either exactly one byte too long or was truncated;
 * both are rejected, and peak memory never exceeds the limit plus one byte.
 */
function inflateBounded(compressed: Uint8Array): Uint8Array {
  const ceiling = HAND_INFLATED_MAX_BYTES + 1
  let inflated: Uint8Array
  try {
    inflated = inflateSync(compressed, { out: new Uint8Array(ceiling) })
  } catch {
    throw new HandCodecError('MALFORMED', 'Payload could not be decompressed.')
  }
  if (inflated.length >= ceiling) {
    throw new HandCodecError(
      'TOO_LARGE',
      `Decompressed payload exceeds ${HAND_INFLATED_MAX_BYTES} bytes.`,
    )
  }
  return inflated
}

/**
 * The only two validation failures a decoded hand is allowed to carry, and only
 * on a record that declares no payout of its own.
 *
 * - `street-not-closed` — the record stops while someone still has to act.
 *   Sharing a hand at the decision point is a first-class use of these URLs, so
 *   an unfinished hand is not a broken one.
 * - `bad-winners` — a showdown whose villain cards are unknown, which therefore
 *   *needs* a manual payout the record has not supplied.
 *
 * **Both exceptions require an absent or empty `winners`.** `validateRecord`
 * stops at the first structural fault and returns, so a record that ends
 * mid-street never reaches the payout comparison at all: tolerating
 * `street-not-closed` on its own would wave through an unfinished hand carrying
 * an invented payout, which is exactly the kind of claim a URL must not be
 * allowed to smuggle in. Once a record declares winners it gets no tolerance —
 * it must replay cleanly and settle to precisely those winners.
 *
 * Everything else — an out-of-turn action, a call larger than the chips owed, an
 * impossible payout, a failed replay — rejects the payload.
 */
function isTolerated(problem: ValidationError, hand: HandRecord): boolean {
  if (hand.winners !== undefined && hand.winners.length > 0) return false
  return problem.code === 'street-not-closed' || problem.code === 'bad-winners'
}

/**
 * Parse a payload produced by {@link encodeHand} back into a `HandRecord`.
 *
 * The payload is treated as untrusted input throughout. In order, `decodeHand`
 * rejects a wrong version prefix (`UNSUPPORTED_VERSION`), a body over
 * {@link HAND_PAYLOAD_MAX_LENGTH} or an expansion over
 * {@link HAND_INFLATED_MAX_BYTES} (`TOO_LARGE`), anything that is not decodable
 * base64url, DEFLATE, UTF-8 and JSON (`MALFORMED`), and finally a record that
 * does not survive both the shape guard and a full replay (`INVALID_RECORD`).
 *
 * The replay contract, spelled out so callers know what they are handed:
 *
 * - **Accepted**: any hand whose actions are legal in sequence. Two unfinished
 *   shapes are accepted alongside complete ones, and both only when the record
 *   declares no winners: a hand that stops mid-street (`street-not-closed`), and
 *   a showdown with unknown villain cards awaiting a manual payout
 *   (`bad-winners`). Such a hand is sound but unfinished — `replay()` reports it
 *   as incomplete or as needing winners, not as an error, so callers must expect
 *   `isComplete: false` or `needsWinners: true`.
 * - **Rejected**: every other validation code, notably out-of-turn actions,
 *   illegal amounts, under-min raises, street structure faults, and duplicate
 *   cards or seats. Also **any** record that declares `winners` and does not
 *   replay to exactly that payout — including an unfinished one, which cannot
 *   have a settled payout to declare in the first place.
 */
export function decodeHand(payload: string): HandRecord {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new HandCodecError('MALFORMED', 'Payload is empty.')
  }
  if (!payload.startsWith(VERSION_PREFIX)) {
    const match = VERSION_PREFIX_PATTERN.exec(payload)
    if (match) {
      throw new HandCodecError(
        'UNSUPPORTED_VERSION',
        `Unsupported hand format version "v${match[1]}"; this build reads v1 only.`,
      )
    }
    throw new HandCodecError('MALFORMED', 'Payload does not start with a version prefix.')
  }

  const body = payload.slice(VERSION_PREFIX.length)
  if (body.length === 0) throw new HandCodecError('MALFORMED', 'Payload has no body.')
  // Checked before base64 decoding, decompression, UTF-8 decoding and parsing,
  // so an oversized payload costs nothing but a length comparison.
  if (body.length > HAND_PAYLOAD_MAX_LENGTH) {
    throw new HandCodecError(
      'TOO_LARGE',
      `Payload body is ${body.length} characters, over the ${HAND_PAYLOAD_MAX_LENGTH} character limit.`,
    )
  }

  const compressed = base64UrlDecode(body)
  const json = utf8Decode(inflateBounded(compressed))

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new HandCodecError('MALFORMED', 'Payload does not contain valid JSON.')
  }

  const record = assertHandRecord(expandHand(parsed))

  // Shape alone is not enough. A record can be perfectly typed and still be
  // impossible poker — two players in one seat, a card dealt twice, or a call
  // for more chips than were ever owed, which would have the replay engine hand
  // out a pot nobody put in. A URL is an untrusted boundary, so the hand is
  // replayed here and only the two deliberate exceptions below survive.
  const problems = validateRecord(record).filter((problem) => !isTolerated(problem, record))
  const first = problems[0]
  if (first !== undefined) {
    const at = first.step === undefined ? '' : ` at step ${first.step}`
    const extra = problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''
    throw new HandCodecError(
      'INVALID_RECORD',
      `Record is not a valid hand [${first.code}]${at}: ${first.message}${extra}`,
    )
  }

  return record
}

/** Build a shareable hand URL: the payload lives in the fragment. */
export function buildHandUrl(hand: HandRecord, baseUrl = 'https://smallblind.app/hand'): string {
  return `${baseUrl}#${encodeHand(hand)}`
}

/** Read a hand back out of a URL produced by {@link buildHandUrl}. */
export function parseHandUrl(url: string): HandRecord {
  if (typeof url !== 'string') throw new HandCodecError('MALFORMED', 'URL must be a string.')
  const hashIndex = url.indexOf('#')
  if (hashIndex === -1) throw new HandCodecError('MALFORMED', 'URL has no fragment.')
  return decodeHand(url.slice(hashIndex + 1))
}
