import type { ChatDialogOption } from "@novadeck/core/conversation"
import type { InboxRow, Trouble } from "@novadeck/core/inbox"

import { context, describe, expect, it } from "../test"
import { answerable, menuOf, standingParts, type MenuRow } from "./console-menu"

const source: InboxRow["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t",
  handle: "crow",
  agent: "codex",
  title: "Title",
  projectName: "Project",
}
const base = { id: "i", source, at: 0, stopped: true, seen: false }

const permission = (
  options: readonly ChatDialogOption[],
  kind: "permission" | "plan" = "permission",
  agent: InboxRow["source"]["agent"] = "codex",
): InboxRow => ({
  ...base,
  source: { ...source, agent },
  kind: "request",
  request: {
    id: "r",
    kind,
    tool: kind === "plan" ? "ExitPlanMode" : "Bash",
    subject: "pnpm add x",
    choices: [],
    subagent: false,
    answered: false,
    dialog: { type: "choices", id: "d", title: null, detail: "pnpm add x", options },
  },
})

const codex: readonly ChatDialogOption[] = [
  { id: "yes", label: "Yes, proceed", text: null },
  {
    id: "always",
    label: "Yes, and don't ask again for commands that start with `pnpm add`",
    text: null,
  },
  { id: "no", label: "No, continue without running it", text: null },
  { id: "differently", label: "No, and tell Codex what to do differently", text: "prompt" },
]

const labels = (rows: readonly MenuRow[]): string[] => rows.map((row) => row.label)
const words = (row: MenuRow | undefined): Extract<MenuRow, { type: "words" }> => {
  if (row?.type !== "words") throw new Error("not a words row")
  return row
}

