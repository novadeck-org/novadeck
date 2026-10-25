import type { ChatDialogOption } from "@novadeck/core/conversation"
import type { InboxItem } from "@novadeck/core/inbox"

import { context, describe, expect, it } from "../test"
import {
  choicesOf,
  clock,
  codeParts,
  labelOf,
  limitWindow,
  needsWords,
  readLabel,
  refusedWords,
  recommended,
  resumesLabel,
  standingOf,
  subjectOf,
  toneOf,
  waitLabel,
} from "./inbox-text"

const source: InboxItem["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t",
  handle: "moth",
  agent: "claude",
  title: "Title",
  projectName: "Project",
}
const base = { id: "i", source, at: 0, stopped: true, seen: false }

const permission = (tool: string, subject: string | null): InboxItem => ({
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
  },
})

const asking = (subject: string | null, questions: number): InboxItem => ({
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
  },
})

const option = (
  id: string,
  label: string,
  text: "field" | "prompt" | null = null,
): ChatDialogOption => ({
  id,
  label,
  text,
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

const draft = (text: string): InboxItem => ({
  ...base,
  stopped: false,
  kind: "feedback",
  draft: { kind: "bug", text },
})

describe("An item's subject", () => {
  it("names a feedback draft's agent and the start of its first line", () => {
    expect(subjectOf(draft("\n  The toast covers the footer.\nMore."))).toBe(
      "Feedback draft from @moth: The toast covers the footer.",
    )
    expect(subjectOf(draft("x".repeat(100)))).toBe(`Feedback draft from @moth: ${"x".repeat(71)}…`)
    expect(subjectOf(draft(""))).toBe("Feedback draft from @moth")
    expect(labelOf(draft("a"))).toBe("Drafted feedback")
  })

  it("says what a command or an edit would do", () => {
    expect(subjectOf(permission("Bash", "pnpm test"))).toBe("Run `pnpm test`?")
    expect(subjectOf(permission("Edit", "src/a.ts"))).toBe("Edit `src/a.ts`?")
    expect(subjectOf(permission("WebFetch", "example.com"))).toBe("Use WebFetch on `example.com`?")
  })

  it("says how many more questions a call asks behind the first", () => {
    expect(subjectOf(asking(null, 1))).toBe("Question 1?")
    expect(subjectOf(asking(null, 3))).toBe("Question 1? (+2 more)")
    expect(subjectOf(asking("Which library?", 2))).toBe("Which library? (+1 more)")
  })

  it("names where a held message goes", () => {
    const item: InboxItem = {
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
    expect(subjectOf(item)).toBe("Release a held message to B?")
  })

  it("names a limit's window and whose it is", () => {
    const item: InboxItem = {
      ...base,
      kind: "trouble",
      trouble: { type: "limit", minutes: 300, resetsAt: 0, autoResume: true, evidence: [] },
    }
    expect(subjectOf(item)).toBe("Hit Claude's 5-hour limit")
  })

  it("counts the messages a hold keeps from the agent, and says what holds them", () => {
    const held = (count: number, waits: "draft" | "dialog"): InboxItem => ({
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
    // It waits on the person, but nothing failed.
    expect(toneOf(held(3, "draft"))).toBe("waiting")
  })
})

describe("A sheet's label", () => {
  it("says who wants what", () => {
    expect(labelOf(permission("Bash", "x"))).toBe("Wants to run a command")
    expect(labelOf(permission("Edit", "x"))).toBe("Wants to edit a file")
  })
})

describe("An item's reading time", () => {
  const ask = (body: string): InboxItem => ({
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
  const limit = (autoResume: boolean | null): InboxItem => ({
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

describe("How an item stands", () => {
  it("says how long ago a feedback draft was written, calmly", () => {
    expect(standingOf(draft("a"), 0, false)).toEqual({ status: "just now", tone: "calm" })
    expect(standingOf(draft("a"), 6 * 60_000, false)).toEqual({ status: "6m ago", tone: "calm" })
  })

  it("is waiting for a stopped agent, and working for the rest", () => {
    expect(standingOf(permission("Bash", "x"), 6 * 60_000, false)).toEqual({
      status: "waiting 6m",
      tone: "waiting",
    })
    expect(standingOf({ ...permission("Bash", "x"), stopped: false }, 0, false).status).toBe(
      "still working",
    )
  })

  it("says a limit whose reset has passed is resuming, not resuming in now", () => {
    const limit: InboxItem = {
      ...base,
      stopped: false,
      kind: "trouble",
      trouble: { type: "limit", minutes: 300, resetsAt: 1000, autoResume: true, evidence: [] },
    }

    expect(standingOf(limit, 5000, false).status).toBe("resuming")
    expect(standingOf(limit, 0, false).status).toMatch(/^resumes in/)
  })

  it("says answered once the person answered", () => {
    expect(standingOf(permission("Bash", "x"), 0, true).status).toBe("answered")
  })
})

describe("A permission's options", () => {
  context("with Codex's four", () => {
    const choices = choicesOf([
      option("yes", "Yes, proceed"),
      option("always", "Yes, and don't ask again for commands that start with `pnpm add`"),
      option("no", "No, continue without running it"),
      option("differently", "No, and tell Codex what to do differently", "prompt"),
    ])

    it("allows with the plain yes and keeps the standing one as a link", () => {
      expect(choices?.allow?.id).toBe("yes")
      expect(choices?.standing.map(({ id }) => id)).toEqual(["always"])
    })

    it("denies with the plain no, or the one that takes words", () => {
      expect(choices?.plain?.id).toBe("no")
      expect(choices?.note?.id).toBe("differently")
    })
  })

  context("with Claude's plan", () => {
    it("approves with the yes that sets nothing standing", () => {
      const choices = choicesOf([
        option("1", "Yes, and auto-accept edits"),
        option("2", "Yes, and manually approve edits"),
        option("3", "No, keep planning"),
      ])

      expect(choices?.allow?.id).toBe("2")
      expect(choices?.standing.map(({ id }) => id)).toEqual(["1"])
      expect(choices?.plain?.id).toBe("3")
    })

    // As the runner reads Claude Code 2.1.287's (harnesses/claude's plan-file probe).
    it("sends it back with the field that tells Claude what to change", () => {
      const choices = choicesOf([
        option("1", "Yes, auto-accept edits"),
        option("2", "Yes, manually approve edits"),
        option("3", "Tell Claude what to change", "field"),
      ])

      expect(choices?.allow?.id).toBe("2")
      expect(choices?.standing.map(({ id }) => id)).toEqual(["1"])
      expect(choices?.note?.id).toBe("3")
      expect(choices?.plain).toBeNull()
      expect(needsWords(choices!.note!)).toBe(true)
    })
  })

  context("with Antigravity's review", () => {
    const choices = choicesOf([
      option("approve", "Approve"),
      option("reject", "Reject"),
      option("feedback", "Tell it what to change", "field"),
    ])

    it("approves, rejects plainly, and sends words back with the field", () => {
      expect(choices?.allow?.id).toBe("approve")
      expect(choices?.plain?.id).toBe("reject")
      expect(choices?.note?.id).toBe("feedback")
    })
  })

  it("takes no words back from an option that can't carry them", () => {
    const choices = choicesOf([option("1", "Yes"), option("2", "Tell Claude what to change")])

    expect(choices?.note).toBeNull()
    expect(choices?.plain).toBeNull()
  })

  it("takes an agent's name of more than one word", () => {
    expect(needsWords(option("3", "Tell Claude Code what to change", "field"))).toBe(true)
  })

  it("needs no words for a no that says so itself", () => {
    expect(needsWords(option("3", "No, and tell Claude what to do differently", "prompt"))).toBe(
      false,
    )
  })

  context("with Claude's own words", () => {
    const choices = choicesOf([
      option("1", "Yes"),
      option("2", "Yes, and don't ask again for this command in /repo"),
      option("3", "No, and tell Claude what to do differently", "prompt"),
    ])

    it("allows with the plain yes, links the standing one, and denies only with words", () => {
      expect(choices?.allow?.id).toBe("1")
      expect(choices?.standing.map(({ id }) => id)).toEqual(["2"])
      expect(choices?.note?.id).toBe("3")
      expect(choices?.plain).toBeNull()
    })
  })

  context("with Allow and Deny", () => {
    const choices = choicesOf([
      option("a", "Allow once"),
      option("b", "Allow for this session"),
      option("c", "Deny"),
    ])

    it("allows once, and denies with Deny", () => {
      expect(choices?.allow?.id).toBe("a")
      expect(choices?.standing.map(({ id }) => id)).toEqual(["b"])
      expect(choices?.plain?.id).toBe("c")
    })
  })

  context("with Claude's plan, bypass first", () => {
    const choices = choicesOf([
      option("1", "Yes, and bypass permissions"),
      option("2", "Yes, clear context and auto-accept edits"),
      option("3", "Yes, and manually approve edits"),
      option("4", "No, keep planning", "prompt"),
    ])

    it("leads with the manual yes alone, leaving the rest as quiet links", () => {
      expect(choices?.allow?.id).toBe("3")
      // With a yes leading, bypass is no button beside it: a quiet link, as auto-accept is.
      expect(choices?.standing.map(({ id }) => id)).toEqual(["1", "2"])
      expect(choices?.unsure).toEqual([])
    })
  })

  it("leads with no yes where none is bare or known, offering each as it words itself", () => {
    const choices = choicesOf([
      option("1", "Yes, and bypass permissions"),
      option("2", "Yes, and don't ask again"),
    ])

    expect(choices?.allow).toBeNull()
    expect(choices?.standing.map(({ id }) => id)).toEqual(["2"])
    expect(choices?.unsure.map(({ id }) => id)).toEqual(["1"])
  })

  it.each([
    "Yes, auto mode",
    "Yes, permanently",
    "Yes, for the whole project",
    "Yes, allow this tool from now on",
    "Yes, but skip the sandbox",
    "Yes, bypass permissions",
    "Yes, clear context and manually approve edits",
  ])("never leads with %s", (label) => {
    const choices = choicesOf([option("a", label), option("n", "No")])

    expect(choices?.allow).toBeNull()
    expect([...(choices?.standing ?? []), ...(choices?.unsure ?? [])].map(({ id }) => id)).toEqual([
      "a",
    ])
  })

  it.each([
    "Yes",
    "Allow",
    "Approve",
    "Allow once",
    "Yes.",
    "Yes, proceed",
    "Yes, manually approve edits",
  ])("leads with %s", (label) => {
    expect(choicesOf([option("a", label)])?.allow?.id).toBe("a")
  })

  it("prefers a bare yes over a known one", () => {
    const choices = choicesOf([option("1", "Yes, proceed"), option("2", "Yes")])

    expect(choices?.allow?.id).toBe("2")
    expect(choices?.standing.map(({ id }) => id)).toEqual(["1"])
  })

  it("keeps a bracket that may qualify the yes, so it doesn't lead", () => {
    expect(choicesOf([option("1", "Yes (all)"), option("2", "No")])?.allow).toBeNull()
    const both = choicesOf([option("1", "Yes (a)"), option("2", "Yes (y)"), option("3", "No")])
    expect(both?.allow?.id).toBe("2")
    expect(both?.standing.map(({ id }) => id)).toEqual(["1"])
  })

  it("reads a yes past the key hint its harness prints after it", () => {
    const choices = choicesOf([option("1", "Yes, proceed (y)"), option("2", "No (esc)")])

    expect(choices?.allow?.id).toBe("1")
    expect(choices?.plain?.id).toBe("2")
  })

  it("offers no Deny where nothing says no, and never a yes in its place", () => {
    const choices = choicesOf([option("a", "Yes"), option("b", "Yes, always")])

    expect(choices?.note).toBeNull()
    expect(choices?.plain).toBeNull()
  })

  it("has none where nothing says yes, or there are no options", () => {
    expect(choicesOf([option("a", "Continue"), option("b", "Stop")])).toBeNull()
    expect(choicesOf([])).toBeNull()
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
})

describe("Words a field won't take", () => {
  const feedback = option("feedback", "Tell it what to change", "field")

  it.each(["/compact", "  ?", "!ls", "see @notes.md"])("are said for Antigravity: %s", (words) => {
    expect(refusedWords("agy", feedback, words)).toBe(
      "Antigravity can't take words that start with /, ? or !, or that have an @.",
    )
  })

  it("are none for plain words, nor for other agents", () => {
    expect(refusedWords("agy", feedback, "Split the second step, then ask?")).toBeNull()
    expect(refusedWords("claude", feedback, "/compact")).toBeNull()
    expect(refusedWords("agy", option("n", "No", "prompt"), "/compact")).toBeNull()
  })
})
