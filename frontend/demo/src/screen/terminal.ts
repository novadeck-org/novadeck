import type { ChatDialog, ChatItem, ChatRequest, Conversation } from "@novadeck/core/conversation"
import type { TerminalKey } from "@novadeck/core/port"
import type { Store } from "@novadeck/core/store"
import type { TerminalMetadata } from "@novadeck/core/types"

import type { DemoAgentLink } from "../agents/link"
import { lessMotion, stillRequested } from "../motion"
import { chatAgent, demoAgent, sampleOutput } from "../samples"
import type { DemoEngine, Entry } from "../terminals/engine"
import { agentTail, agyBlocks, inputLines, itemBlock, shellTail, statusLines } from "./agent"
import { readLine, shownRequest } from "./agent-input"
import { editLine, restoreLine, withReturnedWords } from "./line-editor"
import { openingBlocks, readingAt } from "./openings"
import { commandBlock, sampleBlocks } from "./samples"
import { createDemoScreen, type Block, type ScreenSize, type TailOf } from "./screen"

// One demo terminal's screen, written as the terminal output a real program would print: its
// intro, the commands typed at it and their replies, its agent's conversation, and under them
// the live tail with the command line. It outlives the streams the views attach: each one
// opens with the whole screen and then takes what changes, and what the person types into
// one comes back through `input`.

// What a terminal opens with in place of its program's sample output, as a store of blocks: a
// change that keeps the blocks before it appends what it adds, any other draws it again.
export type DemoIntro = Store<readonly Block[]>

// An intro that never changes.
export const fixedIntro = (blocks: readonly Block[]): DemoIntro => ({
  getSnapshot: () => blocks,
  subscribe: () => () => {},
})

type QuestionAnswers = Parameters<typeof readLine>[2]

// A dialog by what an answer names it with; a raw one has no id and is never answered.
const dialogId = (dialog: ChatDialog | null): string => (dialog && "id" in dialog ? dialog.id : "")

// The shells a terminal waits at the prompt of; anything else in front, as a dev server or
// tests watching, runs on: what is typed shows on a bare line, and it runs no command.
const shells = new Set(["zsh", "bash", "sh", "fish", "pwsh", "nu"])
const runsProgram = (terminal: TerminalMetadata): boolean =>
  !chatAgent(terminal) && !demoAgent(terminal) && !shells.has(terminal.process)

export type DemoTerminalScreen = {
  // The whole screen at its size, as a stream opens with, and that size.
  readonly snapshot: () => string
  readonly size: () => ScreenSize
  // Draws everything again at a new size.
  readonly resize: (size: ScreenSize) => void
  // What the emulator sent for the person's keys.
  readonly input: (data: string) => void
  // Writes each change to `write` until the returned stop.
  readonly attach: (write: (data: string) => void) => () => void
  // Reads its sources again, as when the agent link arrives.
  readonly refresh: () => void
  readonly dispose: () => void
}

