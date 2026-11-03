import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Approval, TerminalChange, TerminalSummary } from "@novadeck/protocol"

import { handleWords } from "../terminals/handles.js"
import { describe, expect } from "../test.js"
import { bash, it, create, showStandIn, show, open } from "./integration.test-support.js"
import { unansweredCalls } from "./reports.js"
import { standIn, driver, type Told, messageId, close, closed } from "./stand-ins.test-support.js"

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "agents closing other bash terminals",
  () => {
    it("closes another terminal of its project and session as the person would, whatever window controls it", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const claude = await create(manager, shell)
      const codex = await create(manager, shell)
      const third = await create(manager, shell)
      // Another session of the project, whose terminals are no one's here.
      const elsewhere = shell.store.createSession({
        id: randomUUID(),
        projectId: shell.store.session(shell.sessionId).projectId,
        name: "S2",
      })
      const away = await Promise.all(
        [1, 2].map(() =>
          manager.create(
            { id: randomUUID(), sessionId: elsewhere.id, cwd: shell.home, cols: 100, rows: 20 },
            "owner",
          ),
        ),
      )
      const pidFile = join(shell.home, "codex.pid")
      manager.write({ terminalId: codex.id, data: `echo $$ > '${pidFile}'\r` }, "owner")
      await expect
        .poll(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim())
        .toBeTruthy()
      const shellPid = Number(readFileSync(pidFile, "utf8").trim())
      // Claude's own token, as its shell has it, for a call made as its tools never would.
      const tokenFile = join(shell.home, "claude.token")
      manager.write(
        { terminalId: claude.id, data: `echo "$NOVADECK_REPORT_TOKEN" > '${tokenFile}'\r` },
        "owner",
      )
      await expect
        .poll(() => existsSync(tokenFile) && readFileSync(tokenFile, "utf8").trim())
        .toBeTruthy()
      const claudeToken = readFileSync(tokenFile, "utf8").trim()
      const { start, step } = driver(shell, manager)
      await start(claude.id, "claude", "s-claude")
      await start(codex.id, "codex", "s-codex")
      await start(third.id, "claude", "s-third")
      await expect.poll(() => manager.messages(codex.id).delivery).toBe("fresh")
      const call = async (from: string, type: string, request: object) =>
        JSON.parse(await step(from, { call: type, request })) as Told
      const mine = await call(claude.id, "send", {
        to: "fox",
        text: "Review a.ts.",
      })
      const theirs = await call(third.id, "send", {
        to: "fox",
        text: "And b.ts.",
      })
      expect([mine.ok, theirs.ok]).toEqual([true, true])
      // Its agent shows a file beside it, on its bar.
      const notes = join(shell.home, "notes")
      mkdirSync(notes)
      writeFileSync(join(notes, "plan.txt"), "plan\n")
      await expect(
        call(codex.id, "show", { file: { path: join(notes, "plan.txt") } }),
      ).resolves.toMatchObject({ ok: true })
      const items = shell.items(manager)
      expect(items.bar(codex.id)).toHaveLength(1)

      // A window controls it, which a close goes past.
      const window = new AbortController()
      const events: string[] = []
      const viewing = (async () => {
        for await (const event of manager.attach(
          { terminalId: codex.id, mode: "control" },
          "owner",
          window.signal,
        ))
          events.push(event.type)
      })()
      await expect.poll(() => events).toContain("snapshot")
      const changes: TerminalChange[] = []
      const watching = new AbortController()
      const watched = (async () => {
        for await (const change of manager.watch("watcher", watching.signal)) changes.push(change)
      })()

      // A handle not there.
      const unknown = await call(claude.id, "close", { to: "codex" })
      expect(unknown.ok).toBe(false)
      expect(unknown.reason).toMatch(/^"codex" is no terminal's handle here\./)
      expect(unknown.reason).toContain("- @fox: Codex")
      expect(unknown.reason).toContain("- @owl: Claude Code")
      // Nor with anything more than the tool takes, which the runner refuses all the same,
      // though the tool passes on only what it takes.
      await expect(
        manager.closePeer({
          type: "close",
          terminalId: claude.id,
          token: claudeToken,
          request: { to: "fox", force: true },
        }),
      ).resolves.toMatchObject({ ok: false })
      expect(manager.get(codex.id).exit).toBeNull()

      // Codex runs an agent claude doesn't lead, so the person is asked first, and no window
      // follows the asks yet.
      await expect(call(claude.id, "close", { to: "fox" })).resolves.toEqual({
        ok: false,
        reason: "Novadeck isn't open to ask the user, so nothing closed.",
      })
      expect(manager.get(codex.id).exit).toBeNull()
      const asking = new AbortController()
      const asked: Approval[] = []
      const person = (async () => {
        for await (const item of manager.approvals("person", asking.signal)) asked.push(item)
      })()
      // The answer comes at once; the person's yes closes it: its shell ended, the terminal
      // gone and forgotten, and what waited for it gone.
      await expect(call(claude.id, "close", { to: "fox" })).resolves.toEqual({
        ok: true,
        text: expect.stringMatching(
          /^Asked the user to confirm closing @fox · Terminal, which runs Codex\. It closes only if/,
        ),
      })
      await expect.poll(() => asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({
        type: "request",
        from: claude.id,
        terminalId: codex.id,
        action: { type: "close" },
      })
      expect(manager.get(codex.id).exit).toBeNull()
      const request = (asked[0] as { requestId: string }).requestId
      // Not another client's to answer.
      expect(() => manager.answerApproval({ requestId: request, approved: true }, "other")).toThrow(
        expect.objectContaining({ code: "NOT_FOUND" }),
      )
      manager.answerApproval({ requestId: request, approved: true }, "person")
      await viewing
      expect(events).toContain("exited")
      expect(() => process.kill(shellPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
      expect(() => manager.get(codex.id)).toThrow(
        expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
      )
      expect(shell.store.terminal(codex.id)).toBeUndefined()
      // Claude hears the person confirmed it, with its next prompt.
      const next = await step(claude.id, { hook: "UserPromptSubmit", payload: { prompt: "ok" } })
      expect(next).toContain("The user confirmed closing @fox")
      // What its bar held went with it.
      expect(items.bar(codex.id)).toEqual([])
      expect(shell.store.items().filter((item) => item.name === "plan.txt")).toEqual([])
      await expect
        .poll(() =>
          changes.some((change) => change.type === "removed" && change.terminalId === codex.id),
        )
        .toBe(true)
      // The other sender learns so with its next answer, as for any message gone.
      await expect(call(third.id, "send", { to: "moth", text: "Done?" })).resolves.toMatchObject({
        ok: true,
        text: expect.stringContaining(
          `Your earlier message ${messageId(theirs)} to @fox won't arrive: the agent session it was for ended there.`,
        ),
      })

      // The other session's fox is no one's here.
      const outside = await call(claude.id, "close", { to: "fox" })
      expect(outside).toMatchObject({ ok: false })
      expect(outside.reason).toMatch(/^"fox" is no terminal's handle here\./)
      expect(away.map(({ id }) => manager.get(id).exit)).toEqual([null, null])
      // Nor does a call without the terminal's own token close anything.
      await expect(
        manager.closePeer({
          type: "close",
          terminalId: claude.id,
          token: "0".repeat(48),
          request: { to: "owl" },
        }),
      ).resolves.toEqual(unansweredCalls.close)
      expect(manager.get(third.id).exit).toBeNull()
      asking.abort()
      await person
      watching.abort()
      await watched
    })

    it("lets an agent close its own terminal, a moment after the answer", async ({ shell }) => {
      const bin = standIn(shell.home)
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const claude = await create(manager, shell)
      const other = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(claude.id, "claude", "s-claude")
      const told = JSON.parse(await step(claude.id, { call: "close", request: { to: "moth" } }))
      expect(told).toEqual({
        ok: true,
        text: expect.stringMatching(/^Closing @moth · Terminal, your own terminal, in a moment/),
      })
      // The shell ends after the answer, and the terminal is forgotten like any closed: the
      // store lets it go a step before the manager does, so wait for both.
      const held = () => {
        try {
          manager.get(claude.id)
          return true
        } catch {
          return false
        }
      }
      await expect.poll(held, { timeout: 10_000 }).toBe(false)
      expect(shell.store.terminal(claude.id)).toBeUndefined()
      expect(manager.get(other.id).exit).toBeNull()
    })

    it("tells the agent the person kept a terminal open, or that nothing closed as their window went away", async ({
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
      const call = async (type: string, request: object) =>
        JSON.parse(await step(claude.id, { call: type, request })) as Told
      const prompt = () => step(claude.id, { hook: "UserPromptSubmit", payload: { prompt: "ok" } })
      const asked: Approval[] = []
      const follow = (signal: AbortSignal) =>
        (async () => {
          for await (const item of manager.approvals("person", signal)) asked.push(item)
        })()

      // The person keeps it open.
      const first = new AbortController()
      const one = follow(first.signal)
      await call("close", { to: "fox" })
      await expect.poll(() => asked).toHaveLength(1)
      manager.answerApproval(
        { requestId: (asked[0] as { requestId: string }).requestId, approved: false },
        "person",
      )
      expect(await prompt()).toContain("The user kept @fox")
      expect(manager.get(codex.id).exit).toBeNull()

      // Their window goes away before they answer.
      await call("close", { to: "fox" })
      await expect.poll(() => asked).toHaveLength(2)
      first.abort()
      await one
      expect(await prompt()).toContain("Nothing closed: Novadeck's window went away")
      expect(manager.get(codex.id).exit).toBeNull()
    })

    it("lets an agent lead another's agent once the person approves, and ends it when the person releases", async ({
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
      const call = async (type: string, request: object) =>
        JSON.parse(await step(claude.id, { call: type, request })) as Told
      const prompt = () => step(claude.id, { hook: "UserPromptSubmit", payload: { prompt: "ok" } })
      const asked: Approval[] = []
      const asking = new AbortController()
      const person = (async () => {
        for await (const item of manager.approvals("person", asking.signal)) asked.push(item)
      })()

      await expect(call("lead", { to: "fox", message: "Fix the lint." })).resolves.toMatchObject({
        ok: true,
        text: expect.stringMatching(/^Asked the user to let you lead @fox/),
      })
      await expect.poll(() => asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({
        type: "request",
        from: claude.id,
        terminalId: codex.id,
        action: { type: "lead", brief: "Fix the lint." },
      })
      expect(manager.get(codex.id).ledBy).toBeNull()
      manager.answerApproval(
        { requestId: (asked[0] as { requestId: string }).requestId, approved: true },
        "person",
      )
      expect(manager.get(codex.id).ledBy).toBe(claude.handle)
      expect(await prompt()).toContain("you now lead @fox")

      // Only the lead releases; the person may too.
      manager.releaseLead(codex.id)
      expect(manager.get(codex.id).ledBy).toBeNull()
      expect(await prompt()).toContain("The user released @fox")
      asking.abort()
      await person
    })

    it("refuses a terminal already closing, and still closes one as the runner stops", async ({
      shell,
    }) => {
      const manager = shell.manager()
      const [first, second, target, last] = await Promise.all(
        [1, 2, 3, 4].map(() => create(manager, shell)),
      )
      // Each caller's own token, as its shell has it, for calls made as its MCP server would.
      const token = async (terminalId: string) => {
        const file = join(shell.home, `token-${terminalId}`)
        manager.write(
          { terminalId, data: `echo "$NOVADECK_REPORT_TOKEN" > '${file}'; echo saved\r` },
          "owner",
        )
        await shell.until(manager, terminalId, /^saved$/m)
        return readFileSync(file, "utf8").trim()
      }
      const calls = {
        first: { type: "close" as const, terminalId: first!.id, token: await token(first!.id) },
        second: { type: "close" as const, terminalId: second!.id, token: await token(second!.id) },
      }
      // The terminals ignore hangups, so ending each takes its second signal, a second on.
      for (const { id } of [target!, last!]) {
        manager.write({ terminalId: id, data: "trap '' HUP; echo trapped\r" }, "owner")
        // eslint-disable-next-line no-await-in-loop -- Each is readied in turn.
        await shell.until(manager, id, /^trapped$/m)
      }
      // Past reading whether a program runs there, a close is under way once the terminal
      // takes no more input.
      const underWay = (terminalId: string) =>
        expect
          .poll(
            () => {
              try {
                manager.write({ terminalId, data: " " }, "owner")
                return false
              } catch (error) {
                return (error as { code?: string }).code === "TERMINAL_EXITED"
              }
            },
            { timeout: 10_000 },
          )
          .toBe(true)
      const closing = manager.closePeer({
        ...calls.first,
        request: { to: "owl" },
      })
      await underWay(target!.id)
      await expect(manager.closePeer({ ...calls.second, request: { to: "owl" } })).resolves.toEqual(
        {
          ok: false,
          reason: "@owl is already closing.",
        },
      )
      await expect(closing).resolves.toMatchObject({ ok: true, handle: "owl" })
      // The runner stops while a close ends the shell: the terminal is closed all the same.
      const stopped = manager.closePeer({
        ...calls.first,
        request: { to: "crow" },
      })
      await underWay(last!.id)
      const stopping = manager.shutdown()
      await expect(stopped).resolves.toEqual(unansweredCalls.close)
      await stopping
      expect(shell.store.terminal(last!.id)).toBeUndefined()
      expect(shell.store.terminal(target!.id)).toBeUndefined()
    })

    it("lets a chain of terminals' agents close five a minute, and all agents twenty", async ({
      shell,
    }) => {
      const bin = showStandIn(shell.home)
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      // moth to cinder, in order, so each handle is the terminal's place in the list.
      const terminals: TerminalSummary[] = []
      for (let index = 0; index < 26; index += 1)
        // eslint-disable-next-line no-await-in-loop -- Created in turn, so handles follow the list.
        terminals.push(await create(manager, shell))
      const closes = (from: number, to: readonly number[]) =>
        show(
          shell,
          manager,
          terminals[from - 1]!.id,
          to.map((each) => close(handleWords[each - 1]!)),
        )
      const spent = {
        ok: false,
        reason:
          "Agents closed as many terminals as they may in the last minute; try again shortly, " +
          "or leave the rest for the user to close.",
      }
      // One terminal's agents close four.
      await expect(closes(1, [2, 3, 4, 5])).resolves.toEqual([2, 3, 4, 5].map(closed))
      // A terminal its agents opened shares their budgets, so a chain can't do more, even
      // once it closed the terminal that began it.
      const controller = new AbortController()
      let opened: string | undefined
      const client = (async () => {
        let opening = true
        for await (const { requestId, sessionId, cwd } of manager.requests(
          "client",
          controller.signal,
        )) {
          // This client opens only the first terminal asked for.
          if (!opening) {
            manager.answerRequest({ requestId, reason: "Not now." }, "client")
            continue
          }
          opening = false
          const id = randomUUID()
          opened = id
          // eslint-disable-next-line no-await-in-loop -- Requests are opened in turn.
          await manager.create({ id, sessionId, cwd, cols: 100, rows: 20, requestId }, "client")
          manager.answerRequest({ requestId, terminalId: id }, "client")
        }
      })()
      try {
        await expect(show(shell, manager, terminals[0]!.id, [open({})])).resolves.toMatchObject([
          { ok: true },
        ])
        const chained = (calls: { request: object; type: "open" | "close" }[]) =>
          show(shell, manager, opened!, calls, "client")
        // The terminal that began the chain is back at its prompt: one still running its last
        // command is asked about, not closed.
        await shell.until(manager, terminals[0]!.id, /\$ [^\n$]{0,12}$/)
        await expect(chained([close("moth"), close("raven")])).resolves.toEqual([closed(1), spent])
        await expect(chained(Array.from({ length: 5 }, () => open({})))).resolves.toEqual([
          ...Array.from({ length: 4 }, () => ({ ok: false, reason: "Not now." })),
          {
            ok: false,
            reason:
              "Agents opened as many terminals as they may in the last minute; try again shortly.",
          },
        ])
      } finally {
        controller.abort()
        await client
      }
      expect(manager.get(terminals[5]!.id).exit).toBeNull()
      // Refusals cost nothing: a handle not there.
      await expect(closes(7, [99])).resolves.toMatchObject([{ ok: false }])
      // Others' budgets are their own, until all agents closed twenty this minute.
      await expect(closes(7, [10, 11, 12, 13, 14])).resolves.toEqual(
        [10, 11, 12, 13, 14].map(closed),
      )
      await expect(closes(8, [15, 16, 17, 18, 19])).resolves.toEqual(
        [15, 16, 17, 18, 19].map(closed),
      )
      await expect(closes(9, [20, 21, 22, 23, 24])).resolves.toEqual(
        [20, 21, 22, 23, 24].map(closed),
      )
      await expect(closes(25, [26])).resolves.toEqual([spent])
      expect(manager.get(terminals[25]!.id).exit).toBeNull()
    })
  },
)
