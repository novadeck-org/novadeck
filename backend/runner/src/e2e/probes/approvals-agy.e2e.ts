/* eslint-disable no-await-in-loop -- The probes poll and step through screens in turn. */
// PROBE (issues #587/#588): can an external program (Novadeck's hooks, answered by the
// runner) approve ONE specific `run_command` in Antigravity under its default tool policy
// (`request-review`, which asks "Run this command?")? Per case: the PreToolUse answer used,
// the screen (the dialog's rows), the hooks that fired with their payloads, and whether the
// command ran (it `touch`es a marker file; nothing else is run).
//
// Run (scrubbed env, see the report): NOVADECK_E2E_PROBES=1 NOVADECK_E2E_AGENTS=agy \
//   APPROVALS_CASE=<prefix> vitest run --config vitest.e2e.config.ts \
//   src/e2e/probes/approvals-agy.e2e.ts
// Captures: APPROVALS_OUT (default <tmp>/approvals-out), one agy-<case>.json each.
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { agy } from "../agents/agy.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, type Call, type Reply, type Rule } from "../model/script.js"
import { own, prompted } from "../scenarios.js"
import { sleep } from "./support.js"

const outDir = process.env.APPROVALS_OUT ?? join(tmpdir(), "approvals-out")
mkdirSync(outDir, { recursive: true })
const save = (name: string, value: unknown) =>
  writeFileSync(join(outDir, `agy-${name}.json`), JSON.stringify(value, null, 2))

const only = process.env.APPROVALS_CASE?.split(",")
const wants = (name: string) => !only || only.some((one) => name.startsWith(one))

// Logs each hook's stdin; for PreToolUse prints the `answer` file (nothing if there is none).
const hook = (dir: string) => `#!/bin/sh
P=${dir}
ev="$1"
af="\${2:-answer}"
in=$(cat)
printf '{"t":%s,"event":"%s","in":%s}\\n' "$(date +%s.%N)" "$ev" "$in" >> "$P/hooks.jsonl"
if [ -f "$P/mode" ] && case "$ev" in PreToolUse) true;; *) false;; esac; then
  case "$(cat "$P/mode")" in
    none) exit 0;;
    oops) printf 'oops'; exit 0;;
    exit1) exit 1;;
    dug-exit1) printf '{"decision":"deny_unless_prior_grant"}'; exit 1;;
    sleep) sleep 30; exit 0;;
  esac
fi
if case "$ev" in PreToolUse*) true;; *) false;; esac && [ -f "$P/$af" ]; then cat "$P/$af"; else printf '{}'; fi
`

type Case = {
  name: string
  /** What PreToolUse prints; a function of the command so the grant can name it. */
  answer?: (command: string) => unknown
  /** Passed to `agy --settings` as a JSON file. */
  settings?: (command: string) => unknown
  /** Keys pressed once the dialog shows (after the capture). */
  press?: string
  /** A second PreToolUse handler's answer: "same" = a second entry in the same group,
   * "group" = a second named group in the same hooks.json, "file" = a second hooks.json
   * in the project's .agents folder. */
  answer2?: (command: string) => unknown
  second?: "same" | "group" | "file" | "plugin"
  /** Novadeck's own plugin hooks (it answers every PreToolUse "ask") are emptied. */
  alone?: boolean
  /** The root starts a subagent, which makes the run_command. */
  subagent?: boolean
  /** How the PreToolUse hook misbehaves (see the script), and its timeout in seconds. */
  mode?: "none" | "oops" | "exit1" | "dug-exit1" | "sleep"
  timeout?: number
  /** The command line the model runs (default `touch <marker>`). */
  cmd?: (marker: string, root: string) => string
  /** A working directory for the call (its Cwd arg), a folder other than the workspace. */
  cwd?: boolean
  /** No PreToolUse hook is registered at all (a baseline for the default dialog). */
  noPre?: boolean
}

