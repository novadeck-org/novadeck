import { MessageChannel } from "node:worker_threads"

import {
  connectRunner,
  messagePort,
  type AttachedTerminal,
  type MessagePortLike,
  type Runner,
} from "@novadeck/protocol/client"
import { createRunner, servePort, type RunnerOptions } from "@novadeck/runner"

import type { RunnerApi } from "./backend"
import { loadListing } from "./index"
import type { RunnerListing } from "./seed"

// Test support: a real runner in this process, reached over a MessageChannel like the
// desktop app's, whose shells are a small program in a real PTY. Typing
// "exit <code>" ends it with that code; "kill <signal>" kills it with that signal;
// "title <name>" renames it, which Linux then
// reports as the terminal's foreground process.
const shell = [
  "process.stdin.setRawMode?.(true)",
  "let input = ''",
  "process.stdin.on('data', (data) => {",
  "  input += data",
  "  const title = /title (\\S+)[\\r\\n]/.exec(input)",
  "  if (title) { process.title = title[1]; input = '' }",
  "  const exit = /exit (\\d+)[\\r\\n]/.exec(input)",
  "  if (exit) process.exit(Number(exit[1]))",
  "  const kill = /kill (SIG[A-Z]+)[\\r\\n]/.exec(input)",
  "  if (kill) process.kill(process.pid, kill[1])",
  "})",
].join("\n")

export type TestRunner = {
  readonly client: Runner
  readonly listing: RunnerListing
  // Lists again, as a reload would.
  readonly reload: () => Promise<RunnerListing>
  // Cuts the current link and resolves once the client noticed; it reconnects over a
  // fresh port shortly after.
  readonly drop: () => Promise<void>
  readonly close: () => Promise<void>
}

export const startTestRunner = async (options: RunnerOptions = {}): Promise<TestRunner> => {
  const service = createRunner({
    ...options,
    terminals: {
      maxTerminals: 256,
      ...options.terminals,
      shell: process.execPath,
      shellArgs: ["-e", shell],
    },
  })
  const links = new Set<() => void>()
  let current: (() => void) | undefined
  // A fresh port for every connection, as the desktop host hands out.
  const connect = (): Promise<MessagePortLike> => {
    const { port1, port2 } = new MessageChannel()
    const dispose = servePort(service, port1)
    links.add(dispose)
    current = dispose
    return Promise.resolve(port2)
  }
  const client = await connectRunner(messagePort(connect), { retryDelay: () => 200 })
  const reload = () => loadListing(client, () => crypto.randomUUID(), Date.now)
  return {
    client,
    listing: await reload(),
    reload,
    drop: async () => {
      current?.()
      for await (const status of client.watch()) if (status.state === "reconnecting") return
    },
    close: async () => {
      await client.close()
      for (const dispose of links) dispose()
      await service.close()
    },
  }
}

// What xterm answers on its own to the shell's output: focus reports and colours. On
// Windows, ConPTY turns focus reports on as the shell starts, sometimes only after the
// terminal is shown, and xterm reports its focus at once; that is the shell's doing,
// not the surface's.
// oxlint-disable-next-line no-control-regex
const replies = /^\u001b(\[[IO]|\]1[0-2];rgb:[^\u0007\u001b]*(\u0007|\u001b\\))$/

// The runner client, noting each call that reaches the runner in `io`, apart from
// xterm's own replies.
export const recordingRunner = (runner: Runner, io: string[]): RunnerApi => {
  const note = <T>(entry: string, call: () => Promise<T>): Promise<T> => {
    io.push(entry)
    return call()
  }
  const attachment = (attached: AttachedTerminal): AttachedTerminal => {
    const wrapped: AttachedTerminal = {
      id: attached.id,
      mode: attached.mode,
      [Symbol.asyncIterator]: () => wrapped,
      next: () => attached.next(),
      return: async () => {
        await attached.detach()
        return { done: true, value: undefined }
      },
      write: (data) =>
        replies.test(data)
          ? attached.write(data)
          : note(`write ${attached.id}`, () => attached.write(data)),
      resize: (size) => note(`resize ${attached.id}`, () => attached.resize(size)),
      detach: () => attached.detach(),
    }
    return wrapped
  }
  return {
    watch: () => runner.watch(),
    projects: {
      list: () => runner.projects.list(),
      create: (input) => note(`create project ${input.id}`, () => runner.projects.create(input)),
      rename: (input) => runner.projects.rename(input),
    },
    sessions: {
      list: (input) => runner.sessions.list(input),
      create: (input) => note(`create session ${input.id}`, () => runner.sessions.create(input)),
      rename: (input) => runner.sessions.rename(input),
      save: (input) => note(`save ${input.sessionId}`, () => runner.sessions.save(input)),
    },
    terminals: {
      list: (input) => runner.terminals.list(input),
      watch: () => runner.terminals.watch(),
      create: (input) => note(`create terminal ${input.id}`, () => runner.terminals.create(input)),
      close: (id) => note(`close ${id}`, () => runner.terminals.close(id)),
      restart: (id, size) => note(`restart ${id}`, () => runner.terminals.restart(id, size)),
      attach: async (id, options) =>
        attachment(await note(`attach ${id}`, () => runner.terminals.attach(id, options))),
    },
    agents: {
      list: () => runner.agents.list(),
      detail: (terminalId) => runner.agents.detail(terminalId),
      transcript: (terminalId, actor) => runner.agents.transcript(terminalId, actor),
      plan: (terminalId, plan) => runner.agents.plan(terminalId, plan),
      shown: (terminalId) => runner.agents.shown(terminalId),
      artifact: (terminalId, artifact) => runner.agents.artifact(terminalId, artifact),
      set: (agent, connected) =>
        note(`agent ${agent} ${connected}`, () => runner.agents.set(agent, connected)),
    },
    settings: {
      get: () => runner.settings.get(),
      set: (settings) =>
        note(`settings ${JSON.stringify(settings)}`, () => runner.settings.set(settings)),
    },
  }
}

// Types into a terminal from `client`, which must be allowed to control it.
export const typeInto = async (client: Runner, terminalId: string, text: string): Promise<void> => {
  const attached = await client.terminals.attach(terminalId)
  try {
    await attached.write(text)
  } finally {
    await attached.detach()
  }
}