describe("A sheet's menu", () => {
  context("for a command permission", () => {
    const { rows } = menuOf(permission(codex), 0)

    it("leads with the plain yes, then the standing one with its scope under it, then the noes", () => {
      expect(labels(rows)).toEqual([
        "Allow",
        "Yes, and don't ask again",
        "Deny",
        "Deny, with your words",
        "Go to terminal",
      ])
      expect(rows[1]).toMatchObject({ effect: "for commands that start with `pnpm add`" })
      expect(rows[0]).toMatchObject({ effect: null, receipt: "Allowed @crow's command." })
    })

    it("sends the note with the option that takes words, and the plain no without them", () => {
      const note = words(rows[3])
      expect(note.required).toBe(false)
      expect(note.answer("Use npm.")).toEqual({
        kind: "request",
        answer: { type: "choice", dialog: "d", option: "differently", text: "Use npm." },
      })
      expect(note.answer("  ")).toEqual({
        kind: "request",
        answer: { type: "choice", dialog: "d", option: "no" },
      })
    })

    it("offers no Deny where no option says no", () => {
      expect(labels(menuOf(permission([{ id: "a", label: "Yes", text: null }]), 0).rows)).toEqual([
        "Allow",
        "Go to terminal",
      ])
    })

    it("offers only the way to the terminal where no option is a yes it can tell", () => {
      const odd = permission([
        { id: "run", label: "Run it", text: null },
        { id: "c", label: "Cancel", text: null },
      ])
      expect(menuOf(odd, 0).rows).toEqual([
        { type: "reveal", label: "Go to terminal", effect: null },
      ])
      expect(answerable(odd)).toBe(false)
      expect(answerable(permission(codex))).toBe(true)
    })

    it("is never hard to undo: a permission carries no such flag", () => {
      expect(menuOf(permission(codex), 0).hard).toBe(false)
    })
  })

  context("for a plan", () => {
    it("says and arms auto mode as it does bypass and auto-accept", () => {
      const { rows } = menuOf(
        permission(
          [
            { id: "auto", label: "Yes, and use auto mode", text: null },
            { id: "manual", label: "Yes, and manually approve edits", text: null },
          ],
          "plan",
        ),
        0,
      )
      expect(rows.find((row) => row.label === "Yes, and use auto mode")).toMatchObject({
        effect: "It acts without asking.",
        hard: true,
      })
    })

    it("approves with the plain yes, and says what a standing yes lets it do", () => {
      const { rows } = menuOf(
        permission(
          [
            { id: "bypass", label: "Yes, and bypass permissions", text: null },
            { id: "manual", label: "Yes, and manually approve edits", text: null },
            { id: "keep", label: "No, keep planning", text: "prompt" },
          ],
          "plan",
        ),
        0,
      )
      expect(labels(rows)).toEqual([
        "Approve",
        "Yes, and bypass permissions",
        "Send it back, with your words",
        "Go to terminal",
      ])
      expect(rows[0]).toMatchObject({
        answer: { kind: "request", answer: { option: "manual" } },
        receipt: "Approved @crow's plan.",
      })
      expect(rows[1]).toMatchObject({
        effect: "It edits and runs commands without asking.",
        hard: true,
      })
      // The plain yes is not a standing one.
      expect(rows[0]).not.toHaveProperty("hard")
      // An empty box keeps planning, by the no that takes words.
      expect(words(rows[2]).answer("")).toEqual({
        kind: "request",
        answer: { type: "choice", dialog: "d", option: "keep" },
      })
    })

    it("needs words where its only way back is them, and sends them on one line", () => {
      const { rows } = menuOf(
        permission(
          [
            { id: "1", label: "Yes, auto-accept edits", text: null },
            { id: "2", label: "Yes, manually approve edits", text: null },
            { id: "3", label: "Tell Claude what to change", text: "field" },
          ],
          "plan",
          "claude",
        ),
        0,
      )
      const back = words(rows[2])
      expect(back).toMatchObject({ required: true, field: "What Claude should change" })
      expect(back.answer("Add a rollback step\n\nand a test\t")).toEqual({
        kind: "request",
        answer: {
          type: "choice",
          dialog: "d",
          option: "3",
          text: "Add a rollback step and a test",
        },
      })
      expect(back.receipt("Add a rollback step")).toBe("Sent back @crow's plan, with your words.")
    })

    it("says before sending that Antigravity can't take words that start with a command", () => {
      const { rows } = menuOf(
        permission(
          [
            { id: "approve", label: "Approve", text: null },
            { id: "reject", label: "Reject", text: null },
            { id: "feedback", label: "Tell it what to change", text: "field" },
          ],
          "plan",
          "agy",
        ),
        0,
      )
      expect(labels(rows)).toEqual([
        "Approve",
        "Send it back",
        "Send it back, with your words",
        "Go to terminal",
      ])
      const back = words(rows[2])
      expect(back.refused("/compact")).toBe(
        "Antigravity can't take words that start with /, ? or !, or that have an @.",
      )
      expect(back.refused("Split the second step")).toBeNull()
    })
  })

  context("on every harness", () => {
    // Each harness's own options, as its adapter reads them.
    const harnessPermissions: readonly [string, InboxRow["source"]["agent"], ChatDialogOption[]][] =
      [
        [
          "Claude Code",
          "claude",
          [
            { id: "1", label: "Yes", text: null },
            { id: "2", label: "Yes, and don't ask again for example.com", text: null },
            { id: "3", label: "No", text: null },
            { id: "tell", label: "No, and tell Claude what to do", text: "prompt" },
          ],
        ],
        // Codex numbers its options.
        ["Codex", "codex", codex.map((each, at) => ({ ...each, id: String(at + 1) }))],
        [
          "Antigravity",
          "agy",
          [
            { id: "1", label: "Yes, run command", text: null },
            {
              id: "2",
              label:
                "Yes, and always allow in this conversation for commands that start with 'echo'",
              text: null,
            },
            {
              id: "3",
              label:
                "Yes, and always allow for commands that start with 'echo' (Persist to settings.json)",
              text: null,
            },
            { id: "4", label: "No, cancel", text: "prompt" },
          ],
        ],
      ]
    const harnessPlans: readonly [string, InboxRow["source"]["agent"], ChatDialogOption[]][] = [
      [
        "Claude Code",
        "claude",
        [
          { id: "1", label: "Yes, auto-accept edits", text: null },
          { id: "2", label: "Yes, manually approve edits", text: null },
          { id: "3", label: "Tell Claude what to change", text: "field" },
        ],
      ],
      [
        "Codex",
        "codex",
        [
          { id: "1", label: "Yes, implement this plan", text: null },
          { id: "2", label: "Yes, clear context and implement", text: null },
          { id: "3", label: "No, stay in Plan mode", text: "prompt" },
        ],
      ],
      [
        "Antigravity",
        "agy",
        [
          { id: "approve", label: "Approve", text: null },
          { id: "reject", label: "Reject", text: null },
          { id: "feedback", label: "Tell it what to change", text: "field" },
        ],
      ],
    ]
    const wordsRow = (rows: readonly MenuRow[]) => words(rows.find((row) => row.type === "words"))

    it.each(harnessPermissions)(
      "names %s's no with words Deny, with your words, and sends its own option",
      (_, agent, options) => {
        const back = wordsRow(menuOf(permission(options, "permission", agent), 0).rows)
        const note = options.find((each) => each.text !== null)!
        expect(back.label).toBe("Deny, with your words")
        expect(back.answer("Use npm.")).toMatchObject({
          answer: { option: note.id, text: "Use npm." },
        })
      },
    )

    it.each(harnessPlans)(
      "names %s's way back with words Send it back, with your words, and sends its own option",
      (_, agent, options) => {
        const back = wordsRow(menuOf(permission(options, "plan", agent), 0).rows)
        const note = options.find((each) => each.text !== null)!
        expect(back.label).toBe("Send it back, with your words")
        expect(back.answer("Split it.")).toMatchObject({
          answer: { option: note.id, text: "Split it." },
        })
      },
    )

    it("keeps the harness's words on a yes that sets something standing, or that isn't plain", () => {
      const [, , claude] = harnessPlans[0]!
      const [, , numbered] = harnessPermissions[1]!
      const [, , agy] = harnessPermissions[2]!
      expect(labels(menuOf(permission(claude, "plan", "claude"), 0).rows)).toEqual([
        "Approve",
        "Yes, auto-accept edits",
        "Send it back, with your words",
        "Go to terminal",
      ])
      expect(labels(menuOf(permission(numbered, "permission", "codex"), 0).rows)).toEqual([
        "Allow",
        "Yes, and don't ask again",
        "Deny",
        "Deny, with your words",
        "Go to terminal",
      ])
      // No yes is plain here, so the run-once yes keeps its words too.
      expect(labels(menuOf(permission(agy, "permission", "agy"), 0).rows)).toEqual([
        "Yes, run command",
        "Yes, and always allow in this conversation for commands that start with 'echo'",
        "Yes, and always allow for commands that start with 'echo' (Persist to settings.json)",
        "Deny, with your words",
        "Go to terminal",
      ])
    })
  })

  context("for an agent's ask", () => {
    const asked = (shape: Extract<InboxRow, { kind: "ask" }>["ask"]["shape"], hard?: string) =>
      ({
        ...base,
        kind: "ask",
        ask: { subject: "s", body: "", details: null, hardToUndo: hard ?? null, shape },
      }) satisfies InboxRow

    it("numbers its options, tags its pick, and always takes the person's own words", () => {
      const { rows, hard } = menuOf(
        asked({
          type: "options",
          recommend: 1,
          options: [
            { label: "Retry", summary: "Three times.", details: null, code: null },
            { label: "Queue", summary: null, details: "- More.", code: null },
          ],
        }),
        0,
      )
      expect(labels(rows)).toEqual(["Retry", "Queue", "Reply in your own words", "Go to terminal"])
      expect(rows[0]).toMatchObject({ effect: "Three times.", pick: false, details: null })
      expect(rows[1]).toMatchObject({ pick: true, details: { details: "- More." } })
      expect(rows[1]).toMatchObject({
        answer: { kind: "ask", answer: { type: "reply", option: 1, text: "" } },
      })
      expect(words(rows[2]).answer(" Neither. ")).toEqual({
        kind: "ask",
        answer: { type: "reply", option: null, text: "Neither." },
      })
      expect(hard).toBe(false)
    })

    it("is hard to undo where the agent says its answer is", () => {
      expect(menuOf(asked({ type: "text" }, "It sets the schema."), 0).hard).toBe(true)
    })

    it("offers the done button and the person's words for something only they can do", () => {
      const { rows } = menuOf(
        asked({
          type: "action",
          command: "vercel login",
          directory: null,
          doneLabel: "I've logged in",
        }),
        0,
      )
      expect(labels(rows)).toEqual(["I've logged in", "Reply in your own words", "Go to terminal"])
      expect(rows[0]).toMatchObject({ receipt: "Told @crow it's done." })
    })
  })

  context("for trouble", () => {
    const troubled = (trouble: Trouble, stopped = true): InboxRow => ({
      ...base,
      stopped,
      kind: "trouble",
      trouble,
    })

    it("asks a failed agent at rest to fix it, saying what it sends, and reads a stored one", () => {
      const { rows } = menuOf(troubled({ type: "failed", error: "x", stored: true }), 0)
      expect(labels(rows)).toEqual(["Ask it to fix", "Mark read", "Go to terminal"])
      expect(rows[0]!).toMatchObject({
        effect: "Sends: “Your last turn ended in an error. Look at what went wrong and fix it.”",
      })
      expect(
        labels(menuOf(troubled({ type: "failed", error: "x", stored: true }, false), 0).rows),
      ).toEqual(["Mark read", "Go to terminal"])
    })

    it("offers Continue only once a limit has reset, and the switch only where Novadeck can resume", () => {
      const limit = (autoResume: boolean | null, resetsAt: number) =>
        troubled({ type: "limit", minutes: 300, resetsAt, autoResume, evidence: [] })
      expect(labels(menuOf(limit(null, 100), 50).rows)).toEqual(["Go to terminal"])
      expect(labels(menuOf(limit(null, 100), 200).rows)).toEqual(["Continue now", "Go to terminal"])
      expect(menuOf(limit(true, 100), 50).rows).toMatchObject([
        {
          type: "toggle",
          on: true,
          change: { kind: "trouble", action: { type: "auto-resume", on: false } },
        },
        { type: "reveal", label: "Go to terminal" },
      ])
    })

    it("nudges a stuck agent with its own line or the person's words, as theirs", () => {
      const { rows } = menuOf(
        troubled({ type: "stuck", summary: "", evidence: [], nudge: "Try another way." }),
        0,
      )
      expect(labels(rows)).toEqual([
        "Nudge it",
        "Nudge it in your own words",
        "Stop it",
        "Go to terminal",
      ])
      expect(rows[0]).toMatchObject({
        answer: { kind: "trouble", action: { type: "nudge", text: "Try another way." } },
      })
      expect(words(rows[1]).answer("Read the log.")).toEqual({
        kind: "trouble",
        action: { type: "nudge", text: "Read the log.", own: true },
      })
    })
  })

  context("on every row", () => {
    it("ends on the way to its terminal, and offers it only once", () => {
      const update: InboxRow = {
        ...base,
        kind: "update",
        update: { type: "done", subject: "s", body: "" },
      }
      const unanswerable = permission([{ id: "run", label: "Run it", text: null }])
      for (const inboxRow of [permission(codex), update, unanswerable]) {
        const menuRows = menuOf(inboxRow, 0).rows
        expect(menuRows.at(-1)).toEqual({ type: "reveal", label: "Go to terminal", effect: null })
        expect(menuRows.filter((menuRow) => menuRow.type === "reveal")).toHaveLength(1)
      }
    })
  })
})

describe("A standing yes's two lines", () => {
  it("puts its scope under what it is", () => {
    expect(standingParts("Yes, and don't ask again for these files")).toEqual({
      label: "Yes, and don't ask again",
      effect: "for these files",
    })
  })

  it("stays one line where there is no scope", () => {
    expect(standingParts("Yes, allow all edits during this session")).toEqual({
      label: "Yes, allow all edits during this session",
      effect: null,
    })
  })
})
