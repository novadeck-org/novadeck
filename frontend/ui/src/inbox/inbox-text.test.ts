import type { InboxEntry } from "@novadeck/core/inbox"

import { describe, expect, it } from "../test"
import {
  clock,
  agentName,
  codeParts,
  endedLine,
  endedWords,
  labelOf,
  limitWindow,
  readLabel,
  recommended,
  resumesLabel,
  subjectOf,
  waitLabel,
} from "./inbox-text"

const source: InboxEntry["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t",
  handle: "moth",
  agent: "claude",
  title: "Title",
  projectName: "Project",
}
const base = { id: "i", source, at: 0, stopped: true, seen: false }

const permission = (tool: string, subject: string | null): InboxEntry => ({
  ...base,
  kind: "request",
  request: {
    id: "r",
    kind: "permission",
    tool,
    subject,
    choices: [],
    subagent: false,
    dialog: null,
    answered: false,
    askedAt: 0,
  },
})

const asking = (subject: string | null, questions: number): InboxEntry => ({
  ...base,
  kind: "request",
  request: {
    id: "r",
    kind: "question",
    tool: "AskUserQuestion",
    subject,
    choices: [],
    subagent: false,
    dialog: {
      type: "questions",
      id: "r",
      chat: null,
      questions: Array.from({ length: questions }, (_, index) => ({
        id: `q${index}`,
        header: null,
        question: `Question ${index + 1}?`,
        multiSelect: false,
        text: false,
        options: [],
      })),
    },
    answered: false,
    askedAt: 0,
  },
})

describe("How long ago", () => {
  it.each([
    [10_000, "now"],
    [7 * 60_000, "7m"],
    [72 * 60_000, "1h 12m"],
    [2 * 60 * 60_000, "2h"],
    [3 * 24 * 60 * 60_000, "3d"],
  ])("reads %i ms as %s", (elapsed, words) => {
    expect(waitLabel(0, elapsed)).toBe(words)
  })
})

describe("A time of day", () => {
  it("is two digits each of hours and minutes", () => {
    expect(clock(new Date(2026, 9, 14, 9, 5).getTime())).toBe("09:05")
  })
})

describe("Text with code in it", () => {
  it("sets what is between backticks as code", () => {
    expect(codeParts("Run `pnpm add` now")).toEqual([
      { code: false, text: "Run " },
      { code: true, text: "pnpm add" },
      { code: false, text: " now" },
    ])
  })

  it("leaves an unpaired backtick as text", () => {
    expect(codeParts("a ` b")).toEqual([{ code: false, text: "a ` b" }])
  })
})

describe("A recommended option", () => {
  it("loses the mark and is the agent's pick", () => {
    expect(recommended("date-fns (Recommended)")).toEqual({ label: "date-fns", pick: true })
    expect(recommended("Native")).toEqual({ label: "Native", pick: false })
  })
})

describe("An Inbox entry's subject", () => {
  it("says what a command or an edit would do", () => {
    expect(subjectOf(permission("Bash", "pnpm test"))).toBe("Run `pnpm test`?")
    expect(subjectOf(permission("Edit", "src/a.ts"))).toBe("Edit `src/a.ts`?")
    // An MCP tool's name says nothing of files.
    expect(subjectOf(permission("mcp__codex_tui__create_thread", null))).toBe(
      "Use mcp__codex_tui__create_thread?",
    )
    expect(subjectOf(permission("mcp_server_write_note", null))).toBe("Use mcp_server_write_note?")
    expect(subjectOf(permission("WebFetch", "example.com"))).toBe("Use WebFetch on `example.com`?")
  })

  it("asks the shipping gate's card's own question, not the tool that raised it", () => {
    const card = permission("request_permit", "Push to origin/feature?")
    if (card.kind !== "request") throw new Error("a request")
    const held: InboxEntry = {
      ...card,
      request: {
        ...card.request,
        detached: true,
        dialog: {
          type: "choices",
          id: "permit-c1",
          title: "Push to origin/feature?",
          detail: "Remote: origin",
          options: [],
        },
      },
    }
    expect(subjectOf(held)).toBe("Push to origin/feature?")
  })

  it("says how many more questions a call asks behind the first", () => {
    expect(subjectOf(asking(null, 1))).toBe("Question 1?")
    expect(subjectOf(asking(null, 3))).toBe("Question 1? (+2 more)")
    expect(subjectOf(asking("Which library?", 2))).toBe("Which library? (+1 more)")
  })

  it("names a form an MCP server asks for by what it says it is for", () => {
    const form = (message: string): InboxEntry => ({
      ...base,
      kind: "request",
      request: {
        id: "r",
        kind: "question",
        tool: "mcp_deploy_configure_target",
        subject: null,
        choices: [],
        subagent: false,
        dialog: { type: "form", id: "f", message, fields: [] },
        answered: false,
        askedAt: 0,
      },
    })
    expect(subjectOf(form("Configure the deploy target"))).toBe("Configure the deploy target")
    expect(subjectOf(form(" "))).toBe("A question for you")
  })

  it("names where a held message goes", () => {
    const entry: InboxEntry = {
      ...base,
      kind: "held",
      held: {
        threadId: "t",
        from: { handle: "moth", title: "A" },
        to: { handle: "fox", title: "B" },
        text: "",
        hop: 3,
        heldFor: "loop",
      },
    }
    expect(subjectOf(entry)).toBe("Release a held message to B?")
  })

  it("names a limit's window and whose it is", () => {
    const entry: InboxEntry = {
      ...base,
      kind: "trouble",
      trouble: { type: "limit", minutes: 300, resetsAt: 0, autoResume: true, evidence: [] },
    }
    expect(subjectOf(entry)).toBe("Hit Claude's 5-hour limit")
    const fable: InboxEntry = {
      ...entry,
      trouble: {
        type: "limit",
        minutes: 10_080,
        resetsAt: 0,
        scope: "Fable",
        autoResume: true,
        evidence: [],
      },
    }
    expect(subjectOf(fable)).toBe("Hit Claude's weekly Fable limit")
  })

  it("counts the messages a hold keeps from the agent, and says what holds them", () => {
    const held = (count: number, waits: "draft" | "dialog"): InboxEntry => ({
      ...base,
      kind: "trouble",
      trouble: { type: "waits", waits, count },
    })
    expect(subjectOf(held(3, "draft"))).toBe(
      `3 messages for @${base.source.handle} wait behind text in its box`,
    )
    expect(subjectOf(held(1, "dialog"))).toBe(
      `1 message for @${base.source.handle} waits behind a dialog or picker in its terminal`,
    )
    expect(
      subjectOf({ ...base, kind: "trouble", trouble: { type: "waits", waits: null, count: 2 } }),
    ).toBe(
      `2 messages for @${base.source.handle} wait behind an idle agent Novadeck can't wake yet`,
    )
  })
})

