import { describe, expect, it } from "../test.js"
import { backgroundOf, commandWords, shellName } from "./background-shells.js"

describe("the words of the command a shell line runs first", () => {
  it("drops leading assignments and a leading cd", () => {
    expect(commandWords("API_KEY=sk-abc123 pnpm deploy")).toEqual(["pnpm", "deploy"])
    expect(commandWords("cd /x && FOO=1 node script.js --token abc")).toEqual([
      "node",
      "script.js",
      "--token",
      "abc",
    ])
    expect(commandWords("cd /x; pnpm dev:web")).toEqual(["pnpm", "dev:web"])
    expect(commandWords("A=1 B=2 && pnpm test")).toEqual(["pnpm", "test"])
  })

  it("stops at a pipe, && , || or ;", () => {
    expect(commandWords("pnpm test | tee out.log")).toEqual(["pnpm", "test"])
    expect(commandWords("pnpm build && pnpm test")).toEqual(["pnpm", "build"])
    expect(commandWords("false || echo hi")).toEqual(["false"])
    expect(commandWords("sleep 5; echo done")).toEqual(["sleep", "5"])
    expect(commandWords("(cd x && pnpm dev) &")).toEqual(["pnpm", "dev"])
  })

  it("keeps a quoted string as one word", () => {
    expect(commandWords(`curl -H "Authorization: Bearer x | y" 'a b'`)).toEqual([
      "curl",
      "-H",
      "Authorization: Bearer x | y",
      "a b",
    ])
    expect(commandWords(`echo "unterminated | x`)).toEqual(["echo", "unterminated | x"])
  })

  it("is empty where nothing runs", () => {
    expect(commandWords("")).toEqual([])
    expect(commandWords("   ")).toEqual([])
    expect(commandWords("cd /x")).toEqual([])
    expect(commandWords("KEY=1")).toEqual([])
  })
})

describe("a background shell's name", () => {
  const secrets = [
    "sk-live-9f8e7d6c5b4a3210",
    "Bearer x",
    "hunter2",
    "abc",
    "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
  ]
  const commands = [
    "API_KEY=sk-live-9f8e7d6c5b4a3210 pnpm deploy",
    `curl -H "Authorization: Bearer x" https://example.com/hook`,
    "cd /x && FOO=1 node script.js --token abc",
    "TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz pnpm dev:web | tee log",
    "openssl passwd hunter2",
    `'KEY=hunter2' ./run.sh --password "hunter2"`,
  ]

  it("is the program and at most two plain subcommand words", () => {
    expect(shellName("API_KEY=sk-live-9f8e7d6c5b4a3210 pnpm deploy", null)).toBe("pnpm deploy")
    expect(shellName(commands[1]!, null)).toBe("curl")
    expect(shellName(commands[2]!, null)).toBe("script")
    expect(shellName(commands[3]!, null)).toBe("pnpm dev:web")
    expect(shellName("vitest run --reporter=dot", null)).toBe("vitest run")
    expect(shellName("pnpm test | grep x", undefined)).toBe("pnpm test")
  })

  it("never shows a secret, whatever the command", () => {
    for (const command of commands) {
      const name = shellName(command, null)
      for (const secret of secrets) expect(name).not.toContain(secret)
      expect(name).not.toContain("=")
    }
  })

  it("is 'a command' where nothing tells", () => {
    expect(shellName("", null)).toBe("a command")
    expect(shellName("   ", null)).toBe("a command")
    expect(shellName("cd /x", null)).toBe("a command")
    expect(shellName("KEY=1", null)).toBe("a command")
    expect(shellName("/path/with$weird*name --x", null)).toBe("a command")
  })

  it("is the agent's own description, cut short, in place of the command", () => {
    expect(shellName("pnpm dev:web", "dev server for the UI")).toBe("dev server for the UI")
    const long = shellName("pnpm dev:web", `${"w".repeat(100)}\nmore`)
    expect([...long].length).toBe(40)
    expect(long.endsWith("…")).toBe(true)
    expect(long).not.toContain("\n")
  })

  it("is redacted as a last backstop", () => {
    const name = shellName("x", "deploy with ghp_0123456789abcdefghijklmnopqrstuvwxyz")
    expect(name).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz")
  })
})

describe("the background work of an agent's listing", () => {
  const now = 1_000_000_000
  const min = 60_000
  const shell = (id: string, command: string, ago: number, exit?: [number, number | null]) => ({
    id,
    command,
    since: now - ago * min,
    exit: exit ? { at: now - exit[0] * min, code: exit[1] } : null,
  })

  it("is null without a running shell or a lately failed one", () => {
    expect(backgroundOf(null, now)).toBeNull()
    expect(backgroundOf({ shells: [] }, now)).toBeNull()
    expect(
      backgroundOf(
        {
          shells: [
            shell("a", "x", 30, [20, 1]),
            shell("b", "y", 30, [1, 0]),
            shell("c", "z", 30, [1, null]),
          ],
        },
        now,
      ),
    ).toBeNull()
  })

  it("lists the newest three running, then how many more", () => {
    const shells = ["a", "b", "c", "d", "e"].map((id, index) =>
      shell(id, `run-${id}`, 50 - index * 10),
    )
    const background = backgroundOf({ shells }, now)!
    expect(background.running.map(({ name }) => name)).toEqual(["run-e", "run-d", "run-c"])
    expect(background.moreRunning).toBe(2)
  })

  it("lists the latest two non-zero exits of the last ten minutes, newest first", () => {
    const shells = [
      shell("a", "vitest run", 30, [9, 1]),
      shell("b", "pnpm lint", 30, [2, 2]),
      shell("c", "pnpm build", 30, [5, 127]),
    ]
    expect(backgroundOf({ shells }, now)!.ended).toEqual([
      { name: "pnpm lint", code: 2, at: now - 2 * min },
      { name: "pnpm build", code: 127, at: now - 5 * min },
    ])
  })

  it("names a shell by the description of the waited job with its id or its command", () => {
    const job = (id: string, command: string, description: string | null) => ({
      id,
      command,
      description,
      since: now,
      until: null,
    })
    const background = backgroundOf(
      {
        shells: [shell("t1", "KEY=s3cret ./watch.sh", 5), shell("t2", "pnpm test", 4)],
        waiting: {
          jobs: [job("t1", "x", "PR checks"), job("other", "pnpm test", "unit tests")],
          wake: null,
        },
      },
      now,
    )!
    expect(background.running.map(({ name }) => name)).toEqual(["unit tests", "PR checks"])
  })
})
