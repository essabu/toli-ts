import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  choice,
  noul,
  score,
  Thresholds,
  Toli,
  ToliAuthError,
  ToliConfigError,
  ToliProtocolError,
  ToliUnavailableError,
} from '../src/index.js'
import { parseReading } from '../src/reading.js'

/**
 * The shared conformance suite, replayed against the TypeScript SDK.
 *
 * These cases live in spec/conformance/ and are replayed by every SDK. They are
 * the only thing that keeps "confirm" meaning the same in TypeScript and in
 * PHP — a language-specific test proves a language-specific belief.
 */
function spec(file: string): Record<string, any> {
  return JSON.parse(readFileSync(join(__dirname, '../../spec/conformance', file), 'utf8'))
}

/** A scripted fetch: hand it the responses, read back the requests. */
function fakeFetch(responses: Array<Response | 'network-failure'>) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = []

  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')),
      headers: (init?.headers ?? {}) as Record<string, string>,
    })

    const next = responses.shift()
    if (!next) throw new Error('The fake fetch ran out of scripted responses.')
    if (next === 'network-failure') throw new TypeError('fetch failed')

    return next
  })

  return { impl: impl as unknown as typeof globalThis.fetch, calls }
}

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers })

const status = (code: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: code, headers })

function client(fetchImpl: typeof globalThis.fetch, thresholds?: Thresholds) {
  return new Toli({
    apiKey: 'test-key',
    fetch: fetchImpl,
    sleep: async () => undefined,
    ...(thresholds ? { thresholds } : {}),
  })
}

function read(body: Record<string, unknown>, thresholds = Thresholds.defaults()) {
  return parseReading({ model: 'toli-1', ...body }, 'toli-1', thresholds)
}

describe('routing (shared fixtures)', () => {
  const routing = spec('routing.json')
  const thresholds = Thresholds.measured(
    routing.thresholds.act,
    routing.thresholds.confirm,
    'conformance suite',
    '2026-09-19',
  )

  for (const testCase of routing.cases) {
    it(testCase.name, () => {
      // The fixture describes the answer as it arrives on the wire, minus the
      // `kind` discriminator, which the parser infers from the payload shape.
      const { kind, ...wire } = testCase.answer
      const reading = parseReading({ model: 'toli-1', answers: { q: wire } }, 'toli-1', thresholds)

      expect(reading.route('q')).toBe(testCase.expect)
    })
  }

  it('a noul at perfect doubt never acts', () => {
    // THE mistake the contract guards against: comparing `noul` straight to the
    // act threshold would make 0.5 — the admission of ignorance — look like
    // near-certainty.
    const reading = read({ answers: { q: { noul: 0.5 } } })

    expect(reading.route('q')).toBe('escalate')
    expect(reading.answer('q').certainty).toBe(0)
  })

  it('a confident no is worth a confident yes', () => {
    const no = read({ answers: { q: { noul: 0.02 } } })
    const yes = read({ answers: { q: { noul: 0.98 } } })

    expect(no.route('q')).toBe('act')
    expect(yes.route('q')).toBe('act')
    expect(no.answer('q').certainty).toBeCloseTo(yes.answer('q').certainty, 9)
    expect(no.answer('q').isYes).toBe(false)
    expect(yes.answer('q').isYes).toBe(true)
  })
})

describe('advisory mode', () => {
  const advisory = Thresholds.advisory(0.6, 'screening corpus', '2026-09-19')

  for (const certainty of [1, 0.99, 0.85, 0.61]) {
    it(`certainty ${certainty} still only proposes`, () => {
      expect(advisory.route(certainty)).toBe('confirm')
    })
  }

  it('escalates below the confirm threshold', () => {
    expect(advisory.route(0.59)).toBe('escalate')
  })

  it('never returns act end to end, whatever the confidence', () => {
    const reading = read({ answers: { q: { choice: 'screen', confidence: 0.999 } } }, advisory)

    expect(reading.route('q')).toBe('confirm')
    expect(reading.toLog().thresholds).toMatchObject({ advisory: true })
  })
})

