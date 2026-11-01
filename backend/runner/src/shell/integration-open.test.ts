import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentName, TerminalRequest } from "@novadeck/protocol"
import { vi } from "vitest"

import { Terminals } from "../terminals/index.js"
import { sessionCommandRefusal } from "../terminals/opens.js"
import { describe, expect } from "../test.js"
import {
  bash,
  type Fixture,
  it,
  create,
  showStandIn,
  fakeAgent,
  show,
  open,
} from "./integration.test-support.js"
import { unansweredCalls } from "./reports.js"
import { quoted, standIn, driver } from "./stand-ins.test-support.js"

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "what agents open from a bash terminal",
  () => {
    it("asks the client for a new terminal, which starts the command where the agent said", async ({
      shell,
    }) => {
      const bin = showStandIn(shell.home)
      fakeAgent(shell.home, "claude")
      const manager = shell.manager({
        env: {
          HOME: shell.home,
          PS1: "$ ",
          PATH: `${bin}:${join(shell.home, "bin")}:${process.env.PATH}`,
        },
      })
      const project = join(shell.home, "project")
      mkdirSync(project)
      const terminal = await create(manager, shell)
      // Without a client to lay it out, nothing opens.
      await expect(show(shell, manager, terminal.id, [open({})])).resolves.toEqual([
        { ok: false, reason: "Novadeck isn't open to show a new terminal." },
      ])
      // A client opens what it is asked to, as its "+" would, or says why not.
      const controller = new AbortController()
      const requests: TerminalRequest[] = []
      const created: string[] = []
      // The person approves every command an agent asks to run, and sees what was asked.
      const approved: object[] = []
      const person = (async () => {
        for await (const item of manager.approvals("client", controller.signal))
          if (item.type === "request") {
            approved.push(item.action)
            manager.answerApproval({ requestId: item.requestId, approved: true }, "client")
          }
      })().catch(() => undefined)
      const client = (async () => {
        for await (const request of manager.requests("client", controller.signal)) {
          requests.push(request)
          const { requestId, sessionId, cwd, command } = request
          // This client opens only what runs a command.
          if (command === undefined) {
            manager.answerRequest({ requestId, reason: "Not now." }, "client")
            continue
          }
          const id = randomUUID()
          created.push(id)
          // eslint-disable-next-line no-await-in-loop -- Requests are opened in turn.
          await manager.create(
            {
              id,
              sessionId,
              cwd,
              cols: 100,
              rows: 20,
              ...(command && { command }),
              // For the request, so the runner names it as the agent asked.
              requestId,
            },
            "client",
          )
          manager.answerRequest({ requestId, terminalId: id }, "client")
        }
      })()
      try {
        const answers = await show(shell, manager, terminal.id, [
          open({ command: "claude --version", cwd: "project", title: "Agent", focus: true }),
          open({ title: "Refused" }),
          open({ cwd: "nowhere" }),
          open({ command: "claude\nrm -rf ~" }),
          // An interactive agent session is open_agent's, however the command spells it.
          open({ command: "claude --resume s-1" }),
          open({ command: "/usr/bin/codex 'fix it'" }),
          open({}, "0".repeat(48)),
        ])
        expect(answers).toEqual([
          // Its handle, which agents message it by.
          {
            ok: true,
            text: expect.stringContaining(
              `Asked the user to approve running claude --version in a new terminal in ${project}.`,
            ),
          },
          { ok: false, reason: "Not now." },
          { ok: false, reason: "nowhere isn't a folder a terminal can open in." },
          { ok: false, reason: "The command must be one line, without control characters." },
          { ok: false, reason: sessionCommandRefusal("claude") },
          { ok: false, reason: sessionCommandRefusal("codex") },
          unansweredCalls.open,
        ])
        // The terminal for a command opens only once the person approved it.
        await vi.waitFor(() => expect(created).toHaveLength(1))
        expect(approved).toEqual([{ type: "run", command: "claude --version", cwd: project }])
        const asked = {
          requestId: expect.any(String),
          from: terminal.id,
          sessionId: shell.sessionId,
        }
        expect(requests).toEqual([
          // The title it asked for never goes to the client, which could give it as the person's.
          { ...asked, cwd: project, command: "claude --version", focus: true },
          { ...asked, cwd: shell.home, focus: false },
        ])
        const [opened] = created
        // The agent chose that title, and the terminal says which terminal's did.
        expect(manager.get(opened!)).toMatchObject({
          cwd: project,
          title: "Agent",
          titleSource: { kind: "agent", by: "moth" },
        })
        expect(shell.store.terminalIdentity(opened!)).toEqual({
          handle: "fox",
          naming: {
            person: null,
            opener: { title: "Agent" },
            murmur: null,
            summary: null,
          },
          openedBy: "moth",
          ledBy: null,
        })
        // Opened for a command, even one that starts an agent, it has no lead.
        expect(manager.get(opened!).ledBy).toBeNull()
        // It is still known as the opener's.
        expect(manager.get(opened!).openedBy).toBe("moth")
        expect(shell.store.terminalIdentity(opened!)).toMatchObject({ ledBy: null })
        await shell.until(manager, opened!, "claude args: --version")
        // Five a minute, counting each request that was asked, opened or not: two more,
        // and the next waits.
        const more = await show(
          shell,
          manager,
          terminal.id,
          Array.from({ length: 3 }, () => open({ title: "Refused" })),
        )
        const spent = {
          ok: false,
          reason:
            "Agents opened as many terminals as they may in the last minute; try again shortly.",
        }
        expect(more).toEqual([
          ...Array.from({ length: 2 }, () => ({ ok: false, reason: "Not now." })),
          spent,
        ])
        // The terminal it opened shares its budget, so a chain can't open more.
        // Enter ends the stand-in agent; what's typed next goes to the shell.
        manager.write({ terminalId: opened!, data: "\r" }, "client")
        await expect(
          show(shell, manager, opened!, [open({ title: "Refused" })], "client"),
        ).resolves.toEqual([spent])
      } finally {
        controller.abort()
        await client
        await person
      }
    })
  },
)

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "agents opening an agent with a task from a bash terminal",
  () => {
    it("starts each agent with the doorbell as its prompt, Antigravity only where trusted", async ({
      shell,
    }) => {
      const bin = showStandIn(shell.home)
      for (const agent of ["claude", "codex", "agy"] as const) fakeAgent(shell.home, agent)
      const trusted = join(shell.home, "trusted")
      mkdirSync(trusted)
      mkdirSync(join(shell.home, ".gemini", "antigravity-cli"), { recursive: true })
      writeFileSync(
        join(shell.home, ".gemini", "antigravity-cli", "settings.json"),
        JSON.stringify({ trustedWorkspaces: [trusted] }),
      )
      const manager = shell.manager({
        env: {
          HOME: shell.home,
          PS1: "$ ",
          PATH: `${bin}:${join(shell.home, "bin")}:${process.env.PATH}`,
        },
        install: (agent) =>
          Promise.resolve({
            env: {},
            home: shell.home,
            platform: process.platform,
            plugin: join(shell.plugins, agent),
          }),
      })
      const openAgent = (request: object) => ({ ...open(request), type: "open_agent" as "open" })
      const terminal = await create(manager, shell)
      const controller = new AbortController()
      const requests: TerminalRequest[] = []
      const created: string[] = []
      const client = (async () => {
        for await (const request of manager.requests("client", controller.signal)) {
          requests.push(request)
          const id = randomUUID()
          created.push(id)
          // eslint-disable-next-line no-await-in-loop -- Requests are opened in turn.
          await manager.create(
            {
              id,
              sessionId: request.sessionId,
              cwd: request.cwd,
              cols: 100,
              rows: 20,
              ...(request.command && { command: request.command }),
              // For the request, as the UI creates it, so the runner knows who opened it.
              requestId: request.requestId,
            },
            "client",
          )
          manager.answerRequest({ requestId: request.requestId, terminalId: id }, "client")
        }
      })()
      try {
        const task = { message: "Review a.ts, please." }
        const answers = (await show(shell, manager, terminal.id, [
          openAgent({ agent: "claude", ...task }),
          openAgent({ agent: "codex", ...task }),
          openAgent({ agent: "agy", cwd: "trusted", ...task }),
          openAgent({ agent: "agy", ...task }),
          // Too large once escaped where delivered: refused before anything starts.
          openAgent({ agent: "codex", message: "&".repeat(4_000) }),
        ])) as { ok: boolean; text?: string }[]
        const line = /^\[Novadeck: automatic notice, agent messages waiting, [A-Za-z0-9]{6}\]$/
        expect(requests.map(({ command }) => command)).toEqual([
          expect.stringMatching(quoted("claude")),
          expect.stringMatching(quoted("codex")),
          expect.stringMatching(quoted("agy -i")),
          // Antigravity would submit its prompt behind its trust dialog: started plain.
          "agy",
        ])
        // Each was told its task's message, which waits for the agent there.
        expect(answers.slice(0, 4)).toEqual(
          Array.from({ length: 4 }, () => ({
            ok: true,
            text: expect.stringMatching(/ message m-\S+,? (waits|reaches it once)/),
          })),
        )
        // Only Antigravity in a folder it doesn't trust started without its task.
        const trustless = "doesn't trust this folder yet, so it started without its task"
        expect(answers.slice(0, 4).map(({ text }) => text?.includes(trustless))).toEqual([
          false,
          false,
          false,
          true,
        ])
        expect(answers.slice(4)).toEqual([
          {
            ok: false,
            reason: expect.stringMatching(/^Delivered, this message would take \d+ bytes/),
          },
        ])
        // Each started with the line as one argument, which its harness submits.
        await shell.until(manager, created[0]!, /claude args: \[Novadeck: [^\n]*\]/)
        const shown = await shell.until(manager, created[2]!, "agy args: -i [Novadeck")
        expect(shown.split("agy args: -i ")[1]?.split(" prompt=")[0]).toMatch(line)
        // The opener's peers say who opened it, with a task, before its agent starts.
        const [listed] = (await show(shell, manager, terminal.id, [
          { type: "agents" as "open", request: {} },
        ])) as { ok: true; text: string }[]
        expect(listed!.text).toContain(
          "- @fox: expecting Claude Code, not started yet\n  title: claude\n  folder: .\n  led by you",
        )
        expect(manager.get(created[0]!).ledBy).toBe("moth")
        // Who opened it is kept with the terminal, for a runner that restores it.
        expect(shell.store.terminalIdentity(created[0]!)).toMatchObject({
          openedBy: "moth",
          ledBy: "moth",
        })
        // The task waits for the first session of that agent there.
        expect(manager.messages(created[0]!).threads[0]?.messages[0]).toMatchObject({
          from: { kind: "agent", handle: "moth" },
          to: { kind: "agent", handle: "fox", agent: "claude" },
          text: "Review a.ts, please.",
          state: "queued",
        })
      } finally {
        controller.abort()
        await client
      }
    })
  },
)

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "agents opening an agent with a model and effort from a bash terminal",
  () => {
    it("starts each harness with them right after its program, and refuses what it doesn't list", async ({
      shell,
    }) => {
      const bin = showStandIn(shell.home)
      for (const agent of ["claude", "codex", "agy"] as const) fakeAgent(shell.home, agent)
      const trusted = join(shell.home, "trusted")
      mkdirSync(trusted)
      mkdirSync(join(shell.home, ".gemini", "antigravity-cli"), { recursive: true })
      writeFileSync(
        join(shell.home, ".gemini", "antigravity-cli", "settings.json"),
        JSON.stringify({ trustedWorkspaces: [trusted] }),
      )
      const all = ["low", "medium", "high", "xhigh", "max"] as const
      const lists = {
        claude: [{ id: "opus", efforts: all }],
        codex: [
          { id: "gpt-a", efforts: ["low", "high"] },
          { id: "gpt-b", efforts: ["low"] },
          { id: "gpt-c", efforts: ["low"] },
        ],
        agy: [
          { id: "flash-high", efforts: ["high"] },
          { id: "sonnet", efforts: [] },
        ],
      } as const
      const manager = shell.manager({
        env: {
          HOME: shell.home,
          PS1: "$ ",
          PATH: `${bin}:${join(shell.home, "bin")}:${process.env.PATH}`,
        },
        install: (agent) =>
          Promise.resolve({
            env: {},
            home: shell.home,
            platform: process.platform,
            plugin: join(shell.plugins, agent),
          }),
        models: (agent) => Promise.resolve(lists[agent]),
      })
      const openAgent = (request: object) => ({ ...open(request), type: "open_agent" as "open" })
      const terminal = await create(manager, shell)
      const controller = new AbortController()
      const requests: TerminalRequest[] = []
      const client = (async () => {
        for await (const request of manager.requests("client", controller.signal)) {
          requests.push(request)
          const id = randomUUID()
          // eslint-disable-next-line no-await-in-loop -- Requests are opened in turn.
          await manager.create(
            {
              id,
              sessionId: request.sessionId,
              cwd: request.cwd,
              cols: 100,
              rows: 20,
              ...(request.command && { command: request.command }),
              requestId: request.requestId,
            },
            "client",
          )
          manager.answerRequest({ requestId: request.requestId, terminalId: id }, "client")
        }
      })()
      try {
        const task = { message: "Review a.ts, please." }
        const answers = (await show(shell, manager, terminal.id, [
          openAgent({ agent: "claude", model: "opus", effort: "max", ...task }),
          openAgent({ agent: "codex", model: "gpt-a", effort: "high", ...task }),
          openAgent({ agent: "agy", cwd: "trusted", model: "flash-high", effort: "high", ...task }),
          openAgent({ agent: "agy", model: "sonnet", ...task }),
          openAgent({ agent: "codex", model: "nope", ...task }),
          openAgent({ agent: "codex", model: "gpt-a", effort: "max", ...task }),
          openAgent({ agent: "claude", effort: "low", ...task }),
          openAgent({ agent: "agy", model: "sonnet", effort: "low", ...task }),
        ])) as { ok: boolean; reason?: string }[]
        const line = '"\\[Novadeck: automatic notice, agent messages waiting, [A-Za-z0-9]{6}\\]"'
        expect(requests.map(({ command }) => command)).toEqual([
          expect.stringMatching(new RegExp(`^claude --model opus --effort max ${line}$`)),
          expect.stringMatching(
            new RegExp(`^codex --model gpt-a -c "model_reasoning_effort=high" ${line}$`),
          ),
          expect.stringMatching(new RegExp(`^agy --model flash-high --effort high -i ${line}$`)),
          "agy --model sonnet",
        ])
        expect(answers.slice(0, 4).map(({ ok }) => ok)).toEqual([true, true, true, true])
        expect(answers.slice(4)).toEqual([
          {
            ok: false,
            reason:
              'Codex has no model "nope" here: give one of gpt-a, gpt-b or gpt-c, or leave model out to start on its default.',
          },
          {
            ok: false,
            reason: 'Codex\'s model "gpt-a" has no effort "max"; its efforts are low and high.',
          },
          {
            ok: false,
            reason: "Give a model with effort: Claude Code's efforts depend on the model.",
          },
          { ok: false, reason: 'Antigravity\'s model "sonnet" takes no effort; leave it out.' },
        ])
      } finally {
        controller.abort()
        await client
      }
    })
  },
)

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "agents opening an agent with no task, a lead or a past session from a bash terminal",
  () => {
    it("starts each harness at its prompt, led or not, and resumes a session in one terminal only", async ({
      shell,
    }) => {
      const bin = showStandIn(shell.home)
      for (const agent of ["claude", "codex", "agy"] as const) fakeAgent(shell.home, agent)
      const lists = {
        claude: [{ id: "opus", efforts: ["low", "max"] }],
        codex: [{ id: "gpt-a", efforts: ["low", "high"] }],
        agy: [{ id: "flash-high", efforts: ["high"] }],
      } as const
      const manager = shell.manager({
        env: {
          HOME: shell.home,
          PS1: "$ ",
          PATH: `${bin}:${join(shell.home, "bin")}:${process.env.PATH}`,
        },
        install: (agent) =>
          Promise.resolve({
            env: {},
            home: shell.home,
            platform: process.platform,
            plugin: join(shell.plugins, agent),
          }),
        models: (agent) => Promise.resolve(lists[agent]),
      })
      const openAgent = (request: object) => ({ ...open(request), type: "open_agent" as "open" })
      const terminal = await create(manager, shell)
      const controller = new AbortController()
      const requests: TerminalRequest[] = []
      const created: string[] = []
      const client = (async () => {
        for await (const request of manager.requests("client", controller.signal)) {
          requests.push(request)
          const id = randomUUID()
          created.push(id)
          // eslint-disable-next-line no-await-in-loop -- Requests are opened in turn.
          await manager.create(
            {
              id,
              sessionId: request.sessionId,
              cwd: request.cwd,
              cols: 100,
              rows: 20,
              ...(request.command && { command: request.command }),
              requestId: request.requestId,
            },
            "client",
          )
          manager.answerRequest({ requestId: request.requestId, terminalId: id }, "client")
        }
      })()
      try {
        const answers = (await show(shell, manager, terminal.id, [
          openAgent({ agent: "claude" }),
          openAgent({ agent: "codex", model: "gpt-a", lead: true }),
          openAgent({ agent: "agy", model: "flash-high", effort: "high", lead: true }),
          openAgent({ agent: "claude", resume: "sess-1", model: "opus", lead: true }),
          openAgent({ agent: "agy", resume: "sess-3" }),
          openAgent({ agent: "claude", resume: "sess-1" }),
          openAgent({ agent: "claude", resume: "no way" }),
        ])) as { ok: boolean; reason?: string }[]
        expect(requests.map(({ command }) => command)).toEqual([
          "claude",
          "codex --model gpt-a",
          "agy --model flash-high --effort high",
          "claude --model opus --resume sess-1",
          "agy --conversation sess-3",
        ])
        expect(answers.slice(0, 5).map(({ ok }) => ok)).toEqual(Array(5).fill(true))
        // One session runs in one terminal: refused while the first has it.
        expect(answers[5]).toMatchObject({
          ok: false,
          reason: expect.stringContaining("already open in a terminal"),
        })
        expect(answers[6]).toMatchObject({ ok: false, reason: expect.stringContaining("session") })
        // Led only where asked to; a plain agent has none, but is still known as the opener's.
        expect(created.map((id) => manager.get(id).ledBy)).toEqual([
          null,
          "moth",
          "moth",
          "moth",
          null,
        ])
        expect(created.map((id) => manager.get(id).openedBy)).toEqual(Array(5).fill("moth"))
        await shell.until(manager, created[3]!, "claude args: --model opus --resume sess-1")
      } finally {
        controller.abort()
        await client
      }
    })
  },
)

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "an agent opened to be led, with a brief or without",
  () => {
    // Opens `agent` as `moth` asks, in a terminal where its program is a stand-in that
    // reports its session and takes hooks; `prompt` is the hook of its prompt, read as the
    // text it carries into the agent (Antigravity's ephemeral message, the others' context).
    const opened = async (
      shell: Fixture,
      agent: AgentName,
      request: object,
      run: (opened: Opened) => Promise<void>,
    ) => {
      const bin = showStandIn(shell.home)
      const stand = standIn(shell.home)
      writeFileSync(
        join(stand, agent),
        '#!/bin/sh\nmkdir -p "$HOME/steps-$NOVADECK_TERMINAL_ID"\n' +
          `exec agent ${agent} s-worker "$HOME/steps-$NOVADECK_TERMINAL_ID"\n`,
        { mode: 0o755 },
      )
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${stand}:${process.env.PATH}` },
        install: (name) =>
          Promise.resolve({
            env: {},
            home: shell.home,
            platform: process.platform,
            plugin: join(shell.plugins, name),
          }),
        models: (name) =>
          Promise.resolve(
            {
              claude: [{ id: "opus", efforts: [] }],
              codex: [{ id: "gpt-a", efforts: [] }],
              agy: [],
            }[name],
          ),
      })
      const terminal = await create(manager, shell)
      const controller = new AbortController()
      const created: string[] = []
      const commands: (string | undefined)[] = []
      const client = (async () => {
        for await (const asked of manager.requests("client", controller.signal)) {
          commands.push(asked.command)
          const id = randomUUID()
          created.push(id)
          // eslint-disable-next-line no-await-in-loop -- Requests are opened in turn.
          await manager.create(
            {
              id,
              sessionId: asked.sessionId,
              cwd: asked.cwd,
              cols: 100,
              rows: 20,
              ...(asked.command && { command: asked.command }),
              requestId: asked.requestId,
            },
            "client",
          )
          manager.answerRequest({ requestId: asked.requestId, terminalId: id }, "client")
        }
      })()
      try {
        const [answer] = (await show(shell, manager, terminal.id, [
          { ...open({ agent, ...request }), type: "open_agent" as "open" },
        ])) as { ok: boolean; text: string }[]
        expect(answer!.ok).toBe(true)
        const [worker] = created
        await shell.until(manager, worker!, `${agent} ready`)
        const { step } = driver(shell, manager)
        await run({
          manager,
          worker: worker!,
          said: answer!.text,
          command: commands[0],
          // What the agent's start hook printed: Antigravity's invocation takes its messages.
          started: () => readFileSync(join(shell.home, `steps-${worker}.start`), "utf8"),
          // The opener sends the agent a message of its own.
          sends: async (text) =>
            show(shell, manager, terminal.id, [
              { type: "send" as "open", request: { to: "fox", text } },
            ]),
          prompt: async (text, ends = false) => {
            // Antigravity's turn ends with its Stop, which takes what waits for a turn's end.
            const out = await step(worker!, {
              hook: agent === "agy" ? (ends ? "Stop" : "PreInvocation") : "UserPromptSubmit",
              payload:
                agent === "agy"
                  ? ends
                    ? { fullyIdle: true }
                    : { invocationNum: 1 }
                  : { prompt: text },
            })
            const parsed = JSON.parse(out) as {
              hookSpecificOutput?: { additionalContext: string }
              injectSteps?: { ephemeralMessage: string }[]
              reason?: string
            }
            return (
              parsed.hookSpecificOutput?.additionalContext ??
              parsed.injectSteps?.map(({ ephemeralMessage }) => ephemeralMessage).join("\n") ??
              parsed.reason ??
              ""
            )
          },
        })
      } finally {
        controller.abort()
        await client
      }
    }
    type Opened = {
      manager: Terminals
      worker: string
      said: string
      started: () => string
      sends: (text: string) => Promise<unknown[]>
      command: string | undefined
      prompt: (text: string, ends?: boolean) => Promise<string>
    }

    // Antigravity's folder here is not one it trusts: it starts without its prompt.
    for (const agent of ["claude", "codex", "agy"] as const) {
      it(`marks ${agent}'s brief as its lead's, then releases the lead once it is delivered, and tells it`, async ({
        shell,
      }) => {
        await opened(
          shell,
          agent,
          { message: "Review a.ts, please.", lead: false },
          async ({ manager, worker, said, command, prompt, started, sends }) => {
            // Antigravity here started plain, its task waiting for the first session.
            expect(said.includes("doesn't trust this folder yet")).toBe(agent === "agy")
            expect(command === agent).toBe(agent === "agy")
            const marked = /lead="[^"]+"[^>]*>Review a.ts, please.<\/message>/
            if (agent === "agy") {
              // Its first invocation binds and takes the brief at once: the mark is there.
              const printed = JSON.parse(started()) as {
                injectSteps: { ephemeralMessage: string }[]
              }
              expect(printed.injectSteps[0]!.ephemeralMessage).toMatch(marked)
            } else {
              // Led until the brief lands. While it waits, the opener's other messages go as a
              // peer's: unmarked, and not the brief's end.
              expect(manager.get(worker).ledBy).toBe("moth")
              expect(await sends("Also this.")).toEqual([
                { ok: true, text: expect.stringContaining("Message m-") },
              ])
              const first = await prompt("go")
              expect(first).toMatch(marked)
              expect(first).toMatch(
                /<message [^>]*from="moth"(?![^>]*lead=)[^>]*>Also this.<\/message>/,
              )
            }
            await expect
              .poll(() => manager.messages(worker).threads[0]?.messages[0]?.state)
              .toBe("delivered")
            await expect.poll(() => manager.get(worker).ledBy).toBeNull()
            expect(shell.store.terminalIdentity(worker)).toMatchObject({ ledBy: null })
            // Its next prompt tells it so: the brief stays its task, the lead's messages are a peer's.
            // (Antigravity's first invocation took the brief, so its notice may come a prompt later.)
            await expect
              .poll(() => prompt("more", true), { interval: 20 })
              .toContain("@moth no longer leads you. Its brief stays")
          },
        )
      })

      it(`keeps leading ${agent} opened with a brief by default: its later messages are marked`, async ({
        shell,
      }) => {
        await opened(
          shell,
          agent,
          { message: "Review a.ts, please." },
          async ({ manager, worker, prompt, sends }) => {
            // The brief and what follows are the lead's: Antigravity's start took the brief,
            // the others take it with their first prompt.
            if (agent !== "agy") await prompt("go")
            await expect
              .poll(() => manager.messages(worker).threads[0]?.messages[0]?.state)
              .toBe("delivered")
            expect(await sends("Next, the tests.")).toEqual([
              { ok: true, text: expect.stringContaining("Message m-") },
            ])
            expect(await prompt("more")).toMatch(
              /<message [^>]*from="moth"[^>]*lead="[^"]+"[^>]*>Next, the tests.<\/message>/,
            )
            expect(manager.get(worker).ledBy).toBe("moth")
          },
        )
      })

      it(`resumes a past ${agent} session with a brief, which reaches the resumed session`, async ({
        shell,
      }) => {
        const form = {
          claude: "claude --model opus --resume sess-r",
          codex: "codex resume --model gpt-a sess-r",
          agy: "agy --conversation sess-r",
        }
        await opened(
          shell,
          agent,
          {
            resume: "sess-r",
            message: "Carry on with a.ts.",
            lead: true,
            ...(agent !== "agy" && { model: agent === "claude" ? "opus" : "gpt-a" }),
          },
          async ({ manager, worker, said, command, prompt, started }) => {
            expect(command).toBe(form[agent])
            expect(said).toContain("resuming session sess-r")
            // The resumed session takes the brief as any message, marked as its lead's.
            const marked = /lead="[^"]+"[^>]*>Carry on with a.ts.<\/message>/
            if (agent === "agy") {
              const printed = JSON.parse(started()) as {
                injectSteps: { ephemeralMessage: string }[]
              }
              expect(printed.injectSteps[0]!.ephemeralMessage).toMatch(marked)
            } else expect(await prompt("go")).toMatch(marked)
            await expect
              .poll(() => manager.messages(worker).threads[0]?.messages[0]?.state)
              .toBe("delivered")
            expect(manager.get(worker).ledBy).toBe("moth")
          },
        )
      })

      it(`tells ${agent} opened without a brief that its opener leads it, and keeps the lead`, async ({
        shell,
      }) => {
        await opened(shell, agent, { lead: true }, async ({ manager, worker, prompt }) => {
          expect(manager.get(worker).ledBy).toBe("moth")
          expect(manager.messages(worker).threads).toEqual([])
          expect(await prompt("go")).toContain("@moth started you and leads you")
          expect(manager.get(worker).ledBy).toBe("moth")
        })
      })
    }
  },
)
