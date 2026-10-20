import type { ThemeSource } from "@novadeck/core/port"
import type { CanvasLayout } from "@novadeck/core/types"
import {
  contract,
  protocolVersion,
  type TerminalChange,
  type TerminalEvent,
  type TerminalSummary,
} from "@novadeck/protocol"
import { messagePort } from "@novadeck/wire/client"
import { memoryPorts } from "@novadeck/wire/testing"
import { implement, ORPCError } from "@orpc/server"
import { RPCHandler } from "@orpc/server/message-port"

import { connectRunnerBackend } from "./index"
import { channel, id, keptSummary, savedSession } from "./scripted"
import { encodeSession } from "./session-state"

// Test support: a runner the whole app boots over, at the wire, for the counter run. Browser
// code: unlike `testing.ts`, it imports nothing Node-only.

// Waits for the next value of a channel, or undefined once the call is cancelled.
const nextOrAbort = async <T>(
  next: Promise<IteratorResult<T, undefined>>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T, undefined> | undefined> => {
  if (signal?.aborted) return undefined
  let stop: (() => void) | undefined
  const aborted = new Promise<undefined>((resolve) => {
    stop = () => resolve(undefined)
    signal?.addEventListener("abort", stop, { once: true })
  })
  try {
    return await Promise.race([next, aborted])
  } finally {
    if (stop) signal?.removeEventListener("abort", stop)
  }
}

// A stream that yields nothing until the client lets go of it.
// eslint-disable-next-line require-yield -- It never has anything to yield.
const idle = async function* ({ signal }: { signal?: AbortSignal }) {
  await nextOrAbort(new Promise<never>(() => {}), signal)
}

// How many rows of each terminal's output its runner screen keeps for a snapshot.
const screenRows = 24
const handles = "moth fox owl crow kite raven wren lark finch heron swift robin hawk".split(" ")
const encoder = new TextEncoder()

// A runner the whole app boots over, at the wire: the whole contract served over an
// in-memory port, under the real client and the real adapter, so a procedure the contract
// adds or changes fails to compile here. It holds one project whose shown session holds
// `terminals` Claude Code agents, every one running, laid out in Grid. The test reports
// changes to a terminal through the runner's watch and writes output into its attached
// streams; the runner counts the bytes those streams send the UI and the streams open at
// once. A procedure the script doesn't play fails, and is noted in `unscripted`.
export const scriptedRunner = ({
  terminals: count,
  canvas,
}: {
  readonly terminals: number
  // Opens the session in Canvas, laid out so.
  readonly canvas?: CanvasLayout
}) => {
  const projectId = id(98)
  const sessionId = id(100)
  const terminalIds = Array.from({ length: count }, (_, index) => id(index + 1))
  const summaries = new Map(
    terminalIds.map((terminalId, index) => [
      terminalId,
      keptSummary(terminalId, sessionId, {
        title: `Agent ${index + 1}`,
        handle: handles[index] ?? `moth${index + 1}`,
        started: true,
        run: 1,
        agentRan: true,
        process: { name: "claude", argv: null },
        agent: "claude",
        activity: {
          state: "working",
          background: null,
          attention: { pending: 0, kind: null },
          planning: false,
          subagents: [],
          lastTurn: null,
        },
        telemetry: {
          context: { occupied: 0, capacity: 200_000 },
          limits: [],
          model: "Opus",
          effort: null,
        },
      }),
    ]),
  )
  // Each terminal's screen: the rows of output it keeps for a snapshot.
  const screens = new Map(terminalIds.map((terminalId) => [terminalId, [] as string[]]))
  // Each attached stream's queue, by terminal.
  const streams = new Map<string, Set<ReturnType<typeof channel<TerminalEvent>>>>()
  const watchers = new Set<ReturnType<typeof channel<TerminalChange>>>()
  const unscripted: string[] = []
  let bytes = 0
  let written = 0
  let streaming = 0
  let attaches = 0
  let sequence = 0
  const session = {
    id: sessionId,
    projectId,
    name: "Agents",
    state: encodeSession(
      savedSession(
        terminalIds.map((terminalId) => ({ id: terminalId, lastProcess: "claude" })),
        5,
        sessionId,
        canvas,
      ),
      0,
    ),
  }
  // Tells every watcher of a change, as the runner announces one.
  const announce = (change: TerminalChange): void => {
    for (const watcher of watchers) watcher.push(change)
  }
  const toStreams = (terminalId: string, event: TerminalEvent): void => {
    for (const events of streams.get(terminalId) ?? []) events.push(event)
  }
  // The terminal goes: its streams end, and watchers hear of it.
  const remove = (terminalId: string): void => {
    summaries.delete(terminalId)
    for (const events of streams.get(terminalId) ?? []) events.end()
    announce({ type: "removed", terminalId, sessionId })
  }
  // Counts what a stream sends the UI.
  const sent = (event: TerminalEvent): TerminalEvent => {
    if (event.type === "snapshot" || event.type === "output")
      bytes += encoder.encode(event.data).length
    return event
  }
  const api = implement(contract)
  // A procedure the script doesn't play: noted, and failed.
  const unplayed = (name: string) => (): never => {
    unscripted.push(name)
    throw new Error(`The counter run doesn't script ${name}`)
  }
  const router = api.router({
    wire: {
      handshake: api.wire.handshake.handler(() => ({ epoch: id(99), protocolVersion })),
    },
    projects: {
      list: api.projects.list.handler(() => [{ id: projectId, name: "Agents", cwd: "/tmp" }]),
      create: api.projects.create.handler(unplayed("projects.create")),
      rename: api.projects.rename.handler(unplayed("projects.rename")),
      remove: api.projects.remove.handler(unplayed("projects.remove")),
    },
    sessions: {
      list: api.sessions.list.handler(() => [session]),
      create: api.sessions.create.handler(unplayed("sessions.create")),
      rename: api.sessions.rename.handler(unplayed("sessions.rename")),
      save: api.sessions.save.handler(() => {}),
    },
    terminals: {
      list: api.terminals.list.handler(() => [...summaries.values()]),
      create: api.terminals.create.handler(unplayed("terminals.create")),
      requests: api.terminals.requests.handler(idle),
      answerRequest: api.terminals.answerRequest.handler(unplayed("terminals.answerRequest")),
      watch: api.terminals.watch.handler(async function* ({ signal }) {
        const changes = channel<TerminalChange>()
        watchers.add(changes)
        try {
          for (const terminal of summaries.values()) yield { type: "changed" as const, terminal }
          yield { type: "synced" as const }
          for (;;) {
            // eslint-disable-next-line no-await-in-loop -- Changes go out in order.
            const result = await nextOrAbort(changes.iterator.next(), signal)
            if (!result || result.done) return
            yield result.value
          }
        } finally {
          watchers.delete(changes)
        }
      }),
      attach: api.terminals.attach.handler(async function* ({ input, signal }) {
        const { terminalId } = input
        const summary = summaries.get(terminalId)
        if (!summary) throw new ORPCError("TERMINAL_NOT_FOUND", { status: 404 })
        const events = channel<TerminalEvent>()
        const held = streams.get(terminalId) ?? new Set()
        streams.set(terminalId, held.add(events))
        streaming += 1
        attaches += 1
        try {
          yield { terminalId, type: "attached" as const, mode: input.mode ?? "control" }
          // The screen as it is, at the size it is.
          yield sent({
            terminalId,
            sequence: (sequence += 1),
            type: "snapshot",
            data: (screens.get(terminalId) ?? []).join(""),
            cols: summary.cols,
            rows: summary.rows,
            exit: null,
          })
          for (;;) {
            // eslint-disable-next-line no-await-in-loop -- Output goes out in order.
            const result = await nextOrAbort(events.iterator.next(), signal)
            if (!result || result.done) return
            yield sent(result.value)
          }
        } finally {
          held.delete(events)
          streaming -= 1
        }
      }),
      write: api.terminals.write.handler(({ input: { terminalId, data } }) => {
        typed.push({ terminalId, data })
      }),
      // As the runner does: the terminal takes the size, the watch announces it, then its
      // streams hear of it, the same size included.
      resize: api.terminals.resize.handler(({ input: { terminalId, cols, rows } }) => {
        const current = summaries.get(terminalId)
        if (!current) throw new ORPCError("TERMINAL_NOT_FOUND", { status: 404 })
        const terminal = { ...current, cols, rows }
        summaries.set(terminalId, terminal)
        announce({ type: "changed", terminal })
        toStreams(terminalId, {
          terminalId,
          sequence: (sequence += 1),
          type: "resized",
          cols,
          rows,
        })
      }),
      ack: api.terminals.ack.handler(() => {}),
      // As the runner does: a terminal it has goes, and watchers hear of it; one it doesn't
      // is not found.
      close: api.terminals.close.handler(({ input: { terminalId } }) => {
        if (!summaries.has(terminalId)) throw new ORPCError("TERMINAL_NOT_FOUND", { status: 404 })
        remove(terminalId)
      }),
      rename: api.terminals.rename.handler(unplayed("terminals.rename")),
      resetTitle: api.terminals.resetTitle.handler(unplayed("terminals.resetTitle")),
      upload: api.terminals.upload.handler(unplayed("terminals.upload")),
      restart: api.terminals.restart.handler(unplayed("terminals.restart")),
    },
    agents: {
      list: api.agents.list.handler(() => [
        { agent: "claude" as const, available: true, connected: true },
      ]),
      detail: api.agents.detail.handler(idle),
      transcript: api.agents.transcript.handler(idle),
      prompt: api.agents.prompt.handler(unplayed("agents.prompt")),
      answer: api.agents.answer.handler(unplayed("agents.answer")),
      interrupt: api.agents.interrupt.handler(unplayed("agents.interrupt")),
      set: api.agents.set.handler(unplayed("agents.set")),
    },
    companions: {
      list: api.companions.list.handler(() => ({ items: [], windows: [] })),
      watch: api.companions.watch.handler(idle),
      content: api.companions.content.handler(unplayed("companions.content")),
      save: api.companions.save.handler(unplayed("companions.save")),
      attach: api.companions.attach.handler(unplayed("companions.attach")),
      move: api.companions.move.handler(unplayed("companions.move")),
      undock: api.companions.undock.handler(unplayed("companions.undock")),
      close: api.companions.close.handler(unplayed("companions.close")),
      renameWindow: api.companions.renameWindow.handler(unplayed("companions.renameWindow")),
      resetWindowTitle: api.companions.resetWindowTitle.handler(
        unplayed("companions.resetWindowTitle"),
      ),
    },
    asks: {
      list: api.asks.list.handler(unplayed("asks.list")),
      watch: api.asks.watch.handler(idle),
      answer: api.asks.answer.handler(unplayed("asks.answer")),
      read: api.asks.read.handler(unplayed("asks.read")),
    },
    messages: {
      list: api.messages.list.handler(unplayed("messages.list")),
      watch: api.messages.watch.handler(idle),
      pause: api.messages.pause.handler(unplayed("messages.pause")),
      release: api.messages.release.handler(unplayed("messages.release")),
      stop: api.messages.stop.handler(unplayed("messages.stop")),
    },
    voice: {
      watch: api.voice.watch.handler(idle),
      install: api.voice.install.handler(unplayed("voice.install")),
      cancel: api.voice.cancel.handler(unplayed("voice.cancel")),
      uninstall: api.voice.uninstall.handler(unplayed("voice.uninstall")),
      set: api.voice.set.handler(unplayed("voice.set")),
      record: api.voice.record.handler(unplayed("voice.record")),
      transcribe: api.voice.transcribe.handler(unplayed("voice.transcribe")),
      discard: api.voice.discard.handler(unplayed("voice.discard")),
    },
    murmur: {
      watch: api.murmur.watch.handler(idle),
      install: api.murmur.install.handler(unplayed("murmur.install")),
      cancel: api.murmur.cancel.handler(unplayed("murmur.cancel")),
      uninstall: api.murmur.uninstall.handler(unplayed("murmur.uninstall")),
      set: api.murmur.set.handler(unplayed("murmur.set")),
      noteOffered: api.murmur.noteOffered.handler(unplayed("murmur.noteOffered")),
      gist: api.murmur.gist.handler(unplayed("murmur.gist")),
    },
    settings: {
      get: api.settings.get.handler(() => ({ transcripts: true, welcomed: true })),
      set: api.settings.set.handler(() => {}),
    },
  })
  // What the app typed into the terminals.
  const typed: { terminalId: string; data: string }[] = []
  let connections = 0
  const connect = (signal: AbortSignal, theme: ThemeSource) => {
    const [server, client] = memoryPorts()
    connections += 1
    server.addEventListener("close", () => (connections -= 1))
    new RPCHandler(router).upgrade(server, { context: {} })
    return connectRunnerBackend(signal, () => {}, {
      transport: () => messagePort(client),
      theme,
    })
  }
  return {
    terminalIds,
    // Connects the app to the runner, as the desktop app does to its own.
    connect,
    // Changes a terminal as the runner reports it, as a status-line tick does.
    report: (
      terminalId: string,
      change: (summary: TerminalSummary) => Partial<TerminalSummary>,
    ) => {
      const current = summaries.get(terminalId)!
      const terminal = { ...current, ...change(current) }
      summaries.set(terminalId, terminal)
      announce({ type: "changed", terminal })
    },
    // Closes every terminal, as another window closing them would: the app lets go of
    // their screens and streams.
    closeAll: () => [...summaries.keys()].forEach(remove),
    // Writes output to the terminal's screen and every stream attached to it.
    write: (terminalId: string, data: string) => {
      written += encoder.encode(data).length
      screens.set(terminalId, [...(screens.get(terminalId) ?? []), data].slice(-screenRows))
      toStreams(terminalId, { terminalId, sequence: (sequence += 1), type: "output", data })
    },
    // The bytes the terminals' streams have sent the UI, snapshots included.
    bytes: () => bytes,
    // The bytes written to the terminals' screens, whoever streams them.
    written: () => written,
    // What the app typed into the terminals, in order.
    typed: (): readonly { readonly terminalId: string; readonly data: string }[] => typed,
    // How many terminals' streams are attached now.
    streaming: () => streaming,
    // How many streams have attached, over the runner's life.
    attaches: () => attaches,
    // Whether a connection is open.
    connected: () => connections > 0,
    // The procedures the app called that the script doesn't play.
    unscripted: (): readonly string[] => unscripted,
  }
}
