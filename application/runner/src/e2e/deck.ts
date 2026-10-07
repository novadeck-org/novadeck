import { randomUUID } from "node:crypto"
import { join } from "node:path"

import type {
  AgentActivity,
  AgentDetail,
  AgentName,
  InterruptResult,
  TerminalMessages,
  TerminalRequest,
  TerminalSummary,
  TranscriptChange,
  TranscriptItem,
} from "@novadeck/protocol"
import headless from "@xterm/headless"

import { wire } from "../runner.js"
import { shellPaths, type ShellPaths } from "../shell/scripts.js"
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
  const screen = new headless.Terminal({
    cols,
    rows,
    scrollback: 0,
    allowProposedApi: true,
  })
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
  /**
   * Presses Escape on its own: sends `keys` (`\x1b` unless given),
   * and resolves only `escapeWindowMs` later. Escapes go one at a time, each waiting for
   * the one before, so two `escape()` calls never reach the TUI as one Esc-Esc, even
   * unawaited. Like `press`, it refuses Enter.
   */
  readonly escape: (keys?: string) => Promise<void>
  /** Resizes its window, as the app does whenever its pane changes size. */
  readonly resize: (cols: number, rows: number) => void
  /**
   * The one deliberate Enter besides `submit` and `confirm`: a bare Enter on a box known
   * empty, mid-turn. It goes only while the turn of the prompt this terminal last
   * submitted is working, with nothing sent to the terminal since that prompt's Enter;
   * otherwise it throws, sending nothing.
   */
  readonly enterEmpty: () => void
  /**
   * Polls `read` until it gives a value, as `poll` does, for something of this terminal;
   * a failure says what its agent is doing and shows its screen.
   */
  readonly poll: <T>(
    read: () => T | undefined | Promise<T | undefined>,
    what: string,
    timeoutMs?: number,
  ) => Promise<T>
  /**
   * Gives its agent a prompt as the chat does, `agents.prompt`: pasted into its box, and
   * Enter once it shows; resolves once that Enter is out, rejects as the call would.
   */
  readonly prompt: (text: string) => Promise<void>
  /** Presses Escape in its agent as the chat does, `agents.interrupt`. */
  readonly interrupt: () => Promise<InterruptResult>
  /**
   * The items of its root actor's transcript as `agents.transcript` gives them now, read
   * as a client does with the root's ref from `agents.detail`; empty before a session binds.
   */
  readonly transcript: () => Promise<readonly TranscriptItem[]>
  /** What a client's terminal listing says of it now: its agent and that agent's activity. */
  readonly summary: () => TerminalSummary
  /** Its messages and how its agent can take one now. */
  readonly messages: () => TerminalMessages
  /**
   * What Novadeck knows of its agent now, as a client's detail view reads it: the session
   * bound, its activity, and the requests it waits on the person for.
   */
  readonly detail: () => Promise<AgentDetail>
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
   * fails with the delivery states it went through from the mark on, and its screen.
   */
  readonly reached: (what: Reach, options?: ReachOptions) => Promise<Snapshot>
}

export type Deck = {
  /** The terminals of the runner wired now: a restart replaces them. */
  readonly terminals: Terminals
  /** The store of the runner wired now: a restart opens it again. */
  readonly store: WorkspaceStore
  readonly sessionId: string
  /** Novadeck's shell files, as its shells read them: the same across restarts. */
  readonly shell: ShellPaths
  /** Installs Novadeck's plugin into the harness through its own commands, as Connect does. */
  readonly connect: (agent: AgentName) => Promise<void>
  /** Opens a terminal in the project that runs `command` at its shell's first prompt. */
  readonly open: (command?: string) => Promise<DeckTerminal>
  /**
   * Starts a saved terminal again, as the app does for each terminal it shows once the
   * runner has restarted: `terminals.create` with its id and `restore`, and with `resume`
   * the agent that ran there, which the runner resumes in the session that agent last
   * reported in it, from the new shell's own startup. Without `resume`, or should the
   * runner not resume it, the shell starts plain with its transcript above it.
   */
  readonly restore: (
    terminal: Pick<DeckTerminal, "id">,
    options?: { readonly resume?: AgentName },
  ) => Promise<DeckTerminal>
  /**
   * Answers agents' requests for a new terminal (`open_terminal`) as the app does: opens
   * one in the request's folder, starting its command, created for the request, and
   * answers with it once its shell has started. It answers every request from the call
   * on, across restarts, until the deck closes, and gives the terminals it opened in the
   * order they opened.
   */
  readonly answerRequests: () => Requests
  /**
   * Closes the runner as Novadeck does when it quits, saving every terminal and ending
   * its shells, then wires another, as Novadeck starts again, on the same database, shell
   * folder and environment. Between the two it looks for processes the first left behind
   * (`DeckOptions.leftovers`), and fails, as a leak, should it find any. Terminals of the
   * first runner are gone; their saved records stay for `restore`.
   */
  readonly restart: () => Promise<void>
  readonly close: () => Promise<void>
}

