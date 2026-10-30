import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { codex as codexHarness } from "@novadeck/harness-codex/index"
import { vi } from "vitest"

import { readyReturnMs } from "../terminals/binding/facts.js"
import { describe, expect } from "../test.js"
import { bash, screen, it, create, type Fixture } from "./integration.test-support.js"
import {
  standIn,
  driver,
  messageId,
  reaches,
  standInTui,
  lines,
  ringing,
  agyStarted,
  type Told,
} from "./stand-ins.test-support.js"

/**
 * A sender, and a terminal whose one command line runs a stand-in Claude Code, then `next`,
 * so no shell prompt shows between them; it waits until Claude Code is bound. `leave`
 * makes Claude Code exit by itself and waits until its process is gone.
 */
const leaving = async (shell: Fixture, next: string) => {
  const bin = standIn(shell.home)
  standInTui(shell.home)
  const manager = shell.manager({
    env: {
      HOME: shell.home,
      PS1: "$ ",
      PATH: `${bin}:${process.env.PATH}`,
      CODEX_HOME: join(shell.home, ".codex"),
    },
    doorbell: { calmMs: 200, settleMs: 300, watchMs: 100, boxCheck: false },
    hooksTrusted: () => Promise.resolve(true),
  })
  const sender = await create(manager, shell)
  const idle = await create(manager, shell)
  const { start, step } = driver(shell, manager)
  await start(sender.id, "claude", "s-claude")
  const file = (name: string) => join(shell.home, name)
  const type = (data: string) => manager.write({ terminalId: idle.id, data }, "owner")
  type(`tui claude s-old '${file("old.jsonl")}' '${file("old-raw.jsonl")}' '' ; ${next}\r`)
  await shell.until(manager, idle.id, "claude ready")
  await expect.poll(() => manager.get(idle.id).agent).toBe("claude")
  const pid = Number(readFileSync(file("old-raw.jsonl.pid"), "utf8"))
  return {
    manager,
    idle,
    type,
    file,
    send: async (text: string) =>
      JSON.parse(
        await step(sender.id, { call: "send", request: { to: idle.handle, text } }),
      ) as Told,
    leave: async () => {
      process.kill(pid, "SIGUSR2")
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 })
    },
  }
}

