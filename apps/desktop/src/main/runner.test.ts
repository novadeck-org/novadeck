import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import type { ForkOptions, MessagePortMain, UtilityProcess } from "electron"
import { afterEach, beforeEach, vi } from "vitest"

import { mainBeatMs, type RunnerCommand } from "../bridge.js"
import { context, describe, expect, it } from "../test"
import { appLog } from "./logs/logs.test-support"
import { logRunnerEvents, startRunner, type RunnerEvents } from "./runner"

/** A utility process as the runner's host sees one: what it was sent, and whether it was killed. */
class FakeWorker extends EventEmitter {
  readonly sent: { command: RunnerCommand; ports: number }[] = []
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  kills = 0
  constructor(
    readonly entry: string,
    readonly args: string[],
    readonly options: ForkOptions,
  ) {
    super()
  }
  postMessage(command: RunnerCommand, ports: MessagePortMain[] = []): void {
    this.sent.push({ command, ports: ports.length })
  }
  kill(): boolean {
    this.kills += 1
    return true
  }
  /** What it was sent, by type. */
  commands(): string[] {
    return this.sent.map(({ command }) => command.type)
  }
  exit(code: number): void {
    this.stdout.end()
    this.stderr.end()
    this.emit("exit", code)
  }
}

const port = {} as MessagePortMain