describe("How a resolved entry ended", () => {
  it("says it in a line, with what the person answered", () => {
    const ask: InboxEntry = {
      ...base,
      kind: "ask",
      ask: { subject: "s", body: "", details: null, hardToUndo: null, shape: { type: "text" } },
    }
    const ended = (settled: NonNullable<InboxEntry["settled"]>): InboxEntry => ({ ...ask, settled })
    expect(endedLine(ended({ how: "answered", at: 1, answer: "Green" }))).toBe(
      "You answered: Green",
    )
    expect(endedLine(ended({ how: "dismissed", at: 1 }))).toBe(
      "You dismissed this entry. @moth was told.",
    )
    expect(endedLine(ended({ how: "ended", at: 1 }))).toContain("session ended")
    expect(endedLine(ask)).toBeNull()
  })

  it("has a short phrase for every way an entry ends", () => {
    expect(Object.keys(endedWords).toSorted()).toEqual([
      "answered",
      "away",
      "delivered",
      "dismissed",
      "ended",
      "gone",
      "lapsed",
      "read",
      "released",
      "replied",
      "stopped",
      "takenBack",
      "terminal",
      "worked",
    ])
    expect(endedWords.terminal).toBe("Answered in the terminal")
  })
})

describe("A shipping permit", () => {
  const permit: InboxEntry = {
    ...base,
    stopped: false,
    kind: "permit",
    permit: {
      id: "p1",
      title: "Merge PR #1190 into main",
      quote: null,
      givenAt: 1,
      until: 2,
      usedAt: null,
    },
  }

  it("is named by what it covers, and says how it ended", () => {
    expect(subjectOf(permit)).toBe("Merge PR #1190 into main")
    expect(endedLine({ ...permit, settled: { how: "takenBack", at: 1 } })).toBe(
      "You took back @moth's permit.",
    )
    expect(endedLine({ ...permit, settled: { how: "lapsed", at: 1 } })).toBe(
      "@moth's permit no longer stands.",
    )
  })
})

describe("A sheet's label", () => {
  it("says who wants what", () => {
    expect(labelOf(permission("Bash", "x"))).toBe("Wants to run a command")
    expect(labelOf(permission("Edit", "x"))).toBe("Wants to edit a file")
  })
})

describe("An Inbox entry's reading time", () => {
  const ask = (body: string): InboxEntry => ({
    ...base,
    kind: "ask",
    ask: { subject: "s", body, details: null, hardToUndo: null, shape: { type: "text" } },
  })

  it("is said only past about 120 words", () => {
    expect(readLabel(ask("a few words"))).toBeNull()
    expect(readLabel(ask("word ".repeat(130)))).toBe("1 min read")
    expect(readLabel(ask("word ".repeat(250)))).toBe("2 min read")
  })
})

describe("A limit that resumes", () => {
  const limit = (autoResume: boolean | null): InboxEntry => ({
    ...base,
    stopped: !autoResume,
    kind: "trouble",
    trouble: {
      type: "limit",
      minutes: 300,
      resetsAt: new Date(2026, 9, 14, 15, 40).getTime(),
      autoResume,
      evidence: [],
    },
  })

  it("says when, while Novadeck resumes it", () => {
    expect(resumesLabel(limit(true))).toBe("Resumes at 15:40")
    expect(resumesLabel(limit(false))).toBeNull()
    expect(resumesLabel(limit(null))).toBeNull()
  })
})

describe("A limit's window", () => {
  it("is named by its length, or plainly where the length is unknown", () => {
    expect(limitWindow(300)).toBe("5-hour")
    expect(limitWindow(45)).toBe("45-minute")
    expect(limitWindow(0)).toBe("usage")
    expect(limitWindow(10_080)).toBe("weekly")
    expect(limitWindow(1440)).toBe("daily")
  })

  it("names the models it covers after its length, where not all of them", () => {
    expect(limitWindow(10_080, "Fable")).toBe("weekly Fable")
    expect(limitWindow(0, "Gemini")).toBe("Gemini usage")
  })
})

describe("an agent's name in the Inbox", () => {
  it("is Nova for Nova, Pi for the person's, and the harness's for the rest", () => {
    expect(agentName("pi", true)).toBe("Nova")
    expect(agentName("pi")).toBe("Pi")
    expect(agentName("claude", true)).toBe("Claude")
    expect(agentName("newer")).toBe("the agent")
  })
})
