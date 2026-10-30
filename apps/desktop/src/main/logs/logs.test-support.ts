import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createLogger, createRedactor, logPath, type Entry, type Logger } from "@novadeck/log"
import { afterEach } from "vitest"

const folders: string[] = []
afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true })
})

export const scratch = (): string => {
  const made = mkdtempSync(join(tmpdir(), "novadeck-app-log-"))
  folders.push(made)
  return made
}

/** The app's log in a fresh folder, redacted for a person named ana, and what it wrote. */
export const appLog = () => {
  const folder = scratch()
  const logger: Logger = createLogger({
    proc: "host",
    sid: "launch",
    file: { folder, name: "host" },
    redact: createRedactor({ home: "/home/ana", user: "ana", salt: "0".repeat(64) }),
    collapseMs: 0,
  })
  const lines = (): Entry[] => {
    try {
      return readFileSync(logPath(folder, "host"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Entry)
    } catch {
      return []
    }
  }
  return { logger, lines }
}
