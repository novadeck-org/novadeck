import { open } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"

import type { HarnessEvent } from "./events.js"
import { doorbellNonce, promptStart, type UserEntry } from "./harness.js"
import { rootedIn, type Root } from "./roots.js"

/** How much of a transcript's end is read for its last typed entry, in bytes. */
const tailBytes = 256 * 1024

/**
 * The last thing a transcript records as typed into the agent's box (by the person, or
 * for them, as the doorbell's line), as its harness's `typedEntry` reads a line: null when
 * it holds no typed entry yet; undefined when it can't be read. Only its tail is read.
 */
export const lastUserInput = async (
  path: string,
  typed: (line: string) => UserEntry | undefined,
): Promise<UserEntry | null | undefined> => {
  let text: string
  try {
    const file = await open(path, "r")
    try {
      const { size } = await file.stat()
      const start = Math.max(0, size - tailBytes)
      const buffer = Buffer.alloc(size - start)
      await file.read(buffer, 0, buffer.length, start)
      text = buffer.toString("utf8")
    } finally {
      await file.close()
    }
  } catch {
    return undefined
  }
  // Its first line may be cut, which reads as nothing.
  let last: UserEntry | null = null
  for (const line of text.split("\n")) last = typed(line) ?? last
  return last
}

/** What a harness whose hooks name no prompt gives to tell its root turns' prompts. */
export type TypedPrompts = {
  /** The terminal's root session, whose turns these are. */
  readonly root: Root
  /** How a line of its transcript records something typed, as its profile reads it. */
  readonly typedEntry: (line: string) => UserEntry | undefined
  /** Its transcript, as its hooks named it. */
  readonly transcript: string
  /** The step of the typed entry last read there; -1 for none yet; undefined before any read. */
  readonly seen: number | undefined
  /** When the person's bare Enter came, if a root turn now would be their submission. */
  readonly enteredAt: number | undefined
  /** Whether a ring waits on the prompt: the transcript is looked at a few times. */
  readonly waiting: boolean
  /** The nonce of the doorbell line the agent was started with, as a task, if it was. */
  readonly startedWith?: string | undefined
}

/**
 * Whether a typed entry is new: its step after the one last seen in that transcript; or,
 * before any was read, its time after the person's Enter (rounded down where the
 * transcript is coarser, so one in the Enter's own second fails safe); or, before any read
 * and with no Enter, the very doorbell line the agent was started with, as a task, never
 * a stale one a resumed session's transcript still ends with.
 */
const fresh = (
  entry: UserEntry,
  { seen, enteredAt, startedWith }: Pick<TypedPrompts, "seen" | "enteredAt" | "startedWith">,
) => {
  if (seen !== undefined) return entry.id !== null && entry.id > seen
  if (enteredAt !== undefined) return entry.at !== null && entry.at > enteredAt
  return startedWith !== undefined && doorbellNonce(entry.text) === startedWith
}

/**
 * The facts with a root turn's prompt told, where a harness's hooks name none (as
 * Antigravity's, whose every turn decodes as harness-started): when its transcript holds
 * a new typed entry, the root's harness-started turn becomes `promptStart` of its text, so
 * it goes through the same classifier as Claude Code's and Codex's: a doorbell prompt with
 * its nonce, a continuation, or a prompt with any doorbell line removed. Whose turn it is
 * then, delivery decides. Also what was seen of the transcript, for the next turn.
 */
export const typedPromptStart = async (
  events: readonly HarnessEvent[],
  { root, typedEntry, transcript, seen, enteredAt, waiting, startedWith }: TypedPrompts,
  read: typeof lastUserInput = lastUserInput,
): Promise<{ readonly events: readonly HarnessEvent[]; readonly seen: number | undefined }> => {
  const index = events.findIndex(
    (event) => event.type === "turn-started" && event.cause === "harness" && rootedIn(root, event),
  )
  if (index < 0) return { events, seen }
  // Its transcript may record the input just after the hook runs: a few looks, briefly,
  // while a ring or the person's Enter waits on it; one otherwise, to know what is new.
  const looks = waiting || enteredAt !== undefined ? 2 : 0
  for (let look = 0; ; look += 1) {
    // eslint-disable-next-line no-await-in-loop -- Each look waits for the last.
    const entry = await read(transcript, typedEntry)
    const known = entry === null ? (seen ?? -1) : (entry?.id ?? seen)
    const typed = entry ? fresh(entry, { seen, enteredAt, startedWith }) : false
    if (typed || look === looks) {
      if (!typed || !entry) return { events, seen: known }
      const started = events[index]!
      const { agent, sessionId, instance, startedAt } = started
      return {
        events: events.map((event, at) =>
          at === index ? promptStart({ agent, sessionId, instance, startedAt }, entry.text) : event,
        ),
        seen: known,
      }
    }
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(150)
  }
}
