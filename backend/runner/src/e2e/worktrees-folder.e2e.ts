import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { worktreesRoot } from "../worktrees/root.js"
import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported, type E2E } from "./fixture.js"
import { answers, own, replies, result, start, turn } from "./scenarios.js"

// Every harness's shim gives a session the folder where agents' worktrees live, once it exists:
// on the rig, the sandbox's own (the deck gives its runner `worktreesRoot` of the sandbox's
// home). Claude Code from 2.1.326 asks before taking a folder it hasn't trusted given by
// `--add-dir`, its default exiting, so its shim names the folder in the settings it passes
// instead (e2e/probes/add-dir.e2e.ts). The test makes the folder; it goes with the sandbox.

type Defer = { readonly defer: (cleanup: () => void) => void }

/** The worktrees' folder the rig's runner gives its agents, made for the test. */
const worktreesFolder = (run: E2E): string => {
  const root = worktreesRoot(run.sandbox.home)
  mkdirSync(root, { recursive: true })
  return root
}

/** A file of its own in `folder`, taken away after. */
const fileIn = (run: Defer, folder: string, name: string, text: string): string => {
  const dir = join(folder, `novadeck-e2e-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  run.defer(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, name)
  writeFileSync(file, text)
  return file
}

/** Merges `change` into the JSON file at `path`, made where it isn't. */
const merge = (path: string, change: (data: Record<string, unknown>) => void): void => {
  const data = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {}
  change(data)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(data))
}

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("starts at its prompt with the worktrees' folder there, asking nothing of it", async ({
      e2e: run,
    }) => {
      worktreesFolder(run)
      run.model.use(replies("Warm up", "Warmed up."))
      const t = await start(run, setup)
      await turn(t, "Warm up", "Warmed up.")
      expect(t.summary().startup ?? null).toBeNull()
      await run.deck.restart()
      const resumed = await run.deck.restore(t, { resume: setup.agent })
      await resumed.reached("ready", { timeoutMs: 60_000 })
      expect(resumed.summary().startup ?? null).toBeNull()
    })

    // A Read outside the session's folders asks the person first (its permission dialog), which
    // would hold the turn: one in the worktrees' folder doesn't, and the person's own folders
    // and rules from their settings still apply beside it, merged with the shim's.
    if (setup.agent === "claude")
      it("reads in the worktrees' folder unasked, the person's own folders and rules still applying", async ({
        e2e: run,
        resources,
      }) => {
        const root = worktreesFolder(run)
        const inWorktrees = fileIn(resources, root, "note.txt", "worktrees-words\n")
        const theirs = join(run.sandbox.root, "their-folder")
        const inTheirs = fileIn(resources, theirs, "note.txt", "their-words\n")
        const inStranger = fileIn(resources, join(run.sandbox.root, "stranger"), "note.txt", "x\n")
        // The person's own settings: a folder and a rule of theirs. (Rules in the project's
        // settings raise Claude Code's own check of the folder first, as ever.)
        merge(join(run.sandbox.home, ".claude", "settings.json"), (settings) => {
          const permissions = (settings.permissions ?? {}) as Record<string, unknown>
          const allow = (permissions.allow ?? []) as string[]
          settings.permissions = {
            ...permissions,
            allow: [...allow, "Bash(echo novadeck-rule:*)"],
            additionalDirectories: [theirs],
          }
        })
        const read = (file: string) => () => ({
          calls: [{ name: "Read", input: { file_path: file } }],
        })
        run.model.use(
          answers("Read the worktree's note", read(inWorktrees)),
          answers("Read their note", read(inTheirs)),
          answers("Read the stranger's note", read(inStranger)),
          answers("Run their rule", () => ({
            calls: [{ name: "Bash", input: { command: "echo novadeck-rule ran" } }],
          })),
          own((call) => {
            const said = result(call)
            return said === undefined ? undefined : { text: `Got: ${said.slice(0, 200)}` }
          }),
        )
        const t = await start(run, setup)
        await turn(t, "Read the worktree's note", "worktrees-words")
        await turn(t, "Read their note", "their-words")
        await turn(t, "Run their rule", "novadeck-rule ran")
        expect((await t.detail()).requests).toEqual([])
        // A folder of none of them asks, as the reads above would have without theirs.
        await t.submit("Read the stranger's note")
        await t.poll(
          async () => ((await t.detail()).requests.length > 0 ? true : undefined),
          "a permission request for the stranger's note",
          60_000,
        )
      })
  })
}
