import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import headless from "@xterm/headless"
import { afterEach, beforeEach, vi } from "vitest"

import {
  started,
  withGist,
  withHeadline,
  type Activity,
  type Request,
} from "../harnesses/activity.js"
import type { Items } from "../harnesses/replies.js"
import type { Description, Digest, ShellDigest } from "../murmur/describer.js"
import { redactDigest } from "../murmur/redact.js"
import { describe, expect, it } from "../test.js"
import { FakeDescriber } from "../testing/describer.js"
import {
  agentDigest,
  commandOf,
  Descriptions,
  Murmur,
  placeName,
  promptsOf,
  replyChars,
  replyTail,
  screenLines,
  screenOf,
  screenRows,
  shellDigest,
  substantial,
  tailOf,
  type MurmurHost,
  type MurmurTimes,
  type MurmurSubject,
} from "./murmur.js"
import { unnamed } from "./naming.js"
import type { Facts } from "./nudges.js"
import { screenText } from "./screen.js"
import { freshWork, promptChars, shorten, type Work } from "./work.js"

const work = (fields: Partial<Work> = {}): Work => ({
  ...freshWork("claude:s1"),
  first: "Fix the login bug",
  latest: "Fix the login bug",
  recent: ["Fix the login bug"],
  ...fields,
})

const { Terminal } = headless

// Draws text at a row of the screen, by a cursor move.
const draw = (row: number, text: string) => `\u001b[${row};1H${text}`

describe("the digest of an agent's terminal", () => {
  const input = {
    harness: "claude" as const,
    projectFolder: "/home/me/shop",
    cwd: "/home/me/shop/services/auth",
    branch: "fix/login",
    plan: "Repair the session cookie",
    work: work({ folders: { "/home/me/shop/services/auth": 4, "/home/me/elsewhere/lib": 2 } }),
    reply: "Done, the cookie is set.",
    summary: "Fixes the login cookie.",
    previous: null,
  }

  it("is built from the project, place, branch, plan, folders, prompts, reply and the agent's summary", () => {
    expect(agentDigest(input)).toEqual({
      kind: "agent",
      harness: "Claude Code",
      project: "shop",
      folder: "services/auth",
      branch: "fix/login",
      plan: "Repair the session cookie",
      // Inside the project relative to it, outside by its last segments.
      folders: ["services/auth", "elsewhere/lib"],
      prompts: ["Fix the login bug"],
      reply: "Done, the cookie is set.",
      summary: "Fixes the login cookie.",
      previous: null,
    })
  })

  it("passes murmur's last description for stability, and names no project it can't", () => {
    const previous = { title: "Fixing login" }
    expect(agentDigest({ ...input, previous, projectFolder: undefined })).toMatchObject({
      project: null,
      previous,
    })
  })

  it("is none before the person has prompted and the agent has summarized", () => {
    const bare = { ...input, summary: null }
    expect(agentDigest({ ...bare, work: freshWork("claude:s1") })).toBeNull()
    expect(agentDigest({ ...bare, work: null })).toBeNull()
    // A summary alone is enough.
    expect(agentDigest({ ...input, work: null })).toMatchObject({
      prompts: [],
      summary: "Fixes the login cookie.",
    })
  })

  it("shows the first prompt beside the recent ones once it left them, the current one last", () => {
    const recent = ["two", "three", "four", "five", "six"]
    expect(promptsOf(work({ first: "one", latest: "six", recent }))).toEqual(["one", ...recent])
    // Still among them: not shown twice.
    expect(promptsOf(work({ first: "one", latest: "five", recent: ["one", "two"] }))).toEqual([
      "one",
      "two",
    ])
    // The first is cut short in `work`; the long form among the recent ones is the same prompt.
    const long = `one ${"word ".repeat(80)}`.trim()
    const short = work({ first: shorten(long, promptChars), recent: [long] })
    expect(promptsOf(short)).toEqual([long])
    expect(promptsOf(null)).toEqual([])
  })

  it("names a place by its last two segments", () => {
    expect(placeName("/home/me/shop/services/auth")).toBe("services/auth")
    expect(placeName("C:\\w\\shop\\")).toBe("w/shop")
    expect(placeName("/")).toBe("/")
  })
})

// One line of a fake transcript: "role:kind:text".
const items: Items = (line) => {
  const [role, kind, ...text] = line.split(":")
  return role && kind ? [{ role, kind, text: text.join(":") } as ReturnType<Items>[number]] : []
}

describe("the tail of an agent's reply", () => {
  it("keeps the end of a long text, with an ellipsis where it was cut", () => {
    expect(tailOf("short", 10)).toBe("short")
    const tail = tailOf("a".repeat(50) + "END", 10)
    expect([...tail]).toHaveLength(10)
    expect(tail.startsWith("…")).toBe(true)
    expect(tail.endsWith("aaaaaaEND")).toBe(true)
  })

  describe("read from the transcript", () => {
    let directory: string
    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), "novadeck-reply-"))
    })
    afterEach(() => rmSync(directory, { recursive: true, force: true }))

    const transcript = (...lines: string[]) => {
      const path = join(directory, "t.jsonl")
      writeFileSync(path, lines.join("\n"))
      return path
    }

    it("is the last text since the person's prompt and the latest tool step, up to the cap", async () => {
      const path = transcript(
        "user:text:fix it",
        "assistant:text:Looking.",
        "assistant:tool-call:Read",
        "tool:tool-result:ok",
        `assistant:text:${"x".repeat(replyChars + 500)}FINAL`,
      )
      const reply = await replyTail(path, items)
      expect([...reply!]).toHaveLength(replyChars)
      expect(reply!.endsWith("FINAL")).toBe(true)
      expect(reply!.startsWith("…")).toBe(true)
    })

    it("is null while the turn has said nothing yet, or when the transcript can't be read", async () => {
      expect(await replyTail(transcript("user:text:fix it"), items)).toBeNull()
      expect(
        await replyTail(transcript("user:text:a", "assistant:text:b", "user:text:c"), items),
      ).toBeNull()
      expect(await replyTail(join(directory, "missing.jsonl"), items)).toBeNull()
    })

    it("drops terminal escapes and control characters", async () => {
      const path = transcript("assistant:text:\u001b[31mred\u001b[0m and \u0007bell")
      expect(await replyTail(path, items)).toBe("red and  bell")
    })
  })
})

describe("the digest of a plain shell", () => {
  it("is the command, the place and the visible rows, trimmed", () => {
    expect(
      shellDigest({
        projectFolder: "/home/me/shop",
        cwd: "/home/me/shop/web",
        command: "pnpm dev",
        rows: ["", "  vite ready  ", "", "$ ", "", ""],
        previous: null,
      }),
    ).toEqual({
      kind: "shell",
      project: "shop",
      folder: "shop/web",
      command: "pnpm dev",
      screen: ["vite ready", "", "$"],
      previous: null,
    })
  })

  it("has nothing to say of a bare prompt, with no program, but of a program with no output", () => {
    const bare = { projectFolder: undefined, cwd: "/w", previous: null }
    expect(shellDigest({ ...bare, command: null, rows: ["$ ", ""] })).toBeNull()
    expect(shellDigest({ ...bare, command: null, rows: ["ls", "a b c", "$"] })).not.toBeNull()
    expect(shellDigest({ ...bare, command: "sleep 60", rows: [] })).toMatchObject({
      command: "sleep 60",
      screen: [],
    })
  })

  it("keeps the lowest rows of a tall screen, each cut, without escapes", () => {
    const rows = Array.from({ length: 150 }, (_, index) => `row ${index}`)
    const kept = screenOf(rows)
    expect(kept).toHaveLength(screenRows)
    expect(kept.at(-1)).toBe("row 149")
    expect(screenOf(["\u001b[1mbold\u001b[0m"])).toEqual(["bold"])
    expect(screenOf(["x".repeat(20_000)])[0]!.length).toBeLessThanOrEqual(8000)
  })

  it("joins the rows the terminal wrapped into the line they are, so a split value is whole", () => {
    const secret = "9f2c4e7a1b3d5f60718293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d8e"
    const rows = ["$ cat key.txt", secret.slice(0, 40), secret.slice(40), "$ "]
    expect(screenOf(rows, [false, false, true, false])).toEqual(["$ cat key.txt", secret, "$"])
    // Unwrapped, they stay lines of their own.
    expect(screenOf(rows)).toHaveLength(4)
    // The first row is never a continuation.
    expect(screenOf(["a", "b"], [true, true])).toEqual(["ab"])
  })

  it("never glues rows drawn full across the screen, but says the line goes on below", async () => {
    const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a09"
    const rows = ["$ cat key", hex.slice(0, 40), hex.slice(40), "$ "]
    const filled = [false, true, false, false]
    expect(screenLines(rows, [], filled)).toEqual({
      screen: ["$ cat key", hex.slice(0, 40), hex.slice(40), "$"],
      continues: [false, true, false, false],
    })
    // A wrapped row joins its line, which goes on when its last row was full.
    expect(
      screenLines(["a".repeat(40), "bb", "c"], [false, true, false], [true, false, false]),
    ).toEqual({
      screen: [`${"a".repeat(40)}bb`, "c"],
      continues: [false, false],
    })
    expect(screenLines(["a".repeat(40), "bb"], [false, true], [false, true])).toMatchObject({
      continues: [true],
    })
    // Blank lines above and below, and the rows past the cap, drop with theirs.
    expect(screenLines(["", "x", "", ""], [], [false, true, false, false])).toEqual({
      screen: ["x"],
      continues: [true],
    })
    // Boxes and progress bars keep their lines.
    expect(screenOf(["┌──────┐", "│ done │", "└──────┘"])).toHaveLength(3)
    expect(
      shellDigest({
        projectFolder: undefined,
        cwd: "/w",
        command: null,
        rows,
        rowContinues: filled,
        previous: null,
      }),
    ).toMatchObject({ continues: [false, true, false, false] })
  })

  it("reads which rows are full from a real terminal's cells, never from string lengths", async () => {
    const terminal = new Terminal({ cols: 8, rows: 8, allowProposedApi: true })
    await new Promise<void>((resolve) =>
      terminal.write(
        `\u001b[2J${draw(1, "abcdefgh")}${draw(2, "abc")}${draw(3, "abcdefg ")}${draw(4, "あいうえ")}${draw(5, "abcdefge\u0301")}${draw(6, "abcdefg")}`,
        resolve,
      ),
    )
    const text = screenText(terminal)
    expect(text.wrapped?.some(Boolean)).toBe(false)
    // Full: plain text to the last column, double-width characters to it, and a combining
    // mark in it. Not: short rows, a trailing blank, an empty row.
    expect(text.continues).toEqual([true, false, false, true, true, false, false, false])
    terminal.dispose()
  })

  it("keeps a secret drawn across rows with cursor moves out of the model's sight, once redaction reads the line's end", async () => {
    const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a09"
    const terminal = new Terminal({ cols: 40, rows: 8, allowProposedApi: true })
    const drawn = ["$ cat key", hex.slice(0, 40), hex.slice(40), "$ "]
      .map((row, index) => `\u001b[${index + 1};1H${row}`)
      .join("")
    await new Promise<void>((resolve) => terminal.write(`\u001b[2J${drawn}`, resolve))
    const text = screenText(terminal)
    const digest = shellDigest({
      projectFolder: undefined,
      cwd: "/w",
      command: null,
      rows: text.rows,
      ...(text.wrapped && { wrapped: text.wrapped }),
      ...(text.continues && { rowContinues: text.continues }),
      previous: null,
    })!
    expect(digest.continues).toEqual([false, true, false, false])
    expect((redactDigest(digest) as ShellDigest).screen.join("\n")).not.toContain(hex.slice(0, 40))
    terminal.dispose()
  })

  it("cuts lines only at a generous safety cap, leaving the redaction its whole value", () => {
    const long = `KEY=${"a".repeat(3000)}`
    expect(screenOf([long])[0]).toBe(long)
  })

  it("names the program by its command line where the platform tells it, else by its name", () => {
    expect(commandOf({ name: "node", argv: ["node", "server.js", "--port", "80"] }, false)).toBe(
      "node server.js --port 80",
    )
    expect(commandOf({ name: "vim", argv: null }, false)).toBe("vim")
    // The prompt is the shell holding the foreground, and Windows tells no program.
    expect(commandOf({ name: "bash", argv: null }, true)).toBeNull()
    expect(commandOf(null, false)).toBeNull()
    // A script the shell's own interpreter runs is a program, not the prompt.
    expect(commandOf({ name: "bash", argv: ["bash", "deploy.sh", "--prod"] }, false)).toBe(
      "bash deploy.sh --prod",
    )
  })
})

