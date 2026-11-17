import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { worktreesRoot } from "../worktrees/root.js"
import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported, type E2E } from "./fixture.js"
import { answers, own, result } from "./scenarios.js"

// Codex's shim gives a session the folder where agents' worktrees live, once it exists (on the
// rig, the sandbox's own: the deck gives its runner `worktreesRoot` of the sandbox's home), as
// its writable roots: not as --add-dir, which Codex 0.163.0 and later exit at under a read-only
// sandbox, its default in a folder not yet trusted (e2e/probes/codex-roots.e2e.ts). The test
// makes the folder; it goes with the sandbox.

/** The worktrees' folder the rig's runner gives its agents, made for the test. */
const worktreesFolder = (run: E2E): string => {
  const root = worktreesRoot(run.sandbox.home)
  mkdirSync(root, { recursive: true })
  return root
}

/** Puts `lines` at the top of the sandbox's Codex config, and `table` at its end. */
const configure = (home: string, lines: string, table = ""): void => {
  const config = join(home, "config.toml")
  writeFileSync(config, `${lines}\n${readFileSync(config, "utf8")}\n${table}`)
}

const setup = setups.find((each) => each.agent === "codex")!

describe.skipIf(!supported)("Codex with the worktrees' folder there", () => {
  const it = e2e(setup)

  it("starts under a read-only sandbox, where --add-dir would end it", async ({ e2e: run }) => {
    worktreesFolder(run)
    configure(run.sandbox.env.CODEX_HOME!, 'sandbox_mode = "read-only"')
    const t = await run.deck.open("codex")
    await t.reached("ready", { timeoutMs: 60_000 })
    expect(await t.screen()).not.toContain("Ignoring --add-dir")
  })

  // Seeded with no folder trusted: its default sandbox there is read-only.
  e2e.seeded({ folderTrusted: false }, setup)(
    "stops at its own trust screen in a folder not yet trusted, not at an error",
    async ({ e2e: run }) => {
      worktreesFolder(run)
      const t = await run.deck.open("codex")
      await t.until(/trust/i, 60_000)
      expect(await t.screen()).not.toContain("Ignoring --add-dir")
    },
  )

  it("writes in the worktrees' folder under workspace-write, and nowhere it isn't given", async ({
    e2e: run,
  }) => {
    const root = worktreesFolder(run)
    const mine = join(root, `novadeck-e2e-${process.pid}-${Date.now()}`)
    mkdirSync(mine)
    const stranger = join(run.sandbox.root, "stranger")
    mkdirSync(stranger)
    // Never asking, and the sandbox's /tmp not writable whole, so a write it may not do fails.
    configure(
      run.sandbox.env.CODEX_HOME!,
      'sandbox_mode = "workspace-write"\napproval_policy = "never"',
      "[sandbox_workspace_write]\nexclude_slash_tmp = true\nexclude_tmpdir_env_var = true\n",
    )
    run.model.use(
      answers("Write them", () => ({
        calls: [
          {
            name: "exec_command",
            input: {
              // Redirection, as sh and PowerShell (Codex's shell on Windows) both write it.
              cmd: `echo a > "${join(mine, "a")}"; echo a > "${join(stranger, "a")}"; echo wrote`,
              yield_time_ms: 2000,
            },
          },
        ],
      })),
      own((call) => (result(call) !== undefined ? { text: "Done writing." } : undefined)),
    )
    const t = await run.deck.open("codex")
    await t.reached("ready", { timeoutMs: 60_000 })
    await t.submit("Write them")
    await t.until("Done writing.", 60_000)
    expect(existsSync(join(mine, "a"))).toBe(true)
    expect(existsSync(join(stranger, "a"))).toBe(false)
  })
})
