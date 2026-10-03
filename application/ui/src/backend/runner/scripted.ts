import type { TerminalSummary } from "@novadeck/protocol"
import type { RunnerStatus, TerminalWatchItem } from "@novadeck/protocol/client"

import { workspaceFromSeed } from "../../model/seed"
import { createTerminalState } from "../../model/state"
import { runnerBackend, type RunnerApi } from "./backend"
import { startingTerminal, type RunnerListing } from "./seed"
import { encodeSession } from "./session-state"

// Test support: a runner adapter over a runner the test scripts step by step.

// Values pushed by the test, read by the adapter as a stream.
const channel = <T>() => {
  const queued: T[] = []
  let wake: (() => void) | undefined
  const iterator: AsyncIterableIterator<T, undefined> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => {
      // eslint-disable-next-line no-await-in-loop -- Waits for the next pushed value.
      while (!queued.length) await new Promise<void>((resolve) => (wake = resolve))
      return { value: queued.shift()!, done: false }
    },
    return: async () => ({ value: undefined, done: true }),
  }
  return {
    iterator,
    push: (value: T) => {
      queued.push(value)
      wake?.()
    },
  }
}

const unused = (): never => {
  throw new Error("not used here")
}

export const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

type Saved = { readonly id: string; readonly lastProcess: string }
type Call = { readonly call: string; readonly input: unknown }

// A saved session laying out the terminals.
const state = (saved: readonly Saved[], visitedAt: number, name: string) => ({
  id: name,
  name,
  visitedAt,
  state: createTerminalState(
    saved.map((terminal) => startingTerminal(terminal.id, "/tmp")),
    "grid",
    "grid",
  ),
})

// A terminal the runner keeps without a shell, as after it restarted.
export const keptSummary = (
  terminalId: string,
  sessionId: string,
  change: Partial<TerminalSummary> = {},
): TerminalSummary => ({
  id: terminalId,
  sessionId,
  title: "Terminal 01",
  titleSource: { kind: "default" },
  handle: "t1",
  started: false,
  command: null,
  lastProgram: null,
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  run: 0,
  exit: null,
  process: null,
  agent: null,
  activity: null,
  telemetry: null,
  ...change,
})

// The runner's terminals of a session: those it lists live, and the rest kept.
const terminalsOf = (
  saved: readonly Saved[],
  listed: readonly TerminalSummary[],
  sessionId: string,
): TerminalSummary[] =>
  saved.map(
    (terminal, index) =>
      listed.find((summary) => summary.id === terminal.id) ??
      keptSummary(terminal.id, sessionId, {
        title: `Terminal ${String(index + 1).padStart(2, "0")}`,
        handle: `t${index + 1}`,
        lastProgram: terminal.lastProcess || null,
      }),
  )

// A runner the test scripts: each session's saved terminals, what the runner still
// lists. Every call that could start a shell is noted.
export const scripted = ({
  shown,
  background = [],
  listed = [],
  restart = () => new Promise<TerminalSummary>(() => {}),
  saveSettings = async () => {},
  connect = async (agent: string, connected: boolean) => ({ agent, available: true, connected }),
}: {
  shown: readonly Saved[]
  background?: readonly Saved[]
  listed?: readonly TerminalSummary[]
  restart?: () => Promise<TerminalSummary>
  saveSettings?: () => Promise<void>
  connect?: (agent: string, connected: boolean) => Promise<unknown>
}) => {
  const changes = channel<TerminalWatchItem>()
  const statuses = channel<RunnerStatus>()
  const calls: Call[] = []
  const note =
    <T>(call: string, answer: (input: unknown) => Promise<T>) =>
    (...input: unknown[]) => {
      calls.push({ call, input: input.length === 1 ? input[0] : input })
      return answer(input)
    }
  const api = {
    watch: () => statuses.iterator,
    projects: { list: unused, create: unused, rename: unused, remove: unused },
    sessions: { list: unused, create: unused, rename: unused, save: async () => {} },
    settings: { get: unused, set: note("settings", saveSettings) },
    agents: {
      list: async () => [],
      set: note("agents", (input) => {
        const [agent, connected] = input as [string, boolean]
        return connect(agent, connected)
      }),
    },
    terminals: {
      list: unused,
      watch: () => changes.iterator,
      // No agent asks for a terminal here.
      requests: () => channel<never>().iterator,
      // Never answers: a fresh shell stays starting.
      create: note("create", () => new Promise(() => {})),
      close: async () => {},
      rename: note("rename", async () => {}),
      restart: note("restart", restart),
      attach: () => new Promise(() => {}),
    },
  } as unknown as RunnerApi
  const listing: RunnerListing = [
    {
      project: { id: "p", name: "P", cwd: "/tmp" },
      sessions: [
        {
          session: {
            id: id(8),
            projectId: "p",
            name: "Shown",
            state: encodeSession(state(shown, 5, id(8)), 2),
          },
          terminals: terminalsOf(shown, listed, id(8)),
        },
        {
          session: {
            id: id(9),
            projectId: "p",
            name: "Background",
            state: encodeSession(state(background, 1, id(9)), 0),
          },
          terminals: terminalsOf(background, [], id(9)),
        },
      ],
    },
  ]
  const created = runnerBackend(api, listing, {
    saveDelay: 10,
    transcripts: true,
    agents: [
      { agent: "claude", available: true, connected: false },
      { agent: "agy", available: false, connected: false },
    ],
    welcomed: false,
  })
  created.backend.commit(
    workspaceFromSeed(created.backend.seed, { view: "grid", windowedView: "grid", now: 1 }),
    [],
  )
  const stop = created.backend.start!({ dispatch: () => {}, open: () => {} })
  statuses.push({ state: "connected", runnerId: "runner-1" })
  const of = (call: string) => calls.filter((item) => item.call === call).map((item) => item.input)
  const key = (terminalId: string) => ({ projectId: "p", workspaceSessionId: id(8), terminalId })
  return { ...created, changes, calls, of, stop, key }
}