/** Starts the runner on fake processes, with every event it reports recorded in order. */
const start = (options: { transcriptKey?: Promise<string | null> } = {}) => {
  const workers: FakeWorker[] = []
  const heard: unknown[][] = []
  const record =
    (name: keyof RunnerEvents) =>
    (...args: unknown[]) =>
      heard.push([name, ...args])
  const runner = startRunner({
    entry: "/app/out/main/runner.js",
    database: "/data/workspace.sqlite",
    relay: "/app/relay",
    engine: "/app/voice/engine.json",
    source: "https://example.test/voice",
    murmurEngine: "/app/murmur/engine.json",
    murmurSource: "https://example.test/murmur",
    transcriptKey: options.transcriptKey ?? Promise.resolve("a2V5"),
    log: (run) => `log-${run}`,
    events: {
      spawned: record("spawned"),
      ready: record("ready"),
      exited: record("exited"),
      fatal: record("fatal"),
      killed: record("killed"),
      abandoned: record("abandoned"),
    },
    fork: (entry, args, forkOptions) => {
      const worker = new FakeWorker(entry, args, forkOptions)
      workers.push(worker)
      return worker as unknown as UtilityProcess
    },
  })
  return { runner, workers, heard, current: () => workers.at(-1)! }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("the runner's process", () => {
  context("as the app starts it", () => {
    it("forks the runner's entry with the app's paths and its log, its output piped", () => {
      const { workers, heard } = start()
      expect(workers).toHaveLength(1)
      const [worker] = workers
      expect(worker?.entry).toBe("/app/out/main/runner.js")
      expect(worker?.args).toEqual([
        "--novadeck-database=/data/workspace.sqlite",
        expect.stringContaining("/app/relay"),
        expect.stringContaining("/app/voice/engine.json"),
        expect.stringContaining("https://example.test/voice"),
        expect.stringContaining("/app/murmur/engine.json"),
        expect.stringContaining("https://example.test/murmur"),
        "--novadeck-log=log-1",
      ])
      expect(worker?.options).toEqual({ serviceName: "Novadeck Runner", stdio: "pipe" })
      expect(heard).toEqual([["spawned", 1]])
    })

    it("hands each port to the running runner", () => {
      const { runner, workers, current } = start()
      expect(runner.deliver(port)).toBe(true)
      expect(runner.deliver(port)).toBe(true)
      expect(workers).toHaveLength(1)
      expect(current().sent.filter(({ command }) => command.type === "connect")).toEqual([
        { command: { type: "connect" }, ports: 1 },
        { command: { type: "connect" }, ports: 1 },
      ])
    })

    it("says when it is ready, and how long it took", () => {
      const { current, heard } = start()
      vi.advanceTimersByTime(40)
      current().emit("message", { type: "ready" })
      expect(heard.at(-1)).toEqual(["ready", 1, expect.any(Number)])
    })

    it("beats to it while it runs", () => {
      const { current } = start()
      vi.advanceTimersByTime(mainBeatMs * 3)
      expect(
        current()
          .commands()
          .filter((type) => type === "beat"),
      ).toHaveLength(3)
    })
  })

  context("when it exits on its own", () => {
    it("says it was unexpected, and the next port starts it again with its own log", () => {
      const { runner, workers, heard } = start()
      workers[0]?.exit(1)
      expect(heard.at(-1)).toEqual(["exited", 1, 1, false])
      expect(runner.deliver(port)).toBe(true)
      expect(workers).toHaveLength(2)
      expect(workers[1]?.args.at(-1)).toBe("--novadeck-log=log-2")
      expect(workers[1]?.commands()).toContain("connect")
      expect(heard.at(-1)).toEqual(["spawned", 2])
    })

    it("beats to none while none runs", () => {
      const { workers } = start()
      workers[0]?.exit(1)
      const before = workers[0]?.sent.length
      vi.advanceTimersByTime(mainBeatMs * 3)
      expect(workers[0]?.sent).toHaveLength(before ?? 0)
    })
  })

  context("given the transcript key", () => {
    it("sends it to the runner once the key is known", async () => {
      let give: (key: string | null) => void = () => {}
      const { current } = start({ transcriptKey: new Promise((resolve) => (give = resolve)) })
      await vi.advanceTimersByTimeAsync(0)
      expect(current().commands()).not.toContain("transcriptKey")
      give("a2V5")
      await vi.advanceTimersByTimeAsync(0)
      expect(current().sent).toContainEqual({
        command: { type: "transcriptKey", key: "a2V5" },
        ports: 0,
      })
    })

    it("sends it to a runner started again, and never to one that is gone", async () => {
      let give: (key: string | null) => void = () => {}
      const { runner, workers } = start({
        transcriptKey: new Promise((resolve) => (give = resolve)),
      })
      workers[0]?.exit(1)
      runner.deliver(port)
      give(null)
      await vi.advanceTimersByTimeAsync(0)
      expect(workers[0]?.commands()).not.toContain("transcriptKey")
      expect(workers[1]?.sent).toContainEqual({
        command: { type: "transcriptKey", key: null },
        ports: 0,
      })
      workers[1]?.exit(1)
      runner.deliver(port)
      await vi.advanceTimersByTimeAsync(0)
      expect(workers[2]?.commands()).toContain("transcriptKey")
    })
  })

  context("when V8 ends it with a fatal error", () => {
    it("reports it, throws nothing into the main process, and still hears the exit", () => {
      const { current, heard } = start()
      const worker = current()
      expect(() =>
        worker.emit("error", "FatalError", "v8::internal::Heap", "{ the whole report }"),
      ).not.toThrow()
      worker.exit(134)
      expect(heard.slice(-2)).toEqual([
        ["fatal", 1, "FatalError", "v8::internal::Heap"],
        ["exited", 1, 134, false],
      ])
    })
  })

  context("as the app closes it", () => {
    it("asks it to close, and settles once it exits by itself, as expected", async () => {
      const { runner, current, heard } = start()
      const closed = vi.fn()
      void runner.close().then(closed)
      expect(current().commands().at(-1)).toBe("close")
      await vi.advanceTimersByTimeAsync(0)
      expect(closed).not.toHaveBeenCalled()
      current().exit(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(closed).toHaveBeenCalled()
      expect(current().kills).toBe(0)
      expect(heard.at(-1)).toEqual(["exited", 1, 0, true])
    })

    it("is final: no port is delivered, no runner started, no beat or save sent", async () => {
      const { runner, workers, current } = start()
      const closing = runner.close()
      expect(runner.close()).toBe(closing)
      current().exit(0)
      await closing
      const sent = current().sent.length
      expect(runner.deliver(port)).toBe(false)
      runner.persist()
      vi.advanceTimersByTime(mainBeatMs * 3)
      expect(workers).toHaveLength(1)
      expect(current().sent).toHaveLength(sent)
    })

    it("settles at once when no runner is running", async () => {
      const { runner, current } = start()
      current().exit(1)
      await expect(runner.close()).resolves.toBeUndefined()
    })

    it("counts a crash while it closes as unexpected", async () => {
      const { runner, current, heard } = start()
      const closing = runner.close()
      current().exit(1)
      await closing
      expect(heard.at(-1)).toEqual(["exited", 1, 1, false])
    })

    it("kills it when it doesn't exit in time, and says so", async () => {
      const { runner, current, heard } = start()
      const closed = vi.fn()
      void runner.close(5_000).then(closed)
      await vi.advanceTimersByTimeAsync(4_999)
      expect(current().kills).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(current().kills).toBe(1)
      expect(heard.at(-1)).toEqual(["killed", 1, 5_000])
      expect(closed).not.toHaveBeenCalled()
      current().exit(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(closed).toHaveBeenCalled()
      expect(heard.at(-1)).toEqual(["exited", 1, 0, false])
    })

    it("doesn't kill it once it has exited", async () => {
      const { runner, current } = start()
      const closing = runner.close(5_000)
      current().exit(0)
      await closing
      await vi.advanceTimersByTimeAsync(10_000)
      expect(current().kills).toBe(0)
    })

    it("settles without it when it doesn't exit even after the kill", async () => {
      const { runner, current, heard } = start()
      const closed = vi.fn()
      void runner.close(5_000, 2_000).then(closed)
      await vi.advanceTimersByTimeAsync(5_000 + 1_999)
      expect(closed).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(closed).toHaveBeenCalled()
      expect(current().kills).toBe(1)
      expect(heard.slice(-2)).toEqual([
        ["killed", 1, 5_000],
        ["abandoned", 1, 2_000],
      ])
    })
  })
})

describe("what the app logs of the runner", () => {
  it("logs a fatal error without its report, and a kill and a stuck exit as faults", () => {
    const { logger, lines } = appLog()
    const events = logRunnerEvents(logger, false)
    events.fatal?.(3, "FatalError", "v8::internal::Heap")
    events.killed?.(3, 5_000)
    events.abandoned?.(3, 2_000)
    logger.close()
    expect(lines().map((line) => [line.evt, line.level, line.data])).toEqual([
      ["runner.fatal", "error", { run: 3, type: "FatalError", location: "v8::internal::Heap" }],
      ["runner.close-timeout", "warn", { run: 3, ms: 5_000 }],
      ["runner.exit-timeout", "error", { run: 3, ms: 2_000 }],
    ])
  })
})
