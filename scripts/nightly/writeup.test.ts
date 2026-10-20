import { readFileSync } from "node:fs"

import type { Answer, Client, Question } from "../openrouter/ask"
import { Skip } from "../openrouter/skip"
import { context, describe, expect, it } from "../test"
import { clientFor, parseWriteup, render, userMessage, versionsOf, writeup } from "./writeup"

// A failed E2E job's log as CI caught it (the known-flake register's fixture).
const lead = readFileSync(
  "scripts/flakes/fixtures/e2e-antigravity-macos-lead-tool-call.txt",
  "utf8",
)
const installed = [
  "2026-10-20T08:40:01.1234567Z claude 2.1.304: /home/runner/work/.e2e-cache/claude/bin/claude",
  "2026-10-20T08:40:02.1234567Z agy 1.4.3: /home/runner/work/.e2e-cache/agy/antigravity",
].join("\n")

const client: Client = { fetch, apiKey: "key", model: "deepseek/deepseek-v4-pro", timeout: 1_000 }
const answering =
  (text: string, asked: Question[] = []) =>
  async (_client: Client, question: Question): Promise<Answer> => {
    asked.push(question)
    return { text, outputTokens: 10, model: "deepseek/deepseek-v4-pro-2026" }
  }

describe("a failed night's writeup", () => {
  it("reads the harness versions each job installed, as the installer prints them", () => {
    expect(versionsOf(`${installed}\n${lead}`)).toEqual(["claude 2.1.304", "agy 1.4.3"])
    expect(versionsOf(lead)).toEqual([])
  })

  it("gives the model each job's versions and its failed tests with their errors", () => {
    const message = userMessage("E2E", [
      { job: "Antigravity (macOS)", log: `${installed}\n${lead}` },
    ])
    expect(message).toContain(
      "Workflow: E2E\n\n## Antigravity (macOS)\nInstalled: claude 2.1.304, agy 1.4.3",
    )
    expect(message).toContain(
      "- src/e2e/lead.e2e.ts > Antigravity > delivers its lead's message at the next tool call",
    )
    expect(message).toContain("The harness refused a tool call the fake model made")
  })

  it("says so where a job's log names no failed test", () => {
    expect(
      userMessage("E2E", [{ job: "Codex (macOS)", log: "##[error]The job was cancelled." }]),
    ).toContain("## Codex (macOS)\nNo failed test in its log.")
  })

  it("keeps the message bounded, each job a share, so the first can't crowd out the last", () => {
    // Six failed tests a job, each with a long error.
    const log = Array.from(
      { length: 6 },
      (_, n) => ` FAIL  src/e2e/x.e2e.ts > X > test ${n}\nError: ${"y".repeat(5_000)}\n`,
    ).join("\n")
    const message = userMessage(
      "E2E",
      Array.from({ length: 12 }, (_, n) => ({ job: `Job ${n}`, log })),
    )
    expect(message.length).toBeLessThanOrEqual(40_100)
    expect(message).toContain("## Job 11\n- src/e2e/x.e2e.ts > X > test 0")
  })

  it("reads the model's answer, a fenced one too, and refuses any other shape", () => {
    const answer = {
      cause: " Antigravity 1.4.3 refuses `Cwd`. ",
      evidence: [" Antigravity: refused ", ""],
    }
    expect(parseWriteup(JSON.stringify(answer))).toEqual({
      cause: "Antigravity 1.4.3 refuses `Cwd`.",
      evidence: ["Antigravity: refused"],
    })
    expect(parseWriteup(`\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``).cause).toBe(
      "Antigravity 1.4.3 refuses `Cwd`.",
    )
    expect(() => parseWriteup("Probably Antigravity.")).toThrow(Skip)
    expect(() => parseWriteup(JSON.stringify({ cause: "", evidence: [] }))).toThrow(Skip)
    expect(() => parseWriteup(JSON.stringify({ cause: "x", evidence: [3] }))).toThrow(Skip)
  })

  it("shows it under its own heading, saying a model wrote it, with at most five lines of evidence", () => {
    const shown = render(
      { cause: "Claude Code 2.1.304 defers MCP tools.", evidence: ["1", "2", "3", "4", "5", "6"] },
      "deepseek/deepseek-v4-pro-2026",
    )
    expect(shown).toBe(
      [
        "### Likely cause",
        "",
        "> Written by a model (`deepseek/deepseek-v4-pro-2026`) from the failed tests' errors: a lead to check, not a verdict.",
        "",
        "Claude Code 2.1.304 defers MCP tools.",
        "",
        "- 1",
        "- 2",
        "- 3",
        "- 4",
        "- 5",
      ].join("\n"),
    )
  })

  context("when asked", () => {
    it("asks once, for its own schema, and renders the answer with the model that wrote it", async () => {
      const asked: Question[] = []
      const shown = await writeup(
        client,
        "E2E",
        [{ job: "Antigravity (macOS)", log: lead }],
        answering(JSON.stringify({ cause: "A cause.", evidence: [] }), asked),
      )
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({
        title: "Novadeck nightly report",
        schema: { name: "nightly_writeup" },
      })
      expect(shown).toContain("(`deepseek/deepseek-v4-pro-2026`)")
      expect(shown).toContain("\n\nA cause.")
    })

    it("has none without a failed job's log, or for an answer it can't read", async () => {
      await expect(writeup(client, "E2E", [], answering("{}"))).rejects.toThrow(Skip)
      await expect(
        writeup(client, "E2E", [{ job: "J", log: lead }], answering("not json")),
      ).rejects.toThrow("The answer was not JSON")
    })
  })

  it("asks a cheap model unless NIGHTLY_REPORT_MODEL names another, and only with a key", () => {
    expect(clientFor({})).toMatchObject({ apiKey: undefined, model: "deepseek/deepseek-v4-pro" })
    expect(
      clientFor({ OPENROUTER_API_KEY: " k ", NIGHTLY_REPORT_MODEL: "anthropic/claude-haiku-5.5" }),
    ).toMatchObject({ apiKey: "k", model: "anthropic/claude-haiku-5.5" })
  })
})
