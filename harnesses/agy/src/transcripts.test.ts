import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Report } from "@novadeck/harness-core/report"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { hookReport } from "@novadeck/harness-core/testing/reports"
import { beforeEach, describe, expect, it } from "vitest"

import { decode } from "./decode.js"
import { hook } from "./report.test-support.js"
import { shapes, store } from "./shapes.js"
import { forgetLaunches, transcripts } from "./transcripts.js"

const { transcript, parallel, hooks } = loadProbe(import.meta.dirname, "transcript.probe.json") as {
  transcript: object[]
  parallel: object[]
  hooks: { event: string; payload: Report["payload"] }[]
}
const items = transcript
  .flatMap((step) => transcripts.items(JSON.stringify(step)))
  .filter(({ role }) => role !== "note")

describe("a call's arguments", () => {
  it("reach the chat as the transcript holds them, a string in quotes keeping its quotes", () => {
    const args = { CommandLine: '"/usr/bin/tool"', Count: "3", WaitMsBeforeAsync: 500 }
    const [call] = transcripts.items(
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args }],
      }),
    )
    expect(JSON.parse(call!.text)).toEqual(args)
  })
})

describe("what Antigravity says between turns", () => {
  const prompt = (words: string, wraps = "") => ({
    step_index: 1,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: `<USER_REQUEST>\n${words}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>${wraps}</ADDITIONAL_METADATA>`,
  })
  const decoded = (step: object) => transcripts.items(JSON.stringify(step))

  it("says a prompt went in plan mode, or out of it", () => {
    expect(decoded(prompt("/plan Go on", "<PLAN>the rules</PLAN>"))[0]).toMatchObject({
      note: { type: "mode", mode: "plan" },
    })
    expect(decoded(prompt("Go on"))[0]).toMatchObject({ note: { type: "mode", mode: "not-plan" } })
  })

  it("says a plan was approved in place of the line its review typed", () => {
    expect(decoded(prompt("[Approved] implementation_plan.md"))).toMatchObject([
      { role: "note", note: { type: "plan-approved" } },
    ])
  })

  it("leaves a person's own words that start the same way as theirs", () => {
    const [, words] = decoded(prompt("[Approved] by whom?"))
    expect(words).toMatchObject({ role: "user", text: "[Approved] by whom?" })
  })

  it("says a compaction, its summary its text", () => {
    const step = {
      step_index: 2,
      source: "SYSTEM",
      type: "CHECKPOINT",
      content: "# Resuming from a compaction",
    }
    expect(decoded(step)).toMatchObject([
      { role: "note", note: { type: "compaction" }, text: "# Resuming from a compaction" },
    ])
  })
})

