import { ToliProtocolError } from './errors.js'
import type { Route, Thresholds } from './thresholds.js'

export type AnswerKind = 'choice' | 'score' | 'noul'

/**
 * Toli's answer to ONE question, and the route it calls for.
 *
 * `certainty` is the quantity the route is decided on. For a choice or a score
 * it is the confidence the model returned. A noul carries no confidence: there
 * it is the distance from doubt.
 */
export interface Answer {
  readonly kind: AnswerKind
  readonly value: string | number
  readonly certainty: number
  readonly route: Route
  readonly probabilities: Record<string, number>
  readonly legend: string | undefined
  /** True when Toli leans towards yes — only meaningful for a noul. */
  readonly isYes: boolean
}

export interface Usage {
  readonly input_tokens: number
  readonly output_tokens: number
}

/** What Toli read: one answer per question, plus enough to replay it. */
export interface Reading {
  readonly model: string
  readonly answers: Readonly<Record<string, Answer>>
  readonly usage: Usage
  readonly thresholds: Thresholds
  /** The route to take for this question: act, propose, or escalate. */
  route(question: string): Route
  value(question: string): string | number
  answer(question: string): Answer
  /**
   * Enough to replay every decision: the model that served it, the thresholds
   * that decided, and the whole distribution. The state is not in there.
   */
  toLog(): Record<string, unknown>
}

function parseAnswer(name: string, raw: Record<string, unknown>, thresholds: Thresholds): Answer {
  const probabilities: Record<string, number> = {}
  const rawProbabilities = raw['probabilities']
  if (rawProbabilities && typeof rawProbabilities === 'object') {
    for (const [option, p] of Object.entries(rawProbabilities as Record<string, unknown>)) {
      probabilities[option] = typeof p === 'number' ? p : 0
    }
  }

  const confidence = typeof raw['confidence'] === 'number' ? raw['confidence'] : 0

  if ('choice' in raw) {
    return {
      kind: 'choice',
      value: String(raw['choice']),
      certainty: confidence,
      route: thresholds.route(confidence),
      probabilities,
      legend: undefined,
      isYes: false,
    }
  }

  if ('score' in raw) {
    return {
      kind: 'score',
      value: Number(raw['score']),
      certainty: confidence,
      route: thresholds.route(confidence),
      probabilities,
      legend: typeof raw['legend'] === 'string' ? raw['legend'] : undefined,
      isYes: false,
    }
  }

  if ('noul' in raw) {
    const noul = Number(raw['noul'])
    // A noul returns no confidence: 0.5 is the admission of ignorance, while
    // 0.02 and 0.98 are both frank answers. Certainty is therefore the distance
    // from doubt, rescaled onto [0, 1] — without which a confident "no" would
    // rank below an "I don't know".
    const certainty = Math.abs(noul - 0.5) * 2

    return {
      kind: 'noul',
      value: noul,
      certainty,
      route: thresholds.route(certainty),
      probabilities,
      legend: undefined,
      isYes: noul > 0.5,
    }
  }

  throw new ToliProtocolError(`Answer "${name}" has an unknown shape: neither choice, score, nor noul.`)
}

export function parseReading(
  body: Record<string, unknown>,
  requestedModel: string,
  thresholds: Thresholds,
): Reading {
  const rawAnswers = body['answers']
  if (!rawAnswers || typeof rawAnswers !== 'object') {
    throw new ToliProtocolError('Response without "answers": the server replied, but not to the question asked.')
  }

  const answers: Record<string, Answer> = {}
  for (const [name, raw] of Object.entries(rawAnswers as Record<string, unknown>)) {
    if (raw && typeof raw === 'object') {
      answers[name] = parseAnswer(name, raw as Record<string, unknown>, thresholds)
    }
  }

  const rawUsage = (body['usage'] ?? {}) as Record<string, unknown>
  const usage: Usage = {
    input_tokens: typeof rawUsage['input_tokens'] === 'number' ? rawUsage['input_tokens'] : 0,
    output_tokens: typeof rawUsage['output_tokens'] === 'number' ? rawUsage['output_tokens'] : 0,
  }

  const answerOf = (question: string): Answer => {
    const answer = answers[question]
    if (!answer) {
      throw new ToliProtocolError(`No answer for "${question}": Toli did not answer that question.`)
    }

    return answer
  }

  return {
    // The model as the SERVER reported it, never echoed from the request: that
    // is what surfaces the day the provider ships an update and you are no
    // longer served the version you pinned.
    model: typeof body['model'] === 'string' ? body['model'] : requestedModel,
    answers,
    usage,
    thresholds,
    answer: answerOf,
    route: (question) => answerOf(question).route,
    value: (question) => answerOf(question).value,
    toLog() {
      return {
        model: this.model,
        thresholds: thresholds.toJSON(),
        usage,
        answers: Object.fromEntries(
          Object.entries(answers).map(([name, a]) => [
            name,
            {
              kind: a.kind,
              value: a.value,
              certainty: a.certainty,
              route: a.route,
              probabilities: a.probabilities,
              legend: a.legend,
            },
          ]),
        ),
      }
    },
  }
}
