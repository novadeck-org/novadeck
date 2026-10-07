import type { RequestAnswer } from "@novadeck/protocol"

import type { Report } from "../../shell/reports.js"
import type { ScreenText } from "../../terminals/screen.js"
import { describe, expect, it } from "../../test.js"
import { loadProbe } from "../../testing/probes.js"
import type { RequestFacts } from "../dialogs.js"
import type { HarnessEvent } from "../events.js"
import { harnesses } from "../registry.js"
import { dialogs } from "./dialogs.js"

type Hook = { readonly event: string; readonly payload: Report["payload"] }
type Scenario = {
  readonly screens?: Record<"wide" | "narrow", ScreenText>
  readonly screen?: ScreenText
  readonly hooksAll?: {
    readonly kind: string
    readonly event?: string
    readonly payload?: Report["payload"]
  }[]
  readonly pressed?: { readonly screen: ScreenText }[]
  readonly screenAfterEsc?: ScreenText
}
type Probe = { scenarios: Record<string, Scenario> }
const load = (file: string) => loadProbe(import.meta.dirname, file) as Probe
// The pin's screens, and those of the newest release probed (0.160.1).
const probe = load("ask.probe.json")
const newer = load("ask.probe.0.160.1.json")

const session = "11111111-2222-4333-8444-555555555555"
const hooks = (name: string, source = probe): readonly Hook[] =>
  source.scenarios[name]!.hooksAll!.filter(({ kind }) => kind === "start").map(
    ({ event, payload }) => ({ event: event!, payload: { ...payload!, session_id: session } }),
  )
const decoded = (hook: Hook, fields: Partial<Report> = {}): readonly HarnessEvent[] =>
  harnesses.codex.decode({
    terminalId: "t",
    token: "0".repeat(48),
    agent: "codex",
    event: hook.event,
    seq: 1000,
    instance: null,
    env: { cursor: false },
    payload: hook.payload,
    ...fields,
  })
const asks = (name: string, source = probe) =>
  hooks(name, source)
    .flatMap((hook) => decoded(hook))
    .filter((event) => event.type === "attention-requested")
// The request as the runner holds it for the dialog, from the hooks Codex fired.
const factsOf = (name: string, at = 0, source = probe): RequestFacts => {
  const event = asks(name, source)[at]!
  if (event.type !== "attention-requested") throw new Error("no request")
  return { kind: event.kind, tool: event.toolName, input: event.input, cwd: null }
}
const screen = (name: string, size: "wide" | "narrow" = "wide", source = probe): string[] => [
  ...source.scenarios[name]!.screens![size].rows,
]
const sizes = ["wide", "narrow"] as const

const read = (rows: readonly string[], facts: RequestFacts) => dialogs.read(rows, facts)
const keys = (rows: readonly string[], facts: RequestFacts, answer: RequestAnswer) =>
  read(rows, facts)!.keys(answer)
const choice = (option: string, text?: string): RequestAnswer => ({
  type: "choice",
  dialog: "d",
  option,
  ...(text !== undefined && { text }),
})
const replaced = (rows: readonly string[], from: string | RegExp, to: string): string[] => {
  const out = rows.map((row) => row.replace(from, to))
  expect(out).not.toEqual(rows)
  return out
}

describe("Codex's exec approval", () => {
  it("reads at both sizes with each option's key from its hint, and 'tell Codex' as a prompt", () => {
    const facts = factsOf("exec-approve")
    expect(facts).toMatchObject({ kind: "permission", tool: "Bash" })
    for (const size of sizes) {
      const found = read(screen("exec-approve", size), facts)!
      expect(found.dialog).toEqual({
        type: "choices",
        title: "Would you like to run the following command?",
        detail: "echo approved > probe-out.txt",
        options: [
          { id: "1", label: "Yes, proceed", text: null },
          {
            id: "2",
            label:
              "Yes, and don't ask again for commands that start with `echo approved > probe-out.txt`",
            text: null,
          },
          { id: "3", label: "No, and tell Codex what to do differently", text: "prompt" },
        ],
      })
      expect(found.keys(choice("1"))).toEqual([{ press: "y" }])
      expect(found.keys(choice("2"))).toEqual([{ press: "p" }])
      expect(found.keys(choice("3", "use ls instead"))).toEqual([{ press: "\x1b" }])
    }
  })

  it("takes words only for the option that takes them, and no option it hasn't", () => {
    const rows = screen("exec-approve")
    const facts = factsOf("exec-approve")
    expect(keys(rows, facts, choice("1", "words"))).toBeUndefined()
    expect(keys(rows, facts, choice("9"))).toBeUndefined()
    expect(
      keys(rows, facts, {
        type: "questions",
        dialog: "d",
        answers: [{ question: "a", options: [] }],
      }),
    ).toBeUndefined()
  })

  it("offers only what a long command's dialog offers, and matches its wrapped command", () => {
    const facts = factsOf("exec-long-command")
    for (const size of sizes) {
      const found = read(screen("exec-long-command", size), facts)!
      expect(found.dialog).toMatchObject({
        options: [
          { id: "1", label: "Yes, proceed" },
          { id: "2", label: "No, and tell Codex what to do differently", text: "prompt" },
        ],
      })
      expect(found.keys(choice("2"))).toEqual([{ press: "\x1b" }])
    }
  })

  it("is the dialog of the call whose command it shows, never the queued one's", () => {
    // The overlay showed the later call first (probed).
    const [first, second] = [factsOf("exec-two-queued", 0), factsOf("exec-two-queued", 1)]
    expect(JSON.stringify([first.input, second.input])).toContain("echo first")
    const rows = screen("exec-two-queued")
    const [asked, other] = String((first.input as { command: string }).command).includes("second")
      ? [first, second]
      : [second, first]
    expect(read(rows, asked)).toBeDefined()
    expect(read(rows, other)).toBeUndefined()
  })

  it("is answered once its dialog is gone, and not while it shows, or while another's does", () => {
    const facts = factsOf("exec-approve")
    const found = read(screen("exec-approve"), facts)!
    expect(found.answered(screen("exec-approve"))).toBe(false)
    expect(found.answered(screen("exec-approve", "narrow"))).toBe(false)
    expect(found.answered(probe.scenarios["exec-approve"]!.pressed![0]!.screen.rows)).toBe(true)
    const queued = screen("exec-two-queued")
    const second = read(queued, factsOf("exec-two-queued", 1))
    const first = read(queued, factsOf("exec-two-queued", 0))
    const shown = second ?? first!
    expect(shown.answered(probe.scenarios["exec-two-queued"]!.pressed![0]!.screen.rows)).toBe(true)
  })

  it("is no dialog on a screen without one", () => {
    const facts = factsOf("exec-approve")
    expect(read([], facts)).toBeUndefined()
    expect(read(probe.scenarios["y-with-no-dialog"]!.screen!.rows, facts)).toBeUndefined()
  })
})