export const createDemoTerminalScreen = ({
  key,
  engine,
  intro,
  link,
  size: initial,
}: {
  readonly key: TerminalKey
  readonly engine: DemoEngine
  readonly intro: DemoIntro | undefined
  // Where its agent is read and answered, once the demo links one.
  readonly link: () => DemoAgentLink | undefined
  readonly size: ScreenSize
}): DemoTerminalScreen => {
  // Blocks keep their identity while what they show does, so a transcript that grows is told
  // apart from one drawn anew.
  const entries = new WeakMap<Entry, Block>()
  // By the item itself, which a conversation never changes in place: an id comes back for
  // other text once an agent's conversation starts again.
  const items = new WeakMap<ChatItem, Block>()
  // The program's sample output, made once for each program and place it runs in.
  let sample: { readonly id: string; readonly blocks: Block[] } | undefined
  const opening = new Map<string, Block[]>()
  // The questions of a dialog taken so far, and a note on a line the screen couldn't take,
  // which belongs to the request shown when it came up.
  let taken: { readonly dialog: string; readonly answers: QuestionAnswers } | undefined
  // Each note counts up, so one that repeats is drawn, and announced, again.
  let noted:
    | { readonly text: string; readonly request: string | undefined; readonly n: number }
    | undefined
  let notes = 0
  // The note last drawn, by its count.
  let heard = 0
  let write: ((data: string) => void) | undefined
  let reading: ReturnType<typeof setTimeout> | undefined
  let watched: { store: Store<Conversation>; stop: () => void } | undefined

  const conversation = (): Store<Conversation> | undefined => {
    const terminal = engine.terminal(key)
    const agent = link()
    if (!terminal || !agent || !chatAgent(terminal)) return undefined
    if (!watched) {
      const store = agent.conversations.conversation(key)
      watched = { store, stop: store.subscribe(() => refresh()) }
    }
    return watched.store
  }

  // The intro its program opens with: the agent's opening, read as far as it has come, or the
  // shell's sample output.
  const programIntro = (): Block[] => {
    const terminal = engine.terminal(key)
    if (!terminal) return []
    const { opening: opened } = engine.getSnapshot(key)
    const agent = demoAgent(terminal)
    if (!agent) {
      const output = sampleOutput(terminal)
      const id = `${output}|${terminal.directory}|${engine.projectName(key)}`
      if (sample?.id !== id)
        sample = {
          id,
          blocks: sampleBlocks(output, {
            directory: terminal.directory,
            projectName: engine.projectName(key),
          }),
        }
      return sample.blocks
    }
    const { step, nextIn } = readingAt(opened.reading ? opened.at : undefined, {
      still: stillRequested(),
      less: lessMotion(),
      now: Date.now(),
    })
    clearTimeout(reading)
    if (nextIn !== undefined) reading = setTimeout(() => refresh(), nextIn)
    // The blocks of each step, made once and kept, so a later step extends the earlier one's.
    const id = `${agent}|${opened.at}|${step}`
    const known = opening.get(id)
    if (known) return known
    const made = openingBlocks(agent, terminal.directory, {
      planned: opened.planned,
      reviewing: opened.reviewing,
      step,
    })
    const before = opening.get(`${agent}|${opened.at}|${step - 1}`)
    const kept = before ? [...before, ...made.slice(before.length)] : made
    opening.set(id, kept)
    return kept
  }

  const transcript = (): Block[] => {
    const terminal = engine.terminal(key)
    if (!terminal) return []
    const snapshot = engine.getSnapshot(key)
    const start = snapshot.cleared ? [] : (intro?.getSnapshot() ?? programIntro())
    const commands = snapshot.entries.map((entry) => {
      const made = entries.get(entry) ?? commandBlock(entry.command, entry.reply)
      entries.set(entry, made)
      return made
    })
    const agent = chatAgent(terminal)
    const store = conversation()
    const shown = agent && store ? store.getSnapshot().items.slice(link()!.opening(key)) : []
    const said = !agent
      ? []
      : agent === "agy"
        ? agyBlocks(shown)
        : shown.map((item) => {
            const made = items.get(item) ?? itemBlock(item, agent)
            items.set(item, made)
            return made
          })
    return [...start, ...commands, ...said]
  }

  // The request the screen shows, where its agent is linked.
  const asked = (): { request: ChatRequest | undefined; requests: readonly ChatRequest[] } => {
    const requests = conversation()?.getSnapshot().requests ?? []
    return { request: shownRequest(requests), requests }
  }

  const tail = (): TailOf => {
    const terminal = engine.terminal(key)
    const { line } = engine.getSnapshot(key)
    const agent = terminal && (chatAgent(terminal) ?? demoAgent(terminal))
    // A program running in front draws no prompt under its output; the terminal shows what
    // is typed there on a bare line.
    if (terminal && runsProgram(terminal))
      return (width) => inputLines([], line.draft, line.cursor, width)
    if (!terminal || !agent) return shellTail({ project: engine.projectName(key), ...line })
    const status = terminal.state === "running" ? terminal.agent : undefined
    const { request, requests } = asked()
    const dialog = request?.dialog
    const answers = dialog && taken?.dialog === dialogId(dialog) ? taken.answers : []
    return agentTail({
      agent,
      request,
      progress: answers.length,
      place: request ? { at: requests.indexOf(request) + 1, of: requests.length } : undefined,
      note: noted && noted.request === request?.id ? noted.text : undefined,
      status: statusLines(agent, status, request !== undefined && !request.answered),
      draft: line.draft,
      cursor: line.cursor,
      noteAgain: noted !== undefined && noted.n !== heard,
    })
  }

  let blocks = transcript()
  const screen = createDemoScreen(initial, { transcript: blocks, tail: tail() })
  let size = initial
  const emit = (data: string): void => {
    if (data) write?.(data)
  }

  // What the tail last drew, so a change that leaves it as it was draws nothing.
  let drawnTail = ""
  const tailSignature = (next: TailOf): string =>
    JSON.stringify([next(size.cols), noted?.n ?? 0, size.cols, size.rows])

  // The transcript's change appended or drawn anew, after the tail where it changed, which
  // both redraw under them.
  const refresh = (): void => {
    if (!engine.has(key)) return
    const nextTail = tail()
    const signature = tailSignature(nextTail)
    if (signature !== drawnTail) emit(screen.tail(nextTail))
    drawnTail = signature
    heard = noted?.n ?? heard
    const next = transcript()
    const grows = next.length >= blocks.length && blocks.every((block, at) => next[at] === block)
    const added = next.slice(blocks.length)
    blocks = next
    if (!grows) emit(screen.replace(...next))
    else if (added.length) emit(screen.append(...added))
  }

  // A note belongs to the request shown when the line it is about was submitted.
  const note = (text: string | undefined, request = asked().request?.id): void => {
    notes += 1
    noted = text === undefined ? undefined : { text, request, n: notes }
  }
  const failing =
    (request: string | undefined) =>
    (error: unknown): void => {
      note(error instanceof Error ? error.message : "That didn't go through.", request)
      refresh()
    }

  // Sends the line to the agent, or answers the request that waits; a line it can't take
  // goes back into the command line. A terminal that runs no linked agent runs it.
  const submit = (text: string): void => {
    const terminal = engine.terminal(key)
    const agent = link()
    if (terminal && runsProgram(terminal)) return
    if (!terminal || !agent || !chatAgent(terminal)) return engine.run(key, text)
    const refused = (why: string): void => {
      note(why)
      engine.setLine(key, restoreLine(engine.getSnapshot(key).line, text))
    }
    note(undefined)
    const { request } = asked()
    const failed = failing(request?.id)
    const dialog = request?.dialog
    // What the screen can't answer stands aside for a prompt, which moves the agent on.
    if (!request || dialog?.type === "form" || dialog?.type === "raw") {
      agent.conversations.send(key, text.trim()).catch(failed)
      return
    }
    if (!dialog) return refused("This request isn't ready to answer yet.")
    if (request.answered) return refused("Already answered; the agent is catching up.")
    const answers = taken?.dialog === dialogId(dialog) ? taken.answers : []
    const result = readLine(text, dialog, answers)
    if (result.type === "note") return refused(result.text)
    if (result.type === "next") {
      taken = { dialog: dialogId(dialog), answers: result.answers }
      return
    }
    taken = undefined
    agent.conversations.answer(key, request.id, result.answer).catch(failed)
  }

  // Escape stops a working agent's turn, as in its TUI; the words it gives back return.
  const escape = (): void => {
    const terminal = engine.terminal(key)
    const agent = link()
    if (!terminal || !agent || terminal.state !== "running" || !terminal.agent?.working) return
    agent.conversations
      .interrupt(key)
      .then((words) => {
        if (words) engine.setLine(key, withReturnedWords(engine.getSnapshot(key).line, words))
      })
      .catch(failing(asked().request?.id))
  }

  const stopEngine = engine.subscribe(key, refresh)
  const stopIntro = intro?.subscribe(refresh)

  return {
    snapshot: () => screen.snapshot(),
    size: () => size,
    resize: (next) => {
      if (next.cols === size.cols && next.rows === size.rows) return
      size = next
      emit(screen.resize(next))
      drawnTail = tailSignature(tail())
    },
    input: (data) => {
      const { line, events } = editLine(engine.getSnapshot(key).line, data)
      // Each event reads the line as it stands, so a submit's cleared draft comes first.
      engine.setLine(key, line)
      for (const event of events) {
        if (event.type === "submit") submit(event.line)
        else if (event.type === "escape") escape()
      }
      refresh()
    },
    attach: (next) => {
      write = next
      return () => {
        if (write === next) write = undefined
      }
    },
    refresh,
    dispose: () => {
      stopEngine()
      stopIntro?.()
      watched?.stop()
      clearTimeout(reading)
      write = undefined
    },
  }
}
