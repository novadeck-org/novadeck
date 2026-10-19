import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ScreenText } from "@novadeck/emulator/headless"
import { createLogger, logPath, type Entry, type Logger } from "@novadeck/log"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDoorbellLog, doorbellLog, logDoorbell } from "./doorbell-log.js"
import { tracer } from "./doorbell.js"

const folders: string[] = []
afterEach(() => {
  vi.useRealTimers()
  doorbellLog.current?.close()
  delete doorbellLog.current
  delete tracer.sink
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true })
})

/** A runner's log in a fresh folder, at a clock the test moves, and what it wrote. */
const setup = (options: { verbose?: boolean } = {}) => {
  const folder = mkdtempSync(join(tmpdir(), "novadeck-doorbell-log-"))
  folders.push(folder)
  const clock = { now: 0 }
  const logger: Logger = createLogger({
    proc: "runner",
    sid: "launch",
    file: { folder, name: "runner" },
    redact: (text) => text,
    collapseMs: 0,
    now: () => clock.now,
    ...(options.verbose !== undefined && { verbose: options.verbose }),
  })
  const lines = (): Entry[] => {
    logger.flush()
    try {
      return readFileSync(logPath(folder, "runner"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Entry)
    } catch {
      return []
    }
  }
  return { logger, clock, lines }
}

const screen = (rows: string[]): ScreenText => ({ rows, bracketedPaste: true, alternate: false })

describe("createDoorbellLog", () => {
  it("logs a hold with its reason, whatever it is named, and how long it held", () => {
    const { logger, clock, lines } = setup()
    const log = createDoorbellLog(logger.for("doorbell"), { now: () => clock.now })
    log.hold("t1", "draft")
    clock.now = 4_000
    log.hold("t1", "some-reason-a-sibling-adds")
    clock.now = 9_000
    log.hold("t1", null)
    log.close()
    expect(lines().map((line) => [line.evt, line.data])).toEqual([
      ["doorbell.hold", { terminal: "t1", reason: "draft" }],
      ["doorbell.hold", { terminal: "t1", reason: "some-reason-a-sibling-adds", from: "draft" }],
      ["doorbell.release", { terminal: "t1", reason: "some-reason-a-sibling-adds", heldMs: 9_000 }],
    ])
  })

  it("logs a ring with how long messages waited, ending a hold", () => {
    const { logger, clock, lines } = setup()
    const log = createDoorbellLog(logger.for("doorbell"), { now: () => clock.now })
    log.trace("t1", "look: ringable true")
    log.hold("t1", "dialog")
    clock.now = 2_500
    log.ring("t1")
    log.close()
    expect(lines().map((line) => [line.evt, line.data])).toEqual([
      ["doorbell.hold", { terminal: "t1", reason: "dialog" }],
      ["doorbell.release", { terminal: "t1", reason: "dialog", heldMs: 2_500 }],
      ["doorbell.ring", { terminal: "t1", waitedMs: 2_500 }],
    ])
  })

  it("keeps its trace in memory, and writes the latest lines when a ring fails", () => {
    const { logger, clock, lines } = setup()
    const log = createDoorbellLog(logger.for("doorbell"), { now: () => clock.now, keep: 2 })
    log.trace("t1", "settling for 10 ms")
    log.trace("t1", "look: ringable true")
    log.trace("t1", "ring abc pressed")
    expect(lines()).toEqual([])
    log.ringFailed("t1", false)
    log.close()
    expect(lines().map((line) => [line.evt, line.msg])).toEqual([
      ["doorbell.ring-failed", "A ring of the doorbell failed."],
      ["doorbell.trace", "1970-01-01T00:00:00.000Z look: ringable true"],
      ["doorbell.trace", "1970-01-01T00:00:00.000Z ring abc pressed"],
    ])
  })

  it("writes its trace once messages have waited past the escalation, held or not", () => {
    const { logger, clock, lines } = setup()
    const log = createDoorbellLog(logger.for("doorbell"), {
      now: () => clock.now,
      escalateMs: 60_000,
      quietMs: 20_000,
    })
    for (clock.now = 0; clock.now <= 75_000; clock.now += 15_000)
      log.trace("t1", "not looked at: activity working")
    log.close()
    const written = lines()
    expect(written[0]).toEqual(
      expect.objectContaining({
        evt: "doorbell.held-long",
        level: "warn",
        data: { terminal: "t1", reason: "waiting", waitedMs: 75_000 },
      }),
    )
    expect(written.filter((line) => line.evt === "doorbell.trace")).toHaveLength(6)
  })

  it("writes its trace when a hold outlasts the escalation with the doorbell quiet", () => {
    vi.useFakeTimers()
    const { logger, lines } = setup()
    const log = createDoorbellLog(logger.for("doorbell"), { now: Date.now, escalateMs: 60_000 })
    log.trace("t1", "reading draft")
    log.hold("t1", "draft")
    vi.advanceTimersByTime(60_000)
    log.close()
    expect(lines().map((line) => line.evt)).toEqual([
      "doorbell.hold",
      "doorbell.held-long",
      "doorbell.trace",
    ])
  })

  it("starts a new wait after the doorbell was quiet", () => {
    const { logger, clock, lines } = setup()
    const log = createDoorbellLog(logger.for("doorbell"), {
      now: () => clock.now,
      escalateMs: 60_000,
      quietMs: 20_000,
    })
    log.trace("t1", "look")
    clock.now = 3_600_000
    log.trace("t1", "look")
    log.close()
    expect(lines()).toEqual([])
  })

  it("writes the rows it read only when verbose, and marks them so", () => {
    const quiet = setup()
    const log = createDoorbellLog(quiet.logger.for("doorbell"), { now: () => 0 })
    log.trace("t1", "reading draft", screen(["secret plans", "> half a prompt"]))
    log.ringFailed("t1", false)
    log.close()
    expect(JSON.stringify(quiet.lines())).not.toContain("secret plans")

    const verbose = setup({ verbose: true })
    const loud = createDoorbellLog(verbose.logger.for("doorbell"), { now: () => 0, verbose: true })
    loud.trace("t1", "reading draft", screen(["", "secret plans", "> half a prompt"]))
    loud.close()
    expect(verbose.lines()).toEqual([
      expect.objectContaining({
        evt: "doorbell.screen",
        msg: "secret plans",
        verbose: true,
        data: { terminal: "t1", row: -2 },
      }),
      expect.objectContaining({ evt: "doorbell.screen", msg: "> half a prompt", verbose: true }),
    ])
  })
})

describe("logDoorbell", () => {
  it("takes the doorbell's trace from its tracer into the runner's file", () => {
    const { logger, lines } = setup()
    logDoorbell(logger.for("doorbell"), { now: () => 0 })
    tracer.sink?.("t1", "gate not-calm (foreground true, input box true, bracketed paste true)")
    doorbellLog.current?.ringFailed("t1", true)
    expect(lines().map((line) => [line.evt, line.msg])).toEqual([
      ["doorbell.ring-failed", "A ring of the doorbell failed."],
      [
        "doorbell.trace",
        "1970-01-01T00:00:00.000Z gate not-calm (foreground true, input box true, bracketed paste true)",
      ],
    ])
  })
})