const grant = () => ({ permissions: { allow: ["command(touch)"] } })
const ans = (decision: string) => () => ({ decision })
const cases: Case[] = [
  // ---- round 4 (J): a subagent's run_command
  {
    name: "j1-sub-grant-force-ask",
    alone: true,
    subagent: true,
    settings: grant,
    answer: ans("force_ask"),
    press: "\x0b",
  },
  {
    name: "j2-sub-grant-dug",
    alone: true,
    subagent: true,
    settings: grant,
    answer: ans("deny_unless_prior_grant"),
  },
  { name: "j3-sub-nogrant-ask", alone: true, subagent: true, answer: ans("ask"), press: "\x0b" },
  { name: "j4-sub-grant-ask", alone: true, subagent: true, settings: grant, answer: ans("ask") },
  // ---- round 3 (H): the hook misbehaves, Novadeck's plugin hook emptied
  { name: "h1-grant-silent", alone: true, settings: grant, mode: "none" },
  { name: "h2-grant-empty-object", alone: true, settings: grant, answer: () => ({}) },
  { name: "h3-grant-oops", alone: true, settings: grant, mode: "oops" },
  { name: "h4-grant-exit1", alone: true, settings: grant, mode: "exit1" },
  { name: "h5-grant-dug-exit1", alone: true, settings: grant, mode: "dug-exit1" },
  { name: "h6-grant-timeout", alone: true, settings: grant, mode: "sleep", timeout: 1 },
  { name: "h1b-nogrant-silent", alone: true, mode: "none" },
  { name: "h6b-nogrant-timeout", alone: true, mode: "sleep", timeout: 1 },
  // ---- round 2b: Novadeck's own plugin hook ("ask") is present in the cases above; these
  // empty it ("alone") or add a second project/plugin handler beside it.
  { name: "g1-alone-allow", alone: true, answer: ans("allow") },
  {
    name: "g1b-alone-allow-override",
    alone: true,
    answer: (c) => ({ decision: "allow", permissionOverrides: [`command(${c})`] }),
  },
  {
    name: "g2-alone-dug-grant",
    alone: true,
    answer: ans("deny_unless_prior_grant"),
    settings: grant,
  },
  { name: "g2b-alone-dug-no-grant", alone: true, answer: ans("deny_unless_prior_grant") },
  { name: "g3-alone-ask-grant", alone: true, answer: ans("ask"), settings: grant },
  { name: "g3b-alone-force-ask-grant", alone: true, answer: ans("force_ask"), settings: grant },
  { name: "g4-plugin-hook-with-project-allow", answer: ans("allow") },
  { name: "g4b-plugin-hook-with-project-allow-grant", answer: ans("allow"), settings: grant },
  {
    name: "g5a-plugin2-force-ask+project-ask",
    answer: ans("ask"),
    answer2: ans("force_ask"),
    second: "plugin",
    settings: grant,
  },
  {
    name: "g5b-plugin2-ask+project-force-ask",
    answer: ans("force_ask"),
    answer2: ans("ask"),
    second: "plugin",
    settings: grant,
  },
  {
    name: "g5c-plugin2-dug+project-force-ask",
    answer: ans("force_ask"),
    answer2: ans("deny_unless_prior_grant"),
    second: "plugin",
    settings: grant,
  },
  {
    name: "g5d-plugin2-force-ask+project-dug",
    answer: ans("deny_unless_prior_grant"),
    answer2: ans("force_ask"),
    second: "plugin",
    settings: grant,
  },
  // ---- round 2 (D): a program-wide launch grant, narrowed one call at a time
  { name: "d1-grant-dug", answer: ans("deny_unless_prior_grant"), settings: grant },
  { name: "d2-grant-force-ask", answer: ans("force_ask"), settings: grant, press: "1" },
  { name: "d3-grant-ask", answer: ans("ask"), settings: grant },
  { name: "d3b-grant-no-hook", noPre: true, settings: grant },
  {
    name: "d4a-same-force-ask+ask",
    answer: ans("force_ask"),
    answer2: ans("ask"),
    second: "same",
    settings: grant,
  },
  {
    name: "d4b-same-ask+force-ask",
    answer: ans("ask"),
    answer2: ans("force_ask"),
    second: "same",
    settings: grant,
  },
  {
    name: "d4c-same-force-ask+allow",
    answer: ans("force_ask"),
    answer2: ans("allow"),
    second: "same",
    settings: grant,
  },
  {
    name: "d4d-same-allow+force-ask",
    answer: ans("allow"),
    answer2: ans("force_ask"),
    second: "same",
    settings: grant,
  },
  {
    name: "d4e-group-force-ask+ask",
    answer: ans("force_ask"),
    answer2: ans("ask"),
    second: "group",
    settings: grant,
  },
  {
    name: "d4f-group-ask+force-ask",
    answer: ans("ask"),
    answer2: ans("force_ask"),
    second: "group",
    settings: grant,
  },
  {
    name: "d4g-file-force-ask+ask",
    answer: ans("force_ask"),
    answer2: ans("ask"),
    second: "file",
    settings: grant,
  },
  {
    name: "d4h-file-ask+force-ask",
    answer: ans("ask"),
    answer2: ans("force_ask"),
    second: "file",
    settings: grant,
  },
  {
    name: "d4i-same-dug+force-ask",
    answer: ans("deny_unless_prior_grant"),
    answer2: ans("force_ask"),
    second: "same",
    settings: grant,
  },
  {
    name: "d4j-same-force-ask+dug",
    answer: ans("force_ask"),
    answer2: ans("deny_unless_prior_grant"),
    second: "same",
    settings: grant,
  },
  {
    name: "d4k-same-dug+ask",
    answer: ans("deny_unless_prior_grant"),
    answer2: ans("ask"),
    second: "same",
    settings: grant,
  },
  {
    name: "d4l-file-dug+force-ask",
    answer: ans("deny_unless_prior_grant"),
    answer2: ans("force_ask"),
    second: "file",
    settings: grant,
  },
  {
    name: "d4m-file-force-ask+dug",
    answer: ans("force_ask"),
    answer2: ans("deny_unless_prior_grant"),
    second: "file",
    settings: grant,
  },
  {
    name: "d5-cwd-in-command",
    answer: ans("force_ask"),
    settings: grant,
    cmd: (_m, root) => `cd ${root}/elsewhere && touch ran-there.txt`,
  },
  {
    name: "d6a-other-program-grant-no-hook",
    noPre: true,
    settings: grant,
    cmd: (m) => `echo hi > ${m}`,
  },
  {
    name: "d6b-other-program-grant-dug",
    answer: ans("deny_unless_prior_grant"),
    settings: grant,
    cmd: (m) => `echo hi > ${m}`,
  },
  { name: "d6c-other-program-no-grant-no-hook", noPre: true, cmd: (m) => `echo hi > ${m}` },
  { name: "b0-no-pretooluse-hook", noPre: true },
  { name: "b0-nohook" }, // the hook prints {} (no decision)
  { name: "b0b-empty-answer", answer: () => ({}) },
  { name: "b1-allow", answer: () => ({ decision: "allow" }) },
  {
    name: "b1b-allow-override-exact",
    answer: (c) => ({ decision: "allow", permissionOverrides: [`command(${c})`] }),
  },
  {
    name: "b1c-allow-override-binary",
    answer: () => ({ decision: "allow", permissionOverrides: ["command(touch)"] }),
  },
  {
    name: "b1d-override-no-decision",
    answer: (c) => ({ permissionOverrides: [`command(${c})`] }),
  },
  { name: "b2-ask", answer: () => ({ decision: "ask" }), press: "1" },
  { name: "b2b-force-ask", answer: () => ({ decision: "force_ask" }), press: "1" },
  {
    name: "b2c-force-ask-with-override",
    answer: (c) => ({ decision: "force_ask", permissionOverrides: [`command(${c})`] }),
  },
  { name: "b3-deny-unless-prior-grant", answer: () => ({ decision: "deny_unless_prior_grant" }) },
  {
    name: "b3b-deny-unless-prior-grant-granted",
    answer: () => ({ decision: "deny_unless_prior_grant" }),
    settings: (c) => ({ permissions: { allow: [`command(${c})`] } }),
  },
  {
    name: "b3c-deny",
    answer: () => ({ decision: "deny", reason: "Blocked by the probe" }),
  },
  {
    name: "b4e-settings-grant-exact-no-hook",
    noPre: true,
    settings: (c) => ({ permissions: { allow: [`command(${c})`] } }),
  },
  {
    name: "b4f-settings-grant-binary-no-hook",
    noPre: true,
    settings: () => ({ permissions: { allow: ["command(touch)"] } }),
  },
  {
    name: "b4g-settings-grant-other-command-no-hook",
    noPre: true,
    settings: () => ({ permissions: { allow: ["command(touch /nonexistent/other)"] } }),
  },
  {
    name: "b4-settings-grant-exact",
    settings: (c) => ({ permissions: { allow: [`command(${c})`] } }),
  },
  {
    name: "b4b-settings-grant-binary",
    settings: () => ({ permissions: { allow: ["command(touch)"] } }),
  },
  {
    name: "b4c-settings-grant-with-ask-hook",
    answer: () => ({ decision: "ask" }),
    settings: (c) => ({ permissions: { allow: [`command(${c})`] } }),
  },
  {
    name: "b4d-settings-grant-with-force-ask-hook",
    answer: () => ({ decision: "force_ask" }),
    settings: (c) => ({ permissions: { allow: [`command(${c})`] } }),
  },
]

