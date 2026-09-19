# Toli for TypeScript

[![npm](https://img.shields.io/badge/npm-%40essabu%2Ftoli-cb3837)](https://www.npmjs.com/package/@essabu/toli)

Typed decisions with a calibrated confidence, and the three-route rule that
keeps a human in the loop.

```bash
npm i @essabu/toli
```

Node 18+ (or any environment with `fetch`: Bun, Deno, Workers, the browser —
but **never with the key in the browser**). No runtime dependencies; ESM and
CJS, types included.

---

## In one screen

```ts
import { Toli, choice, noul, score, Thresholds } from '@essabu/toli'

const toli = new Toli({
  apiKey: process.env.TOLI_API_KEY!,
  thresholds: Thresholds.measured(
    0.85,
    0.6,
    '896 support tickets, French',
    '2026-09-18',
  ),
  model: 'toli-1',
})

const reading = await toli.ask(
  // Send what is needed to judge — and nothing more. A name or a phone number
  // has no bearing on a category and no business leaving your infrastructure.
  { interface: ticket.interface, feature: ticket.feature, description: ticket.description },
  {
    category: choice('Which team should handle this ticket', {
      application: 'The application misbehaves',
      hardware: 'A device is broken or missing',
      synchronization: 'Data does not sync',
      other: 'None of the above',
    }),
    urgent: noul('The sender is blocked from working today'),
    tone: score('How frustrated the sender appears', [
      'Calm',
      'Frustrated but civil',
      'Angry, strong language',
    ]),
  },
)

switch (reading.route('category')) {
  case 'act':
    await ticket.assignTo(reading.value('category') as string)
    break
  case 'confirm':
    await ticket.suggest(reading.value('category') as string)
    break
  case 'escalate':
    await ticket.queueForTriage()
    break
}

if (reading.answer('urgent').isYes && reading.route('urgent') === 'act') {
  await ticket.raisePriority()
}

logger.info(reading.toLog())   // model, routes, thresholds, probabilities
```

All three questions travel in **one** request. Asking them separately would
cost three times as much and take three times as long, for the same answers.

> Write question instructions in English: the model is trained on English
> first. Measure before writing them in another language.

---

## What happens when you call `ask()`

```mermaid
flowchart TB
    A1["A1 choice() / score() / noul()"] --> G1{"Does the choice have >= 2 options?"}
    G1 -->|no| X1["ToliConfigError<br/>thrown before any network call"]
    G1 -->|yes| A2["A2 toli.ask(state, questions)"]
    A2 --> G2{"Key present?<br/>at least one question?"}
    G2 -->|no| X1
    G2 -->|yes| A3["A3 fetch POST<br/>toli.essabu.com/v1/ask"]
    A3 --> G3{"Response"}
    G3 -->|401 / 403| X2["ToliAuthError · 1 attempt"]
    G3 -->|"429 · 529 · 5xx · fetch failed"| R1["R1 backoff 1·2·4·8·16 s<br/>retry-after wins"]
    R1 --> G4{"5th attempt?"}
    G4 -->|no| A3
    G4 -->|yes| X3["ToliRateLimitError<br/>ToliUnavailableError"]
    G3 -->|2xx| G5{"Does the JSON carry answers?"}
    G5 -->|no| X4["ToliProtocolError<br/>status · requestId · 300 chars"]
    G5 -->|yes| W1(["Reading"])
    W1 --> A4["A4 reading.route('category')"]
    A4 --> D1["'act'"]
    A4 --> D2["'confirm'"]
    A4 --> D3["'escalate'"]
```

`ToliConfigError` does **not** extend `ToliError`: a caller catching Toli
errors in order to retry must not silently swallow its own configuration bugs.

---

## Domains where acting alone is not an option

```ts
// Clinical orientation, screening: the 'act' route does not exist.
const thresholds = Thresholds.advisory(0.6, 'screening cohort, 2026', '2026-09-19')
```

No confidence, not even 0.999, returns `'act'` under this mode: at best
`'confirm'`, which a qualified person accepts or rejects. The `advisory` flag
travels in `toLog()`, so a reading can be shown afterwards never to have been
able to act alone.

---

## The API

| Export | What it does |
|---|---|
| `new Toli({ apiKey, thresholds?, model?, baseUrl?, fetch?, sleep? })` | The client; only change `baseUrl` for local development |
| `toli.ask(state, questions, model?)` | One call, every question, returns a `Reading` |
| `choice(instructions, criteria)` | Closed set; refuses fewer than two options |
| `score(instructions, criteria)` | Ordered levels, weakest to strongest |
| `noul(instructions)` | A statement; returns the probability of yes |
| `reading.route(name)` | `'act'` / `'confirm'` / `'escalate'` |
| `reading.value(name)` | The chosen option, the score, or the probability |
| `reading.answer(name)` | `certainty`, `probabilities`, `legend`, `isYes` |
| `reading.toLog()` | Model, thresholds, routes, distributions — never the state |
| `Thresholds.measured / advisory / defaults` | Thresholds: dated, or advisory |

There is deliberately no `decide()` and no `autoRoute()`. Toli proposes; your
code disposes.

---

## Errors

| Class | When | Retried for you |
|---|---|---|
| `ToliConfigError` | missing key, inconsistent thresholds, one-option `choice` | no — fix the call |
| `ToliAuthError` | 401 / 403 | no |
| `ToliRateLimitError` | 429, after five attempts | yes |
| `ToliUnavailableError` | 5xx, 529, `fetch failed` | yes |
| `ToliProtocolError` | non-JSON body, 200 without `answers`, other 4xx | no |

Each carries `status`, `requestId` and a `bodyExcerpt` capped at 300 characters
— enough to diagnose, too little to spill a state into a log file.

A dropped connection retries like a 429. That rule is not theoretical: three
readings out of 897 were lost before it existed.

---

## Where to run this package

The Toli key is a server secret. In a front-end application (Nuxt, Next,
TanStack Start), call Toli from a server route and never from the browser — a
published package cannot stop you, but saying it here prevents the most
ordinary leak there is.

---

## Development

```bash
npm ci
npm test         # Vitest, including the shared conformance suite
npm run typecheck
npm run build
```

The conformance tests read `../spec/conformance/*.json` — the same fixtures
every other Toli SDK replays.