const text = (title: string): Description => ({ title })

describe("the descriptions of a terminal", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const digest = {
    kind: "shell",
    project: null,
    folder: null,
    command: "a",
    screen: [],
    previous: null,
  } as const

  it("waits out its quiet: a newer request restarts the wait, and one description is made", async () => {
    const describer = new FakeDescriber()
    const descriptions = new Descriptions(describer)
    const done =
      vi.fn<(outcome: Description | null | undefined, digest: Digest | undefined) => void>()
    const build = vi.fn<() => Promise<Digest>>(() => Promise.resolve(digest))
    descriptions.request("a", 100, build, done)
    await vi.advanceTimersByTimeAsync(60)
    descriptions.request("a", 100, build, done)
    await vi.advanceTimersByTimeAsync(60)
    expect(build).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60)
    expect(build).toHaveBeenCalledTimes(1)
    expect(done).toHaveBeenCalledTimes(1)
    expect(descriptions.busy("a")).toBe(false)
  })

  it("has at most one job per terminal: a newer digest aborts the older, whose answer is dropped", async () => {
    const describer = new FakeDescriber()
    describer.hold = true
    const descriptions = new Descriptions(describer)
    const done =
      vi.fn<(outcome: Description | null | undefined, digest: Digest | undefined) => void>()
    descriptions.request("a", 10, () => Promise.resolve({ ...digest, command: "first" }), done)
    await vi.advanceTimersByTimeAsync(10)
    expect(describer.jobs).toHaveLength(1)
    expect(descriptions.busy("a")).toBe(true)
    descriptions.request("a", 10, () => Promise.resolve({ ...digest, command: "second" }), done)
    await vi.advanceTimersByTimeAsync(10)
    expect(describer.jobs).toHaveLength(2)
    expect(describer.jobs[0]!.signal?.aborted).toBe(true)
    expect(describer.jobs[1]!.signal?.aborted).toBe(false)
    // Even an answer the aborted job still gives lands nowhere.
    describer.jobs[0]!.answer(text("Old"))
    describer.jobs[1]!.answer(text("New"))
    await vi.advanceTimersByTimeAsync(0)
    expect(done.mock.calls.map(([description]) => (description as Description).title)).toEqual([
      "New",
    ])
  })

  it("does not coalesce different terminals", async () => {
    const describer = new FakeDescriber()
    const descriptions = new Descriptions(describer)
    const done =
      vi.fn<(outcome: Description | null | undefined, digest: Digest | undefined) => void>()
    descriptions.request("a", 10, () => Promise.resolve(digest), done)
    descriptions.request("b", 10, () => Promise.resolve(digest), done)
    await vi.advanceTimersByTimeAsync(10)
    expect(done).toHaveBeenCalledTimes(2)
  })

  it("tells a request whose build has nothing, and a describer that did not run, as undefined", async () => {
    const describer = new FakeDescriber({ reply: () => undefined })
    const descriptions = new Descriptions(describer)
    const done =
      vi.fn<(outcome: Description | null | undefined, digest: Digest | undefined) => void>()
    descriptions.request("a", 10, () => Promise.resolve(undefined), done)
    descriptions.request("b", 10, () => Promise.resolve(digest), done)
    await vi.advanceTimersByTimeAsync(10)
    expect(describer.jobs).toHaveLength(1)
    expect(done.mock.calls).toEqual([
      [undefined, undefined],
      [undefined, digest],
    ])
  })

  it("tells a refusal as null, and passes the describer the terminal it asks for", async () => {
    const describer = new FakeDescriber({ reply: () => null })
    const descriptions = new Descriptions(describer)
    const done =
      vi.fn<(outcome: Description | null | undefined, digest: Digest | undefined) => void>()
    descriptions.request("terminal-9", 10, () => Promise.resolve(digest), done)
    await vi.advanceTimersByTimeAsync(10)
    expect(done).toHaveBeenCalledWith(null, digest)
    expect(describer.jobs[0]!.terminal).toBe("terminal-9")
  })

  it("withdraws a request that waits, and cancels a running job when the terminal is gone", async () => {
    const describer = new FakeDescriber()
    describer.hold = true
    const descriptions = new Descriptions(describer)
    const done =
      vi.fn<(outcome: Description | null | undefined, digest: Digest | undefined) => void>()
    descriptions.request("a", 10, () => Promise.resolve(digest), done)
    descriptions.withdraw("a")
    await vi.advanceTimersByTimeAsync(10)
    expect(describer.jobs).toHaveLength(0)
    descriptions.request("a", 10, () => Promise.resolve(digest), done)
    await vi.advanceTimersByTimeAsync(10)
    // A job that runs goes on past a withdrawal, until the terminal is gone.
    descriptions.withdraw("a")
    expect(describer.jobs[0]!.signal?.aborted).toBe(false)
    descriptions.cancel("a")
    expect(describer.jobs[0]!.signal?.aborted).toBe(true)
    describer.jobs[0]!.answer(text("Late"))
    await vi.advanceTimersByTimeAsync(0)
    expect(done).not.toHaveBeenCalled()
    expect(descriptions.busy("a")).toBe(false)
  })

  it("survives a describer that fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const describer = new FakeDescriber({
      reply: () => {
        throw new Error("boom")
      },
    })
    const descriptions = new Descriptions(describer)
    const done =
      vi.fn<(outcome: Description | null | undefined, digest: Digest | undefined) => void>()
    descriptions.request("a", 10, () => Promise.resolve(digest), done)
    await vi.advanceTimersByTimeAsync(10)
    expect(done).not.toHaveBeenCalled()
    expect(descriptions.busy("a")).toBe(false)
    error.mockRestore()
  })
})

const settle = (ms = 150) => vi.advanceTimersByTimeAsync(ms)

