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
  /** Written over the user's settings.json `permissions` (the sandbox's own allows replaced). */
  user?: Permissions
  /** A project settings file to write (relative to the project folder) and its `permissions`. */
  project?: { file: string; permissions: Permissions }
  /** Top-level keys merged into the user's settings.json. */
  extraUser?: object
  /** Files to write under the sandbox's home (path relative to it) with their text. */
  homeFiles?: Record<string, string>
  /** Further project settings files, all written with the same `permissions`. */
  projectMore?: string[]
}

type Permissions = { allow?: string[]; deny?: string[]; ask?: string[] }

const grant = () => ({ permissions: { allow: ["command(touch)"] } })
const ans = (decision: string) => () => ({ decision })
// ---- round 5 (M): do `--settings`' permissions merge with the person's, or replace them?
// Novadeck's hooks are off (alone, no PreToolUse), so only the settings layers decide.
// Results (2026-11-01, Antigravity 1.4.12, Linux; `touch` is the command; user = the sandbox's
// ~/.gemini/antigravity-cli/settings.json):
// - Within one layer deny beats allow (m16) and allow beats ask (m15); ask+deny denies (m17).
// - `--settings` replaces the user's `permissions.allow` array when it names one: the user's
//   `command(touch)` and the sandbox's `mcp(novadeck_novadeck/*)` allow are gone (m4, m10).
// - It does not touch an array it doesn't name: the user's deny still denies (m5), and
//   --settings' allow does not beat it (m7, m24). A `deny` array it does name replaces the
//   user's (m18). Its own deny beats the user's allow (m9). A user's ask is beaten by a
//   --settings allow of the same command (m8, m19) as by a same-layer one.
// - No project settings file is read: `.agents/settings.json`, `.agents/settings.local.json`,
//   `.gemini/antigravity-cli/settings.json` and seven other names changed nothing (m11-m14, m22).
//   "Persist to settings.json" writes the user's file (m21).
// - What a `command(...)` rule matches (n-cases): the literal words a command starts with,
//   case-sensitive; `command(*)` alone matches everything; `touch *`, `*ran.txt*`, `t*ch`, `tou?h`,
//   `*ouch` and an empty rule match nothing (n1-n7). Double spaces and tabs are seen through
//   (n8, n9); `/usr/bin/touch` is not matched by `command(touch)` (n10). It finds the command
//   after `env FOO=1`, `FOO=1`, `&&`, `;`, `if ...; then`, a subshell, `time` and `nohup`
//   (n11-n16, n18, n19) but not after `xargs`, `command`, `sudo -n`, or in quotes (n17, n21-n23).
//   A rule `command(TOUCH)` does not match `touch` (n20).
// - Other places for the person's rules: `excludeTools`, `tools.exclude`, `coreTools` in the
//   user's settings, `~/.gemini/settings.json`, `~/.gemini/config/settings.json` and a Gemini CLI
//   policy TOML did not change the decision (s1-s6). No system or admin file was tried (it
//   needs root), and the binary's strings name none.
// - A PreToolUse `force_ask` puts the dialog over the user's deny (m23: click-through); `ask`
//   leaves it denied (m25); `deny_unless_prior_grant` plus a --settings allow stays denied (m24)
//   and runs over a user ask (m26).
const layered = (name: string, c: Omit<Case, "name">): Case => ({
  name,
  alone: true,
  noPre: true,
  ...c,
})
const touch = (rule: "allow" | "deny" | "ask"): Permissions => ({ [rule]: ["command(touch)"] })
const git = () => ({ permissions: { allow: ["command(git)"] } })
const denyTouch = (...rules: string[]): Permissions => ({ deny: rules })
const touchAs = (shape: (marker: string) => string) => ({ cmd: (marker: string) => shape(marker) })
const mCases: Case[] = [
  // ---- round 6 (G): what a `command(...)` deny rule matches
  layered("n1-glob-star-all", { user: denyTouch("command(*)") }),
  layered("n2-glob-star-args", { user: denyTouch("command(touch *)") }),
  layered("n3-glob-star-both-ends", { user: denyTouch("command(*ran.txt*)") }),
  layered("n4-glob-inside-word", { user: denyTouch("command(t*ch)") }),
  layered("n5-glob-question", { user: denyTouch("command(tou?h)") }),
  layered("n6-glob-leading-star-word", { user: denyTouch("command(*ouch)") }),
  layered("n7-empty-rule", { user: denyTouch("command()") }),
  // the forms a plain `command(touch)` deny may or may not see
  layered("n8-double-space", {
    user: denyTouch("command(touch)"),
    ...touchAs((m) => `touch  ${m}`),
  }),
  layered("n9-tab", { user: denyTouch("command(touch)"), ...touchAs((m) => `touch\t${m}`) }),
  layered("n10-abs-path", {
    user: denyTouch("command(touch)"),
    ...touchAs((m) => `/usr/bin/touch ${m}`),
  }),
  layered("n11-env-prefix", {
    user: denyTouch("command(touch)"),
    ...touchAs((m) => `env FOO=1 touch ${m}`),
  }),
  layered("n12-assignment-prefix", {
    user: denyTouch("command(touch)"),
    ...touchAs((m) => `FOO=1 touch ${m}`),
  }),
  layered("n13-after-and", {
    user: denyTouch("command(touch)"),
    ...touchAs((m) => `true && touch ${m}`),
  }),
  layered("n14-after-semicolon", {
    user: denyTouch("command(touch)"),
    ...touchAs((m) => `true; touch ${m}`),
  }),
  layered("n15-in-if", {
    user: denyTouch("command(touch)"),
    ...touchAs((m) => `if true; then touch ${m}; fi`),
  }),
  layered("n16-subshell", { user: denyTouch("command(touch)"), ...touchAs((m) => `(touch ${m})`) }),
  layered("n17-xargs", {
    user: denyTouch("command(touch)"),
    ...touchAs((m) => `echo ${m} | xargs touch`),
  }),
  layered("n18-time", { user: denyTouch("command(touch)"), ...touchAs((m) => `time touch ${m}`) }),
  layered("n19-nohup", {
    user: denyTouch("command(touch)"),
    ...touchAs((m) => `nohup touch ${m}`),
  }),
  layered("n20-uppercase-rule", { user: denyTouch("command(TOUCH)") }),
  layered("n21-command-builtin", {
    user: denyTouch("command(touch)"),
    ...touchAs((m) => `command touch ${m}`),
  }),
  layered("n22-sudo-n", {
    user: denyTouch("command(touch)"),
    ...touchAs((m) => `sudo -n touch ${m}`),
  }),
  layered("n23-quoted-program", {
    user: denyTouch("command(touch)"),
    ...touchAs((m) => `"touch" ${m}`),
  }),
  // ---- round 6 (S): other places the person's rules might live
  layered("s1-excludeTools", { extraUser: { excludeTools: ["run_command"] } }),
  layered("s2-tools-exclude", { extraUser: { tools: { exclude: ["run_command"] } } }),
  layered("s3-coreTools", { extraUser: { coreTools: ["read_file"] } }),
  layered("s4-gemini-settings-deny", {
    homeFiles: {
      ".gemini/settings.json": JSON.stringify({ permissions: { deny: ["command(touch)"] } }),
    },
  }),
  layered("s5-policy-toml", {
    homeFiles: {
      ".gemini/policies/x.toml":
        '[[rule]]\ntoolName = "run_command"\ncommandPrefix = ["touch"]\ndecision = "deny"\npriority = 900\n',
    },
  }),
  layered("s6-config-dir-settings", {
    homeFiles: {
      ".gemini/config/settings.json": JSON.stringify({ permissions: { deny: ["command(touch)"] } }),
    },
  }),
  layered("m0-none", {}),
  layered("m1-user-allow", { user: touch("allow") }),
  layered("m2-user-deny", { user: touch("deny") }),
  layered("m3-user-ask", { user: touch("ask") }),
  // allow: the user's touch allow with a --settings that allows only git
  layered("m4-user-allow-settings-git", { user: touch("allow"), settings: git }),
  // deny: does the user's deny survive a --settings that has none?
  layered("m5-user-deny-settings-git", { user: touch("deny"), settings: git }),
  // ask: likewise for the user's ask
  layered("m6-user-ask-settings-git", { user: touch("ask"), settings: git }),
  // conflicts: the same command denied (asked) by the user and allowed by --settings
  layered("m7-user-deny-settings-allow", { user: touch("deny"), settings: grant }),
  layered("m8-user-ask-settings-allow", { user: touch("ask"), settings: grant }),
  // and --settings' own deny against the user's allow
  layered("m9-user-allow-settings-deny", {
    user: touch("allow"),
    settings: () => ({ permissions: { deny: ["command(touch)"] } }),
  }),
  // the user's MCP allow (the e2e sandbox's own) with a --settings of commands only
  layered("m10-sandbox-mcp-allow-kept-with-settings", { settings: git }),
  // project settings files agy might read
  layered("m11-project-agents-settings-deny", {
    project: { file: ".agents/settings.json", permissions: touch("deny") },
  }),
  layered("m12-project-agents-settings-local-deny", {
    project: { file: ".agents/settings.local.json", permissions: touch("deny") },
  }),
  layered("m13-project-gemini-settings-deny", {
    project: { file: ".gemini/antigravity-cli/settings.json", permissions: touch("deny") },
  }),
  // within one layer: which of allow, ask and deny wins
  layered("m15-user-allow+ask", {
    user: { allow: ["command(touch)"], ask: ["command(touch)"] },
  }),
  layered("m16-user-allow+deny", {
    user: { allow: ["command(touch)"], deny: ["command(touch)"] },
  }),
  layered("m17-user-ask+deny", {
    user: { ask: ["command(touch)"], deny: ["command(touch)"] },
  }),
  // does a --settings array replace the user's array of the same key, and leave the others?
  layered("m18-user-deny-settings-other-deny", {
    user: touch("deny"),
    settings: () => ({ permissions: { allow: ["command(git)"], deny: ["command(other)"] } }),
  }),
  layered("m19-user-ask-settings-other-ask", {
    user: touch("ask"),
    settings: () => ({ permissions: { allow: ["command(touch)"], ask: ["command(other)"] } }),
  }),
  layered("m20-user-allow-settings-other-allow-and-same-ask", {
    user: touch("allow"),
    settings: () => ({ permissions: { ask: ["command(other)"] } }),
  }),
  // every project settings file name that came to mind, at once: none denying means none is read
  layered("m22-project-candidates-deny", {
    project: { file: ".gemini/settings.json", permissions: touch("deny") },
    projectMore: [
      ".antigravity/settings.json",
      ".agy/settings.json",
      ".agents/config/settings.json",
      ".gemini/antigravity-cli/settings.local.json",
      "settings.json",
      ".agents/permissions.json",
    ],
  }),
  // the narrowing hook's answers against the person's deny
  layered("m23-user-deny-hook-force-ask", {
    noPre: false,
    user: touch("deny"),
    answer: ans("force_ask"),
    settings: git,
  }),
  layered("m24-user-deny-hook-run-settings-allow", {
    noPre: false,
    user: touch("deny"),
    answer: ans("deny_unless_prior_grant"),
    settings: grant,
  }),
  layered("m25-user-deny-hook-ask", {
    noPre: false,
    user: touch("deny"),
    answer: ans("ask"),
    settings: git,
  }),
  layered("m26-user-ask-hook-run-settings-allow", {
    noPre: false,
    user: touch("ask"),
    answer: ans("deny_unless_prior_grant"),
    settings: grant,
  }),
  // where "Persist to settings.json" writes
  layered("m21-persist-option-3", { press: "3" }),
  layered("m14-project-agents-settings-deny-settings-allow", {
    project: { file: ".agents/settings.json", permissions: touch("deny") },
    settings: grant,
  }),
]

