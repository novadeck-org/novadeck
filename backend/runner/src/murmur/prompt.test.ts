import { describe, expect, it } from "../test.js"
import type { AgentDigest, ShellDigest } from "./describer.js"
import { titleCharacters } from "./description.js"
import { agentSystem, formats, messages, responseFormat, shellSystem } from "./prompt.js"

const agent: AgentDigest = {
  kind: "agent",
  project: "app",
  summary: "Task billing-v2: migrating the app's billing tables to the new schema; PR #4 in CI",
}

const shell: ShellDigest = {
  kind: "shell",
  project: "app",
  command: "tail -f app.log",
  screen: ["a", "b"],
}

const user = (digest: AgentDigest | ShellDigest): string => messages(digest)[1]?.content ?? ""

describe("asking for a title", () => {
  it("asks an agent and a shell for the title alone", () => {
    expect(responseFormat.json_schema.schema.required).toEqual(["title"])
    expect(formats.title.responseFormat).toBe(responseFormat)
    expect(responseFormat.json_schema.name).toBe("terminal_title")
    expect(messages(agent)[0]?.content).toBe(agentSystem)
    expect(messages(shell)[0]?.content).toBe(shellSystem)
  })

  it("asks for a short noun name, never the project's", () => {
    expect(agentSystem).toMatch(/1 to 3 words/)
    expect(agentSystem).toMatch(/never the project's name/)
    expect(agentSystem).toMatch(/"Help with"/)
    expect(agentSystem).toMatch(/EMO-118/)
    expect(shellSystem).toMatch(/never the project's name/)
  })

  it("shows an agent's summary alone, and what to make of it last", () => {
    const text = user(agent)

    expect(text).toMatch(/^The agent's summary of its work:\nTask billing-v2: migrating/)
    expect(text.trimEnd().split("\n").at(-1)).toMatch(
      /^Name what the work is about[^]*language of the summary\.$/,
    )
    expect(agentSystem).toMatch(/not a label it opens with/)
    expect(agentSystem).toMatch(/not its progress/)
  })

  it("splits a shell's screen at the row the runner says the last command was typed on", () => {
    const prompt = "me@host:~/app$"
    const text = user({
      ...shell,
      command: null,
      screen: ["old output", `${prompt} pnpm test`, "FAIL login.test.ts", prompt],
      commandAt: 1,
    })

    expect(text).toMatch(/Earlier on the screen \(background only\):\nold output\n/)
    expect(text).toMatch(/The last command and its output:\nme@host:~\/app\$ pnpm test\nFAIL/)
    expect(text).toContain("Nothing runs now: the shell waits at its prompt.")
    expect(text.trimEnd().split("\n").at(-1)).toMatch(/Never just that a command runs or finished/)
    expect(user(shell)).toContain("Running now: tail -f app.log")
  })

  it("cuts a long screen row to its budget, keeping every character whole", () => {
    const row = `${"x".repeat(158)}😀😀tail`
    const text = user({ ...shell, screen: [row, "short"] })

    expect(text).toContain(`\n${"x".repeat(158)}…\n`)
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })

  it("splits at row 0 without a background section", () => {
    const text = user({
      ...shell,
      command: "pnpm dev",
      screen: ["$ pnpm dev", "ready"],
      commandAt: 0,
    })

    expect(text).toContain("The last command and its output:\n$ pnpm dev\nready")
    expect(text).not.toContain("Earlier on the screen")
  })

  it("shows the rows as the screen when the runner gives no row", () => {
    const text = user({ ...shell, command: null, screen: ["$ ls", "a.txt", "$"] })

    expect(text).toContain("The screen, oldest row first")
    expect(text).not.toContain("The last command and its output")
    expect(text).not.toContain("Earlier on the screen")
  })

  it.each([-1, 3, 1.5, Number.NaN])("ignores a row that is not on the screen: %s", (commandAt) => {
    const text = user({ ...shell, command: null, screen: ["$ ls", "a.txt", "$"], commandAt })

    expect(text).toContain("The screen, oldest row first")
  })

  it("moves the row with the screen when only its last rows are shown", () => {
    const screen = Array.from({ length: 40 }, (_, index) => `row ${index}`)
    const text = user({ ...shell, command: null, screen, commandAt: 20 })

    // The 30 lowest rows are 10..39: the command is the eleventh of them.
    expect(text).toContain("The last command and its output:\nrow 20\nrow 21")
    expect(text).toContain("Earlier on the screen (background only):\nrow 14\nrow 15")
    expect(user({ ...shell, command: null, screen, commandAt: 5 })).toContain(
      "The screen, oldest row first",
    )
  })

  it("leaves a full-screen program's screen out and names only what runs", () => {
    const text = user({ ...shell, command: "htop", screen: [], commandAt: 0 })

    expect(text).not.toContain("The last command")
    expect(text).not.toContain("The screen, oldest row first")
    expect(text).toContain("Running now: htop")
  })
})

it("keeps the title's own format", () => {
  expect(formats.title.responseFormat).toBe(responseFormat)
  expect(formats.title.maxTokens).toBe(64)
})

const length = (format: { json_schema: { schema: { properties: object } } }, name: string) =>
  (format.json_schema.schema.properties as Record<string, { maxLength: number }>)[name]
    ?.maxLength ?? 0

describe("the schemas' room", () => {
  it("allows more than the parser does, so an overrun is refused and not cut", () => {
    expect(length(responseFormat, "title")).toBeGreaterThan(titleCharacters)
  })
})