// A host over terminals a test changes in place, remembering what murmur wrote.
const create = (
  initial: Partial<MurmurSubject> = {},
  describer = new FakeDescriber(),
  more: Partial<MurmurTimes> = {},
) => {
  const base: MurmurSubject = {
    summary: {
      id: "a",
      sessionId: "s",
      cwd: "/home/me/shop",
      process: null,
    } as MurmurSubject["summary"],
    naming: unnamed,
    work: null,
    activity: null,
    openedBy: null,
    agent: "claude",
    transcript: null,
    program: null,
    atPrompt: true,
    expecting: null,
    ...initial,
  }
  const subjects = new Map<string, MurmurSubject>([["a", base]])
  const facts: { current: Facts } = { current: { plan: null, folder: null, branch: "main" } }
  const rows: { current: readonly string[] } = { current: ["$ ls", "a b", "$ "] }
  const wrapped: { current: readonly boolean[] | undefined } = { current: undefined }
  const alternate = { current: false }
  // The terminals are there only once murmur is built, as when the runner starts.
  let ready = false
  const reads = { facts: 0, screens: 0 }
  const replies: { current: string | null } = { current: null }
  const written: Description[] = []
  const clears = { count: 0 }
  const files = new Map<string, string>()
  const heads: string[] = []
  const hooks: { items?: () => void; head?: Promise<string | null> } = {}
  const headlined: string[] = []
  const gisted: string[] = []
  const host: MurmurHost = {
    subject: (id) => subjects.get(id),
    subjects: () => (ready ? [...subjects.values()] : []),
    facts: () => {
      reads.facts += 1
      return Promise.resolve(facts.current)
    },
    screen: () => {
      reads.screens += 1
      return Promise.resolve({
        rows: rows.current,
        alternate: alternate.current,
        ...(wrapped.current && { wrapped: wrapped.current }),
      })
    },
    items: () => {
      hooks.items?.()
      return items
    },
    projectFolder: () => "/home/me/shop",
    described: (id, description) => {
      written.push(description)
      const subject = subjects.get(id)
      if (subject)
        subjects.set(id, { ...subject, naming: { ...subject.naming, murmur: description } })
    },
    headlined: (id, { requestId, askedAt }, headline) => {
      const subject = subjects.get(id)
      const activity =
        subject?.activity && withHeadline(subject.activity, requestId, askedAt, headline)
      if (!activity) return
      headlined.push(headline)
      subjects.set(id, { ...subject, activity })
    },
    gisted: (id, at, gist) => {
      const subject = subjects.get(id)
      const activity = subject?.activity && withGist(subject.activity, at, gist)
      if (!activity) return
      gisted.push(gist.text)
      subjects.set(id, { ...subject, activity })
    },
    fileHead: (path) => {
      heads.push(path)
      return hooks.head ?? Promise.resolve(files.get(path) ?? null)
    },
    cleared: () => {
      clears.count += 1
      for (const [id, subject] of subjects)
        subjects.set(id, { ...subject, naming: { ...subject.naming, murmur: null } })
    },
  }
  // A program in the foreground is the prompt when it is bash, the shell of these tests.
  const change = (fields: Partial<MurmurSubject>, id = "a") =>
    subjects.set(id, {
      ...subjects.get(id)!,
      ...("program" in fields && !("atPrompt" in fields)
        ? { atPrompt: fields.program?.name === "bash" && fields.program.argv?.length !== 2 }
        : {}),
      ...fields,
    })
  const times = {
    settleMs: 100,
    shellRunMs: 500,
    shellSettleMs: 200,
    promptsBetween: 3,
    expectMs: 1_000,
    noteMs: 50,
    ...more,
  }
  const murmur = new Murmur(describer, host, times)
  ready = true
  // The replies the host gives are read from the transcript; here, from the activity.
  return {
    murmur,
    describer,
    subjects,
    facts,
    rows,
    wrapped,
    alternate,
    reads,
    replies,
    written,
    clears,
    files,
    heads,
    hooks,
    headlined,
    gisted,
    change,
    times,
  }
}

const idle = (reply: string | null) =>
  ({
    state: "idle",
    pending: [],
    plans: [],
    lastTurn: { reply },
  }) as unknown as MurmurSubject["activity"]
const working = () =>
  ({
    state: "working",
    pending: [],
    plans: [],
    lastTurn: null,
  }) as unknown as MurmurSubject["activity"]
const report = (fields: Partial<Parameters<Murmur["reported"]>[1]> = {}) => ({
  session: false,
  ...fields,
})

describe("when an agent's terminal is titled", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("titles it once from the first prompt, its mission, however many reports follow", async () => {
    const { murmur, describer, change, written } = create({ work: work(), activity: working() })
    murmur.reported("a", report({ session: true }))
    murmur.reported("a", report())
    murmur.reported("a", report())
    await settle()
    expect(describer.jobs).toHaveLength(1)
    expect(describer.digests[0]).toMatchObject({
      kind: "agent",
      harness: "Claude Code",
      project: "shop",
      branch: "main",
      prompts: ["Fix the login bug"],
      summary: null,
      previous: null,
    })
    expect(written).toEqual([{ title: "Title 1" }])
    // Titled, it is not titled again by turns, prompts, compactions or drift.
    change({
      work: work({ recent: ["Fix the login bug", "hows going?", "try again"] }),
      activity: idle("Fixed it."),
    })
    for (const _ of [1, 2, 3, 4, 5, 6]) murmur.reported("a", report())
    await settle(10_000)
    expect(describer.jobs).toHaveLength(1)
  })

  it("waits out terse prompts: a greeting or two words is no mission", async () => {
    const { murmur, describer, change } = create({
      work: work({ first: "hey!", latest: "hey!", recent: ["hey!"] }),
      activity: working(),
    })
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(describer.jobs).toHaveLength(0)
    change({ work: work({ first: "hey!", latest: "try again", recent: ["hey!", "try again"] }) })
    murmur.reported("a", report())
    await settle()
    expect(describer.jobs).toHaveLength(0)
    // The next substantial prompt is the mission; the terse ones are not shown without a summary.
    change({
      work: work({
        first: "hey!",
        latest: "Fix the login bug",
        recent: ["hey!", "try again", "Fix the login bug"],
      }),
    })
    murmur.reported("a", report())
    await settle()
    expect(describer.jobs).toHaveLength(1)
    expect(describer.digests[0]).toMatchObject({ prompts: ["Fix the login bug"] })
  })

  it("titles it from the agent's first summary when no prompt was substantial", async () => {
    const { murmur, describer, change } = create({
      work: work({ first: "hey!", latest: "hey!", recent: ["hey!"] }),
      activity: working(),
    })
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(describer.jobs).toHaveLength(0)
    change({ naming: { ...unnamed, summary: "Fixes the login cookie." } })
    murmur.summarized("a")
    await settle()
    expect(describer.jobs).toHaveLength(1)
    expect(describer.digests[0]).toMatchObject({
      summary: "Fixes the login cookie.",
      prompts: ["hey!"],
    })
  })

  it("titles again on every summary, which is the main input, as one job for a burst", async () => {
    const { murmur, describer, change } = create({ work: work(), activity: idle("ok") })
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(describer.jobs).toHaveLength(1)
    expect(describer.digests[0]).toMatchObject({ summary: null })
    change({
      naming: { ...unnamed, murmur: { title: "Title 1" }, summary: "Fixes the login cookie." },
    })
    murmur.summarized("a")
    murmur.summarized("a")
    await settle()
    expect(describer.jobs).toHaveLength(2)
    expect(describer.digests[1]).toMatchObject({
      summary: "Fixes the login cookie.",
      previous: { title: "Title 1" },
    })
  })

  it("titles a new root session again once it has a mission of its own", async () => {
    const { murmur, describer, change } = create({ work: work(), activity: idle("ok") })
    murmur.reported("a", report({ session: true }))
    await settle()
    // A new session starts over, but waits for its own first prompt.
    change({ work: freshWork("claude:s2") })
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(describer.jobs).toHaveLength(1)
    change({
      work: work({ session: "claude:s2", first: "Write the docs", recent: ["Write the docs"] }),
    })
    murmur.reported("a", report())
    await settle()
    expect(describer.jobs).toHaveLength(2)
    expect(describer.digests[1]).toMatchObject({ prompts: ["Write the docs"] })
  })

  it("coalesces: a newer digest aborts the job still running", async () => {
    const { murmur, describer, change } = create({ work: work(), activity: idle("ok") })
    describer.hold = true
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(describer.jobs).toHaveLength(1)
    change({ naming: { ...unnamed, summary: "Fixes the login cookie." } })
    murmur.summarized("a")
    await settle()
    expect(describer.jobs).toHaveLength(2)
    expect(describer.jobs[0]!.signal?.aborted).toBe(true)
  })

  it("does nothing in a terminal with no agent, or without being usable", async () => {
    const { murmur, describer, change } = create({ work: work(), agent: null })
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(describer.jobs).toHaveLength(0)
    change({ agent: "claude" })
    describer.setUsable(false)
    murmur.reported("a", report({ session: true }))
    murmur.summarized("a")
    await settle()
    expect(describer.jobs).toHaveLength(0)
  })

  it("shows the preview of the last reply where no transcript tells more, once the turn is over", async () => {
    const { murmur, describer, change } = create({ work: work(), activity: working() })
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(describer.digests[0]).toMatchObject({ reply: null })
    change({ activity: idle("Cookie fixed."), naming: { ...unnamed, summary: "Fixes it." } })
    murmur.summarized("a")
    await settle()
    expect(describer.digests[1]).toMatchObject({ reply: "Cookie fixed." })
  })

  it("never names a terminal with a title that can't be one", async () => {
    for (const title of ["two\nlines", "", "x".repeat(300)]) {
      const { murmur, written } = create(
        { work: work(), activity: idle(null) },
        new FakeDescriber({ reply: () => ({ title }) }),
      )
      murmur.reported("a", report({ session: true }))
      // eslint-disable-next-line no-await-in-loop -- One terminal after another.
      await settle()
      expect(written).toEqual([])
    }
    const { murmur, written } = create(
      { work: work(), activity: idle(null) },
      new FakeDescriber({ reply: () => ({ title: "  Fixing login  " }) }),
    )
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(written).toEqual([{ title: "Fixing login" }])
  })
})

