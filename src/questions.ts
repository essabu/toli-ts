import { ToliConfigError } from './errors.js'

/**
 * A typed question — the only way to ask Toli anything.
 *
 * Three forms, no more: a closed choice, an ordered degree, a statement to
 * check. Everything else belongs to the calling code.
 */
export type Question =
  | { kind: 'choice'; instructions: string; criteria: Record<string, string> }
  | { kind: 'score'; instructions: string; criteria: string[] }
  | { kind: 'noul'; instructions: string }

/**
 * One option out of a CLOSED set.
 *
 * Always leave an escape hatch ("other", "none"…): without one the model is
 * forced to pick between boxes that do not describe the case, and the
 * confidence it returns stops meaning anything.
 *
 * @param instructions what is being asked, preferably in English
 * @param criteria option => what it covers
 */
export function choice(instructions: string, criteria: Record<string, string>): Question {
  if (Object.keys(criteria).length < 2) {
    throw new ToliConfigError(
      'A Choice with fewer than two options leaves no choice: add at least an escape hatch ("other").',
    )
  }

  return { kind: 'choice', instructions, criteria }
}

/**
 * A degree on ORDERED, described levels, from weakest to strongest. What comes
 * back is a weighted float, not an index: "1.4" says something "level 1" does
 * not.
 */
export function score(instructions: string, criteria: string[]): Question {
  if (criteria.length < 2) {
    throw new ToliConfigError('A Score needs at least two ordered levels.')
  }

  return { kind: 'score', instructions, criteria }
}

/**
 * A statement: is it true?
 *
 * What comes back is the probability of yes — and NOT a confidence. 0.5 is the
 * admission of ignorance; 0.02 and 0.98 are both frank answers. The SDK derives
 * certainty from it (distance from doubt) to pick the route.
 */
export function noul(instructions: string): Question {
  return { kind: 'noul', instructions }
}
