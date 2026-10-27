import { createScreen, readScreen } from "@novadeck/emulator/headless"
import { afterEach, beforeEach, vi } from "vitest"

import type { Description, Digest, ShellDigest } from "../murmur/describer.js"
import { redactDigest } from "../murmur/redact.js"
import { describe, expect, it } from "../test.js"
import { FakeDescriber } from "../testing/describer.js"
import {
  commandOf,
  Descriptions,
  Murmur,
  screenLines,
  screenOf,
  screenRows,
  shellDigest,
  type MurmurHost,
  type MurmurTimes,
  type MurmurSubject,
} from "./murmur.js"
import { unnamed } from "./naming.js"
import { freshWork, type Work } from "./work.js"

const work = (fields: Partial<Work> = {}): Work => ({
  ...freshWork("claude:s1"),
  first: "Fix the login bug",
  latest: "Fix the login bug",
  ...fields,
})

// The summary of the terminal `create` makes, to change one field of in a test.
const subjectSummary = () =>
  ({
    id: "a",
    sessionId: "s",
    cwd: "/home/me/shop",
    process: null,
  }) as MurmurSubject["summary"]

describe("the digest of a plain shell", () => {
  it("tells where the last command's line is in the screen it shows", () => {
    // Wrapped rows are one line, and the blank rows above the first text are dropped.
    const rows = [
      "",
      "",
      "$ first",
      "out",
      "$ a very long command",
      " that wrapped",
      "result",
      "$ ",
    ]
    const wrapped = [false, false, false, false, false, true, false, false]
    expect(screenLines(rows, wrapped, [], 5)).toMatchObject({
      screen: ["$ first", "out", "$ a very long command that wrapped", "result", "$"],
      at: 2,
    })
    expect(screenLines(rows, wrapped, [], 4).at).toBe(2)
    expect(screenLines(rows, wrapped, [], 2).at).toBe(0)
    // On a blank row above the text, or below the last, or none given: no line.
    expect(screenLines(rows, wrapped, [], 0).at).toBeUndefined()
    expect(screenLines([...rows, ""], [...wrapped, false], [], 8).at).toBeUndefined()
    expect(screenLines(rows, wrapped).at).toBeUndefined()
  })

  it("tells no line for a command above the last rows it keeps", () => {
    const rows = Array.from({ length: screenRows + 5 }, (_, index) => `line ${index}`)
    expect(screenLines(rows, [], [], 2).at).toBeUndefined()
    expect(screenLines(rows, [], [], 5).at).toBe(0)
    expect(screenLines(rows, [], [], rows.length - 1).at).toBe(screenRows - 1)
  })

  it("puts the command's line in the digest as commandAt, and none on a full-screen program", () => {
    const input = {
      projectFolder: undefined,
      command: null,
      rows: ["$ echo a", "a", "$ printf x", "x", "$ "],
    }
    expect(shellDigest({ ...input, commandRow: 2 })).toMatchObject({ commandAt: 2 })
    expect(shellDigest(input)).not.toHaveProperty("commandAt")
    expect(
      shellDigest({ ...input, commandRow: 2, alternate: true, command: "vim" }),
    ).not.toHaveProperty("commandAt")
  })

  it("is the command, the project and the visible rows, trimmed", () => {
    expect(
      shellDigest({
        projectFolder: "/home/me/shop",
        command: "pnpm dev",
        rows: ["", "  vite ready  ", "", "$ ", "", ""],
      }),
    ).toEqual({
      kind: "shell",
      project: "shop",
      command: "pnpm dev",
      screen: ["vite ready", "", "$"],
    })
  })

  it("has nothing to say of a bare prompt, with no program, but of a program with no output", () => {
    const bare = { projectFolder: undefined }
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
        command: null,
        rows,
        rowContinues: filled,
      }),
    ).toMatchObject({ continues: [false, true, false, false] })
  })

  it("keeps a secret drawn across rows with cursor moves out of the model's sight, once redaction reads the line's end", async () => {
    const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a09"
    const terminal = createScreen({ cols: 40, rows: 8, scrollback: 1000 })
    const drawn = ["$ cat key", hex.slice(0, 40), hex.slice(40), "$ "]
      .map((row, index) => `\u001b[${index + 1};1H${row}`)
      .join("")
    await new Promise<void>((resolve) => terminal.write(`\u001b[2J${drawn}`, resolve))
    const text = readScreen(terminal)
    const digest = shellDigest({
      projectFolder: undefined,
      command: null,
      rows: text.rows,
      ...(text.wrapped && { wrapped: text.wrapped }),
      ...(text.continues && { rowContinues: text.continues }),
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
    command: "a",
    screen: [],
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
    program: null,
    atPrompt: true,
    expecting: null,
    ...initial,
  }
  const subjects = new Map<string, MurmurSubject>([["a", base]])
  const rows: { current: readonly string[] } = { current: ["$ ls", "a b", "$ "] }
  const wrapped: { current: readonly boolean[] | undefined } = { current: undefined }
  const alternate = { current: false }
  const commandRow: { current: number | undefined } = { current: undefined }
  // The terminals are there only once murmur is built, as when the runner starts.
  let ready = false
  const reads = { screens: 0 }
  const written: { readonly title: string }[] = []
  const clears = { count: 0 }
  const host: MurmurHost = {
    subject: (id) => subjects.get(id),
    subjects: () => (ready ? [...subjects.values()] : []),
    screen: () => {
      reads.screens += 1
      return Promise.resolve({
        rows: rows.current,
        alternate: alternate.current,
        ...(commandRow.current !== undefined && { commandRow: commandRow.current }),
        ...(wrapped.current && { wrapped: wrapped.current }),
      })
    },
    projectFolder: () => "/home/me/shop",
    described: (id, description) => {
      written.push(description)
      const subject = subjects.get(id)
      if (subject)
        subjects.set(id, { ...subject, naming: { ...subject.naming, murmur: description } })
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
    expectMs: 1_000,
    retryMs: 60_000,
    ...more,
  }
  const murmur = new Murmur(describer, host, times)
  ready = true
  return {
    murmur,
    describer,
    subjects,
    rows,
    wrapped,
    alternate,
    commandRow,
    reads,
    written,
    clears,
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
// The agent of terminal "a" wrote `said` as its summary, and murmur is told so.
const summarize = (made: ReturnType<typeof create>, said: string) => {
  made.change({ naming: { ...made.subjects.get("a")!.naming, summary: said } })
  made.murmur.summarized("a")
}

// A turn that has ended at `at`, as the activity tells it.
const finished = (at: number, reply: string | null = "Done.") =>
  ({
    state: "idle",
    pending: [],
    plans: [],
    lastTurn: { reply, at, outcome: "completed", recorded: false },
  }) as unknown as MurmurSubject["activity"]

describe("when an agent's terminal is named", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const summary = "Task addons-off-default: the Addons switch shows off until installed."

  it("names it from its agent's summary alone, once its quiet passes", async () => {
    const made = create({ work: work(), activity: idle("ok") })
    summarize(made, summary)
    await settle(made.times.settleMs - 10)
    expect(made.describer.jobs).toHaveLength(0)
    await settle(20)
    expect(made.describer.digests).toEqual([{ kind: "agent", project: "shop", summary }])
    expect(made.written).toEqual([{ title: "Title 1" }])
  })

  it("makes one title of a burst of summaries, from the latest", async () => {
    const made = create({ work: work(), activity: idle("ok") })
    summarize(made, "Fixes the login cookie.")
    await settle(10)
    summarize(made, summary)
    await settle()
    expect(made.describer.digests).toEqual([{ kind: "agent", project: "shop", summary }])
  })

  it("is never named by the person's prompts, turn ends or reports", async () => {
    const made = create({ work: work(), activity: working() })
    made.murmur.reported("a")
    made.change({ activity: finished(10) })
    made.change({ work: work({ latest: "Run a critic pass on the PR" }), activity: finished(20) })
    made.murmur.reported("a")
    await settle(10 * made.times.retryMs)
    expect(made.describer.jobs).toHaveLength(0)
  })

  it("names nothing for the same summary again, and again for a new one", async () => {
    const made = create({ work: work(), activity: idle("ok") })
    summarize(made, summary)
    await settle()
    // The same words, spaced and cased otherwise, as the agent's nudges bring them.
    summarize(made, `  ${summary.toUpperCase()} `)
    await settle()
    expect(made.describer.jobs).toHaveLength(1)
    summarize(made, "Builds the PDF export for invoices.")
    await settle()
    expect(made.describer.jobs).toHaveLength(2)
  })

  it("keeps the name when the new title shares a word with it, and replaces it when none", async () => {
    const titles = ["Addons off by default", "Addons switch", "Invoice export"]
    const made = create(
      { work: work(), activity: idle("ok") },
      new FakeDescriber({ reply: (_digest, call) => ({ title: titles[call - 1]! }) }),
    )
    summarize(made, summary)
    await settle()
    summarize(made, "Addons switch stays off until voice input is installed.")
    await settle()
    summarize(made, "Builds the PDF export for invoices.")
    await settle()
    expect(made.written).toEqual([{ title: "Addons off by default" }, { title: "Invoice export" }])
  })

  it("weighs its opening agent's title as the name, but not a title it had as a plain shell", async () => {
    const opened = create(
      {
        work: work(),
        activity: idle("ok"),
        naming: { ...unnamed, opener: { title: "Addons" } },
      },
      new FakeDescriber({ reply: () => ({ title: "Addons switch" }) }),
    )
    summarize(opened, summary)
    await settle()
    expect(opened.written).toEqual([])

    const shell = create(
      { agent: null, program: { name: "bash", argv: null } },
      new FakeDescriber({ reply: () => ({ title: "Addons switch" }) }),
    )
    shell.rows.current = ["$ ls addons", "switch.ts", "$ "]
    shell.murmur.prompted("a")
    await settle(shell.times.shellSettleMs + 50)
    expect(shell.written).toEqual([{ title: "Addons switch" }])
    shell.change({ agent: "claude" })
    summarize(shell, summary)
    await settle()
    expect(shell.written).toEqual([{ title: "Addons switch" }, { title: "Addons switch" }])
  })

  it("replaces a shell's title, which shows over its opener's, though the opener's shares a word", async () => {
    const made = create(
      {
        agent: null,
        program: { name: "bash", argv: null },
        naming: { ...unnamed, opener: { title: "Login fix" } },
      },
      new FakeDescriber({
        reply: (digest) => ({ title: digest.kind === "shell" ? "Git history" : "Login redirect" }),
      }),
    )
    made.rows.current = ["$ git log", "abc123 Fix login", "$ "]
    made.murmur.prompted("a")
    await settle(made.times.shellSettleMs + 50)
    made.change({ agent: "claude" })
    summarize(made, "Fixes the login redirect.")
    await settle()
    expect(made.written).toEqual([{ title: "Git history" }, { title: "Login redirect" }])
  })

  it("still owes a summary that came while the one before it was named", async () => {
    const made = create(
      { work: work(), activity: idle("ok") },
      new FakeDescriber({
        reply: (_digest, call) => (call === 2 ? undefined : { title: `T${call}` }),
      }),
    )
    made.describer.hold = true
    summarize(made, summary)
    await settle()
    // A newer summary waits out its quiet while the first one's job runs.
    summarize(made, "Builds the PDF export for invoices.")
    made.describer.hold = false
    made.describer.jobs[0]!.answer({ title: "Addons off by default" })
    await settle()
    // The newer one's job did not run: it is asked again after a minute.
    expect(made.describer.jobs).toHaveLength(2)
    await settle(made.times.retryMs)
    await settle()
    expect(made.describer.digests.at(-1)).toMatchObject({
      summary: "Builds the PDF export for invoices.",
    })
    expect(made.written.at(-1)).toEqual({ title: "T3" })
  })

  it("owes nothing for a summary whose agent left before its title was asked", async () => {
    const made = create({ work: work(), activity: idle("ok") })
    summarize(made, summary)
    made.change({ agent: null })
    await settle()
    // A new agent in the terminal, once murmur is usable again, is not named from it.
    made.change({
      agent: "codex",
      naming: { ...made.subjects.get("a")!.naming, murmur: { title: "Kept" } },
    })
    made.describer.setUsable(false)
    made.describer.setUsable(true)
    await settle(300)
    expect(made.describer.jobs).toHaveLength(0)
  })

  it("leaves a shell's title to an agent's own next summary, not the one left from before", async () => {
    const made = create(
      {
        agent: null,
        program: { name: "bash", argv: null },
        naming: { ...unnamed, summary: "Fixes the login redirect." },
      },
      new FakeDescriber({
        reply: (digest) => ({ title: digest.kind === "shell" ? "Git history" : "Login redirect" }),
      }),
    )
    made.rows.current = ["$ git log", "abc123 Fix login", "$ "]
    made.murmur.prompted("a")
    await settle(made.times.shellSettleMs + 50)
    // A new agent binds and reports: the summary on record is the last agent's.
    made.change({ agent: "claude" })
    made.murmur.reported("a")
    await settle()
    expect(made.written).toEqual([{ title: "Git history" }])
    summarize(made, "Fixes the login redirect again.")
    await settle()
    expect(made.written).toEqual([{ title: "Git history" }, { title: "Login redirect" }])
  })

  it("names a summary written under the person's title once they clear it", async () => {
    const made = create({
      work: work(),
      activity: idle("ok"),
      naming: { ...unnamed, person: "Mine" },
    })
    summarize(made, summary)
    await settle()
    expect(made.describer.jobs).toHaveLength(0)
    made.change({ naming: { ...made.subjects.get("a")!.naming, person: null } })
    made.murmur.summarized("a")
    await settle()
    expect(made.written).toEqual([{ title: "Title 1" }])
  })

  it("drops a title whose agent left or the person titled while the model ran, naming nothing", async () => {
    const left = create({ work: work(), activity: idle("ok") })
    left.describer.hold = true
    summarize(left, summary)
    await settle()
    left.change({ agent: null })
    left.describer.jobs[0]!.answer({ title: "Addons" })
    await settle()
    expect(left.written).toEqual([])

    const titled = create({ work: work(), activity: idle("ok") })
    titled.describer.hold = true
    summarize(titled, summary)
    await settle()
    titled.change({ naming: { ...titled.subjects.get("a")!.naming, person: "Mine" } })
    titled.describer.jobs[0]!.answer({ title: "Addons" })
    await settle()
    // Cleared again, the same summary is named.
    titled.describer.hold = false
    titled.change({ naming: { ...titled.subjects.get("a")!.naming, person: null } })
    titled.murmur.summarized("a")
    await settle()
    expect(titled.written).toEqual([{ title: "Title 2" }])
  })

  it("owes nothing for a summary whose job a shell's request took", async () => {
    const made = create(
      { work: work(), activity: idle("ok"), program: { name: "bash", argv: null } },
      new FakeDescriber({ reply: () => null }),
    )
    summarize(made, summary)
    // The agent leaves within the quiet, and the shell's prompt takes the job.
    made.change({ agent: null })
    made.murmur.prompted("a")
    await settle(made.times.shellSettleMs + 50)
    // A titled terminal, which catch-up names only for a summary still owed.
    made.change({
      agent: "codex",
      naming: { ...made.subjects.get("a")!.naming, murmur: { title: "Kept" } },
    })
    made.describer.setUsable(false)
    made.describer.setUsable(true)
    await settle(300)
    expect(made.describer.digests.filter((digest) => digest.kind === "agent")).toHaveLength(0)
  })

  it("lets a refused title go until the next summary", async () => {
    const made = create(
      { work: work(), activity: idle("ok") },
      new FakeDescriber({ reply: (_digest, call) => (call === 1 ? null : { title: "Back" }) }),
    )
    summarize(made, summary)
    await settle(10 * made.times.retryMs)
    expect(made.describer.jobs).toHaveLength(1)
    summarize(made, "Builds the PDF export for invoices.")
    await settle()
    expect(made.written).toEqual([{ title: "Back" }])
  })

  it("asks again after a minute for a title that did not run, and is dropped with the terminal", async () => {
    const made = create(
      { work: work(), activity: idle("ok") },
      new FakeDescriber({ reply: (_digest, call) => (call === 1 ? undefined : { title: "Back" }) }),
    )
    summarize(made, summary)
    await settle()
    expect(made.describer.jobs).toHaveLength(1)
    await settle(made.times.retryMs)
    await settle()
    expect(made.written).toEqual([{ title: "Back" }])

    const gone = create(
      { work: work(), activity: idle("ok") },
      new FakeDescriber({ reply: () => undefined }),
    )
    summarize(gone, summary)
    await settle()
    gone.murmur.gone("a")
    await settle(10 * gone.times.retryMs)
    expect(gone.describer.jobs).toHaveLength(1)
  })

  it("owes a summary that came while murmur was unusable, or whose job it stopped", async () => {
    const owed = create(
      { work: work(), activity: idle("ok") },
      new FakeDescriber({ usable: false }),
    )
    summarize(owed, summary)
    await settle()
    expect(owed.describer.jobs).toHaveLength(0)
    owed.describer.setUsable(true)
    await settle(300)
    expect(owed.describer.digests).toEqual([{ kind: "agent", project: "shop", summary }])

    const stopped = create({ work: work(), activity: idle("ok") })
    stopped.describer.hold = true
    summarize(stopped, summary)
    await settle()
    stopped.describer.setUsable(false)
    expect(stopped.describer.jobs[0]!.signal?.aborted).toBe(true)
    stopped.describer.hold = false
    stopped.describer.setUsable(true)
    await settle(300)
    expect(stopped.written).toEqual([{ title: "Title 2" }])
  })

  it("never asks for a terminal the person titled, nor names one they titled while it ran", async () => {
    const titled = create({
      work: work(),
      activity: idle("ok"),
      naming: { ...unnamed, person: "Mine" },
    })
    summarize(titled, summary)
    await settle()
    expect(titled.describer.jobs).toHaveLength(0)

    const running = create({ work: work(), activity: idle("ok") })
    running.describer.hold = true
    summarize(running, summary)
    await settle()
    running.change({ naming: { ...running.subjects.get("a")!.naming, person: "Mine" } })
    running.describer.jobs[0]!.answer({ title: "Addons" })
    await settle()
    expect(running.written).toEqual([])
  })

  it("does nothing in a terminal with no agent, and never names one with a title that can't be one", async () => {
    const shell = create({ agent: null })
    summarize(shell, summary)
    await settle()
    expect(shell.describer.jobs).toHaveLength(0)

    const made = create(
      { work: work(), activity: idle("ok") },
      new FakeDescriber({ reply: () => ({ title: "x".repeat(500) }) }),
    )
    summarize(made, summary)
    await settle()
    expect(made.written).toEqual([])
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

  it("describes at every return to the prompt, debounced, so rapid commands make one description", async () => {
    const { murmur, describer, rows, times } = create({ agent: null })
    murmur.prompted("a")
    await settle(times.shellSettleMs - 50)
    rows.current = ["$ tree", "src", "$ "]
    murmur.prompted("a")
    await settle(times.shellSettleMs - 50)
    expect(describer.jobs).toHaveLength(0)
    await settle(100)
    expect(describer.jobs).toHaveLength(1)
    expect(describer.digests[0]).toMatchObject({
      kind: "shell",
      command: null,
      screen: ["$ tree", "src", "$"],
    })
    // A quick command with no program running long enough to be sampled still names it.
    rows.current = ["$ git status", "clean", "$ "]
    murmur.prompted("a")
    await settle(times.shellSettleMs + 50)
    expect(describer.jobs).toHaveLength(2)
  })

  it("describes nothing for a prompt that shows what it last described", async () => {
    const { murmur, describer, rows, change, times } = create({ agent: null })
    murmur.prompted("a")
    await settle(times.shellSettleMs + 50)
    expect(describer.jobs).toHaveLength(1)
    // A command that printed nothing and left the screen as it was.
    murmur.prompted("a")
    await settle(times.shellSettleMs + 50)
    expect(describer.jobs).toHaveLength(1)
    // But a directory changed is something new, whatever the screen shows.
    change({ summary: { ...subjectSummary(), cwd: "/home/me/shop/web" } })
    murmur.prompted("a")
    await settle(times.shellSettleMs + 50)
    expect(describer.jobs).toHaveLength(2)
    rows.current = ["$ ls", "x", "$ "]
    murmur.prompted("a")
    await settle(times.shellSettleMs + 50)
    expect(describer.jobs).toHaveLength(3)
  })

  it("describes nothing for a prompt no command was entered at", async () => {
    const { murmur, describer, times } = create({ agent: null })
    murmur.prompted("a", false)
    await settle(times.shellSettleMs + 50)
    expect(describer.jobs).toHaveLength(0)
    murmur.prompted("a", true)
    await settle(times.shellSettleMs + 50)
    expect(describer.jobs).toHaveLength(1)
  })

  it("describes nothing from a screen of bare prompts, which nothing was entered after", async () => {
    const { murmur, describer, rows, commandRow, times } = create({ agent: null })
    // Ctrl+L, a line typed and erased, or arrows, then an empty Enter: only prompts remain.
    rows.current = ["user@host:~$", "user@host:~$"]
    murmur.prompted("a")
    await settle(times.shellSettleMs + 50)
    expect(describer.jobs).toHaveLength(0)
    // The line the last command was typed on is a prompt like the bottom one.
    rows.current = ["user@host:~$", "output of nothing known", "user@host:~$"]
    commandRow.current = 0
    murmur.prompted("a")
    await settle(times.shellSettleMs + 50)
    expect(describer.jobs).toHaveLength(0)
    // With a command on that line, it is described.
    rows.current = ["user@host:~$ ls", "a b", "user@host:~$"]
    murmur.prompted("a")
    await settle(times.shellSettleMs + 50)
    expect(describer.jobs).toHaveLength(1)
    expect(describer.digests[0]).toMatchObject({ commandAt: 0 })
  })

  it("owes a shell nothing for a run during which an agent was bound", async () => {
    const { murmur, describer, change, times } = create({
      agent: null,
      work: work(),
      activity: working(),
    })
    // The real order: the sampler takes the program for what it is before the agent binds,
    // and, the foreground being the same all along, is not told again while it runs.
    change({ program: { name: "claude", argv: ["claude"] } })
    murmur.sampled("a")
    await settle(times.shellRunMs - 100)
    change({ agent: "claude" })
    murmur.reported("a")
    await settle(times.shellRunMs + 300)
    // It exits: a sample may land before the prompt is reported, with the agent still bound.
    change({ program: { name: "bash", argv: null } })
    murmur.sampled("a")
    change({ agent: null })
    murmur.sampled("a")
    await settle(times.shellSettleMs + times.shellRunMs + 200)
    expect(describer.digests.filter((digest) => digest.kind === "shell")).toHaveLength(0)
  })

  it("is not asked for a shell the person titled", async () => {
    const { murmur, describer, change, times } = create({
      agent: null,
      naming: { ...unnamed, person: "My shell" },
    })
    murmur.prompted("a")
    await settle(times.shellSettleMs + 50)
    expect(describer.jobs).toHaveLength(0)
    change({ naming: unnamed })
    murmur.prompted("a")
    await settle(times.shellSettleMs + 50)
    expect(describer.jobs).toHaveLength(1)
  })

  it("leaves a terminal that runs an agent to its agent triggers", async () => {
    const { murmur, describer } = create({ agent: "claude" })
    murmur.prompted("a")
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
    murmur.prompted("a")
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

  it("says nothing of a bare prompt", async () => {
    const { murmur, describer, rows } = create({ agent: null })
    rows.current = ["$ "]
    murmur.prompted("a")
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

  it("builds and asks nothing, reading no screen, whatever the terminals do", async () => {
    const made = create(
      { work: work(), activity: idle("ok") },
      new FakeDescriber({ usable: false }),
    )
    for (let turn = 0; turn < 5; turn += 1) {
      summarize(made, `Summary ${turn}`)
      // eslint-disable-next-line no-await-in-loop -- Summaries come one after another.
      await settle()
    }
    made.change({ agent: null, program: { name: "node", argv: ["node", "dev.js"] } })
    made.murmur.sampled("a")
    made.murmur.prompted("a")
    await settle(made.times.shellRunMs * 3)
    expect(made.describer.jobs).toHaveLength(0)
    expect(made.reads).toEqual({ screens: 0 })
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
    const made = create({ work: work(), activity: idle("ok") }, silent as never)
    summarize(made, "Fixes the login cookie.")
    made.murmur.prompted("a")
    await settle(5_000)
    expect(calls).toEqual([])
  })

  it("drops what waited when murmur stops being usable, and asks nothing built before", async () => {
    const made = create({ work: work(), activity: working() })
    summarize(made, "Fixes the login cookie.")
    made.describer.setUsable(false)
    await settle()
    expect(made.describer.jobs).toHaveLength(0)
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
    murmur.prompted("a")
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
    murmur.prompted("a")
    await settle(times.shellSettleMs + 10)
    expect(describer.digests[0]).toMatchObject({ screen: ["$ cat key.txt", secret, "$"] })
  })

  it("waits for the agent it was opened to run, and describes it as a shell only if none binds", async () => {
    const { murmur, describer, change, times } = create({
      agent: null,
      expecting: "claude",
    })
    murmur.prompted("a")
    await settle(times.expectMs - 100)
    expect(describer.jobs).toHaveLength(0)
    // The agent binds: it is no shell, and has no prompt yet to be described by.
    change({ agent: "claude", expecting: null })
    await settle(times.expectMs)
    expect(describer.jobs).toHaveLength(0)

    // Another that never starts is a shell after the wait.
    const other = create({ agent: null, expecting: "claude" })
    other.murmur.prompted("a")
    await settle(times.expectMs + 50)
    expect(other.describer.digests).toHaveLength(1)
    expect(other.describer.digests[0]).toMatchObject({ kind: "shell" })
  })

  it("forgets a terminal's job and state when it is restarted", async () => {
    const { murmur, describer, written, times } = create({ agent: null })
    describer.hold = true
    murmur.prompted("a")
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

  it("describes the shells with no description, and the agents with a summary and no title", async () => {
    const { describer, subjects, written, change } = create({ agent: null })
    const agent = (id: string, naming: MurmurSubject["naming"]) =>
      subjects.set(id, {
        ...subjects.get("a")!,
        summary: { id, sessionId: "s", cwd: "/w" } as MurmurSubject["summary"],
        agent: "claude",
        work: work(),
        activity: idle("ok"),
        naming,
      })
    agent("b", { ...unnamed, summary: "Fixes the build." })
    // No summary: prompts name nothing.
    agent("c", unnamed)
    // Titled: it waits for its agent's next summary.
    agent("d", { ...unnamed, murmur: { title: "Had one" }, summary: "Fixes the login." })
    agent("e", { ...unnamed, opener: { title: "Opened" }, summary: "Fixes the logout." })
    change({ program: { name: "bash", argv: null } })
    describer.setUsable(false)
    describer.setUsable(true)
    await settle(300)
    expect(describer.digests.map((digest) => digest.kind).toSorted()).toEqual(["agent", "shell"])
    expect(describer.digests).toContainEqual({
      kind: "agent",
      project: "shop",
      summary: "Fixes the build.",
    })
    expect(written).toHaveLength(2)
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
      naming: { ...unnamed, summary: "Fixes the build." },
    })
    describer.setUsable(true)
    await settle(300)
    expect(error).toHaveBeenCalled()
    expect(describer.digests.filter((digest) => digest.kind === "agent")).toHaveLength(1)
    error.mockRestore()
  })

  it("names an agent that binds after the catch-up from its summary on record, once", async () => {
    // Resumed with the runner: its saved summary named nothing, and catch-up took it for a shell.
    const resumed = (naming: Partial<MurmurSubject["naming"]>, describer?: FakeDescriber) => {
      const made = create(
        {
          agent: null,
          expecting: "claude",
          naming: { ...unnamed, summary: "Website comparison pages", ...naming },
        },
        describer,
      )
      made.describer.setUsable(false)
      made.describer.setUsable(true)
      made.change({ agent: "claude", expecting: null, work: work(), activity: idle("ok") })
      return made
    }
    const made = resumed({})
    await settle(made.times.expectMs + 50)
    expect(made.describer.jobs).toHaveLength(0)
    made.murmur.reported("a")
    await settle(made.times.settleMs / 2)
    // Reports keep coming: they neither hold the title back nor ask for it again.
    made.murmur.reported("a")
    await settle(made.times.settleMs / 2 + 10)
    expect(made.written).toEqual([{ title: "Title 1" }])
    made.murmur.reported("a")
    await settle(made.times.retryMs)
    expect(made.describer.digests).toEqual([
      { kind: "agent", project: "shop", summary: "Website comparison pages" },
    ])

    // A refused title is let go until the next summary, as ever.
    const refused = resumed({}, new FakeDescriber({ reply: () => null }))
    refused.murmur.reported("a")
    await settle()
    refused.murmur.reported("a")
    await settle()
    expect(refused.describer.jobs).toHaveLength(1)

    // A titled terminal waits for its agent's next summary, as catch-up leaves it.
    const titled = resumed({ murmur: { title: "Had one" } })
    titled.murmur.reported("a")
    await settle()
    expect(titled.describer.jobs).toHaveLength(0)
  })

  it("asks nothing while murmur is unusable, and nothing once stopped", async () => {
    const made = create({ work: work(), activity: idle("ok") })
    made.describer.setUsable(false)
    summarize(made, "Fixes the login cookie.")
    await settle()
    expect(made.describer.jobs).toHaveLength(0)
    made.murmur.stop()
    made.describer.setUsable(true)
    await settle(1_000)
    expect(made.describer.jobs).toHaveLength(0)
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
    const made = create({
      work: work(),
      activity: idle("ok"),
      naming: { ...unnamed, murmur: { title: "Old title" } },
    })
    // A title for a summary waits out its quiet when murmur is cleared.
    summarize(made, "Fixes the login cookie.")
    made.describer.clear()
    await settle(1_000)
    expect(made.clears.count).toBe(1)
    expect(made.describer.jobs).toHaveLength(0)
    expect(made.subjects.get("a")!.naming.murmur).toBeNull()
    // Back on, the untitled terminal is named from its summary by catch-up, once.
    made.describer.setUsable(true)
    await settle(1_000)
    expect(made.describer.jobs).toHaveLength(1)
    expect(made.subjects.get("a")!.naming.murmur).toEqual({ title: "Title 1" })
  })

  // `fireCleared` leaves murmur usable, so what clearing itself drops shows apart from what
  // becoming unusable drops.
  it("drops a request waiting for its quiet, and aborts a job running", async () => {
    const waiting = create({ work: work(), activity: idle("ok") })
    summarize(waiting, "Fixes the login cookie.")
    waiting.describer.fireCleared()
    await settle(1_000)
    expect(waiting.describer.jobs).toHaveLength(0)

    const running = create({ work: work(), activity: idle("ok") })
    running.describer.hold = true
    summarize(running, "Fixes the login cookie.")
    await settle()
    expect(running.describer.jobs).toHaveLength(1)
    running.describer.fireCleared()
    expect(running.describer.jobs[0]!.signal?.aborted).toBe(true)
  })

  it("forgets the summary it named, so the same one names the terminal afresh", async () => {
    const made = create({ work: work(), activity: idle("ok") })
    summarize(made, "Fixes the login cookie.")
    await settle()
    expect(made.subjects.get("a")!.naming.murmur).toEqual({ title: "Title 1" })
    made.describer.fireCleared()
    expect(made.subjects.get("a")!.naming.murmur).toBeNull()
    summarize(made, "Fixes the login cookie.")
    await settle()
    expect(made.describer.jobs).toHaveLength(2)
  })

  it("forgets a retry it was waiting for", async () => {
    const made = create(
      { work: work(), activity: idle("ok") },
      new FakeDescriber({ reply: () => undefined }),
    )
    summarize(made, "Fixes the login cookie.")
    await settle()
    expect(made.describer.jobs).toHaveLength(1)
    made.describer.fireCleared()
    await settle(10 * made.times.retryMs)
    expect(made.describer.jobs).toHaveLength(1)
  })

  it("forgets a shell's description owed, so a brief program's end asks nothing", async () => {
    const { murmur, describer, change } = create({ agent: null })
    change({ program: { name: "node", argv: ["node", "dev.js"] } })
    murmur.sampled("a")
    murmur.prompted("a")
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