describe("a mission murmur did not get to title", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("stays owed while murmur backs off, asked again once a minute at most, building nothing between", async () => {
    let answers = 0
    const { murmur, describer, reads, written } = create(
      { work: work(), activity: working() },
      new FakeDescriber({ reply: () => (answers++ < 2 ? undefined : { title: "Fixing login" }) }),
    )
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(describer.jobs).toHaveLength(1)
    const reads1 = reads.facts
    // Report after report for 50 seconds: no job, and no digest built.
    for (let count = 0; count < 50; count += 1) {
      murmur.reported("a", report())
      // eslint-disable-next-line no-await-in-loop -- Time passes between reports.
      await settle(1_000)
    }
    expect(describer.jobs).toHaveLength(1)
    expect(reads.facts).toBe(reads1)
    // After the minute, the next report asks again, once; backed off still, it waits again.
    await settle(10_000)
    murmur.reported("a", report())
    await settle()
    expect(describer.jobs).toHaveLength(2)
    for (let count = 0; count < 20; count += 1) murmur.reported("a", report())
    await settle()
    expect(describer.jobs).toHaveLength(2)
    await settle(61_000)
    murmur.reported("a", report())
    await settle()
    expect(describer.jobs).toHaveLength(3)
    expect(written).toEqual([{ title: "Fixing login" }])
    expect(describer.jobs.every((job) => job.terminal === "a")).toBe(true)
  })
})

describe("a retitle by a summary murmur did not get to run", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const titled = {
    naming: { ...unnamed, murmur: { title: "Fixing login" }, summary: "Rewrites billing." },
  }

  it("is asked again by a timer on an idle terminal, with no report to ask at", async () => {
    let answers = 0
    const { murmur, describer, reads, written } = create(
      { work: work(), activity: idle("ok"), ...titled },
      new FakeDescriber({ reply: () => (answers++ === 0 ? undefined : { title: "Billing" }) }),
    )
    murmur.summarized("a")
    await settle()
    expect(describer.jobs).toHaveLength(1)
    const before = reads.facts
    // Nothing reports for the whole minute: nothing is built or asked.
    await settle(59_000)
    expect(describer.jobs).toHaveLength(1)
    expect(reads.facts).toBe(before)
    // Then it asks, once.
    await settle(2_000)
    expect(describer.jobs).toHaveLength(2)
    expect(describer.digests[1]).toMatchObject({ summary: "Rewrites billing." })
    expect(written).toEqual([{ title: "Billing" }])
    await settle(120_000)
    expect(describer.jobs).toHaveLength(2)
  })

  it("is asked again at the next report too, once the minute has passed", async () => {
    let answers = 0
    const { murmur, describer } = create(
      { work: work(), activity: idle("ok"), ...titled },
      new FakeDescriber({ reply: () => (answers++ === 0 ? undefined : { title: "Billing" }) }),
    )
    murmur.summarized("a")
    await settle()
    for (let count = 0; count < 10; count += 1) murmur.reported("a", report())
    await settle(30_000)
    expect(describer.jobs).toHaveLength(1)
    await settle(31_000)
    expect(describer.jobs).toHaveLength(2)
  })

  it("is dropped with the terminal, and on stopping", async () => {
    const first = create(
      { work: work(), activity: idle("ok"), ...titled },
      new FakeDescriber({ reply: () => undefined }),
    )
    first.murmur.summarized("a")
    await settle()
    first.murmur.gone("a")
    await settle(120_000)
    expect(first.describer.jobs).toHaveLength(1)
    const second = create(
      { work: work(), activity: idle("ok"), ...titled },
      new FakeDescriber({ reply: () => undefined }),
    )
    second.murmur.summarized("a")
    await settle()
    second.murmur.stop()
    await settle(120_000)
    expect(second.describer.jobs).toHaveLength(1)
  })

  it("is forgotten when a new session starts", async () => {
    const { murmur, describer, change } = create(
      { work: work(), activity: idle("ok"), ...titled },
      new FakeDescriber({ reply: () => undefined }),
    )
    murmur.summarized("a")
    await settle()
    change({ work: freshWork("claude:s2") })
    murmur.reported("a", report({ session: true }))
    await settle(120_000)
    // Its timer is gone, and the new session has no mission yet.
    expect(describer.jobs).toHaveLength(1)
  })
})

describe("a mission murmur refused to title", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("is asked for once after a refusal, however many reports follow, until something new arrives", async () => {
    const { murmur, describer, change } = create(
      { work: work(), activity: working() },
      new FakeDescriber({ reply: () => null }),
    )
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(describer.jobs).toHaveLength(1)
    // Hook after hook, status line after status line: no further call.
    for (let count = 0; count < 20; count += 1) {
      murmur.reported("a", report())
      // eslint-disable-next-line no-await-in-loop -- Time passes between reports.
      await settle(500)
    }
    expect(describer.jobs).toHaveLength(1)
    // The same mission among more prompts is not new; other words for it are.
    change({ work: work({ recent: ["Fix the login bug", "hows going?"] }) })
    murmur.reported("a", report())
    await settle()
    expect(describer.jobs).toHaveLength(1)
    change({ work: work({ first: "hey!", recent: ["hey!", "Add paging to the users API"] }) })
    murmur.reported("a", report())
    await settle()
    expect(describer.jobs).toHaveLength(2)
    // A summary is new, and so is a new session.
    change({ naming: { ...unnamed, summary: "Fixes the login cookie." } })
    murmur.summarized("a")
    await settle()
    expect(describer.jobs).toHaveLength(3)
    for (let count = 0; count < 10; count += 1) murmur.reported("a", report())
    await settle()
    expect(describer.jobs).toHaveLength(3)
    change({
      naming: unnamed,
      work: work({
        session: "claude:s2",
        first: "Write the docs now",
        recent: ["Write the docs now"],
      }),
    })
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(describer.jobs).toHaveLength(4)
  })
})

describe("a summary across root sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("is the mission only in the session it was written in: a new session is titled from its own", async () => {
    const { murmur, describer, change } = create({ work: work(), activity: idle("ok") })
    murmur.reported("a", report({ session: true }))
    await settle()
    change({
      naming: { ...unnamed, murmur: { title: "Title 1" }, summary: "Fixes the login cookie." },
    })
    murmur.summarized("a")
    await settle()
    expect(describer.jobs).toHaveLength(2)
    expect(describer.digests[1]).toMatchObject({ summary: "Fixes the login cookie." })
    // /clear: a new session, with fresh work. Its old summary is no mission and no input.
    change({ work: freshWork("claude:s2") })
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(describer.jobs).toHaveLength(2)
    change({
      work: work({
        session: "claude:s2",
        first: "Write the release docs",
        latest: "Write the release docs",
        recent: ["Write the release docs"],
      }),
    })
    murmur.reported("a", report())
    await settle(5_000)
    expect(describer.jobs).toHaveLength(3)
    expect(describer.digests[2]).toMatchObject({
      prompts: ["Write the release docs"],
      summary: null,
    })
  })

  it("makes a digest of a current summary alone, with no prompt yet", async () => {
    const { murmur, describer, change } = create({
      work: freshWork("claude:s1"),
      activity: working(),
    })
    change({ naming: { ...unnamed, summary: "Fixes the login cookie." } })
    murmur.summarized("a")
    await settle()
    expect(describer.digests[0]).toMatchObject({ summary: "Fixes the login cookie.", prompts: [] })
    expect(
      agentDigest({
        harness: "claude",
        projectFolder: undefined,
        cwd: "/w",
        branch: null,
        plan: null,
        work: freshWork("claude:s1"),
        reply: null,
        summary: null,
        previous: null,
      }),
    ).toBeNull()
  })

  it("is not the mission after a runner restart, where it was written is unknown", async () => {
    const { murmur, describer, change } = create({
      work: work(),
      activity: idle("ok"),
      naming: { ...unnamed, summary: "Left over." },
    })
    describer.setUsable(false)
    describer.setUsable(true)
    await settle(300)
    // Titled from the first prompt, with the persisted summary not among its inputs.
    expect(describer.digests[0]).toMatchObject({ summary: null, prompts: ["Fix the login bug"] })
    // Its agent's next summary is its own, and counts.
    change({ naming: { ...unnamed, summary: "Fixes login again." } })
    murmur.summarized("a")
    await settle()
    expect(describer.digests[1]).toMatchObject({ summary: "Fixes login again." })
  })

  it("follows a corrected root session, and is noted while murmur is unusable", async () => {
    const { murmur, describer, change } = create(
      { work: work({ session: "agy:guess" }), activity: idle("ok") },
      new FakeDescriber({ usable: false }),
    )
    change({ naming: { ...unnamed, summary: "Fixes login." } })
    // Unusable, it asks nothing but knows which session wrote the summary.
    murmur.summarized("a")
    change({ work: work({ session: "agy:real" }) })
    murmur.reported("a", report({ corrected: [{ from: "agy:guess", to: "agy:real" }] }))
    describer.setUsable(true)
    await settle(300)
    expect(describer.digests[0]).toMatchObject({ summary: "Fixes login." })
  })
})

