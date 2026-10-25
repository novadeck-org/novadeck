import { longHoldMs } from "@novadeck/protocol"

import type { ChatDialog } from "./conversation"
import type { InboxUnread } from "./inbox"
import {
  dialogMs,
  inboxItems,
  leadHearsOf,
  type Asked,
  type InboxInputs,
  type InboxLetter,
} from "./inbox-items"
import {
  noMail,
  type AgentMessage,
  type MailState,
  type MessageThread,
  type TerminalMail,
} from "./messages"
import { createTerminalState } from "./state"
import { describe, expect, it } from "./test"
import type { AgentStatus, AgentTurnEnd, TerminalMetadata, Workspace } from "./types"

const choices: ChatDialog = {
  type: "choices",
  id: "d1",
  title: null,
  detail: "pnpm add x",
  options: [{ id: "yes", label: "Yes", text: null }],
}

const agentTerminal = (
  number: number,
  agent: AgentStatus = { working: false },
  process = "claude",
): TerminalMetadata => ({
  id: `0${number}`,
  name: `Terminal ${number}`,
  directory: "/work/app",
  command: process,
  process,
  handle: ["moth", "fox", "owl", "crow"][number - 1]!,
  state: "running",
  agent,
})

const workspaceOf = (...terminals: TerminalMetadata[]): Workspace => ({
  activeProjectId: "p",
  projects: [
    {
      id: "p",
      name: "App",
      directory: "/work/app",
      activeSessionId: "s",
      history: [
        {
          id: "s",
          name: "s",
          visitedAt: 0,
          state: createTerminalState(terminals, "grid", "grid"),
        },
      ],
    },
  ],
})

const turn = (end: Partial<AgentTurnEnd> = {}): AgentTurnEnd => ({
  outcome: "completed",
  at: 100,
  ...end,
})

const asked = (id: string, askedAt: number, dialog: ChatDialog | null = choices): Asked => ({
  request: {
    id,
    kind: "permission",
    tool: "Bash",
    subject: "pnpm add x",
    choices: [],
    subagent: false,
    dialog,
    answered: false,
  },
  askedAt,
})

const message = (change: Partial<AgentMessage> = {}): AgentMessage => ({
  id: "m1",
  hop: 3,
  from: "moth",
  to: "fox",
  text: "Is the schema ready?",
  sentAt: 50,
  state: "held",
  held: "release",
  deliveredAt: null,
  ...change,
})

const thread = (change: Partial<MessageThread> = {}): MessageThread => ({
  id: "th1",
  peer: "fox",
  hops: 3,
  idle: 0,
  held: true,
  heldFor: "loop",
  messages: [message()],
  ...change,
})

const mailOf = (...threads: MessageThread[]): MailState => ({
  ...noMail,
  terminals: { "p/s/01": { handle: "moth", agent: true, threads } },
})

const inputs = (workspace: Workspace, more: Partial<InboxInputs> = {}): InboxInputs => ({
  workspace,
  unread: {},
  mail: noMail,
  requests: {},
  letters: [],
  now: 10_000,
  caseless: false,
  longHoldMs,
  ...more,
})

const letter = (change: Partial<InboxLetter> = {}): InboxLetter => ({
  id: "letter-1",
  terminalId: "01",
  projectId: "p",
  workspaceSessionId: "s",
  agent: "claude",
  handle: "moth",
  at: 4000,
  content: {
    kind: "ask",
    ask: {
      subject: "Which route?",
      body: "Choose a route.",
      details: null,
      hardToUndo: null,
      shape: { type: "text" },
    },
  },
  ...change,
})

const done: InboxUnread = { "p/s": { "01": "done" } }
const failed: InboxUnread = { "p/s": { "01": "failed" } }