const pastes = (raw: readonly string[]) => raw.filter((data) => data.startsWith("\x1b[200~"))
const quiet = () => new Promise((resolve) => setTimeout(resolve, 1_500))

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "the doorbell in bash terminals",
  () => {
    it("wakes an idle agent's TUI: the test paste, Enter, and its hook delivers", async ({
      shell,
    }) => {
      const tui = await ringing(shell)
      await tui.first()
      // Its first prompt carries the notices of the bar beside it, the Inbox and the summary.
      expect(tui.received()).toMatchObject([
        { prompt: "hello", printed: expect.stringContaining("beside this terminal") },
      ])
      expect(await tui.send("Review a.ts")).toMatchObject({
        ok: true,
        text: reaches("ringing it now"),
      })
      await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
      const [, rung] = tui.received()
      expect(rung!.prompt).toMatch(
        /^\[Novadeck: automatic notice, agent messages waiting, [A-Za-z0-9]+\]$/,
      )
      expect(rung!.printed).toContain(">Review a.ts</message>")
      await expect
        .poll(() => tui.manager.messages(tui.idle.id).threads[0]?.messages[0]?.state)
        .toBe("delivered")
      await tui.back(2)
      await expect.poll(tui.delivery).toBe("settled")
      // Rung once: nothing more is typed.
      await quiet()
      expect(tui.received()).toHaveLength(2)
    })

    it("types only the constant doorbell line into a terminal whose title holds @ and quotes", async ({
      shell,
    }) => {
      const tui = await ringing(shell)
      await tui.first()
      const title = `@src/a.ts "quoted" 'single' $HOME !1 #x`
      tui.manager.rename({ terminalId: tui.idle.id, title })
      await expect.poll(() => tui.manager.get(tui.idle.id).title).toBe(title)
      const before = tui.raw().length
      expect(await tui.send("Review a.ts")).toMatchObject({
        ok: true,
        text: reaches("ringing it now"),
      })
      await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
      await quiet()
      // The test paste of the line, then its Enter: nothing of the title, nor of the message.
      expect(tui.raw().slice(before)).toEqual([
        expect.stringMatching(
          // eslint-disable-next-line no-control-regex -- A bracketed paste's markers.
          /^\x1b\[200~\[Novadeck: automatic notice, agent messages waiting, [A-Za-z0-9]+\]\x1b\[201~$/,
        ),
        "\r",
      ])
      expect(tui.received()[1]!.printed).toContain(">Review a.ts</message>")
    })

    it("wakes a Claude Code TUI idle at its prompt since it started, before any turn", async ({
      shell,
    }) => {
      // Its SessionStart at a startup came as its prompt came up: it is Ready.
      const tui = await ringing(shell, "", "tui", "claude", "s-idle")
      await expect.poll(tui.delivery).toBe("ready")
      expect(await tui.send("Review a.ts")).toMatchObject({
        ok: true,
        text: reaches("ringing it now"),
      })
      await vi.waitFor(() => expect(tui.received()).toHaveLength(1), { timeout: 10_000 })
      const [rung] = tui.received()
      expect(rung!.prompt).toMatch(
        /^\[Novadeck: automatic notice, agent messages waiting, [A-Za-z0-9]+\]$/,
      )
      expect(rung!.printed).toContain(">Review a.ts</message>")
      await expect
        .poll(() => tui.manager.messages(tui.idle.id).threads[0]?.messages[0]?.state)
        .toBe("delivered")
      await expect.poll(tui.delivery).toBe("settled")
    })

    it("rings no Codex TUI while its spawned agent's request waits, until its rollout records Esc on it", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "subabort")
      await tui.first()
      const pending = () => tui.manager.get(tui.idle.id).activity?.attention.pending
      // Asked after its Stop, by hooks that may take a while on a loaded machine.
      await expect.poll(pending, { timeout: 10_000 }).toBe(1)
      expect(tui.delivery()).toBe("settled")
      expect(await tui.send("Review a.ts")).toMatchObject({ ok: true })
      await quiet()
      expect(pastes(tui.raw())).toEqual([])
      expect(tui.received()).toHaveLength(1)
      // Esc dismissed its dialog: no hook, but its own rollout, beside the root's, says so.
      const day = join(shell.home, "received.jsonl.sessions", "2026", "10", "03")
      mkdirSync(day, { recursive: true })
      writeFileSync(
        join(day, "rollout-2026-10-03T00-00-01-a1.jsonl"),
        `${JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } })}\n`,
      )
      await expect.poll(pending, { timeout: 5_000 }).toBe(0)
      await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
      expect(tui.received()[1]!.printed).toContain(">Review a.ts</message>")
      expect(pastes(tui.raw())).toHaveLength(1)
    })

    it("fails a ring whose request came after its test paste, pressing no Enter into that dialog", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "askpaste")
      await tui.first()
      const pending = () => tui.manager.get(tui.idle.id).activity?.attention.pending
      expect(await tui.send("Review a.ts")).toMatchObject({ ok: true })
      // The test paste went out, and its request was asked before the line showed.
      await expect.poll(pending, { timeout: 10_000 }).toBe(1)
      expect(pastes(tui.raw())).toHaveLength(1)
      writeFileSync(join(shell.home, "raw.jsonl.go"), "")
      await expect.poll(tui.delivery).toBe("unknown")
      await quiet()
      // Nothing after the paste: its dialog was never answered, and the message waits.
      const raw = tui.raw()
      expect(raw.slice(raw.findIndex((data) => data.startsWith("\x1b[200~")) + 1)).toEqual([])
      expect(pending()).toBe(1)
      expect(tui.received()).toHaveLength(1)
    })

    it("follows a Codex spawned agent's next request after its rollout records Esc on one, its thread still open", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "subagain")
      await tui.first()
      const activity = () => tui.manager.get(tui.idle.id).activity
      const pending = () => activity()?.attention.pending
      // Asked after its Stop, by hooks that may take a while on a loaded machine.
      await expect.poll(pending, { timeout: 10_000 }).toBe(1)
      const own = join(
        shell.home,
        "received.jsonl.sessions/2026/10/03/rollout-2026-10-03T00-00-01-a1.jsonl",
      )
      mkdirSync(dirname(own), { recursive: true })
      const abort = () =>
        appendFileSync(
          own,
          `${JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } })}\n`,
        )
      // Esc on its first request ends that turn only: it still runs.
      abort()
      await expect.poll(pending, { timeout: 5_000 }).toBe(0)
      expect(activity()?.subagents).toHaveLength(1)
      // Rung, the root's turn ends, and the spawned agent asks again: followed again.
      expect(await tui.send("Review a.ts")).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
      await expect.poll(pending, { timeout: 5_000 }).toBe(1)
      abort()
      await expect.poll(pending, { timeout: 5_000 }).toBe(0)
    })

    it("stops following a spawned agent once its request settles or resolves, and when the binding ends", async ({
      shell,
    }) => {
      const watch = vi.spyOn(codexHarness, "watchActor")
      try {
        const tui = await ringing(shell, "subagain")
        const signals = () => watch.mock.calls.map((call) => call[3])
        const pending = () => tui.manager.get(tui.idle.id).activity?.attention.pending
        await tui.first()
        // Asked after its Stop, by hooks that may take a while on a loaded machine.
        await expect.poll(pending, { timeout: 10_000 }).toBe(1)
        await expect.poll(() => signals().length).toBe(1)
        expect(signals()[0]!.aborted).toBe(false)
        // Esc on it, as its rollout records: settled, no longer followed.
        const own = join(
          shell.home,
          "received.jsonl.sessions/2026/10/03/rollout-2026-10-03T00-00-01-a1.jsonl",
        )
        mkdirSync(dirname(own), { recursive: true })
        writeFileSync(
          own,
          `${JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "turn_aborted" } })}\n`,
        )
        await expect.poll(pending, { timeout: 5_000 }).toBe(0)
        expect(signals()[0]!.aborted).toBe(true)
        // Its next request, allowed with Enter: resolved, no longer followed.
        await tui.send("Review a.ts")
        await expect.poll(pending, { timeout: 10_000 }).toBe(1)
        await expect.poll(() => signals().length).toBe(2)
        expect(signals()[1]!.aborted).toBe(false)
        tui.type("\r")
        await expect.poll(pending, { timeout: 5_000 }).toBe(0)
        expect(signals()[1]!.aborted).toBe(true)
        // Another, then the agent exits: the binding ends, and its follower with it.
        await tui.send("Review b.ts")
        await expect.poll(pending, { timeout: 10_000 }).toBe(1)
        await expect.poll(() => signals().length).toBe(3)
        expect(signals()[2]!.aborted).toBe(false)
        tui.leave()
        await expect.poll(() => tui.manager.get(tui.idle.id).agent, { timeout: 5_000 }).toBeNull()
        expect(signals()[2]!.aborted).toBe(true)
      } finally {
        watch.mockRestore()
      }
    })

    it("rings no Settled TUI while a request asked after its Stop waits, and rings once it resolves", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "askafter")
      await tui.first()
      const pending = () => tui.manager.get(tui.idle.id).activity?.attention.pending
      // Asked after its Stop, by hooks that may take a while on a loaded machine.
      await expect.poll(pending, { timeout: 10_000 }).toBe(1)
      // Settled by its Stop, yet the request waits on the person: no ring.
      expect(tui.delivery()).toBe("settled")
      expect(await tui.send("Review a.ts")).toMatchObject({ ok: true })
      await quiet()
      expect(pastes(tui.raw())).toEqual([])
      expect(tui.received()).toHaveLength(1)
      // The person allows it; its dialog drew nothing, so the screen stays as it was.
      tui.type("\r")
      await expect.poll(pending, { timeout: 5_000 }).toBe(0)
      await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
      expect(tui.received()[1]!.printed).toContain(">Review a.ts</message>")
      expect(pastes(tui.raw())).toHaveLength(1)
    })

    it("rings no Claude Code TUI the person started typing in", async ({ shell }) => {
      const tui = await ringing(shell, "", "tui", "claude", "s-idle")
      tui.type("my first thought")
      await expect.poll(tui.delivery).toBe("drafting")
      expect(await tui.send("Review a.ts")).toMatchObject({
        text: reaches("ringing it once its box reads empty"),
      })
      await quiet()
      expect(pastes(tui.raw())).toEqual([])
      expect(tui.received()).toEqual([])
    })

    it("wakes a Codex TUI started plain once its title says Ready, before any session binds", async ({
      shell,
    }) => {
      const thread = "01a0f932-a824-7c30-b713-b59ed562f00b"
      const tui = await ringing(shell, "shown", "named", "codex", thread)
      // Told once its prompt's title or hook is checked against the terminal's foreground,
      // which macOS reads through ps, slow on a loaded machine.
      await expect.poll(tui.delivery, { timeout: 10_000 }).toBe("ready")
      expect(await tui.send("Review a.ts")).toMatchObject({
        ok: true,
        text: reaches("ringing it now"),
      })
      await vi.waitFor(() => expect(tui.received()).toHaveLength(1), { timeout: 10_000 })
      const [rung] = tui.received()
      expect(rung!.prompt).toMatch(
        /^\[Novadeck: automatic notice, agent messages waiting, [A-Za-z0-9]+\]$/,
      )
      expect(rung!.printed).toContain(">Review a.ts</message>")
      await expect
        .poll(() => tui.manager.messages(tui.idle.id).threads[0]?.messages[0]?.state)
        .toBe("delivered")
      await expect.poll(tui.delivery).toBe("settled")
    })

    it("takes no Codex title as its prompt while Novadeck's hooks aren't trusted there", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "shown", "named", "codex", "01a0f932-a824", false)
      await quiet()
      expect(tui.delivery()).toBe("unbound")
      expect(await tui.send("Review a.ts")).toMatchObject({ ok: false })
    })

    it("takes no title as Codex's unless a codex process holds the terminal's foreground", async ({
      shell,
    }) => {
      // The same title, from a program of another name.
      const tui = await ringing(shell, "shown", "tui", "codex", "01a0f932-a824")
      await quiet()
      expect(tui.delivery()).toBe("unbound")
    })

    it("wakes an Antigravity TUI started plain once its status line says idle", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "shown", "named-agy", "agy")
      // Told once its prompt's title or hook is checked against the terminal's foreground,
      // which macOS reads through ps, slow on a loaded machine.
      await expect.poll(tui.delivery, { timeout: 10_000 }).toBe("ready")
      expect(await tui.send("Review a.ts")).toMatchObject({
        ok: true,
        text: reaches("ringing it now"),
      })
      await vi.waitFor(() => expect(tui.received()).toHaveLength(1), { timeout: 10_000 })
      expect(tui.received()[0]!.printed).toContain(">Review a.ts</message>")
      await expect
        .poll(() => tui.manager.messages(tui.idle.id).threads[0]?.messages[0]?.state)
        .toBe("delivered")
    })

    it("names an agent ready at its prompt until the person presses Enter there", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "shown", "named-agy", "agy")
      const summary = () =>
        tui.manager.list(tui.idle.sessionId).find(({ id }) => id === tui.idle.id)
      await expect.poll(() => summary()?.ready).toBe("agy")
      // Only its first prompt's hooks bind it: until then nothing says it is idle.
      tui.manager.write({ terminalId: tui.idle.id, data: "\r" }, "owner")
      expect(summary()?.ready).toBeNull()
    })

    it("names a Codex ready again once an Enter at its prompt started nothing", async ({
      shell,
    }) => {
      const thread = "01a0f932-a824-7c30-b713-b59ed562f00b"
      const tui = await ringing(shell, "shown", "named", "codex", thread)
      const summary = () =>
        tui.manager.list(tui.idle.sessionId).find(({ id }) => id === tui.idle.id)
      await expect.poll(() => summary()?.ready).toBe("codex")
      // An empty box: Enter submits nothing, binds nothing, and retitles nothing.
      tui.manager.write({ terminalId: tui.idle.id, data: "\r" }, "owner")
      expect(summary()?.ready).toBeNull()
      await expect.poll(() => summary()?.ready, { timeout: readyReturnMs + 3_000 }).toBe("codex")
      expect(summary()?.agent).toBeNull()
    })

    // Each harness tells of a resumed session its own way: Claude Code's SessionStart,
    // Codex's title naming the thread, Antigravity's status line naming the conversation.
    for (const [agent, program] of [
      ["claude", "tui"],
      ["codex", "named"],
      ["agy", "tui"],
    ] as const)
      it(`wakes ${agent} resumed at its prompt, as after a runner restart`, async ({ shell }) => {
        const tui = await ringing(
          shell,
          "resumed",
          program,
          agent,
          "01a0f932-a824-7c30-b713-b59ed562f00b",
        )
        // Told once its prompt's title or hook is checked against the terminal's foreground,
        // which macOS reads through ps, slow on a loaded machine.
        await expect.poll(tui.delivery, { timeout: 10_000 }).toBe("ready")
        expect(await tui.send("Review a.ts")).toMatchObject({
          ok: true,
          text: reaches("ringing it now"),
        })
        await vi.waitFor(() => expect(tui.received()).toHaveLength(1), { timeout: 10_000 })
        expect(tui.received()[0]!.printed).toContain(">Review a.ts</message>")
      })

    // Each harness tells of /clear its own way: Claude Code's SessionStart, Codex's title
    // naming another thread, Antigravity's status line naming another conversation.
    for (const [agent, program, mode] of [
      ["claude", "tui", ""],
      ["codex", "named", "shown"],
      ["agy", "tui", "shown"],
    ] as const)
      it(`wakes ${agent} at its prompt after /clear, its new session's hook delivering`, async ({
        shell,
      }) => {
        const tui = await ringing(
          shell,
          mode,
          program,
          agent,
          "01a0f932-a824-7c30-b713-b59ed562f00b",
        )
        await tui.first()
        tui.type("/clear")
        await shell.until(tui.manager, tui.idle.id, "> /clear")
        tui.type("\r")
        await expect.poll(tui.delivery, { timeout: 10_000 }).toBe("ready")
        expect(await tui.send("Review a.ts")).toMatchObject({
          ok: true,
          text: reaches("ringing it now"),
        })
        await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
        expect(tui.received()[1]!.printed).toContain(">Review a.ts</message>")
        await expect
          .poll(() => tui.manager.messages(tui.idle.id).threads[0]?.messages[0]?.state)
          .toBe("delivered")
      })

    it("keeps a session that bound while a title naming it was still being checked", async ({
      shell,
    }) => {
      let holding = false
      let asked!: () => void
      const checking = new Promise<void>((resolve) => (asked = resolve))
      let answer!: (trusted: boolean) => void
      // The initial title can be superseded by the person's first keys before its trust
      // check runs. Hold the check after /clear by phase, regardless of earlier checks.
      const trust = () => {
        if (!holding) return Promise.resolve(true)
        asked()
        return new Promise<boolean>((resolve) => (answer = resolve))
      }
      const thread = "01a0f932-a824-7c30-b713-b59ed562f00b"
      const tui = await ringing(shell, "shownbusy", "named", "codex", thread, trust)
      await tui.first()
      holding = true
      tui.type("/clear")
      await shell.until(tui.manager, tui.idle.id, "> /clear")
      tui.type("\r")
      await checking
      // The new thread's own first prompt binds it, and its turn runs, before the title's
      // check answers.
      tui.type("next")
      await shell.until(tui.manager, tui.idle.id, "> next")
      tui.type("\r")
      // Its prompt hook reports the turn, which may take a while on a loaded machine.
      await expect.poll(tui.delivery, { timeout: 10_000 }).toBe("working")
      answer(true)
      await quiet()
      expect(tui.delivery()).toBe("working")
      expect(tui.manager.get(tui.idle.id).agent).not.toBeNull()
    })

    it("keeps a Codex binding when its title names a thread started during its turn, as a spawned agent's", async ({
      shell,
    }) => {
      const thread = "01a0f932-a824-7c30-b713-b59ed562f00b"
      const tui = await ringing(shell, "shownbusy", "named", "codex", thread)
      await tui.first()
      tui.type("next")
      await shell.until(tui.manager, tui.idle.id, "> next")
      tui.type("\r")
      await expect.poll(tui.delivery).toBe("working")
      tui.spawn()
      await quiet()
      expect(tui.delivery()).toBe("working")
      expect(tui.manager.get(tui.idle.id).agent).not.toBeNull()
    })

    it("drops a prompt shown before the shell's prompt came back, however long its check took", async ({
      shell,
    }) => {
      let asked!: () => void
      const checking = new Promise<void>((resolve) => (asked = resolve))
      let answer!: (trusted: boolean) => void
      const slow = () => {
        asked()
        return new Promise<boolean>((resolve) => (answer = resolve))
      }
      const tui = await ringing(shell, "shown", "named", "codex", "01a0f932-a824", slow)
      await checking
      // Codex quits while its hooks are still being asked about; the shell's prompt returns.
      tui.type("\x04")
      await quiet()
      answer(true)
      await quiet()
      expect(tui.delivery()).toBe("unbound")
      expect(await tui.send("Review a.ts")).toMatchObject({ ok: false })
    })

    it("refuses a Codex at its prompt whose hooks its app-server says aren't trusted", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "shown", "named", "codex", "01a0f932-a824", false)
      await expect
        .poll(async () => (await tui.send("Review a.ts")) as unknown)
        .toMatchObject({ ok: false, reason: expect.stringContaining("/hooks") })
    })

    it("asks about its hooks again once the person's keys pause, as after trusting them in /hooks", async ({
      shell,
    }) => {
      let trusted = false
      const tui = await ringing(shell, "shown", "named", "codex", "01a0f932-a824", () =>
        Promise.resolve(trusted),
      )
      await expect
        .poll(async () => (await tui.send("Review a.ts")) as unknown)
        .toMatchObject({ ok: false, reason: expect.stringContaining("/hooks") })
      // The person trusts them in Codex's /hooks and closes it, which sets no new title.
      trusted = true
      tui.type("\x1b")
      await expect.poll(tui.delivery, { timeout: 5_000 }).toBe("ready")
      expect(await tui.send("Review a.ts")).toMatchObject({ ok: true })
    })

    it("takes a Codex whose trust check couldn't answer as unknown, never untrusted", async ({
      shell,
    }) => {
      let checked!: () => void
      const checking = new Promise<void>((resolve) => (checked = resolve))
      const failing = () => {
        checked()
        return Promise.resolve(undefined)
      }
      const tui = await ringing(shell, "shown", "named", "codex", "01a0f932-a824", failing)
      await checking
      await quiet()
      expect(tui.delivery()).toBe("unbound")
      const answer = await tui.send("Review a.ts")
      expect(answer).toMatchObject({ ok: false })
      expect(JSON.stringify(answer)).not.toContain("/hooks")
    })

    it("reads the same Codex prompt again after an unknown trust answer recovers", async ({
      shell,
    }) => {
      let checks = 0
      const trust = () => Promise.resolve(++checks === 1 ? undefined : true)
      const tui = await ringing(shell, "shown", "named", "codex", "01a0f932-a824", trust)
      await expect.poll(tui.delivery, { timeout: 5_000 }).toBe("ready")
      expect(checks).toBe(2)
      expect(await tui.send("Review a.ts")).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(tui.received()).toHaveLength(1), { timeout: 10_000 })
      expect(tui.received()[0]!.printed).toContain(">Review a.ts</message>")
    })

    it("stops asking about an unchanged Codex prompt after three unknown answers", async ({
      shell,
    }) => {
      let checks = 0
      const tui = await ringing(shell, "shown", "named", "codex", "01a0f932-a824", () => {
        checks += 1
        return Promise.resolve(undefined)
      })
      await vi.waitFor(() => expect(checks).toBe(3), { timeout: 5_000 })
      await quiet()
      expect(checks).toBe(3)
      expect(tui.delivery()).toBe("unbound")
      expect(JSON.stringify(await tui.send("Review a.ts"))).not.toContain("/hooks")
    })

    for (const replacement of ["sleep", "codex"] as const)
      it(`drops a recovered trust answer after Codex exits into ${replacement} without retitling`, async ({
        shell,
      }) => {
        let checks = 0
        let checking!: () => void
        const pending = new Promise<void>((resolve) => {
          checking = resolve
        })
        let answer!: (trusted: boolean) => void
        const reply = new Promise<boolean>((resolve) => {
          answer = resolve
        })
        const tui = await ringing(
          shell,
          "shown",
          "named",
          "codex",
          "01a0f932-a824",
          () => {
            if (++checks === 1) return Promise.resolve(undefined)
            checking()
            return reply
          },
          undefined,
          replacement === "sleep"
            ? "echo replacement-'running'; sleep 30"
            : `'${join(shell.home, "named", "codex")}' -c "echo replacement-'running'; sleep 30; :"`,
        )
        await pending
        tui.leave()
        await shell.until(tui.manager, tui.idle.id, "replacement-running")
        expect(tui.delivery()).toBe("unbound")
        answer(true)
        await quiet()
        expect(tui.delivery()).toBe("unbound")
        expect(tui.received()).toHaveLength(0)
      })

    it("stops retrying once Codex confirms that its hooks aren't trusted", async ({ shell }) => {
      let checks = 0
      const tui = await ringing(shell, "shown", "named", "codex", "01a0f932-a824", () =>
        Promise.resolve(++checks === 1 ? undefined : false),
      )
      await expect
        .poll(async () => (await tui.send("Review a.ts")) as unknown, { timeout: 5_000 })
        .toMatchObject({ ok: false, reason: expect.stringContaining("/hooks") })
      await quiet()
      expect(checks).toBe(2)
      expect(tui.delivery()).toBe("unbound")
    })

    for (const changed of ["title", "draft", "session", "process", "terminal"] as const)
      it(`drops an unknown Codex trust retry after its ${changed} changes`, async ({ shell }) => {
        let checks = 0
        const tui = await ringing(shell, "shown", "named", "codex", "01a0f932-a824", () => {
          checks += 1
          return Promise.resolve(undefined)
        })
        await vi.waitFor(() => expect(checks).toBe(1))
        if (changed === "title") tui.title("Working | 01a0f932-a824")
        else if (changed === "draft") {
          tui.type("my own draft")
          await shell.until(tui.manager, tui.idle.id, "> my own draft")
        } else if (changed === "session") await tui.first()
        else if (changed === "process") {
          tui.leave()
          await shell.until(tui.manager, tui.idle.id, "$ ")
          tui.type("sleep 10\r")
        } else await tui.manager.close({ terminalId: tui.idle.id })
        await quiet()
        expect(checks).toBe(1)
        expect(tui.received()).toHaveLength(changed === "session" ? 1 : 0)
      })

    it("marks no terminal untrusted by an answer that came after its agent left", async ({
      shell,
    }) => {
      let asked!: () => void
      const checking = new Promise<void>((resolve) => (asked = resolve))
      let answer!: (trusted: boolean) => void
      const slow = () => {
        asked()
        return new Promise<boolean>((resolve) => (answer = resolve))
      }
      const tui = await ringing(shell, "shown", "named", "codex", "01a0f932-a824", slow)
      await checking
      // Codex quits while its hooks are still being asked about; the shell's prompt returns.
      tui.type("\x04")
      await quiet()
      answer(false)
      await quiet()
      const refused = await tui.send("Review a.ts")
      expect(refused).toMatchObject({ ok: false })
      expect(JSON.stringify(refused)).not.toContain("/hooks")
    })

    it("rings no prompt shown in a nested shell once its agent has left unseen", async ({
      shell,
    }) => {
      // A nested shell without Novadeck's integration tells no prompt of its own.
      const tui = await ringing(
        shell,
        "shown",
        "named",
        "codex",
        "01a0f932-a824",
        true,
        "PS1='nested$ ' bash --norc --noprofile",
      )
      // Told once its prompt's title or hook is checked against the terminal's foreground,
      // which macOS reads through ps, slow on a loaded machine.
      await expect.poll(tui.delivery, { timeout: 10_000 }).toBe("ready")
      tui.leave()
      await shell.until(tui.manager, tui.idle.id, /> nested\$/)
      // Still Ready, as nothing told it the agent left: the ring's foreground check does.
      expect(tui.delivery()).toBe("ready")
      expect(await tui.send("Review a.ts")).toMatchObject({ ok: true })
      await quiet()
      expect(await screen(tui.manager, tui.idle.id)).not.toContain("automatic notice")
      expect(tui.delivery()).toBe("ready")
    })

    it("ends a bound agent that left unseen once another agent's title shows, its messages gone", async ({
      shell,
    }) => {
      // Claude Code, then Codex, in one command line: no shell prompt shows between them.
      const thread = "01a0f932-a824-7c30-b713-b59ed562f00b"
      const { manager, idle, send, file, leave } = await leaving(
        shell,
        `named codex ${thread} '${join(shell.home, "new.jsonl")}' '${join(shell.home, "new-raw.jsonl")}' shown`,
      )
      // Paused, the message waits for Claude Code's session rather than ringing it.
      manager.pauseMessages(true)
      const first = await send("For the old session")
      await leave()
      await shell.until(manager, idle.id, "codex ready")
      // Codex's title shows its prompt: Claude Code's binding ended, its message gone.
      await expect.poll(() => manager.messages(idle.id).threads[0]?.messages[0]?.state).toBe("gone")
      await expect.poll(() => manager.messages(idle.id).delivery).toBe("ready")
      expect(manager.get(idle.id).agent).toBeNull()
      manager.pauseMessages(false)
      const second = await send("For the new session")
      expect(second.text).toContain(`Your earlier message ${messageId(first)} to `)
      await vi.waitFor(() => expect(lines(file("new.jsonl"))).toHaveLength(1), { timeout: 10_000 })
      const [rung] = lines<{ printed: string }>(file("new.jsonl"))
      expect(rung!.printed).toContain(">For the new session</message>")
      expect(rung!.printed).not.toContain("For the old session")
    })

    it("shows another agent's title prompt though a ring check ended the binding it found while it asked", async ({
      shell,
    }) => {
      // As `leaving`, but whether Codex's hooks run there takes a while to tell, and the
      // doorbell isn't paused: its check finds Claude Code gone and ends that binding
      // while the title's question is out.
      const bin = standIn(shell.home)
      standInTui(shell.home)
      const manager = shell.manager({
        env: {
          HOME: shell.home,
          PS1: "$ ",
          PATH: `${bin}:${process.env.PATH}`,
          CODEX_HOME: join(shell.home, ".codex"),
        },
        doorbell: { calmMs: 200, settleMs: 300, watchMs: 100, boxCheck: false },
        hooksTrusted: (agent) =>
          agent === "codex"
            ? new Promise((resolve) => setTimeout(() => resolve(true), 2_000))
            : Promise.resolve(true),
      })
      const sender = await create(manager, shell)
      const idle = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(sender.id, "claude", "s-claude")
      const file = (name: string) => join(shell.home, name)
      const thread = "01a0f932-a824-7c30-b713-b59ed562f00b"
      manager.write(
        {
          terminalId: idle.id,
          data: `tui claude s-old '${file("old.jsonl")}' '${file("old-raw.jsonl")}' '' ; named codex ${thread} '${file("new.jsonl")}' '${file("new-raw.jsonl")}' shown\r`,
        },
        "owner",
      )
      await shell.until(manager, idle.id, "claude ready")
      await expect.poll(() => manager.get(idle.id).agent).toBe("claude")
      await expect.poll(() => manager.messages(idle.id).delivery).toBe("ready")
      const pid = Number(readFileSync(file("old-raw.jsonl.pid"), "utf8"))
      process.kill(pid, "SIGUSR2")
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 })
      // Codex's title is out, its question pending, while Claude Code's binding stands.
      await shell.until(manager, idle.id, "codex ready")
      expect(manager.get(idle.id).agent).toBe("claude")
      await step(sender.id, {
        call: "send",
        request: { to: idle.handle, text: "For the old session" },
      })
      await expect.poll(() => manager.get(idle.id).agent).toBeNull()
      expect(manager.messages(idle.id).delivery).toBe("unbound")
      // The title's answer, once it comes, shows Codex's prompt as from no binding.
      await expect.poll(() => manager.messages(idle.id).delivery, { timeout: 5_000 }).toBe("ready")
    })

    it("rings no bound agent that left unseen, and ends its binding, its messages gone", async ({
      shell,
    }) => {
      // Claude Code leaves, and the line goes on with a program of no agent's: no prompt.
      const { manager, idle, send, leave } = await leaving(shell, "sleep 60")
      await expect.poll(() => manager.messages(idle.id).delivery).toBe("ready")
      await leave()
      const id = messageId(await send("For the old session"))
      await quiet()
      expect(await screen(manager, idle.id)).not.toContain("automatic notice")
      expect(manager.messages(idle.id).threads[0]?.messages[0]).toMatchObject({ id, state: "gone" })
      expect(manager.messages(idle.id).delivery).toBe("unbound")
      expect(manager.get(idle.id).agent).toBeNull()
    })

    it("keeps a Codex binding when its title names a /side conversation, which no new lock confirms", async ({
      shell,
    }) => {
      const tui = await ringing(
        shell,
        "shown",
        "named",
        "codex",
        "01a0f932-a824-7c30-b713-b59ed562f00b",
      )
      await tui.first()
      tui.type("/side")
      await shell.until(tui.manager, tui.idle.id, "> /side")
      tui.type("\r")
      await quiet()
      expect(tui.manager.get(tui.idle.id).agent).not.toBeNull()
      expect(tui.delivery()).toBe("drafting")
    })

    it("rings no agent whose start says nothing of its screen, before its first turn", async ({
      shell,
    }) => {
      // Codex announces a session only with its first prompt, so its binding proves nothing.
      const tui = await ringing(shell)
      await expect.poll(tui.delivery).toBe("fresh")
      expect(await tui.send("Review a.ts")).toMatchObject({
        text: reaches("ringing it once its box reads empty"),
      })
      await quiet()
      expect(pastes(tui.raw())).toEqual([])
      // The person's first prompt carries it.
      await tui.first()
      expect(tui.received()[0]!.printed).toContain(">Review a.ts</message>")
    })

    it("presses nothing when the paste lands nowhere, as in an open menu", async ({ shell }) => {
      const tui = await ringing(shell, "menu")
      tui.type("hello")
      await shell.until(tui.manager, tui.idle.id, "> hello")
      tui.type("\r")
      await shell.until(tui.manager, tui.idle.id, "[menu] pick an item")
      await expect.poll(tui.delivery).toBe("settled")
      await tui.send("Review a.ts")
      // The ring fails: Unknown, the message waits, and no Enter picked the menu's item.
      await expect.poll(tui.delivery, { timeout: 5_000 }).toBe("unknown")
      await quiet()
      expect(tui.received().some(({ picked }) => picked)).toBe(false)
      expect(tui.manager.messages(tui.idle.id).threads[0]?.messages[0]?.state).toBe("queued")
    })

    it("never submits what the person typed after their Enter, before its hook", async ({
      shell,
    }) => {
      const tui = await ringing(shell)
      tui.type("hello")
      await shell.until(tui.manager, tui.idle.id, "> hello")
      // The person keeps typing at once, before the prompt hook reports.
      tui.type("\r")
      tui.type("my half-typed next thought")
      await tui.back(1)
      await expect.poll(tui.delivery).toBe("drafting")
      await tui.send("Review a.ts")
      await quiet()
      expect(pastes(tui.raw())).toEqual([])
      expect(tui.received().map(({ prompt }) => prompt)).toEqual(["hello"])
    })

    it("holds what the person types during the ring, and gives it to the TUI after", async ({
      shell,
    }) => {
      const tui = await ringing(shell)
      await tui.first()
      await tui.send("Review a.ts")
      await vi.waitFor(
        async () => expect(await screen(tui.manager, tui.idle.id)).toContain("automatic notice"),
        { timeout: 10_000, interval: 5 },
      )
      tui.type("xyz")
      await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
      await vi.waitFor(() => expect(tui.raw().join("")).toContain("xyz"))
      const raw = tui.raw().join("")
      // Their keys come after the doorbell's Enter, never into its line.
      expect(raw.indexOf("xyz")).toBeGreaterThan(raw.lastIndexOf("\r"))
      expect(tui.received()[1]!.prompt).toMatch(/^\[Novadeck: automatic notice/)
      // What they typed waits in the box.
      await expect.poll(tui.delivery).toBe("drafting")
    })

    it("holds a resize during the ring, submits its line, and resizes after", async ({ shell }) => {
      const tui = await ringing(shell)
      await tui.first()
      await tui.send("Review a.ts")
      await vi.waitFor(
        async () => expect(await screen(tui.manager, tui.idle.id)).toContain("automatic notice"),
        { timeout: 10_000, interval: 5 },
      )
      // A pane changing size mid-ring would redraw the screen the line is checked on.
      tui.manager.resize({ terminalId: tui.idle.id, cols: 70, rows: 20 }, "owner")
      await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
      expect(tui.received()[1]!.prompt).toMatch(/^\[Novadeck: automatic notice/)
      expect(pastes(tui.raw())).toHaveLength(1)
      await expect.poll(() => tui.manager.get(tui.idle.id)).toMatchObject({ cols: 70, rows: 20 })
    })

    it("lets the person's keys go after the ring's Enter, and its held resize once its prompt confirms it", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "latehook")
      await tui.first()
      const { cols, rows } = tui.manager.get(tui.idle.id)
      await tui.send("Review a.ts")
      await vi.waitFor(
        async () => expect(await screen(tui.manager, tui.idle.id)).toContain("automatic notice"),
        { timeout: 10_000, interval: 5 },
      )
      tui.manager.resize({ terminalId: tui.idle.id, cols: 70, rows: 20 }, "owner")
      // Its Enter went; its prompt's hook is still to report.
      // eslint-disable-next-line no-control-regex -- A bracketed paste's end marker.
      await vi.waitFor(() => expect(tui.raw().join("")).toMatch(/\x1b\[201~[\s\S]*\r/), {
        timeout: 5_000,
      })
      tui.type("xyz")
      await vi.waitFor(() => expect(tui.raw().join("")).toContain("xyz"))
      expect(tui.received()).toHaveLength(1)
      expect(tui.manager.get(tui.idle.id)).toMatchObject({ cols, rows })
      // Its prompt confirms the ring: the size it held goes on.
      await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
      await expect.poll(() => tui.manager.get(tui.idle.id)).toMatchObject({ cols: 70, rows: 20 })
    })

    // The turn the TUI starts by itself may reach Novadeck before the doorbell's Enter, or
    // after it, as on a loaded machine (macOS CI): either way the doorbell writes one
    // Enter at most, and its line is never submitted.
    for (const mode of ["", "slowkick"] as const)
      it(`abandons a ring a turn cuts short, and never submits its line later${mode ? ", the turn reported late" : ""}`, async ({
        shell,
      }) => {
        const tui = await ringing(shell, mode)
        await tui.first()
        const before = tui.raw().length
        await tui.send("one")
        await vi.waitFor(
          async () => expect(await screen(tui.manager, tui.idle.id)).toContain("automatic notice"),
          { timeout: 10_000, interval: 5 },
        )
        tui.kick()
        await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
        await expect.poll(tui.delivery).toBe("drafting")
        await tui.send("two")
        await quiet()
        expect(tui.received().map(({ prompt }) => prompt)).toEqual(["hello", "background result"])
        // Since the person's first prompt: one paste, and at most its one Enter.
        const ring = tui.raw().slice(before)
        expect(pastes(ring)).toHaveLength(1)
        expect(ring.join("").split("\r").length - 1).toBeLessThanOrEqual(1)
        if (mode === "slowkick") expect(ring.join("").split("\r").length - 1).toBe(1)
      })

    it("takes typing while an approved tool runs as a draft, not an answer", async ({ shell }) => {
      const tui = await ringing(shell, "perm")
      await tui.first()
      tui.type("run the tests")
      await shell.until(tui.manager, tui.idle.id, "> run the tests")
      tui.type("\r")
      await shell.until(tui.manager, tui.idle.id, "running npm test")
      // While the approved command runs, the person types their next request.
      tui.type("next: also fix the lint")
      await vi.waitFor(() => expect(tui.raw().join("")).toContain("next: also fix the lint"))
      await expect.poll(tui.delivery, { timeout: 5_000 }).toBe("drafting")
      await tui.send("Review a.ts")
      await quiet()
      expect(pastes(tui.raw())).toEqual([])
    })

    for (const [name, keys] of [
      ["a paste", "\x1b[200~next: also fix the lint\x1b[201~"],
      ["Up, recalling the last prompt", "\x1b[A"],
      ["one hotkey", "y"],
    ] as const)
      it(`takes ${name} while a request waits but shows no dialog as a draft`, async ({
        shell,
      }) => {
        const tui = await ringing(shell, "perm")
        await tui.first()
        tui.type("run the tests")
        await shell.until(tui.manager, tui.idle.id, "> run the tests")
        tui.type("\r")
        await shell.until(tui.manager, tui.idle.id, "running npm test")
        // The request still waits while its tool runs; nothing shows a dialog.
        tui.type(keys)
        await vi.waitFor(() => expect(tui.raw().join("")).toContain(keys))
        await expect.poll(tui.delivery, { timeout: 5_000 }).toBe("drafting")
        await tui.send("Review a.ts")
        await quiet()
        expect(pastes(tui.raw()).filter((data) => data.includes("automatic notice"))).toEqual([])
        expect(tui.received()).toHaveLength(2)
      })

    it("keeps a draft typed while a tool runs, after Enter approves another request", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "perm2")
      await tui.first()
      tui.type("run the tests")
      await shell.until(tui.manager, tui.idle.id, "> run the tests")
      tui.type("\r")
      await shell.until(tui.manager, tui.idle.id, "running npm test")
      tui.type("next: fix lint")
      await shell.until(tui.manager, tui.idle.id, "[dialog]")
      // Enter approves the second request; the draft stays in the box.
      tui.type("\r")
      await shell.until(tui.manager, tui.idle.id, "lint approved")
      await expect.poll(tui.delivery, { timeout: 5_000 }).toBe("drafting")
      await tui.send("Review a.ts")
      await quiet()
      expect(pastes(tui.raw()).filter((data) => data.includes("automatic notice"))).toEqual([])
    })

    it("keeps a draft whose Enter made a newline while a request waits", async ({ shell }) => {
      const tui = await ringing(shell, "perm")
      await tui.first()
      tui.type("run the tests")
      await shell.until(tui.manager, tui.idle.id, "> run the tests")
      tui.type("\r")
      await shell.until(tui.manager, tui.idle.id, "running npm test")
      // A backslash, then Enter: a newline in the box, as Claude Code takes it.
      tui.type("next: fix lint\\")
      tui.type("\r")
      await vi.waitFor(() => expect(tui.raw().join("")).toContain("lint\\\r"))
      await expect.poll(tui.delivery, { timeout: 5_000 }).toBe("drafting")
      await tui.send("Review a.ts")
      await quiet()
      expect(pastes(tui.raw()).filter((data) => data.includes("automatic notice"))).toEqual([])
    })

    it("applies a draft typed while asked before the prompt that clears the request", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "askfirst")
      await tui.first()
      tui.type("run the tests")
      await shell.until(tui.manager, tui.idle.id, "> run the tests")
      // The person's Enter, a request before the turn starts, and a hotkey answering it:
      // the turn's prompt comes within the Enter's window, as the request clears.
      tui.type("\r")
      await shell.until(tui.manager, tui.idle.id, "[dialog]")
      tui.type("1")
      await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
      // Had the prompt come before the clear, the Enter would have counted, the hotkey not.
      await expect.poll(tui.delivery, { timeout: 5_000 }).toBe("drafting")
    })

    it("keeps a draft typed before a late hook of a failed ring", async ({ shell }) => {
      const tui = await ringing(shell, "slowhook")
      await tui.first()
      await tui.send("one")
      // The doorbell's Enter goes in; its hook comes after the 5 s confirmation lapsed.
      await vi.waitFor(() => expect(tui.raw().join("").split("\r").length).toBeGreaterThan(2), {
        timeout: 10_000,
      })
      await expect.poll(tui.delivery, { timeout: 8_000 }).toBe("unknown")
      tui.type("my draft")
      await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
      await expect.poll(tui.delivery, { timeout: 5_000 }).toBe("drafting")
      await tui.send("two")
      await quiet()
      expect(tui.received().map(({ prompt }) => prompt)).toHaveLength(2)
    })

    it("takes Shift+Enter as a newline in the draft, never a submission", async ({ shell }) => {
      const tui = await ringing(shell)
      await tui.first()
      tui.type("first line")
      tui.type("\x1b\r")
      tui.type("second line")
      await vi.waitFor(() => expect(tui.raw().join("")).toContain("second line"))
      // A turn the TUI starts by itself just after: not the person's submission.
      tui.kick()
      await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
      await expect.poll(tui.delivery).toBe("drafting")
      await tui.send("Review a.ts")
      await quiet()
      expect(pastes(tui.raw())).toEqual([])
    })

    for (const agent of ["codex", "claude", "agy"] as const)
      it(`takes ${agent}'s open asks out of the Inbox at the person's own prompt, and tells it`, async ({
        shell,
      }) => {
        const tui = await ringing(shell, "asking", "tui", agent)
        if (agent === "agy") await agyStarted(tui)
        else await tui.first()
        const asking = () =>
          tui.manager.inboxEntries().filter(({ content }) => content.kind === "ask")
        await expect.poll(asking, { timeout: 10_000 }).toHaveLength(1)
        // A turn the agent's harness starts by itself leaves it there.
        const turns = tui.received().length
        tui.kick()
        await vi.waitFor(() => expect(tui.received()).toHaveLength(turns + 1), { timeout: 10_000 })
        await tui.back(2)
        await expect.poll(tui.delivery, { timeout: 10_000 }).toBe("settled")
        expect(asking()).toHaveLength(1)
        expect(tui.received().at(-1)!.printed).not.toContain("took your open ask")
        // The person writes to it in its terminal.
        tui.type("blue, please")
        await shell.until(tui.manager, tui.idle.id, "> blue, please")
        tui.type("\r")
        await vi.waitFor(() => expect(tui.received()).toHaveLength(turns + 2), { timeout: 10_000 })
        // Out of the Inbox once the relay acknowledged printing the notice.
        await expect.poll(() => asking().map(({ settled }) => settled?.how)).toEqual(["replied"])
        const printed = tui.received().at(-1)!.printed
        expect(printed).toContain("took your open ask out of their Inbox")
        expect(printed).toContain("Which colour?")
      })

    for (const agent of ["codex", "claude", "agy"] as const) {
      // The agent asks, the person writes to it, and the answer to its prompt hook is lost:
      // the relay never prints it, so it never acknowledges it.
      const lost = async (shell: Fixture, later: boolean) => {
        const tui = await ringing(shell, "askinglost", "tui", agent)
        if (agent === "agy") await agyStarted(tui)
        else await tui.first()
        const asking = () =>
          tui.manager.inboxEntries().filter(({ content }) => content.kind === "ask")
        await expect.poll(asking, { timeout: 10_000 }).toHaveLength(1)
        const call = join(shell.home, "raw.jsonl.later")
        if (!later) writeFileSync(join(shell.home, "raw.jsonl.nolater"), "")
        tui.type("blue, please")
        await shell.until(tui.manager, tui.idle.id, "> blue, please")
        tui.type("\r")
        await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
        await tui.back(2)
        expect(tui.received()[1]!.printed).not.toContain("took your open ask")
        return { tui, asking, call }
      }

      it(`keeps ${agent}'s ask open when the answer telling it is lost, and withdraws it once a later hook of the turn prints the notice`, async ({
        shell,
      }) => {
        const { asking, call } = await lost(shell, true)
        await vi.waitFor(() => expect(existsSync(call)).toBe(true), { timeout: 10_000 })
        const printed = readFileSync(call, "utf8")
        expect(printed).toContain("took your open ask out of their Inbox")
        expect(printed).toContain("Which colour?")
        await expect.poll(() => asking().map(({ settled }) => settled?.how)).toEqual(["replied"])
      })

      it(`leaves ${agent}'s ask open when its turn ends with the notice never printed`, async ({
        shell,
      }) => {
        const { tui, asking } = await lost(shell, false)
        expect(asking().filter(({ settled }) => !settled)).toHaveLength(1)
        // Nor does a later turn the agent's harness starts tell it of the ask the person's
        // prompt of that turn was to take.
        const turns = tui.received().length
        tui.kick()
        await vi.waitFor(() => expect(tui.received()).toHaveLength(turns + 1), { timeout: 10_000 })
        await tui.back(3)
        expect(tui.received().at(-1)!.printed).not.toContain("took your open ask")
        expect(asking().filter(({ settled }) => !settled)).toHaveLength(1)
      })
    }

    for (const agent of ["codex", "claude", "agy"] as const)
      it(`shows ${agent}'s standing done in its summary until the person's prompt or a message gives it more`, async ({
        shell,
      }) => {
        const tui = await ringing(shell, "donecall", "tui", agent)
        if (agent === "agy") await agyStarted(tui)
        else await tui.first()
        const reported = () => tui.manager.get(tui.idle.id).reported?.subject
        await expect.poll(reported, { timeout: 10_000 }).toBe("Shipped it")
        // Reading the entry leaves the Inbox, not the report that stands.
        const entries = tui.manager.inboxEntries().filter(({ content }) => content.kind === "done")
        expect(entries).toHaveLength(1)
        tui.manager.readTells(entries.map(({ id }) => id))
        expect(tui.manager.inboxEntries()).toEqual([])
        expect(reported()).toBe("Shipped it")
        // The person writes to it in its terminal: more to do.
        const turns = tui.received().length
        tui.type("one more thing")
        await shell.until(tui.manager, tui.idle.id, "one more thing")
        tui.type("\r")
        await vi.waitFor(() => expect(tui.received()).toHaveLength(turns + 1), { timeout: 10_000 })
        await expect.poll(reported, { timeout: 10_000 }).toBeUndefined()
      })

    it("clears a standing done when a peer's message is delivered to the agent", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "donecall", "tui", "codex")
      await tui.first()
      await expect
        .poll(() => tui.manager.get(tui.idle.id).reported?.subject, { timeout: 10_000 })
        .toBe("Shipped it")
      await tui.back(1)
      await tui.send("Review a.ts")
      await vi.waitFor(() => expect(tui.received().length).toBeGreaterThan(1), { timeout: 10_000 })
      await expect.poll(() => tui.manager.get(tui.idle.id).reported, { timeout: 10_000 }).toBeNull()
    })

    it("sends an Inbox button's fixed line through agents.prompt without taking Codex's asks out, but the person's next words do", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "askbox", "tui", "codex")
      tui.type("hello")
      await shell.until(tui.manager, tui.idle.id, "\u203a hello")
      tui.type("\r")
      await expect.poll(tui.delivery, { timeout: 10_000 }).toBe("settled")
      await tui.back(1)
      const asking = () =>
        tui.manager.inboxEntries().filter(({ content }) => content.kind === "ask")
      await expect.poll(asking, { timeout: 10_000 }).toHaveLength(1)
      // The line goes in as a paste and an Enter, and its hook prints the real prompt text.
      await tui.manager.prompt({ terminalId: tui.idle.id, text: "continue\r\n", automatic: true })
      await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
      expect(tui.received()[1]!.prompt).toBe("continue")
      await tui.back(2)
      await expect.poll(tui.delivery, { timeout: 10_000 }).toBe("settled")
      expect(asking()).toHaveLength(1)
      expect(tui.received()[1]!.printed).not.toContain("took your open ask")
      // The person's own words next.
      tui.type("blue, please")
      await shell.until(tui.manager, tui.idle.id, "\u203a blue, please")
      tui.type("\r")
      await vi.waitFor(() => expect(tui.received()).toHaveLength(3), { timeout: 10_000 })
      await expect.poll(() => asking().map(({ settled }) => settled?.how)).toEqual(["replied"])
      expect(tui.received()[2]!.printed).toContain("took your open ask out of their Inbox")
    })

    it("rings an agent whose process group holds the terminal's foreground", async ({ shell }) => {
      // Under its harness's name, so its hooks name its instance.
      const tui = await ringing(shell, "", "named")
      await tui.first()
      await tui.send("Review a.ts")
      await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
      expect(tui.received()[1]!.printed).toContain(">Review a.ts</message>")
    })

    it("rings an agent whose terminal only reported the mouse's scroll and motion and its focus since the turn", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "mouse", "named")
      await tui.first()
      await expect.poll(tui.delivery).toBe("settled")
      // A fullscreen TUI's scroll and the pointer moving over it, then the focus leaving:
      // none of them types.
      tui.type("\x1b[<64;40;10M\x1b[<65;40;10M")
      tui.type("\x1b[<35;12;7M")
      tui.type("\x1b[O")
      await quiet()
      await expect.poll(tui.delivery).toBe("settled")
      await tui.send("Review a.ts")
      await vi.waitFor(() => expect(tui.received()).toHaveLength(2), { timeout: 10_000 })
      // The doorbell's line alone: no report reached the box ahead of it.
      expect(tui.received()[1]!.prompt).toMatch(
        /^\[Novadeck: automatic notice, agent messages waiting, [A-Za-z0-9]+\]$/,
      )
      expect(tui.received()[1]!.printed).toContain(">Review a.ts</message>")
    })

    it("takes what looks like the mouse's scroll as typing while the agent's TUI reports no mouse", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "", "named")
      await tui.first()
      await expect.poll(tui.delivery).toBe("settled")
      // Without mouse reporting, no terminal sends one: it may be Alt+[ and typing.
      tui.type("\x1b[<64;40;10M")
      await expect.poll(tui.delivery).toBe("drafting")
    })

    it("takes Antigravity's turn after the person's Enter as theirs once its transcript shows the input", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "", "tui", "agy")
      await agyStarted(tui)
      // Its hooks name no prompt: the transcript's new typed entry tells it was theirs.
      await tui.first()
      await tui.send("Review a.ts")
      await vi.waitFor(() => expect(tui.received()).toHaveLength(3), { timeout: 10_000 })
      expect(tui.received()[2]!.prompt).toMatch(/^\[Novadeck: automatic notice/)
      expect(tui.received()[2]!.printed).toContain(">Review a.ts</message>")
    })

    it("keeps Antigravity Drafting when a turn after the Enter brought no typed input", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "", "tui", "agy")
      await agyStarted(tui)
      await tui.first()
      tui.type("draft")
      await shell.until(tui.manager, tui.idle.id, "> draft")
      await expect.poll(tui.delivery).toBe("drafting")
      // Cleared, then Enter on the empty box submits nothing; a subagent wakes it at once.
      tui.type("\x15")
      tui.type("\r")
      tui.kick()
      await vi.waitFor(() => expect(tui.received()).toHaveLength(3), { timeout: 10_000 })
      await tui.back(3)
      await expect.poll(tui.delivery).toBe("drafting")
      await tui.send("Review a.ts")
      await quiet()
      expect(pastes(tui.raw())).toEqual([])
    })

    it("keeps Antigravity Drafting when the person typed after their Enter", async ({ shell }) => {
      const tui = await ringing(shell, "", "tui", "agy")
      await agyStarted(tui)
      await tui.first()
      tui.type("next")
      await shell.until(tui.manager, tui.idle.id, "> next")
      tui.type("\r")
      tui.type("and more")
      await vi.waitFor(() => expect(tui.received()).toHaveLength(3), { timeout: 10_000 })
      await tui.back(3)
      await expect.poll(tui.delivery).toBe("drafting")
      await tui.send("Review a.ts")
      await quiet()
      expect(pastes(tui.raw())).toEqual([])
    })

    it.skipIf(process.platform !== "linux")(
      "never rings an agent whose process group doesn't hold the terminal's foreground",
      async ({ shell }) => {
        // In a session of its own: the terminal's foreground is setsid's, waiting for it.
        const tui = await ringing(shell, "", "setsid -w named")
        await tui.first()
        await tui.send("Review a.ts")
        await quiet()
        expect(pastes(tui.raw())).toEqual([])
        expect(tui.delivery()).toBe("settled")
      },
    )
  },
)
