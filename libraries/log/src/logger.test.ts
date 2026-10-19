import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { Entry } from "./envelope.js"
import { logPath } from "./file.js"
import { consoleLogger, createLogger, switchableLogger, type LoggerOptions } from "./logger.js"
import { createRedactor } from "./redact.js"

const folders: string[] = []
afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true })
})

const salt = "0".repeat(64)

/** A logger writing to a fresh folder, at a fixed time, and what it wrote. */
const setup = (options: Partial<LoggerOptions> = {}) => {
  const folder = mkdtempSync(join(tmpdir(), "novadeck-log-"))
  folders.push(folder)
  const logger = createLogger({
    proc: "runner",
    sid: "launch-1",
    run: 2,
    file: { folder, name: "runner" },
    redact: createRedactor({ home: "/home/ana", user: "ana", salt }),
    now: () => Date.UTC(2026, 9, 19, 12),
    pid: 42,
    ...options,
  })
  const lines = (index = 0): Entry[] =>
    readFileSync(logPath(folder, "runner", index), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Entry)
  return { logger, folder, lines }
}

describe("createLogger", () => {
  it("writes one JSON line per event, in the envelope", () => {
    const { logger, lines } = setup()
    logger
      .for("doorbell")
      .info("doorbell.hold", "Held a message.", { data: { reason: "draft", heldMs: 12 } })
    logger.close()
    expect(lines()).toEqual([
      {
        v: 1,
        t: "2026-10-19T12:00:00.000Z",
        level: "info",
        proc: "runner",
        sid: "launch-1",
        run: 2,
        pid: 42,
        src: "doorbell",
        evt: "doorbell.hold",
        msg: "Held a message.",
        data: { reason: "draft", heldMs: 12 },
      },
    ])
  })

  it("redacts the message, the data's text and the error", () => {
    const { logger, lines } = setup()
    const error = new Error("EACCES: open '/home/ana/acme/notes.md'")
    logger.for("store").error("store.save-failed", "Could not save for ana.", {
      data: { path: "/home/ana/acme" },
      err: error,
    })
    logger.close()
    const [line] = lines()
    const text = JSON.stringify(line)
    expect(text).not.toContain("acme")
    expect(text).not.toContain("/home/ana")
    expect(line?.msg).toBe("Could not save for <user>.")
    expect(line?.err?.message).toMatch(/^EACCES: open '~\/#[0-9a-f]{8}\/#[0-9a-f]{8}\.md'$/)
  })

  it("leaves out lines below its level", () => {
    const { logger, lines } = setup({ level: "info" })
    logger.for("doorbell").debug("doorbell.trace", "look")
    logger.for("doorbell").info("doorbell.ring", "Rang.")
    logger.close()
    expect(lines().map((line) => line.evt)).toEqual(["doorbell.ring"])
  })

  it("leaves out verbose lines unless verbose logging is on", () => {
    const quiet = setup()
    quiet.logger.for("doorbell").info("doorbell.screen", "row one", { verbose: true })
    quiet.logger.for("doorbell").info("doorbell.ring", "Rang.")
    quiet.logger.close()
    expect(quiet.lines().map((line) => line.evt)).toEqual(["doorbell.ring"])

    const verbose = setup({ verbose: true })
    verbose.logger.for("doorbell").info("doorbell.screen", "row one", { verbose: true })
    verbose.logger.close()
    expect(verbose.lines()).toEqual([
      expect.objectContaining({ evt: "doorbell.screen", verbose: true }),
    ])
  })

  it("collapses repeats and counts them out when it closes", () => {
    const { logger, lines } = setup()
    for (let index = 0; index < 5; index += 1)
      logger.for("murmur").warn("murmur.failed", "Could not describe.")
    logger.close()
    expect(lines().map((line) => [line.evt, line.msg])).toEqual([
      ["murmur.failed", "Could not describe."],
      ["log.repeated", "Could not describe. (repeated 4 more times)"],
    ])
  })

  it("starts a rotated-in file with a header that names the launch", () => {
    const resume = { version: "1.2.3", os: "linux", arch: "x64" }
    const { logger, folder } = setup()
    logger.close()
    const small = createLogger({
      proc: "runner",
      sid: "launch-2",
      file: { folder, name: "runner", maxBytes: 600 },
      redact: (text) => text,
      resume,
      collapseMs: 0,
    })
    for (let index = 0; index < 10; index += 1) small.for("main").info("app.tick", `tick ${index}`)
    small.close()
    const header = JSON.parse(readFileSync(logPath(folder, "runner"), "utf8").split("\n")[0] ?? "")
    expect(header).toEqual(
      expect.objectContaining({ evt: "session.resume", sid: "launch-2", data: resume }),
    )
  })

  it("never throws, even when the file can't be written", () => {
    const logger = createLogger({
      proc: "host",
      sid: "s",
      file: { folder: "/proc/novadeck-cannot-write-here", name: "host" },
      redact: () => {
        throw new Error("broken redactor")
      },
    })
    expect(() => logger.for("main").error("x.y", "z", { err: new Error("e") })).not.toThrow()
    logger.close()
  })

  it("shows each line on the console it is given, as it was logged", () => {
    const echo = vi.fn<NonNullable<LoggerOptions["echo"]>>()
    const { logger } = setup({ echo })
    const error = new Error("at /home/ana/acme")
    logger.for("main").error("x.failed", "Failed", { err: error })
    logger.close()
    expect(echo).toHaveBeenCalledWith("error", "Failed", error)
  })
})

describe("consoleLogger", () => {
  it("shows warnings and errors the way console calls did", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const logger = consoleLogger()
      const thrown = new Error("boom")
      logger.for("x").error("x.failed", "Novadeck could not save", { err: thrown })
      logger.for("x").warn("x.odd", "Something odd.")
      logger.for("x").info("x.fine", "Fine.")
      expect(error).toHaveBeenCalledWith("Novadeck could not save:", thrown)
      expect(warn).toHaveBeenCalledWith("Something odd.")
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      error.mockRestore()
      warn.mockRestore()
    }
  })
})

describe("switchableLogger", () => {
  it("hands lines to the logger it was given last, even through a log taken before", () => {
    const first = setup()
    const second = setup()
    const logger = switchableLogger(first.logger)
    const log = logger.for("messaging")
    log.info("a.one", "one")
    logger.use(second.logger)
    log.info("a.two", "two")
    first.logger.close()
    second.logger.close()
    expect(first.lines().map((line) => line.msg)).toEqual(["one"])
    expect(second.lines().map((line) => line.msg)).toEqual(["two"])
  })
})