describe("Codex's exec approval, as an update might change it", () => {
  const facts = factsOf("exec-approve")
  const rows = screen("exec-approve")

  it("follows a rebound shortcut hint, and drops an option whose hint is gone", () => {
    const rebound = replaced(replaced(rows, "(y)", "(a)"), "(esc)", "(ctrl+x)")
    expect(keys(rebound, facts, choice("1"))).toEqual([{ press: "a" }])
    expect(keys(rebound, facts, choice("3"))).toEqual([{ press: "\x18" }])
    expect(keys(rebound, facts, choice("2"))).toEqual([{ press: "p" }])
    const unbound = replaced(rows, " (p)", "")
    const found = read(unbound, facts)!
    expect((found.dialog as { options: unknown[] }).options).toHaveLength(2)
    expect(found.keys(choice("2"))).toBeUndefined()
    const chord = replaced(rows, "(y)", "(ctrl+shift+y)")
    expect((read(chord, facts)!.dialog as { options: unknown[] }).options).toHaveLength(2)
  })

  it("follows options that were reordered, by their hints", () => {
    const swapped = [...rows]
    const [one, three] = [
      swapped.findIndex((r) => r.includes("1. Yes, proceed")),
      swapped.findIndex((r) => r.includes("3. No,")),
    ]
    swapped[one] = rows[three]!.replace("3.", "1.").replace("  3", "› 1").replace("› 1", "› 1")
    swapped[three] = rows[one]!.replace("1.", "3.").replace("› ", "  ")
    const found = read(swapped, facts)!
    expect(found.keys(choice("1"))).toEqual([{ press: "\x1b" }])
    expect(found.keys(choice("3"))).toEqual([{ press: "y" }])
  })

  it("is no dialog when its title is reworded", () => {
    expect(read(replaced(rows, "Would you like to run", "Shall we run"), facts)).toBeUndefined()
  })

  it("is no dialog when an option's wording changed or an unknown option was added", () => {
    expect(read(replaced(rows, "Yes, proceed", "Sure, go ahead"), facts)).toBeUndefined()
    const extra = [...rows]
    extra.splice(extra.length - 1, 0, "  4. Yes, and run it twice (t)")
    expect(read(extra, facts)).toBeUndefined()
  })

  it("is no dialog when the command it shows differs from the request's", () => {
    expect(read(replaced(rows, "$ echo approved", "$ echo rejected"), facts)).toBeUndefined()
    expect(read(rows, { ...facts, input: { command: "rm -rf /" } })).toBeUndefined()
    expect(read(rows, { ...facts, input: null })).toBeUndefined()
  })

  it("is no dialog for another tool, kind or a dialog cut off from its title", () => {
    expect(read(rows, { ...facts, tool: "apply_patch" })).toBeUndefined()
    expect(read(rows, { ...facts, kind: "question" })).toBeUndefined()
    const top = rows.findIndex((row) => row.includes("Would you like"))
    expect(read(rows.slice(top + 1), facts)).toBeUndefined()
  })

  it("is no dialog when something other than its footer follows the options", () => {
    expect(read([...rows.slice(0, -1), "  something new"], facts)).toBeUndefined()
  })

  it("is no network access or terminal-input dialog", () => {
    expect(
      read(
        replaced(
          rows,
          "Would you like to run the following command?",
          'Do you want to approve network access to "x.test"?',
        ),
        facts,
      ),
    ).toBeUndefined()
    expect(
      read(
        replaced(
          rows,
          "Would you like to run the following command?",
          "Would you like to send input to terminal 3?",
        ),
        facts,
      ),
    ).toBeUndefined()
  })
})