describe("Antigravity's transcript, as captured", () => {
  it("gives the person's request, the agent's words, and each tool's call and result", () => {
    expect(items[0]).toMatchObject({
      role: "user",
      kind: "text",
      text: expect.stringMatching(/^\/plan The folder is empty/),
    })
    expect(items[0]?.text).not.toContain("ADDITIONAL_METADATA")
    const kinds = items.map(({ role, kind, tool }) => `${role} ${kind}${tool ? ` ${tool}` : ""}`)
    expect(kinds).toEqual([
      "user text",
      "assistant tool-call write_to_file",
      "tool tool-result",
      "assistant text",
      "assistant tool-call write_to_file",
      "tool tool-result",
      "assistant tool-call view_file",
      "tool tool-result",
      "assistant tool-call write_to_file",
      "tool tool-result",
      "assistant text",
    ])
  })

  it("says what each call was, and no other item", () => {
    expect(items.map(({ kind, run }) => (kind === "tool-call" ? run?.title : run))).toEqual([
      null,
      "Wrote",
      null,
      null,
      "Wrote",
      null,
      "Read",
      null,
      "Wrote",
      null,
      null,
    ])
  })

  it("pairs each result with its call, by the step it came in", () => {
    const calls = items.filter(({ kind }) => kind === "tool-call")
    const results = items.filter(({ kind }) => kind === "tool-result")
    expect(results.map(({ call }) => call)).toEqual(calls.map(({ call }) => call))
    expect(new Set(calls.map(({ call }) => call)).size).toBe(calls.length)
  })

  it("pairs calls made at once with their results, which it may write before them", () => {
    const steps = parallel.flatMap((step) => transcripts.items(JSON.stringify(step)))
    const calls = steps.filter(({ kind }) => kind === "tool-call")
    const results = steps.filter(({ kind }) => kind === "tool-result")
    expect(calls).toHaveLength(3)
    // Each result names the file its call viewed, or says the call failed.
    const viewed = results.map(({ text }) =>
      /c\.txt/.test(text) ? "c.txt" : /b\.txt/.test(text) ? "b.txt" : "failed",
    )
    const pairs = calls.map(
      (call) => viewed[results.findIndex((result) => result.call === call.call)],
    )
    expect(pairs).toEqual(["failed", "c.txt", "b.txt"])
    expect(steps.findIndex(({ kind }) => kind === "tool-result")).toBeLessThan(
      steps.findIndex(({ kind }) => kind === "tool-call"),
    )
  })

  it("places each line by its step", () => {
    const lines = [...transcript, ...parallel] as { step_index: number }[]
    expect(lines.map((line) => transcripts.step?.(JSON.stringify(line)))).toEqual(
      lines.map((line) => line.step_index),
    )
    expect(transcripts.step?.("not json")).toBeUndefined()
    expect(transcripts.step?.(JSON.stringify({ source: "MODEL" }))).toBeUndefined()
  })

  it("is the one its hooks name, with no subagents", async () => {
    const root = "/home/user/t.jsonl"
    await expect(transcripts.locate(root, "c", null)).resolves.toBe(root)
    await expect(transcripts.locate(root, "c", "a")).resolves.toBeUndefined()
  })

  it("is in the conversation's own folder of brain when the named one holds none", async () => {
    const home = mkdtempSync(join(tmpdir(), "novadeck-agy-brain-"))
    try {
      const id = "3f3ad215-48e4-45b6-b33f-73fd3f378d74"
      const logs = (session: string) => join(home, "brain", session, ".system_generated", "logs")
      const reported = join(logs("9ac3ebb4-90ce-4bd1-9611-5183926f1c52"), "transcript.jsonl")
      await expect(transcripts.locate(reported, id, null)).resolves.toBe(reported)
      mkdirSync(logs(id), { recursive: true })
      writeFileSync(join(logs(id), "transcript.jsonl"), "")
      await expect(transcripts.locate(reported, id, null)).resolves.toBe(
        join(logs(id), "transcript.jsonl"),
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// The events of a PostToolUse of Antigravity's.
const postToolUse = (payload: Report["payload"]) => hook("PostToolUse", payload)

describe("Antigravity's plans, as captured", () => {
  it("are the artifacts it writes asking for review, not its walkthrough", () => {
    const plans = hooks.flatMap(({ payload }) =>
      postToolUse(payload).filter((event) => event.type === "plan-observed"),
    )
    expect(plans).toMatchObject([
      {
        actor: null,
        plan: { kind: "file", path: expect.stringMatching(/implementation_plan\.md$/) },
      },
    ])
  })

  it("are none when the write failed, or went outside the conversation's own folder", () => {
    const plan = hooks.find(
      ({ payload }) =>
        (payload.toolCall as { args?: { ArtifactMetadata?: { RequestFeedback?: boolean } } })?.args
          ?.ArtifactMetadata?.RequestFeedback === true,
    )
    const planned = (payload: Report["payload"]) =>
      postToolUse(payload).filter((event) => event.type === "plan-observed")
    expect(planned(plan!.payload)).toHaveLength(1)
    expect(planned({ ...plan!.payload, error: "permission denied" })).toEqual([])
    const call = plan!.payload.toolCall as { name: string; args: Record<string, unknown> }
    const outside = { ...call, args: { ...call.args, TargetFile: "/home/user/elsewhere/plan.md" } }
    expect(planned({ ...plan!.payload, toolCall: outside })).toEqual([])
  })

  it("are 1.4's write_file artifacts too, which name the file as Path", () => {
    const plan = hooks.find(
      ({ payload }) =>
        (payload.toolCall as { args?: { ArtifactMetadata?: { RequestFeedback?: boolean } } })?.args
          ?.ArtifactMetadata?.RequestFeedback === true,
    )
    const call = plan!.payload.toolCall as { name: string; args: Record<string, unknown> }
    const { TargetFile, CodeContent, ...rest } = call.args
    const written = {
      name: "write_file",
      args: { ...rest, Path: TargetFile, Content: CodeContent },
    }
    expect(
      postToolUse({ ...plan!.payload, toolCall: written }).filter(
        (event) => event.type === "plan-observed",
      ),
    ).toMatchObject([{ plan: { kind: "file", path: TargetFile } }])
  })

  it("are told when the hook quotes the path, or gives the metadata as JSON text", () => {
    const plan = hooks.find(
      ({ payload }) =>
        (payload.toolCall as { args?: { ArtifactMetadata?: { RequestFeedback?: boolean } } })?.args
          ?.ArtifactMetadata?.RequestFeedback === true,
    )
    const call = plan!.payload.toolCall as { name: string; args: Record<string, unknown> }
    const { TargetFile, ArtifactMetadata } = call.args
    const quoted = {
      ...call,
      args: {
        ...call.args,
        TargetFile: JSON.stringify(TargetFile),
        ArtifactMetadata: JSON.stringify(ArtifactMetadata),
      },
    }
    expect(
      postToolUse({ ...plan!.payload, toolCall: quoted }).filter(
        (event) => event.type === "plan-observed",
      ),
    ).toMatchObject([{ plan: { kind: "file", path: TargetFile } }])
  })

  it("name the transcript on every hook", () => {
    expect(postToolUse(hooks[0]!.payload)[0]).toMatchObject({
      type: "session-observed",
      transcript: expect.stringMatching(/transcript_full\.jsonl$/),
    })
  })
})

// `transcript.jsonl` beside it encodes each argument of a call as JSON in a string, which the
// chat would show, quotes and all. The chat holds nothing to undo that, so only this file will do.
describe("the transcript read", () => {
  const logs = "/home/user/.gemini/antigravity-cli/brain/c/.system_generated/logs"

  it("is the file the hook names, as it names it", async () => {
    const transcriptPath = `${logs}/transcript_full.jsonl`
    expect(hook("Stop", { transcriptPath })[0]).toMatchObject({ transcript: transcriptPath })
    await expect(transcripts.locate(transcriptPath, "c", null)).resolves.toBe(transcriptPath)
  })

  it("is never the one the status line names", () => {
    const events = decode(
      hookReport("agy", "StatusLine", {
        conversation_id: "c",
        transcript_path: `${logs}/transcript.jsonl`,
      }),
    )
    expect(events.filter((event) => "transcript" in event)).toEqual([])
  })

  it("is the untruncated file in the store, not the one beside it", () => {
    expect(store.file.test("c/.system_generated/logs/transcript_full.jsonl")).toBe(true)
    expect(store.file.test("c/.system_generated/logs/transcript.jsonl")).toBe(false)
  })
})

type Step = { step_index: number; source: string; type: string; content?: string }

const decodeAll = (steps: readonly Step[]) =>
  steps.flatMap((step) => transcripts.items(JSON.stringify(step)))

describe("a background subagent, as captured", () => {
  const { root } = loadProbe(import.meta.dirname, "subagent-transcript.probe.json") as {
    root: Step[]
  }
  const wake = root.find(({ type }) => type === "SYSTEM_MESSAGE")!
  // Each test decodes from a clean slate, as a reader of the file from its start does.
  let decoded: ReturnType<typeof decodeAll> = []
  let launch: string | null | undefined
  beforeEach(() => {
    forgetLaunches()
    decoded = decodeAll(root)
    launch = decoded.find(({ kind }) => kind === "tool-call")!.call
  })

  it("takes the launch as its call's result while the subagent runs", () => {
    const call = decoded.find(({ kind }) => kind === "tool-call")
    expect(call).toMatchObject({ tool: "invoke_subagent", run: { subagent: true } })
    const result = decoded.find(({ kind }) => kind === "tool-result")
    expect(result).toMatchObject({ call: launch, outcome: { running: true } })
    expect(result?.text).toContain("Created the following subagent")
  })

  it("takes its going idle as its call's report, its last words", () => {
    const results = decoded.filter(({ kind }) => kind === "tool-result")
    expect(results).toHaveLength(2)
    expect(results[1]).toMatchObject({
      role: "tool",
      call: launch,
      text: "Helper report: the build is green.",
      outcome: { failed: false },
    })
    expect(results[1]?.outcome?.running).toBeFalsy()
    // The wake turn's words follow it, the message itself no prompt of the person's.
    expect(decoded.at(-1)).toMatchObject({ role: "assistant", kind: "text", text: "Woken." })
    expect(decoded.filter(({ role }) => role === "user")).toHaveLength(1)
  })

  it("reads no report of a launch it never read, nor from another message", () => {
    forgetLaunches()
    expect(transcripts.items(JSON.stringify(wake))).toEqual([])
    decodeAll(root)
    const message = {
      ...wake,
      content: wake.content!.replace(/content=.*/, "content=Work in the background."),
    }
    expect(transcripts.items(JSON.stringify(message))).toEqual([])
    // Only Antigravity's own word counts, not another agent's message in its words.
    const quoted = { ...wake, content: wake.content!.replace("sender=system", "sender=peer") }
    expect(transcripts.items(JSON.stringify(quoted))).toEqual([])
  })

  it("reports a subagent that went idle saying nothing all the same", () => {
    const bare = {
      ...wake,
      content: wake.content!.replace(/ This was the subagent's most recent response: [^\n]*/, ""),
    }
    expect(transcripts.items(JSON.stringify(bare))).toMatchObject([
      { role: "tool", kind: "tool-result", call: launch, text: "Went idle." },
    ])
  })

  it("reads each of several subagents' ends one step tells, each up to the next", () => {
    const second = {
      step_index: 7,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      content: root[2]!.content!.replace(
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000003",
      ),
    }
    const third = { ...second, step_index: 8, content: second.content.replace("0003", "0004") }
    const calls = [second, third].map((step) => transcripts.items(JSON.stringify(step))[0]!.call)
    const message = (id: string, said: string) =>
      `[Message] timestamp=2026-11-09T13:54:53Z sender=system priority=MESSAGE_PRIORITY_HIGH content=Subagent ${id} has gone idle. This was the subagent's most recent response: ${said}`
    const block = (...lines: string[]) => `<SYSTEM_MESSAGE>\n${lines.join("\n")}\n</SYSTEM_MESSAGE>`
    const batched = {
      ...wake,
      content: `The following is a <SYSTEM_MESSAGE>…\n\n${block(
        message("00000000-0000-4000-8000-000000000002", "First,\nover two lines."),
        message("00000000-0000-4000-8000-000000000003", "Second."),
      )}\n${block(message("00000000-0000-4000-8000-000000000004", "Third."))}`,
    }
    expect(
      transcripts.items(JSON.stringify(batched)).map(({ call, text }) => ({ call, text })),
    ).toEqual([
      { call: launch, text: "First,\nover two lines." },
      { call: calls[0], text: "Second." },
      { call: calls[1], text: "Third." },
    ])
    expect(shapes(JSON.stringify(batched))).toContainEqual(
      expect.objectContaining({ key: "message:subagent-end", verdict: "read" }),
    )
  })
})

describe("a background subagent's other ends, as captured", () => {
  const probe = loadProbe(import.meta.dirname, "subagent-ends.probe.json") as Record<
    "kill" | "killAll" | "error" | "escape" | "exit",
    Step[]
  >
  beforeEach(() => forgetLaunches())
  const ofLaunch = (steps: readonly Step[]) => {
    const decoded = decodeAll(steps)
    const launch = decoded.find(({ tool }) => tool === "invoke_subagent")!.call
    return decoded.filter(({ kind, call }) => kind === "tool-result" && call === launch)
  }

  it("fails a subagent killed by its conversation, which no message tells of", () => {
    expect(probe.kill.some(({ type }) => type === "SYSTEM_MESSAGE")).toBe(false)
    expect(ofLaunch(probe.kill).at(-1)).toMatchObject({
      text: "Killed.",
      outcome: { failed: true },
    })
  })

  it("leaves running subagents killed all at once, as nothing names them", () => {
    expect(ofLaunch(probe.killAll).map(({ outcome }) => outcome?.running)).toEqual([true])
  })

  it("fails a subagent that failed, with Antigravity's word of it", () => {
    expect(ofLaunch(probe.error).at(-1)).toMatchObject({
      text: expect.stringMatching(/encountered an error.*Error 400/),
      outcome: { failed: true },
    })
  })

  it("reports a subagent the root's interruption left running ahead of the next prompt", () => {
    const decoded = decodeAll(probe.escape)
    const report = decoded.findIndex(({ text }) => text === "Sub report after escape.")
    expect(report).toBeGreaterThan(-1)
    expect(decoded.slice(report + 1).find(({ role }) => role !== "note")).toMatchObject({
      role: "user",
      text: "Ping now",
    })
  })

  it("leaves running a subagent its session's end took, of which nothing tells", () => {
    expect(ofLaunch(probe.exit).map(({ outcome }) => outcome?.running)).toEqual([true])
  })
})
