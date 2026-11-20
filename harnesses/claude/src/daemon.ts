import { readdir, readFile, stat } from "node:fs/promises"
import { basename, join } from "node:path"

import type { Apart, ApartProcess, Install } from "@novadeck/harness-core/harness"

import { claudeHome } from "./home.js"

// Claude Code's agents view (← at its prompt, since 2.1.316) moves the conversation into a
// background session run by its background service: `claude daemon run --origin transient`,
// one per configuration folder, shared by every Claude Code session of the person's, in
// Novadeck or not. It starts it apart from the terminal on purpose: on Windows through WMI,
// on macOS through `launchctl asuser`, on Linux detached in a session of its own (probed
// 2026-11-20, 2.1.329). The service keeps two sessions warm (each a `claude bg-pty-host` and
// its `claude bg-spare`), one of which takes the copy of the conversation.
//
// Its help says it "exits once no client is connected and no background session is running",
// and that a session moved with ← before anything was typed in it "usually stops after about
// 5 minutes". Neither happened: the service, its spares and the unused copy were all still
// running 9 minutes after the terminal closed, about 630 MB (Linux, 2.1.329). So once a
// terminal whose agent did that has closed, Novadeck ends what was that terminal's alone:
// the copy of its conversation nothing was typed into (and any other left with no client to
// show it), and the service itself where that leaves it serving no one. A background session the person set to work, and a service
// another of their sessions is using, are left running, as Claude Code means them to.
//
// It reads, never writes: `daemon.lock`, which names the service by its pid and start,
// `daemon/roster.json`, its sessions, each by its pid and start and what it was made from,
// and the folder of transcripts. Anything it can't read or doesn't recognize leaves the
// service and its sessions alone.

/** The service, as its lock names it. */
export type Lock = {
  readonly pid: number
  readonly start: string | undefined
  /** When it wrote the lock, in milliseconds since the epoch: just after it started. */
  readonly startedAt: number
  /** `transient` where a session started it on demand; `service` where the person installed it. */
  readonly origin: string
  /** The process that started it, which may still be using it. */
  readonly spawnedBy: number | undefined
}

/** A background session of the service, as its roster lists it. */
export type Worker = {
  readonly id: string
  readonly pid: number
  readonly start: string | undefined
  /** When the service took it on, in milliseconds since the epoch. */
  readonly startedAt: number
  /** The session it runs. */
  readonly sessionId: string | undefined
  /** Its program, under `pid`. */
  readonly repl: { readonly pid: number; readonly start: string | undefined } | undefined
  /**
   * How it came to be: `slash` for ← at a prompt, `spare` for a warm session a client took
   * for its own view, which goes when that client does; others for what was asked of it.
   */
  readonly source: string | undefined
  /** The session it copied (`fork`), where it was made from one. */
  readonly forkOf: string | undefined
}

export type Roster = { readonly supervisor: number; readonly workers: readonly Worker[] }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const pid = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 1 ? value : undefined

const time = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

const json = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/** The lock's service; undefined for a lock it doesn't recognize. */
export const parseLock = (raw: string): Lock | undefined => {
  const lock = record(json(raw))
  const at = time(lock?.startedAt)
  const id = pid(lock?.pid)
  const origin = text(lock?.origin)
  if (!lock || id === undefined || at === undefined || origin === undefined) return undefined
  return {
    pid: id,
    start: text(lock.procStart),
    startedAt: at,
    origin,
    spawnedBy: pid(record(lock.spawnedBy)?.pid),
  }
}

/** The roster's sessions; undefined for a roster it doesn't recognize, or one with any such session. */
export const parseRoster = (raw: string): Roster | undefined => {
  const roster = record(json(raw))
  const supervisor = pid(roster?.supervisorPid)
  const listed = record(roster?.workers)
  if (supervisor === undefined || !listed) return undefined
  const workers: Worker[] = []
  for (const [id, value] of Object.entries(listed)) {
    const worker = record(value)
    const at = time(worker?.startedAt)
    const own = pid(worker?.pid)
    // A session it can't place may be anyone's: the whole roster is left alone.
    if (!worker || own === undefined || at === undefined) return undefined
    const dispatch = record(worker.dispatch)
    const launch = record(dispatch?.launch)
    const from = launch?.fork === true ? text(launch.sessionId) : undefined
    const repl = pid(worker.replPid)
    workers.push({
      id,
      pid: own,
      start: text(worker.procStart),
      startedAt: at,
      sessionId: text(worker.sessionId),
      repl: repl === undefined ? undefined : { pid: repl, start: text(worker.replProcStart) },
      source: text(dispatch?.source),
      // A path to its transcript, or the bare id.
      forkOf: from === undefined ? undefined : basename(from, ".jsonl"),
    })
  }
  return { supervisor, workers }
}

/** How long before writing its lock the service may have started, in milliseconds. */
const lockWithinMs = 60_000

/**
 * How far from its roster's time a session's processes may have started, in milliseconds,
 * on Windows, which records no start Novadeck reads: a session taken from the warm ones was
 * started before the service took it on, never before the service itself.
 */
