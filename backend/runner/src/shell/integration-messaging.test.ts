import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { Latest } from "@novadeck/wire/server"
import { vi } from "vitest"

import { describe, expect } from "../test.js"
import { bash, it, create } from "./integration.test-support.js"
import { unansweredCalls } from "./reports.js"
import {
  standIn,
  driver,
  type Told,
  messageId,
  reaches,
  context,
} from "./stand-ins.test-support.js"

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "agents messaging each other between bash terminals",
  () => {
    it("delivers a message through the recipient's hooks, and its reply through the sender's", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      // The project is a git checkout, on main.
      mkdirSync(join(shell.home, ".git"))
      writeFileSync(join(shell.home, ".git", "HEAD"), "ref: refs/heads/main\n")
      const claude = await create(manager, shell)
      const codex = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(claude.id, "claude", "s-claude")
      await start(codex.id, "codex", "s-codex")
      await expect.poll(() => manager.messages(codex.id).delivery).toBe("fresh")
      const send = async (from: string, to: string, text: string) =>
        JSON.parse(await step(from, { call: "send", request: { to, text } })) as Told

      // Claude sends Codex a message while Codex has had no prompt yet.
      const sent = await send(claude.id, "fox", "Review a.ts, please.")
      expect(sent).toEqual({
        ok: true,
        text: expect.stringMatching(
          /^Message m-\S+ to @fox is queued: it reaches them ringing it once its box reads empty\.\n/,
        ),
      })
      // Codex's next prompt carries it, wrapped and attributed, never as the person.
      const prompted = JSON.parse(
        await step(codex.id, { hook: "UserPromptSubmit", payload: { prompt: "go on" } }),
      ) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
      expect(prompted.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
      expect(prompted.hookSpecificOutput.additionalContext).toMatch(
        new RegExp(
          `<message id="${messageId(sent)}" from="moth" agent="Claude Code" thread="t-[a-z0-9]+" ` +
            `sent="\\d\\d:\\d\\d">Review a.ts, please.</message>`,
        ),
      )
      // Its hook acknowledged what it printed.
      await expect
        .poll(() => manager.messages(codex.id).threads[0]?.messages[0]?.state)
        .toBe("delivered")

      // Claude is working when Codex answers: its Stop continues the turn with the reply.
      // Its first prompt of a new session, carrying no messages, carries the nudge to
      // summarize the terminal.
      const firstPrompt = await step(claude.id, {
        hook: "UserPromptSubmit",
        payload: { prompt: "ask codex" },
      })
      expect(firstPrompt).toContain("this terminal has no summary yet")
      // Claude Code's additionalContext carries each paragraph: the bar's, the Inbox's, then
      // the summary's.
      const carried = (
        JSON.parse(firstPrompt) as { hookSpecificOutput: { additionalContext: string } }
      ).hookSpecificOutput.additionalContext
      const paragraphs = carried.split("\n\n")
      expect(paragraphs).toHaveLength(3)
      expect(paragraphs[0]).toMatch(
        /^Novadeck: automatic notice, not from the user: beside this terminal/,
      )
      expect(paragraphs[1]).toMatch(
        /^Novadeck: automatic notice, not from the user: the user rarely watches/,
      )
      expect(paragraphs[2]).toMatch(
        /^Novadeck: automatic notice, not from the user: this terminal has no/,
      )
      const reply = await send(codex.id, "moth", "Looks good & ships.")
      expect(reply).toMatchObject({
        ok: true,
        text: reaches("when its current turn ends"),
      })
      // Its Stop goes on with the reply as context, which Claude Code reads once.
      const stopped = context(await step(claude.id, { hook: "Stop", payload: {} }))
      expect(stopped).toContain('from="fox" agent="Codex"')
      expect(stopped).toContain(">Looks good &amp; ships.</message>")
      await expect
        .poll(() => manager.messages(claude.id).threads[0]?.messages.map(({ state }) => state))
        .toEqual(["delivered", "delivered"])
      // The agent asked to list sees its peer as Novadeck knows it: busy, the title the
      // person gave it, where it works, what it was asked and what it wrote; and nothing of
      // its own still waiting.
      manager.rename({ terminalId: claude.id, title: "API author" })
      await step(claude.id, {
        hook: "PostToolUse",
        payload: { tool_name: "Write", tool_input: { file_path: join(shell.home, "src", "a.ts") } },
      })
      await expect
        .poll(async () => JSON.parse(await step(codex.id, { call: "agents", request: {} })))
        .toEqual({
          ok: true,
          text: [
            "You are @fox in Novadeck.",
            "Other terminals in this project and session:",
            "- @moth: Claude Code, busy, last active just now",
            "  title: API author",
            "  folder: ., branch main",
            "  started with: ask codex",
            "  works in: src/ (1)",
            "  with you: you, just now: Looks good & ships.",
          ].join("\n"),
        })
      // Nothing more waits: the next Stop ends Claude's turn.
      await expect(step(claude.id, { hook: "Stop", payload: {} })).resolves.toBe("")
      expect(manager.messages(claude.id).delivery).toBe("settled")
      // The person submits a prompt of their own during Claude's next turn: its Stop
      // leaves the message to that prompt's hook.
      await step(claude.id, { hook: "UserPromptSubmit", payload: { prompt: "next" } })
      manager.write({ terminalId: claude.id, data: "and then this\r" }, "owner")
      await send(codex.id, "moth", "One more thing.")
      await expect(step(claude.id, { hook: "Stop", payload: {} })).resolves.toBe("")
      expect(manager.messages(claude.id).delivery).toBe("drafting")
      const queued = JSON.parse(
        await step(claude.id, { hook: "UserPromptSubmit", payload: { prompt: "and then this" } }),
      ) as { hookSpecificOutput: { additionalContext: string } }
      expect(queued.hookSpecificOutput.additionalContext).toContain("One more thing.")
    })

    it("tells an agent no one types to Novadeck's notices with the messages its doorbell delivers", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const lead = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(lead.id, "claude", "s-lead")
      const ring = "[Novadeck: automatic notice, agent messages waiting, abc123]"
      const teammate = async (agent: "claude" | "codex") => {
        const worker = await create(manager, shell)
        await start(worker.id, agent, `s-${agent}`)
        await expect.poll(() => manager.messages(worker.id).delivery).toMatch(/^(?:fresh|ready)$/)
        const { handle } = manager.get(worker.id)
        await step(lead.id, { call: "send", request: { to: handle, text: "Build the page." } })
        // Its first turn is the doorbell's: the message, then the bar's, the Inbox's and the
        // summary's notices, a paragraph each.
        const rung = context(
          await step(worker.id, { hook: "UserPromptSubmit", payload: { prompt: ring } }),
        )
        expect(rung).toContain(">Build the page.</message>")
        const notices = rung.slice(rung.indexOf("</novadeck-messages>")).split("\n\n").slice(1)
        expect(notices).toHaveLength(3)
        expect(notices[0]).toMatch(/^Novadeck: automatic notice, not from the user: beside this/)
        expect(notices[1]).toMatch(/the user rarely watches this terminal/)
        expect(notices[2]).toMatch(/this terminal has no summary yet/)
        await expect
          .poll(() => manager.messages(worker.id).threads[0]?.messages[0]?.state)
          .toBe("delivered")
        await step(worker.id, { hook: "Stop", payload: {} })
        // The next message's turn asks for the summary again, and only that, until one comes.
        await step(lead.id, { call: "send", request: { to: handle, text: "And the footer." } })
        const again = context(
          await step(worker.id, { hook: "UserPromptSubmit", payload: { prompt: ring } }),
        )
        expect(again).toContain(">And the footer.</message>")
        expect(again).toContain("this terminal has no summary yet")
        expect(again).not.toContain("beside this terminal is a bar")
      }
      await teammate("claude")
      await teammate("codex")
    })

    it("tells a terminal's watchers nothing of messages between two others", async ({ shell }) => {
      const bin = standIn(shell.home)
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const claude = await create(manager, shell)
      const codex = await create(manager, shell)
      const third = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(claude.id, "claude", "s-claude")
      await start(codex.id, "codex", "s-codex")
      await expect.poll(() => manager.messages(codex.id).delivery).toBe("fresh")
      const watch = manager.watchMessages(third.id)
      await watch.next()
      const pushes = vi.spyOn(Latest.prototype, "push")
      await step(claude.id, {
        call: "send",
        request: { to: "fox", text: "Review a.ts." },
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(pushes).not.toHaveBeenCalled()
      pushes.mockRestore()
      // The pause is every terminal's news.
      manager.pauseMessages(true)
      await expect(watch.next()).resolves.toMatchObject({ value: { paused: true, threads: [] } })
      manager.pauseMessages(false)
      await watch.return(undefined)
    })

    it("follows a terminal's messages as they change, for each of its watchers", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const claude = await create(manager, shell)
      const codex = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(claude.id, "claude", "s-claude")
      await start(codex.id, "codex", "s-codex")
      await expect.poll(() => manager.messages(codex.id).delivery).toBe("fresh")
      const first = manager.watchMessages(codex.id)
      const second = manager.watchMessages(codex.id)
      await expect(first.next()).resolves.toMatchObject({
        value: { handle: "fox", delivery: "fresh", paused: false, threads: [] },
      })
      await expect(second.next()).resolves.toMatchObject({ value: { threads: [] } })

      // A message to it arrives, and both watchers hear; the doorbell still does its part.
      await step(claude.id, {
        call: "send",
        request: { to: "fox", text: "Review a.ts." },
      })
      const waiting = {
        value: {
          threads: [
            {
              peer: { kind: "agent", handle: "moth" },
              messages: [
                { from: { kind: "agent", handle: "moth" }, text: "Review a.ts.", state: "queued" },
              ],
            },
          ],
        },
      }
      await expect(first.next()).resolves.toMatchObject(waiting)
      await expect(second.next()).resolves.toMatchObject(waiting)

      // Pausing holds it, and every listing says so.
      manager.pauseMessages(true)
      await expect(first.next()).resolves.toMatchObject({
        value: { paused: true, threads: [{ messages: [{ state: "held", held: "paused" }] }] },
      })
      manager.pauseMessages(false)
      await expect(first.next()).resolves.toMatchObject({
        value: { paused: false, threads: [{ messages: [{ state: "queued", held: null }] }] },
      })

      // One watcher stops; the other follows on until the terminal closes.
      await second.return(undefined)
      await manager.close({ terminalId: codex.id })
      // It may tell first that its agent went, and the message with it; then it ends.
      for await (const listing of first) expect(listing.threads[0]?.messages[0]?.state).toBe("gone")
      await expect(manager.watchMessages(codex.id).next()).rejects.toMatchObject({
        code: "TERMINAL_NOT_FOUND",
      })
    })

    it("takes each terminal's reports and asks in order, never waiting on another terminal's", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      // Telling whether Codex is connected takes until the test says.
      const waiting: (() => void)[] = []
      let connecting = new Promise<void>((resolve) => waiting.push(resolve))
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
        connected: async (agent) => {
          if (agent === "codex") await connecting
          return true
        },
      })
      const codex = await create(manager, shell)
      const claude = await create(manager, shell)
      const { start, prepare, queue, step } = driver(shell, manager)
      // Codex's first prompt asks as soon as its SessionStart has reported.
      prepare(codex.id)
      const { name } = queue(codex.id, { hook: "UserPromptSubmit", payload: { prompt: "go" } })
      await start(codex.id, "codex", "s-codex")
      // Meanwhile Claude's terminal binds, at its prompt, though Codex's report still waits.
      await start(claude.id, "claude", "s-claude")
      await expect.poll(() => manager.messages(claude.id).delivery).toBe("ready")
      expect(manager.messages(codex.id).delivery).toBe("unbound")
      for (const connect of waiting) connect()
      await shell.until(manager, codex.id, `done ${name}`)
      // The ask waited for its own terminal's SessionStart, so its prompt found it bound.
      expect(manager.messages(codex.id).delivery).toBe("working")
      // A report naming no session needs no such lookup: its Stop is answered at once.
      connecting = new Promise(() => {})
      await expect(step(codex.id, { hook: "Stop", payload: {} })).resolves.toBe("")
      expect(manager.messages(codex.id).delivery).toBe("settled")
      // A call without the terminal's own token learns nothing.
      await expect(
        manager.send({
          type: "send",
          terminalId: claude.id,
          token: "0".repeat(48),
          request: { to: "codex", text: "x" },
        }),
      ).resolves.toEqual(unansweredCalls.send)
    })
  },
)
