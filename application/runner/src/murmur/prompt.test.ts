import { describe, expect, it } from "../test.js"
import type { AgentDigest, ShellDigest } from "./describer.js"
import { messages, responseFormat } from "./prompt.js"

const agent: AgentDigest = {
  kind: "agent",
  harness: "Claude Code",
  project: "app",
  folder: "api",
  branch: "main",
  plan: null,
  folders: [],
  prompts: ["first", "second", "the current one"],
  reply: "Done.",
  summary: "Migrating the billing tables to the new schema.",
  previous: { title: "Billing schema" },
}

const user = (digest: AgentDigest | ShellDigest): string => messages(digest)[1]?.content ?? ""

describe("asking for a title", () => {
  it("asks for a title alone", () => {
    expect(responseFormat.json_schema.schema.required).toEqual(["title"])
    expect(messages(agent)[0]?.content).not.toMatch(/^summary:/m)
  })

  it("shows the agent's summary, the previous title, and the current prompt last", () => {
    const text = user(agent)

    expect(text).toContain("Migrating the billing tables")
    expect(text).toContain(
      "Previous title (keep it unless the work clearly changed): Billing schema",
    )
    expect(text.indexOf("Migrating")).toBeLessThan(text.indexOf("CURRENT prompt"))
    expect(text.trimEnd().split("\n").at(-1)).toMatch(/language of the agent's summary/)
    expect(
      user({ ...agent, summary: null })
        .trimEnd()
        .split("\n")
        .at(-1),
    ).toMatch(/language of the CURRENT prompt/)
    expect(text).toMatch(/CURRENT prompt[^]*the current one/)
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("the current one"))
  })

  it("leaves the summary out of an agent that has none, and shells unchanged", () => {
    expect(user({ ...agent, summary: null })).not.toContain("own summary")
    const shell: ShellDigest = {
      kind: "shell",
      project: null,
      folder: null,
      command: "tail -f app.log",
      screen: ["a", "b"],
      previous: null,
    }
    expect(user(shell)).toContain("Running: tail -f app.log")
    expect(user(shell)).toContain("What the screen shows now")
    expect(user({ ...shell, screen: [] })).not.toContain("What the screen shows now")
    expect(user({ ...shell, screen: [] })).toContain("The screen is not shown")
  })

  it("is driven by the agent's summary when there are no prompts", () => {
    const text = user({ ...agent, prompts: [] })

    expect(text).not.toContain("CURRENT prompt from")
    expect(text).not.toContain("(none yet)")
    expect(text).not.toContain("Earlier prompts")
    expect(text).toContain("Migrating the billing tables")
    expect(text.trimEnd().split("\n").at(-1)).toMatch(/language of the agent's summary/)
  })
})
