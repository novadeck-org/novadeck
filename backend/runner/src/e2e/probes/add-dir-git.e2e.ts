// PROBE, not a test of Novadeck: whether Claude Code asks before read-only git commands in an
// agent's worktree, given the worktrees' folder by `--add-dir` (the person taking 2.1.326's
// "Adding a new directory" question), by `permissions.additionalDirectories` in the settings it is
// passed, or by both. Its 2.1.326 changelog: read-only git commands ask first in a repository that
// isn't the project's or one trusted, and only `--add-dir` names one. Each lane runs, with no rule
// allowing git: `git status` and `git -C <project> status` as baselines; `git -C <worktree of the
// project's repo> status`; `cd <that worktree> && git status`; `git -C <worktree of another repo>
// status`. A request that comes is denied, and counted. Run it outside /tmp (TMPDIR), as an empty
// /tmp/.git reads as a repository to Claude Code. Found 2026-11-17, on 2.1.325 and 2.1.326 alike,
// settings and --add-dir alike: only the plain `git status` runs unasked; every `git -C` asks, the
// project's own included, and so does `cd … && git`. Giving both still raises the question on
// 2.1.326. Runs only with NOVADECK_E2E_PROBES=1, by path; writes
// $PROBE_OUT/claude-add-dir-git-<lane>-<pinned|latest>.json.
/* eslint-disable no-await-in-loop -- Steps run in order. */
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked } from "../model/script.js"
import { own, result } from "../scenarios.js"
import { probing } from "./support.js"

const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")
const setup = setups.find((each) => each.agent === "claude")!

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

/** A repository at `dir` with one commit. */
const repo = (dir: string) => {
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "probe@example.invalid")
  git(dir, "config", "user.name", "Probe")
  writeFileSync(join(dir, "a.txt"), "a\n")
  git(dir, "add", "a.txt")
  git(dir, "commit", "-q", "-m", "first")
}

describe.skipIf(!supported || !probing || !setup)("probe: Claude Code's git in worktrees", () => {
  for (const lane of ["settings", "add-dir", "both"] as const)
    e2e(setup)(
      `asks or not, the folder given by ${lane}`,
      async ({ e2e: run }) => {
        const folder = join(run.sandbox.root, "worktrees")
        repo(run.sandbox.project)
        const other = join(run.sandbox.root, "other")
        repo(other)
        const projectWorktree = join(folder, "project", "a")
        const theirs = join(folder, "other", "c")
        mkdirSync(join(folder, "project"), { recursive: true })
        mkdirSync(join(folder, "other"), { recursive: true })
        git(run.sandbox.project, "worktree", "add", "-q", "-b", "a", projectWorktree)
        git(other, "worktree", "add", "-q", "-b", "c", theirs)
        writeFileSync(join(projectWorktree, "a.txt"), "changed\n")
        const steps = {
          "p-status": "git status --short",
          "p-c-status": `git -C ${run.sandbox.project} status --short`,
          "a-status": `git -C ${projectWorktree} status --short`,
          "b-cd-status": `cd ${projectWorktree} && git status --short`,
          "c-other-status": `git -C ${theirs} status --short`,
        } as const
        run.model.use(
          own((call) => {
            for (const [name, command] of Object.entries(steps))
              if (asked(call, `Run ${name}`))
                return { calls: [{ name: "Bash", input: { command, description: name } }] }
            if (result(call) === undefined) return undefined
            const last = call.turns.findLast((turn) => turn.role === "user")?.text ?? ""
            const name = /Run ([\w-]+)/.exec(last)?.[1] ?? "it"
            return { text: `Ran ${name}.` }
          }),
          () => ({ text: "Noted." }),
        )
        const settings = JSON.stringify({ permissions: { additionalDirectories: [folder] } })
        const flags = {
          settings: `--settings '${settings}'`,
          "add-dir": `--add-dir=${folder}`,
          both: `--add-dir=${folder} --settings '${settings}'`,
        }[lane]
        const t = await run.deck.open(`claude ${flags}`)
        // The question 2.1.326 asks of --add-dir: taken, as the person would.
        let prompted = false
        if (lane !== "settings") {
          prompted = await t
            .until(/Adding a new directory/, 20_000)
            .then(() => true)
            .catch(() => false)
          if (prompted)
            await t.confirm(
              /❯ Yes, add it/,
              async () => {
                await sleep(500)
                t.press("\x1b[B")
              },
              { timeoutMs: 20_000 },
            )
        }
        await t.reached("ready", { timeoutMs: 60_000 })
        const version = process.env.NOVADECK_E2E_HARNESS === "latest" ? "latest" : "pinned"
        const outcome: Record<string, string> = {}
        for (const name of Object.keys(steps)) {
          await t.submit(`Run ${name}`)
          let asks = false
          for (let at = 0; at < 60; at += 1) {
            if ((await t.detail()).requests.length > 0) {
              asks = true
              t.press("\x1b")
              break
            }
            if ((await t.screen()).includes(`Ran ${name}.`)) break
            await sleep(250)
          }
          await t.until(`Ran ${name}.`, 30_000).catch(() => undefined)
          outcome[name] = asks ? "asks" : "runs"
          await sleep(500)
        }
        mkdirSync(outDir, { recursive: true })
        writeFileSync(
          join(outDir, `claude-add-dir-git-${lane}-${version}.json`),
          JSON.stringify({ version, lane, prompted, outcome }, null, 2),
        )
      },
      600_000,
    )
})