describe("a prompt that says what a terminal is for", () => {
  it("has at least three words and is no greeting", () => {
    for (const terse of [
      "hey!",
      "hows going?",
      "try again",
      "ok",
      "thanks a lot",
      "hello there",
      "cześć, co tam słychać",
      "tak, zrób to",
      "spróbuj jeszcze raz",
      "can you help me",
      "hey can you help",
      "how are you doing today",
      "I'm back",
      "możesz mi pomóc",
      "こんにちは",
      "ありがとうございます",
      "สวัสดีครับ",
      "你好",
      "好的",
      "你好，谢谢",
      "谢谢你",
      "안녕하세요",
      "안녕하세요 감사합니다 고맙습니다",
      "hej, jak leci?",
      "siema co tam",
      "dzięki, świetna robota",
      "sounds good, thanks!",
      "yes do it",
      "go on please",
      "no, the other one",
      "ok thanks, bye",
      "yes please do that",
      "please continue",
      "continue",
      "/review 130",
      "/clear",
      "fix #131",
      "fix tests",
      "bump deps",
      "",
    ])
      expect(substantial(terse), terse).toBe(false)
    for (const mission of [
      "przejrzyj PR 130",
      "修好测试",
      "修好的测试",
      "你好，修好测试",
      "로그인 버그를 고쳐줘",
      "こんにちは、テストを直して",
      "สวัสดีครับ แก้บั๊กการเข้าสู่ระบบ",
      "review PR 130",
      "zrób review PR 130",
      "dodaj tryb ciemny",
      "test the login flow",
      "testing the new parser",
      "ping the other agent",
      "hello world app",
      "ok fix the tests",
      "ok, now deploy it",
      "lgtm, merge it",
      "write release notes",
      "refactor manager.ts",
      "rebase on main",
      "test e2e suite fails",
      "修复登录错误",
      "テストを直して",
      "로그인 버그 수정",
      "แก้บั๊กการเข้าสู่ระบบ",
      "Fix the login bug",
      "add pagination to /users",
      "refactor the store, please",
      "hello, please fix the build",
      "Écris les tests du module",
    ])
      expect(substantial(mission), mission).toBe(true)
  })
})

describe("when a plain shell's terminal is described", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const dev = { name: "node", argv: ["node", "dev.js"] }

  it("describes a program that has run a few seconds, not a command that ended sooner", async () => {
    const { murmur, describer, change, times } = create({ agent: null })
    change({ program: { name: "ls", argv: ["ls"] } })
    murmur.sampled("a")
    await settle(times.shellRunMs - 100)
    // Back at the prompt before it ran long enough.
    change({ program: { name: "bash", argv: null } })
    murmur.sampled("a")
    await settle(2_000)
    expect(describer.jobs).toHaveLength(0)

    change({ program: dev })
    murmur.sampled("a")
    await settle(times.shellRunMs - 1)
    expect(describer.jobs).toHaveLength(0)
    await settle(2)
    expect(describer.jobs).toHaveLength(1)
    expect(describer.digests[0]).toMatchObject({
      kind: "shell",
      command: "node dev.js",
      screen: ["$ ls", "a b", "$"],
    })
  })

  it("describes again at the prompt after a program that ran long, not after a short one", async () => {
    const { murmur, describer, change, times } = create({ agent: null })
    change({ program: dev })
    murmur.sampled("a")
    await settle(times.shellRunMs + 10)
    expect(describer.jobs).toHaveLength(1)
    await settle(times.shellRunMs)
    change({ program: { name: "bash", argv: null } })
    murmur.sampled("a")
    await settle(times.shellSettleMs + 10)
    expect(describer.jobs).toHaveLength(2)
    expect(describer.digests[1]).toMatchObject({ command: null })
  })

  it("describes nothing for a program that is gone by the time its wait is over", async () => {
    const { murmur, describer, change, times } = create({ agent: null })
    change({ program: dev })
    murmur.sampled("a")
    await settle(times.shellRunMs - 10)
    change({ program: { name: "vim", argv: null } })
    murmur.sampled("a")
    await settle(times.shellRunMs - 100)
    expect(describer.jobs).toHaveLength(0)
    await settle(200)
    expect(describer.jobs).toHaveLength(1)
    expect(describer.digests[0]).toMatchObject({ command: "vim" })
  })

  it("describes when its directory changed, debounced", async () => {
    const { murmur, describer, times } = create({ agent: null })
    murmur.moved("a")
    await settle(times.shellSettleMs - 50)
    murmur.moved("a")
    await settle(times.shellSettleMs - 50)
    expect(describer.jobs).toHaveLength(0)
    await settle(100)
    expect(describer.jobs).toHaveLength(1)
  })

  it("leaves a terminal that runs an agent to its agent triggers", async () => {
    const { murmur, describer } = create({ agent: "claude" })
    murmur.moved("a")
    murmur.sampled("a")
    await settle(2_000)
    expect(describer.jobs).toHaveLength(0)
  })

  it("shows no screen of a full-screen program, only its command, and the screen again when it quits", async () => {
    const { murmur, describer, change, alternate, rows, times } = create({ agent: null })
    alternate.current = true
    rows.current = ["secret text in vim", "more of it"]
    change({ program: { name: "vim", argv: ["vim", "src/auth.ts"] } })
    murmur.sampled("a")
    await settle(times.shellRunMs + 10)
    expect(describer.digests).toHaveLength(1)
    expect(describer.digests[0]).toMatchObject({
      kind: "shell",
      command: "vim src/auth.ts",
      folder: expect.any(String),
      screen: [],
    })
    // The program quits: the prompt is described from the normal screen again.
    alternate.current = false
    rows.current = ["$ vim src/auth.ts", "$ "]
    change({ program: { name: "bash", argv: null } })
    murmur.sampled("a")
    await settle(times.shellSettleMs + 10)
    expect(describer.digests).toHaveLength(2)
    expect(describer.digests[1]).toMatchObject({ screen: ["$ vim src/auth.ts", "$"] })
  })

  it("asks nothing for a full-screen program whose command is not known", async () => {
    const { murmur, describer, alternate, rows, change } = create({ agent: null })
    alternate.current = true
    rows.current = ["drawn by a program", "on two lines"]
    murmur.moved("a")
    change({ program: null })
    murmur.sampled("a")
    await settle(2_000)
    expect(describer.jobs).toHaveLength(0)
  })

  it("is not asked again by a full-screen program's redraws", async () => {
    const { murmur, describer, change, alternate, rows, times } = create({ agent: null })
    alternate.current = true
    change({ program: { name: "htop", argv: ["htop"] } })
    murmur.sampled("a")
    await settle(times.shellRunMs + 10)
    expect(describer.jobs).toHaveLength(1)
    for (let tick = 0; tick < 20; tick += 1) {
      rows.current = [`tick ${tick}`, "cpu"]
      // eslint-disable-next-line no-await-in-loop -- Redraws come one after another.
      await settle(500)
    }
    expect(describer.jobs).toHaveLength(1)
  })

  it("leaves an agent's digest as it is on the alternate screen", async () => {
    const { murmur, describer, alternate } = create({ work: work(), activity: idle("ok") })
    alternate.current = true
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(describer.digests[0]).toMatchObject({ kind: "agent", prompts: ["Fix the login bug"] })
    expect(describer.digests[0]).not.toHaveProperty("screen")
  })

  it("says nothing of a bare prompt", async () => {
    const { murmur, describer, rows } = create({ agent: null })
    rows.current = ["$ "]
    murmur.moved("a")
    await settle(1_000)
    expect(describer.jobs).toHaveLength(0)
  })
})

describe("when murmur is not usable", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("builds and asks nothing, reading no facts, transcript or screen, whatever the terminals do", async () => {
    const { murmur, describer, reads, change, times } = create(
      { work: work(), activity: idle("ok") },
      new FakeDescriber({ usable: false }),
    )
    for (let turn = 0; turn < 5; turn += 1) {
      // eslint-disable-next-line no-await-in-loop -- Turns come one after another.
      murmur.reported("a", report({ session: true }))
      // eslint-disable-next-line no-await-in-loop -- As above.
      await settle()
    }
    change({ agent: null, program: { name: "node", argv: ["node", "dev.js"] } })
    murmur.sampled("a")
    murmur.moved("a")
    await settle(times.shellRunMs * 3)
    expect(describer.jobs).toHaveLength(0)
    expect(reads).toEqual({ facts: 0, screens: 0 })
  })

  it("is how a describer that never says it is usable stays, as the real service does while murmur is off", async () => {
    const calls: unknown[] = []
    const silent = {
      describe: (digest: unknown) => {
        calls.push(digest)
        return Promise.resolve(undefined)
      },
      watchUsable: () => () => {},
      watchCleared: () => () => {},
    }
    const { murmur } = create({ work: work(), activity: idle("ok") }, silent as never)
    murmur.reported("a", report({ session: true }))
    murmur.moved("a")
    await settle(5_000)
    expect(calls).toEqual([])
  })

  it("drops what waited when murmur stops being usable, and asks nothing built before", async () => {
    const { murmur, describer, reads } = create({ work: work(), activity: working() })
    murmur.reported("a", report({ session: true }))
    describer.setUsable(false)
    await settle()
    expect(describer.jobs).toHaveLength(0)
    expect(reads.facts).toBe(0)
  })
})