const sessionWithinMs = 10_000

const serviceProcess = (lock: Lock): ApartProcess => ({
  pid: lock.pid,
  ...(lock.start !== undefined && { start: lock.start }),
  born: { after: lock.startedAt - lockWithinMs, before: lock.startedAt },
})

const sessionProcesses = (lock: Lock, worker: Worker): ApartProcess[] => {
  const born = { after: lock.startedAt - lockWithinMs, before: worker.startedAt + sessionWithinMs }
  return [
    { pid: worker.pid, ...(worker.start !== undefined && { start: worker.start }), born },
    ...(worker.repl
      ? [
          {
            pid: worker.repl.pid,
            ...(worker.repl.start !== undefined && { start: worker.repl.start }),
            born,
          },
        ]
      : []),
  ]
}

/** What a closed terminal left in the service, as `left` reads it. */
export type Facts = {
  readonly lock: Lock
  readonly roster: Roster
  /** Whether session `sessionId` has a transcript: whether anything was said in it. */
  readonly transcribed: (sessionId: string) => boolean
  /** Whether process `pid` runs, or one given its pid since. */
  readonly running: (pid: number) => boolean
}

export type Verdict = {
  /** Whether what the service lists is final: no client's own session is still going. */
  readonly settled: boolean
  readonly end: readonly ApartProcess[]
}

/**
 * What to end of what terminal session `closed` left in the service. A copy ← made of a
 * conversation, while nothing was said in it: the closed one's always; any other's too once
 * no client's own session (`spare`) is listed, as such a copy lives only while its client
 * shows the agents view, and none does (two terminals closing together each leave the
 * other's). And the service with all it runs, where it was started on demand (`transient`),
 * whatever started it has gone, and only such copies are left in it. A session the person
 * gave work, one made otherwise, or a client's own keeps the service; and while a client's
 * own is listed, what is listed may not be final, as the closed terminal's goes a moment
 * after its agent.
 */
export const verdict = (facts: Facts, closed: string): Verdict => {
  const { lock, roster } = facts
  // A roster of another service than the lock's: one of them is stale, and nothing is sure.
  if (roster.supervisor !== lock.pid) return { settled: true, end: [] }
  const settled = !roster.workers.some((worker) => worker.source === "spare")
  const unused = (worker: Worker) =>
    worker.source === "slash" &&
    worker.forkOf !== undefined &&
    (settled || worker.forkOf === closed) &&
    worker.sessionId !== undefined &&
    !facts.transcribed(worker.sessionId)
  const copies = roster.workers.filter(unused)
  const idle =
    copies.length === roster.workers.length &&
    lock.origin === "transient" &&
    (lock.spawnedBy === undefined || !facts.running(lock.spawnedBy))
  return {
    settled,
    end: [
      ...(idle ? [serviceProcess(lock)] : []),
      ...copies.flatMap((worker) => sessionProcesses(lock, worker)),
    ],
  }
}

const readText = (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch(() => undefined)

const running = (id: number): boolean => {
  try {
    process.kill(id, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

// Whether any project's folder holds the session's transcript.
const transcripts = async (home: string): Promise<(sessionId: string) => Promise<boolean>> => {
  const projects = join(home, "projects")
  const folders = await readdir(projects).catch(() => [] as string[])
  return async (sessionId) => {
    const found = await Promise.all(
      folders.map((folder) =>
        stat(join(projects, folder, `${sessionId}.jsonl`)).then(
          () => true,
          () => false,
        ),
      ),
    )
    return found.some(Boolean)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const pollMs = 100

/** Claude Code's background service as a terminal's close treats it (see above). */
export const claudeApart: Apart = {
  kept: async (install) => {
    const raw = await readText(join(claudeHome(install), "daemon.lock"))
    const lock = raw === undefined ? undefined : parseLock(raw)
    return lock ? [serviceProcess(lock)] : []
  },
  left: async (install: Install, closed, until) => {
    const home = claudeHome(install)
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- Each look reads the files anew.
      const [rawLock, rawRoster] = await Promise.all([
        readText(join(home, "daemon.lock")),
        readText(join(home, "daemon", "roster.json")),
      ])
      const lock = rawLock === undefined ? undefined : parseLock(rawLock)
      const roster = rawRoster === undefined ? undefined : parseRoster(rawRoster)
      if (!lock || !roster) return []
      // eslint-disable-next-line no-await-in-loop -- Read once per look.
      const said = await transcripts(home)
      const told = new Map<string, boolean>()
      for (const worker of roster.workers)
        if (worker.sessionId !== undefined)
          // eslint-disable-next-line no-await-in-loop -- A few sessions at most.
          told.set(worker.sessionId, await said(worker.sessionId))
      const found = verdict(
        { lock, roster, transcribed: (id) => told.get(id) ?? true, running },
        closed.sessionId,
      )
      if (found.settled || Date.now() >= until) return found.end
      // eslint-disable-next-line no-await-in-loop -- Waits for the service to settle.
      await sleep(Math.max(1, Math.min(pollMs, until - Date.now())))
    }
  },
}
