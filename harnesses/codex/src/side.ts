import { createReadStream } from "node:fs"

import type { SessionObserved } from "@novadeck/harness-core/events"

// How much of a rollout's first line is read for its `session_meta`: it holds the thread's
// instructions, tens of kilobytes.
const metaBytes = 1 << 20

/** The file's first line, as far as `metaBytes` reach; undefined where it can't be read. */
const firstLine = (path: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    let text = ""
    const stream = createReadStream(path, { encoding: "utf8", end: metaBytes - 1 })
    stream.on("data", (chunk) => {
      text += chunk
      const end = text.indexOf("\n")
      if (end < 0) return
      resolve(text.slice(0, end))
      stream.destroy()
    })
    stream.on("end", () => resolve(undefined))
    stream.on("error", () => resolve(undefined))
  })

/** The source Codex's TUI gives a `/side` conversation it keeps (`ATTACHED_SIDE_CHAT_SOURCE`). */
export const sideSource = "tui_side_chat"

/**
 * Whether the rollout is a side conversation's, kept with its root: from 0.171.0 Codex keeps a
 * `/side` conversation as a thread of its own, with a writer lock and a rollout, whose
 * `session_meta` marks it `attached_thread`, its `thread_source` "tui_side_chat", forked from
 * the root (probed 2026-11-20, e2e/probes/codex-side.e2e.ts). Up to 0.170.0 it was ephemeral by
 * default, with neither (the kept thread is behind the `tui_workspace` feature there, off by default: `app/side.rs`, v0.170.0 source). Undefined where the rollout's first record can't be read: Codex writes a new
 * root's only once it has records to keep, a kept side conversation's as it makes the thread.
 */
export const sideRollout = async (path: string): Promise<boolean | undefined> => {
  const line = await firstLine(path)
  if (line === undefined) return undefined
  try {
    const { type, payload } = JSON.parse(line) as {
      type?: unknown
      payload?: { attached_thread?: unknown; thread_source?: unknown }
    }
    if (type !== "session_meta") return undefined
    return payload?.attached_thread === true || payload?.thread_source === sideSource
  } catch {
    return undefined
  }
}

/**
 * A session its hooks name that is a kept side conversation: its `SessionStart` says `fork`, as
 * a `/fork` that the person goes on in does too, and names its rollout, which tells them apart.
 */
export const aside = async (event: SessionObserved): Promise<boolean> =>
  event.transcript !== undefined && (await sideRollout(event.transcript)) === true