describe("Codex's apply_patch approval", () => {
  it("reads at both sizes against the files the patch names", () => {
    const facts = factsOf("patch-approve")
    expect(facts.tool).toBe("apply_patch")
    for (const size of sizes) {
      const found = read(screen("patch-approve", size), facts)!
      expect(found.dialog).toMatchObject({
        title: "Would you like to make the following edits?",
        options: [
          { id: "1", label: "Yes, proceed", text: null },
          { id: "2", label: "Yes, and don't ask again for these files", text: null },
          { id: "3", label: "No, and tell Codex what to do differently", text: "prompt" },
        ],
      })
      expect(found.keys(choice("1"))).toEqual([{ press: "y" }])
      expect(found.keys(choice("2"))).toEqual([{ press: "a" }])
      expect(found.keys(choice("3", "no"))).toEqual([{ press: "\x1b" }])
      expect(found.answered(probe.scenarios["patch-approve"]!.pressed![0]!.screen.rows)).toBe(true)
    }
  })

  it("is no dialog when the destination is another file than the patch's", () => {
    const facts = factsOf("patch-approve")
    const rows = screen("patch-approve")
    expect(read(replaced(rows, "patched.txt", "other.txt"), facts)).toBeUndefined()
    const more = {
      ...facts,
      input: {
        command: `${(facts.input as { command: string }).command}\n*** Add File: second.txt`,
      },
    }
    expect(read(rows, more)).toBeUndefined()
    expect(
      read(rows, { ...facts, input: { command: "*** Begin Patch\n*** End Patch" } }),
    ).toBeUndefined()
    expect(
      read(replaced(rows, /Destination: .*/, "Destination: unavailable"), facts),
    ).toBeUndefined()
  })
})

describe("Codex's request_permissions", () => {
  it("reads at both sizes, from the call that has no PermissionRequest", () => {
    const facts = factsOf("request-permissions")
    expect(facts).toMatchObject({ kind: "permission", tool: "request_permissions" })
    for (const size of sizes) {
      const found = read(screen("request-permissions", size), facts)!
      expect(found.dialog).toMatchObject({
        title: "Would you like to grant these permissions?",
        options: [
          { id: "1", text: null },
          { id: "2", text: null },
          { id: "3", text: null },
          { id: "4", label: "No, continue without permissions", text: null },
        ],
      })
      expect(["1", "2", "3", "4"].map((id) => found.keys(choice(id)))).toEqual([
        [{ press: "y" }],
        [{ press: "r" }],
        [{ press: "a" }],
        [{ press: "d" }],
      ])
      expect(found.answered(probe.scenarios["request-permissions"]!.pressed![0]!.screen.rows)).toBe(
        true,
      )
    }
  })

  it("is no dialog when its reason is not the request's", () => {
    const facts = factsOf("request-permissions")
    expect(
      read(replaced(screen("request-permissions"), "Need network", "Need disk"), facts),
    ).toBeUndefined()
  })
})

describe("Codex's MCP tool approval", () => {
  const facts = factsOf("mcp-tool-approval")

  it("reads at both sizes, a digit per row", () => {
    expect(facts).toMatchObject({ kind: "permission", tool: "mcp__probe__touch" })
    for (const size of sizes) {
      const found = read(screen("mcp-tool-approval", size), facts)!
      expect(found.dialog).toEqual({
        type: "choices",
        title: 'Allow the probe MCP server to run tool "touch"?',
        detail: "name: a.txt",
        options: [
          { id: "1", label: "Allow", text: null },
          { id: "2", label: "Cancel", text: null },
        ],
      })
      expect(found.keys(choice("1"))).toEqual([{ press: "1" }])
      expect(found.keys(choice("2"))).toEqual([{ press: "2" }])
      expect(found.answered(probe.scenarios["mcp-tool-approval"]!.pressed![0]!.screen.rows)).toBe(
        true,
      )
    }
  })

  it("is no dialog for another tool or server, reordered rows or another wording", () => {
    const rows = screen("mcp-tool-approval")
    expect(read(rows, { ...facts, tool: "mcp__probe__other" })).toBeUndefined()
    expect(read(rows, { ...facts, tool: "mcp__other__touch" })).toBeUndefined()
    expect(read(replaced(rows, "1. Allow ", "1. Cancel"), facts)).toBeUndefined()
    expect(read(replaced(rows, "2. Cancel", "2. Deny  "), facts)).toBeUndefined()
    expect(read(replaced(rows, "Run the tool and continue", "Run it"), facts)).toBeUndefined()
  })

  it("leaves a server's own elicitation form raw", () => {
    const asked: RequestFacts = {
      kind: "permission",
      tool: "mcp__probe__ask_color",
      input: {},
      cwd: null,
    }
    for (const size of sizes) expect(read(screen("mcp-elicitation", size), asked)).toBeUndefined()
    expect(read(screen("mcp-elicitation"), facts)).toBeUndefined()
  })
})

const answer = (options: string[], text?: string): RequestAnswer => ({
  type: "questions",
  dialog: "d",
  answers: [{ question: "color", options, ...(text !== undefined && { text }) }],
})