/** The terminals the deck opened for agents' requests. */
export type Requests = {
  /**
   * The next terminal opened for a request that no earlier call took, once it opens;
   * fails should opening it have failed, or after the timeout (a minute unless given).
   */
  readonly next: (timeoutMs?: number) => Promise<DeckTerminal>
}

export type DeckOptions = {
  /** The data folder: the workspace's database and Novadeck's shell files. */
  readonly data: string
  /** The project folder terminals open in. */
  readonly project: string
  /** The whole environment of every process the deck starts. */
  readonly env: Readonly<Record<string, string>>
  /**
   * Ends what a closed runner left running, and names each process it had to end; a
   * restart fails on any. Without it, a restart looks for nothing.
   */
  readonly leftovers?: () => Promise<readonly string[]>
}

/**
 * How long `escape` waits after its keys: past the window in which a TUI reads a second
 * Escape as Esc-Esc rather than two presses. Claude Code 2.1.287's is about 800 ms: two
 * Escapes 300 or 700 ms apart opened its Rewind picker, 1000 or 1500 ms apart didn't
 * (probed in the sandbox). That also covers the far shorter wait a TUI gives a lone ESC
 * byte before taking it as Escape rather than the start of a sequence.
 */
export const escapeWindowMs = 1200

// Enter's keys, as `press` and `escape` refuse them: a carriage return or line feed, the
// keypad's Enter or the kitty keyboard protocol's.
// eslint-disable-next-line no-control-regex -- Enter's escape sequences start with ESC.
const enterKeys = /[\r\n]|\x1bOM|\x1b\[13[;u]/

const refuseEnter = (keys: string): void => {
  if (enterKeys.test(keys))
    throw new Error("Enter only follows text or a dialog seen: use submit or confirm")
}

/**
 * A terminal's `escape`: writes each press's keys (`\x1b` unless given) only once the
 * press before has waited out `windowMs`, and resolves once its own has, so presses never
 * come closer than that, awaited or not. Refuses Enter, as `press` does.
 */
export const escaper = (write: (keys: string) => void, windowMs = escapeWindowMs) => {
  let last: Promise<void> = Promise.resolve()
  return (keys = "\x1b"): Promise<void> => {
    refuseEnter(keys)
    const pressed = last.then(async () => {
      write(keys)
      await new Promise((resolve) => setTimeout(resolve, windowMs))
    })
    last = pressed.catch(() => {})
    return pressed
  }
}

/**
 * Why `enterEmpty` mustn't press Enter now, or undefined when it may: `prompted` is where
 * the history stood as the terminal's last prompt was submitted, undefined once anything
 * else was sent to it since (or before any prompt). It may only while that prompt's turn
 * has been working ever since it started, and still is.
 */
export const emptyEnterRefusal = (
  prompted: number | undefined,
  snapshots: readonly Pick<Snapshot, "delivery">[],
): string | undefined => {
  if (prompted === undefined)
    return "A bare Enter goes only on a box known empty: submit a prompt, then send nothing else"
  const since = snapshots.slice(prompted)
  const started = since.findIndex((one) => one.delivery === "working")
  if (started < 0 || since.slice(started).some((one) => one.delivery !== "working"))
    return "A bare Enter goes only while the turn of the prompt submitted is working"
  return undefined
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
  /** What its agent is doing, as a failure states it. */
  readonly state?: () => string
}

/**
 * A screen as a failure quotes it: its non-blank rows, the last `rows` of them at most,
 * saying how many came before those.
 */
export const excerpt = (shown: string, rows = 30): string => {
  const lines = shown.split("\n").filter((line) => line.trim() !== "")
  if (lines.length === 0) return "(blank)"
  const above = lines.length - rows
  return [...(above > 0 ? [`(${above} more rows above)`] : []), ...lines.slice(-rows)].join("\n")
}

/**
 * An agent's activity as a failed wait states it: its state and the requests waiting on
 * the person, `working, 1 request waiting (permission)`.
 */
export const stated = (activity: AgentActivity | null): string => {
  if (activity === null) return "no agent"
  const { pending, kind } = activity.attention
  const waiting =
    pending === 0
      ? "no request waiting"
      : `${pending} request${pending === 1 ? "" : "s"} waiting${kind === null ? "" : ` (${kind})`}`
  return `${activity.state}, ${waiting}`
}

// What a failure says of something it couldn't read.
const unread = (cause: unknown): string =>
  `(can't be read: ${cause instanceof Error ? cause.message : String(cause)})`

/**
 * A failed wait's error, its message followed by what the terminal's agent is doing
 * (`state`, when given) and its screen as it is now, so a timeout shows what the terminal
 * was doing instead; a screen that can't be read says why.
 */
export const withScreen = async (
  error: unknown,
  screen: () => Promise<string>,
  state?: () => string,
): Promise<Error> => {
  const message = error instanceof Error ? error.message : String(error)
  let doing = ""
  if (state)
    try {
      doing = `. Its agent: ${state()}`
    } catch (cause) {
      doing = `. Its agent: ${unread(cause)}`
    }
  const shown = await screen().then(excerpt, unread)
  return new Error(`${message}${doing}. Its screen:\n${shown}`, { cause: error })
}

/**
 * Counts what the screen shows of `shows`, runs `trigger`, waits until the screen shows it
 * once more, and only then presses Enter: Enter follows only what `trigger` was seen to
 * bring, never what was there before it. Fails after the timeout, with the screen.
 */
export const enterAfter = async (
  { handle, screen, enter, state }: Screen,
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
    throw await withScreen(error, screen, state)
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
 * Values as they arrive, each taken once, in order, by `next`: at once when one is
 * waiting, else as the next arrives. A failure arrives as a value does, and fails the
 * `next` that takes it.
 */
export const arrivals = <T>(what: string) => {
  type Arrival =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: Error }
  const waiting: Arrival[] = []
  const takers: ((arrival: Arrival) => void)[] = []
  const arrive = (arrival: Arrival) => {
    const taker = takers.shift()
    if (taker) taker(arrival)
    else waiting.push(arrival)
  }
  return {
    push: (value: T) => arrive({ ok: true, value }),
    fail: (error: Error) => arrive({ ok: false, error }),
    next: (timeoutMs = 60_000): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const settle = (arrival: Arrival) =>
          arrival.ok ? resolve(arrival.value) : reject(arrival.error)
        const first = waiting.shift()
        if (first) {
          settle(first)
          return
        }
        const taker = (arrival: Arrival) => {
          clearTimeout(timer)
          settle(arrival)
        }
        const timer = setTimeout(() => {
          takers.splice(takers.indexOf(taker), 1)
          reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`))
        }, timeoutMs)
        takers.push(taker)
      }),
  }
}

/** One runner the deck wired, from `wire` until it closes. */
type Runner = {
  readonly store: WorkspaceStore
  readonly agents: ReturnType<typeof wire>["agents"]
  readonly terminals: Terminals
  /** Aborts as the runner closes, ending every watch of it. */
  readonly closing: AbortController
}

// Closes the runner, once: ends every watch of it, saves and ends its terminals.
const stop = async (runner: Runner): Promise<void> => {
  if (runner.closing.signal.aborted) return
  runner.closing.abort()
  try {
    await runner.terminals.shutdown()
  } finally {
    runner.store.close()
  }
}

/**
 * The items a transcript stream holds now: what it sent until it had nothing more to say
 * for `quietMs`.
 */
const itemsNow = async (
  stream: (signal: AbortSignal) => AsyncGenerator<TranscriptChange>,
  quietMs = 300,
): Promise<TranscriptItem[]> => {
  const controller = new AbortController()
  const changes = stream(controller.signal)
  const items: TranscriptItem[] = []
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- Changes are taken in order.
      const next = await Promise.race([
        changes.next(),
        new Promise<undefined>((resolve) => setTimeout(resolve, quietMs)),
      ])
      if (next === undefined || next.done) return items
      if (next.value.type === "reset") items.length = 0
      else items.push(...next.value.items)
    }
  } finally {
    controller.abort()
    await changes.return(undefined)
  }
}

// The first of a stream's snapshots: how things stand now.
const now = async <T>(stream: (signal: AbortSignal) => AsyncGenerator<T>): Promise<T> => {
  const controller = new AbortController()
  const snapshots = stream(controller.signal)
  try {
    const first = await snapshots.next()
    if (first.done) throw new Error("The stream ended before its first snapshot")
    return first.value
  } finally {
    controller.abort()
    await snapshots.return(undefined)
  }
}

/**
 * A runner's store, terminals and harness connections, in process, for one test: wired by
 * the runner's own `wire`, with every process the deck starts given exactly `env`, so
 * nothing of the developer's reaches a shell. A restart wires another on the same files.
 */
export const createDeck = async (options: DeckOptions): Promise<Deck> => {
  const shellFolder = join(options.data, "shell")
  const start = async (): Promise<Runner> => {
    const { store, shellFiles, agents, terminals } = wire({
      database: join(options.data, "workspace.sqlite"),
      shell: shellFolder,
      // Plugin commands run with the sandbox's environment as it is: a login shell's
      // startup files, even the system's own in /etc/profile, could put another PATH
      // before the pinned harnesses.
      agents: { env: options.env, home: options.env.HOME!, login: false },
      terminals: { shell: "/bin/bash", baseEnv: options.env },
    })
    // The runner carries on without its shell files; a test can't, as no agent would report.
    if ((await shellFiles) === undefined) {
      await terminals.shutdown()
      store.close()
      throw new Error("Novadeck's shell files could not be written")
    }
    return { store, agents, terminals, closing: new AbortController() }
  }

  let runner = await start()
  const project = await runner.store.createProject({
    id: randomUUID(),
    name: "E2E",
    cwd: options.project,
  })
  const session = runner.store.createSession({
    id: randomUUID(),
    projectId: project.id,
    name: "E2E",
  })

  const screen = async ({ terminals }: Runner, terminalId: string): Promise<string> => {
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

  const terminal = async (on: Runner, summary: TerminalSummary): Promise<DeckTerminal> => {
    const { terminals } = on
    const id = summary.id
    const history = createHistory(summary.handle)
    // Its screen, read one look at a time: a terminal takes one reader at once, and a
    // failed wait may look while another wait still polls.
    let looking: Promise<unknown> = Promise.resolve()
    const look = (): Promise<string> => {
      const shown = looking.then(() => screen(on, id))
      looking = shown.catch(() => {})
      return shown
    }
    void (async () => {
      try {
        for await (const listing of terminals.watchMessages(id, on.closing.signal))
          history.push(listing)
        history.end(on.closing.signal.aborted ? "its runner closed" : "its terminal is gone")
      } catch (error) {
        history.end(`its messages can't be watched: ${(error as Error).message}`)
      }
    })()
    const state = () => stated(terminals.get(id).activity)
    // A failed wait's error, with what its agent is doing and its screen.
    const explain = (error: unknown) => withScreen(error, look, state)
    // The watch's first listing is the terminal's state as it opened.
    await history.reached(() => true, { timeoutMs: 5000 })
    // Waits until the screen passes `shows`, and returns it.
    const showing = (shows: (shown: string) => boolean, what: string, timeoutMs = 30_000) =>
      poll(
        async () => {
          const shown = await look()
          return shows(shown) ? shown : undefined
        },
        `${summary.handle} to show ${what}`,
        timeoutMs,
      ).catch(async (error: unknown) => {
        throw await explain(error)
      })
    const write = (data: string) => terminals.write({ terminalId: id, data }, owner)
    // Where its history stood as its last prompt was submitted, while nothing else has
    // been sent to it since: what `enterEmpty` needs to know the box is empty.
    let prompted: number | undefined
    const send = (data: string) => {
      prompted = undefined
      write(data)
    }
    const view: Screen = {
      handle: summary.handle,
      screen: look,
      enter: () => send("\r"),
      state,
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
      screen: look,
      until,
      // The text may be on screen already, as an earlier prompt: only one more of it
      // shows that this one landed.
      submit: async (text) => {
        if (/[\r\n]/.test(text)) throw new Error("A prompt is one line")
        const entered = {
          ...view,
          enter: () => {
            write("\r")
            prompted = history.mark()
          },
        }
        await enterAfter(entered, text, async () => send(text))
      },
      confirm: (shows, trigger, { timeoutMs } = {}) => enterAfter(view, shows, trigger, timeoutMs),
      press: (keys) => {
        refuseEnter(keys)
        send(keys)
      },
      escape: escaper(send),
      resize: (cols, rows) => terminals.resize({ terminalId: id, cols, rows }, owner),
      enterEmpty: () => {
        const refusal = emptyEnterRefusal(prompted, history.snapshots())
        if (refusal) throw new Error(refusal)
        write("\r")
      },
      poll: (read, what, timeoutMs) =>
        poll(read, `${summary.handle}: ${what}`, timeoutMs).catch(async (error: unknown) => {
          throw await explain(error)
        }),
      summary: () => terminals.get(id),
      messages: () => terminals.messages(id),
      prompt: async (text) => {
        prompted = undefined
        await terminals.prompt({ terminalId: id, text })
      },
      interrupt: async () => {
        prompted = undefined
        return await terminals.interrupt({ terminalId: id })
      },
      transcript: async () => {
        const detail = await now((signal) => terminals.detail(id, signal))
        const root = detail.actors.find((actor) => actor.role === "root")
        if (!root) return []
        return itemsNow((signal) => terminals.transcript(id, root.ref, signal))
      },
      detail: () => now((signal) => terminals.detail(id, signal)),
      history: history.snapshots,
      mark: history.mark,
      reached: (what, reach) =>
        history.reached(what, reach).catch(async (error: unknown) => {
          throw await explain(error)
        }),
    }
  }

  // Every terminal the deck opens is 120 by 40.
  const created = (on: Runner, input: Omit<Parameters<Terminals["create"]>[0], "cols" | "rows">) =>
    on.terminals.create({ ...input, cols: 120, rows: 40 }, owner)

  // Opens a terminal for an agent's request, as the app does, and answers the request with
  // it once its shell has started, or with why it couldn't.
  const respond = async (on: Runner, request: TerminalRequest): Promise<DeckTerminal> => {
    const { requestId } = request
    try {
      const opened = await terminal(
        on,
        await created(on, {
          id: randomUUID(),
          sessionId: request.sessionId,
          cwd: request.cwd,
          ...(request.command !== undefined && { command: request.command }),
          requestId,
        }),
      )
      on.terminals.answerRequest({ requestId, terminalId: opened.id }, owner)
      return opened
    } catch (error) {
      try {
        on.terminals.answerRequest({ requestId, reason: "The deck couldn't open it." }, owner)
      } catch {
        // The runner no longer waits for it.
      }
      throw error
    }
  }

  // The terminals opened for requests, once the test asks the deck to answer them.
  let requests: ReturnType<typeof arrivals<DeckTerminal>> | undefined
  // Follows the runner's requests until it closes, answering each.
  const answer = (on: Runner) => {
    const opened = requests
    if (!opened) return
    void (async () => {
      try {
        for await (const request of on.terminals.requests(owner, on.closing.signal))
          respond(on, request).then(opened.push, opened.fail)
      } catch (error) {
        if (!on.closing.signal.aborted) opened.fail(error as Error)
      }
    })()
  }

  return {
    get terminals() {
      return runner.terminals
    },
    get store() {
      return runner.store
    },
    sessionId: session.id,
    shell: shellPaths(shellFolder),
    connect: async (agent) => {
      const result = await runner.agents.set(agent, true)
      if (!result.connected) throw new Error(`${agent} did not connect`)
    },
    open: async (command) =>
      terminal(
        runner,
        await created(runner, {
          id: randomUUID(),
          sessionId: session.id,
          cwd: options.project,
          ...(command !== undefined && { command }),
        }),
      ),
    restore: async ({ id }, { resume } = {}) =>
      terminal(
        runner,
        await created(runner, {
          id,
          sessionId: session.id,
          // As the router gives a create without a folder; a saved terminal starts in its own.
          cwd: options.project,
          restore: true,
          ...(resume !== undefined && { resume }),
        }),
      ),
    answerRequests: () => {
      if (!requests) {
        requests = arrivals<DeckTerminal>("a terminal opened for an agent's request")
        answer(runner)
      }
      return { next: requests.next }
    },
    restart: async () => {
      await stop(runner)
      const left = (await options.leftovers?.()) ?? []
      if (left.length > 0)
        throw new Error(
          `process(es) outlived the runner as it restarted, ended before the next: ${left.join(", ")}`,
        )
      runner = await start()
      answer(runner)
    },
    close: () => stop(runner),
  }
}
