/* eslint-disable no-await-in-loop -- Each case runs on its own, one after another. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { APIConnectionTimeoutError } from "@anthropic-ai/sdk"
import { afterEach, describe, expect, it } from "vitest"

import { readNotesBlock } from "../../contract/protocol/src/release-notes.ts"
import { commit, fakeSources, releaseBody } from "./fixtures.ts"
import { main } from "./main.ts"
import { type Client } from "./model.ts"

const sources = fakeSources({
  tags: ["v0.0.151", "v0.0.152"],
  commits: { "v0.0.151..v0.0.152": [commit(330)] },
  bodies: { "v0.0.152": releaseBody },
})
type Message = Awaited<ReturnType<ReturnType<Client["beta"]["messages"]["stream"]>["finalMessage"]>>
const claude = (finish: () => Promise<Message>): ((mode: "release" | "promote") => Client) => {
  return () => ({ beta: { messages: { stream: () => ({ finalMessage: finish }) } } })
}
const saying = (text: string, fields: object = {}) =>
  claude(
    async () =>
      ({
        stop_reason: "end_turn",
        content: [{ type: "text", text }],
        usage: { output_tokens: 42 },
        ...fields,
      }) as Message,
  )
const answer = JSON.stringify({
  highlights: [],
  changes: [{ area: "Look & feel", line: "Tab descriptions say who leads whom.", prs: [330] }],
})

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"))
  dirs.push(dir)
  return join(dir, "body.md")
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("the command", () => {
  it("writes the release's body and prints a summary with the tokens used", async () => {
    const out = scratch()
    const printed: string[] = []
    await main(["release", "v0.0.152", out], sources, saying(answer), (line) => printed.push(line))
    const body = readFileSync(out, "utf8")
    expect(body).toContain("- Tab descriptions say who leads whom.")
    expect(readNotesBlock(body)?.kind).toBe("release")
    expect(printed.join("\n")).toMatch(/1 line from 1 change.*42 output tokens/)
  })

  it("writes no file, exits normally and says why, whatever goes wrong", async () => {
    const throwing = (error: Error) => claude(async () => Promise.reject(error))
    for (const [clientFor, reason] of [
      [saying("sorry"), "The answer was not JSON"],
      [saying(answer, { stop_reason: "refusal" }), "The model refused"],
      [saying(answer, { stop_reason: "max_tokens" }), "The answer was cut off"],
      [throwing(new APIConnectionTimeoutError()), "timed out"],
      [throwing(new Error("Could not resolve authentication method")), "authentication"],
    ] as const) {
      const out = scratch()
      // A file left by an earlier run is removed, so the workflow can't take it for this run's.
      writeFileSync(out, "stale")
      const printed: string[] = []
      await main(["release", "v0.0.152", out], sources, clientFor, (line) => printed.push(line))
      expect(existsSync(out), reason).toBe(false)
      expect(printed.join("\n")).toContain("the release keeps its body")
      expect(printed.join("\n")).toContain(reason)
    }
  })

  it("writes no file when gh can't read the release", async () => {
    const out = scratch()
    const broken = {
      ...sources,
      release: async () => {
        throw new Error("HTTP 502")
      },
    }
    const printed: string[] = []
    await main(["release", "v0.0.152", out], broken, saying(answer), (line) => printed.push(line))
    expect(existsSync(out)).toBe(false)
    expect(printed.join("\n")).toContain("HTTP 502")
  })

  it("lets git's failure through", async () => {
    const broken = {
      ...sources,
      commits: async () => {
        throw new Error("fatal: bad revision")
      },
    }
    await expect(main(["release", "v0.0.152", scratch()], broken, saying(answer))).rejects.toThrow(
      /bad revision/,
    )
  })

  it("appends what it prints to the job's summary", async () => {
    const out = scratch()
    const summary = join(join(out, ".."), "summary.md")
    process.env.GITHUB_STEP_SUMMARY = summary
    try {
      await main(["release", "v0.0.152", out], sources, saying("sorry"), () => {})
    } finally {
      delete process.env.GITHUB_STEP_SUMMARY
    }
    expect(readFileSync(summary, "utf8")).toContain("No release notes written for v0.0.152")
  })

  it("prints the body and the model's answer on a dry run, and writes nothing", async () => {
    const printed: string[] = []
    await main(["promote", "v0.0.152", "--dry-run"], sources, saying(answer), (line) =>
      printed.push(line),
    )
    const output = printed.join("\n")
    expect(output).toContain(answer)
    expect(output).toContain("<!-- novadeck:notes")
    expect(output).toContain("[Compare on GitHub](https://github.com/")
  })

  it("shows on a dry run why nothing would be written, and the answer that failed", async () => {
    const bad = JSON.stringify({
      highlights: [],
      changes: [{ area: "Voice", line: "Visit https://x.test", prs: [330] }],
    })
    const printed: string[] = []
    await main(["release", "v0.0.152", "--dry-run"], sources, saying(bad), (line) =>
      printed.push(line),
    )
    expect(printed.join("\n")).toContain("No release notes written")
    expect(printed.join("\n")).toContain("https://x.test")
  })

  it("is a usage error without a mode, a tag or an out file", async () => {
    for (const args of [
      [],
      ["release"],
      ["release", "v0.0.152"],
      ["ship", "v0.0.152", "x"],
      ["release", "v0.0.152", "x", "y"],
    ])
      await expect(main(args, sources, saying(answer))).rejects.toThrow(/Usage/)
  })
})