describe("Codex's request_user_input", () => {
  const facts = factsOf("rui-default-on")
  const rows = screen("rui-default-on")
  const questions = {
    type: "questions",
    chat: "prompt",
    questions: [
      {
        id: "color",
        header: "Color",
        question: "Which color should the button be?",
        options: [
          { id: "1", label: "Blue (Recommended)", description: "The house color." },
          { id: "2", label: "Green", description: "Calmer." },
        ],
        multiSelect: false,
        text: true,
      },
    ],
  }

  it("is a question from its PreToolUse, resolved by its PostToolUse", () => {
    expect(facts).toMatchObject({ kind: "question", tool: "request_user_input" })
    const [pre, , , , post] = hooks("rui-default-on").filter(({ event }) =>
      ["PreToolUse", "PostToolUse"].includes(event),
    )
    expect(pre?.event).toBe("PreToolUse")
    const [asked] = decoded(pre!)
    const [done] = decoded(
      post ?? hooks("rui-default-on").find(({ event }) => event === "PostToolUse")!,
    )
    expect(asked).toMatchObject({
      type: "attention-requested",
      kind: "question",
      toolName: "request_user_input",
      subject: "Which color should the button be?",
      choices: ["Blue (Recommended)", "Green"],
      actor: null,
    })
    expect(done).toMatchObject({ type: "attention-resolved", outcome: "allowed" })
    expect((done as { requestId: string }).requestId).toBe(
      (asked as { requestId: string }).requestId,
    )
  })

  it("reads at both sizes: its questions and options with descriptions, and the none-of-the-above notes", () => {
    for (const size of sizes) {
      expect(read(screen("rui-default-on", size), facts)!.dialog).toEqual(questions)
    }
  })

  it("answers an option with its digit", () => {
    expect(keys(rows, facts, answer(["2"]))).toEqual([{ press: "2" }])
    expect(keys(screen("rui-default-on", "narrow"), facts, answer(["1"]))).toEqual([{ press: "1" }])
  })

  it("answers in words through the notes of 'None of the above', or of an option", () => {
    const wide = keys(rows, facts, answer([], "Red, please"))!
    expect(wide.filter((step) => "press" in step)).toEqual([
      { press: "\x1b[B" },
      { press: "\x1b[B" },
      { press: "\t" },
      { press: "\r" },
    ])
    expect(wide).toContainEqual({ type: "Red, please" })
    const option = keys(rows, facts, answer(["2"], "calmer than that"))!
    expect(option.filter((step) => "press" in step)).toEqual([
      { press: "\x1b[B" },
      { press: "\t" },
      { press: "\r" },
    ])
    expect(option).toContainEqual({ type: "calmer than that" })
    const waits = wide.filter((step) => "until" in step)
    expect(waits).toHaveLength(3)
    // It waits for the row to be highlighted, then for the notes to open, then for the words.
    const [highlight, notes] = waits as { until: (rows: readonly string[]) => boolean }[]
    expect(highlight!.until(rows)).toBe(false)
    const moved = [...rows]
    moved[moved.findIndex((r) => r.includes("1. Blue"))] =
      "    1. Blue (Recommended)  The house color."
    moved[moved.findIndex((r) => r.includes("3. None"))] =
      "  › 3. None of the above   Optionally, add details in notes (tab)"
    expect(highlight!.until(moved)).toBe(true)
    expect(notes!.until(rows)).toBe(false)
    expect(notes!.until([...moved, "  tab or esc to clear notes | enter to submit answer"])).toBe(
      true,
    )
  })

  it("takes no answer the dialog can't: none, several options, an unknown one", () => {
    expect(keys(rows, facts, answer([]))).toBeUndefined()
    expect(keys(rows, facts, answer(["1", "2"]))).toBeUndefined()
    expect(keys(rows, facts, answer(["7"]))).toBeUndefined()
    expect(
      keys(rows, facts, {
        type: "questions",
        dialog: "d",
        answers: [{ question: "other", options: ["1"] }],
      }),
    ).toBeUndefined()
    expect(keys(rows, facts, choice("1"))).toBeUndefined()
  })

  it("is answered once its question is gone, as the answer's line says", () => {
    const found = read(rows, facts)!
    expect(found.answered(rows)).toBe(false)
    expect(found.answered(screen("rui-default-on", "narrow"))).toBe(false)
    expect(found.answered(probe.scenarios["rui-default-on"]!.pressed![0]!.screen.rows)).toBe(true)
  })

  it("walks several questions, waiting for each", () => {
    const two = {
      ...facts,
      input: {
        questions: [
          ...(facts.input as { questions: unknown[] }).questions,
          {
            id: "size",
            header: "Size",
            question: "How big?",
            options: [
              { label: "S", description: "small" },
              { label: "L", description: "large" },
            ],
          },
        ],
      },
    }
    const first = replaced(rows, "Question 1/1", "Question 1/2")
    const steps = keys(first, two, {
      type: "questions",
      dialog: "d",
      answers: [
        { question: "color", options: ["2"] },
        { question: "size", options: ["1"] },
      ],
    })!
    expect(
      steps.map((step) => ("press" in step ? step.press : "until" in step ? "wait" : "type")),
    ).toEqual(["2", "wait", "1"])
    const wait = steps[1] as { until: (rows: readonly string[]) => boolean }
    expect(wait.until(first)).toBe(false)
    expect(
      wait.until([
        "  Question 2/2 (1 unanswered)",
        "  How big?",
        "  › 1. S  small",
        "    2. L  large",
        "    3. None of the above   Optionally, add details in notes (tab)",
      ]),
    ).toBe(true)
    expect(keys(first, two, answer(["1"]))).toBeUndefined()
  })
})

