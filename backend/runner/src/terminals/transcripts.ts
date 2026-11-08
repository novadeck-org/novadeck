import { stat } from "node:fs/promises"

import { followLines, tailLines } from "@novadeck/harness-core/follow"
import type { Harness, TranscriptEntry } from "@novadeck/harness-core/harness"
import { interruptionEntry, noteEntry } from "@novadeck/harness-core/items"
import { transcriptLimits, type TranscriptChange } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import type { Binding } from "../harnesses/bindings.js"
import { actorOf } from "../harnesses/detail.js"
import { harnesses } from "../harnesses/registry.js"
import { logs } from "../log.js"
import type { Record } from "./record.js"

const log = logs.for("chat")

// Items per change, as the protocol takes them, and how many may wait unread before the
// file's reading pauses.
const batch = transcriptLimits.items
const backlog = 4 * batch

/**
 * Where the person interrupted a turn that the transcript itself doesn't record, as
 * Antigravity's writes no step for an Escape: the last step the file had when they pressed
 * it (its harness's `step`; -1 for none), and when: the mark keeps its place after a runner
 * restart, and after a reset as long as the rewrite keeps each step's index, which a byte
 * offset never would (Antigravity's rewrite on compaction is unprobed).
 */
export type Interruption = { readonly step: number; readonly at: number }

// How much of a transcript's end `lastStep` reads first, growing by `widen` while what it
// read holds no whole line with a step, as a long tool result may fill it.
const tailBytes = 256 * 1024
const widen = 16

/**
 * The latest step `path` holds now, as its harness's `step` reads its lines: -1 for none;
 * undefined when it can't be read. Only its end is read, as much as it takes to hold a
 * step; the latest there, as lines may come out of step order (Antigravity writes results
 * made at once before the step that made the calls).
 */
export const lastStep = async (
  path: string,
  step: (line: string) => number | undefined,
): Promise<number | undefined> => {
  const size = await stat(path).then(
    (file) => file.size,
    () => undefined,
  )
  if (size === undefined) return undefined
  for (let bytes = tailBytes; ; bytes *= widen) {
    // eslint-disable-next-line no-await-in-loop -- Each read is wider than the last.
    const lines = await tailLines(path, Math.min(bytes, size))
    if (!lines) return undefined
    // The first may be cut short, which reads as no step; a line written since is no harm,
    // its step later than the key.
    const found = lines.reduce<number | undefined>((latest, line) => {
      const at = step(line)
      return at === undefined || (latest !== undefined && latest > at) ? latest : at
    }, undefined)
    if (found !== undefined) return found
    if (bytes >= size) return -1
  }
}

/**
 * The interruptions a terminal keeps for an actor of its bound session, by its native id:
 * the root's alone, as only the root's turn is the person's to interrupt.
 */
export const interruptionsOf =
  (record: Pick<Record, "bound" | "interruptions">, native: string | null) =>
  (): readonly Interruption[] =>
    native === null
      ? (record.interruptions ?? []).filter(
          (each) => each.sessionId === record.bound?.binding.sessionId,
        )
      : []

// The unknown shapes the log has told, by harness version (`agent@version`): each once per
// runner, so the one that raised the chat's notice is there beside the metadata a release
// added first: metadata up to `shapesPerVersion` a version, a conversational shape always
// (its containers' types are few); `pnpm transcripts:shapes` lists all of a developer's own
// history.
const toldShapes = new Map<string, Set<string>>()
const shapesPerVersion = 16

// A key as the log may hold it: a tag's name is the person's own text where they typed or
// pasted it (`<acme_notes>…`), so only that it was a tag is told.
const loggable = (key: string): string => key.replace(/(^|\/)tag:[^/]*/g, "$1tag:…")

/**
 * Logs each shape a harness version writes that its decoder has never seen, once per
 * runner: its key, a tag's name left out, and whether it sits inside the conversation,
 * never the line's content. The version is the bound session's, null while its records
 * haven't named one yet.
 */
export const unknownShape = (
  binding: { readonly agent: string; readonly version?: string } | undefined,
  key: string,
  conversational: boolean,
): void => {
  if (!binding) return
  const version = binding.version ?? null
  const shape = loggable(key)
  const at = `${binding.agent}@${version ?? ""}`
  const told = toldShapes.get(at) ?? new Set<string>()
  if (told.has(shape) || (!conversational && told.size >= shapesPerVersion)) return
  told.add(shape)
  toldShapes.set(at, told)
  log.warn("transcript.unknown", "A transcript holds a shape its decoder has never seen.", {
    data: { agent: binding.agent, version, shape, conversational },
  })
}

// A shape that holds the agent's reasoning, by its key, in any harness.
const reasoning = /thinking|reasoning/i

/** What a reading of a transcript tells beside its items. */
export type Reading = {
  /** The interruptions it doesn't record (see `Interruption`). */
  readonly interruptions?: () => readonly Interruption[]
  /** Told each shape a line holds that its decoder has never seen. */
  readonly unknown?: (key: string, conversational: boolean) => void
}

/** The reading of an actor's transcript for a terminal's chat, by the actor's native id. */
export const readingOf = (
  record: Pick<Record, "bound" | "interruptions">,
  native: string | null,
): Reading => ({
  interruptions: interruptionsOf(record, native),
  unknown: (key, conversational) => unknownShape(record.bound?.binding, key, conversational),
})

