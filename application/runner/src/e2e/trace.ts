import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import type { Report } from "@novadeck/harness-core/report"

import { agents, harnesses } from "../harnesses/registry.js"
import type { DeliveryEvent } from "../messaging/delivery.js"
import { Messaging } from "../messaging/messaging.js"
import { Terminals } from "../terminals/manager.js"
import type { FakeModel } from "./model/server.js"

/**
 * Where a failed test's trace goes (`NOVADECK_E2E_TRACES`), as CI uploads it; none is
 * written where it is unset.
 */
const folder = process.env.NOVADECK_E2E_TRACES

/** Whether tests are traced at all: only where their traces go (`NOVADECK_E2E_TRACES`). */
export const tracing = Boolean(folder)

/** Whether every test writes its trace, passed or not (`NOVADECK_E2E_TRACE_ALL=1`). */
export const tracesAll = process.env.NOVADECK_E2E_TRACE_ALL === "1"

// What one line of a trace shows of a value: its JSON, cut short.
const brief = (value: unknown, most = 160): string => {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > most ? `${text.slice(0, most)}…` : text
}

/**
 * `owner`, its `names` checked to be methods it has: a renamed one fails the trace at once,
 * rather than leaving it to record nothing of it.
 */
const methods = <T extends object>(owner: T, label: string, names: readonly string[]): T => {
  for (const name of names)
    if (typeof (owner as Record<string, unknown>)[name] !== "function")
      throw new TypeError(`The e2e trace wraps ${label}.${name}, which is no longer a method.`)
  return owner
}

type Live = {
  readonly terminalId: string
  readonly handle: string
  delivery: { readonly state: string; readonly byPerson: boolean }
}
type Inside = {
  step: (live: Live, event: DeliveryEvent) => void
  keys: Messaging["keys"]
  ask: Messaging["ask"]
}
// What the trace reads of a terminal's record: its agent's activity as clients see it.
type Traced = {
  readonly summary: { readonly id: string }
  readonly binding: Bound | null
  readonly activity: {
    readonly state: string
    readonly lastTurn: { readonly outcome: string } | null
  } | null
}
// Whose a binding or a fact is: the session, by its id's start, and the agent's instance.
type Bound = { readonly sessionId?: string; readonly instance?: string | number | null }
const whose = ({ sessionId, instance }: Bound): string =>
  `${sessionId?.slice(0, 8) ?? "?"}/${instance ?? "-"}`
type Runner = {
  queue: <T>(terminalId: string, work: () => Promise<T>, fallback: T) => Promise<T>
  report: (report: Report, deadline?: number) => Promise<unknown>
  connected: (agent: string | undefined) => Promise<boolean>
  persisting: (work: () => void) => boolean
  appliedFact: (record: Traced, fact: { readonly type: string }) => boolean
}

// An activity in a word or two: its state, and how its last turn ended.
const activityOf = (activity: Traced["activity"]): string =>
  activity ? `${activity.state}${activity.lastTurn ? `/${activity.lastTurn.outcome}` : ""}` : "none"

/**
 * What the runner heard and did during one test, for reading a failure afterwards where
 * its screens don't say why (as on a CI runner): each hook's report as it came, with when
 * its hook started, and what it decoded to; the person's keys; each change of a terminal's
 * delivery and what caused it; each answer to a hook that asks; and when each report
 * reached the runner, began to be handled after the terminal's earlier ones, and was done.
 * The runner runs in this process, so its harnesses' decoders, its messaging and its
 * report handling are wrapped while the test runs.
 */
