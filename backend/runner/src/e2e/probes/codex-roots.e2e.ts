// PROBE, not a test of Novadeck: which folders a Codex session may write, given a folder by
// `--add-dir`, as Novadeck's shim gave the worktrees' folder, or by
// `-c sandbox_workspace_write.writable_roots=[…]`, beside a folder of the person's own in their
// config's `writable_roots`, and one of no one's; and whether it starts at all under a read-only
// sandbox, where 0.169.0 exits at `--add-dir` ("Ignoring --add-dir … because the effective
// permissions do not allow additional writable roots"). Runs only with NOVADECK_E2E_PROBES=1, by
// path; writes $PROBE_OUT/codex-roots-<version>.json.
/* eslint-disable no-await-in-loop -- Cases run in order. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { answers, own, result } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")
const setup = setups.find((each) => each.agent === "codex")!

describe.skipIf(!supported || !probing || !setup)("probe: Codex's writable roots", () => {
  for (const sandbox of ["workspace-write", "read-only"] as const)
    e2e(setup)(`writes where it may, ${sandbox}`, async ({ e2e: run }) => {
      const home = run.sandbox.env.CODEX_HOME!
      const folder = (name: string) => {
        const dir = join(run.sandbox.root, name)
        mkdirSync(dir, { recursive: true })
        return dir
      }
      const given = folder("given")
      const theirs = folder("theirs")
      const stranger = folder("stranger")
      // The person's own: their sandbox, never asking, and a writable root of theirs.
      const config = join(home, "config.toml")
      // Top-level keys first, its table last, so none of the rest falls into it. The sandbox
      // lies in /tmp, which its workspace-write sandbox otherwise lets it write whole.
      writeFileSync(
        config,
        `sandbox_mode = "${sandbox}"\napproval_policy = "never"\n${readFileSync(config, "utf8")}\n[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(theirs)}]\nexclude_slash_tmp = true\nexclude_tmpdir_env_var = true\n`,
      )
      // A profile of theirs with a root of its own, as `--profile x` layers it on their config.
      const profiled = folder("profiled")
      writeFileSync(
        join(home, "x.config.toml"),
        `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(profiled)}]\nexclude_slash_tmp = true\nexclude_tmpdir_env_var = true\n`,
      )
      const record: Record<string, unknown> = { sandbox }
      const roots = `-c 'sandbox_workspace_write.writable_roots=[${JSON.stringify(given)}]'`
      const flags = {
        "add-dir": `--add-dir=${given}`,
        config: roots,
        "profile+config": `--profile x ${roots}`,
        profile: "--profile x",
      } as const
      for (const how of Object.keys(flags) as (keyof typeof flags)[]) {
        const flag = flags[how]
        const tag = `${how}-${Date.now()}`
        const touch = (dir: string) => `touch ${join(dir, tag)}`
        run.model.use(
          answers("Write them", () => ({
            calls: [
              {
                name: "exec_command",
                input: {
                  cmd: `${touch(given)}; ${touch(theirs)}; ${touch(profiled)}; ${touch(stranger)}; echo touched`,
                  yield_time_ms: 2000,
                },
              },
            ],
          })),
          own((call) => (result(call) !== undefined ? { text: "Done writing." } : undefined)),
        )
        const t = await run.deck.open(`codex ${flag}`)
        let started = true
        try {
          await t.reached("ready", { timeoutMs: 30_000 })
        } catch {
          started = false
        }
        if (started) {
          await t.submit("Write them")
          await t.until("Done writing.", 60_000).catch(() => undefined)
          await sleep(500)
        }
        record[how] = {
          started,
          screen: started ? undefined : await t.screen(),
          wrote: {
            given: existsSync(join(given, tag)),
            theirs: existsSync(join(theirs, tag)),
            profiled: existsSync(join(profiled, tag)),
            stranger: existsSync(join(stranger, tag)),
          },
        }
        appendFileSync(join(run.sandbox.root, "probe.log"), `${how} done\n`)
      }
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, `codex-roots-${sandbox}.json`), JSON.stringify(record, null, 2))
    })
})
