import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { transcripts, typedEntry } from "./transcripts.js"

type Probe = { readonly transcript: readonly unknown[]; readonly child: readonly unknown[] }
const session = loadProbe(import.meta.dirname, "session.probe.json") as Probe
const lines = session.transcript.map((line) => JSON.stringify(line))
const items = lines.flatMap((line) => transcripts.items(line))

describe("the transcript Novadeck's plugin writes (probed 2026-11-22, 1.19.6)", () => {
  it("holds each of the person's prompts, and the deliveries the plugin added to them as such", () => {
    const said = items.filter((item) => item.role === "user").map((item) => item.text)
    expect(said).toEqual([
      "PING please",
      "<novadeck-messages>AT-PROMPT</novadeck-messages>",
      "BASH it",
      "QUESTION now",
      "SUBAGENT go",
      "<novadeck-messages>AT-STOP</novadeck-messages>",
    ])
  })

  it("holds the agent's words", () => {
    const words = items.filter((item) => item.role === "assistant" && item.kind === "text")
    expect(words.map((item) => item.text)).toEqual(["OK.", "OK.", "OK.", "OK.", "OK."])
  })

  it("holds each tool call with its result, paired by the call's id", () => {
    const calls = items.filter((item) => item.kind === "tool-call")
    const results = items.filter((item) => item.kind === "tool-result")
    expect(calls.map((item) => item.tool)).toEqual(["novadeck_ping", "bash", "question", "task"])
    expect(results.map((item) => item.call)).toEqual(calls.map((item) => item.call))
    const bash = results[1]!
    expect(bash.text).toContain("approved")
    expect(bash.text).toContain("<novadeck-messages>AT-TOOL</novadeck-messages>")
    expect(bash.outcome).toEqual(expect.objectContaining({ failed: false, exit: 0 }))
    expect(calls[1]!.run).toEqual(expect.objectContaining({ kind: "run", detail: "echo approved" }))
    expect(calls[3]!.run).toEqual(expect.objectContaining({ kind: "agent", subagent: true }))
  })

  it("notes which agent each prompt went to, so its plan agent shows", () => {
    const modes = items.filter((item) => item.role === "note")
    expect(modes.map((item) => item.note)).toEqual(
      Array.from({ length: 5 }, () => ({ type: "mode", mode: "not-plan" })),
    )
  })

  it("tells what the person typed apart from what the plugin added", () => {
    const typed = lines.flatMap((line) => typedEntry(line)?.text ?? [])
    expect(typed).toEqual(["PING please", "BASH it", "QUESTION now", "SUBAGENT go"])
  })

  it("keeps a subagent's session apart, beside the root's", async () => {
    const root = "/home/person/.config/novadeck/shell/plugins/opencode/sessions/ses_root0001.jsonl"
    expect(await transcripts.locate(root, "ses_root0001", "ses_child0001")).toBe(
      "/home/person/.config/novadeck/shell/plugins/opencode/sessions/ses_child0001.jsonl",
    )
    const child = session.child.flatMap((line) => transcripts.items(JSON.stringify(line)))
    expect(child.filter((item) => item.role === "assistant").map((item) => item.text)).toEqual([
      "child says hi",
    ])
  })
})

describe("a prompt that carries an image", () => {
  const line = JSON.stringify({
    type: "prompt",
    info: { id: "msg_1", role: "user", agent: "build", time: { created: 5 } },
    parts: [
      { id: "prt_1", type: "text", text: "what is this?" },
      {
        id: "prt_2",
        type: "file",
        mime: "image/png",
        filename: "a.png",
        url: "data:image/png;base64,iVBORw0K",
      },
    ],
  })

  it("holds the image with the words it came with", () => {
    expect(transcripts.images(line)).toEqual([{ mime: "image/png", base64: "iVBORw0K" }])
    const words = transcripts.items(line).find((item) => item.role === "user")
    expect(words).toEqual(
      expect.objectContaining({ text: "what is this?", images: [{ index: 0, mime: "image/png" }] }),
    )
  })

  it("names a file the image was saved in, where its url names one", () => {
    const saved = line.replace("data:image/png;base64,iVBORw0K", "file:///home/person/a.png")
    expect(transcripts.images(saved)).toEqual([{ mime: "image/png", file: "/home/person/a.png" }])
  })
})

describe("a tool call that failed", () => {
  it("is a failed result, as a refused permission's is", () => {
    const line = JSON.stringify({
      type: "part",
      role: "assistant",
      part: {
        id: "prt_1",
        type: "tool",
        tool: "bash",
        callID: "toolu_1",
        state: {
          status: "error",
          input: { command: "echo approved" },
          error: "The user rejected permission to use this specific tool call.",
          time: { start: 1, end: 2 },
        },
      },
    })
    const [, result] = transcripts.items(line)
    expect(result).toEqual(
      expect.objectContaining({
        kind: "tool-result",
        outcome: expect.objectContaining({ failed: true }),
      }),
    )
  })
})

describe("a tool call as it runs and once it ended", () => {
  const part = (state: Record<string, unknown>, tool = "bash") => ({
    id: "prt_9",
    type: "tool",
    tool,
    callID: "toolu_9",
    state: { input: { command: "sleep 5" }, time: { start: 1 }, ...state },
  })
  const line = (fields: Record<string, unknown>) =>
    JSON.stringify({ type: "part", role: "assistant", ...fields })

  it("is the call alone as it starts, which the chat shows running", () => {
    const items = transcripts.items(line({ part: part({ status: "running" }), call: true }))
    expect(items.map((item) => item.kind)).toEqual(["tool-call"])
  })

  it("is its result alone once it ended, where its call was written as it started", () => {
    const ended = part({ status: "completed", output: "done", metadata: { exit: 0 } })
    const items = transcripts.items(line({ part: ended, called: true }))
    expect(items.map((item) => item.kind)).toEqual(["tool-result"])
    // Without that, as a resumed session's history has it, both.
    expect(transcripts.items(line({ part: ended })).map((item) => item.kind)).toEqual([
      "tool-call",
      "tool-result",
    ])
  })

  it("failed where bash stopped it at its timeout, though it completed", () => {
    const stopped = part({
      status: "completed",
      output:
        "(no output)\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout 1000 ms. If this command is expected to take longer…\n</shell_metadata>",
    })
    const [, result] = transcripts.items(line({ part: stopped }))
    expect(result?.outcome).toEqual(expect.objectContaining({ failed: true }))
  })

  it("counts an edit's change from the diff opencode keeps beside it", () => {
    const diff =
      "Index: /p/a.ts\n===\n--- /p/a.ts\n+++ /p/a.ts\n@@ -1,3 +1,4 @@\n const a = 1\n-const b = 2\n+const b = 20\n+const bb = 21\n const c = 3\n"
    const edited = part(
      { status: "completed", output: "Edit applied.", metadata: { diff } },
      "edit",
    )
    const [, result] = transcripts.items(line({ part: edited }))
    expect(result?.outcome?.change).toEqual(expect.objectContaining({ added: 2, removed: 1 }))
  })

  it("names the tool a call of one it wasn't offered tried", () => {
    const invalid = part(
      {
        status: "completed",
        input: { tool: "frobnicate", error: "Model tried to call unavailable tool 'frobnicate'." },
        output: "The arguments provided to the tool are invalid",
      },
      "invalid",
    )
    const [call] = transcripts.items(line({ part: invalid }))
    expect(call?.run).toEqual(expect.objectContaining({ kind: "other", title: "frobnicate" }))
  })
})