describe("The Inbox's items", () => {
  describe("a request", () => {
    const waiting = workspaceOf(
      agentTerminal(1, { working: true, attention: { kind: "permission", count: 1 } }),
    )

    it("comes from the oldest request, waiting since it was asked", () => {
      const items = inboxItems(
        inputs(waiting, {
          requests: { "01": [asked("r1", 4000), asked("r2", 5000), asked("r3", 6000)] },
          now: 5500,
        }),
      )

      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        id: "request:r1",
        at: 4000,
        stopped: true,
        seen: false,
        kind: "request",
        source: {
          projectId: "p",
          workspaceSessionId: "s",
          terminalId: "01",
          handle: "moth",
          agent: "claude",
          title: "Terminal 1",
          projectName: "App",
        },
      })
    })

    it("does not fall forward to a newer request while the oldest has no dialog yet", () => {
      const requests = { "01": [asked("r1", 4000, null), asked("r2", 4500)] }

      expect(inboxItems(inputs(waiting, { requests, now: 5000 }))).toEqual([])
      expect(inboxItems(inputs(waiting, { requests, now: 4000 + dialogMs }))[0]).toMatchObject({
        id: "request:r1",
      })
    })

    it("takes the terminal over an unread failed turn from before", () => {
      const both = workspaceOf(
        agentTerminal(1, {
          working: false,
          attention: { kind: "permission", count: 1 },
          lastTurn: turn({ outcome: "failed", error: "x" }),
        }),
      )
      const items = inboxItems(
        inputs(both, { unread: failed, requests: { "01": [asked("r1", 9000)] } }),
      )
      const pending = inboxItems(inputs(both, { unread: failed, requests: {} }))

      expect(items.map((item) => item.id)).toEqual(["request:r1"])
      expect(pending).toEqual([])
    })

    it("waits for a dialog a moment, then shows without one to be answered in the terminal", () => {
      const requests = { "01": [asked("r1", 4000, null)] }

      expect(inboxItems(inputs(waiting, { requests, now: 4000 + dialogMs - 1 }))).toEqual([])
      const [item] = inboxItems(inputs(waiting, { requests, now: 4000 + dialogMs }))
      expect(item).toMatchObject({ id: "request:r1", kind: "request", request: { dialog: null } })
    })

    it("is none once the agent no longer waits, whatever was last read", () => {
      const rested = workspaceOf(agentTerminal(1))

      expect(inboxItems(inputs(rested, { requests: { "01": [asked("r1", 1)] } }))).toEqual([])
    })

    it("keeps its identity and time across changes elsewhere", () => {
      const first = inboxItems(inputs(waiting, { requests: { "01": [asked("r1", 4000)] } }))
      const later = inboxItems(
        inputs(waiting, { requests: { "01": [asked("r1", 4000)] }, now: 99_000 }),
      )

      expect(later[0]!.id).toBe(first[0]!.id)
      expect(later[0]!.at).toBe(first[0]!.at)
    })
  })

  describe("a finished turn", () => {
    const rested = (end: Partial<AgentTurnEnd>) =>
      workspaceOf(agentTerminal(1, { working: false, lastTurn: turn(end) }))

    it("is an update while its mark is unread, with the reply and the files it wrote", () => {
      const [item] = inboxItems(
        inputs(
          rested({
            reply: "Done. Tests pass.",
            files: ["/work/app/src/a.ts", "/elsewhere/b.ts", "/work/application/c.ts"],
          }),
          { unread: done },
        ),
      )

      expect(item).toMatchObject({
        id: "update:01:100",
        at: 100,
        stopped: false,
        kind: "update",
        update: {
          type: "finished",
          subject: "Done. Tests pass.",
          reply: "Done. Tests pass.",
          files: ["src/a.ts", "/elsewhere/b.ts", "/work/application/c.ts"],
        },
      })
    })

    it("says murmur's gist first, and a plain line where there is no reply", () => {
      const [gist] = inboxItems(
        inputs(rested({ reply: "Long.", gist: "Fixed rounding" }), { unread: done }),
      )
      const [none] = inboxItems(inputs(rested({}), { unread: done }))

      expect(gist).toMatchObject({ update: { subject: "Fixed rounding", reply: "Long." } })
      expect(none).toMatchObject({ update: { subject: "Finished its turn", reply: "", files: [] } })
    })

    it("is none once read, or while the agent works again", () => {
      expect(inboxItems(inputs(rested({})))).toEqual([])
      const working = workspaceOf(
        agentTerminal(1, { working: true, lastTurn: turn({ reply: "old" }) }),
      )
      expect(inboxItems(inputs(working, { unread: done }))).toEqual([])
    })

    it("is its lead's while that lead runs, and the person's once it doesn't", () => {
      const worker = (end: Partial<AgentTurnEnd> = {}): TerminalMetadata => ({
        ...agentTerminal(2, { working: false, lastTurn: turn(end) }),
        ledBy: "moth",
      })
      const unread: InboxUnread = { "p/s": { "02": "done" } }

      expect(inboxItems(inputs(workspaceOf(agentTerminal(1), worker()), { unread }))).toEqual([])
      // A lead whose agent stopped, or whose terminal closed, hears nothing: the person does.
      const shell = { ...agentTerminal(1), process: "bash" }
      expect(inboxItems(inputs(workspaceOf(shell, worker()), { unread }))).toMatchObject([
        { id: "update:02:100", kind: "update" },
      ])
      expect(inboxItems(inputs(workspaceOf(worker()), { unread }))).toMatchObject([
        { id: "update:02:100" },
      ])
      // What only the person can fix still comes to them.
      expect(
        inboxItems(
          inputs(workspaceOf(agentTerminal(1), worker({ outcome: "failed", error: "x" })), {
            unread: { "p/s": { "02": "failed" } },
          }),
        ),
      ).toMatchObject([{ id: "trouble:02:100", kind: "trouble" }])
    })
  })

  describe("whether a lead hears of a terminal", () => {
    const worker: TerminalMetadata = { ...agentTerminal(2), ledBy: "moth" }

    it("is so while the lead's agent runs, and not once it stopped, closed, or for a terminal it doesn't lead", () => {
      expect(leadHearsOf(workspaceOf(agentTerminal(1), worker), "p/s", "02")).toBe(true)
      expect(leadHearsOf(workspaceOf(agentTerminal(1), worker), "p/s", "01")).toBe(false)
      expect(leadHearsOf(workspaceOf(agentTerminal(1), worker), "q/s", "02")).toBe(false)
      const shell = { ...agentTerminal(1), process: "bash" }
      expect(leadHearsOf(workspaceOf(shell, worker), "p/s", "02")).toBe(false)
      expect(leadHearsOf(workspaceOf(worker), "p/s", "02")).toBe(false)
    })
  })

  describe("a failed turn", () => {
    const ended = (end: Partial<AgentTurnEnd>) =>
      workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed", ...end }) }),
      )

    it("is trouble with its error while its mark is unread", () => {
      const [item] = inboxItems(inputs(ended({ error: "API Error: 529" }), { unread: failed }))

      expect(item).toMatchObject({
        id: "trouble:01:100",
        at: 100,
        stopped: true,
        kind: "trouble",
        trouble: { type: "failed", error: "API Error: 529" },
      })
    })

    it("has no error to show where its harness gave none", () => {
      const [item] = inboxItems(inputs(ended({}), { unread: failed }))

      expect(item).toMatchObject({ trouble: { type: "failed", error: null } })
    })

    it("goes once the person has viewed the terminal", () => {
      expect(inboxItems(inputs(ended({ error: "x" })))).toEqual([])
    })
  })

  describe("a usage limit", () => {
    const limited = (end: Partial<AgentTurnEnd>) =>
      workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed", ...end }) }),
      )

    it("is trouble Novadeck can't resume, shown without an unread mark", () => {
      const [item] = inboxItems(
        inputs(limited({ error: "5-hour limit reached", limit: { minutes: 300, resetsAt: 9e12 } })),
      )

      expect(item).toMatchObject({
        id: "limit:01:100",
        stopped: true,
        trouble: {
          type: "limit",
          minutes: 300,
          resetsAt: 9e12,
          autoResume: null,
          evidence: [{ text: "5-hour limit reached", result: null, times: 1 }],
        },
      })
    })

    it("names a window of unknown length with 0 minutes and says so where no error came", () => {
      const [item] = inboxItems(inputs(limited({ limit: { minutes: null, resetsAt: 9e12 } })))

      expect(item).toMatchObject({
        trouble: { minutes: 0, evidence: [{ text: "Usage limit reached" }] },
      })
    })

    it("replaces the failure that came with it, and stays after the person looked", () => {
      const items = inboxItems(
        inputs(limited({ error: "x", limit: { minutes: 60, resetsAt: 9e12 } }), { unread: failed }),
      )

      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ trouble: { type: "limit" } })
    })

    it("goes with the agent's next turn", () => {
      const next = workspaceOf(agentTerminal(1, { working: true }))

      expect(inboxItems(inputs(next))).toEqual([])
    })
  })

  describe("a file the turn wrote", () => {
    const wrote = (directory: string, file: string) =>
      workspaceOf({
        ...agentTerminal(1, { working: false, lastTurn: turn({ files: [file] }) }),
        directory,
      })
    const withProject = (directory: string, file: string): string[] => {
      const workspace = wrote(directory, file)
      workspace.projects[0]!.directory = directory
      const [item] = inboxItems(inputs(workspace, { unread: done }))
      return item?.kind === "update" && item.update.type === "finished"
        ? [...item.update.files]
        : []
    }

    it("is relative to the project however its separators fall", () => {
      expect(withProject("C:/work/app", "C:\\work\\app\\src\\a.ts")).toEqual(["src\\a.ts"])
      expect(withProject("C:\\work\\app\\", "C:/work/app/src/a.ts")).toEqual(["src/a.ts"])
      expect(withProject("c:/work/app", "C:/Work/App/a.ts")).toEqual(["a.ts"])
      expect(withProject("/work/app", "/work/App/a.ts")).toEqual(["/work/App/a.ts"])
    })

    it("matches the project whatever its case where the machine's paths are caseless", () => {
      const workspace = wrote("/work/app", "/work/App/src/a.ts")
      const [item] = inboxItems(inputs(workspace, { unread: done, caseless: true }))
      expect(item).toMatchObject({ update: { files: ["src/a.ts"] } })
    })
  })

  describe("a held message", () => {
    const pair = workspaceOf(
      agentTerminal(1, { working: false }),
      agentTerminal(2, { working: false }, "codex"),
    )

    it("is an approve from the sender's terminal, from the oldest message held for release", () => {
      const held = thread({
        messages: [
          message({ id: "m0", state: "delivered", held: null, hop: 2 }),
          message({ id: "m1", hop: 3, sentAt: 50 }),
          message({ id: "m2", hop: 4, sentAt: 60, text: "Later" }),
        ],
      })
      const [item] = inboxItems(inputs(pair, { mail: mailOf(held) }))

      expect(item).toMatchObject({
        id: "held:th1",
        at: 50,
        stopped: true,
        kind: "held",
        source: { terminalId: "01", handle: "moth", agent: "claude" },
        held: {
          threadId: "th1",
          from: { handle: "moth", title: "Terminal 1" },
          to: { handle: "fox", title: "Terminal 2" },
          text: "Is the schema ready?",
          hop: 3,
          heldFor: "loop",
        },
      })
    })

    it("carries why the thread is held, or none", () => {
      const reason = (heldFor: "loop" | null) =>
        inboxItems(inputs(pair, { mail: mailOf(thread({ heldFor })) }))[0]
      expect(reason("loop")).toMatchObject({ held: { heldFor: "loop" } })
      expect(reason(null)).toMatchObject({ held: { heldFor: null } })
    })

    it("is one item for a thread both its terminals list", () => {
      const mail: MailState = {
        ...noMail,
        terminals: {
          "p/s/01": { handle: "moth", agent: true, threads: [thread()] },
          "p/s/02": { handle: "fox", agent: true, threads: [thread({ peer: "moth" })] },
        },
      }

      expect(inboxItems(inputs(pair, { mail }))).toHaveLength(1)
    })

    it("is not stopped while the sender's agent works", () => {
      const busy = workspaceOf(
        agentTerminal(1, { working: true }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const [item] = inboxItems(inputs(busy, { mail: mailOf(thread()) }))

      expect(item).toMatchObject({ stopped: false })
    })

    it("comes from the recipient's terminal where the sender is gone", () => {
      const alone = workspaceOf(agentTerminal(2, { working: false }, "codex"))
      const [item] = inboxItems(inputs(alone, { mail: mailOf(thread()) }))

      expect(item).toMatchObject({
        stopped: true,
        source: { terminalId: "02", agent: "codex" },
        held: { from: { handle: "moth", title: "moth" }, to: { title: "Terminal 2" } },
      })
    })

    it("is none while messaging is paused, and none once released", () => {
      const paused = thread({ messages: [message({ held: "paused" })] })

      expect(inboxItems(inputs(pair, { mail: mailOf(paused) }))).toEqual([])
      expect(inboxItems(inputs(pair, { mail: mailOf(thread({ held: false })) }))).toEqual([])
    })
  })

  describe("messages held long behind what keeps the doorbell from an idle agent", () => {
    // Codex in fox is idle with moth's messages for it, its box holding text since 1 000.
    const pair = workspaceOf(
      agentTerminal(1, { working: false }),
      agentTerminal(2, { working: false }, "codex"),
    )
    const waiting = (change: Partial<AgentMessage> = {}) =>
      message({ state: "queued", held: null, ...change })
    const heldFor = (
      messages: readonly AgentMessage[],
      waits: TerminalMail["waits"] = "draft",
    ): MailState => ({
      ...noMail,
      terminals: {
        "p/s/02": {
          handle: "fox",
          agent: true,
          waits,
          waitsSince: 1_000,
          threads: [thread({ peer: "moth", held: false, messages })],
        },
      },
    })
    const at = 1_000 + longHoldMs

    it("is a trouble item of the recipient's terminal, from when the hold began", () => {
      const mail = heldFor([waiting({ id: "m1" }), waiting({ id: "m2", state: "leased" })])
      expect(inboxItems(inputs(pair, { mail, now: at }))).toEqual([
        expect.objectContaining({
          id: "waits:02:1000",
          at: 1_000,
          stopped: true,
          source: expect.objectContaining({
            terminalId: "02",
            handle: "fox",
            agent: "codex",
          }),
          kind: "trouble",
          // The leased one is on its way: only the queued one is held.
          trouble: { type: "waits", waits: "draft", count: 1 },
        }),
      ])
    })

    it("is none while the agent works, as its status says, whatever the listing last said", () => {
      const busy = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: true }, "codex"),
      )
      expect(inboxItems(inputs(busy, { mail: heldFor([waiting()]), now: at }))).toEqual([])
    })

    it("says why it holds as the hold says, whatever that is", () => {
      const [item] = inboxItems(inputs(pair, { mail: heldFor([waiting()], "dialog"), now: at }))
      expect(item).toMatchObject({
        trouble: { type: "waits", waits: "dialog", count: 1 },
      })
    })

    it("is raised where the doorbell gave no reason, as when the screen never calms", () => {
      const [item] = inboxItems(inputs(pair, { mail: heldFor([waiting()], null), now: at }))
      expect(item).toMatchObject({ trouble: { type: "waits", waits: null, count: 1 } })
    })

    it("is none until the hold has lasted, nor once no message waits or the hold ends", () => {
      expect(inboxItems(inputs(pair, { mail: heldFor([waiting()]), now: at - 1 }))).toEqual([])
      const delivered = waiting({ state: "delivered", deliveredAt: 2_000 })
      expect(inboxItems(inputs(pair, { mail: heldFor([delivered]), now: at }))).toEqual([])
      const ended: MailState = {
        ...heldFor([waiting()]),
        terminals: {
          "p/s/02": { ...heldFor([waiting()]).terminals["p/s/02"]!, waitsSince: null },
        },
      }
      expect(inboxItems(inputs(pair, { mail: ended, now: at }))).toEqual([])
      // Moth's own messages to fox wait in its listing, not for it.
      const sent = heldFor([waiting({ from: "fox", to: "moth" })])
      expect(inboxItems(inputs(pair, { mail: sent, now: at }))).toEqual([])
    })

    it("counts no message held for the person's release, or a pause, which have their own", () => {
      const mail = heldFor([
        waiting(),
        message({ id: "m2" }),
        waiting({ id: "m3", state: "held", held: "paused" }),
      ])
      const items = inboxItems(inputs(pair, { mail, now: at }))
      expect(items.find((item) => item.kind === "trouble")).toMatchObject({
        trouble: { count: 1 },
      })
    })

    it("gives way to the agent's own ask, and comes before a finished turn", () => {
      const ask = letter({ terminalId: "02", agent: "codex", handle: "fox" })
      const [shown] = inboxItems(
        inputs(pair, { mail: heldFor([waiting()]), letters: [ask], now: at }),
      )
      expect(shown).toMatchObject({ id: "letter-1", kind: "ask" })
      const finished = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: false, lastTurn: turn() }, "codex"),
      )
      const [first] = inboxItems(
        inputs(finished, {
          mail: heldFor([waiting()]),
          unread: { "p/s": { "02": "done" } },
          now: at,
        }),
      )
      expect(first).toMatchObject({ kind: "trouble", trouble: { type: "waits" } })
    })

    it("gives way to a request waiting on the person in that terminal", () => {
      const asking = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: false, attention: { kind: "permission", count: 1 } }, "codex"),
      )
      const [item] = inboxItems(
        inputs(asking, {
          mail: heldFor([waiting()], "asking"),
          requests: { "02": [asked("r1", 0)] },
          now: at,
        }),
      )
      expect(item).toMatchObject({ kind: "request" })
    })
  })

  describe("a terminal with several", () => {
    it("shows the request of a running turn, not the finish from before", () => {
      const both = workspaceOf(
        agentTerminal(1, {
          working: true,
          attention: { kind: "permission", count: 1 },
          lastTurn: turn({ reply: "old" }),
        }),
      )
      const items = inboxItems(inputs(both, { unread: done, requests: { "01": [asked("r1", 5)] } }))

      expect(items.map((item) => item.id)).toEqual(["request:r1"])
    })

    it("keeps a held thread beside the terminal's other item", () => {
      const pair = workspaceOf(
        agentTerminal(1, {
          working: false,
          lastTurn: turn({ outcome: "failed", error: "x" }),
        }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const items = inboxItems(inputs(pair, { unread: failed, mail: mailOf(thread()) }))

      expect(items.map((item) => item.id)).toEqual(["trouble:01:100", "held:th1"])
    })

    it("shows every held thread, the longest waiting first", () => {
      const both = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const mail: MailState = {
        ...noMail,
        terminals: {
          "p/s/01": {
            handle: "moth",
            agent: true,
            threads: [
              thread({ id: "newer", messages: [message({ sentAt: 90 })] }),
              thread({ id: "older", messages: [message({ sentAt: 20 })] }),
            ],
          },
        },
      }

      expect(inboxItems(inputs(both, { mail })).map((item) => item.id)).toEqual([
        "held:older",
        "held:newer",
      ])
    })
  })

  describe("the whole list", () => {
    it("orders by urgency, then by how long each waited", () => {
      const workspace = workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn({ at: 10, reply: "a" }) }),
        agentTerminal(2, { working: true, attention: { kind: "permission", count: 1 } }),
        agentTerminal(3, { working: false, lastTurn: turn({ at: 5, outcome: "failed" }) }),
        agentTerminal(4, { working: false }, "zsh"),
      )
      const items = inboxItems(
        inputs(workspace, {
          unread: { "p/s": { "01": "done", "03": "failed" } },
          requests: { "02": [asked("r1", 20)] },
        }),
      )

      expect(items.map((item) => item.id)).toEqual(["trouble:03:5", "request:r1", "update:01:10"])
    })

    it("holds nothing for a terminal that runs no agent, and never an ask, told or stuck", () => {
      const shell: TerminalMetadata = {
        id: "01",
        name: "Shell",
        directory: "/work/app",
        command: "zsh",
        process: "zsh",
        state: "idle",
      }
      const items = inboxItems(
        inputs(workspaceOf(shell, agentTerminal(2, { working: false, lastTurn: turn() })), {
          unread: { "p/s": { "01": "done", "02": "done" } },
        }),
      )

      expect(items.map((item) => item.id)).toEqual(["update:02:100"])
      expect(items.every((item) => item.kind !== "ask")).toBe(true)
    })
  })

  describe("a letter", () => {
    const attention: AgentStatus = { working: true, attention: { kind: "permission", count: 1 } }
    const told = (id = "told-1"): InboxLetter =>
      letter({ id, content: { kind: "tell", subject: "Preview ready", body: "Open the preview." } })

    it("derives whether an ask waits from the agent's current working state", () => {
      for (const agent of ["claude", "codex", "agy"] as const) {
        for (const working of [true, false]) {
          const items = inboxItems(
            inputs(workspaceOf(agentTerminal(1, { working }, agent)), {
              letters: [letter({ agent })],
            }),
          )
          expect(items[0]).toMatchObject({ kind: "ask", stopped: !working, source: { agent } })
        }
      }
    })

    it("keeps an unread tell after its agent exits, with its original attribution", () => {
      const exited: TerminalMetadata = {
        ...agentTerminal(1),
        state: "exited",
        exitCode: 0,
        signal: null,
      }
      const items = inboxItems(inputs(workspaceOf(exited), { letters: [letter(), told()] }))
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        id: "told-1",
        kind: "update",
        stopped: false,
        source: { agent: "claude", handle: "moth" },
        update: { type: "told" },
      })
      expect(inboxItems(inputs(workspaceOf(), { letters: [told()] }))).toEqual([])
    })

    it("lists a current permission or plan and an older stopped MCP ask, each its own row", () => {
      for (const kind of ["permission", "plan"] as const) {
        const request = asked("gate", 8000)
        const waiting = workspaceOf(
          agentTerminal(1, { working: false, attention: { kind, count: 1 } }),
        )
        const items = inboxItems(
          inputs(waiting, {
            letters: [letter()],
            requests: { "01": [{ ...request, request: { ...request.request, kind } }] },
          }),
        )
        expect(items.map(({ id }) => id).toSorted()).toEqual(["letter-1", "request:gate"])
      }
    })

    it("keeps a gate's unread dialog grace for the request's row, not for the ask beside it", () => {
      const waiting = workspaceOf(agentTerminal(1, attention))
      for (const requests of [{}, { "01": [asked("gate", 9500, null)] }]) {
        const items = inboxItems(inputs(waiting, { letters: [letter()], requests }))
        expect(items.map(({ id }) => id)).toEqual(["letter-1"])
      }
    })

    it("lists a stopped question and an MCP ask beside it", () => {
      const question = asked("question", 8000)
      const waiting = workspaceOf(
        agentTerminal(1, { working: false, attention: { kind: "question", count: 1 } }),
      )
      const items = inboxItems(
        inputs(waiting, {
          letters: [letter()],
          requests: { "01": [{ ...question, request: { ...question.request, kind: "question" } }] },
        }),
      )
      expect(items.map(({ id }) => id).toSorted()).toEqual(["letter-1", "request:question"])
    })

    it("lists two tells from one terminal, the newer beside the older", () => {
      const items = inboxItems(
        inputs(workspaceOf(agentTerminal(1, { working: false })), {
          letters: [
            { ...told("merged"), at: 20 },
            { ...told("opened"), at: 10 },
          ],
        }),
      )
      expect(items.map(({ id }) => id)).toEqual(["opened", "merged"])
    })

    it("lists an ask beside the finish of the same terminal, and every tell too", () => {
      const items = inboxItems(
        inputs(workspaceOf(agentTerminal(1, { working: false, lastTurn: turn() })), {
          unread: done,
          letters: [letter({ id: "ask" }), told("t1"), told("t2")],
        }),
      )
      expect(items.map(({ id }) => id).toSorted()).toEqual(["ask", "t1", "t2", "update:01:100"])
    })

    it("ignores letters for terminals outside their recorded ownership context", () => {
      for (const change of [
        { terminalId: "closed" },
        { projectId: "elsewhere" },
        { workspaceSessionId: "other" },
        { handle: "old-handle" },
        { agent: "codex" as const },
      ]) {
        expect(
          inboxItems(inputs(workspaceOf(agentTerminal(1)), { letters: [letter(change)] })),
        ).toEqual([])
      }
    })
  })
})
