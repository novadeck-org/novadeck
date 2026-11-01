import { describe, expect, it } from "vitest"

import { rolloutCall } from "./rollout.js"

const rolloutWorkdir = (text: string, turn: string, command: string) =>
  rolloutCall(text, turn, command).workdir

const turn = "01a198d1-eb71-7e73-bc08-b87341b034be"
const command = "touch /tmp/x/ran.txt"

// A rollout's lines as Codex 0.165.0 wrote them (probe, approvals-probes/captures/codexrollout-*).
const call = (id: string, args: object, over: { turn?: string; name?: string } = {}) =>
  JSON.stringify({
    timestamp: "2026-11-01T20:34:16.747Z",
    ordinal: 10,
    type: "response_item",
    payload: {
      type: "function_call",
      status: "completed",
      id: `fc_${id}`,
      name: over.name ?? "exec_command",
      arguments: JSON.stringify(args),
      call_id: id,
      internal_chat_message_metadata_passthrough: { turn_id: over.turn ?? turn },
    },
    metadata: { client_authored: false, user_input_order: 1 },
  })
const output = (id: string) =>
  JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", id: `fco_${id}`, call_id: id, output: "x" },
  })
const text = (...lines: string[]) => `${lines.join("\n")}\n`
const args = { cmd: command, sandbox_permissions: "require_escalated" }

describe("the folder Codex's rollout gives a call", () => {
  it("is the workdir the model passed, as written", () => {
    expect(
      rolloutWorkdir(text(call("a", { ...args, workdir: "/tmp/x/elsewhere" })), turn, command),
    ).toBe("/tmp/x/elsewhere")
    expect(rolloutWorkdir(text(call("a", { ...args, workdir: "sub/pkg" })), turn, command)).toBe(
      "sub/pkg",
    )
  })

  it("is null where the call names none", () => {
    expect(rolloutWorkdir(text(call("a", args)), turn, command)).toBeNull()
    expect(rolloutWorkdir(text(call("a", { ...args, workdir: null })), turn, command)).toBeNull()
    expect(rolloutWorkdir(text(call("a", { ...args, workdir: "" })), turn, command)).toBeNull()
  })

  it("is undefined where the call is not on disk, or not that turn's, command's or tool's", () => {
    expect(rolloutWorkdir("", turn, command)).toBeUndefined()
    expect(rolloutWorkdir(text(call("a", args, { turn: "other" })), turn, command)).toBeUndefined()
    expect(
      rolloutWorkdir(text(call("a", { ...args, cmd: "touch /y" })), turn, command),
    ).toBeUndefined()
    expect(rolloutWorkdir(text(call("a", args, { name: "shell" })), turn, command)).toBeUndefined()
  })

  it("is undefined where more than one call could be it, but an earlier one with output is not", () => {
    expect(
      rolloutWorkdir(text(call("a", args), call("b", { ...args, workdir: "/e" })), turn, command),
    ).toBeUndefined()
    expect(
      rolloutWorkdir(
        text(call("a", args), output("a"), call("b", { ...args, workdir: "/e" })),
        turn,
        command,
      ),
    ).toBe("/e")
    expect(rolloutWorkdir(text(call("a", args), output("a")), turn, command)).toBeUndefined()
  })

  it("is undefined for a workdir that is no text, and skips a cut or foreign line", () => {
    expect(rolloutWorkdir(text(call("a", { ...args, workdir: 3 })), turn, command)).toBeUndefined()
    const cut = call("z", args).slice(40)
    expect(
      rolloutWorkdir(
        text(cut, "not json function_call", call("a", { ...args, workdir: "/w" })),
        turn,
        command,
      ),
    ).toBe("/w")
  })
})

describe("the call must be the turn's newest exec_command", () => {
  it("is undefined when a later exec_command of the turn is on disk", () => {
    const later = call("b", { cmd: "ls" })
    expect(rolloutCall(text(call("a", args), later), turn, command).workdir).toBeUndefined()
    // Another turn's later call doesn't count.
    expect(
      rolloutCall(text(call("a", args), call("b", { cmd: "ls" }, { turn: "other" })), turn, command)
        .workdir,
    ).toBeNull()
  })
})

const started = (id: string, kind: string) =>
  JSON.stringify({
    type: "event_msg",
    payload: { type: "task_started", turn_id: id, collaboration_mode_kind: kind },
  })
const context = (id: string, mode: string) =>
  JSON.stringify({
    type: "turn_context",
    payload: { turn_id: id, collaboration_mode: { mode, settings: {} } },
  })

