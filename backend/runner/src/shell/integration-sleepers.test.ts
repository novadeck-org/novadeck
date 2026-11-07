import { randomUUID } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"
import { vi } from "vitest"

import { describe, expect } from "../test.js"
import { bash, create, fakeAgent, it, type Fixture } from "./integration.test-support.js"

/** A terminal saved as an earlier runner left it: `agent` in its foreground, its session known. */
const sleeper = (
  shell: Fixture,
  agent: AgentName,
  sessionId: string,
  extra: { lastProgram?: string | null; turn?: "running"; ledBy?: string } = {},
): string => {
  const id = randomUUID()
  shell.store.saveTerminal({
    id,
    sessionId: shell.sessionId,
    cwd: shell.home,
    handle: shell.store.giveHandle(shell.sessionId),
    naming: { person: null, opener: null, murmur: null, own: null, summary: null },
    openedBy: null,
    ledBy: extra.ledBy ?? null,
    command: null,
    lastProgram: extra.lastProgram === undefined ? agent : extra.lastProgram,
    work: null,
    agents: { [agent]: { sessionId, seq: 1, ...(extra.turn && { turn: extra.turn }) } },
    promptedAt: null,
  })
  return id
}

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "bash shell integration: sleeping agents",
  () => {
    it("lists a saved terminal whose agent can resume as asleep, with that agent", async ({
      shell,
    }) => {
      const id = sleeper(shell, "claude", "abc-1")
      const plain = sleeper(shell, "claude", "abc-2", { lastProgram: "bash" })
      const manager = shell.manager()
      const listed = manager.list(shell.sessionId)
      expect(listed.find((each) => each.id === id)).toMatchObject({
        sleeping: true,
        restingAgent: "claude",
        started: false,
      })
      // A shell that ran an agent long ago, with no agent left in its foreground, is plain.
      expect(listed.find((each) => each.id === plain)).toMatchObject({
        sleeping: false,
        restingAgent: null,
        lastTurnAt: null,
      })
    })

    it("rests Codex saved as the node process an npm install runs as", async ({ shell }) => {
      const id = sleeper(shell, "codex", "codex-1", { lastProgram: "node" })
      const manager = shell.manager()
      expect(manager.list().find((each) => each.id === id)).toMatchObject({
        sleeping: true,
        restingAgent: "codex",
      })
    })

    it("rests nothing where a shell can't run a resume", async ({ shell }) => {
      const id = sleeper(shell, "claude", "abc-1")
      const manager = shell.manager({ shellArgs: ["--norc"] })
      expect(manager.list().find((each) => each.id === id)).toMatchObject({ sleeping: false })
    })

    it("wakes when it is created, resuming the same session, and is no longer asleep", async ({
      shell,
    }) => {
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      fakeAgent(shell.home, "claude")
      const id = sleeper(shell, "claude", "abc-1")
      const manager = shell.manager()
      const created = await create(manager, shell, {
        id,
        restore: true,
        resume: "claude",
      })
      expect(created).toMatchObject({ sleeping: false, restingAgent: null, started: true })
      await shell.until(manager, id, "claude args: --resume abc-1")
    })

    it("leaves a wake nobody is looking at asleep when it can't resume, and fails it", async ({
      shell,
    }) => {
      const id = sleeper(shell, "claude", "abc-1")
      const manager = shell.manager({ connected: () => Promise.resolve(false) })
      await expect(
        create(manager, shell, { id, restore: true, resume: "claude" }),
      ).rejects.toMatchObject({ code: "SPAWN_FAILED" })
      expect(manager.list().find((each) => each.id === id)).toMatchObject({ sleeping: true })
    })

    it("starts a plain shell for a wake the person is looking at, keeping its lead", async ({
      shell,
    }) => {
      const lead = sleeper(shell, "claude", "lead-1")
      const handle = shell.store.terminal(lead)!.handle
      const id = sleeper(shell, "claude", "abc-1", { ledBy: handle })
      const manager = shell.manager({ connected: () => Promise.resolve(false) })
      const created = await manager.create(
        {
          id,
          sessionId: shell.sessionId,
          cwd: shell.home,
          cols: 100,
          rows: 20,
          restore: true,
          resume: "claude",
          seen: true,
        },
        "owner",
      )
      expect(created).toMatchObject({ ledBy: handle, sleeping: false })
      const shown = await shell.until(manager, id, "wasn't resumed")
      expect(shown).toContain("Novadeck isn't connected to Claude Code")
      // The row still names its agent: the next start rests it again.
      expect(shell.store.terminal(id)?.lastProgram).toBe("claude")
    })

    it("wakes by itself, after a short grace, a turn the stop cut short, with no client", async ({
      shell,
    }) => {
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      fakeAgent(shell.home, "claude")
      const id = sleeper(shell, "claude", "abc-1", { turn: "running" })
      const manager = shell.manager()
      // Asked for at start, judged, and after the grace created by the runner itself.
      await vi.waitFor(
        () =>
          expect(manager.list().find((each) => each.id === id)).toMatchObject({ started: true }),
        { timeout: 8_000 },
      )
      await shell.until(manager, id, "claude args: --resume abc-1")
    })

    it("ends a sleeper's message stream when it is closed", async ({ shell }) => {
      const id = sleeper(shell, "claude", "abc-1")
      const manager = shell.manager()
      const stream = manager.watchMessages(id)
      await stream.next()
      const ended = stream.next()
      await manager.close({ terminalId: id })
      await expect(ended).resolves.toMatchObject({ done: true })
    })

    it("takes the person's feedback request for a terminal that is waking", async ({ shell }) => {
      const id = sleeper(shell, "claude", "abc-1", { turn: "running" })
      const manager = shell.manager()
      await vi.waitFor(() =>
        expect(manager.list().find((each) => each.id === id)).toMatchObject({
          sleeping: false,
          started: false,
        }),
      )
      expect(() => manager.feedback.ask(id, "how was it")).not.toThrow(
        expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
      )
    })
  },
)