describe("when a plain shell's terminal runs more than the prompt", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("describes a script its own interpreter runs, which is not the prompt", async () => {
    const { murmur, describer, change, times } = create({ agent: null })
    change({ program: { name: "bash", argv: ["bash", "deploy.sh", "--prod"] }, atPrompt: false })
    murmur.sampled("a")
    await settle(times.shellRunMs + 10)
    expect(describer.digests[0]).toMatchObject({ kind: "shell", command: "bash deploy.sh --prod" })
  })

  it("still describes the prompt after a long run when a short program flashes by first", async () => {
    // The losing order: the long run ends and the prompt's description is asked for; before
    // it is built, a brief program holds the foreground (a prompt hook, a status helper), and
    // the sample after it finds the prompt again with too short a run behind it.
    const { murmur, describer, change, times } = create({ agent: null })
    change({ program: { name: "sleep", argv: ["sleep", "30"] }, atPrompt: false })
    murmur.sampled("a")
    await settle(times.shellRunMs + 10)
    expect(describer.digests).toHaveLength(1)
    change({ program: { name: "bash", argv: null }, atPrompt: true })
    murmur.sampled("a")
    await settle(times.shellSettleMs / 4)
    change({ program: { name: "git", argv: ["git", "status"] }, atPrompt: false })
    murmur.sampled("a")
    await settle(10)
    change({ program: { name: "bash", argv: null }, atPrompt: true })
    murmur.sampled("a")
    await settle(times.shellRunMs * 2)
    expect(describer.digests).toHaveLength(2)
    expect(describer.digests[1]).toMatchObject({ kind: "shell", command: null })
  })

  it("still describes the prompt after a long run when a brief program holds the foreground the moment it ends", async () => {
    // The sample right after the run finds the shell caught between processes, not at its
    // prompt; the next finds the prompt, with too short a stay behind it.
    const { murmur, describer, change, times } = create({ agent: null })
    change({ program: { name: "sh", argv: ["sh", "-c", "sleep 3"] }, atPrompt: false })
    murmur.sampled("a")
    await settle(times.shellRunMs + 10)
    expect(describer.digests).toHaveLength(1)
    await settle(times.shellRunMs)
    change({ program: { name: "bash", argv: [] }, atPrompt: false })
    murmur.sampled("a")
    await settle(10)
    change({ program: { name: "bash", argv: null }, atPrompt: true })
    murmur.sampled("a")
    await settle(times.shellRunMs * 2)
    expect(describer.digests).toHaveLength(2)
    expect(describer.digests[1]).toMatchObject({ kind: "shell", command: null })
  })

  it("describes the prompt after a long run while the run's own description is still in flight", async () => {
    const { murmur, describer, change, times } = create({ agent: null })
    describer.hold = true
    change({ program: { name: "sleep", argv: ["sleep", "30"] }, atPrompt: false })
    murmur.sampled("a")
    await settle(times.shellRunMs + 10)
    expect(describer.jobs).toHaveLength(1)
    // The prompt returns with the first job still held: the newer one is queued, not lost.
    change({ program: { name: "bash", argv: null }, atPrompt: true })
    murmur.sampled("a")
    await settle(times.shellSettleMs + 10)
    expect(describer.jobs).toHaveLength(2)
    expect(describer.jobs[0]!.signal?.aborted).toBe(true)
    expect(describer.digests[1]).toMatchObject({ command: null })
  })

  it("still describes a directory change that a short command followed", async () => {
    const { murmur, describer, change, times } = create({ agent: null })
    murmur.moved("a")
    await settle(times.shellSettleMs / 2)
    change({ program: { name: "git", argv: ["git", "status"] }, atPrompt: false })
    murmur.sampled("a")
    await settle(100)
    change({ program: { name: "bash", argv: null }, atPrompt: true })
    murmur.sampled("a")
    await settle(times.shellRunMs * 2)
    expect(describer.jobs).toHaveLength(1)
    expect(describer.digests[0]).toMatchObject({ kind: "shell", command: null })
  })

  it("is shown a line the terminal wrapped whole", async () => {
    const { murmur, describer, rows, wrapped, times } = create({ agent: null })
    const secret = "9f2c4e7a1b3d5f60718293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d8e"
    rows.current = ["$ cat key.txt", secret.slice(0, 40), secret.slice(40), "$ "]
    wrapped.current = [false, false, true, false]
    murmur.moved("a")
    await settle(times.shellSettleMs + 10)
    expect(describer.digests[0]).toMatchObject({ screen: ["$ cat key.txt", secret, "$"] })
  })

  it("waits for the agent it was opened to run, and describes it as a shell only if none binds", async () => {
    const { murmur, describer, change, times } = create({
      agent: null,
      expecting: "claude",
    })
    murmur.moved("a")
    await settle(times.expectMs - 100)
    expect(describer.jobs).toHaveLength(0)
    // The agent binds: it is no shell, and has no prompt yet to be described by.
    change({ agent: "claude", expecting: null })
    await settle(times.expectMs)
    expect(describer.jobs).toHaveLength(0)

    // Another that never starts is a shell after the wait.
    const other = create({ agent: null, expecting: "claude" })
    other.murmur.moved("a")
    await settle(times.expectMs + 50)
    expect(other.describer.digests).toHaveLength(1)
    expect(other.describer.digests[0]).toMatchObject({ kind: "shell" })
  })

  it("forgets a terminal's job and state when it is restarted", async () => {
    const { murmur, describer, written, times } = create({ agent: null })
    describer.hold = true
    murmur.moved("a")
    await settle(times.shellSettleMs + 10)
    expect(describer.jobs).toHaveLength(1)
    murmur.gone("a")
    expect(describer.jobs[0]!.signal?.aborted).toBe(true)
    describer.jobs[0]!.answer({ title: "Old shell" })
    await settle()
    expect(written).toEqual([])
  })
})

describe("when murmur becomes usable", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("describes the running terminals that have no description yet", async () => {
    const { describer, subjects, written, change } = create({ agent: null })
    subjects.set("b", {
      ...subjects.get("a")!,
      summary: { id: "b", sessionId: "s", cwd: "/w" } as MurmurSubject["summary"],
      agent: "claude",
      work: work(),
      activity: idle("ok"),
    })
    subjects.set("c", {
      ...subjects.get("a")!,
      summary: { id: "c", sessionId: "s", cwd: "/w" } as MurmurSubject["summary"],
      agent: "claude",
      work: null,
    })
    subjects.set("d", {
      ...subjects.get("a")!,
      summary: { id: "d", sessionId: "s", cwd: "/w" } as MurmurSubject["summary"],
      agent: "codex",
      work: work(),
      naming: { person: null, agent: null, murmur: { title: "Had one" }, summary: null },
    })
    change({ program: { name: "bash", argv: null } })
    describer.setUsable(false)
    describer.setUsable(true)
    await settle(300)
    // The shell and the agent with a prompt; not the one with no prompt yet, nor the described.
    expect(describer.digests.map((digest) => digest.kind).toSorted()).toEqual(["agent", "shell"])
    expect(written).toHaveLength(2)
  })

  it("titles an agent that has no title from its first substantial prompt, not a summary left from before", async () => {
    const { describer, subjects, change } = create({ agent: null })
    const agent = (id: string, fields: Partial<MurmurSubject>) =>
      subjects.set(id, {
        ...subjects.get("a")!,
        summary: { id, sessionId: "s", cwd: "/w" } as MurmurSubject["summary"],
        agent: "claude",
        activity: idle("ok"),
        ...fields,
      })
    agent("b", { work: work({ first: "hey!", recent: ["hey!"] }) })
    agent("c", {
      work: work({ first: "hey!", recent: ["hey!"] }),
      naming: { ...unnamed, summary: "Fixes the build." },
    })
    agent("d", { work: work() })
    change({ agent: null, program: { name: "bash", argv: null } })
    describer.setUsable(false)
    describer.setUsable(true)
    await settle(300)
    const agents = describer.digests.filter((digest) => digest.kind === "agent")
    // The terse one waits for a substantial prompt; a summary left from before a restart is
    // no mission (its session is unknown), so only the one with a prompt is titled.
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ summary: null, prompts: ["Fix the login bug"] })
  })

  it("goes on to the other terminals when one cannot be looked at", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const { describer, subjects } = create({ agent: null })
    describer.setUsable(false)
    const broken = {
      ...subjects.get("a")!,
      summary: { id: "x", sessionId: "s", cwd: "/w" } as MurmurSubject["summary"],
      agent: "claude",
      get naming(): MurmurSubject["naming"] {
        throw new Error("unreadable")
      },
    } as MurmurSubject
    subjects.set("x", broken)
    subjects.set("b", {
      ...subjects.get("a")!,
      summary: { id: "b", sessionId: "s", cwd: "/w" } as MurmurSubject["summary"],
      agent: "claude",
      activity: idle("ok"),
      work: work(),
    })
    describer.setUsable(true)
    await settle(300)
    expect(error).toHaveBeenCalled()
    expect(describer.digests.filter((digest) => digest.kind === "agent")).toHaveLength(1)
    error.mockRestore()
  })

  it("asks nothing while murmur is unusable, and nothing once stopped", async () => {
    const { murmur, describer } = create({ work: work(), activity: idle("ok") })
    describer.setUsable(false)
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(describer.jobs).toHaveLength(0)
    murmur.stop()
    describer.setUsable(true)
    await settle(1_000)
    expect(describer.jobs).toHaveLength(0)
  })
})

describe("when a session or a summary comes while murmur is unusable", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const titled = { ...unnamed, murmur: { title: "Old title" } }

  it("keeps a new session owed, and retitles for it once murmur is usable", async () => {
    const { murmur, describer } = create(
      { work: work(), activity: idle("ok"), naming: titled },
      new FakeDescriber({ usable: false }),
    )
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(describer.jobs).toHaveLength(0)
    describer.setUsable(true)
    await settle(300)
    expect(describer.jobs).toHaveLength(1)
  })

  it("keeps a summary owed, and retitles for it once murmur is usable", async () => {
    const { murmur, describer, change } = create(
      { work: work(), activity: idle("ok"), naming: titled },
      new FakeDescriber({ usable: false }),
    )
    change({ naming: { ...titled, summary: "Fixes login." } })
    murmur.summarized("a")
    await settle()
    expect(describer.jobs).toHaveLength(0)
    describer.setUsable(true)
    await settle(300)
    expect(describer.digests).toHaveLength(1)
    expect(describer.digests[0]).toMatchObject({ summary: "Fixes login." })
  })
})

