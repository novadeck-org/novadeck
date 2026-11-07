import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked } from "./model/script.js"
import { prompted, replies, turn } from "./scenarios.js"

// Closing a terminal and bringing it back (History pane), through the real runner and each
// real harness in the sandbox: the row a close leaves, the restore that resumes the same
// conversation and removes the row, a conversation whose file is gone, and Antigravity's
// resume of a conversation it no longer has, which starts a new one without a word.

/** Every path under `root`, relative to it with `/`. */
const walk = (root: string): string[] => {
  const out: string[] = []
  const go = (dir: string) => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      out.push(relative(root, full).replaceAll("\\", "/"))
      try {
        if (statSync(full).isDirectory()) go(full)
      } catch {
        // Gone between the two calls: not in the listing.
      }
    }
  }
  go(root)
  return out
}

for (const setup of setups) {
  describe.skipIf(!supported)(`closing and restoring in ${setup.name}`, () => {
    const it = e2e(setup)

    it("leaves a row on close, restores the same conversation, and refuses one whose file is gone", async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Remember the word heron", "Heron noted."),
        replies("Remember the word egret", "Egret noted."),
        replies("Which word", "The word was heron."),
      )
      const { terminals, store } = run.deck
      const projectId = store.session(run.deck.sessionId).projectId
      const rows = () => store.closed(projectId)
      const make = async (word: string, noted: string) => {
        const terminal = await run.deck.open(setup.agent)
        await terminal.reached("ready", { timeoutMs: 60_000 })
        await prompted(terminal, setup)
        await turn(terminal, `Remember the word ${word}`, noted)
        const id = (await terminal.detail()).sessionId
        if (!id) throw new Error("no session bound after the first prompt")
        return { terminal, id }
      }

      // A close leaves a row that can be restored, naming the session.
      const first = await make("heron", "Heron noted.")
      expect(first.terminal.summary().restorable).toBe(true)
      await terminals.close({ terminalId: first.terminal.id })
      const [row] = rows()
      expect(row).toMatchObject({ id: first.terminal.id, agent: setup.agent, closedBy: null })
      expect(row?.agents[setup.agent]?.sessionId).toBe(first.id)
      expect(row?.agents[setup.agent]?.cwd).toBeTruthy()
      expect((await terminals.history.list(projectId))[0]?.availability).toEqual({ state: "ready" })

      // A restore resumes that conversation as a new terminal, and the row leaves.
      const restored = await run.deck.restoreClosed(row!.id)
      expect(restored.id).not.toBe(first.terminal.id)
      await restored.reached("ready", { timeoutMs: 60_000 })
      // Codex has no id before its first prompt: reaching ready is its sign.
      if (setup.agent !== "codex")
        await expect
          .poll(async () => (await restored.detail()).sessionId, { timeout: 30_000 })
          .toBe(first.id)
      await expect.poll(rows, { timeout: 30_000 }).toEqual([])
      await prompted(restored, setup, 30_000)
      const before = run.model.mark()
      await restored.prompt("Which word")
      await restored.until("The word was heron.", 30_000)
      const call = await run.model.waitFor((one) => !one.side && asked(one, "Which word"), {
        after: before,
        timeoutMs: 30_000,
      })
      expect(call.turns.some((one) => one.text.includes("Remember the word heron"))).toBe(true)
      expect((await restored.detail()).sessionId).toBe(first.id)
      await terminals.close({ terminalId: restored.id })
      // Closing a restored terminal adds a new row, with a new date.
      expect(rows().map(({ id }) => id)).toEqual([restored.id])
      await terminals.history.list(projectId)
      store.removeClosed(restored.id)

      // A conversation whose file is gone is unavailable, and a restore is refused.
      const second = await make("egret", "Egret noted.")
      await terminals.close({ terminalId: second.terminal.id })
      const store_ = /(?:^|\/)(?:projects|sessions|conversations)\//
      for (const path of walk(run.sandbox.home))
        if (store_.test(path) && path.includes(second.id))
          rmSync(join(run.sandbox.home, path), { recursive: true, force: true })
      expect((await terminals.history.list(projectId))[0]?.availability).toEqual({
        state: "gone",
        reason: "conversation",
      })
      await expect(run.deck.restoreClosed(second.terminal.id)).rejects.toMatchObject({
        code: "CONFLICT",
      })
      expect(rows().map(({ id }) => id)).toEqual([second.terminal.id])

      // Where the check can't tell it gone (the harness's whole folder of conversations
      // missing), the restore is tried: Claude Code and Codex exit at once, and Antigravity
      // starts a new conversation silently. None confirms, so the row stays, and the
      // session is free for another restore.
      for (const path of walk(run.sandbox.home))
        if (/(?:^|\/)(?:projects|sessions|conversations)$/.test(path))
          rmSync(join(run.sandbox.home, path), { recursive: true, force: true })
      mkdirSync(join(run.sandbox.home, "elsewhere"), { recursive: true })
      expect((await terminals.history.list(projectId))[0]?.availability).toEqual({ state: "ready" })
      const tried = await run.deck.restoreClosed(second.terminal.id)
      await expect
        .poll(async () => (await terminals.history.list(projectId))[0]?.availability.state, {
          timeout: 60_000,
        })
        .not.toBe("restoring")
      expect(rows().map(({ id }) => id)).toEqual([second.terminal.id])
      await terminals.close({ terminalId: tried.id }).catch(() => undefined)
    })
  })
}
