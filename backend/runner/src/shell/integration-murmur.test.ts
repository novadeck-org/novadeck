import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { Terminals } from "../terminals/index.js"
import { describe, expect } from "../test.js"
import { FakeDescriber } from "../testing/describer.js"
import { bash, it, create } from "./integration.test-support.js"
import {
  standIn,
  driver,
  type Told,
  context,
  ringing,
  agyStarted,
} from "./stand-ins.test-support.js"

// Murmur's waits, short for the tests.
const murmurTimes = { settleMs: 30, shellRunMs: 400, shellSettleMs: 60 }

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "murmur naming terminals in bash terminals",
  // Polls wait up to 30 s for a loaded machine; the tests have room for them.
  { timeout: 90_000 },
  () => {
    it("titles an agent's terminal from its summary alone, beneath the person's title", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      // The terminals' shells are described at their prompts too: here murmur does not run
      // for them, so only the agent's digests are answered and counted.
      const describer = new FakeDescriber({
        reply: (digest) => (digest.kind !== "agent" ? undefined : { title: "Login fix" }),
      })
      const agentDigests = () => describer.digests.filter((digest) => digest.kind === "agent")
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
        describer,
        murmurTimes,
      })
      const claude = await create(manager, shell)
      const codex = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(claude.id, "claude", "s-claude")
      await start(codex.id, "codex", "s-codex")
      const prompt = async (terminalId: string, text: string) =>
        context(await step(terminalId, { hook: "UserPromptSubmit", payload: { prompt: text } }))
      const listed = async () =>
        (JSON.parse(await step(claude.id, { call: "agents", request: {} })) as { text: string })
          .text
      const summarize = async (summary: string, extra: object = {}) =>
        JSON.parse(
          await step(codex.id, { call: "summarize", request: { summary, ...extra } }),
        ) as Told

      // Its first prompt tells the agent of the bar beside its terminal and of the Inbox,
      // and asks for a summary; it has no way to set a title.
      const first = (await prompt(codex.id, "Fix the login bug")).split("\n\n")
      expect(first[0]).toMatch(/^Novadeck: automatic notice, not from the user: beside this/)
      expect(first[1]).toMatch(/the user rarely watches this terminal/)
      expect(first[2]).toMatch(/this terminal has no summary yet.*summarize tool/)
      // Its prompt titles nothing.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(agentDigests()).toHaveLength(0)

      // The agent summarizes its own terminal: titles stay Novadeck's, and murmur names the
      // terminal from the summary alone.
      await expect(
        summarize("Fixes the login bug.\nThen its tests.", {
          title: "Evil",
          to: "moth",
        }),
      ).resolves.toEqual({ ok: true, text: "Summarized this terminal." })
      await expect.poll(() => manager.get(codex.id).title, { timeout: 30_000 }).toBe("Login fix")
      expect(manager.get(codex.id).titleSource).toEqual({ kind: "murmur" })
      expect(agentDigests()).toEqual([
        expect.objectContaining({
          kind: "agent",
          summary: "Fixes the login bug.\nThen its tests.",
        }),
      ])
      expect(agentDigests()[0]).not.toHaveProperty("prompts")
      expect(manager.get(claude.id).title).toBe("Terminal")
      expect(await listed()).toContain(
        "- @fox: Codex, busy, last active just now\n" +
          "  title: Login fix (written by Novadeck's local model, not the user)\n" +
          "  described by its agent: Fixes the login bug. / Then its tests.",
      )
      expect(shell.store.terminalIdentity(codex.id)?.naming).toEqual({
        person: null,
        opener: null,
        murmur: { title: "Login fix" },
        summary: "Fixes the login bug.\nThen its tests.",
      })
      // A summary that can't be taken says why.
      await expect(summarize("")).resolves.toMatchObject({
        ok: false,
        reason: expect.stringMatching(/^The summary is empty/),
      })

      // The person's title shows over murmur's, and goes back to it when reset.
      manager.rename({ terminalId: codex.id, title: "Mine" })
      expect(manager.get(codex.id)).toMatchObject({
        title: "Mine",
        titleSource: { kind: "person" },
      })
      expect(await listed()).toContain(
        "  described by its agent: Fixes the login bug. / Then its tests.",
      )
      manager.resetTitle({ terminalId: codex.id })
      expect(manager.get(codex.id)).toMatchObject({
        title: "Login fix",
        titleSource: { kind: "murmur" },
      })
    })

    it("nudges the agent to summarize again after a compaction, which retitles nothing", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      // The shell the stand-in agent ran in is described at its prompt when the machine is slow
      // to bind the agent; murmur does not run for shells here, so only the agent's digests count.
      const describer = new FakeDescriber({
        reply: (digest, call) => (digest.kind === "shell" ? undefined : { title: `Title ${call}` }),
      })
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
        describer,
        murmurTimes,
      })
      const terminal = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      const agents = () => describer.digests.filter((digest) => digest.kind === "agent")
      await start(terminal.id, "claude", "s-claude")
      const prompt = async (text: string) =>
        context(await step(terminal.id, { hook: "UserPromptSubmit", payload: { prompt: text } }))
      await prompt("Fix the build")
      await step(terminal.id, {
        call: "summarize",
        request: { summary: "Fixes the build." },
      })
      await expect.poll(() => agents().length, { timeout: 30_000 }).toBe(1)
      await step(terminal.id, { hook: "Stop", payload: {} })
      await expect(prompt("go on")).resolves.toBe("")
      await step(terminal.id, { hook: "Stop", payload: {} })
      await step(terminal.id, {
        hook: "SessionStart",
        payload: { source: "compact", cwd: shell.home },
      })
      const after = (await prompt("and now?")).split("\n\n")
      // All: the bar and the Inbox again, then the summary to update only for another subject.
      expect(after[0]).toMatch(/beside this terminal/)
      expect(after[1]).toMatch(/the user rarely watches this terminal/)
      expect(after[2]).toMatch(
        /summary is "Fixes the build\."; if the work here is now about something else/,
      )
      await expect(prompt("next")).resolves.toBe("")
      // Murmur titled it from its summary; the compaction, the Stops and the prompts after
      // them retitled nothing.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(agents()).toEqual([expect.objectContaining({ summary: "Fixes the build." })])
    })

    it("tells a session resumed after a restart nothing it heard, and a compacted one all again", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const env = { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` }
      const first = shell.manager({ env, describer: new FakeDescriber(), murmurTimes })
      const terminal = await create(first, shell)
      const peer = await create(first, shell)
      const one = driver(shell, first)
      await one.start(terminal.id, "claude", "s-claude")
      await one.start(peer.id, "codex", "s-codex")
      const prompt = async (step: typeof one.step, text: string) =>
        context(await step(terminal.id, { hook: "UserPromptSubmit", payload: { prompt: text } }))
      const send = (step: typeof one.step, text: string) =>
        step(peer.id, { call: "send", request: { to: "moth", text } })
      const pointer = "as the full note given earlier in this session"
      await send(one.step, "First.")
      const given = await prompt(one.step, "Fix the build")
      expect(given).toMatch(/beside this terminal/)
      expect(given).toContain("First.")
      expect(given).not.toContain(pointer)
      await one.step(terminal.id, { call: "summarize", request: { summary: "Fixes the build." } })
      await one.step(terminal.id, { hook: "Stop", payload: {} })
      // Kept with the session's report, which a restart reads back.
      await expect
        .poll(() => shell.store.terminal(terminal.id)?.agents.claude)
        .toMatchObject({
          sessionId: "s-claude",
          told: { bar: true, notes: { peer: expect.any(String) } },
        })
      await first.shutdown()

      // The same session again under a new runner, as a restart resumes it: it holds the
      // notices and the note still, so it hears none of them again.
      const second = shell.manager({ env, describer: new FakeDescriber(), murmurTimes })
      await create(second, shell, { id: terminal.id, restore: true })
      await create(second, shell, { id: peer.id, restore: true })
      const two = driver(shell, second)
      await two.start(terminal.id, "claude", "s-claude")
      await two.start(peer.id, "codex", "s-codex")
      await send(two.step, "Second.")
      const resumed = await prompt(two.step, "go on")
      expect(resumed).toContain("Second.")
      expect(resumed).toContain(pointer)
      expect(resumed).not.toMatch(/beside this terminal/)
      await two.step(terminal.id, { hook: "Stop", payload: {} })

      // Compacted, it may have lost them: all again, and the report holds nothing.
      await two.step(terminal.id, {
        hook: "SessionStart",
        payload: { source: "compact", cwd: shell.home },
      })
      expect(shell.store.terminal(terminal.id)?.agents.claude?.told).toBeUndefined()
      await send(two.step, "Third.")
      const after = (await prompt(two.step, "and now?")).split("\n\n")
      expect(after[0]).toContain("Third.")
      expect(after[0]).not.toContain(pointer)
      expect(after[1]).toMatch(/beside this terminal/)
      expect(after[2]).toMatch(/the user rarely watches this terminal/)
      await second.shutdown()
    })

    it("never titles an agent from its prompts, its turns' ends or its drift", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const describer = new FakeDescriber()
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
        describer,
        murmurTimes,
      })
      const terminal = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(terminal.id, "claude", "s-claude")
      const write = (folder: string) =>
        step(terminal.id, {
          hook: "PostToolUse",
          payload: {
            tool_name: "Write",
            tool_input: { file_path: join(shell.home, folder, "a.ts") },
          },
        })
      // (The shell the stand-in agent ran in is described at its prompt, as any shell is.)
      const agents = () => describer.digests.filter((digest) => digest.kind === "agent")
      await step(terminal.id, { hook: "UserPromptSubmit", payload: { prompt: "hows going?" } })
      await step(terminal.id, { hook: "Stop", payload: {} })
      await step(terminal.id, { hook: "UserPromptSubmit", payload: { prompt: "Fix the build" } })
      for (const _ of [1, 2, 3, 4])
        // eslint-disable-next-line no-await-in-loop -- Each write is its own hook.
        await write("docs")
      await step(terminal.id, { hook: "Stop", payload: {} })
      await step(terminal.id, { hook: "UserPromptSubmit", payload: { prompt: "try again" } })
      await step(terminal.id, { hook: "Stop", payload: {} })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(agents()).toHaveLength(0)
    })

    it("describes a plain shell at its prompt, while a program has run a few seconds, and when its directory changes", async ({
      shell,
    }) => {
      const describer = new FakeDescriber({
        reply: (digest) => ({
          title: digest.kind === "shell" && digest.command ? "Waiting" : "Back at the prompt",
          summary: "A shell.",
        }),
      })
      const manager = shell.manager({ describer, murmurTimes, processPollMs: 50 })
      const terminal = await create(manager, shell)
      await shell.until(manager, terminal.id, "$ ")
      // A command that ends at once is described at the prompt it returns to, with no program.
      manager.write({ terminalId: terminal.id, data: "echo quick\r" }, "owner")
      await expect.poll(() => describer.digests.length, { timeout: 30_000 }).toBe(1)
      expect(describer.digests[0]).toMatchObject({
        kind: "shell",
        command: null,
        screen: expect.arrayContaining([expect.stringContaining("quick")]),
      })
      // One that runs on is described by its command line (where the platform tells it) and screen.
      manager.write({ terminalId: terminal.id, data: "sleep 30\r" }, "owner")
      await expect.poll(() => describer.digests.length, { timeout: 30_000 }).toBe(2)
      expect(describer.digests[1]).toMatchObject({
        kind: "shell",
        command: expect.stringContaining("sleep"),
        screen: expect.arrayContaining([expect.stringContaining("sleep 30")]),
      })
      await expect.poll(() => manager.get(terminal.id).title, { timeout: 30_000 }).toBe("Waiting")
      expect(manager.get(terminal.id).titleSource).toEqual({ kind: "murmur" })
      // Interrupted, back at the prompt after a long run: described again, from the prompt
      // (no program in its digest), whenever the machine gets to it.
      manager.write({ terminalId: terminal.id, data: "\x03" }, "owner")
      // Polled as the commands asked about so far, so a failure shows what was asked.
      await expect
        .poll(
          () => describer.digests.map((digest) => (digest.kind === "shell" ? digest.command : "")),
          {
            timeout: 30_000,
          },
        )
        .toContain(null)
      await expect
        .poll(() => manager.get(terminal.id).title, { timeout: 30_000 })
        .toBe("Back at the prompt")
      // Another directory describes it too.
      const before = describer.digests.length
      mkdirSync(join(shell.home, "sub"))
      manager.write({ terminalId: terminal.id, data: "cd sub\r" }, "owner")
      await expect.poll(() => describer.digests.length, { timeout: 30_000 }).toBeGreaterThan(before)
      expect(describer.digests.at(-1)).toMatchObject({
        kind: "shell",
        screen: expect.arrayContaining([expect.stringContaining("cd sub")]),
      })
    })

    it("tells which screen line the last command was typed on, from the prompt reports", async ({
      shell,
    }) => {
      const describer = new FakeDescriber({ reply: () => ({ title: "Shell" }) })
      const manager = shell.manager({ describer, murmurTimes, processPollMs: 50 })
      const terminal = await create(manager, shell)
      await shell.until(manager, terminal.id, "$ ")
      const run = async (line: string, seen: string) => {
        const before = describer.digests.length
        manager.write({ terminalId: terminal.id, data: `${line}\r` }, "owner")
        await expect
          .poll(
            () =>
              describer.digests
                .slice(before)
                .find(
                  (digest) =>
                    digest.kind === "shell" && digest.screen.some((row) => row.includes(seen)),
                ),
            { timeout: 30_000 },
          )
          .toBeDefined()
        return describer.digests.slice(before).findLast((digest) => digest.kind === "shell")!
      }
      await run("echo a", "echo a")
      // Output that looks like prompts and commands is not a command's line.
      const digest = await run("printf '> not a prompt\\n$ neither\\n'", "neither")
      if (digest.kind !== "shell") throw new Error("shell digest expected")
      expect(digest.commandAt).toBeDefined()
      expect(digest.screen[digest.commandAt!]).toContain("printf")
      expect(digest.screen[digest.commandAt!]).not.toContain("not a prompt\n")
      expect(digest.screen).toContain("> not a prompt")
    })

    it("describes nothing for an empty Enter, and keeps no line for a command that was not entered", async ({
      shell,
    }) => {
      const describer = new FakeDescriber({ reply: () => ({ title: "Shell" }) })
      const manager = shell.manager({ describer, murmurTimes, processPollMs: 50 })
      const terminal = await create(manager, shell)
      await shell.until(manager, terminal.id, "$ ")
      manager.write({ terminalId: terminal.id, data: "echo hello\r" }, "owner")
      await expect.poll(() => describer.digests.length, { timeout: 30_000 }).toBeGreaterThan(0)
      await new Promise((resolve) => setTimeout(resolve, 300))
      const before = describer.digests.length
      manager.write({ terminalId: terminal.id, data: "\r" }, "owner")
      manager.write({ terminalId: terminal.id, data: "\r" }, "owner")
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(describer.digests).toHaveLength(before)
    })

    it("describes nothing for an Enter on a line with nothing on it", async ({ shell }) => {
      const describer = new FakeDescriber({ reply: () => ({ title: "Shell" }) })
      const manager = shell.manager({ describer, murmurTimes, processPollMs: 50 })
      const terminal = await create(manager, shell)
      await shell.until(manager, terminal.id, "$ ")
      manager.write({ terminalId: terminal.id, data: "echo hello\r" }, "owner")
      await expect.poll(() => describer.digests.length, { timeout: 30_000 }).toBeGreaterThan(0)
      await new Promise((resolve) => setTimeout(resolve, 300))
      const before = describer.digests.length
      // A line typed and erased, Ctrl+L, and a line cleared with Ctrl+U: each then Enter.
      for (const keys of ["ls\x7f\x7f\r", "\x0c\r", "abc\x15\r"]) {
        manager.write({ terminalId: terminal.id, data: keys }, "owner")
        // eslint-disable-next-line no-await-in-loop -- One after the other.
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      expect(describer.digests).toHaveLength(before)
    })

    it("keeps no line across a full reset, which clears the screen", async ({ shell }) => {
      const describer = new FakeDescriber({ reply: () => ({ title: "Shell" }) })
      const manager = shell.manager({ describer, murmurTimes, processPollMs: 50 })
      const terminal = await create(manager, shell)
      await shell.until(manager, terminal.id, "$ ")
      // A clean screen, so the lines below are the same on every machine.
      manager.write({ terminalId: terminal.id, data: "printf '\\ec'\r" }, "owner")
      // (A bare prompt is no digest: wait for the prompt to be reported and settled.)
      await new Promise((resolve) => setTimeout(resolve, 800))
      const earlier = describer.digests.length
      manager.write({ terminalId: terminal.id, data: "seq 3\r" }, "owner")
      await expect
        .poll(() => describer.digests.length, { timeout: 30_000 })
        .toBeGreaterThan(earlier)
      const before = describer.digests.length
      manager.write({ terminalId: terminal.id, data: "printf '\\ec'; seq 6\r" }, "owner")
      await expect
        .poll(
          () =>
            describer.digests
              .slice(before)
              .find((digest) => digest.kind === "shell" && digest.screen.includes("6")),
          { timeout: 30_000 },
        )
        .toBeDefined()
      const digest = describer.digests
        .slice(before)
        .findLast((candidate) => candidate.kind === "shell" && candidate.screen.includes("6"))
      if (digest?.kind !== "shell") throw new Error("shell digest expected")
      // The marker of the prompt the reset cleared is gone: no row, not another line's.
      expect(digest.commandAt).toBeUndefined()
    })

    it("names an agent typed into a titled shell from its summary, and its exit does not retitle from its screen", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const env = { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` }
      // Shells are described here, as they are for a person's terminal.
      const describer = new FakeDescriber({
        reply: (digest) => ({ title: digest.kind === "shell" ? "Shell work" : "Login fix" }),
      })
      const manager = shell.manager({ env, describer, murmurTimes, processPollMs: 50 })
      const terminal = await create(manager, shell)
      await shell.until(manager, terminal.id, "$ ")
      manager.write({ terminalId: terminal.id, data: "echo hello\r" }, "owner")
      await expect
        .poll(() => manager.get(terminal.id).title, { timeout: 30_000 })
        .toBe("Shell work")
      // An agent is typed into it, and summarizes its work.
      const { start, step } = driver(shell, manager)
      await start(terminal.id, "claude", "s-claude")
      await step(terminal.id, { call: "summarize", request: { summary: "Fixes the login bug." } })
      // The shell's title is no name of the agent's work: the summary's title replaces it.
      await expect.poll(() => manager.get(terminal.id).title, { timeout: 30_000 }).toBe("Login fix")
      // It runs a while, then the person ends it: what its exit leaves on the screen does not
      // name the terminal again.
      await new Promise((resolve) => setTimeout(resolve, 700))
      const shells = describer.digests.filter((digest) => digest.kind === "shell").length
      manager.write({ terminalId: terminal.id, data: "\x03" }, "owner")
      await expect.poll(() => manager.get(terminal.id).agent, { timeout: 30_000 }).toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(describer.digests.filter((digest) => digest.kind === "shell")).toHaveLength(shells)
      expect(manager.get(terminal.id).title).toBe("Login fix")
    })

    it("drops a restarted terminal's job in flight, and the stale answer lands nowhere", async ({
      shell,
    }) => {
      const describer = new FakeDescriber()
      describer.hold = true
      const manager = shell.manager({ describer, murmurTimes })
      const terminal = await create(manager, shell)
      await shell.until(manager, terminal.id, "$ ")
      mkdirSync(join(shell.home, "sub"))
      manager.write({ terminalId: terminal.id, data: "cd sub\r" }, "owner")
      await expect.poll(() => describer.jobs.length, { timeout: 30_000 }).toBe(1)
      // The shell ends and restarts while the model is still working.
      manager.write({ terminalId: terminal.id, data: "exit\r" }, "owner")
      await expect.poll(() => manager.get(terminal.id).exit, { timeout: 30_000 }).not.toBeNull()
      await manager.restart({ terminalId: terminal.id, cols: 100, rows: 20 }, "owner")
      expect(describer.jobs[0]!.signal?.aborted).toBe(true)
      describer.jobs[0]!.answer({ title: "Stale shell" })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(manager.get(terminal.id)).toMatchObject({
        title: "Terminal",
        titleSource: { kind: "default" },
      })
      expect(shell.store.terminalIdentity(terminal.id)?.naming.murmur).toBeNull()
    })

    it("shows murmur no screen of a full-screen program, and its screen again once the program quits", async ({
      shell,
    }) => {
      const describer = new FakeDescriber()
      const manager = shell.manager({ describer, murmurTimes, processPollMs: 50 })
      const terminal = await create(manager, shell)
      await shell.until(manager, terminal.id, "$ ")
      // A program that, as full-screen ones do, draws a secret on the alternate screen and leaves
      // it before it exits. Not a shell's own: where only the foreground's name is told (macOS),
      // `sh -c` runs as bash, and a program with the shell's name is read as its prompt.
      manager.write(
        {
          terminalId: terminal.id,
          data: `perl -e '$| = 1; print "\\e[?1049h", "ALT", 1, "SECRET\\n"; sleep 3; print "\\e[?1049l", "BACK", 1, "ON\\n"'\r`,
        },
        "owner",
      )
      await expect.poll(() => describer.jobs.length, { timeout: 30_000 }).toBeGreaterThan(0)
      expect(describer.digests[0]).toMatchObject({
        kind: "shell",
        command: expect.stringContaining("perl"),
        screen: [],
      })
      expect(JSON.stringify(describer.digests)).not.toContain("ALT1SECRET")
      // Once it quits, the normal screen is read as before.
      await expect
        .poll(() => describer.digests.at(-1), { timeout: 30_000 })
        .toMatchObject({ screen: expect.arrayContaining([expect.stringContaining("BACK1ON")]) })
      expect(JSON.stringify(describer.digests)).not.toContain("ALT1SECRET")
    })

    it("describes a running terminal that has none once murmur becomes usable", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const describer = new FakeDescriber({ usable: false })
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
        describer,
        murmurTimes,
      })
      const terminal = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(terminal.id, "claude", "s-claude")
      describer.setUsable(false)
      await step(terminal.id, { call: "summarize", request: { summary: "Fixes the build." } })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(describer.jobs).toHaveLength(0)
      expect(manager.get(terminal.id).titleSource).toEqual({ kind: "default" })
      describer.setUsable(true)
      await expect
        .poll(() => manager.get(terminal.id).titleSource, { timeout: 30_000 })
        .toEqual({ kind: "murmur" })
    })

    it("does not retitle a restored terminal whose agent binds the session it already worked in", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const env = { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` }
      const first = shell.manager({ env, describer: new FakeDescriber(), murmurTimes })
      const terminal = await create(first, shell)
      const before = driver(shell, first)
      await before.start(terminal.id, "claude", "s-claude")
      await before.step(terminal.id, {
        call: "summarize",
        request: { summary: "Fixes the login bug." },
      })
      await expect
        .poll(() => first.get(terminal.id).titleSource, { timeout: 30_000 })
        .toEqual({ kind: "murmur" })
      await first.shutdown()
      expect(shell.store.terminalIdentity(terminal.id)?.naming.murmur).not.toBeNull()

      // The runner restarts, and the same session binds again: it is no new conversation.
      // The shell the stand-in agent ran in is described at its prompt when the machine is slow
      // to bind the agent; murmur does not run for shells here, so only the agent's digests count.
      const describer = new FakeDescriber({
        reply: (digest, call) => (digest.kind === "shell" ? undefined : { title: `Title ${call}` }),
      })
      const second = shell.manager({ env, describer, murmurTimes })
      await create(second, shell, { id: terminal.id, restore: true })
      const after = driver(shell, second)
      await after.start(terminal.id, "claude", "s-claude")
      await after.step(terminal.id, { hook: "Stop", payload: {} })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(describer.digests.filter((digest) => digest.kind === "agent")).toHaveLength(0)
      expect(second.get(terminal.id).titleSource).toEqual({ kind: "murmur" })
    })

    it("titles a terminal again only when its agent's new session summarizes", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const env = { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` }
      // The shell the stand-in agent ran in may be described at its prompt when the machine is
      // slow to bind the agent: only the agent's digests are counted.
      const describer = new FakeDescriber()
      const agents = () => describer.digests.filter((digest) => digest.kind === "agent")
      const manager = shell.manager({ env, describer, murmurTimes })
      const terminal = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(terminal.id, "claude", "s-one")
      await step(terminal.id, { call: "summarize", request: { summary: "Fixes the login bug." } })
      await expect.poll(() => agents().length, { timeout: 30_000 }).toBe(1)
      await step(terminal.id, { hook: "Stop", payload: {} })
      await step(terminal.id, {
        hook: "SessionStart",
        payload: { source: "clear", session_id: "s-two", cwd: process.cwd() },
      })
      await step(terminal.id, {
        hook: "UserPromptSubmit",
        payload: { prompt: "Write the signup tests", session_id: "s-two" },
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(agents()).toHaveLength(1)
      await step(terminal.id, {
        call: "summarize",
        request: { summary: "Writes the signup tests." },
      })
      await expect.poll(() => agents().length, { timeout: 30_000 }).toBe(2)
    })

    it("takes murmur's titles from running and kept terminals when murmur is turned off", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const env = { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` }
      const titled = async (manager: Terminals, session: string) => {
        const terminal = await create(manager, shell)
        const { start, step } = driver(shell, manager)
        await start(terminal.id, "claude", session)
        await step(terminal.id, {
          call: "summarize",
          request: { summary: "Fixes the login bug." },
        })
        await expect
          .poll(() => manager.get(terminal.id).titleSource, { timeout: 30_000 })
          .toEqual({ kind: "murmur" })
        return terminal.id
      }
      const earlier = shell.manager({ env, describer: new FakeDescriber(), murmurTimes })
      const kept = await titled(earlier, "s-kept")
      await earlier.shutdown()
      // Closing the runner keeps the title.
      expect(shell.store.terminalIdentity(kept)?.naming.murmur).not.toBeNull()

      const describer = new FakeDescriber()
      const manager = shell.manager({ env, describer, murmurTimes })
      const live = await titled(manager, "s-live")
      const theirs = await titled(manager, "s-theirs")
      manager.rename({ terminalId: theirs, title: "My title" })
      // A client shows the kept terminal as a saved summary, and hears it lose its title.
      const seen = shell.watch(manager)
      describer.clear()
      await seen((terminal) => terminal.id === kept && terminal.titleSource.kind === "default")
      expect(manager.get(live)).toMatchObject({
        title: "Terminal",
        titleSource: { kind: "default" },
      })
      expect(manager.get(theirs)).toMatchObject({ title: "My title" })
      expect(shell.store.terminalIdentity(live)?.naming.murmur).toBeNull()
      expect(shell.store.terminalIdentity(kept)?.naming.murmur).toBeNull()
      expect(shell.store.terminalIdentity(theirs)?.naming).toMatchObject({
        person: "My title",
        murmur: null,
      })
    })

    it("does nothing without a describer: terminals keep their default titles and have no summary", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(terminal.id, "claude", "s-claude")
      await step(terminal.id, { hook: "UserPromptSubmit", payload: { prompt: "Fix the build" } })
      await step(terminal.id, { hook: "Stop", payload: {} })
      expect(manager.get(terminal.id)).toMatchObject({
        title: "Terminal",
        titleSource: { kind: "default" },
      })
      expect(shell.store.terminalIdentity(terminal.id)?.naming.murmur).toBeNull()
    })

    it("takes Antigravity's first typed prompt for its started with, never for its title", async ({
      shell,
    }) => {
      const tui = await ringing(shell, "", "tui", "agy")
      await agyStarted(tui)
      await tui.first()
      expect(tui.manager.get(tui.idle.id)).toMatchObject({
        title: "Terminal",
        titleSource: { kind: "default" },
      })
      expect(shell.store.terminal(tui.idle.id)?.work).toMatchObject({ first: "hello" })
    })

    it("never takes the opener's command-line prompt for the person's, in its first session only", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      // `claude` there is the stand-in, as the opener's command names it.
      writeFileSync(join(bin, "claude"), '#!/bin/sh\nexec agent claude "$@"\n')
      chmodSync(join(bin, "claude"), 0o755)
      const opener = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(opener.id, "claude", "s-opener")
      const steps = join(shell.home, "steps-opened")
      mkdirSync(steps)
      const controller = new AbortController()
      const created: string[] = []
      const client = (async () => {
        for await (const request of manager.requests("client", controller.signal)) {
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
        // The opener starts an agent there with its own prompt on the command line.
        const answer = JSON.parse(
          await step(opener.id, {
            call: "open",
            // Its program quoted, as a shell takes it all the same. The trailing help flag lets
            // open_terminal take it, as a wrapper would, while the runner still sees the agent.
            request: { command: `'claude' s-opened ${steps} fix-the-build --help` },
          }),
        ) as Told
        expect(answer.ok).toBe(true)
        const [opened] = created as [string]
        symlinkSync(steps, join(shell.home, `steps-${opened}`))
        await shell.until(manager, opened, "claude ready")
        // Bound once Novadeck has applied the hook the agent printed it ran; an Enter keyed
        // before that is dropped when the binding applies, and would test nothing here.
        await expect
          .poll(() => manager.messages(opened).delivery, { timeout: 10_000 })
          .toBe("ready")
        const listed = async () =>
          (JSON.parse(await step(opener.id, { call: "agents", request: {} })) as { text: string })
            .text
        // An Enter the person pressed meanwhile, as at a trust screen, doesn't make it theirs.
        manager.write({ terminalId: opened, data: "\r" }, "client")
        await step(opened, { hook: "UserPromptSubmit", payload: { prompt: "fix-the-build" } })
        expect(shell.store.terminal(opened)?.work).toMatchObject({
          first: "fix-the-build",
          firstByPerson: false,
          opened: true,
        })
        expect(manager.get(opened)).toMatchObject({
          title: "claude",
          titleSource: { kind: "default" },
        })
        expect(await listed()).toContain("  started with (@moth's command): fix-the-build")
        // A later root session there is the person's.
        await step(opened, {
          hook: "SessionStart",
          payload: { session_id: "s-later", source: "clear", cwd: shell.home },
        })
        await step(opened, {
          hook: "UserPromptSubmit",
          payload: { session_id: "s-later", prompt: "write the docs" },
        })
        expect(manager.get(opened)).toMatchObject({
          title: "claude",
          titleSource: { kind: "default" },
        })
        expect(await listed()).toContain("  started with: write the docs")

        // A command that starts no agent, as `echo` here: the session the person starts
        // after it, with its own prompt, is theirs, even one the command's words match.
        const generic = join(shell.home, "steps-generic")
        mkdirSync(generic)
        const told = JSON.parse(
          await step(opener.id, { call: "open", request: { command: "echo fix-the-docs" } }),
        ) as Told
        expect(told.ok).toBe(true)
        const plain = { terminalId: created[1]! }
        symlinkSync(generic, join(shell.home, `steps-${plain.terminalId}`))
        await shell.until(manager, plain.terminalId, /^fix-the-docs$/m)
        manager.write(
          { terminalId: plain.terminalId, data: `agent claude s-mine ${generic}\r` },
          "client",
        )
        await shell.until(manager, plain.terminalId, "claude ready")
        await step(plain.terminalId, {
          hook: "UserPromptSubmit",
          payload: { prompt: "fix-the-docs" },
        })
        expect(manager.get(plain.terminalId)).toMatchObject({
          titleSource: { kind: "default" },
        })
        expect(await listed()).toContain("  started with: fix-the-docs")
      } finally {
        controller.abort()
        await client
      }
    })

    it("takes no ask out of the Inbox at the opener's command-line prompt, but at the person's next prompt", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      writeFileSync(join(bin, "claude"), '#!/bin/sh\nexec agent claude "$@"\n')
      chmodSync(join(bin, "claude"), 0o755)
      const opener = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(opener.id, "claude", "s-opener")
      const steps = join(shell.home, "steps-opened")
      mkdirSync(steps)
      const controller = new AbortController()
      const created: string[] = []
      const client = (async () => {
        for await (const request of manager.requests("client", controller.signal)) {
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
        await step(opener.id, {
          call: "open",
          request: { command: `'claude' s-opened ${steps} fix-the-build --help` },
        })
        const [opened] = created as [string]
        symlinkSync(steps, join(shell.home, `steps-${opened}`))
        await shell.until(manager, opened, "claude ready")
        await expect
          .poll(() => manager.messages(opened).delivery, { timeout: 10_000 })
          .toBe("ready")
        const asks = () => manager.inboxEntries().filter(({ terminalId }) => terminalId === opened)
        const asked = JSON.parse(
          await step(opened, {
            call: "ask",
            request: { subject: "Which colour?", body: "Blue or green." },
          }),
        ) as Told
        expect(asked.ok).toBe(true)
        expect(asks()).toHaveLength(1)
        // Its own command-line prompt, whatever Enter came before: the ask stays.
        manager.write({ terminalId: opened, data: "\r" }, "client")
        const first = await step(opened, {
          hook: "UserPromptSubmit",
          payload: { prompt: "fix-the-build" },
        })
        expect(first).not.toContain("took your open ask")
        expect(asks()).toHaveLength(1)
        await step(opened, { hook: "Stop", payload: {} })
        await expect
          .poll(() => manager.messages(opened).delivery, { timeout: 10_000 })
          .toBe("settled")
        // The person's next prompt takes it out, and the agent is told in that answer.
        manager.write({ terminalId: opened, data: "\r" }, "client")
        const next = await step(opened, {
          hook: "UserPromptSubmit",
          payload: { prompt: "blue, please" },
        })
        expect(next).toContain("took your open ask out of their Inbox")
        expect(asks().filter(({ settled }) => !settled)).toEqual([])
        expect(asks().map(({ settled }) => settled?.how)).toEqual(["replied"])
      } finally {
        controller.abort()
        await client
      }
    })

    it("tells whose each root session's first prompt is, and titles none by it", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(terminal.id, "claude", "s-1")
      const prompt = async (session: string, text: string) =>
        context(
          await step(terminal.id, {
            hook: "UserPromptSubmit",
            payload: { session_id: session, prompt: text },
          }),
        )
      const clear = (session: string) =>
        step(terminal.id, {
          hook: "SessionStart",
          payload: { session_id: session, source: "clear", cwd: shell.home },
        })
      expect(manager.get(terminal.id).title).toBe("Terminal")
      // A doorbell's line is never the person's prompt, so never kept as one; its turn, the
      // session's first, takes the notices of the bar, the Inbox and the summary.
      await expect(
        prompt("s-1", "[Novadeck: automatic notice, agent messages waiting, abc123]"),
      ).resolves.toContain("beside this terminal is a bar")
      expect(shell.store.terminal(terminal.id)?.work?.first ?? null).toBeNull()
      // Prompts title nothing; while there is no summary, each asks for one.
      const bar = /^Novadeck: automatic notice, not from the user: beside this terminal/
      await expect(prompt("s-1", "Fix the login bug")).resolves.toMatch(
        /^Novadeck: automatic notice, not from the user: this terminal has no summary yet/,
      )
      await prompt("s-1", "Now its tests")
      expect(manager.get(terminal.id)).toMatchObject({
        title: "Terminal",
        titleSource: { kind: "default" },
      })
      // Nobody pressed Enter for it, so not told as the person's submission.
      expect(shell.store.terminal(terminal.id)?.work).toMatchObject({
        first: "Fix the login bug",
        firstByPerson: false,
        latest: "Now its tests",
      })
      // A new root session starts over, with its own prompts.
      await clear("s-2")
      // The new session is bound once Novadeck says so: a hook's report is applied after the
      // agent has printed that it ran, and an Enter keyed before it is dropped when it applies.
      await expect
        .poll(() => manager.messages(terminal.id).delivery, { timeout: 10_000 })
        .toBe("ready")
      manager.write({ terminalId: terminal.id, data: "\r" }, "owner")
      await expect(prompt("s-2", "Write the docs")).resolves.toMatch(bar)
      expect(shell.store.terminal(terminal.id)?.work).toMatchObject({
        first: "Write the docs",
        firstByPerson: true,
        latest: "Write the docs",
      })
      expect(manager.get(terminal.id).title).toBe("Terminal")
    })

    it("tells the agent once, at the person's next prompt, of a page it showed that had problems", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(terminal.id, "claude", "s-1")
      const prompt = async (text: string) =>
        context(
          await step(terminal.id, {
            hook: "UserPromptSubmit",
            payload: { session_id: "s-1", prompt: text },
          }),
        )
      // The first prompt of the session carries the bar's notice and the summary's.
      await prompt("Build the page")
      // Summarized, so the prompts below are told of pages alone.
      await step(terminal.id, { call: "summarize", request: { summary: "Builds the page." } })
      const items = shell.items(manager)
      const shown = await items.show(manager.place(terminal.id)!, {
        page: { url: "http://localhost:5173/app" },
      })
      const itemId = shown.ok ? shown.id : ""
      const troubles = [
        {
          kind: "error" as const,
          text: "x is undefined",
          source: "http://localhost:5173/a.js",
          line: 3,
        },
      ]
      items.pageTrouble({ itemId, shown: 1, troubles })
      // A doorbell's turn takes it as the person's prompt would, after what it says.
      const told = await prompt("[Novadeck: automatic notice, agent messages waiting, abc123]")
      expect(told).toMatch(
        /\n\nNovadeck: automatic notice, not from the user: the page you showed, /,
      )
      expect(told).toContain('error "x is undefined" at "/a.js:3".')
      // Told once for that show, however often the page repeats itself.
      items.pageTrouble({ itemId, shown: 1, troubles })
      await expect(prompt("And now?")).resolves.toBe("")
      // A new show starts over.
      await items.show(manager.place(terminal.id)!, { page: { url: "http://localhost:5173/app" } })
      items.pageTrouble({ itemId, shown: 2, troubles })
      await expect(prompt("Again?")).resolves.toContain("the page you showed")
    })

    it("drops what a page had when its item is closed or shown again, and with a new session", async ({
      shell,
    }) => {
      const bin = standIn(shell.home)
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      const { start, step } = driver(shell, manager)
      await start(terminal.id, "claude", "s-1")
      const prompt = async (session: string, text: string) =>
        context(
          await step(terminal.id, {
            hook: "UserPromptSubmit",
            payload: { session_id: session, prompt: text },
          }),
        )
      await prompt("s-1", "Build the page")
      // Summarized, so the prompts below are told of pages alone.
      await step(terminal.id, { call: "summarize", request: { summary: "Builds the page." } })
      const items = shell.items(manager)
      const place = manager.place(terminal.id)!
      const troubles = [{ kind: "load" as const, text: "ERR_CONNECTION_REFUSED" }]
      const show = async (url: string) => {
        const shown = await items.show(place, { page: { url } })
        return shown.ok ? shown.id : ""
      }
      const first = await show("http://localhost:5173/")
      const second = await show("http://localhost:5174/")
      // A closed item, and one shown again since, have nothing left to tell.
      items.pageTrouble({ itemId: first, shown: shell.store.item(first)!.version, troubles })
      items.pageTrouble({ itemId: second, shown: shell.store.item(second)!.version, troubles })
      items.close(first)
      await show("http://localhost:5174/")
      await expect(prompt("s-1", "Anything?")).resolves.toBe("")
      // A new root session did not show the page, though the pane repeats itself after it.
      const third = await show("http://localhost:5175/")
      items.pageTrouble({ itemId: third, shown: 1, troubles })
      await step(terminal.id, {
        hook: "SessionStart",
        payload: { session_id: "s-2", source: "clear", cwd: shell.home },
      })
      await expect
        .poll(() => manager.messages(terminal.id).delivery, { timeout: 10_000 })
        .toBe("ready")
      await prompt("s-2", "Hello")
      items.pageTrouble({ itemId: third, shown: shell.store.item(third)!.version, troubles })
      await expect(prompt("s-2", "Still?")).resolves.toBe("")
      // A show of the new session is told (its latest version).
      await show("http://localhost:5175/")
      items.pageTrouble({ itemId: third, shown: shell.store.item(third)!.version, troubles })
      await expect(prompt("s-2", "And?")).resolves.toContain("the page you showed")
    })
  },
)
