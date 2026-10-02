import type { Api, Call, Reply } from "./script.js"

/** A request as the fake model's server passes it on: never with its credentials. */
export type Request = {
  readonly method: string
  /** The path and query, as sent. */
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export type Response = {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /** The whole body, or its chunks in order, as a streamed answer sends them. */
  readonly body: string | readonly string[]
}

/**
 * One API, as a harness speaks it. It answers every request of that API the harness makes
 * on its way to the agent's turns (its models list, token counts, eligibility checks),
 * and for each model call parses the request into a `Call`, asks `reply` what to say, and
 * encodes the answer as that API streams it. The reply may take its time, as a rule
 * holding it at a gate does; the call counts as made as soon as `reply` is asked.
 */
export type Dialect = {
  readonly api: Api
  /** Whether the request is one of this API's. */
  readonly matches: (request: Request) => boolean
  readonly handle: (request: Request, reply: (call: Call) => Promise<Reply>) => Promise<Response>
}
