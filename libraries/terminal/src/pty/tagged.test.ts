import { describe as context, describe, expect, it, vi } from "vitest"

import { parseTagged, taggedScopes, TaggedScopes } from "./tagged.js"
import type { RunRelay } from "./trees.js"

const line = (pid: number, startedUs: number, value: string) =>
  JSON.stringify({ pid, startedUs, value })

// The relay's answer: two processes of terminal `a`, one of `b`.
const answer = [
  line(40, 1_795_444_200_359_651, "a"),
  line(41, 1_795_444_200_400_000, "a"),
  line(50, 1_795_444_201_000_000, "b"),
].join("\n")

const scopesWith = (run: RunRelay, relay = "/relay") =>
  new TaggedScopes(() => Promise.resolve(relay), "NOVADECK_TERMINAL_ID", run)

describe("the relay's tagged processes", () => {
  it("are read with their starts in milliseconds, to the microsecond", () => {
    expect(parseTagged(`${answer}\n`)).toEqual([
      { pid: 40, startedMs: 1_795_444_200_359.651, value: "a" },
      { pid: 41, startedMs: 1_795_444_200_400, value: "a" },
      { pid: 50, startedMs: 1_795_444_201_000, value: "b" },
    ])
  })

  it("leave out a line that isn't one, and init", () => {
    const lines = [
      "garbage",
      line(1, 5, "a"),
      JSON.stringify({ pid: "40", startedUs: 5, value: "a" }),
      JSON.stringify({ pid: 40, startedUs: "5", value: "a" }),
      JSON.stringify({ pid: 40, startedUs: 5 }),
      "null",
      line(42, 7_000, "a"),
    ]
    expect(parseTagged(lines.join("\n"))).toEqual([{ pid: 42, startedMs: 7, value: "a" }])
  })
})

describe("a terminal's tagged scope", () => {
  it("is the processes that started with its value, as one relay run tells", async () => {
    const run = vi.fn<RunRelay>(() => Promise.resolve(answer))
    const scope = scopesWith(run).contain(10, { NOVADECK_TERMINAL_ID: "a" })
    expect(await scope.members()).toEqual([
      { pid: 40, startedMs: 1_795_444_200_359.651 },
      { pid: 41, startedMs: 1_795_444_200_400 },
    ])
    expect(run).toHaveBeenCalledWith("/relay", ["tagged", "NOVADECK_TERMINAL_ID"], 4_000)
  })

  it("is read once for every terminal that asks while a read is under way, as at a quit", async () => {
    let answered: (output: string) => void = () => {}
    const run = vi.fn<RunRelay>(
      () =>
        new Promise((resolve) => {
          answered = resolve
        }),
    )
    const scopes = scopesWith(run)
    const reads = ["a", "b", "c"].map((value) =>
      scopes.contain(10, { NOVADECK_TERMINAL_ID: value }).members(),
    )
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
    answered(answer)
    expect((await Promise.all(reads)).map((members) => members?.map(({ pid }) => pid))).toEqual([
      [40, 41],
      [50],
      [],
    ])
    expect(run).toHaveBeenCalledOnce()
    // A later ask reads afresh.
    run.mockResolvedValueOnce(line(60, 1, "a"))
    expect(await scopes.contain(11, { NOVADECK_TERMINAL_ID: "a" }).members()).toEqual([
      { pid: 60, startedMs: 0.001 },
    ])
  })

  context("where it can't be told", () => {
    it("is unknown, never empty, where the relay can't run or isn't there", async () => {
      const failing = scopesWith(() => Promise.reject(new Error("usage")))
      expect(await failing.contain(10, { NOVADECK_TERMINAL_ID: "a" }).members()).toBeUndefined()
      const none = new TaggedScopes(() => Promise.resolve(undefined), "NOVADECK_TERMINAL_ID")
      expect(await none.contain(10, { NOVADECK_TERMINAL_ID: "a" }).members()).toBeUndefined()
    })

    it("is none for a program started without the variable, and asks nothing", async () => {
      const run = vi.fn<RunRelay>(() => Promise.resolve(answer))
      const scopes = scopesWith(run)
      expect(await scopes.contain(10, {}).members()).toBeUndefined()
      expect(await scopes.contain(10, { NOVADECK_TERMINAL_ID: "" }).members()).toBeUndefined()
      expect(await scopes.contain(10).members()).toBeUndefined()
      expect(run).not.toHaveBeenCalled()
    })
  })

  it("moves nothing, so a shell waits for nothing, and has no weight or cause to give", async () => {
    const scopes = scopesWith(() => Promise.resolve(answer))
    expect(scopes.active()).toBe(false)
    const scope = scopes.contain(10, { NOVADECK_TERMINAL_ID: "a" })
    expect(scope.cause("SIGKILL")).toBeUndefined()
    await expect(scope.weigh(100)).resolves.toBeUndefined()
    await expect(scope.exited()).resolves.toBeUndefined()
  })

  it("is macOS's alone", () => {
    const relay = () => Promise.resolve("/relay")
    expect(taggedScopes(relay, "V", "darwin")).toBeInstanceOf(TaggedScopes)
    expect(taggedScopes(relay, "V", "linux")).toBeUndefined()
    expect(taggedScopes(relay, "V", "win32")).toBeUndefined()
  })
})
