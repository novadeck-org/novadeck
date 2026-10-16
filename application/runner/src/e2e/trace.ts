import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { isEmpty, type BoxProfile, type InputBox } from "@novadeck/harness-core/box"
import type { Harness } from "@novadeck/harness-core/harness"
import type { Report } from "@novadeck/harness-core/report"
import type { ScreenText } from "@novadeck/harness-core/screen"

import { agents, harnesses } from "../harnesses/registry.js"
import type { DeliveryEvent } from "../messaging/delivery.js"
import { Messaging } from "../messaging/messaging.js"
import { Interrupts } from "../terminals/interrupts.js"
import { Terminals } from "../terminals/manager.js"
import { Prompts } from "../terminals/prompts.js"
import { Trees, type Member } from "../terminals/trees.js"
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

// Processes of a tree, each by its pid and start.
const list = (members: readonly Member[]): string =>
  members.map(({ pid, startedAt }) => `${pid}@${startedAt}`).join(" ")

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
type Bound = {
  readonly sessionId?: string
  readonly instance?: string | number | null
}
const whose = ({ sessionId, instance }: Bound): string =>
  `${sessionId?.slice(0, 8) ?? "?"}/${instance ?? "-"}`
type Runner = {
  queue: <T>(terminalId: string, work: () => Promise<T>, fallback: T) => Promise<T>
  report: (report: Report, deadline?: number) => Promise<unknown>
  connected: (agent: string | undefined) => Promise<boolean>
  persisting: (work: () => void) => boolean
  appliedFact: (record: Traced, fact: { readonly type: string }) => boolean
}

// A screen's box as a profile reads it, and the rows around it (all it shows of a screen).
const boxOf = (screen: ScreenText | undefined, profile: BoxProfile | undefined): string => {
  if (!screen) return "no screen"
  const box: InputBox | undefined = profile?.read(screen)
  const from = Math.max(0, (box?.first ?? screen.rows.length - 3) - 2)
  const rows = screen.rows.slice(from, (box?.last ?? screen.rows.length) + 3)
  return `box ${box ? brief({ mode: box.mode, text: box.text }, 200) : "none"}, rows ${from}..: ${brief(rows, 600)}`
}
// What a trace wraps of the keys' host of an interrupt or a prompt, by terminal.
type Seeing = {
  screen: (terminalId: string) => Promise<ScreenText | undefined>
  type: (terminalId: string, data: string) => boolean
  // An interrupt's host only.
  write?: (terminalId: string, data: string) => boolean
  profile: (terminalId: string) => BoxProfile | undefined
}

// An activity in a word or two: its state, and how its last turn ended.
const activityOf = (activity: Traced["activity"]): string =>
  activity ? `${activity.state}${activity.lastTurn ? `/${activity.lastTurn.outcome}` : ""}` : "none"

