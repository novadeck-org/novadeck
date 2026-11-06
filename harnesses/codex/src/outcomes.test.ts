import { describe, expect, it } from "vitest"

import { callChange, outputOutcome } from "./outcomes.js"
import { patchChange } from "./patch.js"
import { transcripts } from "./transcripts.js"

const header = (end: string) =>
  `Chunk ID: 9ec621\nWall time: 0.0000 seconds\n${end}\nOriginal token count: 2\nOutput:\n`

const event = (item: object): string =>
  JSON.stringify({
    timestamp: "2026-11-06T12:00:00.000Z",
    type: "event_msg",
    payload: { type: "item_completed", item },
  })

const command = (fields: object) => ({
  type: "CommandExecution",
  id: "exec-1",
  command: ["/bin/bash", "-lc", "cat a.txt"],
  status: "completed",
  exit_code: 0,
  aggregated_output: "one\ntwo\n",
  parsed_cmd: [{ type: "read", cmd: "cat a.txt", name: "a.txt", path: "a.txt" }],
  source: "unified_exec_startup",
  ...fields,
})

describe("what a Codex output says", () => {
  it("reads a process's end from the header above its output", () => {
    expect(outputOutcome(`${header("Process exited with code 3")}boom\n`)).toMatchObject({
      failed: true,
      exit: 3,
    })
    expect(outputOutcome(`${header("Process exited with code 0")}ok\n`)).toMatchObject({
      failed: false,
      exit: 0,
    })
  })

  it("takes nothing from what a command printed", () => {
    expect(
      outputOutcome(`${header("Process exited with code 0")}Process exited with code 7\n`),
    ).toMatchObject({ failed: false, exit: 0 })
    expect(outputOutcome("Process exited with code 7\n")).toBeNull()
    expect(outputOutcome("the log says apply_patch verification failed")).toBeNull()
    expect(outputOutcome("Output:\nScript failed\n")).toBeNull()
  })

  it("says a process that runs on is unknown yet", () => {
    expect(outputOutcome(`${header("Process running with session ID 36575")}`)).toMatchObject({
      failed: null,
      running: true,
    })
    expect(outputOutcome("Script running with cell ID 84\nWall time 31.0 seconds\n")).toMatchObject(
      { failed: null, running: true },
    )
  })

  it("reads a patch's end through a shell's header and its own", () => {
    const applied = "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess.\n"
    expect(outputOutcome(applied)).toMatchObject({ failed: false, exit: 0 })
    expect(outputOutcome(`Wall time: 0.0000 seconds\nOutput:\n${applied}`)).toMatchObject({
      failed: false,
      exit: 0,
    })
    expect(outputOutcome("apply_patch verification failed: no")).toMatchObject({ failed: true })
  })

  it("fails a script only on its own word", () => {
    expect(outputOutcome("Script completed\nWall time 0.1 seconds\nOutput:\n")).toBeNull()
    expect(outputOutcome("Script failed\nWall time 0.0 seconds\nOutput:\n")).toMatchObject({
      failed: true,
    })
  })

  it("knows nothing of another tool's output", () => {
    expect(outputOutcome('{"message":"Wait completed.","timed_out":false}')).toBeNull()
    expect(outputOutcome("")).toBeNull()
  })
})

describe("a patch's change", () => {
  it("counts a new file's and an update's lines", () => {
    const text =
      "*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** Update File: b.txt\n@@ fn x\n keep\n-old\n+new\n*** End Patch"
    const change = patchChange(text)
    expect(change).toMatchObject({ added: 3, removed: 1 })
    expect(change?.lines.map(({ sign, line }) => `${sign}${line}`)).toEqual([
      "+1",
      "+2",
      " null",
      "-null",
      "+null",
    ])
  })

  it("reads a patch out of a shell's heredoc", () => {
    expect(
      callChange(
        "exec_command",
        JSON.stringify({
          cmd: "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\nEOF",
        }),
      )?.change,
    ).toMatchObject({ added: 1, removed: 0 })
  })

  it("reads the tool's raw text and its JSON wrapper", () => {
    const patch = "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch"
    expect(callChange("apply_patch", patch)?.change?.added).toBe(1)
    expect(callChange("apply_patch", JSON.stringify({ input: patch }))?.change?.added).toBe(1)
  })

  it("leaves a patch that deletes a file unknown, as it doesn't say how long it was", () => {
    expect(
      patchChange("*** Begin Patch\n*** Delete File: a\n*** Update File: b\n@@\n+x\n*** End Patch"),
    ).toBeNull()
  })

  it("takes only a patch for a change", () => {
    expect(patchChange("*** Add File: a\n+x")).toBeNull()
    expect(callChange("exec_command", JSON.stringify({ cmd: "cat notes.patch" }))).toBeNull()
    expect(
      callChange(
        "exec_command",
        JSON.stringify({
          cmd: "grep -c x <<'EOF'\n*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\nEOF",
        }),
      ),
    ).toBeNull()
  })
})

