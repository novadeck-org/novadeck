import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import {
  ask,
  choice,
  command,
  gone,
  planFeedback,
  questionsAnswer,
  read,
  same,
  sent,
  waits,
  without,
} from "./dialogs.test-support.js"

describe("Antigravity's plan review", () => {
  const request: RequestFacts = { kind: "plan", tool: "artifact", cwd: null, input: null }
  const written = planFeedback.afterWrite.screen120!.rows

  it("is a request the screen alone tells, by its footer over an empty idle prompt", () => {
    expect(dialogs.screenRequest!(written)).toEqual({
      kind: "plan",
      tool: "artifact",
      input: null,
      subject: "1 artifact to review",
    })
    // Not while the review itself is listed, as it is no longer the prompt.
    expect(dialogs.screenRequest!(planFeedback.review.screen120!.rows)).toBeUndefined()
    for (const none of [
      gone.planApproved!.rows,
      gone.planRejected!.rows,
      gone.ask!.rows,
      command.pending.screen120!.rows,
      ask.pending.screen120!.rows,
      [],
    ])
      expect(dialogs.screenRequest!(none)).toBeUndefined()
  })

  it("offers Approve, Reject and Reject with feedback, a prompt for the words", () => {
    const found = read(written, request)
    expect(found.dialog).toEqual({
      type: "choices",
      title: "1 artifact to review",
      detail: null,
      options: [
        { id: "approve", label: "Approve", text: null },
        { id: "reject", label: "Reject", text: null },
        { id: "feedback", label: "Tell it what to change", text: "field" },
      ],
    })
  })

  it("types /artifact, waits for the review, then y or n", () => {
    const found = read(written, request)
    const approve = found.keys(choice("approve"))
    expect(sent(approve)).toEqual(["/artifact", "\r", "y"])
    expect(sent(found.keys(choice("reject")))).toEqual(["/artifact", "\r", "n"])
    // Its feedback is a plain prompt, with neither y nor n, which would reject first.
    const feedback = found.keys(choice("feedback", "Use SQLite"))
    expect(sent(feedback)).toEqual(['"Use SQLite"', "\r"])
    // It presses Enter only once the words show in the prompt box, not on another row.
    const [typedIn] = waits(feedback)!
    expect(typedIn!(written)).toBe(false)
    expect(typedIn!(same(written, ">", "> Use SQLite"))).toBe(true)
    expect(typedIn!([...written, "> Use SQLite"])).toBe(false)
    expect(typedIn!(same(written, ">", "> Use SQL"))).toBe(false)
    // Words that start a slash command or help are refused, with or without space before.
    // Nor a shell: `!` in the empty box activates bash mode and runs it (probed).
    for (const text of [
      "/clear",
      " /artifact",
      "?",
      "? help",
      "!echo hi",
      "  !ls",
      "@notes",
      "fix @notes",
      "mail a@b",
    ])
      expect(found.keys(choice("feedback", text))).toBeUndefined()
    expect(sent(found.keys(choice("feedback", "use /clear or !ls")))).toBeDefined()
    expect(found.keys(choice("feedback"))).toBeUndefined()
    expect(found.keys(choice("feedback", "a\nb"))).toBeUndefined()
    const [listed] = waits(approve)!
    expect(listed!(planFeedback.review.screen120!.rows)).toBe(true)
    expect(listed!(written)).toBe(false)
    expect(listed!(without(planFeedback.review.screen120!.rows, /^Action required/))).toBe(false)
    expect(found.keys(choice("approve", "go"))).toBeUndefined()
    expect(found.keys(choice("later"))).toBeUndefined()
    expect(found.keys(questionsAnswer({ question: "1", options: ["1"] }))).toBeUndefined()
  })

  it("is answered once the review is closed, as the turn it starts shows", () => {
    const found = read(written, request)
    expect(found.answered(written)).toBe(false)
    expect(found.answered(planFeedback.review.screen120!.rows)).toBe(false)
    expect(found.answered(gone.planApproved!.rows)).toBe(true)
    expect(found.answered(gone.planRejected!.rows)).toBe(true)
  })

  it("reads as the same request with /artifact typed or its review listed, with no keys", () => {
    const found = read(written, request)
    const typed = same(written, ">", "> /artifact")
    for (const state of [typed, planFeedback.review.screen120!.rows]) {
      const now = read(state, request)
      expect(now.dialog).toEqual(found.dialog)
      expect(now.keys(choice("approve"))).toBeUndefined()
    }
  })

  it("reads a draft in the prompt box as the same dialog, with no keys, as /artifact would join it", () => {
    const draft = read(same(written, ">", "> half a sent"), request)
    expect(draft.keys(choice("approve"))).toBeUndefined()
    expect(dialogs.screenRequest!(same(written, ">", "> half a sent"))).toBeUndefined()
  })

  it("is none once the screen is broken, or where keys would reach something else", () => {
    const breaks = [
      // A turn running, not the idle prompt.
      same(written, /^\? for shortcuts/, "esc to cancel"),
      // More than one artifact, which y and n take one by one.
      same(written, /artifact to review$/, "2 artifacts · /artifact to review"),
      without(written, /artifact to review$/),
      [],
    ]
    for (const broken of breaks) expect(dialogs.read(broken, request)).toBeUndefined()
    expect(dialogs.read(written, { ...request, tool: "plan" })).toBeUndefined()
    expect(dialogs.read(written, { ...request, kind: "question" })).toBeUndefined()
  })
})