/**
 * What the runner heard and did during one test, for reading a failure afterwards where
 * its screens don't say why (as on a CI runner): each hook's report as it came, with when
 * its hook started, and what it decoded to; the person's keys; each change of a terminal's
 * delivery and what caused it; an interrupt's reads of the agent's box and keys, and a prompt
 * its box refused; each answer to a hook that asks; and when each report
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

  // An interrupt, as it reads the agent's box before and after Escape, when `settled` gave
  // it back, and what it wrote: where an interrupted prompt that was put back, or not
  // cleared, is told from a stale read. Each host's keys and screens are wrapped once.
  const interrupting = methods(
    Interrupts.prototype as unknown as Record<string, never>,
    "Interrupts",
    ["once", "settled"],
  ) as unknown as {
    host: Seeing & {
      working: (terminalId: string) => boolean
      prompt: (terminalId: string) => string | undefined
    }
    once: (terminalId: string, ...rest: unknown[]) => Promise<unknown>
    settled: (terminalId: string, ...rest: unknown[]) => Promise<InputBox | undefined>
  }
  const { once, settled } = interrupting
  const boxes = new Map<string, string>()
  const seeing = new Map<Seeing, Omit<Seeing, "profile">>()
  const watch = (
    host: Seeing,
    after: (terminalId: string, screen: ScreenText | undefined) => void,
  ) => {
    if (seeing.has(host)) return
    const { screen, type, write } = host
    seeing.set(host, { screen, type, ...(write && { write }) })
    host.screen = async (terminalId) => {
      const read = await screen.call(host, terminalId)
      after(terminalId, read)
      return read
    }
    host.type = (terminalId, data) => {
      add(`keys ${named(terminalId)} typed ${brief(data, 40)}`)
      return type.call(host, terminalId, data)
    }
    if (write)
      host.write = (terminalId, data) => {
        add(`keys ${named(terminalId)} wrote ${brief(data, 40)}`)
        return write.call(host, terminalId, data)
      }
  }
  interrupting.once = async function (terminalId, ...rest) {
    const { host } = this
    watch(host, (id, read) => {
      const profile = host.profile(id)
      const queued = read !== undefined && profile?.queued(read) === true
      const shown = `${boxOf(read, profile)}${queued ? ", queued" : ""}`
      if (boxes.get(id) !== shown) add(`interrupt ${named(id)} screen read: ${shown}`)
      boxes.set(id, shown)
    })
    boxes.delete(terminalId)
    // What decides whether it waits for the box at all: a working turn, a box it can read,
    // and the turn's prompt as the hooks told it (or a prompt queued).
    add(
      `interrupt ${named(terminalId)} begins: ${host.working(terminalId) ? "working" : "not working"}, ${host.profile(terminalId) ? "box read" : "no box profile"}, hooks' prompt ${brief(host.prompt(terminalId) ?? null, 80)}`,
    )
    try {
      const result = await once.call(this, terminalId, ...rest)
      add(`interrupt ${named(terminalId)} returned ${brief(result, 200)}`)
      return result
    } catch (error) {
      add(`interrupt ${named(terminalId)} threw ${brief(String(error), 200)}`)
      throw error
    }
  }
  interrupting.settled = async function (terminalId, ...rest) {
    add(`interrupt ${named(terminalId)} waits for the box to settle`)
    const box = await settled.call(this, terminalId, ...rest)
    add(
      `interrupt ${named(terminalId)} settled: ${box ? brief({ mode: box.mode, text: box.text }, 200) : "no box"}`,
    )
    return box
  }

  // The screen a prompt last read of each terminal, shown where its box refuses the prompt.
  const prompting = Prompts.prototype as unknown as {
    host: Seeing
    emptied: (
      terminalId: string,
      profile: BoxProfile,
      first: ScreenText,
      ...rest: unknown[]
    ) => Promise<unknown>
    landed: (
      terminalId: string,
      typed: string,
      profile: BoxProfile,
      ...rest: unknown[]
    ) => Promise<unknown>
  }
  methods(prompting, "Prompts", ["emptied", "landed"])
  const { emptied, landed } = prompting
  const lastRead = new Map<string, { time: number; screen: ScreenText | undefined }>()
  prompting.emptied = async function (terminalId, profile, first, ...rest) {
    watch(this.host, (id, screen) => lastRead.set(id, { time: Date.now(), screen }))
    // The box as the prompt first found it, where it held text: read before any wrap here.
    const box = profile.read(first)
    if (!box || box.mode !== "prompt" || !isEmpty(box))
      add(`prompt ${named(terminalId)} finds the box not empty: ${boxOf(first, profile)}`)
    try {
      return await emptied.call(this, terminalId, profile, first, ...rest)
    } catch (error) {
      const read = lastRead.get(terminalId)
      add(
        `prompt ${named(terminalId)} refused (${brief(String(error), 120)}); last read at ${read ? at(read.time) : "never"}: ${boxOf(read?.screen, profile)}`,
      )
      throw error
    }
  }

  // Where a pasted prompt is not found in the box, within the time it is given: the box as
  // it was last read, and when, to tell a screen that never showed it from one that was
  // read late (a runner busy for seconds at a time).
  prompting.landed = async function (terminalId, typed, profile, ...rest) {
    watch(this.host, (id, screen) => lastRead.set(id, { time: Date.now(), screen }))
    const began = Date.now()
    const result = await landed.call(this, terminalId, typed, profile, ...rest)
    if (result !== true) {
      const read = lastRead.get(terminalId)
      add(
        `prompt ${named(terminalId)} paste of ${typed.length} chars ended as ${brief(result, 40)} (not found, or placeholder, or the hold lapsed) after ${Date.now() - began} ms; last read at ${read ? at(read.time) : "never"}: ${boxOf(read?.screen, profile)}`,
      )
    }
    return result
  }

  // A terminal's tree as the runner reads and ends it as the terminal closes (Windows'
  // only), and how a close begins: where a program outlives the deck, whether its tree
  // was read with it in, and what was ended. Each line says whether a close was running,
  // so the runner's own reads and ends are told from the reap's after the deck.
  const treeing = methods(Trees.prototype as unknown as Record<string, never>, "Trees", [
    "read",
    "end",
  ]) as unknown as {
    read: (root: number | Member, timeoutMs?: number) => Promise<readonly Member[] | undefined>
    end: (members: readonly Member[], timeoutMs?: number) => Promise<void>
  }
  const closing = methods(Terminals.prototype as unknown as Record<string, never>, "Terminals", [
    "kill",
  ]) as unknown as {
    kill: (record: {
      readonly summary: { readonly id: string; readonly exit: unknown }
      readonly exitQueued: boolean
      readonly process: { readonly pid: number }
    }) => Promise<void>
  }
  const { read: readTree, end: endTree } = treeing
  const { kill } = closing
  let closes = 0
  const during = () => (closes > 0 ? "in a close" : "outside a close")
  treeing.read = async function (root, timeoutMs) {
    const rooted = typeof root === "number" ? String(root) : `${root.pid}@${root.startedAt}`
    const tree = await readTree.call(this, root, timeoutMs)
    add(
      `tree read ${rooted} (${during()}, within ${timeoutMs ?? "default"} ms): ${
        tree === undefined ? "unknown" : `${tree.length} [${list(tree)}]`
      }`,
    )
    return tree
  }
  treeing.end = async function (members, timeoutMs) {
    if (members.length === 0) return endTree.call(this, members, timeoutMs)
    add(
      `tree end ${members.length} [${list(members)}] (${during()}, within ${timeoutMs ?? "default"} ms)`,
    )
    await endTree.call(this, members, timeoutMs)
    add(`tree end ${members.length} returned`)
  }
  closing.kill = async function (record) {
    add(
      `kill ${named(record.summary.id)} begins: shell ${record.process.pid}, exit queued ${record.exitQueued}`,
    )
    closes += 1
    try {
      await kill.call(this, record)
    } finally {
      closes -= 1
      add(`kill ${named(record.summary.id)} done`)
    }
  }

  return {
    /** Puts the runner back as it was. */
    stop: () => {
      clearInterval(calls)
      Object.assign(treeing, { read: readTree, end: endTree })
      Object.assign(closing, { kill })
      Object.assign(interrupting, { once, settled })
      Object.assign(prompting, { emptied, landed })
      for (const [host, original] of seeing) Object.assign(host, original)
      Object.assign(runner, {
        queue,
        report: handle,
        connected,
        persisting,
        appliedFact,
      })
      for (const [agent, decode] of decoders)
        (
          harnesses[agent as keyof typeof harnesses] as {
            decode: Harness["decode"]
          }
        ).decode = decode
      Object.assign(inside, { step, keys, ask })
    },
    /** Writes the trace, with what else is given, where failed tests' traces go. */
    write: () => {
      if (!folder) return
      const more = model.trail(40)
      mkdirSync(folder, { recursive: true })
      const file = `${name.replaceAll(/[^\w.-]+/g, "-").slice(0, 150)}.txt`
      writeFileSync(
        join(folder, file.replace(/\.txt$/, ".tools.json")),
        JSON.stringify(
          model.calls
            .filter((call) => !call.side)
            .map((call) => ({
              api: call.api,
              model: call.model,
              tools: call.rawTools,
              reads: call.turns.filter(
                (turn) =>
                  turn.role === "tool" &&
                  call.turns.some(
                    (entry) =>
                      entry.role === "assistant" &&
                      entry.calls.some(
                        (tool) =>
                          tool.id === turn.id &&
                          tool.name === "view_file" &&
                          /[/\\]mcp[/\\].*\.json$/.test(String(tool.input.AbsolutePath)),
                      ),
                  ),
              ),
              mcp: /<mcp_servers>[\s\S]*?<\/mcp_servers>/.exec(call.system)?.[0],
            })),
          null,
          2,
        ),
      )
      writeFileSync(join(folder, file), `${name}\n\n${lines.join("\n")}\n\n${more}\n`)
    },
  }
}