describe("Codex's request_user_input, as an update might change it", () => {
  const facts = factsOf("rui-default-on")
  const rows = screen("rui-default-on")

  it("is no dialog when the question's wording differs from the request's", () => {
    expect(read(replaced(rows, "Which color", "What colour"), facts)).toBeUndefined()
  })

  it("is no dialog when an option was relabelled, reordered or added", () => {
    expect(read(replaced(rows, "Green", "Teal"), facts)).toBeUndefined()
    const swapped = replaced(
      replaced(rows, "1. Blue (Recommended)  The house color.", "1. Green               Calmer."),
      "2. Green               Calmer.",
      "2. Blue (Recommended)  The house color.",
    )
    expect(read(swapped, facts)).toBeUndefined()
    const extra = [...rows]
    extra.splice(extra.length - 1, 0, "    4. Purple              Bold.")
    expect(read(extra, facts)).toBeUndefined()
    expect(read(replaced(rows, "None of the above", "Something else"), facts)).toBeUndefined()
  })

  it("is a dialog without its none-of-the-above row, taking no words", () => {
    const without = rows.filter((row) => !row.includes("None of the above"))
    const found = read(without, facts)!
    expect(found.dialog).toMatchObject({ questions: [{ text: false }] })
    expect(
      found.keys({
        type: "questions",
        dialog: "d",
        answers: [{ question: "color", options: ["1"], text: "x" }],
      }),
    ).toBeUndefined()
    expect(
      found.keys({
        type: "questions",
        dialog: "d",
        answers: [{ question: "color", options: ["1"] }],
      }),
    ).toEqual([{ press: "1" }])
  })

  it("is no dialog on another question than the first, or of another count", () => {
    expect(read(replaced(rows, "Question 1/1", "Question 2/2"), facts)).toBeUndefined()
    expect(read(replaced(rows, "Question 1/1", "Question 1/3"), facts)).toBeUndefined()
  })

  it("is no dialog while notes are open, where a digit would type", () => {
    expect(read([...rows, "  › Add notes"], facts)).toBeUndefined()
    expect(
      read([...rows, "  tab or esc to clear notes | enter to submit answer"], facts),
    ).toBeUndefined()
  })

  it("is no dialog when the request asks something it can't vouch for", () => {
    expect(read(rows, { ...facts, input: null })).toBeUndefined()
    expect(read(rows, { ...facts, input: { questions: [] } })).toBeUndefined()
    expect(
      read(rows, {
        ...facts,
        input: { questions: [{ id: "color", question: "Which color should the button be?" }] },
      }),
    ).toBeUndefined()
    expect(read(rows, { ...facts, tool: "other" })).toBeUndefined()
  })
})

describe("Codex's plan prompt", () => {
  const facts: RequestFacts = { kind: "plan", tool: "plan", input: null, cwd: null }

  it("is a request the screen tells, at both sizes", () => {
    for (const size of sizes) {
      expect(dialogs.screenRequest!(screen("plan-prompt", size))).toEqual({
        kind: "plan",
        tool: "plan",
        input: null,
        subject: "Implement this plan?",
      })
    }
    expect(dialogs.screenRequest!(screen("exec-approve"))).toBeUndefined()
    expect(dialogs.screenRequest!(screen("rui-default-on"))).toBeUndefined()
    expect(dialogs.screenRequest!([])).toBeUndefined()
  })

  it("reads three options, digits answering, with feedback as a prompt after 'stay in Plan mode'", () => {
    for (const size of sizes) {
      const found = read(screen("plan-prompt", size), facts)!
      expect(found.dialog).toEqual({
        type: "choices",
        title: "Implement this plan?",
        detail: null,
        options: [
          { id: "1", label: "Yes, implement this plan", text: null },
          { id: "2", label: "Yes, clear context and implement", text: null },
          { id: "3", label: "No, stay in Plan mode", text: "prompt" },
        ],
      })
      expect(found.keys(choice("1"))).toEqual([{ press: "1" }])
      expect(found.keys(choice("3", "split it"))).toEqual([{ press: "3" }])
      expect(found.keys(choice("2", "x"))).toBeUndefined()
      expect(found.answered(screen("plan-prompt", size))).toBe(false)
      expect(found.answered(probe.scenarios["plan-prompt-digit-3"]!.pressed![0]!.screen.rows)).toBe(
        true,
      )
    }
  })

  it("is no prompt when reworded, reordered or given a new option", () => {
    const rows = screen("plan-prompt")
    expect(
      dialogs.screenRequest!(replaced(rows, "Implement this plan?", "Build this plan?")),
    ).toBeUndefined()
    expect(
      read(replaced(rows, "No, stay in Plan mode", "No, keep planning"), facts),
    ).toBeUndefined()
    expect(
      read(replaced(rows, "Yes, clear context and implement", "Yes, compact and implement"), facts),
    ).toBeUndefined()
    const extra = [...rows]
    extra.splice(
      extra.findIndex((row) => row.includes("enter select")),
      0,
      "  4. Yes, and stop",
    )
    expect(read(extra, facts)).toBeUndefined()
    expect(dialogs.screenRequest!(extra)).toBeUndefined()
  })
})