describe('requests', () => {
  it('sends every question in a single request', async () => {
    const { impl, calls } = fakeFetch([ok({ model: 'toli-1', answers: { a: { noul: 0.9 } } })])

    await client(impl).ask('a state', {
      a: noul('Something is true'),
      b: choice('Which team', { x: 'X', other: 'None of the above' }),
      c: score('How tense', ['Calm', 'Tense']),
    })

    expect(calls).toHaveLength(1)
    expect(Object.keys(calls[0]!.body.questions)).toEqual(['a', 'b', 'c'])
    expect(calls[0]!.body.questions.b.kind).toBe('choice')
    expect(calls[0]!.url).toBe('https://toli.essabu.com/v1/ask')
  })

  it('serialises a structured state as-is', async () => {
    const { impl, calls } = fakeFetch([ok({ model: 'toli-1', answers: { a: { noul: 0.9 } } })])
    const state = { interface: 'CommCare', feature: 'Sync' }

    await client(impl).ask(state, { a: noul('Blocked today') })

    expect(calls[0]!.body.state).toEqual(state)
  })

  it('refuses a single-option choice before touching the network', () => {
    expect(() => choice('Which team', { application: 'The app' })).toThrow(ToliConfigError)
  })

  it('refuses an empty key before touching the network', () => {
    expect(() => new Toli({ apiKey: '' })).toThrow(ToliConfigError)
  })

  it('refuses to ask nothing', async () => {
    const { impl, calls } = fakeFetch([])

    await expect(client(impl).ask('s', {})).rejects.toThrow(ToliConfigError)
    expect(calls).toHaveLength(0)
  })

  it('refuses inverted and out-of-bounds thresholds', () => {
    expect(() => Thresholds.measured(0.6, 0.85, 'x', '2026-09-19')).toThrow(ToliConfigError)
    expect(() => Thresholds.measured(1.4, 0.6, 'x', '2026-09-19')).toThrow(ToliConfigError)
    expect(() => Thresholds.measured(0.9, 0.6, '', '')).toThrow(ToliConfigError)
  })
})

describe('responses', () => {
  it('returns the served model, not the requested one', () => {
    // Pinning a version only protects you if you can tell you were served
    // something else.
    const reading = parseReading(
      { model: 'toli-1.14', answers: { q: { noul: 0.1 } } },
      'toli-1',
      Thresholds.defaults(),
    )

    expect(reading.model).toBe('toli-1.14')
  })

  it('counts a missing usage as zero', () => {
    expect(read({ answers: { q: { noul: 0.9 } } }).usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it('logs the decision but never the state', () => {
    const log = read({
      model: 'toli-1.13',
      answers: { q: { choice: 'sync', confidence: 0.92, probabilities: { sync: 0.92, other: 0.08 } } },
    }).toLog()

    expect(log.model).toBe('toli-1.13')
    expect((log.answers as any).q.route).toBe('act')
    expect((log.answers as any).q.probabilities).toEqual({ sync: 0.92, other: 0.08 })
    expect(log).toHaveProperty('thresholds')
    expect(JSON.stringify(log)).not.toContain('state')
  })
})

describe('errors and retries', () => {
  it('never retries a rejected key', async () => {
    const { impl, calls } = fakeFetch([status(401, { error: 'invalid api key' })])

    await expect(client(impl).ask('s', { q: noul('x') })).rejects.toThrow(ToliAuthError)
    expect(calls).toHaveLength(1)
  })

  it('retries a dropped connection', async () => {
    // 3 readings out of 897 were lost before this rule existed.
    const { impl, calls } = fakeFetch(['network-failure', ok({ model: 'toli-1', answers: { q: { noul: 0.9 } } })])

    const reading = await client(impl).ask('s', { q: noul('x') })

    expect(calls).toHaveLength(2)
    expect(reading.model).toBe('toli-1')
  })

  it('gives up after five attempts', async () => {
    const { impl, calls } = fakeFetch(
      Array.from({ length: 6 }, () => status(503, { error: 'unavailable' })),
    )

    await expect(client(impl).ask('s', { q: noul('x') })).rejects.toThrow(ToliUnavailableError)
    expect(calls).toHaveLength(5)
  })

  it('honours the server retry-after over its own backoff', async () => {
    const { impl } = fakeFetch([
      status(429, { error: 'rate limited' }, { 'retry-after': '2' }),
      ok({ model: 'toli-1', answers: { q: { noul: 0.9 } } }),
    ])
    const waits: number[] = []

    const toli = new Toli({
      apiKey: 'test-key',
      fetch: impl,
      sleep: async (s) => {
        waits.push(s)
      },
    })
    await toli.ask('s', { q: noul('x') })

    expect(waits).toEqual([2])
  })

  it('treats a 200 without answers as a protocol error', async () => {
    const { impl, calls } = fakeFetch([ok({ model: 'toli-1' })])

    await expect(client(impl).ask('s', { q: noul('x') })).rejects.toThrow(ToliProtocolError)
    expect(calls).toHaveLength(1)
  })

  it('carries the request id and a bounded excerpt', async () => {
    const { impl } = fakeFetch([
      new Response('x'.repeat(5000), { status: 400, headers: { 'x-request-id': 'req_8fa31' } }),
    ])

    await expect(client(impl).ask('s', { q: noul('x') })).rejects.toMatchObject({
      requestId: 'req_8fa31',
      bodyExcerpt: 'x'.repeat(300),
    })
  })
})
