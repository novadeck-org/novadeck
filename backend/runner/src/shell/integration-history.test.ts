import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import type { Terminals } from "../terminals/index.js"
import { describe, expect } from "../test.js"
import { unsealed } from "../testing/sealing.js"
import { bash, create, it, type Fixture } from "./integration.test-support.js"
import { driver, messageId, standIn, standInTui, type Told } from "./stand-ins.test-support.js"

// A stand-in harness under its own name (so the foreground program is the agent's) that
// runs the stand-in TUI: a resume (`--resume <id>`) shows its session at once. `failbin`
// holds one that prints an error and exits, as a harness does for a missing conversation.
const install = (home: string) => {
  standInTui(home)
  standIn(home)
  mkdirSync(join(home, "names"), { recursive: true })
  mkdirSync(join(home, "failbin"), { recursive: true })
  const name = join(home, "names", "claude")
  if (!existsSync(name)) writeFileSync(name, "")
  const bin = join(home, "bin")
  writeFileSync(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      "for last; do :; done",
      'case "$1" in -*|resume) mode=resumed ;; *) mode= ;; esac',
      `exec "${process.execPath}" "$HOME/bin/tui.cjs" claude "$last" "$HOME/rec-$NOVADECK_TERMINAL_ID" "$HOME/raw-$NOVADECK_TERMINAL_ID" "$mode"`,
      "",
    ].join("\n"),
  )
  chmodSync(join(bin, "claude"), 0o755)
  writeFileSync(
    join(home, "failbin", "claude"),
    '#!/bin/sh\nfor last; do :; done\necho "No conversation found with session ID: $last" >&2\nexit 1\n',
  )
  chmodSync(join(home, "failbin", "claude"), 0o755)
}

const options = (shell: Fixture, failing = false) => ({
  closed: shell.store,
  projects: () => shell.store.projects().map(({ id }) => id),
  env: {
    HOME: shell.home,
    PS1: "$ ",
    PATH: `${failing ? `${join(shell.home, "failbin")}:` : ""}${join(shell.home, "bin")}:${process.env.PATH}`,
  },
  processPollMs: 100,
  saveMs: 50,
  hooksTrusted: () => Promise.resolve(true),
  install: (agent: AgentName) =>
    Promise.resolve({
      env: {},
      home: shell.home,
      platform: process.platform,
      plugin: join(shell.plugins, agent),
    }),
  models: () => Promise.resolve([{ id: "m", efforts: [] }]),
})

const projectOf = (shell: Fixture) => shell.store.session(shell.sessionId).projectId
const rows = (shell: Fixture) => shell.store.closed(projectOf(shell))

