import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import type { PromptShown } from "../events.js"
import type { Install } from "../harness.js"

/**
 * The items Novadeck's shim gives Codex's terminal title, as one `-c` setting: its run
 * state, then the start of its thread's id, as "Ready | 01a0f932-a824-7c30-b713-b59ed...".
 * Novadeck shows no terminal's own title, so the person never sees it.
 */
export const titleSetting = "tui.terminal_title=['status','thread-id']"

// The run states Codex's `status` item says (`run_state_status_text` in its TUI, 0.159.3).
const states = new Set(["Ready", "Working", "Thinking", "Waiting", "Starting"])

// The start of a thread's id, which it cuts short with an ellipsis.
const threadId = /^([0-9a-f]{8}(?:-[0-9a-f]+)*)(?:\.\.\.|…)?$/

/**
 * Whether Codex's title says its prompt shows: of its items, joined by " | ", exactly one
 * is a run state, and it is Ready, and exactly one is a thread's id. Codex says Ready only
 * once its own prompt is up: never behind its folder-trust, hooks review, sign-in, update
 * or resume picker screens (probed 2026-10-01, 0.159.3); Working during a turn, Ready again
 * after. So any title the person gives it with `status` and `thread-id` among its items
 * tells as well as the shim's; one without its thread's id tells nothing.
 */
export const title = (text: string, at: number): PromptShown | undefined => {
  const parts = text.split(" | ")
  const said = parts.filter((part) => states.has(part))
  const ids = parts.flatMap((part) => threadId.exec(part)?.[1] ?? [])
  if (said.length !== 1 || said[0] !== "Ready" || ids.length !== 1) return undefined
  return {
    type: "prompt-shown",
    agent: "codex",
    instance: null,
    startedAt: at,
    sessionPrefix: ids[0]!,
  }
}

/** Whether Codex's title says a turn runs: its one run state is past Ready and Starting. */
export const titleWorking = (text: string): boolean => {
  const said = text.split(" | ").filter((part) => states.has(part))
  return said.length === 1 && said[0] !== "Ready" && said[0] !== "Starting"
}

/**
 * The shortest start of a thread's id that may confirm a new thread. Codex's ids are
 * UUIDv7: 12 hex digits of milliseconds, then the version digit and 3 random ones, then a
 * group whose first 2 bits are the variant and 14 random. Through that group, 23
 * characters, two threads started in the same millisecond share it with odds of 1 in
 * 2^26 (about 67 million); a shorter start, down to the bare time, may name another
 * thread of the same moment, so it never confirms one.
 */
export const confirmingPrefix = 23

/**
 * Whether Codex just started, as a new root thread, the thread whose id starts with
 * `prefix`. It writes and holds a lock for each thread it starts through its thread store
 * (`live_writer::create_thread`, 0.159.3): a new or cleared root, but also an agent it
 * spawns (with `parent_thread_id`); none for an ephemeral `/side` fork, whose id its title
 * shows alike. So the lock must be made from a second before the title to a moment after
 * it (an agent's was made at its spawn, inside an earlier turn), and, where `holds` can
 * tell, held by a process of the terminal's foreground group, where its Codex runs (a
 * wrapper may run the program that holds it). The caller rules out a turn running as the title
 * came, as agents are spawned only within one.
 */
export const startedSession = async (
  where: Install,
  prefix: string,
  since: number,
  holds?: (path: string) => Promise<boolean | undefined>,
  waitMs = 2_000,
): Promise<boolean> => {
  if (prefix.length < confirmingPrefix) return false
  const home = where.env.CODEX_HOME || join(where.home, ".codex")
  const locks = join(home, "thread-writer-locks")
  const until = Date.now() + waitMs
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- Looked for again until it shows.
    const names = await readdir(locks).catch(() => [] as string[])
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".lock")) continue
      const path = join(locks, name)
      // eslint-disable-next-line no-await-in-loop -- Few locks share a thread's prefix.
      const made = await stat(path).then(
        (file) => file.mtimeMs,
        () => 0,
      )
      // A second of slack either way for clocks that round.
      if (made < since - 1_000 || made > since + waitMs + 1_000) continue
      // eslint-disable-next-line no-await-in-loop -- As above.
      if ((await holds?.(path)) !== false) return true
    }
    if (Date.now() >= until) return false
    // eslint-disable-next-line no-await-in-loop -- As above.
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