export const startTrace = (name: string, model: FakeModel) => {
  const started = Date.now()
  const lines: string[] = []
  const at = (time = Date.now()) => `+${String(Math.round(time - started)).padStart(6)}`
  // Each terminal by its handle, once its delivery has been seen.
  const handles = new Map<string, string>()
  const named = (terminalId: string) => handles.get(terminalId) ?? terminalId.slice(0, 8)
  const add = (line: string) => lines.push(`${at()} ${line}`)

  // The model's calls, as they come, a few milliseconds late at most; and any stretch the
  // process was too busy to run this every 10 ms, as everything else waited too.
  let seen = model.calls.length
  let ticked = Date.now()
  const calls = setInterval(() => {
    const now = Date.now()
    if (now - ticked > 250) add(`stalled: nothing ran for ${now - ticked} ms`)
    ticked = now
    for (; seen < model.calls.length; seen += 1)
      add(
        `model ${
          model
            .trail(model.calls.length - seen)
            .split("\n")[1]
            ?.trim() ?? ""
        }`,
      )
  }, 10)
  calls.unref()

  const decoders = new Map<string, Harness["decode"]>()
  for (const agent of agents) {
    const harness = methods(harnesses[agent] as { decode: Harness["decode"] }, agent, ["decode"])
    const { decode } = harness
    decoders.set(agent, decode)
    harness.decode = (report) => {
      const events = decode(report)
      const { payload } = report
      const said = payload.prompt ?? payload.agent_state ?? payload.hook_event_name
      add(
        `report ${report.agent} ${report.event} hook started ${at(report.seq)} in ${report.instance ?? "?"}` +
          `${said === undefined ? "" : ` (${brief(said, 80)})`} → ${brief(
            events.map((event) => ({
              type: event.type,
              ...("cause" in event && { cause: event.cause }),
              ...("outcome" in event && { outcome: event.outcome }),
            })),
            300,
          )}`,
      )
      return events
    }
  }

  const inside = methods(Messaging.prototype as unknown as Inside, "Messaging", [
    "step",
    "keys",
    "ask",
  ])
  const { step, keys, ask } = inside
  inside.step = function (live, event) {
    handles.set(live.terminalId, live.handle)
    const before = live.delivery.state
    step.call(this, live, event)
    const after = live.delivery
    if (after.state !== before || event.type !== "key")
      add(
        `delivery ${live.handle} ${brief(event, 200)}: ${before} → ${after.state}${after.byPerson ? " (by the person)" : ""}`,
      )
  }
  inside.keys = function (terminalId, kinds, asked) {
    add(`keys ${named(terminalId)} ${kinds.join(",")}${asked ? " (asked)" : ""}`)
    keys.call(this, terminalId, kinds, asked)
  }
  inside.ask = function (terminalId, report) {
    const answer = ask.call(this, terminalId, report)
    add(
      `answer ${named(terminalId)} ${report.agent} ${report.event}: ${
        answer.leaseId === null ? "no lease" : `lease ${answer.leaseId}`
      }, ${answer.stdout === null ? "prints nothing" : brief(answer.stdout, 120)}`,
    )
    return answer
  }

  // When a report came, began after the terminal's earlier ones, and was done.
  const runner = methods(Terminals.prototype as unknown as Runner, "Terminals", [
    "queue",
    "report",
    "connected",
    "persisting",
    "appliedFact",
  ])
  const { queue, report: handle, connected, persisting, appliedFact } = runner
  // Each fact told the agent's activity, and what it made of it: a turn's end, an Escape,
  // an idle, as clients read the activity. A change between two of them is a new binding's.
  runner.appliedFact = function (record, fact) {
    const before = activityOf(record.activity)
    const applied = appliedFact.call(this, record, fact)
    // One that changed nothing names the binding it was weighed against, and its own.
    if (fact.type !== "telemetry-observed")
      add(
        `activity ${named(record.summary.id)} ${fact.type}: ${before} → ${activityOf(record.activity)}${
          applied
            ? ""
            : ` (no change; bound to ${record.binding ? whose(record.binding) : "none"}, the fact ${whose(fact as Bound)})`
        }`,
      )
    return applied
  }
  // Saving a terminal blocks the process until its store has written it.
  runner.persisting = function (work) {
    const began = performance.now()
    try {
      return persisting.call(this, work)
    } finally {
      const took = Math.round(performance.now() - began)
      if (took > 50) add(`slow: saving a terminal blocked everything for ${took} ms`)
    }
  }
  runner.connected = async function (agent) {
    const began = Date.now()
    try {
      return await connected.call(this, agent)
    } finally {
      const took = Date.now() - began
      if (took > 100) add(`slow: whether ${agent ?? "no agent"} is connected took ${took} ms`)
    }
  }
  runner.queue = function <T>(terminalId: string, work: () => Promise<T>, fallback: T) {
    const came = Date.now()
    return queue.call(
      this,
      terminalId,
      async () => {
        const began = Date.now()
        try {
          return await work()
        } finally {
          add(
            `handled ${named(terminalId)} a report that came at ${at(came)}: began ${at(began)}, took ${Date.now() - began} ms`,
          )
        }
      },
      fallback,
    ) as Promise<T>
  }
  runner.report = function (report, deadline) {
    add(
      `handling ${named(report.terminalId)} ${report.agent} ${report.event} (hook started ${at(report.seq)})`,
    )
    return handle.call(this, report, deadline)
  }

  return {
    /** Puts the runner back as it was. */
    stop: () => {
      clearInterval(calls)
      Object.assign(runner, { queue, report: handle, connected, persisting, appliedFact })
      for (const [agent, decode] of decoders)
        (harnesses[agent as keyof typeof harnesses] as { decode: Harness["decode"] }).decode =
          decode
      Object.assign(inside, { step, keys, ask })
    },
    /** Writes the trace, with what else is given, where failed tests' traces go. */
    write: () => {
      if (!folder) return
      const more = model.trail(40)
      mkdirSync(folder, { recursive: true })
      const file = `${name.replaceAll(/[^\w.-]+/g, "-").slice(0, 150)}.txt`
      writeFileSync(join(folder, file), `${name}\n\n${lines.join("\n")}\n\n${more}\n`)
    },
  }
}
