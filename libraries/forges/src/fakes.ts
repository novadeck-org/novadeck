import type { Problem, PullRequest, Ran, Run } from "./forge.js"

/** A scripted `Run`: each call is answered by the first entry whose key is its command line. */
export const scripted = (answers: Record<string, Ran>): { run: Run; calls: string[] } => {
  const calls: string[] = []
  const run: Run = async (program, args) => {
    const line = [program, ...args].join(" ")
    calls.push(line)
    return answers[line] ?? { ok: false, kind: "missing", said: `unscripted: ${line}` }
  }
  return { run, calls }
}

export const ok = (out: string, said?: string): Ran =>
  said === undefined ? { ok: true, out } : { ok: true, out, said }
export const exit = (said: string): Ran => ({ ok: false, kind: "exit", said })
export const missing: Ran = { ok: false, kind: "missing", said: "not found" }
export const timeout: Ran = { ok: false, kind: "timeout", said: "" }

/** A lookup's answer as the map it should be. */
export const mapOf = (
  answer: ReadonlyMap<string, PullRequest> | Problem,
): ReadonlyMap<string, PullRequest> => {
  if (!(answer instanceof Map)) throw new Error(`expected a map, got ${JSON.stringify(answer)}`)
  return answer
}
