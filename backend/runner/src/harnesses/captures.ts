import { readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { captureFolder } from "../shell/capture.js"

/**
 * Codex writes a background command's output nowhere Novadeck can read, so Novadeck's own
 * capture keeps it (see shell/capture.ts): each command the agent runs leaves, in its
 * terminal's folder, a log and the record of what its shell was given. This finds the
 * record of a shell the rollout tells of, and so its log, and clears what no shell uses.
 */

/** One command's capture: its log, when it started, and the texts its command may be in. */
export type Capture = {
  readonly log: string
  readonly started: number
  readonly texts: readonly string[]
}

/** How far from the call's time a command's capture may have started to be its own. */
export const startedWithin = { before: 2000, after: 10_000 } as const

// The most of a record read: a shell snapshot's wrapper is larger than the command it runs.
const readChars = 1_000_000

// How a capture's files are named: `out-<id>.<kind>`.
const named = /^out-(.+)\.(log|command|json|out|err)$/

// The script Codex's shell snapshot gives a shell ends in `exec '<shell>' -c '<command>'`, the
// command single-quoted with `'\''` for each quote in it.
const wrapped = /(?:^|\n)exec '[^'\n]*' -c '((?:[^']|'\\'')*)'\s*$/

/** The texts a record's script may hold the command in: as given, and out of Codex's wrapper. */
export const commandTexts = (script: string): string[] => {
  const inner = wrapped.exec(script)?.[1]
  return inner === undefined ? [script] : [script, inner.replaceAll("'\\''", "'")]
}

// A Windows record: the command line novadeck-pwsh was given, whose command is in double
// quotes with each quote in it written `\"`, and when the command started.
const windowsRecord = (json: string): { started?: number; texts: string[] } => {
  try {
    const { commandLine, started } = JSON.parse(json) as {
      commandLine?: unknown
      started?: unknown
    }
    return {
      ...(typeof started === "number" && { started }),
      texts: typeof commandLine === "string" ? [commandLine.replaceAll('\\"', '"')] : [],
    }
  } catch {
    return { texts: [] }
  }
}

const unified = (text: string): string => text.replaceAll("\r\n", "\n").trim()

/** Whether a record's texts hold `command`. */
export const holds = (texts: readonly string[], command: string): boolean => {
  const wanted = unified(command)
  return wanted !== "" && texts.some((text) => unified(text).includes(wanted))
}

/**
 * The first of `captures`, nearest in time to `since`, that is not `claimed`, started
 * within `startedWithin` of it, and holds `command`.
 */
export const matchCapture = (
  captures: readonly Capture[],
  command: string,
  since: number,
  claimed: ReadonlySet<string>,
): Capture | undefined =>
  captures
    .filter(
      ({ log, started, texts }) =>
        !claimed.has(log) &&
        started >= since - startedWithin.before &&
        started <= since + startedWithin.after &&
        holds(texts, command),
    )
    .toSorted((a, b) => Math.abs(a.started - since) - Math.abs(b.started - since))[0]

// The files of a folder by capture id, with the time each last changed; none where it is
// missing or cannot be read.
const filesOf = async (
  folder: string,
): Promise<Map<string, { kinds: Map<string, number>; changed: number }>> => {
  const found = new Map<string, { kinds: Map<string, number>; changed: number }>()
  const names = await readdir(folder).catch(() => [])
  await Promise.all(
    names.map(async (name) => {
      const [, id, kind] = named.exec(name) ?? []
      if (id === undefined || kind === undefined) return
      const info = await stat(join(folder, name)).catch(() => undefined)
      if (!info) return
      const each = found.get(id) ?? {
        kinds: new Map<string, number>(),
        changed: 0,
      }
      each.kinds.set(kind, info.mtimeMs)
      each.changed = Math.max(each.changed, info.mtimeMs)
      found.set(id, each)
    }),
  )
  return found
}

/** The captures a terminal's folder holds that have a log and a record of their command. */
export const readCaptures = async (folder: string): Promise<Capture[]> => {
  const files = await filesOf(folder)
  const captures = await Promise.all(
    [...files].map(async ([id, { kinds }]): Promise<Capture | undefined> => {
      if (!kinds.has("log")) return undefined
      const log = join(folder, `out-${id}.log`)
      if (kinds.has("json")) {
        const text = await readFile(join(folder, `out-${id}.json`), "utf8").catch(() => "")
        const { started, texts } = windowsRecord(text)
        return { log, started: started ?? kinds.get("json")!, texts }
      }
      if (!kinds.has("command")) return undefined
      const script = await readFile(join(folder, `out-${id}.command`), "utf8").catch(() => "")
      return {
        log,
        started: kinds.get("command")!,
        texts: commandTexts(script.slice(0, readChars)),
      }
    }),
  )
  return captures.filter((each) => each !== undefined)
}

/** The tuning of `Captures`, for tests. */
export type CaptureOptions = {
  /** The system's temporary folder the captures are under. */
  readonly temporary?: string
  /** How long between looks for a capture not there yet, and how many looks. */
  readonly pollMs?: number
  readonly polls?: number
  /** How long a capture stays unchanged before it is cleared if no shell uses it. */
  readonly idleMs?: number
  /** How often at most a terminal's folder is cleared. */
  readonly sweepMs?: number
}

/**
 * The captures of Codex's commands, per terminal: finds the log of a shell the rollout
 * told of, clears the captures no shell uses, and removes a closed terminal's folder.
 * Nothing here throws: a folder that is missing or unreadable holds no output.
 */
export class Captures {
  // The logs found for a shell and not yet applied to its terminal's activity, by terminal.
  private readonly pending = new Map<string, Set<string>>()
  private readonly swept = new Map<string, number>()
  private readonly options: Required<CaptureOptions>

  constructor(options: CaptureOptions = {}) {
    this.options = {
      temporary: tmpdir(),
      pollMs: 250,
      polls: 24,
      idleMs: 120_000,
      sweepMs: 30_000,
      ...options,
    }
  }

  /**
   * Looks for the log of a shell that started at `since` with `command`, a few times as the
   * capture may be written after the rollout line, then hands `found` its path. `claimed`
   * gives the logs the terminal's shells have already, which no other shell takes.
   */
  async find(
    terminalId: string,
    { command, since }: { readonly command: string; readonly since: number },
    claimed: () => ReadonlySet<string>,
    found: (path: string) => void,
  ): Promise<void> {
    const folder = captureFolder(terminalId, this.options.temporary)
    const taking = this.pending.get(terminalId) ?? new Set<string>()
    this.pending.set(terminalId, taking)
    try {
      for (let look = 0; look < this.options.polls; look++) {
        if (look > 0)
          // eslint-disable-next-line no-await-in-loop -- Each look waits for the one before.
          await sleep(this.options.pollMs, undefined, { ref: false })
        // eslint-disable-next-line no-await-in-loop -- Each look waits for the one before.
        const captures = await readCaptures(folder).catch(() => [])
        const taken = new Set([...claimed(), ...taking])
        const capture = matchCapture(captures, command, since, taken)
        if (!capture) continue
        taking.add(capture.log)
        try {
          found(capture.log)
        } finally {
          taking.delete(capture.log)
        }
        return
      }
    } catch {
      // No output is known, and the shell is as it was.
    }
  }

  /**
   * Clears a terminal's captures that none of its shells uses (`keep` holds the logs they do)
   * and that have not changed for `idleMs`: at most every `sweepMs` for a terminal.
   */
  async tend(terminalId: string, keep: ReadonlySet<string>, now = Date.now()): Promise<void> {
    const last = this.swept.get(terminalId)
    if (last !== undefined && now - last < this.options.sweepMs) return
    this.swept.set(terminalId, now)
    const folder = captureFolder(terminalId, this.options.temporary)
    const using = new Set([...keep, ...(this.pending.get(terminalId) ?? [])])
    try {
      for (const [id, { changed }] of await filesOf(folder)) {
        if (now - changed < this.options.idleMs || using.has(join(folder, `out-${id}.log`)))
          continue
        // eslint-disable-next-line no-await-in-loop -- One capture at a time.
        await Promise.all(
          ["log", "command", "json", "out", "err"].map((kind) =>
            rm(join(folder, `out-${id}.${kind}`), { force: true }),
          ),
        )
      }
    } catch {
      // What stays is cleared the next time.
    }
  }

  /** Removes a closed terminal's folder with all it holds. */
  async closed(terminalId: string): Promise<void> {
    this.pending.delete(terminalId)
    this.swept.delete(terminalId)
    await rm(captureFolder(terminalId, this.options.temporary), {
      recursive: true,
      force: true,
    }).catch(() => undefined)
  }
}
