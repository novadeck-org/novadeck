import { useEffect, useMemo, useRef, useState } from "react"

import { sigsOf, writtenSince, type Agent } from "./layout"

// How long a write's pulse plays, as the Source tree's does.
export const pulseMs = 1400

/** What follows an agent's latest write: its cursor while its turn runs, then its trail. */
export type Mark =
  | { readonly line: string; readonly cursor: true }
  | { readonly line: string; readonly cursor: false; readonly at: number }

/**
 * What the writes seen while the preview is open show: each write pulses the lines it changed
 * (found by comparing what each agent held before and after, not by reading any harness's tool
 * calls), and the agent's mark sits at the end of the last of them: a cursor while the agent
 * writes the file, its trail once it does not. An agent writing with nothing of its seen yet has
 * its cursor on its last line.
 */
export const useWrites = (
  agents: readonly Agent[],
  writing: ReadonlySet<string>,
): { readonly pulsing: ReadonlySet<string>; readonly marks: ReadonlyMap<string, Mark> } => {
  const sigs = useMemo(() => sigsOf(agents), [agents])
  const before = useRef(sigs)
  const [last, setLast] = useState<ReadonlyMap<string, { line: string; at: number }>>(new Map())
  const [pulsing, setPulsing] = useState<ReadonlySet<string>>(new Set())
  // Each write's pulse is forgotten by its own timer, whatever writes follow.
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const running = timers.current
    return () => {
      for (const timer of running) clearTimeout(timer)
      running.clear()
    }
  }, [])
  useEffect(() => {
    const written = writtenSince(before.current, sigs)
    before.current = sigs
    if (written.size === 0) return
    const at = Date.now()
    setLast((now) => {
      const next = new Map(now)
      for (const [key, lines] of written) next.set(key, { line: lines.at(-1)!, at })
      return next
    })
    const lines = [...written.values()].flat()
    setPulsing((now) => new Set([...now, ...lines]))
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setPulsing((now) => {
        const rest = new Set(now)
        for (const line of lines) rest.delete(line)
        return rest
      })
    }, pulseMs)
    timers.current.add(timer)
  }, [sigs])
  const marks = useMemo(() => {
    const found = new Map<string, Mark>()
    for (const agent of agents) {
      const seen = last.get(agent.key)
      if (agent.handle !== undefined && writing.has(agent.handle)) {
        const line = seen?.line ?? sigs.get(agent.key)?.at(-1)?.sig
        if (line !== undefined) found.set(agent.key, { line, cursor: true })
      } else if (seen) found.set(agent.key, { line: seen.line, cursor: false, at: seen.at })
    }
    return found
  }, [agents, last, sigs, writing])
  return { pulsing, marks }
}
