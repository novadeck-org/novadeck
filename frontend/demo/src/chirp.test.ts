import { workspaceFromSeed } from "@novadeck/core/seed"
import { activeSession } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { answerMs, answeredMs } from "./chat"
import { chirpIntroOf, chirpWaiting } from "./chirp"
import { isDemoInbox } from "./inbox"
import { demoTerminalId } from "./samples"
import { demoTurns } from "./turns"
import { createDemo } from "./variants"

const desk = { projectId: "night-shift", workspaceSessionId: "initial" }
const key = (number: number) => ({ ...desk, terminalId: demoTerminalId(desk, number) })

// The Chirp demo, opened on the Canvas as its video shows it.
const open = () => {
  const backend = createDemo("chirp", undefined, demoTurns())
  const store = createWorkspaceStore(
    workspaceFromSeed(backend.seed, { view: "canvas", windowedView: "canvas", now: 0 }),
    backend.commit,
  )
  backend.commit(store.getSnapshot(), [])
  backend.start!({ dispatch: (actions) => store.transact(actions as never), open: () => {} })
  const terminal = (number: number) =>
    activeSession(store.getSnapshot())!.state.roster.terminals.find(
      (each) => each.id === key(number).terminalId,
    )
  return { backend, terminal, store }
}

describe("the Chirp demo", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("opens on her desk's project, its twelve agents all at work but one, which waits to run a command", () => {
    const { backend } = open()
    const [first] = backend.seed.projects
    expect(first?.id).toBe("night-shift")
    const terminals = first!.sessions[0]!.terminals
    expect(terminals).toHaveLength(12)
    const waiting = terminals.filter(
      (terminal) => terminal.state === "running" && terminal.agent?.attention,
    )
    expect(waiting.map((terminal) => terminal.id)).toEqual([key(chirpWaiting).terminalId])
    expect(waiting[0]).toMatchObject({
      process: "claude",
      agent: { attention: { kind: "permission", count: 1 } },
    })
    for (const project of backend.seed.projects)
      for (const terminal of project.sessions[0]!.terminals)
        expect(terminal).toMatchObject({ state: "running", agent: { working: true } })
  })

  it("has the Inbox its agents make: Cache warmer's request, answered from it until it's gone", async () => {
    const { backend, terminal, store } = open()
    const inbox = backend.inbox
    if (!isDemoInbox(inbox)) throw new Error("the Chirp demo has the demo's Inbox")
    inbox.bind!({ workspace: store })
    // Her agents are all at work: no finish is stored for the Inbox to list.
    expect(inbox.turns?.getSnapshot()).toEqual([])
    const items = inbox.state.getSnapshot().items
    expect(items).toHaveLength(1)
    const [item] = items
    expect(item).toMatchObject({
      kind: "request",
      source: { terminalId: key(chirpWaiting).terminalId, title: "Cache warmer" },
    })
    if (item?.kind !== "request" || item.request.dialog?.type !== "choices")
      throw new Error("a request with choices")
    inbox.answer(item.id, {
      kind: "request",
      answer: { type: "choice", dialog: item.request.dialog.id, option: "1" },
    })
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs + 100)
    expect(inbox.state.getSnapshot().items).toEqual([])
    const answered = terminal(chirpWaiting)
    expect(answered?.state === "running" && answered.agent?.attention).toBeFalsy()
  })

  it("lets her answer the waiting agent: the request goes, its tests pass, and it waits no more", async () => {
    const { backend, terminal } = open()
    const chat = backend.conversations!
    const id = String(chirpWaiting).padStart(2, "0")
    const conversation = chat.conversation(key(chirpWaiting))
    expect(conversation.getSnapshot().requests.map((request) => request.id)).toEqual([
      `${id}:permission`,
    ])
    const answering = chat.answer(key(chirpWaiting), `${id}:permission`, {
      type: "choice",
      dialog: `${id}:d`,
      option: "1",
    })
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
    await answering
    expect(conversation.getSnapshot().requests).toEqual([])
    expect(conversation.getSnapshot().items.at(-1)).toMatchObject({
      kind: "tool-result",
      call: `toolu_${id}a`,
    })
    const answered = terminal(chirpWaiting)
    expect(answered?.state).toBe("running")
    expect(answered?.state === "running" && answered.agent?.attention).toBeFalsy()
  })

  it("asks in Claude Code's own words for a command", () => {
    const { backend } = open()
    const [request] = backend.conversations!.conversation(key(chirpWaiting)).getSnapshot().requests
    expect(request).toMatchObject({ kind: "permission", tool: "Bash", choices: [] })
    expect(request?.dialog).toMatchObject({
      type: "choices",
      title: "Do you want to proceed?",
      options: [
        { label: "Yes" },
        { label: expect.stringMatching(/^Yes, and always allow/) },
        { label: "No" },
      ],
    })
  })

  it("stops on No, and the agent waits for her words", async () => {
    const { backend, terminal } = open()
    const chat = backend.conversations!
    const id = String(chirpWaiting).padStart(2, "0")
    const answering = chat.answer(key(chirpWaiting), `${id}:permission`, {
      type: "choice",
      dialog: `${id}:d`,
      option: "3",
    })
    await vi.advanceTimersByTimeAsync(answerMs + answeredMs)
    await answering
    expect(chat.conversation(key(chirpWaiting)).getSnapshot().items.at(-1)).toMatchObject({
      kind: "tool-result",
      text: expect.stringMatching(/^The user doesn't want to proceed/),
    })
    const stopped = terminal(chirpWaiting)
    expect(stopped?.state === "running" && stopped.agent?.attention).toBeFalsy()
  })

  it("opens her desk's screens on their own work, and leaves the others' to the demo", () => {
    const { backend } = open()
    const [mine, other] = backend.seed.projects
    const at = (project: typeof mine, number: number) => ({
      projectId: project!.id,
      workspaceSessionId: "initial",
      terminalId: project!.sessions[0]!.terminals[number - 1]!.id,
    })
    expect(chirpIntroOf(mine!.sessions[0]!.terminals[0]!, at(mine, 1))).toBeDefined()
    expect(chirpIntroOf(other!.sessions[0]!.terminals[0]!, at(other, 1))).toBeUndefined()
  })
})
