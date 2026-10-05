import { setTimeout as sleep } from "node:timers/promises"

import type { HarnessEvent } from "./events.js"
import { tailLines } from "./follow.js"
import { replyPreview, type Harness } from "./harness.js"

/** How a harness reads one line of its transcript as items. */
export type Items = NonNullable<Harness["transcripts"]>["items"]

/**
 * The start of what the agent said last since the person's latest prompt and its latest
 * tool step, as its transcript records it, through its harness's items: undefined when
 * it said nothing since, as before its final words are written, or the transcript can't
 * be read. Words before a tool call are its working notes, not its reply. Only its tail
 * is read.
 */
export const lastReply = async (path: string, items: Items): Promise<string | undefined> => {
  const lines = await tailLines(path)
  let reply: string | undefined
  for (const line of lines ?? [])
    for (const { role, kind, text } of items(line)) {
      if (role === "user" || role === "tool" || kind === "tool-call") reply = undefined
      else if (role === "assistant" && kind === "text" && text.trim()) reply = text
    }
  return replyPreview(reply)
}

/**
 * Where among one hook's facts a root turn's end names no reply that its transcript may
 * hold: one the turn ended on its own, as the hook told it; -1 for none. An end the
 * person interrupted, or one told by records, reads nothing.
 */
export const unreplied = (events: readonly HarnessEvent[]): number =>
  events.findIndex(
    (event) =>
      event.type === "turn-ended" &&
      !event.recorded &&
      event.reply === undefined &&
      event.outcome !== "interrupted",
  )

/**
 * The facts of one hook's report, a root turn's end given the start of the agent's last
 * reply where the hook named none (`unreplied`): from the transcript the same report
 * names, as Antigravity's Stop names one, or else from `bound`'s, the transcript or
 * rollout of the session the terminal follows, when the end is that session's, as Claude
 * Code's and Codex's Stop name none.
 */
export const withReplies = async (
  events: readonly HarnessEvent[],
  items: Items | undefined,
  bound?: { readonly sessionId: string; readonly transcript: string | null },
  read: typeof lastReply = lastReply,
  { looks = 4, gapMs = 100 }: { readonly looks?: number; readonly gapMs?: number } = {},
): Promise<readonly HarnessEvent[]> => {
  const index = unreplied(events)
  const ended = events[index]
  if (!ended || !items) return events
  const named = events.find(
    (event) => event.type === "session-observed" && event.sessionId === ended.sessionId,
  )
  const transcript =
    (named?.type === "session-observed" ? named.transcript : undefined) ??
    (bound?.sessionId === ended.sessionId ? bound.transcript : null)
  if (!transcript) return events
  // Claude Code may write the turn's last records just after its Stop hook starts (about
  // 50 ms after, seen in the e2e sandbox with 2.1.287): a few brief looks, which only an
  // end its hook named no reply for waits on.
  let reply: string | undefined
  for (let look = 0; look < looks && reply === undefined; look += 1) {
    // eslint-disable-next-line no-await-in-loop -- Each look waits for the last.
    if (look > 0) await sleep(gapMs)
    // eslint-disable-next-line no-await-in-loop -- As above.
    reply = await read(transcript, items)
  }
  if (reply === undefined) return events
  return events.map((event, at) =>
    at === index && event.type === "turn-ended" ? { ...event, reply } : event,
  )
}
