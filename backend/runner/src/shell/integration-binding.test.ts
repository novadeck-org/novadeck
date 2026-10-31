import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { Trees } from "@novadeck/terminal/pty"

import { describe, expect } from "../test.js"
import { bash, it, create, reporter, fakeClaude } from "./integration.test-support.js"

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "bash shell integration: binding agent sessions",
  () => {
    it("tells which agent session runs, through a connected agent's plugin", async ({ shell }) => {
      const session = randomUUID()
      fakeClaude(shell.home, shell.plugins, session)
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const project = join(shell.home, "project")
      mkdirSync(project)
      const manager = shell.manager()
      const next = shell.watch(manager)
      const terminal = await create(manager, shell)
      // No prompt shows in the directory claude runs in: its report says where it is.
      manager.write({ terminalId: terminal.id, data: "cd project && claude\r" }, "owner")
      const running = await next((summary) => summary.agent === "claude")
      expect(running.cwd).toBe(project)
      expect(manager.reportedSession(terminal.id, "claude")).toBe(session)
      expect(manager.reportedSession(terminal.id, "codex")).toBeNull()
      expect(shell.store.terminal(terminal.id)?.agents.claude?.sessionId).toBe(session)
      // Back at the prompt, the agent no longer holds the foreground; its session stays.
      manager.write({ terminalId: terminal.id, data: "\r" }, "owner")
      await next((summary) => summary.agent === null && summary.id === terminal.id)
      expect(manager.reportedSession(terminal.id, "claude")).toBe(session)
    })

    it("runs a connected Codex through Novadeck's shim, even after .bashrc moves PATH", async ({
      shell,
    }) => {
      const bin = join(shell.home, "bin")
      mkdirSync(bin)
      writeFileSync(join(bin, "codex"), '#!/bin/sh\necho "codex args: $*"\n', { mode: 0o755 })
      writeFileSync(join(shell.home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n')
      const connected = shell.manager({ shims: () => Promise.resolve(["codex" as const]) })
      const on = await create(connected, shell)
      connected.write({ terminalId: on.id, data: "codex resume abc\r" }, "owner")
      await shell.until(
        connected,
        on.id,
        "codex args: --no-daemon -c tui.terminal_title=['status','thread-id'] resume abc",
      )

      const disconnected = shell.manager()
      const off = await create(disconnected, shell)
      disconnected.write({ terminalId: off.id, data: "codex resume abc\r" }, "owner")
      await shell.until(disconnected, off.id, /codex args: resume abc\r?\n/)
    })

    it("keeps only the latest report of each agent, by when it was sent", async ({ shell }) => {
      const bin = reporter(shell.home, [
        { agent: "codex", sessionId: "s3", seq: 3, source: "startup" },
        { agent: "codex", sessionId: "s1", seq: 1, source: "clear" },
        { agent: "codex", sessionId: "s2", seq: 2, source: "clear" },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await shell.until(manager, terminal.id, "reports sent")
      // Reports may still be waiting for the platform to tell who holds the foreground.
      await expect.poll(() => manager.reportedSession(terminal.id, "codex")).toBe("s3")
    })

    it("takes a session switch, but not a nested agent's own session", async ({ shell }) => {
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "outer", seq: 1, source: "startup" },
        // Run by the agent in the foreground, as from its shell tool.
        { agent: "claude", sessionId: "nested", seq: 2, source: "startup" },
        { agent: "codex", sessionId: "nested-codex", seq: 3, source: "startup" },
        // /clear in the agent in the foreground.
        { agent: "claude", sessionId: "cleared", seq: 4, source: "clear" },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await shell.until(manager, terminal.id, "reports sent")
      await expect.poll(() => manager.reportedSession(terminal.id, "claude")).toBe("cleared")
      expect(manager.reportedSession(terminal.id, "codex")).toBeNull()
    })

    it("lets a later process of the same agent bind once the bound one is gone", async ({
      shell,
    }) => {
      // As in tmux, where no prompt shows between the two: the first has exited.
      const gone = String(spawnSync(process.execPath, ["-e", ""]).pid)
      const alive = String(process.pid)
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "one", seq: 1, source: "startup", instance: gone },
        { agent: "claude", sessionId: "two", seq: 2, source: "resume", instance: alive },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await shell.until(manager, terminal.id, "reports sent")
      await expect.poll(() => manager.reportedSession(terminal.id, "claude")).toBe("two")
    })

    it("binds no late report of a session whose process was found gone", async ({ shell }) => {
      // As Antigravity's status line drawn as it exits: the hook outlives it, and can't
      // tell its process. The session ended with its process; the report brings it back no more.
      const gone = String(spawnSync(process.execPath, ["-e", ""]).pid)
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "one", seq: 1, source: "startup", instance: gone },
        { agent: "claude", sessionId: "one", seq: 2, source: "resume" },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await shell.until(manager, terminal.id, "reports sent")
      // Both reports taken, in turn: the first recorded for resuming, its binding ended with
      // its gone process; the later one, of that same session, skipped as late, binding nothing.
      await expect
        .poll(
          () =>
            manager.get(terminal.id).agent === null &&
            manager.reportedSession(terminal.id, "claude"),
        )
        .toBe("one")
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(manager.get(terminal.id).agent).toBeNull()
    })

    it("refuses another live process of the bound agent", async ({ shell }) => {
      const bin = reporter(shell.home, [
        {
          agent: "claude",
          sessionId: "one",
          seq: 1,
          source: "startup",
          instance: String(process.pid),
        },
        // Nested, as a Claude Code run from the one in the foreground resuming its own.
        {
          agent: "claude",
          sessionId: "two",
          seq: 2,
          source: "resume",
          instance: String(process.ppid),
        },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await shell.until(manager, terminal.id, "reports sent")
      await expect.poll(() => manager.reportedSession(terminal.id, "claude")).toBe("one")
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(manager.reportedSession(terminal.id, "claude")).toBe("one")
    })

    it.for(["agy", "claude"] as const)(
      "accepts a replacement of %s once Windows proves the old pid names a newer process",
      async (agent, { shell }) => {
        const instance = String(process.pid)
        const bin = reporter(shell.home, [
          { agent, sessionId: "old", seq: 1, source: "startup", instance },
          {
            agent: "claude",
            sessionId: "replacement",
            seq: 300,
            source: "startup",
            instance: agent === "claude" ? instance : String(process.ppid),
            wait: 200,
          },
        ])
        const manager = shell.manager({
          platform: "win32",
          env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
        })
        const terminal = await create(manager, shell)
        const inside = manager as unknown as {
          records: Map<string, { agents: { [name: string]: { seq: number } | undefined } }>
          trees: Trees
        }
        let reads = 0
        // The relay's actual wire shape, simulating reuse: kill(pid, 0) succeeds, but
        // Windows says that process began after the old binding was observed.
        inside.trees = new Trees(
          async () => "relay.exe",
          async (_relay, args) => {
            reads += 1
            expect(args).toEqual(["tree", instance])
            const observed = inside.records.get(terminal.id)!.agents[agent]!.seq
            return JSON.stringify({
              root: instance,
              processes: [{ pid: process.pid, startedAt: observed + 100 }],
            })
          },
        )
        manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
        await shell.until(manager, terminal.id, "reports sent")
        await expect.poll(() => manager.reportedSession(terminal.id, "claude")).toBe("replacement")
        expect(manager.get(terminal.id).agent).toBe("claude")
        expect(reads).toBe(1)
      },
    )

    it("reads no Windows process start for another report of the bound session", async ({
      shell,
    }) => {
      const instance = String(process.pid)
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "root", seq: 1, source: "startup", instance },
        { agent: "claude", sessionId: "root", seq: 300, source: "resume", instance, wait: 200 },
      ])
      const manager = shell.manager({
        platform: "win32",
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      const inside = manager as unknown as {
        trees: Trees
        reporting: { queues: Map<string, Promise<void>> }
      }
      let reads = 0
      inside.trees = new Trees(
        async () => "relay.exe",
        async () => {
          reads += 1
          return ""
        },
      )
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await shell.until(manager, terminal.id, "reports sent")
      await inside.reporting.queues.get(terminal.id)
      expect(manager.reportedSession(terminal.id, "claude")).toBe("root")
      expect(manager.get(terminal.id).agent).toBe("claude")
      expect(reads).toBe(0)
    })

    it.for(["older", "same", "rounded", "missing", "child", "unknown"] as const)(
      "keeps a live nested agent out when Windows' process start is %s",
      async (start, { shell }) => {
        const instance = String(process.pid)
        const bin = reporter(shell.home, [
          { agent: "agy", sessionId: "root", seq: 1, source: "", instance },
          {
            agent: "claude",
            sessionId: "nested",
            seq: 300,
            source: "startup",
            instance: String(process.ppid),
            wait: 200,
          },
        ])
        const manager = shell.manager({
          platform: "win32",
          env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
        })
        const terminal = await create(manager, shell)
        const inside = manager as unknown as {
          records: Map<string, { agents: { agy?: { seq: number } } }>
          trees: Trees
        }
        let reads = 0
        inside.trees = new Trees(
          async () => (start === "unknown" ? undefined : "relay.exe"),
          async (_relay, args) => {
            reads += 1
            expect(args).toEqual(["tree", instance])
            const observed = inside.records.get(terminal.id)!.agents.agy!.seq
            return JSON.stringify({
              root: instance,
              processes:
                start === "missing"
                  ? []
                  : [
                      {
                        pid: start === "child" ? process.pid + 1 : process.pid,
                        startedAt:
                          observed +
                          (start === "rounded"
                            ? 50
                            : start === "same"
                              ? 0
                              : start === "child"
                                ? 100
                                : -1_000),
                      },
                    ],
            })
          },
        )
        manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
        await shell.until(manager, terminal.id, "reports sent")
        // This PID really remains alive throughout; a later start must be proven before
        // another harness is allowed to replace it.
        expect(() => process.kill(process.pid, 0)).not.toThrow()
        expect(manager.get(terminal.id).agent).toBe("agy")
        expect(manager.reportedSession(terminal.id, "claude")).toBeNull()
        expect(reads).toBe(start === "unknown" ? 0 : 1)
      },
    )

    it.for(["binding", "process", "exit", "disconnection"] as const)(
      "drops a Windows reuse check once the terminal's %s changes while it reads",
      async (change, { shell }) => {
        const instance = String(process.pid)
        const bin = reporter(shell.home, [
          { agent: "agy", sessionId: "root", seq: 1, source: "", instance },
          {
            agent: "claude",
            sessionId: "replacement",
            seq: 300,
            source: "startup",
            instance: String(process.ppid),
            wait: 200,
          },
        ])
        const manager = shell.manager({
          platform: "win32",
          env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
        })
        const terminal = await create(manager, shell)
        const inside = manager as unknown as {
          records: Map<
            string,
            {
              agents: { agy?: { seq: number } }
              bound: {
                binding: { agent: string; sessionId: string; instance: string | null }
              } | null
              terminal: { pty: object; exiting: boolean }
            }
          >
          trees: Trees
          reporting: {
            queues: Map<string, Promise<void>>
            disconnections: Map<string, number>
          }
        }
        let started!: () => void
        let release!: () => void
        const reading = new Promise<void>((resolve) => {
          started = resolve
        })
        const released = new Promise<void>((resolve) => {
          release = resolve
        })
        inside.trees = new Trees(
          async () => "relay.exe",
          async () => {
            started()
            await released
            const observed = inside.records.get(terminal.id)!.agents.agy!.seq
            return JSON.stringify({
              root: instance,
              processes: [{ pid: process.pid, startedAt: observed + 100 }],
            })
          },
        )
        manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
        await reading
        const record = inside.records.get(terminal.id)!
        const original = { bound: record.bound, terminal: record.terminal }
        const switched = {
          ...original.bound,
          binding: { agent: "codex", sessionId: "new-root", instance: null },
        }
        if (change === "binding") record.bound = switched
        // Another run, or this one's exit queued, as the manager sees its terminal.
        if (change === "process")
          record.terminal = Object.create(original.terminal, {
            pty: { value: { ...original.terminal.pty } },
          })
        if (change === "exit")
          record.terminal = Object.create(original.terminal, { exiting: { value: true } })
        if (change === "disconnection") inside.reporting.disconnections.set("claude", 1)
        release()
        try {
          await inside.reporting.queues.get(terminal.id)
          expect(record.bound).toBe(change === "binding" ? switched : original.bound)
          expect(manager.reportedSession(terminal.id, "claude")).toBeNull()
        } finally {
          record.bound = original.bound
          record.terminal = original.terminal
        }
      },
    )

    it("takes no other conversation from a report that can't tell its process mid-turn", async ({
      shell,
    }) => {
      // As a nested `agy -p` run inside the root's turn: its status line, drawn as it exits,
      // comes from a hook that outlived it and found no Antigravity above it.
      const bin = reporter(shell.home, [
        {
          agent: "agy",
          sessionId: "root",
          seq: 1,
          source: "",
          instance: String(process.pid),
          fields: { invocationNum: 0 },
        },
        {
          agent: "agy",
          sessionId: "nested",
          seq: 2,
          source: "",
          event: "StatusLine",
          fields: { conversation_id: "nested", agent_state: "working" },
        },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await shell.until(manager, terminal.id, "reports sent")
      await expect.poll(() => manager.messages(terminal.id).delivery).toBe("working")
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(manager.reportedSession(terminal.id, "agy")).toBe("root")
      expect(manager.messages(terminal.id).delivery).toBe("working")
    })
  },
)
