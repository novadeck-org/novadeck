import { randomUUID } from "node:crypto"
import { join } from "node:path"

import type { AgentName, TerminalMessages, TerminalSummary } from "@novadeck/protocol"
import headless from "@xterm/headless"

import { wire } from "../runner.js"
import type { Terminals } from "../terminals/index.js"
import type { WorkspaceStore } from "../workspaces/store.js"
import { createHistory, type Reach, type ReachOptions, type Snapshot } from "./history.js"

/** The client the deck drives terminals as: it creates them, so it controls them. */
const owner = "e2e"

/**
 * A snapshot's visible rows as plain text, as the person would read them: the snapshot
 * draws spaces as cursor moves and colours as escapes, so it is replayed on a screen of
 * its own.
 */
const render = async (snapshot: string, cols: number, rows: number): Promise<string> => {
  const screen = new headless.Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
  try {
    await new Promise<void>((resolve) => screen.write(snapshot, resolve))
    const buffer = screen.buffer.active
    return Array.from({ length: rows }, (_, row) =>
      (buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").trimEnd(),
    ).join("\n")
  } finally {
    screen.dispose()
  }
}

/** One terminal of the deck, driven as the person would and read as a client would. */
export type DeckTerminal = {
  readonly id: string
  /** Its handle, as agents name it to each other: `t1`, `t2`… */
  readonly handle: string
  /** Its screen's text now. */
  readonly screen: () => Promise<string>
  /** Waits until its screen shows the text, and returns the screen. */
  readonly until: (text: string | RegExp, timeoutMs?: number) => Promise<string>
  /**
   * Types the text, waits for it to show once more than it did before, then presses
   * Enter: Enter only ever follows text seen to land, so it can't confirm a dialog or
   * pick from a menu.
   */
  readonly submit: (text: string) => Promise<void>
  /**
   * The one deliberate way to confirm a dialog or pick from a menu: counts what the screen
   * shows of `shows`, the option or dialog expected, runs `trigger`, the action that brings
   * it up, then waits until it shows once more and presses Enter. Text left from an
   * earlier dialog can't let it through, and a dialog drawn before `trigger` returns isn't
   * missed.
   */
  readonly confirm: (
    shows: string | RegExp,
    trigger: () => Promise<unknown>,
    options?: { readonly timeoutMs?: number },
  ) => Promise<void>
  /**
   * Sends keys other than Enter, such as Escape (`\x1b`), as typed. Anything holding a
   * carriage return or line feed, the keypad's Enter (`\x1bOM`) or the kitty keyboard
   * protocol's (`\x1b[13u`, `\x1b[13;…u`), is refused: `submit` and `confirm` press it.
   */
  readonly press: (keys: string) => void
  /** What a client's terminal listing says of it now: its agent and that agent's activity. */
  readonly summary: () => TerminalSummary
  /** Its messages and how its agent can take one now. */
  readonly messages: () => TerminalMessages
  /**
   * Every change to its messages and delivery state since it opened, in order, as a
   * client watching them saw it, so no state between two looks is missed.
   */
  readonly history: () => readonly Snapshot[]
  /** How far its history goes now: a cursor `reached` takes as `after`. */
  readonly mark: () => number
  /**
   * Waits until its history holds a snapshot from `after` on that is in the state asked
   * for, or passes the test, and returns it; at once if one already does. On timeout it
   * fails with the delivery states it went through from the mark on.
   */
  readonly reached: (what: Reach, options?: ReachOptions) => Promise<Snapshot>
}

export type Deck = {
  readonly terminals: Terminals
  readonly store: WorkspaceStore
  readonly sessionId: string
  /** Installs NovaDeck's plugin into the harness through its own commands, as Connect does. */
  readonly connect: (agent: AgentName) => Promise<void>
  /** Opens a terminal in the project that runs `command` at its shell's first prompt. */
  readonly open: (command?: string) => Promise<DeckTerminal>
  readonly close: () => Promise<void>
}

export type DeckOptions = {
  /** The data folder: the workspace's database and NovaDeck's shell files. */
  readonly data: string
  /** The project folder terminals open in. */
  readonly project: string
  /** The whole environment of every process the deck starts. */
  readonly env: Readonly<Record<string, string>>
}

/** How many times the text, or a match of the pattern, appears on the screen. */
export const occurrences = (shown: string, text: string | RegExp): number =>
  typeof text === "string"
    ? shown.split(text).length - 1
    : (shown.match(
        new RegExp(text.source, text.flags.includes("g") ? text.flags : `${text.flags}g`),
      )?.length ?? 0)

/** What `enterAfter` needs of a terminal: its handle, its screen, and its Enter key. */
export type Screen = {
  readonly handle: string
  readonly screen: () => Promise<string>
  readonly enter: () => void
}

/**
 * Counts what the screen shows of `shows`, runs `trigger`, waits until the screen shows it
 * once more, and only then presses Enter: Enter follows only what `trigger` was seen to
 * bring, never what was there before it. Fails after the timeout, with the screen.
 */
export const enterAfter = async (
  { handle, screen, enter }: Screen,
  shows: string | RegExp,
  trigger: () => Promise<unknown>,
  timeoutMs = 30_000,
): Promise<void> => {
  const before = occurrences(await screen(), shows)
  await trigger()
  await poll(
    async () => (occurrences(await screen(), shows) > before ? true : undefined),
    `${handle} to show ${String(shows)} once more`,
    timeoutMs,
  ).catch(async (error: unknown) => {
    throw new Error(`${(error as Error).message}. Its screen:\n${await screen()}`)
  })
  enter()
}

/**
 * Polls `read` until it gives a value, and returns it; fails with `what` after the
 * timeout, read then when it's a function, so it can say how things stand at the end.
 */
export const poll = async <T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string | (() => string),
  timeoutMs = 30_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- Polls until the value comes.
    const value = await read()
    if (value !== undefined) return value
    // eslint-disable-next-line no-await-in-loop -- As above.
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for ${typeof what === "string" ? what : what()}`,
  )
}

/**
 * A runner's store, terminals and harness connections, in process, for one test: wired by
 * the runner's own `wire`, with every process the deck starts given exactly `env`, so
 * nothing of the developer's reaches a shell.
 */
export const createDeck = async (options: DeckOptions): Promise<Deck> => {
  const { store, shellFiles, agents, terminals } = wire({
    database: join(options.data, "workspace.sqlite"),
    shell: join(options.data, "shell"),
    // Plugin commands run with the sandbox's environment as it is: a login shell's startup
    // files, even the system's own in /etc/profile, could put another PATH before the
    // pinned harnesses.
    agents: { env: options.env, home: options.env.HOME!, login: false },
    terminals: { shell: "/bin/bash", baseEnv: options.env },
  })
  // The runner carries on without its shell files; a test can't, as no agent would report.
  if ((await shellFiles) === undefined) {
    await terminals.shutdown()
    store.close()
    throw new Error("NovaDeck's shell files could not be written")
  }
  const project = await store.createProject({ id: randomUUID(), name: "E2E", cwd: options.project })
  const session = store.createSession({ id: randomUUID(), projectId: project.id, name: "E2E" })

  const screen = async (terminalId: string): Promise<string> => {
    const controller = new AbortController()
    const stream = terminals.attach({ terminalId, mode: "observe" }, "reader", controller.signal)
    try {
      for await (const event of stream) {
        if (event.type !== "snapshot") continue
        const { cols, rows } = terminals.get(terminalId)
        return await render(event.data, cols, rows)
      }
      return ""
    } finally {
      controller.abort()
      await stream.return(undefined)
    }
  }

  // Every terminal's watch of its messages, until the deck closes.
  const watching = new AbortController()

  const terminal = async (summary: TerminalSummary): Promise<DeckTerminal> => {
    const id = summary.id
    const history = createHistory(summary.handle)
    void (async () => {
      try {
        for await (const listing of terminals.watchMessages(id, watching.signal))
          history.push(listing)
        history.end(watching.signal.aborted ? "the deck closed" : "its terminal is gone")
      } catch (error) {
        history.end(`its messages can't be watched: ${(error as Error).message}`)
      }
    })()
    // The watch's first listing is the terminal's state as it opened.
    await history.reached(() => true, { timeoutMs: 5000 })
    // Waits until the screen passes `shows`, and returns it.
    const showing = (shows: (shown: string) => boolean, what: string, timeoutMs = 30_000) =>
      poll(
        async () => {
          const shown = await screen(id)
          return shows(shown) ? shown : undefined
        },
        `${summary.handle} to show ${what}`,
        timeoutMs,
      ).catch(async (error: unknown) => {
        throw new Error(`${(error as Error).message}. Its screen:\n${await screen(id)}`)
      })
    const view: Screen = {
      handle: summary.handle,
      screen: () => screen(id),
      enter: () => terminals.write({ terminalId: id, data: "\r" }, owner),
    }
    const until = (text: string | RegExp, timeoutMs = 30_000) =>
      showing(
        (shown) => (typeof text === "string" ? shown.includes(text) : text.test(shown)),
        String(text),
        timeoutMs,
      )
    return {
      id,
      handle: summary.handle,
      screen: () => screen(id),
      until,
      // The text may be on screen already, as an earlier prompt: only one more of it
      // shows that this one landed.
      submit: async (text) => {
        if (/[\r\n]/.test(text)) throw new Error("A prompt is one line")
        await enterAfter(view, text, async () =>
          terminals.write({ terminalId: id, data: text }, owner),
        )
      },
      confirm: (shows, trigger, { timeoutMs } = {}) => enterAfter(view, shows, trigger, timeoutMs),
      press: (keys) => {
        // eslint-disable-next-line no-control-regex -- Enter's escape sequences start with ESC.
        if (/[\r\n]|\x1bOM|\x1b\[13[;u]/.test(keys))
          throw new Error("Enter only follows text or a dialog seen: use submit or confirm")
        terminals.write({ terminalId: id, data: keys }, owner)
      },
      summary: () => terminals.get(id),
      messages: () => terminals.messages(id),
      history: history.snapshots,
      mark: history.mark,
      reached: history.reached,
    }
  }

  return {
    terminals,
    store,
    sessionId: session.id,
    connect: async (agent) => {
      const result = await agents.set(agent, true)
      if (!result.connected) throw new Error(`${agent} did not connect`)
    },
    open: async (command) =>
      terminal(
        await terminals.create(
          {
            id: randomUUID(),
            sessionId: session.id,
            cwd: options.project,
            cols: 120,
            rows: 40,
            ...(command !== undefined && { command }),
          },
          owner,
        ),
      ),
    close: async () => {
      watching.abort()
      try {
        await terminals.shutdown()
      } finally {
        store.close()
      }
    },
  }
}
