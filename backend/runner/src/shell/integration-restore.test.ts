import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { vi } from "vitest"

import { createTranscriptRedactor } from "../terminals/redaction.js"
import type { TerminalRecords } from "../terminals/saved-terminals.js"
import { describe, expect } from "../test.js"
import { plainSealer, unsealed } from "../testing/sealing.js"
import {
  bash,
  screen,
  it,
  create,
  reporter,
  fakeAgent,
  fakeClaude,
} from "./integration.test-support.js"

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "bash shell integration: disconnecting agents and restoring terminals",
  () => {
    it("keeps an agent session's own markers out of its shells", async ({ shell }) => {
      // As when Novadeck itself was started from inside Claude Code.
      const manager = shell.manager({
        env: {
          HOME: shell.home,
          PS1: "$ ",
          CLAUDECODE: "1",
          CLAUDE_CODE_CHILD_SESSION: "1",
          CODEX_THREAD_ID: "outer",
          CLAUDE_CODE_USE_BEDROCK: "kept",
        },
      })
      const terminal = await create(manager, shell)
      manager.write(
        {
          terminalId: terminal.id,
          data: 'echo "[$CLAUDECODE$CLAUDE_CODE_CHILD_SESSION$CODEX_THREAD_ID|$CLAUDE_CODE_USE_BEDROCK]"\r',
        },
        "owner",
      )
      // The person's own settings stay.
      await shell.until(manager, terminal.id, "[|kept]")
    })

    it("names this runner's own launchers, not those of a Novadeck it was started from", async ({
      shell,
    }) => {
      const manager = shell.manager({
        env: {
          HOME: shell.home,
          PS1: "$ ",
          NOVADECK_HOOK: "/other/shell/hook",
          NOVADECK_MCP: "/other/shell/mcp",
        },
      })
      const terminal = await create(manager, shell)
      manager.write(
        { terminalId: terminal.id, data: 'echo "[$NOVADECK_HOOK|$NOVADECK_MCP]"\r' },
        "owner",
      )
      const shellFolder = dirname(shell.plugins)
      await shell.until(
        manager,
        terminal.id,
        `[${join(shellFolder, "hook")}|${join(shellFolder, "mcp")}]`,
      )
    })

    it("ignores a switch announced by another agent than the one in the foreground", async ({
      shell,
    }) => {
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "outer", seq: 1, source: "startup" },
        // A Codex the agent in the foreground resumed, as from its shell tool.
        { agent: "codex", sessionId: "resumed-codex", seq: 2, source: "resume" },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await shell.until(manager, terminal.id, "reports sent")
      await expect.poll(() => manager.reportedSession(terminal.id, "claude")).toBe("outer")
      // Long enough for the second report to have been taken.
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(manager.reportedSession(terminal.id, "codex")).toBeNull()
      expect(manager.list(terminal.sessionId)[0]?.agent).toBe("claude")
    })

    it("resumes nothing for a disconnected agent, and ignores its reports", async ({ shell }) => {
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "late", seq: 1, source: "startup" },
      ])
      fakeAgent(shell.home, "claude")
      const id = randomUUID()
      shell.saveSession(id, "claude", "abc-1")
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
        connected: () => Promise.resolve(false),
      })
      await create(manager, shell, { id, restore: true, resume: "claude" })
      manager.write({ terminalId: id, data: "report\r" }, "owner")
      const shown = await shell.until(manager, id, "reports sent")
      expect(shown).not.toContain("args:")
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(manager.reportedSession(id, "claude")).toBe("abc-1")
    })

    it("lets go of the foreground agent once it is disconnected", async ({ shell }) => {
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "running", seq: 1, source: "startup" },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const next = shell.watch(manager)
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await next((summary) => summary.id === terminal.id && summary.agent === "claude")
      manager.forgetAgent("claude")
      await next((summary) => summary.id === terminal.id && summary.agent === null)
      expect(manager.reportedSession(terminal.id, "claude")).toBeNull()
    })

    it("says an agent has run in a terminal the person opened, until its harness is disconnected", async ({
      shell,
    }) => {
      fakeClaude(shell.home, shell.plugins, randomUUID())
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const manager = shell.manager()
      const next = shell.watch(manager)
      const terminal = await create(manager, shell)
      expect(terminal).toMatchObject({ openedBy: null, agentRan: false })
      manager.write({ terminalId: terminal.id, data: "claude\r" }, "owner")
      await next((summary) => summary.id === terminal.id && summary.agentRan)
      // Back at the prompt, no agent is bound, but one has run.
      manager.write({ terminalId: terminal.id, data: "\r" }, "owner")
      await expect.poll(() => manager.get(terminal.id).agent).toBeNull()
      expect(manager.get(terminal.id).agentRan).toBe(true)
      // Disconnecting its harness forgets what it reported.
      // A watcher joining now starts from the state with the agent run, so it only sees the change.
      const later = shell.watch(manager)
      manager.forgetAgent("claude")
      await later((summary) => summary.id === terminal.id && !summary.agentRan)
      expect(manager.get(terminal.id).agentRan).toBe(false)
    })

    it("drops a report that was still waiting when its agent was disconnected", async ({
      shell,
    }) => {
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "late", seq: 1, source: "startup" },
      ])
      // Whether it is connected takes a while to tell, long enough to disconnect meanwhile.
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
        connected: () => new Promise((resolve) => setTimeout(() => resolve(true), 1_500)),
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await shell.until(manager, terminal.id, "reports sent")
      manager.forgetAgent("claude")
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      expect(manager.reportedSession(terminal.id, "claude")).toBeNull()
      expect(manager.list(terminal.sessionId)[0]?.agent).toBeNull()
    })

    // Linux and macOS tell which process group holds a terminal's foreground.
    it.runIf(process.platform === "linux" || process.platform === "darwin")(
      "ignores reports made while the shell holds the foreground",
      async ({ shell }) => {
        // As from a tmux server or an editor started from this terminal, running elsewhere.
        const bin = reporter(shell.home, [
          { agent: "claude", sessionId: "elsewhere", seq: 1, source: "startup" },
        ])
        const manager = shell.manager({
          env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
        })
        const terminal = await create(manager, shell)
        manager.write(
          { terminalId: terminal.id, data: "(sleep 0.5; report </dev/null) &\r" },
          "owner",
        )
        await shell.until(manager, terminal.id, "reports sent")
        // Long enough for a report waiting on the platform to have been taken.
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        expect(manager.reportedSession(terminal.id, "claude")).toBeNull()
      },
    )

    it("resumes each saved session in one terminal only", async ({ shell }) => {
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      fakeAgent(shell.home, "claude")
      const [first, second] = [randomUUID(), randomUUID()]
      for (const id of [first, second]) shell.saveSession(id, "claude", "shared")
      const manager = shell.manager()
      await create(manager, shell, { id: first, restore: true, resume: "claude" })
      await shell.until(manager, first, "claude args: --resume shared")
      await create(manager, shell, { id: second, restore: true, resume: "claude" })
      manager.write({ terminalId: second, data: "echo plain\r" }, "owner")
      await shell.until(manager, second, /plain\r?\n[\s\S]*\$ /)
      expect(await screen(manager, second)).not.toContain("args:")
      // Once the terminal that resumed it closes, the session is free again.
      await manager.close({ terminalId: first })
      manager.write({ terminalId: second, data: "exit\r" }, "owner")
      await shell.watch(manager)((summary) => summary.id === second && summary.exit !== null)
      await manager.restart({ terminalId: second, cols: 100, rows: 20, resume: "claude" }, "owner")
      await shell.until(manager, second, "claude args: --resume shared")
    })

    it("does not resume a session another terminal is running", async ({ shell }) => {
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "running", seq: 1, source: "startup" },
      ])
      fakeAgent(shell.home, "claude")
      const lost = randomUUID()
      shell.saveSession(lost, "claude", "running")
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const next = shell.watch(manager)
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await next((summary) => summary.id === terminal.id && summary.agent === "claude")
      await create(manager, shell, { id: lost, restore: true, resume: "claude" })
      manager.write({ terminalId: lost, data: "echo plain\r" }, "owner")
      const shown = await shell.until(manager, lost, /plain\r?\n[\s\S]*\$ /)
      expect(shown).not.toContain("args:")
    })

    it("restores a terminal in its last directory, showing its transcript", async ({ shell }) => {
      const directory = join(shell.home, "work")
      mkdirSync(directory)
      const id = randomUUID()
      const first = shell.manager()
      await create(first, shell, { id })
      first.write({ terminalId: id, data: `cd work; echo before-reboot\r` }, "owner")
      await shell.until(first, id, /before-reboot[\s\S]*\$ /)
      await shell.watch(first)((summary) => summary.cwd === directory)
      await first.shutdown()

      const second = shell.manager()
      const restored = await create(second, shell, { id, restore: true })
      expect(restored.cwd).toBe(directory)
      const shown = await shell.until(second, id, /restored transcript[\s\S]*\$ /)
      expect(shown.indexOf("before-reboot")).toBeLessThan(shown.indexOf("restored transcript"))
    })

    it("masks a token in the transcript the real redactor saves as the runner shuts down", async ({
      shell,
    }) => {
      const id = randomUUID()
      const token = `ghp_${"aB3dE5gH7jK9mN1pQ3sT5vX7zC9eF1hJ3kL5"}`
      // No periodic save runs: only the last pass at shutdown writes the transcript.
      const manager = shell.manager({
        redactor: createTranscriptRedactor(),
        saveMs: 600_000,
        transcriptMs: 600_000,
        transcriptShutdownMs: 10_000,
      })
      await create(manager, shell, { id })
      manager.write({ terminalId: id, data: `echo ${token} marker-after\r` }, "owner")
      await shell.until(manager, id, /marker-after\r?\n/)
      expect(shell.store.terminal(id)?.transcript ?? null).toBeNull()
      await manager.shutdown()
      const saved = unsealed(shell.store.terminal(id)?.transcript, id)
      expect(saved).toContain("marker-after")
      expect(saved).not.toContain(token)
    })

    it("shows only a sealed transcript, and forgets an unsealed one left behind", async ({
      shell,
    }) => {
      const id = randomUUID()
      const first = shell.manager()
      await create(first, shell, { id })
      first.write({ terminalId: id, data: "echo before-reboot\r" }, "owner")
      await shell.until(first, id, /before-reboot[\s\S]*\$ /)
      await first.shutdown()
      expect(shell.store.terminal(id)?.transcript).toMatch(/^v1\./)

      const second = shell.manager()
      await create(second, shell, { id, restore: true })
      const shown = await shell.until(second, id, /restored transcript[\s\S]*\$ /)
      expect(shown.indexOf("before-reboot")).toBeLessThan(shown.indexOf("restored transcript"))
      await second.shutdown()

      // A copy an earlier runner left unsealed is not shown, and is gone as the runner starts.
      shell.store.saveTerminal({ ...shell.store.terminal(id)!, transcript: "unsealed-leftover" })
      const third = shell.manager()
      await vi.waitFor(() => expect(shell.store.terminal(id)?.transcript).toBeNull())
      await create(third, shell, { id, restore: true })
      expect(await shell.until(third, id, /\$ /)).not.toContain("unsealed-leftover")
    })

    it("shows no transcript, and keeps it, when no key comes or it comes too late", async ({
      shell,
    }) => {
      const id = randomUUID()
      const first = shell.manager()
      await create(first, shell, { id })
      first.write({ terminalId: id, data: "echo before-reboot\r" }, "owner")
      await shell.until(first, id, /before-reboot[\s\S]*\$ /)
      await first.shutdown()
      const sealed = shell.store.terminal(id)?.transcript
      expect(sealed).toMatch(/^v1\./)

      const none = shell.manager({ sealer: { ...plainSealer(), ready: Promise.resolve(false) } })
      await create(none, shell, { id, restore: true })
      expect(await shell.until(none, id, /\$ /)).not.toContain("before-reboot")
      await none.shutdown()
      // Neither saved over nor cleared: a denied prompt may be temporary.
      expect(shell.store.terminal(id)?.transcript).toBe(sealed)

      const late = shell.manager({
        sealer: { ...plainSealer(), ready: new Promise<boolean>(() => {}) },
        transcriptKeyMs: 100,
      })
      await create(late, shell, { id, restore: true })
      expect(await shell.until(late, id, /\$ /)).not.toContain("before-reboot")
    })

    it("leaves a saved transcript alone when the key comes after the wait, and shows it next run", async ({
      shell,
    }) => {
      const id = randomUUID()
      const first = shell.manager()
      await create(first, shell, { id })
      first.write({ terminalId: id, data: "echo before-reboot\r" }, "owner")
      await shell.until(first, id, /before-reboot[\s\S]*\$ /)
      await first.shutdown()
      const sealed = shell.store.terminal(id)?.transcript
      expect(sealed).toMatch(/^v1\./)

      let arrive!: (key: boolean) => void
      const sealer = {
        ...plainSealer(),
        ready: new Promise<boolean>((resolve) => (arrive = resolve)),
      }
      const second = shell.manager({ sealer, transcriptKeyMs: 100, saveMs: 100 })
      await create(second, shell, { id, restore: true })
      expect(await shell.until(second, id, /\$ /)).not.toContain("before-reboot")
      arrive(true)
      second.write({ terminalId: id, data: "echo after-key\r" }, "owner")
      await shell.until(second, id, /after-key\r?\n/)
      second.persist()
      await second.shutdown()
      // Neither the new screen nor a blank one replaced it.
      expect(shell.store.terminal(id)?.transcript).toBe(sealed)

      const third = shell.manager()
      await create(third, shell, { id, restore: true })
      expect(await shell.until(third, id, /restored transcript[\s\S]*\$ /)).toContain(
        "before-reboot",
      )
    })

    it("shows no transcript when it resumes an agent instead", async ({ shell }) => {
      const id = randomUUID()
      const first = shell.manager()
      await create(first, shell, { id })
      first.write({ terminalId: id, data: "echo before-reboot\r" }, "owner")
      await shell.until(first, id, /before-reboot[\s\S]*\$ /)
      await first.shutdown()

      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      fakeAgent(shell.home, "claude")
      shell.saveSession(id, "claude", "abc-1")
      const second = shell.manager()
      await create(second, shell, { id, restore: true, resume: "claude" })
      const shown = await shell.until(second, id, "claude args: --resume abc-1")
      expect(shown).not.toContain("before-reboot")
    })

    it("keeps the last saved state when shells print on their way out", async ({ shell }) => {
      const id = randomUUID()
      const manager = shell.manager()
      await create(manager, shell, { id })
      manager.write(
        // The word is split so that the typed command does not show it.
        {
          terminalId: id,
          data: `trap 'printf "\\033[2J\\033[H%s%s" wi ped; exit' HUP; echo important\r`,
        },
        "owner",
      )
      await shell.until(manager, id, /important\r?\n/)
      await manager.shutdown()
      const saved = shell.store.terminal(id)!
      expect(unsealed(saved.transcript, id)).toContain("important")
      expect(unsealed(saved.transcript, id)).not.toContain("wiped")
    })

    it("saves a screen again after a save of it failed", async ({ shell }) => {
      const id = randomUUID()
      // The store refuses once, as a busy or full disk would.
      let refuse = false
      const records: TerminalRecords = {
        terminal: (terminalId) => shell.store.terminal(terminalId),
        terminals: (sessionId) => shell.store.terminals(sessionId),
        giveHandle: (sessionId) => shell.store.giveHandle(sessionId),
        renameTerminal: (terminalId, title) => shell.store.renameTerminal(terminalId, title),
        terminalIdentity: (terminalId) => shell.store.terminalIdentity(terminalId),
        saveTerminal: (terminal) => {
          if (refuse && terminal.transcript !== undefined) {
            refuse = false
            throw new Error("disk full")
          }
          shell.store.saveTerminal(terminal)
        },
        removeTerminal: (terminalId) => shell.store.removeTerminal(terminalId),
        clearTranscripts: () => shell.store.clearTranscripts(),
        forgetUnsealed: (sealed) => shell.store.forgetUnsealed(sealed),
        clearMurmurTitles: () => shell.store.clearMurmurTitles(),
        forgetAgent: (agent) => shell.store.forgetAgent(agent),
      }
      const manager = shell.manager({ records })
      await create(manager, shell, { id })
      manager.write({ terminalId: id, data: "echo kept\r" }, "owner")
      await shell.until(manager, id, /kept\r?\n/)
      refuse = true
      const error = vi.spyOn(console, "error").mockImplementation(() => {})
      manager.persist()
      await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
      error.mockRestore()
      expect(unsealed(shell.store.terminal(id)?.transcript, id) ?? "").not.toContain("kept")
      manager.persist()
      await vi.waitFor(() =>
        expect(unsealed(shell.store.terminal(id)?.transcript, id)).toContain("kept"),
      )
    })

    it("creates no terminal it can't number, so no handle repeats", async ({ shell }) => {
      const manager = shell.manager()
      const first = await create(manager, shell)
      // Giving a handle fails once, as a busy or full disk would.
      let refuse = true
      const records: TerminalRecords = {
        terminal: (terminalId) => shell.store.terminal(terminalId),
        terminals: (sessionId) => shell.store.terminals(sessionId),
        giveHandle: (sessionId, order) => {
          if (refuse) throw new Error("disk full")
          return shell.store.giveHandle(sessionId, order)
        },
        renameTerminal: (terminalId, title) => shell.store.renameTerminal(terminalId, title),
        terminalIdentity: (terminalId) => shell.store.terminalIdentity(terminalId),
        saveTerminal: (terminal) => shell.store.saveTerminal(terminal),
        removeTerminal: (terminalId) => shell.store.removeTerminal(terminalId),
        clearTranscripts: () => shell.store.clearTranscripts(),
        forgetUnsealed: (sealed) => shell.store.forgetUnsealed(sealed),
        clearMurmurTitles: () => shell.store.clearMurmurTitles(),
        forgetAgent: (agent) => shell.store.forgetAgent(agent),
      }
      const later = shell.manager({ records })
      const id = randomUUID()
      const error = vi.spyOn(console, "error").mockImplementation(() => {})
      await expect(create(later, shell, { id })).rejects.toThrow(
        /couldn't give a new terminal a handle/,
      )
      error.mockRestore()
      expect(later.list(shell.sessionId).map((terminal) => terminal.id)).not.toContain(id)
      refuse = false
      expect(first.handle).toBe("moth")
      expect(await create(later, shell, { id })).toMatchObject({
        handle: "fox",
      })
    })

    it("forgets every transcript once transcripts are turned off", async ({ shell }) => {
      const id = randomUUID()
      const manager = shell.manager()
      await create(manager, shell, { id })
      manager.write({ terminalId: id, data: "echo secret\r" }, "owner")
      await shell.until(manager, id, /secret\r?\n/)
      manager.persist()
      await vi.waitFor(() =>
        expect(unsealed(shell.store.terminal(id)?.transcript, id)).toContain("secret"),
      )
      manager.keepTranscripts(false)
      expect(shell.store.terminal(id)?.transcript).toBeNull()
      manager.persist()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(shell.store.terminal(id)?.transcript).toBeNull()
    })
  },
)
