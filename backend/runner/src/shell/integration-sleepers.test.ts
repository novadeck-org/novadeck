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

// Where closed terminals are kept, as the runner is given them.
const history = (shell: Fixture) => ({
  closed: shell.store,
  projects: () => shell.store.projects().map(({ id }) => id),
})

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

    it("leaves no wake timer behind once the manager shuts down", async ({ shell }) => {
      sleeper(shell, "claude", "abc-1", { turn: "running" })
      const manager = shell.manager()
      const sleepers = (manager as unknown as { sleepers: { timers: Map<string, unknown> } })
        .sleepers
      // The turn the stop cut short owes a wake, which waits out its grace for a client.
      await vi.waitFor(() => expect(sleepers.timers.size).toBe(1))
      await manager.shutdown()
      expect(sleepers.timers.size).toBe(0)
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

    it("closes a sleeper into History with its agent session, and restoring it is a new terminal on that session", async ({
      shell,
    }) => {
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      fakeAgent(shell.home, "claude")
      const id = sleeper(shell, "claude", "abc-1")
      const manager = shell.manager(history(shell))
      const project = shell.store.session(shell.sessionId).projectId
      // Judged restorable (the stand-in install has no files to find gone).
      await vi.waitFor(() =>
        expect(manager.list().find((each) => each.id === id)).toMatchObject({
          sleeping: true,
          restorable: true,
          busy: false,
        }),
      )
      const stream = manager.watchMessages(id)
      await stream.next()
      const ended = stream.next()
      await manager.close({ terminalId: id }, "moth")
      // Gone from the live list, its stream ended, its resting presence dropped...
      expect(manager.list().find((each) => each.id === id)).toBeUndefined()
      await expect(ended).resolves.toMatchObject({ done: true })
      expect(() => manager.get(id)).toThrow(expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }))
      // ...and kept as a History row with the session, as any closed agent is.
      const [row] = shell.store.closed(project)
      expect(row).toMatchObject({ id, agent: "claude", closedBy: "moth" })
      expect(row?.agents.claude).toMatchObject({ sessionId: "abc-1" })
      expect((await manager.history.list(project))[0]?.availability).toEqual({ state: "ready" })

      const restored = randomUUID()
      const made = await manager.create(
        {
          id: restored,
          sessionId: shell.sessionId,
          cwd: shell.home,
          cols: 100,
          rows: 20,
          closed: id,
        },
        "owner",
      )
      expect(made.id).toBe(restored)
      expect(restored).not.toBe(id)
      expect(made).toMatchObject({ sleeping: false, started: true })
      await shell.until(manager, restored, "claude args: --resume abc-1")
      // The closed terminal never comes back as a sleeper beside the new one.
      expect(manager.list().filter((each) => each.sleeping)).toEqual([])
    })

    it("holds a session for a sleeper, not for a row closed from another terminal", async ({
      shell,
    }) => {
      const closing = sleeper(shell, "claude", "same-1")
      const other = sleeper(shell, "claude", "same-1")
      const manager = shell.manager(history(shell))
      const project = shell.store.session(shell.sessionId).projectId
      await manager.close({ terminalId: closing })
      const [row] = await manager.history.list(project)
      // The other sleeper rests on the session: restoring the row would run it twice.
      expect(row?.availability).toMatchObject({ state: "open", terminalId: other })
      await expect(
        manager.create(
          {
            id: randomUUID(),
            sessionId: shell.sessionId,
            cwd: shell.home,
            cols: 100,
            rows: 20,
            closed: closing,
          },
          "owner",
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" })
      // Once that sleeper is closed too, nothing holds it.
      await manager.close({ terminalId: other })
      const rows = await manager.history.list(project)
      expect(rows.map((each) => each.availability.state)).toEqual(["ready"])
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