describe("Codex's hooks, as attention", () => {
  it("raise every PermissionRequest with its tool's input", () => {
    expect(asks("exec-approve")).toMatchObject([
      {
        kind: "permission",
        toolName: "Bash",
        subject: "echo approved > probe-out.txt",
        input: {
          command: "echo approved > probe-out.txt",
          description: "Echo outside the sandbox",
        },
      },
    ])
    expect(asks("patch-approve")).toMatchObject([
      { toolName: "apply_patch", input: { command: expect.stringContaining("*** Begin Patch") } },
    ])
    expect(asks("mcp-tool-approval")).toMatchObject([
      { toolName: "mcp__probe__touch", input: { name: "a.txt" } },
    ])
  })

  it("raise request_permissions from its PreToolUse alone, and resolve it by its PostToolUse", () => {
    const [asked, ...rest] = asks("request-permissions")
    expect(rest).toEqual([])
    expect(asked).toMatchObject({
      kind: "permission",
      toolName: "request_permissions",
      input: { reason: "Need network for the build" },
    })
    const result = hooks("request-permissions")
      .filter(({ event }) => event === "PostToolUse")
      .flatMap((hook) => decoded(hook))
    expect(result[0]).toMatchObject({
      type: "attention-resolved",
      requestId: (asked as { requestId: string }).requestId,
    })
  })

  it("raise nothing from the PreToolUse of any other tool, which only the exec and patch requests follow", () => {
    for (const name of ["exec-approve", "patch-approve", "mcp-tool-approval"]) {
      const pre = hooks(name).filter(({ event }) => event === "PreToolUse")
      expect(pre.length).toBeGreaterThan(0)
      expect(pre.flatMap((hook) => decoded(hook))).toEqual([])
    }
  })

  it("lets a subagent's question be its own", () => {
    const pre = hooks("rui-default-on").find(({ event }) => event === "PreToolUse")!
    const [asked] = decoded({ ...pre, payload: { ...pre.payload, agent_id: "sub-1" } })
    expect(asked).toMatchObject({ actor: "sub-1", kind: "question" })
  })

  it("register the PreToolUse hook for those two tools alone", () => {
    const file = harnesses.codex
      .files("linux", { mcp: { command: "node", args: [] } } as never)
      .find(({ path }) => path.endsWith("hooks.json"))!
    const registered = JSON.parse(file.content).hooks.PreToolUse
    expect(registered).toHaveLength(1)
    expect(registered[0].matcher).toBe("request_user_input|request_permissions")
  })
})

describe("Codex's dialogs, matched strictly to their requests", () => {
  it("compare a command's whitespace exactly within a row, a row break standing for any break", () => {
    const facts = factsOf("exec-approve")
    const rows = screen("exec-approve")
    const shows = (...shown: string[]) => {
      const at = rows.findIndex((row) => row.includes("$ echo"))
      return [
        ...rows.slice(0, at),
        `  $ ${shown[0]}`,
        ...shown.slice(1).map((r) => `    ${r}`),
        ...rows.slice(at + 1),
      ]
    }
    const command = (text: string) => ({ ...facts, input: { command: text } })
    expect(read(shows("echo approved > probe-out.txt"), facts)).toBeDefined()
    expect(read(rows, command("echo approved >probe-out.txt"))).toBeUndefined()
    // Whitespace the screen shows must be the request's, and the request's must be shown.
    expect(
      read(shows("echo approved > probe-out.txt"), command("echo  approved > probe-out.txt")),
    ).toBeUndefined()
    expect(
      read(shows("echo  approved > probe-out.txt"), command("echo approved > probe-out.txt")),
    ).toBeUndefined()
    expect(read(shows("echo a\tb"), command("echo a b"))).toBeUndefined()
    // A row break may be a newline, a space or the middle of a word.
    expect(read(shows("echo a", "echo b"), command("echo a\necho b"))).toBeDefined()
    expect(read(shows("echo a", "echo b"), command("echo a echo b"))).toBeDefined()
    expect(read(shows("echo abc", "def"), command("echo abcdef"))).toBeDefined()
    expect(read(shows("echo a", "echo b"), command("echo aecho b"))).toBeDefined()
    expect(read(shows("echo a", "echo b"), command("echo a  echo c"))).toBeUndefined()
  })

  it("compare an MCP tool's printed arguments with the request's", () => {
    const facts = factsOf("mcp-tool-approval")
    const rows = screen("mcp-tool-approval")
    expect(read(replaced(rows, "name: a.txt", "name: b.txt"), facts)).toBeUndefined()
    expect(read(rows, { ...facts, input: { name: "a.txt", extra: 1 } })).toBeUndefined()
    expect(read(rows, { ...facts, input: {} })).toBeUndefined()
    expect(
      read(
        rows.filter((row) => !row.includes("name: a.txt")),
        facts,
      ),
    ).toBeUndefined()
    expect(
      read(
        rows.filter((row) => !row.includes("name: a.txt")),
        { ...facts, input: {} },
      ),
    ).toBeDefined()
  })

  it("compare request_permissions' rule and reason, and refuse a request with neither", () => {
    const facts = factsOf("request-permissions")
    const rows = screen("request-permissions")
    expect(read(rows, facts)!.dialog).toMatchObject({
      detail: "Permission rule: network\nReason: Need network for the build",
    })
    expect(
      read(replaced(rows, "Permission rule: network", "Permission rule: read `/etc`"), facts),
    ).toBeUndefined()
    expect(
      read(
        rows.filter((row) => !row.includes("Permission rule")),
        facts,
      ),
    ).toBeUndefined()
    expect(
      read(rows, { ...facts, input: { permissions: { network: { enabled: true } } } }),
    ).toBeUndefined()
    expect(
      read(rows, { ...facts, input: { reason: "Need network for the build" } }),
    ).toBeUndefined()
    expect(
      read(rows, {
        ...facts,
        input: { ...(facts.input as object), permissions: { file_system: { entries: [] } } },
      }),
    ).toBeUndefined()
  })

  it("show what each dialog asks about as its detail", () => {
    for (const size of sizes) {
      expect(
        read(screen("exec-long-command", size), factsOf("exec-long-command"))!.dialog,
      ).toMatchObject({
        detail: expect.stringContaining("second line of a long command"),
      })
      expect(read(screen("patch-approve", size), factsOf("patch-approve"))!.dialog).toMatchObject({
        detail: "/tmp/sandbox/project/patched.txt",
      })
    }
  })
})