const startClaude = async (shell: Fixture, manager: Terminals, id: string, session: string) => {
  manager.write({ terminalId: id, data: `claude ${session}\r` }, "owner")
  await expect.poll(() => manager.get(id).agent, { timeout: 8000 }).toBe("claude")
}

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "closing and restoring terminals through History",
  () => {
    it("keeps a closed terminal that ran something, with its last output, and none that did not", async ({
      shell,
    }) => {
      const manager = shell.manager(options(shell))
      const used = await create(manager, shell)
      const idle = await create(manager, shell)
      manager.write({ terminalId: used.id, data: "echo kept-output\r" }, "owner")
      await shell.until(manager, used.id, /kept-output\r?\n/)
      await manager.close({ terminalId: used.id })
      await manager.close({ terminalId: idle.id })
      expect(rows(shell).map(({ id }) => id)).toEqual([used.id])
      await expect
        .poll(() => unsealed(shell.store.closedTerminal(used.id)?.transcript, used.id))
        .toContain("kept-output")
    })

    it("keeps nothing of a project that is being removed", async ({ shell }) => {
      const manager = shell.manager(options(shell))
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "echo hi\r" }, "owner")
      await shell.until(manager, terminal.id, /hi\r?\n/)
      await manager.closeProject(projectOf(shell), [shell.sessionId])
      expect(rows(shell)).toEqual([])
    })

    it("restores a plain terminal as a new one in its session, with its output above and its handle", async ({
      shell,
    }) => {
      const manager = shell.manager(options(shell))
      const old = await create(manager, shell)
      manager.write({ terminalId: old.id, data: "echo before-close\r" }, "owner")
      await shell.until(manager, old.id, /before-close\r?\n/)
      await expect.poll(() => manager.get(old.id).busy).toBe(false)
      await manager.close({ terminalId: old.id })
      await expect.poll(() => shell.store.closedTerminal(old.id)?.transcript).toBeTruthy()
      const id = randomUUID()
      const restored = await manager.create(
        { id, sessionId: shell.sessionId, cwd: shell.home, cols: 100, rows: 20, closed: old.id },
        "owner",
      )
      expect(restored.handle).toBe(old.handle)
      expect(await shell.until(manager, id, "before-close")).toContain("restored transcript")
      expect(rows(shell)).toEqual([])
      // Restored again, the same new id answers with the terminal that is there.
      await expect(
        manager.create(
          { id, sessionId: shell.sessionId, cwd: shell.home, cols: 100, rows: 20, closed: old.id },
          "owner",
        ),
      ).resolves.toMatchObject({ id })
    })

    it("restores an agent's conversation, and the row leaves once it is bound", async ({
      shell,
    }) => {
      install(shell.home)
      const manager = shell.manager(options(shell))
      const old = await create(manager, shell)
      await startClaude(shell, manager, old.id, "conv-0001")
      expect(manager.get(old.id).restorable).toBe(true)
      await manager.close({ terminalId: old.id })
      const [row] = rows(shell)
      expect(row).toMatchObject({ id: old.id, agent: "claude" })
      expect(row?.agents.claude).toMatchObject({ sessionId: "conv-0001", cwd: shell.home })
      const id = randomUUID()
      await manager.create(
        { id, sessionId: shell.sessionId, cwd: shell.home, cols: 100, rows: 20, closed: old.id },
        "owner",
      )
      await expect.poll(() => manager.get(id).agent, { timeout: 8000 }).toBe("claude")
      await expect.poll(() => rows(shell), { timeout: 8000 }).toEqual([])
      expect((await manager.detail(id).next()).value?.sessionId).toBe("conv-0001")
    })

    it("keeps the row, frees the session and says so when the resume fails", async ({ shell }) => {
      install(shell.home)
      const first = shell.manager(options(shell))
      const old = await create(first, shell)
      await startClaude(shell, first, old.id, "conv-0002")
      await first.close({ terminalId: old.id })
      await first.shutdown()
      const manager = shell.manager(options(shell, true))
      const id = randomUUID()
      await manager.create(
        { id, sessionId: shell.sessionId, cwd: shell.home, cols: 100, rows: 20, closed: old.id },
        "owner",
      )
      const shown = await shell.until(manager, id, /conversation didn't open/)
      // On a line of its own, not glued to the prompt it was written after.
      expect(shown).toContain("Claude Code was running here, but its conversation didn't open.")
      expect(shown).not.toMatch(/\$ \S*Claude Code was running/)
      expect(manager.get(id).agent).toBeNull()
      expect(rows(shell).map(({ id: row }) => row)).toEqual([old.id])
      // The claim is given back: the row can be restored again.
      await expect.poll(async () => (await shell.store.closed(projectOf(shell))).length).toBe(1)
      const list = await manager.history.list(projectOf(shell))
      expect(list[0]?.availability).toEqual({ state: "ready" })
    })

    it("does not deliver, nor hold again, a message to the terminal that closed when its session returns", async ({
      shell,
    }) => {
      install(shell.home)
      const manager = shell.manager(options(shell))
      const sender = await create(manager, shell)
      const old = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(sender.id, "codex", "s-sender")
      await startClaude(shell, manager, old.id, "conv-0003")
      await expect.poll(() => manager.messages(old.id).delivery).not.toBeNull()
      manager.pauseMessages(true)
      const sent = JSON.parse(
        await step(sender.id, { call: "send", request: { to: old.handle, text: "Review a.ts." } }),
      ) as Told
      const id = messageId(sent)!
      const state = (): string | undefined =>
        manager
          .messages(sender.id)
          .threads.flatMap((thread) => thread.messages)
          .find((message) => message.id === id)?.state
      expect(state()).toBe("held")
      await manager.close({ terminalId: old.id })
      expect(state()).toBe("gone")
      const restored = randomUUID()
      await manager.create(
        {
          id: restored,
          sessionId: shell.sessionId,
          cwd: shell.home,
          cols: 100,
          rows: 20,
          closed: old.id,
        },
        "owner",
      )
      await expect.poll(() => manager.get(restored).agent, { timeout: 8000 }).toBe("claude")
      manager.pauseMessages(false)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(state()).toBe("gone")
      const received = join(shell.home, `rec-${restored}`)
      expect(existsSync(received) ? readFileSync(received, "utf8") : "").not.toContain(
        "Review a.ts.",
      )
    })
  },
)
