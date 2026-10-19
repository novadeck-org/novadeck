import { describe, expect, it } from "../test"
import { updateLog, updateLogBytes, type UpdateLogHost } from "./update-log"

// A log host over files kept in memory, at a fixed time.
const memory = (sizes: Record<string, number> = {}) => {
  const files = new Map<string, string>()
  const host: UpdateLogHost = {
    append: (file, text) => void files.set(file, (files.get(file) ?? "") + text),
    size: (file) => sizes[file] ?? files.get(file)?.length ?? 0,
    rename: (from, to) => {
      files.set(to, files.get(from) ?? "")
      files.delete(from)
      delete sizes[from]
    },
    mkdir: () => {},
    now: () => new Date("2026-10-19T12:00:00.000Z"),
  }
  return { files, host }
}

describe("the log of updating", () => {
  it("writes a line for each message, with the time and level", () => {
    const { files, host } = memory()
    const log = updateLog(() => "/logs/updates.log", host)
    log.info("Checking for updates.")
    log.logger.warn({ code: 7 })
    expect(files.get("/logs/updates.log")).toBe(
      "2026-10-19T12:00:00.000Z info Checking for updates.\n" +
        "2026-10-19T12:00:00.000Z warn { code: 7 }\n",
    )
  })

  it("keeps a failure's error, its later lines indented", () => {
    const { files, host } = memory()
    const error = new Error("App Still Running")
    error.stack = "Error: App Still Running\n    at install"
    updateLog(() => "/logs/updates.log", host).warn("Installing the update failed.", error)
    expect(files.get("/logs/updates.log")).toBe(
      "2026-10-19T12:00:00.000Z warn Installing the update failed. Error: App Still Running\n" +
        "        at install\n",
    )
  })

  it("sets a full log aside and starts a new one, keeping two at most", () => {
    const { files, host } = memory({ "/logs/updates.log": updateLogBytes })
    files.set("/logs/updates.log", "old\n")
    files.set("/logs/updates.log.1", "older\n")
    updateLog(() => "/logs/updates.log", host).info("New.")
    expect(files.get("/logs/updates.log.1")).toBe("old\n")
    expect(files.get("/logs/updates.log")).toBe("2026-10-19T12:00:00.000Z info New.\n")
  })

  it("drops a line it can't write, so updating goes on", () => {
    const { host } = memory()
    const log = updateLog(() => "/logs/updates.log", {
      ...host,
      append: () => {
        throw new Error("read-only")
      },
    })
    expect(() => log.info("Checking.")).not.toThrow()
  })
})
