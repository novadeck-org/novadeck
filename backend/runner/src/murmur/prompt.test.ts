import { describe, expect, it } from "../test.js"
import type { AgentDigest, NoteDigest, ShellDigest } from "./describer.js"
import { gistCharacters, titleCharacters } from "./description.js"
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

const user = (digest: AgentDigest | ShellDigest | NoteDigest): string =>
  messages(digest)[1]?.content ?? ""

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

const reply = (text: string, failed = false): NoteDigest => ({
  kind: "reply",
  reply: text,
  failed,
})

const make = (n: number, from: string) =>
  Array.from({ length: n }, (_, index) => from[(index * 7 + (index >> 3)) % from.length]).join("")
describe("asking for a gist", () => {
  it("shows a short reply whole, and says when the turn failed", () => {
    expect(user(reply("I fixed the build."))).toContain("I fixed the build.")
    expect(user(reply("I fixed the build."))).not.toContain("ended with an error")
    expect(user(reply("The build is broken.", true))).toContain("The turn ended with an error.")
  })

  it("shows the start and the end of a long reply, named and with the cut marked", () => {
    const text = `${"a".repeat(4500)}${"MIDDLE".repeat(1000)}${"z".repeat(4500)}`

    const shown = user(reply(text))

    expect(shown).toContain("The start of the agent's reply:\n")
    expect(shown).toContain("\n[…]\nThe end of the agent's reply:\n")
    expect(shown).toContain("a".repeat(1000))
    expect(shown).toContain("z".repeat(1000))
    expect(shown).not.toContain("MIDDLE")
  })

  it("keeps every kind of text inside the window, by the rates the engine's tokenizer measured", () => {
    // [text, tokens per character the tokenizer was measured to take at most]
    const texts: [string, number][] = [
      [make(8000, "0123456789"), 1],
      [Array.from({ length: 1400 }, (_, index) => `${index * 37} `).join(""), 1],
      [make(8000, "0123456789abcdef"), 0.9],
      [make(8000, "!@#$%^&*()_+-=[]{};:,.<>/?|~"), 0.7],
      [make(4000, "\u{1F300}\u{1F680}\u{1F9E0}"), 2.9],
      [make(4000, "\u{20000}\u{20BB7}\u{2A6D6}"), 4],
      [make(4000, "\u3400\u4DB5"), 3],
      [make(4000, "\uAC00\uD7A3"), 2.2],
      ["The runner was fixed and all the checks pass again. ".repeat(160), 0.3],
      ["x".repeat(8000), 0.5],
      // Short lines, each line break a token of its own.
      [Array.from({ length: 1200 }, (_, index) => `v1.${index % 20}.${index % 7}\n`).join(""), 1],
      [Array.from({ length: 1600 }, (_, index) => `L${index}\n`).join(""), 1],
      [Array.from({ length: 1400 }, (_, index) => `ok ${index % 99}\n`).join(""), 0.83],
      ["q ".repeat(4000), 0.51],
      ["'Kv ".repeat(2000), 0.76],
      ["'Kv\n".repeat(2000), 1],
      [Array.from({ length: 2000 }, (_, index) => `${"qZx'"[index % 4]}Kv\n`).join(""), 1],
    ]

    for (const [text, rate] of texts) {
      // Less the labels and the closing line, which are about 150 characters of English.
      const shown = [...(messages(reply(text))[1]?.content ?? "")].length - 150
      // The system prompt is about 450 tokens, and the model answers in up to 128.
      expect(shown * rate + 60 + 450 + 128).toBeLessThan(4096)
    }
  })

  it("shows about as much as the window allows of plain English", () => {
    const shown = user(reply("The runner was fixed and all the checks pass again. ".repeat(400)))

    expect(shown.length).toBeGreaterThan(5500)
  })

  it("shows a reply that fits whole, unmarked", () => {
    const shown = user(reply("Fixed the build.\n\nWant me to push?"))

    expect(shown).toContain("The agent's reply:\nFixed the build.\n\nWant me to push?")
    expect(shown).not.toContain("[…]")
  })

  it("budgets by what the text costs the model, so a script that costs more gets less", () => {
    const english = user(reply("word ".repeat(3000)))
    const chinese = user(reply("我已经修改了数据库配置。".repeat(400)))

    expect(english.length).toBeGreaterThan(chinese.length * 2)
    expect(chinese.length).toBeLessThan(3000)
    expect(chinese).toContain("[…]")
  })

  it("leaves out what is no prose, after which the words fit", () => {
    const text = [
      "Fixed it in [the PR](https://example.com/pull/131) and ![shot](https://example.com/a.png).",
      "```ts\nconst secret = 1\n```",
      "See https://example.com/docs/a?b=c for more.",
      "| Term | Meaning |\n| --- | --- |\n| a | b |\n| c | d |",
      "```js\nunclosed fence",
    ].join("\n\n\n\n")

    const shown = user(reply(text))

    expect(shown).toContain("Fixed it in the PR and shot.")
    expect(shown).not.toMatch(/example\.com|const secret|unclosed|--- \|/)
    expect(shown).toContain("[code]")
    expect(shown).toContain("See [link] for more.")
    expect(shown).toContain("| Term | Meaning |\n[table]")
    expect(shown).not.toContain("\n\n\n")
  })

  it("takes a fence only at the start of a line, and keeps the sentences around a stray one", () => {
    const shown = user(
      reply("Wrap it in ``` fences like this.\n\nI changed the parser and all 12 tests pass."),
    )

    expect(shown).toContain("Wrap it in ``` fences like this.")
    expect(shown).toContain("I changed the parser and all 12 tests pass.")
    expect(shown).not.toContain("[code]")
  })

  it("runs a fence to its own closing line, nested longer fences included, or to the end", () => {
    const nested = user(reply("Before.\n````md\n```ts\nlet a = 1\n```\nstill code\n````\nAfter."))
    const open = user(reply("Before.\n  ```ts\nlet a = 1\nnever closed"))

    expect(nested).toContain("Before.\n[code]\nAfter.")
    expect(nested).not.toMatch(/still code|let a/)
    expect(open).toContain("Before.\n[code]")
    expect(open).not.toContain("never closed")
  })

  it("leaves a redaction mark as it is, link or no link", () => {
    const shown = user(reply("Use [redacted](expires) and [the docs](https://example.com/a) now."))

    expect(shown).toContain("[redacted](expires)")
    expect(shown).toContain("Use [redacted](expires) and the docs now.")
  })

  it("spends the budget on prose, not on a long code block", () => {
    const text = `${"The fix is in.\n\n"}\`\`\`\n${"x = 1\n".repeat(3000)}\`\`\`\n\nAll done.`

    const shown = user(reply(text))

    expect(shown).toContain("The fix is in.\n\n[code]\n\nAll done.")
    expect(shown).not.toContain("[…]")
  })

  it("asks for the gist alone", () => {
    const chat = messages(reply("Want me to add tests?"))
    const { responseFormat: format, maxTokens } = formats.gist

    expect(chat[0]?.content).toMatch(/in those words/)
    expect(format.json_schema.name).toBe("reply_gist")
    expect(Object.keys(format.json_schema.schema.properties)).toEqual(["gist"])
    expect(format.json_schema.schema.required).toEqual(["gist"])
    expect(maxTokens).toBe(128)
  })

  it("keeps the title's own format", () => {
    expect(formats.title.responseFormat).toBe(responseFormat)
    expect(formats.title.maxTokens).toBe(64)
  })
})

const length = (format: { json_schema: { schema: { properties: object } } }, name: string) =>
  (format.json_schema.schema.properties as Record<string, { maxLength: number }>)[name]
    ?.maxLength ?? 0

describe("the schemas' room", () => {
  it("allows more than the parser does, so an overrun is refused and not cut", () => {
    expect(length(responseFormat, "title")).toBeGreaterThan(titleCharacters)
    expect(length(formats.gist.responseFormat, "gist")).toBeGreaterThan(gistCharacters)
  })
})
