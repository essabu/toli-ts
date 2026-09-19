/**
 * Malformed call: missing key, inconsistent thresholds, impossible question.
 *
 * Deliberately NOT a ToliError: a caller that catches Toli errors in order to
 * retry must not silently swallow its own configuration bugs.
 */
export class ToliConfigError extends Error {
  override readonly name = 'ToliConfigError'
}

export interface ToliErrorContext {
  status?: number | undefined
  requestId?: string | undefined
  bodyExcerpt?: string | undefined
}

/**
 * Root of the Toli errors. Carries enough to diagnose without spilling the
 * state into a log file: the HTTP status, the server's request id, and a body
 * excerpt CAPPED at 300 characters.
 */
export class ToliError extends Error {
  static readonly BODY_EXCERPT_MAX = 300

  readonly status: number | undefined
  readonly requestId: string | undefined
  readonly bodyExcerpt: string | undefined

  constructor(message: string, context: ToliErrorContext = {}) {
    super(message)
    this.name = 'ToliError'
    this.status = context.status
    this.requestId = context.requestId
    this.bodyExcerpt = context.bodyExcerpt
  }

  /** Cuts a response body down to what we accept to copy into a log. */
  static excerpt(body: string): string {
    return body.slice(0, ToliError.BODY_EXCERPT_MAX)
  }
}

/** Key rejected (401 / 403). No retry: the same key will be rejected again. */
export class ToliAuthError extends ToliError {
  override readonly name = 'ToliAuthError'
}

/** Quota exceeded (429). The SDK already retried, honouring retry-after. */
export class ToliRateLimitError extends ToliError {
  override readonly name = 'ToliRateLimitError'
}

/** Unavailable (5xx, 529) or dropped connection. The SDK already retried. */
export class ToliUnavailableError extends ToliError {
  override readonly name = 'ToliUnavailableError'
}

/** Deadline exceeded. Transient. */
export class ToliTimeoutError extends ToliError {
  override readonly name = 'ToliTimeoutError'
}

/** The server answered, but not with what was expected. */
export class ToliProtocolError extends ToliError {
  override readonly name = 'ToliProtocolError'
}