/**
 * An actor's transcript as changes: every item from the start of `path`, then each one
 * appended, in batches, with `reset` when the file is rewritten; until `signal` aborts.
 * Each of `interruptions` joins them as its item before the person's first item the file got
 * after it, or once all it had then is read: after the turn's last steps, as the words a
 * harness writes just after the key (Antigravity's, up to 0.1 s on), before the next prompt.
 * One told only after the next prompt was read joins at the end, and in its place once the
 * transcript is read again. Where its harness gives lines no `step`, none joins.
 * A line holding a shape its harness's decoder has never seen is told to `unknown`, and one
 * inside the conversation (its harness's `conversational`) leaves a gap among the items, where
 * the chat may be missing words the terminal shows, its text the line as written. Reasoning
 * stays private, so a line that holds some gives no text.
 */
export const transcriptChanges = async function* (
  path: string,
  {
    items,
    step,
    shapes,
    conversational,
  }: Pick<NonNullable<Harness["transcripts"]>, "items"> &
    Partial<Pick<NonNullable<Harness["transcripts"]>, "step" | "shapes" | "conversational">>,
  outer: AbortSignal,
  { interruptions = () => [], unknown }: Reading = {},
): AsyncGenerator<TranscriptChange> {
  // Its own, so leaving early stops the reading as `outer` aborting does.
  const controller = new AbortController()
  const { signal } = controller
  const stop = () => controller.abort()
  outer.addEventListener("abort", stop, { once: true })
  if (outer.aborted) stop()
  const queue: TranscriptChange[] = []
  let collected: Extract<TranscriptChange, { type: "items" }>["items"][number][] = []
  let index = 0
  let queued = 0
  // The latest step of the lines read so far (-1 before any), as lines may come out of
  // step order, and the interruptions told since the file was read from its start.
  let reached = -1
  const told = new Set<string>()
  let wake: (() => void) | undefined
  let resume: (() => void) | undefined
  const notify = () => {
    const waiting = wake
    wake = undefined
    waiting?.()
  }
  const flush = () => {
    if (collected.length === 0) return
    queue.push({ type: "items", items: collected })
    collected = []
    notify()
  }
  const collect = (item: TranscriptEntry) => {
    collected.push({ ...item, index })
    index += 1
    queued += 1
    if (collected.length === batch) flush()
  }
  // The interruptions whose steps are all read by `upTo`, oldest first.
  const interrupted = (upTo: number) => {
    if (!step) return
    for (const each of interruptions().toSorted((a, b) => a.step - b.step || a.at - b.at)) {
      const key = `${each.step}:${each.at}`
      if (each.step > upTo || told.has(key)) continue
      told.add(key)
      collect(interruptionEntry(each.at))
    }
  }
  const reading = followLines(
    path,
    signal,
    (line) => {
      const found = shapes?.(line) ?? []
      let gap = false
      for (const shape of found) {
        if (shape.verdict !== "unknown") continue
        const inside = conversational?.(shape.key) ?? false
        unknown?.(shape.key, inside)
        gap ||= inside
      }
      const read = items(line)
      if (read.some((item) => item.role === "user")) interrupted(reached)
      reached = Math.max(reached, step?.(line) ?? reached)
      for (const item of read) collect(item)
      if (gap) {
        const reasons = found.some(({ key }) => reasoning.test(key))
        collect(noteEntry({ type: "gap" }, null, reasons ? "" : line))
      }
    },
    {
      fromStart: true,
      onIdle: () => {
        interrupted(reached)
        flush()
      },
      onReset: () => {
        queued -= collected.length
        collected = []
        index = 0
        reached = -1
        told.clear()
        queue.push({ type: "reset" })
        notify()
      },
      pace: () =>
        queued <= backlog || signal.aborted
          ? Promise.resolve()
          : new Promise<void>((resolve) => (resume = resolve)),
    },
  )
  const abort = () => {
    notify()
    resume?.()
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    while (!signal.aborted) {
      const next = queue.shift()
      if (!next) {
        // eslint-disable-next-line no-await-in-loop -- Waits for the file to grow.
        await new Promise<void>((resolve) => (wake = resolve))
        continue
      }
      if (next.type === "items") queued -= next.items.length
      if (queued <= backlog) {
        const paused = resume
        resume = undefined
        paused?.()
      }
      yield next
    }
  } finally {
    outer.removeEventListener("abort", stop)
    controller.abort()
    signal.removeEventListener("abort", abort)
    await reading
  }
}

/**
 * Whether a record still holds the session it held, through the new binding object each hook
 * report makes of it (a version learned, a status line): a read that waits on the disk would
 * otherwise find the session gone when a report landed meanwhile.
 */
export const holds = (now: Binding | undefined, then: Binding): boolean =>
  now !== undefined &&
  now.agent === then.agent &&
  now.sessionId === then.sessionId &&
  now.instance === then.instance

/**
 * An actor's conversation in the terminal, as its harness recorded it: every item so far,
 * then each later one, until the terminal's agent leaves the session it belongs to or
 * `signal` aborts. An actor the bound session does not have, or whose harness keeps no
 * transcript Novadeck reads, is NOT_FOUND.
 */
export const followTranscript = async function* (
  record: Record,
  actor: string,
  signal?: AbortSignal,
): AsyncGenerator<TranscriptChange> {
  const { bound, transcript: root } = record
  const source = bound && harnesses[bound.binding.agent].transcripts
  const native = bound && actorOf(bound.binding, bound.activity, actor)
  if (!bound || !source || !root || native === undefined) throw new DomainError("NOT_FOUND")
  const path = await source.locate(root, bound.binding.sessionId, native)
  if (!path || !holds(record.bound?.binding, bound.binding)) throw new DomainError("NOT_FOUND")
  const reader = new AbortController()
  record.sourceReaders.add(reader)
  const abort = () => reader.abort()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) reader.abort()
  try {
    yield* transcriptChanges(path, source, reader.signal, readingOf(record, native))
  } finally {
    signal?.removeEventListener("abort", abort)
    reader.abort()
    record.sourceReaders.delete(reader)
  }
}
