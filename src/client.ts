import {
  ToliAuthError,
  ToliConfigError,
  ToliError,
  ToliProtocolError,
  ToliRateLimitError,
  ToliUnavailableError,
} from './errors.js'
import type { Question } from './questions.js'
import { parseReading, type Reading } from './reading.js'
import { Thresholds } from './thresholds.js'

/** The Essabu gateway — the only public path. */
export const DEFAULT_BASE_URL = 'https://toli.essabu.com'

export interface ToliOptions {
  apiKey: string
  /** Defaults to the Essabu gateway; only change it for local development. */
  baseUrl?: string
  thresholds?: Thresholds
  /** A pinned version. A moving alias would silently invalidate your thresholds. */
  model?: string
  /** Injected in tests so the suite does not actually wait. */
  sleep?: (seconds: number) => Promise<void>
  fetch?: typeof globalThis.fetch
}

/** Attempts, then we hand control back. */
const MAX_ATTEMPTS = 5

/** Statuses worth trying again: quota, overload. 5xx joins them below. */
const RETRYABLE = new Set([429, 529])

/**
 * The Toli client.
 *
 * One call carries a state and every question at once: the model evaluates them
 * in parallel, which is an order of magnitude cheaper and faster than one
 * request per question.
 *
 * Nothing here applies a decision. `ask()` returns a Reading; the caller reads
 * the route and acts. That asymmetry is deliberate.
 */
export class Toli {
  static readonly CONTRACT_VERSION = 1

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly thresholds: Thresholds
  private readonly model: string
  private readonly sleep: (seconds: number) => Promise<void>
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: ToliOptions) {
    if (!options.apiKey?.trim()) {
      throw new ToliConfigError('Missing Toli API key: nothing can be asked without it.')
    }

    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.thresholds = options.thresholds ?? Thresholds.defaults()
    this.model = options.model ?? 'toli-1'
    this.sleep = options.sleep ?? ((s) => new Promise((resolve) => setTimeout(resolve, s * 1000)))
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  /**
   * Ask Toli to read a state.
   *
   * Send it what is needed to judge — and nothing more. Names, phone numbers
   * and personal identifiers have no bearing on a category and no business
   * leaving your infrastructure.
   */
  async ask(
    state: string | Record<string, unknown>,
    questions: Record<string, Question>,
    model?: string,
  ): Promise<Reading> {
    if (Object.keys(questions).length === 0) {
      throw new ToliConfigError('Asking Toli nothing: provide at least one question.')
    }

    const servedModel = model ?? this.model
    const body = JSON.stringify({ state, model: servedModel, questions })
    const response = await this.send(body)
    const text = await response.text()

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ToliProtocolError('Unreadable response body: expected JSON.', {
        status: response.status,
        requestId: response.headers.get('x-request-id') ?? undefined,
        bodyExcerpt: ToliError.excerpt(text),
      })
    }

    return parseReading(parsed as Record<string, unknown>, servedModel, this.thresholds)
  }

  private async send(body: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let response: Response

      try {
        response = await this.fetchImpl(`${this.baseUrl}/v1/ask`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            'user-agent': `toli-ts/${Toli.CONTRACT_VERSION}`,
          },
          body,
        })
      } catch (cause) {
        // A dropped connection is transient and retries like a 429. Three
        // readings out of 897 were lost before this rule existed.
        if (attempt >= MAX_ATTEMPTS) {
          throw new ToliUnavailableError(`Toli unreachable after ${attempt} attempts: ${String(cause)}`)
        }

        await this.backoff(attempt)
        continue
      }

      if (response.ok) return response

      const requestId = response.headers.get('x-request-id') ?? undefined

      if (response.status === 401 || response.status === 403) {
        throw new ToliAuthError('Toli rejected the key: retrying would change nothing.', {
          status: response.status,
          requestId,
          bodyExcerpt: ToliError.excerpt(await response.text()),
        })
      }

      const retryable = RETRYABLE.has(response.status) || response.status >= 500

      if (!retryable) {
        throw new ToliProtocolError(`Toli answered HTTP ${response.status}.`, {
          status: response.status,
          requestId,
          bodyExcerpt: ToliError.excerpt(await response.text()),
        })
      }

      if (attempt >= MAX_ATTEMPTS) {
        const context = {
          status: response.status,
          requestId,
          bodyExcerpt: ToliError.excerpt(await response.text()),
        }
        const message = `Toli still failing after ${attempt} attempts (HTTP ${response.status}).`

        throw response.status === 429
          ? new ToliRateLimitError(message, context)
          : new ToliUnavailableError(message, context)
      }

      // A server that states its own retry-after knows its load better than our
      // backoff curve does.
      const retryAfter = Number(response.headers.get('retry-after'))
      await this.backoff(attempt, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined)
    }
  }

  private async backoff(attempt: number, retryAfter?: number): Promise<void> {
    await this.sleep(retryAfter ?? 2 ** (attempt - 1))
  }
}