describe("Codex's answered, on positive evidence", () => {
  const facts = factsOf("exec-approve")
  const done = probe.scenarios["exec-approve"]!.pressed![0]!.screen.rows

  it("needs the result line or the composer back, not just a screen that no longer reads", () => {
    const found = read(screen("exec-approve"), facts)!
    expect(found.answered(done)).toBe(true)
    expect(
      found.answered(
        done.filter((row) => !row.includes("shortcuts") && !row.includes("fake-model")),
      ),
    ).toBe(true)
    expect(found.answered(["  Would you like to run the follow"])).toBe(false)
    expect(found.answered([])).toBe(false)
    expect(found.answered(screen("exec-approve"))).toBe(false)
  })

  it("counts a result line even while an identical command's dialog is up again", () => {
    const found = read(screen("exec-approve"), facts)!
    const again = [...done.slice(0, 5), ...screen("exec-approve").slice(5)]
    expect(again.some((row) => row.includes("✔ You approved"))).toBe(true)
    expect(read(again, facts)).toBeDefined()
    expect(found.answered(again)).toBe(true)
  })

  it("does not take a result line that was already there", () => {
    const rows = [...done.slice(0, 5), ...screen("exec-approve").slice(3)]
    const found = read(rows, facts)!
    expect(found.answered(rows)).toBe(false)
  })
})

describe("Codex's plan prompt, only as the bottom popup", () => {
  const facts: RequestFacts = { kind: "plan", tool: "plan", input: null, cwd: null }
  const popup = screen("plan-prompt")

  it("is not text in the agent's output", () => {
    const text = popup.slice(popup.findIndex((row) => row.includes("Implement this plan?")))
    const output = [
      ...popup.slice(0, 4),
      ...text,
      "  Worked for 2s",
      "› Ask Codex to do anything",
      "  ? for shortcuts",
    ]
    expect(dialogs.screenRequest!(output)).toBeUndefined()
    expect(read(output, facts)).toBeUndefined()
  })

  it("is not a popup with anything after its footer, or without it", () => {
    expect(dialogs.screenRequest!([...popup, "  more"])).toBeUndefined()
    expect(dialogs.screenRequest!(popup.slice(0, -1))).toBeUndefined()
    expect(dialogs.screenRequest!([...popup, "", "   "])).toBeDefined()
  })
})

describe("Codex's notes field, after the words are typed", () => {
  const facts = factsOf("rui-default-on")
  const rows = screen("rui-default-on")

  it("waits for the words in the notes row itself, not a short answer found in another row", () => {
    const steps = keys(rows, facts, {
      type: "questions",
      dialog: "d",
      answers: [{ question: "color", options: [], text: "1" }],
    })!
    const typed = steps.findIndex((step) => "type" in step)
    const wait = steps[typed + 1] as { until: (rows: readonly string[]) => boolean }
    const base = rows.filter((row) => !row.includes("tab to add notes"))
    const open = (note: string) => [
      ...base,
      `  › ${note}`,
      "",
      "  tab or esc to clear notes | enter to submit answer",
    ]
    expect(wait.until(open("Add notes"))).toBe(false)
    expect(wait.until(open("1"))).toBe(true)
    // The options' own "1." and the header's "1/1" are not the words.
    expect(wait.until(open("Add notes").map((row) => row.replace("Blue", "Blue 1")))).toBe(false)
    expect(wait.until(rows)).toBe(false)
    expect(steps.at(-1)).toEqual({ press: "\r" })
  })

  it("accepts words that wrap, by their start", () => {
    const text = "Make it a calm green with a very long description of exactly why it should be so"
    const steps = keys(rows, facts, {
      type: "questions",
      dialog: "d",
      answers: [{ question: "color", options: ["2"], text }],
    })!
    const wait = steps[steps.findIndex((step) => "type" in step) + 1] as {
      until: (rows: readonly string[]) => boolean
    }
    const base = rows.filter((row) => !row.includes("tab to add notes"))
    expect(
      wait.until([
        ...base,
        "  › Make it a calm green with a very long",
        "    description of exactly why it",
        "  tab or esc to clear notes",
      ]),
    ).toBe(true)
    expect(wait.until([...base, "  › Make it a", "  tab or esc to clear notes"])).toBe(false)
  })
})

