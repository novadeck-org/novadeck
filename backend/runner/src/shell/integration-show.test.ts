import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect } from "../test.js"
import { bash, it, create, showStandIn, show } from "./integration.test-support.js"

// What showing `name` tells the agent, when it waits for the person.
const awaits = (name: string) => ({
  ok: true,
  text: `${name} is waiting for the user in Novadeck, marked new.`,
})

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "what agents show from a bash terminal",
  () => {
    it("shows any file the person can read, opening it when asked, but never a secret one", async ({
      shell,
    }) => {
      const project = join(shell.home, "project")
      const work = join(shell.home, "work")
      const plans = join(shell.home, ".claude", "plans")
      for (const folder of [project, work, plans]) mkdirSync(folder, { recursive: true })
      writeFileSync(join(project, "a.ts"), "const a = 1\n")
      writeFileSync(join(work, "w.txt"), "work\n")
      writeFileSync(join(plans, "p.md"), "# Plan\n")
      writeFileSync(join(shell.home, "elsewhere.txt"), "elsewhere\n")
      writeFileSync(join(work, ".env"), "TOKEN=x\n")
      const bin = showStandIn(shell.home)
      const manager = shell.manager({
        env: {
          HOME: shell.home,
          CLAUDE_CONFIG_DIR: join(shell.home, ".claude"),
          PS1: "$ ",
          PATH: `${bin}:${process.env.PATH}`,
        },
        projectFolder: (sessionId) => (sessionId === shell.sessionId ? project : undefined),
      })
      const terminal = await create(manager, shell, { cwd: work })
      const items = shell.items(manager)
      const bar = () => items.bar(terminal.id)
      const answers = await show(shell, manager, terminal.id, [
        { request: { file: { path: join(project, "a.ts") } } },
        { request: { file: { path: "w.txt" }, open: true } },
        { request: { file: { path: join(plans, "p.md") }, title: "The plan" } },
        { request: { file: { path: join(shell.home, "elsewhere.txt") } } },
        { request: { file: { path: ".env" }, open: true } },
        { request: { file: { path: "w.txt" } }, token: "0".repeat(48) },
        { request: { file: { path: "w.txt", lines: { from: 2, to: 1 } } } },
      ])
      expect(answers).toEqual([
        awaits("a.ts"),
        { ok: true, text: "Showing w.txt to the user in Novadeck." },
        awaits("The plan"),
        awaits("elsewhere.txt"),
        // Asked to open, but it may hold secrets: it waits for the person.
        {
          ok: true,
          text:
            ".env may hold secrets, so it doesn't open by itself: it's waiting for the user " +
            "in Novadeck, marked new, to open if they choose.",
        },
        { ok: false, reason: "Novadeck couldn't show it." },
        { ok: false, reason: 'The request\'s "file.lines" is not valid.' },
      ])
      expect(bar()).toMatchObject([
        {
          id: expect.any(String),
          holder: { terminalId: terminal.id },
          kind: "file",
          name: "a.ts",
          detail: "a.ts",
          version: 1,
          openAsked: false,
        },
        {
          id: expect.any(String),
          holder: { terminalId: terminal.id },
          kind: "file",
          name: "w.txt",
          detail: "w.txt",
          version: 1,
          openAsked: true,
        },
        {
          id: expect.any(String),
          holder: { terminalId: terminal.id },
          kind: "file",
          name: "The plan",
          detail: join(plans, "p.md"),
          version: 1,
          openAsked: false,
        },
        {
          id: expect.any(String),
          holder: { terminalId: terminal.id },
          kind: "file",
          name: "elsewhere.txt",
          detail: join(shell.home, "elsewhere.txt"),
          version: 1,
          openAsked: false,
        },
        {
          id: expect.any(String),
          holder: { terminalId: terminal.id },
          kind: "file",
          name: ".env",
          detail: ".env",
          version: 1,
          openAsked: false,
          secret: true,
        },
      ])
      const [first, , , , env] = bar()
      await expect(items.load(first!.id, false)).resolves.toMatchObject({
        state: "ready",
        content: {
          kind: "file",
          path: join(project, "a.ts"),
          firstLine: 1,
          lines: ["const a = 1"],
          from: 1,
          to: 1,
        },
      })
      // A path is taken from where the shell is now; showing a file again replaces it.
      const moved = shell.watch(manager)
      manager.write({ terminalId: terminal.id, data: "cd ../project\r" }, "owner")
      await moved((summary) => summary.id === terminal.id && summary.cwd === project)
      writeFileSync(join(project, "a.ts"), "const a = 2\n")
      expect(
        await show(shell, manager, terminal.id, [{ request: { file: { path: "a.ts" } } }]),
      ).toEqual([
        { ok: true, text: "a.ts is updated and waiting for the user in Novadeck, marked new." },
      ])
      expect(bar().find(({ name }) => name === "a.ts")?.id).toBe(first!.id)
      expect(bar().map(({ name, version }) => `${name} ${version}`)).toEqual([
        "w.txt 1",
        "The plan 1",
        "elsewhere.txt 1",
        ".env 1",
        "a.ts 2",
      ])
      await expect(items.load(first!.id, false)).resolves.toMatchObject({
        content: { lines: ["const a = 2"] },
      })
      // Held, it opens only as the person picks it.
      await expect(items.load(env!.id, false)).resolves.toMatchObject({ reason: "secret" })
      await expect(items.load(env!.id, true)).resolves.toMatchObject({
        content: { lines: ["TOKEN=x"] },
      })
      await manager.close({ terminalId: terminal.id })
      // Closed, the terminal took what its bar held along.
      expect(shell.store.items()).toEqual([])
    })

    it("keeps everything shown, with no cap", async ({ shell }) => {
      const bin = showStandIn(shell.home)
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      // A project folder, not the home folder itself, which Novadeck never shows from.
      const project = join(shell.home, "many")
      mkdirSync(project)
      const terminal = await create(manager, shell, { cwd: project })
      const names = Array.from({ length: 65 }, (_, index) => `f${index}.txt`)
      for (const name of names) writeFileSync(join(project, name), `${name}\n`)
      const answers = (await show(
        shell,
        manager,
        terminal.id,
        names.map((path) => ({ request: { file: { path } } })),
      )) as { ok: boolean }[]
      expect(answers.every((answer) => answer.ok)).toBe(true)
      const items = shell.items(manager)
      const bar = items.bar(terminal.id)
      expect(bar.map(({ name }) => name)).toEqual(names)
      await expect(items.load(bar[0]!.id, false)).resolves.toMatchObject({
        content: { lines: ["f0.txt"] },
      })
    })
  },
)
