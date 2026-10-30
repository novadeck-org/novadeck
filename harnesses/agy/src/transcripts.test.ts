import type { Report } from "@novadeck/harness-core/report"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { hook } from "./report.test-support.js"
import { transcripts } from "./transcripts.js"

const { transcript, parallel, hooks } = loadProbe(import.meta.dirname, "transcript.probe.json") as {
  transcript: object[]
  parallel: object[]
  hooks: { event: string; payload: Report["payload"] }[]
}
const items = transcript.flatMap((step) => transcripts.items(JSON.stringify(step)))

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

  it("is the one its hooks name, with no subagents", async () => {
    const root = "/home/user/t.jsonl"
    await expect(transcripts.locate(root, "c", null)).resolves.toBe(root)
    await expect(transcripts.locate(root, "c", "a")).resolves.toBeUndefined()
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

  it("name the transcript on every hook", () => {
    expect(postToolUse(hooks[0]!.payload)[0]).toMatchObject({
      type: "session-observed",
      transcript: expect.stringMatching(/transcript_full\.jsonl$/),
    })
  })
})