describe("the turn's mode, from Codex's rollout", () => {
  const planning = (...lines: string[]) =>
    rolloutCall(text(...lines, call("a", args)), turn, command).planning

  it("is planning where the turn's start or its context says plan", () => {
    expect(planning(started(turn, "plan"))).toBe(true)
    expect(planning(context(turn, "plan"))).toBe(true)
    expect(planning(started(turn, "default"), context(turn, "plan"))).toBe(true)
  })

  it("is not planning where the turn's records name another mode", () => {
    expect(planning(started(turn, "default"))).toBe(false)
    expect(planning(context(turn, "default"))).toBe(false)
    expect(planning(started(turn, "default"), context(turn, "default"))).toBe(false)
  })

  it("is undefined where the turn's mode isn't on disk, whatever other turns say", () => {
    expect(planning()).toBeUndefined()
    expect(planning(started("other", "default"), context("other", "default"))).toBeUndefined()
    expect(planning(started(turn, "plan").slice(10))).toBeUndefined()
    expect(planning(started("other", "plan"))).toBeUndefined()
  })
})

describe("the arguments a call may carry", () => {
  const workdirOf = (extra: object) =>
    rolloutCall(text(call("a", { ...args, ...extra })), turn, command).workdir

  it("are the command, where it runs and how it waits, and that it asks to leave the sandbox", () => {
    expect(
      workdirOf({
        workdir: "/w",
        justification: "Touch a file",
        yield_time_ms: 1000,
        max_output_tokens: 2000,
        tty: false,
        sandbox_permissions: "require_escalated",
      }),
    ).toBe("/w")
    expect(workdirOf({ sandbox_permissions: "use_default" })).toBeNull()
  })

  it.each([
    ["a shell to launch", { shell: "/work/proj/tools/bash" }],
    ["a login shell", { login: true }],
    ["additional permissions", { additional_permissions: { file_system: { write: ["/"] } } }],
    ["asking for additional permissions", { sandbox_permissions: "with_additional_permissions" }],
    ["a prefix rule", { prefix_rule: ["git", "pull"] }],
    ["the older escalation field", { with_escalated_permissions: true }],
    ["a key it doesn't know", { env: { PATH: "." } }],
    ["a workdir that is no text", { workdir: 3 }],
    ["a tty, which write_stdin types into", { tty: true }],
  ])("refuse a call with %s", (_name, extra) => {
    expect(workdirOf(extra)).toBeUndefined()
  })
})

describe("the turn's folder", () => {
  it("is the turn_context's cwd of that turn", () => {
    const folderOf = (id: string, cwd: string) =>
      JSON.stringify({ type: "turn_context", payload: { turn_id: id, cwd } })
    expect(rolloutCall(text(folderOf(turn, "/p/a"), call("a", args)), turn, command).cwd).toBe(
      "/p/a",
    )
    expect(
      rolloutCall(text(folderOf("other", "/p/b"), call("a", args)), turn, command).cwd,
    ).toBeUndefined()
    expect(rolloutCall(text(call("a", args)), turn, command).cwd).toBeUndefined()
  })
})

// Codex 0.166.0, a call with a relative workdir (probe, approvals-probes/captures/codexargs-x1d):
// its hooks gave `cwd` as `<project>/sub`, the call's folder, while the turn ran in `<project>`.
describe("a relative workdir, as Codex 0.166 recorded it", () => {
  const rollout = [
    '{"type":"turn_context","payload":{"turn_id":"01a1991b-3366","cwd":"/tmp/novadeck-e2e-qRV0Ia/project"}}',
    '{"timestamp":"2026-11-01T21:54:19.531Z","ordinal":10,"type":"response_item","payload":{"type":"function_call","status":"completed","id":"fc_0db1","name":"exec_command","arguments":"{\\"cmd\\":\\"touch /tmp/novadeck-e2e-qRV0Ia/ran.txt\\",\\"workdir\\":\\"sub\\",\\"sandbox_permissions\\":\\"require_escalated\\",\\"justification\\":\\"j\\"}","call_id":"call_df44","internal_chat_message_metadata_passthrough":{"turn_id":"01a1991b-3366"}},"metadata":{"client_authored":false,"user_input_order":1}}',
  ].join("\n")

  it("keeps the workdir as written and the turn's folder apart", () => {
    expect(
      rolloutCall(rollout, "01a1991b-3366", "touch /tmp/novadeck-e2e-qRV0Ia/ran.txt"),
    ).toMatchObject({
      workdir: "sub",
      cwd: "/tmp/novadeck-e2e-qRV0Ia/project",
    })
  })
})

describe("calls of other tools in the same turn", () => {
  const other = (id: string, given: object, name = "shell_command") => call(id, given, { name })

  it("are the newest, or hold the same text, and then nothing is pinned", () => {
    const pinned = (...lines: string[]) => rolloutCall(text(...lines), turn, command).workdir
    expect(pinned(call("a", args))).toBeNull()
    // A later call of any tool is the newest, not this one.
    expect(pinned(call("a", args), other("b", { command: "ls" }))).toBeUndefined()
    // The same text asked of another tool, pending, in either order.
    expect(pinned(other("b", { command, workdir: "/e" }), call("a", args))).toBeUndefined()
    expect(pinned(call("a", args), other("b", { command, workdir: "/e" }))).toBeUndefined()
    // Once the other has its output it is not in question; this call must still be the newest.
    expect(pinned(other("b", { command }), call("a", args))).toBeUndefined()
    expect(pinned(other("b", { command }), output("b"), call("a", args))).toBeNull()
  })
})
