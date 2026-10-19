import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { Entry } from "./envelope.js"
import { logPath } from "./file.js"
import { createLogger } from "./logger.js"
import { startSession } from "./session.js"

const folders: string[] = []
afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true })
})

const logsFolder = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "novadeck-log-"))
  folders.push(folder)
  return folder
}

/** One launch of the host: its logger, and its session started. */
const launch = (folder: string, sid: string, at: number) => {
  const logger = createLogger({
    proc: "host",
    sid,
    file: { folder, name: "host" },
    redact: (text) => text,
    now: () => at,
    collapseMs: 0,
  })
  const session = startSession({
    folder,
    sid,
    log: logger.for("session"),
    file: logPath(folder, "host"),
    data: { version: "1.2.3" },
    now: () => at,
  })
  return { logger, session }
}

const lines = (folder: string): Entry[] =>
  readFileSync(logPath(folder, "host"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Entry)

describe("startSession", () => {
  it("logs the start, and the end once the launch quits", () => {
    const folder = logsFolder()
    const { logger, session } = launch(folder, "one", 0)
    session.end({ code: 0 })
    session.end({ code: 0 })
    logger.close()
    expect(lines(folder).map((line) => [line.evt, line.data])).toEqual([
      ["session.start", { version: "1.2.3" }],
      ["session.end", { code: 0 }],
    ])
    expect(existsSync(join(folder, "session.json"))).toBe(false)
  })

  it("finds a launch that never ended, as one killed does, and says when it last wrote", () => {
    const folder = logsFolder()
    const killed = launch(folder, "one", Date.UTC(2026, 9, 19, 12))
    killed.logger.for("runner").error("runner.exit", "The runner exited.")
    // No end: the process is gone, its marker left behind.
    killed.logger.close()

    const next = launch(folder, "two", Date.UTC(2026, 9, 19, 13))
    next.session.end()
    next.logger.close()
    const unclean = lines(folder).find((line) => line.evt === "session.unclean")
    expect(unclean).toEqual(
      expect.objectContaining({
        sid: "two",
        level: "warn",
        data: {
          sid: "one",
          startedAt: "2026-10-19T12:00:00.000Z",
          lastAt: "2026-10-19T12:00:00.000Z",
        },
      }),
    )
  })

  it("says nothing of a launch that ended", () => {
    const folder = logsFolder()
    const first = launch(folder, "one", 0)
    first.session.end()
    first.logger.close()
    const second = launch(folder, "two", 1)
    second.logger.close()
    expect(lines(folder).some((line) => line.evt === "session.unclean")).toBe(false)
  })

  it("finds the unclean launch from its marker, whatever rotation did to its start", () => {
    const folder = logsFolder()
    const killed = launch(folder, "one", 0)
    killed.logger.close()
    // Its lines rotated away: only the marker is left.
    rmSync(logPath(folder, "host"))
    const next = launch(folder, "two", 1)
    next.logger.close()
    const unclean = lines(folder).find((line) => line.evt === "session.unclean")
    expect(unclean?.data).toEqual({ sid: "one", startedAt: "1970-01-01T00:00:00.000Z" })
  })
})