const cases: Case[] = [
  ...mCases,
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
      if (c.user) {
        const file = join(run.sandbox.home, ".gemini", "antigravity-cli", "settings.json")
        const user = JSON.parse(readFileSync(file, "utf8")) as { permissions?: Permissions }
        user.permissions = { ...user.permissions, ...c.user }
        writeFileSync(file, JSON.stringify(user))
      }
      if (c.extraUser) {
        const file = join(run.sandbox.home, ".gemini", "antigravity-cli", "settings.json")
        writeFileSync(
          file,
          JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), ...c.extraUser }),
        )
      }
      for (const [relative, text] of Object.entries(c.homeFiles ?? {})) {
        const file = join(run.sandbox.home, relative)
        mkdirSync(join(file, ".."), { recursive: true })
        writeFileSync(file, text)
      }
      if (c.project) {
        const file = join(run.sandbox.project, c.project.file)
        mkdirSync(join(file, ".."), { recursive: true })
        writeFileSync(file, JSON.stringify({ permissions: c.project.permissions }))
        for (const more of c.projectMore ?? []) {
          mkdirSync(join(run.sandbox.project, more, ".."), { recursive: true })
          writeFileSync(
            join(run.sandbox.project, more),
            JSON.stringify({ permissions: c.project.permissions }),
          )
        }
      }
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
      let persisted: unknown
      if (dialog && c.press) {
        t.press(c.press)
        await sleep(3500)
        afterKey = await t.screen()
        ranAfterKeys = existsSync(marker)
        persisted = {
          user: readFileSync(
            join(run.sandbox.home, ".gemini", "antigravity-cli", "settings.json"),
            "utf8",
          ),
          newFiles: spawnSync(
            "find",
            [run.sandbox.root, "-newer", script, "-type", "f", "-not", "-path", "*/brain/*"],
            { encoding: "utf8" },
          )
            .stdout.split("\n")
            .filter((f) => /settings|config|rules|polic/i.test(f)),
        }
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
        user: c.user ?? null,
        project: c.project ?? null,
        dialogShown: dialog,
        ranBeforeKeys,
        ranAfterKeys,
        screen: screen.split("\n").filter((row) => row.trim() !== ""),
        persisted,
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