describe("when the person turns murmur off or removes it", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("clears the titles and drops what waited, then catches the terminal up once murmur returns", async () => {
    const { murmur, describer, clears, subjects } = create({
      work: work(),
      activity: idle("ok"),
      naming: { ...unnamed, murmur: { title: "Old title" } },
    })
    // A retitle for a new session waits out its quiet when murmur is cleared.
    murmur.reported("a", report({ session: true }))
    describer.clear()
    await settle(1_000)
    expect(clears.count).toBe(1)
    expect(describer.jobs).toHaveLength(0)
    expect(subjects.get("a")!.naming.murmur).toBeNull()
    // Back on, it is titled afresh by catch-up, once, and nothing else was owed.
    describer.setUsable(true)
    await settle(1_000)
    expect(describer.jobs).toHaveLength(1)
    expect(subjects.get("a")!.naming.murmur).toEqual({ title: "Title 1" })
  })

  // `fireCleared` leaves murmur usable, so what clearing itself drops shows apart from what
  // becoming unusable drops.
  it("drops a request waiting for its quiet, and aborts a job running", async () => {
    const waiting = create({ work: work(), activity: idle("ok") })
    waiting.murmur.reported("a", report({ session: true }))
    waiting.describer.fireCleared()
    await settle(1_000)
    expect(waiting.describer.jobs).toHaveLength(0)

    const running = create({ work: work(), activity: idle("ok") })
    running.describer.hold = true
    running.murmur.reported("a", report({ session: true }))
    await settle()
    expect(running.describer.jobs).toHaveLength(1)
    running.describer.fireCleared()
    expect(running.describer.jobs[0]!.signal?.aborted).toBe(true)
  })

  it("forgets the mission it asked for, so a titled terminal is titled afresh", async () => {
    const { murmur, describer, subjects } = create({ work: work(), activity: idle("ok") })
    murmur.reported("a", report({ session: true }))
    await settle()
    expect(subjects.get("a")!.naming.murmur).toEqual({ title: "Title 1" })
    describer.fireCleared()
    expect(subjects.get("a")!.naming.murmur).toBeNull()
    murmur.reported("a", report())
    await settle()
    expect(describer.jobs).toHaveLength(2)
  })

  it("forgets a retry it was waiting for, to ask at the next report instead", async () => {
    const { murmur, describer } = create(
      { work: work(), activity: idle("ok") },
      new FakeDescriber({ reply: (_digest, call) => (call === 1 ? undefined : { title: "Back" }) }),
    )
    murmur.reported("a", report({ session: true }))
    await settle()
    // It did not run: owed again, after a minute.
    expect(describer.jobs).toHaveLength(1)
    describer.fireCleared()
    murmur.reported("a", report())
    await settle()
    expect(describer.jobs).toHaveLength(2)
  })

  it("forgets a shell's description owed, so a brief program's end asks nothing", async () => {
    const { murmur, describer, change } = create({ agent: null })
    change({ program: { name: "node", argv: ["node", "dev.js"] } })
    murmur.sampled("a")
    murmur.moved("a")
    describer.fireCleared()
    await settle(10)
    change({ program: { name: "bash", argv: null } })
    murmur.sampled("a")
    await settle(1_000)
    expect(describer.jobs).toHaveLength(0)
  })

  it("does not clear on close, a failed check or losing the GPU (only usability changes)", async () => {
    const { murmur, describer, clears } = create({ work: work(), activity: idle("ok") })
    describer.setUsable(false)
    expect(clears.count).toBe(0)
    murmur.stop()
    describer.clear()
    expect(clears.count).toBe(0)
  })
})

const request = (fields: Partial<Request> = {}): Request => ({
  requestId: "r1",
  actor: null,
  toolName: "AskUserQuestion",
  kind: "question",
  subject: "Which database should it use?",
  choices: ["Postgres", "SQLite"],
  askedAt: 10,
  ...fields,
})
const asking = (requests: readonly Request[], fields: Partial<Activity> = {}): Activity => ({
  ...started(0),
  state: "working",
  pending: requests,
  ...fields,
})
const ended = (at = 20, outcome: "completed" | "failed" = "completed"): Activity => ({
  ...started(0),
  lastTurn: { outcome, reply: null, at, recorded: false },
})
const planned = (source: string): Partial<Activity> => ({
  plans: [{ actor: null, source: { kind: "text", text: source, truncated: false }, at: 1 }],
})
const real = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))
const pending = (subjects: ReturnType<typeof create>["subjects"]) =>
  subjects.get("a")!.activity!.pending

