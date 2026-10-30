import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import {
  answer,
  asks,
  choice,
  decoded,
  factsOf,
  hooks,
  newer,
  probe,
  read,
  screen,
  sizes,
} from "./dialogs.test-support.js"
import { codex } from "./index.js"

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

  it("register the PreToolUse hook for those tools alone, the async question named whole", () => {
    const file = codex
      .files("linux", { mcp: { command: "node", args: [] } } as never)
      .find(({ path }) => path.endsWith("hooks.json"))!
    const registered = JSON.parse(file.content).hooks.PreToolUse
    expect(registered).toHaveLength(1)
    // A matcher matches a tool's whole name: `request_user_input` doesn't fire for the async one.
    expect(registered[0].matcher).toBe(
      "request_user_input|request_permissions|request_user_input_async",
    )
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

  // The rows up to its result line, then the dialog's from `from` on: found by what they
  // say, as a release may draw a line more or less above them (0.163.0 has no greeting).
  const answeredThen = (from: string) => {
    const rows = screen("exec-approve")
    return [
      ...done.slice(0, done.findIndex((row) => row.includes("✔ You approved")) + 1),
      ...rows.slice(rows.findIndex((row) => row.startsWith(from))),
    ]
  }

  it("counts a result line even while an identical command's dialog is up again", () => {
    const found = read(screen("exec-approve"), facts)!
    const again = answeredThen("  Would you like")
    expect(again.some((row) => row.includes("✔ You approved"))).toBe(true)
    expect(read(again, facts)).toBeDefined()
    expect(found.answered(again)).toBe(true)
  })

  it("does not take a result line that was already there", () => {
    const rows = answeredThen("› Run the command")
    const found = read(rows, facts)!
    expect(found.answered(rows)).toBe(false)
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
