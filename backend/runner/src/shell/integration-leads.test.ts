import { randomUUID } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect } from "../test.js"
import {
  bash,
  it,
  create,
  reporter,
  fakeAgent,
  fakeClaude,
  type Fixture,
} from "./integration.test-support.js"

// A lead's terminal moth and a worker fox it leads, kept as an earlier runner left them; the
// worker's saved agent session when one is given.
const keepLed = (shell: Fixture, ids: { lead: string; worker: string }, session?: string) => {
  for (const [id, handle, ledBy] of [
    [ids.lead, "moth", null],
    [ids.worker, "fox", "moth"],
  ] as const)
    shell.store.saveTerminal({
      id,
      sessionId: shell.sessionId,
      cwd: shell.home,
      handle,
      naming: { person: null, opener: null, murmur: null, summary: null },
      openedBy: ledBy,
      ledBy,
      command: null,
      lastProgram: null,
      work: null,
      agents: id === ids.worker && session ? { claude: { sessionId: session, seq: 1 } } : {},
      promptedAt: null,
    })
}

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "bash shell integration: kept terminals and leads across restarts",
  () => {
    it("keeps a terminal from an earlier runner, with its title, until it is closed", async ({
      shell,
    }) => {
      const id = randomUUID()
      const first = shell.manager()
      await create(first, shell, { id })
      first.rename({ terminalId: id, title: "API author" })
      await first.shutdown()
      expect(shell.store.terminal(id)).toBeDefined()
      const second = shell.manager()
      // The new runner lists it, with no shell yet, and renames it as it is.
      expect(second.list(shell.sessionId)).toMatchObject([
        { id, title: "API author", started: false, run: 0, exit: null },
      ])
      second.rename({ terminalId: id, title: "API server" })
      expect(shell.store.terminal(id)?.naming.person).toBe("API server")
      // Its title handed back to Novadeck while kept: automatic again, the default here.
      second.resetTitle({ terminalId: id })
      expect(second.list(shell.sessionId)).toMatchObject([
        { id, title: "Terminal", titleSource: { kind: "default" } },
      ])
      expect(shell.store.terminal(id)?.naming.person).toBeNull()
      // Renamed again while it restores, as from another window: the rename stands.
      const restoring = create(second, shell, { id, restore: true })
      second.rename({ terminalId: id, title: "API" })
      await expect(restoring).resolves.toMatchObject({ title: "API" })
      expect(shell.store.terminal(id)?.naming.person).toBe("API")
      await second.close({ terminalId: id })
      expect(shell.store.terminal(id)).toBeUndefined()
      expect(second.list(shell.sessionId)).toEqual([])
      await expect(second.close({ terminalId: id })).rejects.toMatchObject({
        code: "TERMINAL_NOT_FOUND",
      })
      expect(() => second.rename({ terminalId: id, title: "x" })).toThrow(
        expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
      )
    })

    it("shows kept terminals their stored lead, and ends it for a restore that resumes nothing", async ({
      shell,
    }) => {
      const [lead, worker, plain] = [randomUUID(), randomUUID(), randomUUID()]
      const keep = (
        id: string,
        handle: string,
        openedBy: string | null,
        leader: string | null,
        command: string | null = null,
      ) =>
        shell.store.saveTerminal({
          id,
          sessionId: shell.sessionId,
          cwd: shell.home,
          handle,
          naming: { person: null, opener: null, murmur: null, summary: null },
          openedBy,
          ledBy: leader,
          command,
          lastProgram: null,
          work: null,
          agents: {},
          promptedAt: null,
        })
      keep(lead, "moth", null, null)
      // Opened by moth with a brief for an agent, and opened by moth for a command that starts
      // one: only the first is led.
      keep(worker, "fox", "moth", "moth")
      keep(plain, "owl", "moth", null, "claude")
      const manager = shell.manager()
      // What summaries carry is the stored lead, whether or not its terminal runs.
      expect(manager.list(shell.sessionId).map(({ ledBy }) => ledBy)).toEqual([null, "moth", null])
      // Restored as a shell that resumes nothing, the worker has no agent left to lead.
      await create(manager, shell, { id: worker, restore: true })
      await create(manager, shell, { id: plain, restore: true })
      await create(manager, shell, { id: lead, restore: true })
      expect(manager.get(worker).ledBy).toBeNull()
      expect(shell.store.terminalIdentity(worker)?.ledBy).toBeNull()
      expect(manager.get(plain).ledBy).toBeNull()
    })

    it("remembers across a restart that an agent has run in a terminal", async ({ shell }) => {
      const [ran, unused] = [randomUUID(), randomUUID()]
      shell.saveSession(ran, "claude", randomUUID())
      shell.store.saveTerminal({
        id: unused,
        sessionId: shell.sessionId,
        cwd: shell.home,
        handle: shell.store.giveHandle(shell.sessionId),
        naming: { person: null, opener: null, murmur: null, summary: null },
        openedBy: null,
        ledBy: null,
        command: null,
        lastProgram: null,
        work: null,
        agents: {},
        promptedAt: null,
      })
      const manager = shell.manager()
      expect(manager.list(shell.sessionId).map(({ id, agentRan }) => ({ id, agentRan }))).toEqual(
        expect.arrayContaining([
          { id: ran, agentRan: true },
          { id: unused, agentRan: false },
        ]),
      )
    })

    it("keeps a worker's lead through a restore, and ends it when its agent exits", async ({
      shell,
    }) => {
      const session = randomUUID()
      fakeClaude(shell.home, shell.plugins, session)
      reporter(shell.home, [
        { agent: "claude", sessionId: "brand-new", seq: 1, source: "startup" },
        // /clear in the agent in the foreground: a new session of the same agent.
        { agent: "claude", sessionId: "cleared", seq: 2, source: "clear" },
      ])
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const [lead, worker] = [randomUUID(), randomUUID()]
      const keep = (id: string, handle: string, ledBy: string | null) =>
        shell.store.saveTerminal({
          id,
          sessionId: shell.sessionId,
          cwd: shell.home,
          handle,
          naming: { person: null, opener: null, murmur: null, summary: null },
          openedBy: ledBy,
          ledBy,
          command: null,
          lastProgram: null,
          work: null,
          agents: id === worker ? { claude: { sessionId: session, seq: 1 } } : {},
          promptedAt: null,
        })
      keep(lead, "moth", null)
      keep(worker, "fox", "moth")
      const manager = shell.manager()
      const next = shell.watch(manager)
      await create(manager, shell, { id: lead, restore: true })
      // Restored by a new runner, its agent resumed there: the lead stays, kept as saved.
      await create(manager, shell, { id: worker, restore: true, resume: "claude" })
      await next((summary) => summary.id === worker && summary.agent === "claude")
      expect(manager.get(worker).ledBy).toBe("moth")
      // Enter ends the stand-in agent, and the lead ends with it.
      manager.write({ terminalId: worker, data: "\r" }, "owner")
      await expect.poll(() => manager.get(worker).ledBy).toBeNull()
      expect(shell.store.terminalIdentity(worker)?.ledBy).toBeNull()
      expect(shell.store.terminalIdentity(lead)?.ledBy).toBeNull()
    })

    it("starts a worker lost before its agent's first session again with its task, still led", async ({
      shell,
    }) => {
      fakeAgent(shell.home, "codex")
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const task = 'codex "[Novadeck: automatic notice, agent messages waiting, k3f9q2]"'
      const [lead, worker, ran] = [randomUUID(), randomUUID(), randomUUID()]
      const keep = (id: string, handle: string, ledBy: string | null, agents = {}) =>
        shell.store.saveTerminal({
          id,
          sessionId: shell.sessionId,
          cwd: shell.home,
          handle,
          naming: { person: null, opener: null, murmur: null, summary: null },
          openedBy: ledBy,
          ledBy,
          command: ledBy ? task : null,
          lastProgram: null,
          work: null,
          agents,
          promptedAt: null,
        })
      keep(lead, "moth", null)
      keep(worker, "fox", "moth")
      keep(ran, "owl", "moth", { codex: { sessionId: "t-1", seq: 1 } })
      const manager = shell.manager()
      await create(manager, shell, { id: lead, restore: true })
      await create(manager, shell, { id: worker, restore: true })
      await create(manager, shell, { id: ran, restore: true })
      // Lost behind its trust screen, as a reboot leaves it: its task's line starts it again.
      await shell.until(
        manager,
        worker,
        "codex args: [Novadeck: automatic notice, agent messages waiting, k3f9q2]",
      )
      expect(manager.get(worker).ledBy).toBe("moth")
      expect(shell.store.terminalIdentity(worker)?.ledBy).toBe("moth")
      // One whose agent ran resumes that session or comes back a shell, no longer led.
      expect(manager.get(ran).ledBy).toBeNull()
      expect(shell.store.terminalIdentity(ran)?.ledBy).toBeNull()
    })

    it("keeps a worker's lead while its agent is only suspended, as Ctrl+Z leaves it", async ({
      shell,
    }) => {
      const session = randomUUID()
      fakeClaude(shell.home, shell.plugins, session)
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const ids = { lead: randomUUID(), worker: randomUUID() }
      keepLed(shell, ids, session)
      const manager = shell.manager()
      const next = shell.watch(manager)
      await create(manager, shell, { id: ids.lead, restore: true })
      await create(manager, shell, { id: ids.worker, restore: true, resume: "claude" })
      await next((summary) => summary.id === ids.worker && summary.agent === "claude")
      // Ctrl+Z: the shell's prompt returns while the agent still exists.
      manager.write({ terminalId: ids.worker, data: "\x1a" }, "owner")
      await shell.until(manager, ids.worker, "Stopped")
      manager.write({ terminalId: ids.worker, data: "echo back\r" }, "owner")
      await shell.until(manager, ids.worker, /\nback\r?\n/)
      expect(manager.get(ids.worker).ledBy).toBe("moth")
      expect(shell.store.terminalIdentity(ids.worker)?.ledBy).toBe("moth")
      // Killed while suspended, it never comes back: the next prompt finds it gone.
      manager.write(
        { terminalId: ids.worker, data: "kill -9 $(jobs -p); sleep 0.3; echo killed\r" },
        "owner",
      )
      await shell.until(manager, ids.worker, /\nkilled\r?\n/)
      manager.write({ terminalId: ids.worker, data: "echo later\r" }, "owner")
      await expect.poll(() => manager.get(ids.worker).ledBy).toBeNull()
    })

    it("ends a worker's lead when the person starts another agent beside its suspended one", async ({
      shell,
    }) => {
      const session = randomUUID()
      fakeClaude(shell.home, shell.plugins, session)
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const ids = { lead: randomUUID(), worker: randomUUID() }
      keepLed(shell, ids, session)
      const manager = shell.manager()
      const next = shell.watch(manager)
      await create(manager, shell, { id: ids.lead, restore: true })
      await create(manager, shell, { id: ids.worker, restore: true, resume: "claude" })
      await next((summary) => summary.id === ids.worker && summary.agent === "claude")
      manager.write({ terminalId: ids.worker, data: "\x1a" }, "owner")
      await shell.until(manager, ids.worker, "Stopped")
      manager.write({ terminalId: ids.worker, data: "echo back\r" }, "owner")
      await shell.until(manager, ids.worker, /\nback\r?\n/)
      expect(manager.get(ids.worker).ledBy).toBe("moth")
      // Another agent, not the suspended one back from `fg`, binds there: the lead never
      // directed it.
      manager.write({ terminalId: ids.worker, data: "claude\r" }, "owner")
      await expect.poll(() => manager.get(ids.worker).ledBy).toBeNull()
      expect(shell.store.terminalIdentity(ids.worker)?.ledBy).toBeNull()
    })

    it("announces the lead's end with the new binding and its activity together", async ({
      shell,
    }) => {
      const session = randomUUID()
      fakeClaude(shell.home, shell.plugins, session)
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const ids = { lead: randomUUID(), worker: randomUUID() }
      keepLed(shell, ids, session)
      const manager = shell.manager()
      const next = shell.watch(manager)
      await create(manager, shell, { id: ids.lead, restore: true })
      await create(manager, shell, { id: ids.worker, restore: true, resume: "claude" })
      await next((summary) => summary.id === ids.worker && summary.agent === "claude")
      manager.write({ terminalId: ids.worker, data: "\x1a" }, "owner")
      await shell.until(manager, ids.worker, "Stopped")
      manager.write({ terminalId: ids.worker, data: "echo back\r" }, "owner")
      await shell.until(manager, ids.worker, /\nback\r?\n/)
      expect(manager.get(ids.worker).ledBy).toBe("moth")
      // What the record holds each time its detail is told of a change, read as it is told.
      type Seen = {
        ledBy: string | null
        agent: string | null
        activity: string | null
        fresh: boolean
      }
      const seen: Seen[] = []
      const { streams } = manager as unknown as {
        streams: {
          detailed: (record: {
            summary: { id: string; ledBy: string | null }
            bound: {
              binding: { agent: string }
              activity: { state: string; turn: unknown; lastTurn: unknown }
            } | null
          }) => void
        }
      }
      const detailed = streams.detailed.bind(streams)
      streams.detailed = (record) => {
        if (record.summary.id === ids.worker)
          seen.push({
            ledBy: record.summary.ledBy,
            agent: record.bound?.binding.agent ?? null,
            activity: record.bound?.activity.state ?? null,
            // As it bound: no turn yet, and none before.
            fresh: record.bound?.activity.turn === null && record.bound.activity.lastTurn === null,
          })
        detailed(record)
      }
      // Another agent binds beside the suspended one, ending the lead as it binds.
      manager.write({ terminalId: ids.worker, data: "claude\r" }, "owner")
      await expect.poll(() => manager.get(ids.worker).ledBy).toBeNull()
      await expect.poll(() => manager.get(ids.worker).agent).toBe("claude")
      // A report binds the session with its fresh activity, one value (`Record.bound`), so the
      // lead's end, announced as it binds, shows the new binding with its own activity.
      const ended = seen.findIndex(({ ledBy }) => ledBy === null)
      expect(seen[ended]).toEqual({ ledBy: null, agent: "claude", activity: "idle", fresh: true })
    })

    it("ends a worker's lead when its agent exits before any session bound, and its brief is gone", async ({
      shell,
    }) => {
      fakeAgent(shell.home, "claude")
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const ids = { lead: randomUUID(), worker: randomUUID() }
      keepLed(shell, ids)
      const manager = shell.manager()
      await create(manager, shell, { id: ids.lead, restore: true })
      await create(manager, shell, { id: ids.worker, restore: true, command: "claude" })
      await shell.until(manager, ids.worker, "claude args:")
      const brief = (
        manager as unknown as {
          messaging: { send: (from: string, request: object) => { ok: boolean } }
        }
      ).messaging.send(ids.lead, { to: "fox", text: "Do the work." })
      expect(brief.ok).toBe(true)
      expect(manager.get(ids.worker).ledBy).toBe("moth")
      // Enter ends the stand-in agent, which never bound a session.
      manager.write({ terminalId: ids.worker, data: "\r" }, "owner")
      await expect.poll(() => manager.get(ids.worker).ledBy).toBeNull()
      expect(manager.messages(ids.worker).threads[0]?.messages[0]).toMatchObject({
        text: "Do the work.",
        state: "gone",
      })
    })

    it("keeps a worker's lead through a restart that resumes its agent, and ends it when none does", async ({
      shell,
    }) => {
      const session = randomUUID()
      fakeClaude(shell.home, shell.plugins, session)
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const ids = { lead: randomUUID(), worker: randomUUID() }
      keepLed(shell, ids, session)
      const manager = shell.manager()
      const next = shell.watch(manager)
      await create(manager, shell, { id: ids.lead, restore: true })
      // Its startup command ends the shell, as a killed agent's terminal ends.
      await create(manager, shell, { id: ids.worker, restore: true, command: "exec true" })
      await next((summary) => summary.id === ids.worker && summary.exit !== null)
      expect(manager.get(ids.worker).ledBy).toBe("moth")
      await manager.restart(
        { terminalId: ids.worker, cols: 100, rows: 20, resume: "claude" },
        "owner",
      )
      expect(manager.get(ids.worker).ledBy).toBe("moth")
      await shell.until(manager, ids.worker, "claude is running")
      manager.write({ terminalId: ids.worker, data: "\r" }, "owner")
      await expect.poll(() => manager.get(ids.worker).ledBy).toBeNull()
    })

    it("ends a worker's lead when it restarts as a plain shell", async ({ shell }) => {
      const ids = { lead: randomUUID(), worker: randomUUID() }
      keepLed(shell, ids)
      const manager = shell.manager()
      const next = shell.watch(manager)
      await create(manager, shell, { id: ids.lead, restore: true })
      await create(manager, shell, { id: ids.worker, restore: true, command: "exec true" })
      await next((summary) => summary.id === ids.worker && summary.exit !== null)
      expect(manager.get(ids.worker).ledBy).toBe("moth")
      await manager.restart({ terminalId: ids.worker, cols: 100, rows: 20 }, "owner")
      expect(manager.get(ids.worker).ledBy).toBeNull()
      expect(shell.store.terminalIdentity(ids.worker)?.ledBy).toBeNull()
    })

    it("ends a worker's lead when typing cancels its startup, and its brief is gone", async ({
      shell,
    }) => {
      const session = randomUUID()
      fakeClaude(shell.home, shell.plugins, session)
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\nsleep 1\n')
      const ids = { lead: randomUUID(), worker: randomUUID() }
      keepLed(shell, ids, session)
      const manager = shell.manager()
      await create(manager, shell, { id: ids.lead, restore: true })
      await create(manager, shell, {
        id: ids.worker,
        restore: true,
        resume: "claude",
      })
      expect(manager.get(ids.worker).ledBy).toBe("moth")
      const brief = (
        manager as unknown as {
          messaging: { send: (from: string, request: object) => { ok: boolean } }
        }
      ).messaging.send(ids.lead, { to: "fox", text: "Do the work." })
      expect(brief.ok).toBe(true)
      manager.write({ terminalId: ids.worker, data: "echo mine\r" }, "owner")
      await expect.poll(() => manager.get(ids.worker).ledBy).toBeNull()
      expect(manager.messages(ids.worker).threads[0]?.messages[0]).toMatchObject({ state: "gone" })
    })

    it("keeps a worker's lead when its agent clears its conversation", async ({ shell }) => {
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "outer", seq: 1, source: "startup" },
        { agent: "claude", sessionId: "cleared", seq: 2, source: "clear" },
      ])
      const [lead, worker] = [randomUUID(), randomUUID()]
      for (const [id, handle, ledBy] of [
        [lead, "moth", null],
        [worker, "fox", "moth"],
      ] as const)
        shell.store.saveTerminal({
          id,
          sessionId: shell.sessionId,
          cwd: shell.home,
          handle,
          naming: { person: null, opener: null, murmur: null, summary: null },
          openedBy: ledBy,
          ledBy,
          command: null,
          lastProgram: null,
          work: null,
          agents: {},
          promptedAt: null,
        })
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      await create(manager, shell, { id: lead, restore: true })
      // Its startup command is the stand-in agent, which clears its conversation.
      await create(manager, shell, { id: worker, restore: true, command: "report" })
      await shell.until(manager, worker, "reports sent")
      await expect.poll(() => manager.reportedSession(worker, "claude")).toBe("cleared")
      expect(manager.get(worker).ledBy).toBe("moth")
      expect(shell.store.terminalIdentity(worker)?.ledBy).toBe("moth")
    })

    it("takes no lead from a terminal kept in another session, though its id is restored here", async ({
      shell,
    }) => {
      const other = shell.store.createSession({
        id: randomUUID(),
        projectId: shell.store.session(shell.sessionId).projectId,
        name: "Other",
      })
      const id = randomUUID()
      shell.store.saveTerminal({
        id,
        sessionId: other.id,
        cwd: shell.home,
        handle: "moth",
        naming: { person: null, opener: null, murmur: null, summary: null },
        openedBy: "moth",
        ledBy: "moth",
        command: "claude",
        lastProgram: null,
        work: null,
        agents: {},
        promptedAt: null,
      })
      const manager = shell.manager()
      await create(manager, shell, { id: randomUUID() })
      const restored = await create(manager, shell, { id, restore: true })
      expect(restored.ledBy).toBeNull()
      expect(shell.store.terminalIdentity(id)?.openedBy).toBeNull()
    })
  },
)