describe("murmur's headlines and gists", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe("of a question or plan", () => {
    it("asks once for a question, with its answers, and puts the headline on the request", async () => {
      const { murmur, describer, subjects, change, headlined } = create({
        activity: asking([request()]),
      })
      murmur.changed("a")
      murmur.changed("a")
      await settle()
      expect(describer.notes.map(({ digest, terminal }) => [digest, terminal])).toEqual([
        [
          {
            kind: "question",
            question: "Which database should it use?",
            choices: ["Postgres", "SQLite"],
          },
          "a",
        ],
      ])
      expect(headlined).toEqual(["Headline 1"])
      expect(pending(subjects)[0]!.headline).toBe("Headline 1")
      // Told again, with the headline there, nothing is asked.
      change({ activity: subjects.get("a")!.activity })
      murmur.changed("a")
      await settle()
      expect(describer.notes).toHaveLength(1)
      // Titles are not asked for by it.
      expect(describer.jobs).toHaveLength(0)
    })

    it("asks nothing for a permission, a question with no subject, or a terminal with no agent", async () => {
      const { murmur, describer, change } = create({
        activity: asking([
          request({ kind: "permission" }),
          request({ requestId: "r2", subject: null }),
        ]),
      })
      murmur.changed("a")
      await settle()
      change({ agent: null, activity: asking([request()]) })
      murmur.changed("a")
      await settle()
      expect(describer.notes).toHaveLength(0)
    })

    it("gives each waiting question its own job", async () => {
      const { murmur, describer, subjects } = create({
        activity: asking([request(), request({ requestId: "r2", askedAt: 11 })]),
      })
      murmur.changed("a")
      await settle()
      expect(describer.notes).toHaveLength(2)
      expect(pending(subjects).map(({ headline }) => headline)).toEqual([
        "Headline 1",
        "Headline 2",
      ])
    })

    it("calls the job off when the request is answered, and drops its late answer", async () => {
      const { murmur, describer, subjects, change, headlined } = create({
        activity: asking([request()]),
      })
      describer.hold = true
      murmur.changed("a")
      await settle()
      expect(describer.notes).toHaveLength(1)
      change({ activity: asking([]) })
      murmur.changed("a")
      expect(describer.notes[0]!.signal?.aborted).toBe(true)
      describer.notes[0]!.answer({ kind: "headline", text: "Late" })
      await settle()
      expect(headlined).toEqual([])
      expect(subjects.get("a")!.activity!.pending).toEqual([])
    })

    it("asks again for a revised plan, whose old headline and job are gone", async () => {
      const first = request({ kind: "plan", requestId: "p", toolName: "ExitPlanMode" })
      const { murmur, describer, subjects, change, headlined } = create({
        activity: asking([first], planned("# Plan\nSplit the billing service")),
      })
      describer.hold = true
      murmur.changed("a")
      await settle()
      expect(describer.notes[0]!.digest).toEqual({
        kind: "plan",
        plan: "# Plan\nSplit the billing service",
      })
      change({
        activity: asking([{ ...first, askedAt: 30 }], planned("# Plan\nMerge the services")),
      })
      murmur.changed("a")
      await settle()
      expect(describer.notes[0]!.signal?.aborted).toBe(true)
      expect(describer.notes).toHaveLength(2)
      expect(describer.notes[1]!.digest).toMatchObject({ plan: "# Plan\nMerge the services" })
      describer.notes[0]!.answer({ kind: "headline", text: "Stale" })
      describer.notes[1]!.answer({ kind: "headline", text: "Plan to merge services" })
      await settle()
      expect(headlined).toEqual(["Plan to merge services"])
      expect(pending(subjects)[0]!.headline).toBe("Plan to merge services")
    })

    it("reads a plan from its file, the first 16 KiB", async () => {
      const path = "/plans/billing.md"
      const { murmur, describer, files } = create({
        activity: asking([request({ kind: "plan", requestId: "p" })], {
          plans: [{ actor: null, source: { kind: "file", path }, at: 1 }],
        }),
      })
      files.set(path, "x".repeat(20_000))
      murmur.changed("a")
      await settle()
      expect(describer.notes).toHaveLength(1)
      expect((describer.notes[0]!.digest as { plan: string }).plan).toHaveLength(16 * 1024)
    })

    it("uses the plan of the actor that asked, not another's", async () => {
      const { murmur, describer } = create({
        activity: asking([request({ kind: "plan", requestId: "p", actor: "sub" })], {
          plans: [
            { actor: null, source: { kind: "text", text: "root plan", truncated: false }, at: 1 },
            { actor: "sub", source: { kind: "text", text: "sub plan", truncated: false }, at: 2 },
          ],
        }),
      })
      murmur.changed("a")
      await settle()
      expect(describer.notes[0]!.digest).toEqual({ kind: "plan", plan: "sub plan" })
    })

    it("keeps a refusal final, and asks again after a job that did not run", async () => {
      const refused = create(
        { activity: asking([request()]) },
        new FakeDescriber({ note: () => null }),
      )
      refused.murmur.changed("a")
      await settle()
      refused.murmur.changed("a")
      await settle()
      expect(refused.describer.notes).toHaveLength(1)

      // A job that did not run is asked for again after a while, with no other change.
      const skipped = create(
        { activity: asking([request()]) },
        new FakeDescriber({
          note: (_digest, call) =>
            call === 1 ? undefined : { kind: "headline", text: "Asks which one" },
        }),
      )
      skipped.murmur.changed("a")
      await settle()
      expect(skipped.headlined).toEqual([])
      await settle(61_000)
      expect(skipped.headlined).toEqual(["Asks which one"])
    })

    it("asks once for a plan it can't read, until the request changes", async () => {
      const path = "/plans/gone.md"
      const plan = request({ kind: "plan", requestId: "p" })
      const fields = { plans: [{ actor: null, source: { kind: "file" as const, path }, at: 1 }] }
      const { murmur, describer, heads, change } = create({ activity: asking([plan], fields) })
      for (let i = 0; i < 3; i++) {
        murmur.changed("a")
        // eslint-disable-next-line no-await-in-loop -- Each change waits out its quiet.
        await settle()
      }
      expect(heads).toEqual([path])
      change({ activity: asking([{ ...plan, askedAt: 30 }], fields) })
      murmur.changed("a")
      await settle()
      expect(heads).toEqual([path, path])
      expect(describer.notes).toHaveLength(0)
    })

    it("drops a plan whose request was answered while its file was read", async () => {
      const path = "/plans/billing.md"
      const { murmur, describer, change, hooks } = create({
        activity: asking([request({ kind: "plan", requestId: "p" })], {
          plans: [{ actor: null, source: { kind: "file", path }, at: 1 }],
        }),
      })
      const gate = { read: (_text: string) => {} }
      hooks.head = new Promise((resolve) => (gate.read = resolve))
      murmur.changed("a")
      await settle()
      change({ activity: asking([]) })
      gate.read("# Plan")
      await settle()
      expect(describer.notes).toHaveLength(0)
    })

    it("asks nothing while murmur is unusable, until it is usable again", async () => {
      const { murmur, describer, headlined } = create(
        { activity: asking([request()]) },
        new FakeDescriber({ usable: false }),
      )
      murmur.changed("a")
      await settle()
      expect(describer.notes).toHaveLength(0)
      describer.setUsable(true)
      await settle()
      expect(headlined).toEqual(["Headline 1"])
    })
  })

  describe("of a reply", () => {
    let directory: string
    // Transcripts are read from disk, which fake timers don't wait for.
    beforeEach(() => {
      vi.useRealTimers()
      directory = mkdtempSync(join(tmpdir(), "novadeck-gist-"))
    })
    afterEach(() => rmSync(directory, { recursive: true, force: true }))

    const written = (...lines: string[]) => {
      const path = join(directory, "t.jsonl")
      writeFileSync(path, lines.join("\n"))
      return path
    }

    it("asks once for the reply that ended the turn at `at`, and puts the gist on it", async () => {
      const transcript = written("user:text:fix it", "assistant:text:Fixed the rounding bug.")
      const { murmur, describer, subjects, gisted } = create({ activity: ended(20), transcript })
      murmur.replied("a", 20)
      murmur.replied("a", 20)
      await real()
      expect(describer.notes.map(({ digest }) => digest)).toEqual([
        { kind: "reply", reply: "Fixed the rounding bug.", failed: false },
      ])
      expect(gisted).toEqual(["Gist 1"])
      expect(subjects.get("a")!.activity!.lastTurn!.gist).toEqual({ text: "Gist 1", asks: false })
      // Shown unread again: it has a gist already.
      murmur.replied("a", 20)
      await real()
      expect(describer.notes).toHaveLength(1)
    })

    it("tells a failed turn, and cuts a long reply to its head and tail", async () => {
      const long = `${"a".repeat(5000)}${"z".repeat(5000)}`
      const transcript = written(`assistant:text:${long}`)
      const { murmur, describer } = create({ activity: ended(20, "failed"), transcript })
      murmur.replied("a", 20)
      await real()
      const digest = describer.notes[0]!.digest as { reply: string; failed: boolean }
      expect(digest.failed).toBe(true)
      expect(digest.reply).toBe(`${"a".repeat(4000)}\n…\n${"z".repeat(4000)}`)
    })

    it("ignores an end that is not the last, an interrupted one, a running turn and an unreadable reply", async () => {
      const transcript = written("assistant:text:Done.")
      const { murmur, describer, change } = create({ activity: ended(20), transcript })
      murmur.replied("a", 19)
      change({
        activity: { ...ended(20), lastTurn: { ...ended(20).lastTurn!, outcome: "interrupted" } },
      })
      murmur.replied("a", 20)
      change({ activity: asking([]) })
      murmur.replied("a", 20)
      change({ activity: ended(20), transcript: null })
      murmur.replied("a", 20)
      murmur.replied("nobody", 20)
      await real()
      expect(describer.notes).toHaveLength(0)
    })

    it("is called off by a new turn, and drops a late gist for an end no longer the last", async () => {
      const transcript = written("assistant:text:Done.")
      const { murmur, describer, change, gisted } = create({ activity: ended(20), transcript })
      describer.hold = true
      murmur.replied("a", 20)
      await real()
      expect(describer.notes).toHaveLength(1)
      change({ activity: asking([]) })
      murmur.changed("a")
      expect(describer.notes[0]!.signal?.aborted).toBe(true)
      describer.notes[0]!.answer({ kind: "gist", text: "Late", asks: false })
      change({ activity: ended(40) })
      await real()
      expect(gisted).toEqual([])
    })

    it("asks for the gist again when murmur becomes usable, after a job that did not run", async () => {
      const transcript = written("assistant:text:Done.")
      const skipped = create(
        { activity: ended(20), transcript },
        new FakeDescriber({
          note: (_digest, call) =>
            call === 1 ? undefined : { kind: "gist", text: "Did it", asks: false },
        }),
      )
      skipped.murmur.replied("a", 20)
      await real()
      skipped.describer.setUsable(false)
      skipped.describer.setUsable(true)
      await real()
      expect(skipped.gisted).toEqual(["Did it"])
    })

    it("drops a reply whose end stopped being the last while its transcript was read", async () => {
      const transcript = written("assistant:text:Done.")
      const { murmur, describer, change, hooks } = create({ activity: ended(20), transcript })
      hooks.items = () => change({ activity: asking([]) })
      murmur.replied("a", 20)
      await real()
      expect(describer.notes).toHaveLength(0)
    })

    it("is ignored while murmur is unusable, and not remembered", async () => {
      const transcript = written("assistant:text:Done.")
      const { murmur, describer, gisted } = create(
        { activity: ended(20), transcript },
        new FakeDescriber({ usable: false }),
      )
      murmur.replied("a", 20)
      describer.setUsable(true)
      await real()
      expect(describer.notes).toHaveLength(0)
      murmur.replied("a", 20)
      await real()
      expect(gisted).toEqual(["Gist 1"])
    })

    it("keeps a gist that did not run for the catch-up when murmur is unusable as it is due", async () => {
      const transcript = written("assistant:text:Done.")
      const { murmur, describer, gisted } = create(
        { activity: ended(20), transcript },
        new FakeDescriber({
          note: (_digest, call) =>
            call === 1 ? undefined : { kind: "gist", text: "Did it", asks: false },
        }),
        { retryMs: 150 },
      )
      murmur.replied("a", 20)
      await real()
      describer.setUsable(false)
      // Its retry comes and goes while murmur can't run.
      await real(500)
      expect(gisted).toEqual([])
      describer.setUsable(true)
      await real()
      expect(gisted).toEqual(["Did it"])
    })

    it("asks again after a job that did not run, and not after a refusal", async () => {
      const transcript = written("assistant:text:Done.")
      const skipped = create(
        { activity: ended(20), transcript },
        new FakeDescriber({
          note: (_digest, call) =>
            call === 1 ? undefined : { kind: "gist", text: "Did it", asks: true },
        }),
        { retryMs: 150 },
      )
      // Shown unread once: the same end is asked for again after a while on its own.
      skipped.murmur.replied("a", 20)
      await real()
      expect(skipped.gisted).toEqual([])
      await real(500)
      expect(skipped.gisted).toEqual(["Did it"])

      const refused = create(
        { activity: ended(20), transcript },
        new FakeDescriber({ note: () => null }),
      )
      refused.murmur.replied("a", 20)
      await real()
      refused.murmur.replied("a", 20)
      await real()
      expect(refused.describer.notes).toHaveLength(1)
    })
  })

  describe("across murmur's life", () => {
    it("asks again when murmur becomes usable, for a question and a remembered gist", async () => {
      vi.useRealTimers()
      const directory = mkdtempSync(join(tmpdir(), "novadeck-gist-"))
      try {
        const transcript = join(directory, "t.jsonl")
        writeFileSync(transcript, "assistant:text:Done.")
        const done = create({ activity: ended(20), transcript })
        done.describer.hold = true
        done.murmur.replied("a", 20)
        await real()
        expect(done.describer.notes).toHaveLength(1)
        done.describer.setUsable(false)
        expect(done.describer.notes[0]!.signal?.aborted).toBe(true)
        done.describer.setUsable(true)
        await real()
        expect(done.describer.notes).toHaveLength(2)

        const asked = create({ activity: asking([request()]) })
        asked.describer.setUsable(false)
        asked.murmur.changed("a")
        asked.describer.setUsable(true)
        await real()
        expect(asked.headlined).toEqual(["Headline 1"])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    it("stops its jobs and forgets what it asked when murmur is turned off", async () => {
      const { murmur, describer, headlined } = create({ activity: asking([request()]) })
      describer.hold = true
      murmur.changed("a")
      await settle()
      describer.fireCleared()
      expect(describer.notes[0]!.signal?.aborted).toBe(true)
      describer.hold = false
      murmur.changed("a")
      await settle()
      expect(describer.notes).toHaveLength(2)
      expect(headlined).toEqual(["Headline 2"])
    })

    it("cancels a terminal's jobs when it is gone, and all of them on stop", async () => {
      const { murmur, describer } = create({ activity: asking([request()]) })
      describer.hold = true
      murmur.changed("a")
      await settle()
      murmur.gone("a")
      expect(describer.notes[0]!.signal?.aborted).toBe(true)

      const other = create({ activity: asking([request()]) })
      other.describer.hold = true
      other.murmur.changed("a")
      await settle()
      other.murmur.stop()
      expect(other.describer.notes[0]!.signal?.aborted).toBe(true)
    })
  })
})
