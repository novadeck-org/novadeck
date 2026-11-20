import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { Apart } from "@novadeck/harness-core/harness"
import { homeAbove } from "@novadeck/harness-core/paths"

// Claude Code's agents view (← at its prompt) moves the conversation into a background
// session of its background service: `claude daemon run --origin transient`, one per
// configuration folder, shared by every Claude Code session of the person's, in Novadeck or
// not. It starts it apart from the terminal on purpose: on Windows through WMI, on macOS
// through `launchctl asuser`, on Linux detached in a session of its own (probed 2026-11-20,
// 2.1.329), with two warm sessions (each a `claude bg-pty-host` and its `claude bg-spare`).
//
// The service is Claude Code's to end, and so are its sessions. Asked as its own client asks
// on leaving the view (`retire-if-empty`), it keeps the copy ← made of a conversation with
// turns in it ("not-empty"): the conversation goes on in the background, and its help says
// idle background sessions stop after about an hour. So a terminal's close leaves the
// service with all it runs, though on Linux it is still the agent's child then, and ending
// what the agent started would end every background session the person's other terminals
// set going in it too.
//
// It reads, never writes: `daemon.lock` in the configuration folder the closed session's
// transcript lies in (`<home>/projects/<project>/<session>.jsonl`), which names the service
// by its pid and start. Where that can't be read, nothing is kept apart.

/** The service, as its lock names it. */
export type Lock = {
  readonly pid: number
  /**
   * Its start as Claude Code records it: Linux's clock ticks since boot, macOS's
   * `ps -o lstart` in UTC; on Windows, `procStartFt`, a FILETIME (100 ns since 1601).
   */
  readonly start: string | undefined
  readonly startFt: string | undefined
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

/** The lock's service; undefined for a lock it doesn't recognize. */
export const parseLock = (raw: string): Lock | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const lock = record(parsed)
  const pid = lock?.pid
  if (!lock || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return undefined
  return { pid, start: text(lock.procStart), startFt: text(lock.procStartFt) }
}

/** The configuration folder a Claude Code session's transcript lies in. */
export const homeOf = (transcript: string): string | undefined =>
  homeAbove(transcript, "projects", 1, 1)

/** Reads the service's lock in the folder `home`; undefined where it can't be read or recognized. */
export const readLock = async (home: string): Promise<Lock | undefined> => {
  const raw = await readFile(join(home, "daemon.lock"), "utf8").catch(() => undefined)
  return raw === undefined ? undefined : parseLock(raw)
}

/** Claude Code's background service, which a terminal's close leaves running (see above). */
export const claudeApart: Apart = async ({ transcript }) => {
  const home = transcript === undefined ? undefined : homeOf(transcript)
  const lock = home === undefined ? undefined : await readLock(home)
  return lock?.start === undefined ? [] : [{ pid: lock.pid, start: lock.start }]
}