describe("Codex 0.160.1's dialogs, as probed", () => {
  // Their layout, wording and keys are the pin's; only the greeting, the spinner glyph and
  // the mode footer differ, and which queued call shows first varies from run to run.
  const cases = [
    { name: "exec-approve", options: 3, first: "y" },
    { name: "exec-long-command", options: 2, first: "y" },
    { name: "patch-approve", options: 3, first: "y" },
    { name: "request-permissions", options: 4, first: "y" },
    { name: "mcp-tool-approval", options: 2, first: "1" },
    { name: "plan-prompt", options: 3, first: "1" },
  ]

  it("read at both sizes with the same options and keys, and answer from their results", () => {
    for (const { name, options, first } of cases) {
      const facts: RequestFacts =
        name === "plan-prompt"
          ? { kind: "plan", tool: "plan", input: null, cwd: null }
          : factsOf(name, 0, newer)
      for (const size of sizes) {
        const found = read(screen(name, size, newer), facts)
        expect(found, `${name} ${size}`).toBeDefined()
        expect((found!.dialog as { options: unknown[] }).options, name).toHaveLength(options)
        expect(found!.keys(choice("1")), name).toEqual([{ press: first }])
      }
      const done = newer.scenarios[name]!.pressed![0]!.screen.rows
      expect(read(screen(name, "wide", newer), facts)!.answered(done), name).toBe(true)
    }
    expect(dialogs.screenRequest!(screen("plan-prompt", "wide", newer))).toBeDefined()
    expect(dialogs.screenRequest!(screen("plan-prompt", "narrow", newer))).toBeDefined()
  })

  it("read the question, with its answer's result line", () => {
    const facts = factsOf("rui-default-on", 0, newer)
    for (const size of sizes) {
      const found = read(screen("rui-default-on", size, newer), facts)!
      expect(found.keys(answer(["2"]))).toEqual([{ press: "2" }])
      expect(found.answered(newer.scenarios["rui-default-on"]!.pressed![0]!.screen.rows)).toBe(true)
    }
  })

  it("show the queued call the screen shows, whichever it is", () => {
    const rows = screen("exec-two-queued", "wide", newer)
    const [a, b] = [factsOf("exec-two-queued", 0, newer), factsOf("exec-two-queued", 1, newer)]
    expect([read(rows, a), read(rows, b)].filter((each) => each !== undefined)).toHaveLength(1)
  })
})

describe("Codex's request_user_input, set aside to talk it over", () => {
  const facts = factsOf("rui-default-on")
  const rows = screen("rui-default-on")
  const chat: RequestAnswer = { type: "chat", dialog: "d", text: "Let me clarify" }
  const after = [...probe.scenarios["rui-esc-then-prompt"]!.screenAfterEsc!.rows]

  it("is offered with its words as a prompt, at both sizes", () => {
    for (const size of sizes) {
      expect(read(screen("rui-default-on", size), facts)!.dialog).toMatchObject({ chat: "prompt" })
    }
  })

  it("presses Esc alone", () => {
    expect(keys(rows, facts, chat)).toEqual([{ press: "\x1b" }])
    expect(keys(rows, facts, { type: "chat", dialog: "d" })).toEqual([{ press: "\x1b" }])
  })

  it("is answered once the turn was interrupted and the composer is back, not before", () => {
    const found = read(rows, facts)!
    expect(found.answered(after)).toBe(true)
    expect(found.answered(rows)).toBe(false)
    expect(found.answered([])).toBe(false)
  })

  it("is no dialog while notes are open, where Esc would only close them", () => {
    expect(read([...rows, "  › Add notes", "  tab or esc to clear notes"], facts)).toBeUndefined()
  })
})

const given = (...answers: { question: string; options: string[]; text?: string }[]) =>
  ({ type: "questions", dialog: "d", answers }) as RequestAnswer

const second = (a: string, b: string) => [
  "  Question 2/2 (1 unanswered)",
  "  How big?",
  `  › 1. ${a}`,
  `    2. ${b}`,
  "    3. None of the above   Optionally, add details in notes (tab)",
  "  tab to add notes | enter to submit answer",
]

describe("Codex's request_user_input with several questions, and their words", () => {
  const facts = factsOf("rui-default-on")
  const two = {
    ...facts,
    input: {
      questions: [
        ...(facts.input as { questions: unknown[] }).questions,
        {
          id: "size",
          header: "Size",
          question: "How big?",
          options: [{ label: "S" }, { label: "L" }],
        },
      ],
    },
  }
  const first = replaced(screen("rui-default-on"), "Question 1/1", "Question 1/2")

  it("takes words for the first question only, reporting text per question", () => {
    const found = read(first, two)!
    expect(found.dialog).toMatchObject({
      questions: [
        { id: "color", text: true },
        { id: "size", text: false },
      ],
    })
    expect(
      found.keys(
        given(
          { question: "color", options: [], text: "purple" },
          { question: "size", options: ["1"] },
        ),
      ),
    ).toBeDefined()
    expect(
      found.keys(
        given(
          { question: "color", options: ["1"] },
          { question: "size", options: [], text: "huge" },
        ),
      ),
    ).toBeUndefined()
    expect(
      found.keys(
        given(
          { question: "color", options: ["1"] },
          { question: "size", options: ["2"], text: "huge" },
        ),
      ),
    ).toBeUndefined()
  })

  it("waits for a later question's options as the request lists them, before its digit", () => {
    const steps = read(first, two)!.keys(
      given({ question: "color", options: ["1"] }, { question: "size", options: ["2"] }),
    )!
    const wait = steps.find((step) => "until" in step) as {
      until: (rows: readonly string[]) => boolean
    }
    expect(wait.until(second("S", "L"))).toBe(true)
    // The options swapped, or another, or an extra one: the digit would pick the wrong row.
    expect(wait.until(second("L", "S"))).toBe(false)
    expect(wait.until(second("S", "XL"))).toBe(false)
    expect(wait.until([...second("S", "L").slice(0, 5), "    4. Huge", "  tab to add notes"])).toBe(
      false,
    )
    expect(wait.until([...second("S", "L"), "  › Add notes"])).toBe(false)
  })

  it("takes no words for any question where the first has no none-of-the-above row", () => {
    const without = first.filter((row) => !row.includes("None of the above"))
    expect(read(without, two)!.dialog).toMatchObject({
      questions: [{ text: false }, { text: false }],
    })
  })
})
