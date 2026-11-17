// PROBE, not a test of Novadeck: what Claude Code shows where Novadeck's shim gives it the
// folder agents' worktrees live in, on a fresh start and on a resume after the runner restarts, as
// an app restart does, and what Novadeck's summary makes of that screen. Claude Code 2.1.326 asks
// "Adding a new directory … Is this a directory you created or one you trust?" of a folder given
// by `--add-dir` that it hasn't trusted, at every start, its default "No, exit"; 2.1.325 asked
// nothing, and a folder in the settings it is passed asks nothing on either (2026-11-17). The
// folder is the runner's own home's (`worktreesRoot()`, which the shims are written with), made
// where it isn't and taken away after. Runs only with NOVADECK_E2E_PROBES=1, by path, once per
// version (NOVADECK_E2E_HARNESS); writes $PROBE_OUT/claude-add-dir-*.json: every distinct
// screen and summary of each phase, and the command lines of its Claude Code processes.
/* eslint-disable no-await-in-loop -- Samples run in order. */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { worktreesRoot } from "../../worktrees/root.js"
import { setups } from "../agents/index.js"
import type { DeckTerminal } from "../deck.js"
import { describe, e2e, supported } from "../fixture.js"
import { replies, start, turn } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")
const setup = setups.find((each) => each.agent === "claude")!

/** Every distinct screen for `ms`, with the terminal's summary beside it. */
const sample = async (t: DeckTerminal, ms: number) => {
  const seen: unknown[] = []
  let last = ""
  const until = Date.now() + ms
  while (Date.now() < until) {
    const screen = await t.screenText()
    const summary = t.summary()
    const key = JSON.stringify([screen?.rows, summary.agent, summary.startup])
    if (screen && key !== last) {
      last = key
      seen.push({
        at: ms - (until - Date.now()),
        screen: screenRecord(screen),
        summary: { agent: summary.agent, activity: summary.activity, startup: summary.startup },
      })
    }
    await sleep(250)
  }
  return seen
}

/** The worktrees' folder, made where it isn't, and taken away after where made and empty. */
const madeFolder = (resources: { readonly defer: (cleanup: () => void) => void }): string => {
  const root = worktreesRoot()
  if (existsSync(root)) return root
  mkdirSync(root, { recursive: true })
  resources.defer(() => {
    if (existsSync(root) && readdirSync(root).length === 0) rmSync(root, { recursive: true })
  })
  return root
}

/** The command lines of Claude Code's processes naming `root` (this run's), as `ps` shows them. */
const claudes = (root: string): string[] =>
  process.platform === "win32"
    ? []
    : execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
        .split("\n")
        .filter(
          (line) => line.includes(root) && /\bclaude\b/.test(line) && !line.includes("ps -eo"),
        )
        .slice(0, 6)

describe.skipIf(!supported || !probing || !setup)("probe: Claude Code's --add-dir", () => {
  // Opened where the folder exists, sampled without waiting for its prompt: what Novadeck makes
  // of the screen it may stop at.
  e2e(setup)("says what of a start that stops at it", async ({ e2e: run, resources }) => {
    const root = madeFolder(resources)
    run.model.use(() => ({ text: "Noted." }))
    const t = await run.deck.open(setup.agent)
    const opened = await sample(t, 25_000)
    const detail = await t.detail().catch((error: unknown) => String(error))
    const version = /Claude Code v(\d+\.\d+\.\d+)/.exec(JSON.stringify(opened))?.[1] ?? "unknown"
    mkdirSync(outDir, { recursive: true })
    writeFileSync(
      join(outDir, `claude-add-dir-opened-${version}.json`),
      JSON.stringify({ version, root, opened, detail, history: t.history() }, null, 2),
    )
  })

  // The folder the shim passes, where agents' worktrees live: made before the start, or only
  // after it, before the restart, as when the first worktree comes once the session runs.
  for (const made of ["before", "after"] as const)
    e2e(setup)(
      `asks of the worktrees folder made ${made} its start, or not`,
      async ({ e2e: run, resources }) => {
        const root = worktreesRoot()
        if (made === "before") madeFolder(resources)
        run.model.use(replies("Warm up", "Warmed up."), () => ({ text: "Noted." }))
        const t = await start(run, setup)
        const fresh = await sample(t, 3_000)
        const freshArgs = claudes(run.sandbox.root)
        await turn(t, "Warm up", "Warmed up.")
        const version = /Claude Code v(\d+\.\d+\.\d+)/.exec(await t.screen())?.[1] ?? "unknown"
        if (made === "after") madeFolder(resources)
        await run.deck.restart()
        const resumed = await run.deck.restore(t, { resume: setup.agent })
        const resume = await sample(resumed, 15_000)
        const resumeArgs = claudes(run.sandbox.root)
        mkdirSync(outDir, { recursive: true })
        writeFileSync(
          join(outDir, `claude-add-dir-${made}-${version}.json`),
          JSON.stringify({ version, root, freshArgs, resumeArgs, fresh, resume }, null, 2),
        )
      },
    )
})