describe.skipIf(!supported)("Antigravity approvals (probe)", () => {
  const it = e2e(agy)
  for (const c of cases) {
    if (!wants(c.name)) continue
    it(c.name, async ({ e2e: run }) => {
      const dir = join(run.sandbox.root, "probe")
      mkdirSync(dir, { recursive: true })
      const script = join(dir, "hook.sh")
      writeFileSync(script, hook(dir))
      chmodSync(script, 0o755)
      const handler = (event: string, file = "answer") => ({
        type: "command",
        command: `${script} ${event} ${file}`,
        timeout: event === "PreToolUse" && c.timeout ? c.timeout : 30,
      })
      mkdirSync(join(run.sandbox.project, ".agents"), { recursive: true })
      writeFileSync(
        join(run.sandbox.project, ".agents", "hooks.json"),
        JSON.stringify({
          probe: {
            ...(c.noPre
              ? {}
              : {
                  PreToolUse: [
                    { matcher: "*", hooks: [handler("PreToolUse")] },
                    ...(c.second === "same"
                      ? [{ matcher: "*", hooks: [handler("PreToolUse2", "answer2")] }]
                      : []),
                  ],
                }),
            PostToolUse: [{ matcher: "*", hooks: [handler("PostToolUse")] }],
            Stop: [handler("Stop")],
          },
          ...(c.second === "group"
            ? {
                probe2: {
                  PreToolUse: [{ matcher: "*", hooks: [handler("PreToolUse2", "answer2")] }],
                },
              }
            : {}),
        }),
      )
      if (c.second === "file")
        writeFileSync(
          join(run.sandbox.project, ".agents", "hooks2.json"),
          JSON.stringify({
            probe2: { PreToolUse: [{ matcher: "*", hooks: [handler("PreToolUse2", "answer2")] }] },
          }),
        )
      // Novadeck's installed plugin carries its own PreToolUse hook, answering "ask".
      const pluginHooks = spawnSync(
        "find",
        [join(run.sandbox.home, ".gemini", "config", "plugins"), "-name", "hooks.json"],
        { encoding: "utf8" },
      )
        .stdout.split("\n")
        .filter(Boolean)
      const pluginBefore = pluginHooks.map((file) => readFileSync(file, "utf8"))
      for (const file of pluginHooks) {
        if (c.alone) writeFileSync(file, "{}")
        else if (c.second === "plugin") {
          const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
          json.probe2 = {
            PreToolUse: [{ matcher: "*", hooks: [handler("PreToolUse2", "answer2")] }],
          }
          writeFileSync(file, JSON.stringify(json))
        }
      }
      const marker = join(run.sandbox.root, "ran.txt")
      const command = c.cmd?.(marker, run.sandbox.root) ?? `touch ${marker}`
      const other = join(run.sandbox.root, "elsewhere")
      mkdirSync(other, { recursive: true })
      if (c.mode) writeFileSync(join(dir, "mode"), c.mode)
      if (c.answer2) writeFileSync(join(dir, "answer2"), JSON.stringify(c.answer2(command)))
      if (c.answer) writeFileSync(join(dir, "answer"), JSON.stringify(c.answer(command)))
      let flags = ""
      if (c.settings) {
        const file = join(run.sandbox.root, "grant.json")
        writeFileSync(file, JSON.stringify(c.settings(command)))
        flags = ` --settings ${file}`
      }
      const SUBMARK = "novadeck-approvals-sub"
      const runIt = {
        calls: [
          {
            name: "run_command",
            input: { CommandLine: command, WaitMsBeforeAsync: 5000, toolSummary: "Touch" },
          },
        ],
      }
      const subRules: Rule[] = [
        (call: Call): Reply | undefined => {
          if (call.side || !call.system.includes("<subagent_reminder>")) return undefined
          return call.turns.at(-1)?.role === "tool" ? { text: "Sub done." } : runIt
        },
        (call: Call): Reply | undefined => {
          if (call.side || call.system.includes("<subagent_reminder>")) return undefined
          if (asked(call, "Run it"))
            return {
              calls: [
                {
                  name: "invoke_subagent",
                  input: {
                    TypeName: "self",
                    Role: "Toucher",
                    Prompt: `${SUBMARK}: run the command.`,
                  },
                },
              ],
            }
          return undefined
        },
      ]
      if (c.subagent) run.model.use(...subRules)
      const rules: Rule[] = c.subagent
        ? []
        : [
            (call: Call): Reply | undefined =>
              !call.side && asked(call, "Run it")
                ? {
                    calls: [
                      {
                        name: "run_command",
                        input: {
                          CommandLine: command,
                          WaitMsBeforeAsync: 5000,
                          toolSummary: "Touch",
                        },
                      },
                    ],
                  }
                : undefined,
            own((call) => (call.turns.at(-1)?.role === "tool" ? { text: "Made it." } : undefined)),
          ]
      run.model.use(...rules)

      const t = await run.deck.open(`agy${flags}`)
      await t.reached("ready", { timeoutMs: 60_000 })
      await prompted(t, agy)
      await t.submit("Run it")
      await sleep(6000)
      const dialog = /Run this command\?|needs approval for/.test(await t.screen())
      const screen = await t.screen()
      const ranBeforeKeys = existsSync(marker)
      let afterKey: string | undefined
      let ranAfterKeys: boolean | undefined
      if (dialog && c.press) {
        t.press(c.press)
        await sleep(3500)
        afterKey = await t.screen()
        ranAfterKeys = existsSync(marker)
      }
      if (dialog && !c.press) {
        t.press("4")
        await sleep(2000)
      }
      const lines = existsSync(join(dir, "hooks.jsonl"))
        ? readFileSync(join(dir, "hooks.jsonl"), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const one = JSON.parse(line) as {
                t: number
                event: string
                in: Record<string, unknown>
              }
              const { transcriptPath: _t, artifactDirectoryPath: _a, ...kept } = one.in
              return { t: one.t, event: one.event, in: kept }
            })
        : []
      save(c.name, {
        case: c.name,
        answer: c.answer?.(command) ?? null,
        settings: c.settings?.(command) ?? null,
        dialogShown: dialog,
        ranBeforeKeys,
        ranAfterKeys,
        screen: screen.split("\n").filter((row) => row.trim() !== ""),
        afterKey: afterKey?.split("\n").filter((row) => row.trim() !== ""),
        hooks: lines,
        pluginHooksBefore: pluginBefore,
        toolNames: [...new Set(run.model.calls.flatMap((x) => x.tools))],
        subagentCalls: run.model.calls
          .filter((x) => x.system.includes("<subagent_reminder>"))
          .map((x) => ({ tools: x.tools, last: x.turns.at(-1)?.role })),
        alone: c.alone ?? false,
        mode: c.mode ?? null,
        hookTimeout: c.timeout ?? null,
        second: c.second ?? null,
        answer2: c.answer2?.(command) ?? null,
        runCommandDeclaration: JSON.stringify(
          run.model.calls
            .flatMap((x) => x.rawTools ?? [])
            .find((x) => JSON.stringify(x).includes('"run_command"')) ?? null,
        ).slice(0, 9000),
      })
    })
  }
})
