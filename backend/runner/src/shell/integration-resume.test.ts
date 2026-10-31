import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { describe, expect } from "../test.js"
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
  "bash shell integration: startup and resume",
  () => {
    it("loads the person's own .bashrc and reports each prompt's directory", async ({ shell }) => {
      const directory = join(shell.home, "my dir ż")
      mkdirSync(directory)
      writeFileSync(join(shell.home, ".bashrc"), "FROM_BASHRC=loaded\n")
      const manager = shell.manager()
      const next = shell.watch(manager)
      const terminal = await create(manager, shell)
      manager.write(
        { terminalId: terminal.id, data: `cd '${directory}'; echo $FROM_BASHRC\r` },
        "owner",
      )
      const moved = await next((summary) => summary.cwd === directory)
      expect(moved.id).toBe(terminal.id)
      await shell.until(manager, terminal.id, "loaded")
      expect(shell.store.terminal(terminal.id)?.cwd).toBe(directory)
    })

    it("resumes the saved agent session at the first prompt, as if typed there", async ({
      shell,
    }) => {
      // Input while .bashrc runs would be read by it instead of the prompt; the person's own
      // prompt commands run first, as they would before a typed command.
      writeFileSync(
        join(shell.home, ".bashrc"),
        [
          'export PATH="$HOME/bin:$PATH"',
          'sleep 0.5; read -t 0.5 early; echo "rc read [$early]"',
          "PROMPT_COMMAND='export FROM_PROMPT=yes'",
          "HISTFILE=~/.bash_history",
        ].join("\n"),
      )
      fakeAgent(shell.home, "claude")
      const id = randomUUID()
      shell.saveSession(id, "claude", "abc-1")
      const manager = shell.manager()
      await create(manager, shell, { id, restore: true, resume: "claude" })
      const shown = await shell.until(
        manager,
        id,
        "claude args: --resume abc-1 prompt=[yes] resume=[]",
      )
      expect(shown).toContain("rc read []")
      // Nothing was typed: no command line shows, and none is kept in the history.
      expect(shown).not.toContain("$ claude")
      manager.write({ terminalId: id, data: "\rhistory\r" }, "owner")
      const after = await shell.until(manager, id, /history\r?\n[\s\S]*\$ /)
      expect(after).not.toMatch(/\d+ +claude/)
    })

    it("starts a new terminal's command at the first prompt, as if typed there", async ({
      shell,
    }) => {
      writeFileSync(
        join(shell.home, ".bashrc"),
        [
          'export PATH="$HOME/bin:$PATH"',
          "PROMPT_COMMAND='export FROM_PROMPT=yes'",
          "HISTFILE=~/.bash_history",
          // The person's own, which the command sees as typed, not shadowed by Novadeck's.
          "file=USERFILE resume=USERRESUME",
        ].join("\n"),
      )
      fakeAgent(shell.home, "claude")
      const manager = shell.manager()
      const terminal = await create(manager, shell, {
        command: `claude --model 'big one' "$file" "$resume"`,
      })
      const shown = await shell.until(
        manager,
        terminal.id,
        "claude args: --model big one USERFILE USERRESUME prompt=[yes] resume=[]",
      )
      expect(shown).not.toContain("$ claude")
      expect(readdirSync(join(dirname(shell.plugins), "resume"))).toEqual([])
      // Nothing was typed, so the history keeps nothing of it.
      manager.write({ terminalId: terminal.id, data: "\rhistory\r" }, "owner")
      const after = await shell.until(manager, terminal.id, /history\r?\n[\s\S]*\$ /)
      expect(after).not.toMatch(/\d+ +claude/)
    })

    it("refuses to start a terminal whose shell can't run its command", async ({ shell }) => {
      const refused = expect.objectContaining({ code: "SPAWN_FAILED" })
      // Configured arguments, a shell Novadeck doesn't integrate, and no integration at all.
      for (const options of [
        { shellArgs: [] },
        { shell: "/bin/sh" },
        { shellFiles: Promise.resolve(undefined) },
      ]) {
        const manager = shell.manager(options)
        // eslint-disable-next-line no-await-in-loop -- Each manager is tried in turn.
        await expect(create(manager, shell, { command: "claude" })).rejects.toEqual(refused)
        expect(manager.list()).toEqual([])
      }
    })

    it("resumes nothing for an agent that reported no session there", async ({ shell }) => {
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      fakeAgent(shell.home, "codex")
      const id = randomUUID()
      shell.saveSession(id, "claude", "abc-1")
      const manager = shell.manager()
      await create(manager, shell, { id, restore: true, resume: "codex" })
      await shell.until(manager, id, "$ ")
      manager.write({ terminalId: id, data: "echo ready\r" }, "owner")
      const shown = await shell.until(manager, id, /ready\r?\n[\s\S]*\$ /)
      expect(shown).not.toContain("args:")
    })

    for (const how of ["close", "shutdown"] as const)
      it(`ends a resumed agent with its terminal, on ${how}`, async ({ shell }) => {
        // Left running, it would keep its session open, and the next resume would fail.
        const bin = join(shell.home, "bin")
        mkdirSync(bin)
        const pidFile = join(shell.home, "agent.pid")
        writeFileSync(join(bin, "codex"), `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 1000\n`, {
          mode: 0o755,
        })
        writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
        const id = randomUUID()
        shell.saveSession(id, "codex", "abc-1")
        const manager = shell.manager()
        await create(manager, shell, { id, restore: true, resume: "codex" })
        await expect.poll(() => existsSync(pidFile), { timeout: 10_000 }).toBe(true)
        const pid = Number(readFileSync(pidFile, "utf8"))
        const alive = () => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        }
        expect(alive()).toBe(true)
        if (how === "close") await manager.close({ terminalId: id })
        else await manager.shutdown()
        await expect.poll(alive, { timeout: 5_000 }).toBe(false)
      })

    it("knows once a resumed agent exits, and takes the next agent started there", async ({
      shell,
    }) => {
      const session = randomUUID()
      fakeClaude(shell.home, shell.plugins, session)
      reporter(shell.home, [{ agent: "claude", sessionId: "brand-new", seq: 1, source: "startup" }])
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const id = randomUUID()
      shell.saveSession(id, "claude", session)
      const manager = shell.manager()
      const next = shell.watch(manager)
      await create(manager, shell, { id, restore: true, resume: "claude" })
      await next((summary) => summary.id === id && summary.agent === "claude")
      // The shell took the command, and nothing is left waiting.
      expect(readdirSync(join(dirname(shell.plugins), "resume"))).toEqual([])
      manager.write({ terminalId: id, data: "\r" }, "owner")
      await next((summary) => summary.id === id && summary.agent === null)
      manager.write({ terminalId: id, data: "report\r" }, "owner")
      await expect.poll(() => manager.reportedSession(id, "claude")).toBe("brand-new")
    })

    it("cancels the resume when someone types before it runs", async ({ shell }) => {
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\nsleep 1\n')
      fakeAgent(shell.home, "claude")
      const id = randomUUID()
      shell.saveSession(id, "claude", "abc-1")
      const manager = shell.manager()
      await create(manager, shell, { id, restore: true, resume: "claude" })
      await new Promise((resolve) => setTimeout(resolve, 300))
      manager.write({ terminalId: id, data: "echo mine\r" }, "owner")
      await shell.until(manager, id, /mine\r?\n[\s\S]*\$ /)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(await screen(manager, id)).not.toContain("args:")
      expect(readdirSync(join(dirname(shell.plugins), "resume"))).toEqual([])
      // The session it would have resumed is free for another terminal.
      const other = randomUUID()
      shell.saveSession(other, "claude", "abc-1")
      await create(manager, shell, { id: other, restore: true, resume: "claude" })
      await shell.until(manager, other, "claude args: --resume abc-1")
    })

    it("keeps the resume through the mouse's scroll while the screen reports the mouse", async ({
      shell,
    }) => {
      // Something run before the resume turns mouse reporting on, as a fullscreen TUI does.
      writeFileSync(
        join(shell.home, ".bashrc"),
        `export PATH="$HOME/bin:$PATH"\nprintf '\\033[?1000h\\033[?1006hmouse on\\n'\nsleep 1\n`,
      )
      fakeAgent(shell.home, "claude")
      const id = randomUUID()
      shell.saveSession(id, "claude", "abc-1")
      const manager = shell.manager()
      await create(manager, shell, { id, restore: true, resume: "claude" })
      await shell.until(manager, id, "mouse on")
      // The wheel over it, up and down: the terminal's reports, not typing.
      manager.write({ terminalId: id, data: "\x1b[<64;10;5M\x1b[<65;10;5M" }, "owner")
      await shell.until(manager, id, "claude args: --resume abc-1")
    })

    it("shows the transcript when a shell without integration cannot resume", async ({ shell }) => {
      const id = randomUUID()
      const first = shell.manager({ shell: "/bin/sh" })
      await create(first, shell, { id })
      first.write({ terminalId: id, data: "echo before-reboot\r" }, "owner")
      await shell.until(first, id, /before-reboot\r?\n/)
      await first.shutdown()

      shell.saveSession(id, "claude", "abc-1")
      fakeAgent(shell.home, "claude")
      const second = shell.manager({
        shell: "/bin/sh",
        env: {
          HOME: shell.home,
          PS1: "$ ",
          PATH: `${join(shell.home, "bin")}:${process.env.PATH}`,
        },
      })
      await create(second, shell, { id, restore: true, resume: "claude" })
      const shown = await shell.until(second, id, "restored transcript")
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(shown).toContain("before-reboot")
      expect(await screen(second, id)).not.toContain("args:")
    })

    it("resumes an agent that then reports its session from the foreground", async ({ shell }) => {
      const session = randomUUID()
      fakeClaude(shell.home, shell.plugins, session)
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const id = randomUUID()
      shell.saveSession(id, "claude", session)
      const manager = shell.manager()
      const next = shell.watch(manager)
      await create(manager, shell, { id, restore: true, resume: "claude" })
      await next((summary) => summary.id === id && summary.agent === "claude")
      expect(manager.reportedSession(id, "claude")).toBe(session)
    })

    it("tells a resumed agent whose turn the stop cut short to carry on, once, and drops the saved flag", async ({
      shell,
    }) => {
      const session = randomUUID()
      fakeClaude(shell.home, shell.plugins, session)
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const id = randomUUID()
      shell.saveSession(id, "claude", session, "running")
      const manager = shell.manager()
      const next = shell.watch(manager)
      await create(manager, shell, { id, restore: true, resume: "claude" })
      await next((summary) => summary.id === id && summary.agent === "claude")
      // The notice is no peer's conversation, so only the message store holds it.
      const told = () => shell.store.messages().filter(({ to }) => to.terminalId === id)
      await expect.poll(told).toMatchObject([
        {
          from: { kind: "novadeck" },
          text: expect.stringContaining("while your turn was running"),
        },
      ])
      // What it was doing is this run's own now: the saved flag went with the restore.
      await expect.poll(() => shell.store.terminal(id)?.agents.claude?.turn).toBeUndefined()
      expect(told()).toHaveLength(1)
    })

    it("tells a resumed agent nothing where it was not mid-turn, or the shell does not resume it", async ({
      shell,
    }) => {
      const session = randomUUID()
      fakeClaude(shell.home, shell.plugins, session)
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const idle = randomUUID()
      shell.saveSession(idle, "claude", session)
      const manager = shell.manager()
      const next = shell.watch(manager)
      await create(manager, shell, { id: idle, restore: true, resume: "claude" })
      await next((summary) => summary.id === idle && summary.agent === "claude")
      // A terminal restored without a resume drops the flag it was saved with, telling no one.
      const plain = randomUUID()
      shell.saveSession(plain, "claude", randomUUID(), "waking")
      await create(manager, shell, { id: plain, restore: true })
      await expect.poll(() => shell.store.terminal(plain)?.agents.claude?.turn).toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(shell.store.messages()).toEqual([])
    })
  },
)
