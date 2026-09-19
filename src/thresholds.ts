import { ToliConfigError } from './errors.js'

/**
 * The three routes — the heart of Toli.
 *
 * Toli never decides alone: it returns a route, and the caller acts. A library
 * that applied the decision on the caller's behalf would remove the human
 * guardrail without anyone having chosen to.
 */
export type Route = 'act' | 'confirm' | 'escalate'

export interface ThresholdsJson {
  act: number
  confirm: number
  measured_on: string
  measured_at: string
  advisory: boolean
}

/**
 * The thresholds that decide between the three routes.
 *
 * A threshold holds for ONE model, ONE set of questions, ONE corpus. Lifting it
 * from another project without re-measuring is flying blind — hence
 * `measuredOn` and `measuredAt`, required as soon as you depart from the
 * defaults: whoever reads `act: 0.9` six months from now must be able to tell
 * what that 0.9 was established on, and when.
 */
export class Thresholds {
  private constructor(
    readonly act: number,
    readonly confirm: number,
    readonly measuredOn: string,
    readonly measuredAt: string,
    readonly advisory: boolean = false,
  ) {}

  /**
   * MEASURED thresholds: say on what, and when.
   *
   * @param measuredOn the corpus — "896 do-alo tickets, French"
   * @param measuredAt the date — "2026-09-18"
   */
  static measured(act: number, confirm: number, measuredOn: string, measuredAt: string): Thresholds {
    if (!measuredOn || !measuredAt) {
      throw new ToliConfigError(
        'Measured thresholds state what they were measured on and when: measuredOn and measuredAt are required.',
      )
    }
    if (act > 1 || confirm <= 0) {
      throw new ToliConfigError(`Thresholds out of bounds: 0 < confirm <= act <= 1 (got act=${act}, confirm=${confirm}).`)
    }
    if (confirm > act) {
      throw new ToliConfigError(
        `Confirm threshold above the act threshold: the 'propose' route would be unreachable (act=${act}, confirm=${confirm}).`,
      )
    }

    return new Thresholds(act, confirm, measuredOn, measuredAt)
  }

  /**
   * ADVISORY thresholds: Toli may propose, never act.
   *
   * For any domain where acting alone would be irreversible or unsafe —
   * clinical orientation, screening for sickle-cell disease, haemophilia or
   * rare diseases, anything touching a person's care. There, a wrong answer is
   * not re-routed the next morning.
   *
   * The guarantee is structural, not a matter of picking a high threshold:
   * `route()` cannot return 'act', whatever the model's confidence. The most a
   * reading can earn is 'confirm' — a proposal a qualified human accepts or
   * rejects.
   */
  static advisory(confirm: number, measuredOn: string, measuredAt: string): Thresholds {
    if (!measuredOn || !measuredAt) {
      throw new ToliConfigError(
        'Advisory thresholds state what they were measured on and when: measuredOn and measuredAt are required.',
      )
    }
    if (confirm <= 0 || confirm > 1) {
      throw new ToliConfigError(`Confirm threshold out of bounds: 0 < confirm <= 1 (got ${confirm}).`)
    }

    return new Thresholds(1, confirm, measuredOn, measuredAt, true)
  }

  /**
   * The contract defaults, NOT measured on your data. Fine to start with,
   * wrong to decide with: measure, then move to `measured()`.
   */
  static defaults(): Thresholds {
    return new Thresholds(0.85, 0.6, 'contract defaults — not measured on your data', '')
  }

  /** The route a given certainty calls for. Both thresholds are INCLUSIVE. */
  route(certainty: number): Route {
    if (this.advisory) {
      // No amount of confidence buys an automatic action here.
      return certainty >= this.confirm ? 'confirm' : 'escalate'
    }

    if (certainty >= this.act) return 'act'
    if (certainty >= this.confirm) return 'confirm'

    return 'escalate'
  }

  toJSON(): ThresholdsJson {
    return {
      act: this.act,
      confirm: this.confirm,
      measured_on: this.measuredOn,
      measured_at: this.measuredAt,
      advisory: this.advisory,
    }
  }
}