describe("what a script ran", () => {
  it("reads a command as a call and its result, marked", () => {
    const [call, result] = transcripts.items(event(command({})))
    expect(call).toMatchObject({
      kind: "tool-call",
      tool: "exec_command",
      scripted: true,
      run: { kind: "run", title: "Ran", detail: "cat a.txt" },
    })
    expect(result).toMatchObject({
      kind: "tool-result",
      text: "one\ntwo\n",
      call: call!.call,
      scripted: true,
      outcome: { failed: false, exit: 0, size: { count: 2, unit: "line" } },
    })
  })

  it("counts lines only where Codex took the command for a read that passed", () => {
    const sized = (fields: object) => transcripts.items(event(command(fields)))[1]!.outcome?.size
    expect(sized({ parsed_cmd: [{ type: "search", cmd: "grep x" }] })).toBeNull()
    expect(sized({ parsed_cmd: [{ type: "read" }, { type: "read" }] })).toBeNull()
    expect(sized({ parsed_cmd: [{ type: "unknown" }] })).toBeNull()
    expect(sized({ status: "failed", exit_code: 1 })).toBeNull()
    expect(sized({ aggregated_output: "one" })).toEqual({ count: 1, unit: "line" })
  })

  it("reads a command that never started as failed", () => {
    expect(
      transcripts.items(event(command({ status: "failed", exit_code: -1 })))[1]!.outcome,
    ).toMatchObject({ failed: true, exit: -1 })
  })

  it("leaves a status of no meaning here unknown", () => {
    expect(transcripts.items(event(command({ status: "declined" })))[1]!.outcome?.failed).toBeNull()
  })

  it("reads a patch, each file's lines numbered as Codex recorded them", () => {
    const [call, result] = transcripts.items(
      event({
        type: "FileChange",
        id: "exec-2",
        status: "completed",
        stdout: "Success. Updated the following files:\nM a.txt\nA b.txt\nD c.txt\n",
        stderr: "",
        changes: {
          "/w/a.txt": {
            type: "update",
            unified_diff: "@@ -4 +4 @@\n-old\n+new\n",
            move_path: null,
          },
          "/w/b.txt": { type: "add", content: "one\n" },
          "/w/c.txt": { type: "delete", content: "gone\ngone too\n" },
        },
      }),
    )
    expect(call).toMatchObject({
      tool: "apply_patch",
      scripted: true,
      run: { kind: "write", title: "Patched" },
    })
    expect(result?.outcome?.change).toMatchObject({ added: 2, removed: 3 })
    expect(result?.outcome?.change?.lines[0]).toEqual({ sign: "-", text: "old", line: 4 })
  })

  it("leaves a call of the agent's own and a person's shell command to their own items", () => {
    expect(transcripts.items(event(command({ id: "call_12bfbc" })))).toEqual([])
    expect(transcripts.items(event(command({ id: "abc", source: "user_shell" })))).toEqual([])
    expect(transcripts.items(event({ type: "FileChange", id: "call_1", changes: {} }))).toEqual([])
  })

  it("leaves out what else a script's event may be", () => {
    expect(transcripts.items(event({ type: "McpToolCall", id: "exec-3" }))).toEqual([])
    expect(transcripts.items(event({ type: "Reasoning", id: "exec-4" }))).toEqual([])
  })
})

describe("a person's shell command", () => {
  it("reads its code from Codex's account of it", () => {
    const line = JSON.stringify({
      timestamp: "2026-11-06T12:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "m1",
        content: [
          {
            type: "input_text",
            text: "<user_shell_command>\n<command>\nfalse\n</command>\n<result>\nExit code: 1\nDuration: 0.1s\nOutput:\n</result>\n</user_shell_command>",
          },
        ],
      },
    })
    expect(transcripts.items(line).at(-1)?.outcome).toMatchObject({ failed: true, exit: 1 })
  })
})
