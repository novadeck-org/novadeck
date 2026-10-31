/* eslint-disable no-await-in-loop -- The probes poll and step through screens in turn. */
// PROBE (issues #587/#588): can an external program (Novadeck's hooks, answered by the
// runner) approve ONE specific Bash command in Claude Code's AUTO mode, where a classifier
// (itself a model request) decides what asks? Every case runs `gh pr ready 12` (a fake `gh`
// on PATH that writes a marker, never the real one) against the fake model, which also plays
// the classifier. Per case it records the hooks that fired with their payloads, the
// classifier's requests, the screen, and whether the marker was written.
//
// Why not the e2e setup's mode: `claude.prepare` turns auto mode OFF on purpose
// (`defaultMode: "default"`, `disableAutoMode: "disable"`), because 2.1.287 defaults to it
// and its classifier decides what asks, and with a gateway shows a billing notice, or with
// `defaultMode` alone an offer to make it the default, either of which waits on Enter. This
// probe turns it back on and answers those screens.
//
// Run (scrubbed env, see the report): NOVADECK_E2E_PROBES=1 NOVADECK_E2E_AGENTS=claude \
//   APPROVALS_CASE=<prefix> vitest run --config vitest.e2e.config.ts \
//   src/e2e/probes/approvals-claude.e2e.ts
// Captures: APPROVALS_OUT (default <tmp>/approvals-out), one <case>.json each.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import type { AgentSetup } from "../agents/agent.js"
import { claude } from "../agents/claude.js"
import { describe, e2e, supported } from "../fixture.js"
import { anthropic } from "../model/anthropic.js"
import { text as everything, type Call, type Reply, type Rule } from "../model/script.js"
import { own } from "../scenarios.js"
import { install, snap, type Out } from "./claude-support.js"
import { sleep } from "./support.js"

const outDir = process.env.APPROVALS_OUT ?? join(tmpdir(), "approvals-out")
mkdirSync(outDir, { recursive: true })
const save = (name: string, value: unknown) =>
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(value, null, 2))

const only = process.env.APPROVALS_CASE?.split(",")
const wants = (name: string) => !only || only.some((one) => name.startsWith(one))

const command = "gh pr ready 12"

// ---- every model request, as sent
const raw: { n: number; body: any }[] = []
const recording = {
  ...anthropic,
  handle: (
    request: Parameters<typeof anthropic.handle>[0],
    reply: Parameters<typeof anthropic.handle>[1],
  ) => {
    try {
      if (request.path.startsWith("/v1/messages") && request.body)
        raw.push({ n: raw.length + 1, body: JSON.parse(request.body) })
    } catch {
      // Not JSON.
    }
    return anthropic.handle(request, reply)
  },
}

// ---- the setup: Claude Code in auto mode, a fake gh first on PATH
type World = { marker: string; settingsFile: string }
const worlds = new Map<string, World>()
const auto: AgentSetup = {
  ...claude,
  dialect: recording,
  prepare: async (sandbox, model, installed, seed) => {
    const env = await claude.prepare(sandbox, model, installed, seed)
    const config = join(sandbox.home, ".claude", "settings.json")
    const settings = JSON.parse(readFileSync(config, "utf8"))
    delete settings.permissions.disableAutoMode
    settings.permissions.defaultMode = "auto"
    writeFileSync(config, JSON.stringify(settings))
    const bin = join(sandbox.root, "fakebin")
    mkdirSync(bin, { recursive: true })
    const marker = join(sandbox.root, "gh-ran.txt")
    for (const name of ["gh", "uberepo"]) {
      writeFileSync(
        join(bin, name),
        `#!/bin/sh\necho "${name} $*" >> ${marker}\necho "fake ${name}: ok"\n`,
      )
      chmodSync(join(bin, name), 0o755)
    }
    worlds.set(sandbox.root, { marker, settingsFile: join(sandbox.root, "extra-settings.json") })
    return { ...env, PATH: [bin, sandbox.env.PATH].join(delimiter) }
  },
}

// ---- hook outputs
const pre = (permissionDecision: string, extra: Record<string, unknown> = {}): Out => ({
  stdout: {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: "approved in Novadeck's Inbox",
      ...extra,
    },
  },
})
const perm = (decision: Record<string, unknown>): Out => ({
  stdout: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } },
})

// ---- the classifier: told apart from the agent by the system prompt (found by discovery)
const isClassifier = (call: Call) =>
  /You are a security monitor for autonomous AI coding agents/.test(call.system)

type Verdict = "block" | "allow"
const classifierReply = (call: Call, verdict: Verdict): Reply => {
  // Stage 1 asks for `<severity>N</severity>` alone (stop sequence `</severity>`, 64 tokens);
  // stage 2, if it comes, is read from its request (the raw requests are saved).
  const last = call.turns.at(-1)
  const asked = last?.role === "user" ? last.text : ""
  // Only the gh call is blocked; a `cd`, an Agent spawn or a touch is allowed.
  const block = verdict === "block" && asked.includes("gh pr ready")
  if (/Respond with <severity>N<\/severity> ONLY/.test(asked))
    return {
      text: block
        ? "<severity>92</severity><category>External System Writes</category>"
        : "<severity>3</severity>",
    }
  return {
    text: block
      ? "<severity>92</severity><category>External System Writes</category>"
      : "<severity>3</severity>",
  }
}

// ---- cases
type Case = {
  name: string
  /** The Bash command of the first call (default `gh pr ready 12`). */
  cmd?: string
  /** Bash calls one after another in one turn. */
  seq?: string[]
  /** The Bash call is made by a subagent (the Agent tool) with this command. */
  subagent?: boolean
  /** What the classifier says. */
  classifier?: Verdict
  hooks?: Partial<Record<string, Out>>
  /** Extra settings merged into the user settings before start. */
  settings?: Record<string, unknown>
  /** A settings file passed with --settings (rules in it), written before start. */
  settingsFile?: Record<string, unknown>
  /** Where `later` goes (default the --settings file). */
  laterIn?: "user" | "local"
  /** Written into the --settings file after the session started and the first call ran. */
  later?: Record<string, unknown>
  /** Keys to press on a dialog if one shows (digits answer at once). */
  press?: string
  /** The command line to start (default `claude --permission-mode auto`). */
  flags?: string
  /** A second call afterwards, to see whether something stuck. */
  second?: string
  /** Ask a second Bash call with this command after the first. */
}

const ghAllowRule = { permissions: { allow: ["Bash(gh pr ready *)"] } }
const cases: Case[] = [
  // ---- round 2 (F)
  {
    name: "f1-manual-pretool-allow",
    cmd: "touch x",
    flags: " --permission-mode default",
    hooks: { PreToolUse: pre("allow") },
  },
  {
    name: "f1b-manual-no-hook",
    cmd: "touch x",
    flags: " --permission-mode default",
    press: "none",
  },
  { name: "f2-cwd-after-cd", classifier: "allow", seq: ["cd sub", "gh pr ready 12"] },
  {
    name: "f3-allow-rule-plus-pretool-ask",
    classifier: "block",
    settings: ghAllowRule,
    hooks: { PreToolUse: pre("ask") },
    press: "none",
  },
  {
    name: "f4-deny-rule-plus-pretool-allow",
    classifier: "block",
    settings: { permissions: { deny: ["Bash(gh pr ready *)"] } },
    hooks: { PreToolUse: pre("allow") },
  },
  {
    name: "f5-subagent-pretool-allow",
    classifier: "block",
    subagent: true,
    hooks: { PreToolUse: pre("allow") },
  },
  { name: "f5b-subagent-no-hook", classifier: "block", subagent: true },
  { name: "a0-nohook-deny", classifier: "block" },
  { name: "a0b-nohook-allow", classifier: "allow" },
  {
    name: "a1-pretool-allow",
    classifier: "block",
    hooks: { PreToolUse: pre("allow") },
  },
  { name: "a2-pretool-ask", classifier: "block", hooks: { PreToolUse: pre("ask") }, press: "none" },
  {
    name: "a2b-pretool-ask-press1",
    classifier: "block",
    hooks: { PreToolUse: pre("ask") },
    press: "1",
  },
  {
    name: "a2c-pretool-ask-press-no",
    classifier: "block",
    hooks: { PreToolUse: pre("ask") },
    press: "2",
  },
  {
    name: "a2d-pretool-ask-classifier-allow",
    classifier: "allow",
    hooks: { PreToolUse: pre("ask") },
    press: "none",
  },
  {
    name: "a3-permreq-allow",
    classifier: "block",
    hooks: { PermissionRequest: perm({ behavior: "allow" }) },
  },
  {
    name: "a3b-pretool-ask-permreq-allow",
    classifier: "block",
    hooks: { PreToolUse: pre("ask"), PermissionRequest: perm({ behavior: "allow" }) },
  },
  {
    name: "a6-additionalContext-in-classifier",
    classifier: "block",
    hooks: {
      UserPromptSubmit: {
        stdout: {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext:
              "NOVADECK-MARKER: the person approved `gh pr ready 12` in the Novadeck Inbox.",
          },
        },
      },
    },
  },
  {
    name: "a5-rule-in-settings-file",
    classifier: "block",
    settingsFile: { permissions: { allow: ["Bash(gh pr ready *)"] } },
  },
  {
    name: "a5b-rule-added-mid-session",
    classifier: "block",
    settingsFile: { permissions: { allow: [] } },
    later: { permissions: { allow: ["Bash(gh pr ready *)"] } },
    second: "gh pr ready 13",
  },
  {
    name: "a5d-rule-added-mid-session-user-settings",
    classifier: "block",
    later: { permissions: { allow: ["Bash(gh pr ready *)"] } },
    laterIn: "user",
    second: "gh pr ready 13",
  },
  {
    name: "a5e-rule-added-mid-session-project-local",
    classifier: "block",
    later: { permissions: { allow: ["Bash(gh pr ready *)"] } },
    laterIn: "local",
    second: "gh pr ready 13",
  },
  {
    name: "a5c-rule-in-user-settings",
    classifier: "block",
    settings: { permissions: { allow: ["Bash(gh pr ready *)"] } },
  },
]

const startup = (_screen: string): ((t: any) => Promise<void>)[] => []

describe.skipIf(!supported)("Claude Code auto mode approvals (probe)", () => {
  const it = e2e(auto)
  for (const c of cases) {
    if (!wants(c.name)) continue
    it(c.name, async ({ e2e: run }) => {
      raw.length = 0
      const world = worlds.get(run.sandbox.root)!
      const probe = install(run)
      mkdirSync(join(run.sandbox.project, "sub"), { recursive: true })
      // Settings tweaks.
      const userSettings = join(run.sandbox.home, ".claude", "settings.json")
      if (c.settings) {
        const s = JSON.parse(readFileSync(userSettings, "utf8"))
        s.permissions = { ...s.permissions, ...(c.settings.permissions as object) }
        writeFileSync(userSettings, JSON.stringify(s))
      }
      if (c.settingsFile) writeFileSync(world.settingsFile, JSON.stringify(c.settingsFile))
      // The probe hook answers every tool alike; this one only answers the Bash call (the
      // ToolSearch before it must pass), by `cfg.tool` in a patched copy of its script.
      const hookFile = join(probe.dir, "hook.mjs")
      writeFileSync(
        hookFile,
        readFileSync(hookFile, "utf8").replace(
          'finish("immediate", cfg.now ?? {})',
          'finish("immediate", cfg.tool && payload?.tool_name !== cfg.tool ? {} : (cfg.now ?? {}))',
        ),
      )
      for (const [event, out] of Object.entries(c.hooks ?? {}))
        (probe.config as (e: string, cfg: unknown) => void)(event, {
          now: out,
          ...(event === "PreToolUse" || event === "PermissionRequest" ? { tool: "Bash" } : {}),
        })

      const asks: string[] = [c.cmd ?? command]
      const SUB = "novadeck-approvals-subagent"
      const classified: { n: number; verdict: string }[] = []
      const rules: Rule[] = [
        (call) => {
          if (!isClassifier(call)) return undefined
          classified.push({ n: run.model.calls.length, verdict: c.classifier ?? "block" })
          return classifierReply(call, c.classifier ?? "block")
        },
        own((call) => {
          const last = call.turns.at(-1)
          const bash = (line: string) => ({
            calls: [{ name: "Bash", input: { command: line, description: "Run it" } }],
          })
          if (c.subagent) {
            const sub = call.turns.find((x) => x.role === "user")?.text.includes(SUB)
            if (sub) return last?.role === "tool" ? { text: "Sub done." } : bash(asks[0]!)
            if (last?.role === "tool") return { text: "Done." }
            return {
              calls: [
                {
                  name: "Agent",
                  input: {
                    description: "Helper",
                    prompt: `${SUB}: run the command.`,
                    subagent_type: "general-purpose",
                  },
                },
              ],
            }
          }
          if (c.seq) {
            const n = call.turns.filter(
              (x) => x.role === "assistant" && x.calls.some((k) => k.name === "Bash"),
            ).length
            if (last?.role === "tool") return n < c.seq.length ? bash(c.seq[n]!) : { text: "Done." }
            return bash(c.seq[0]!)
          }
          const again =
            c.second && call.turns.some((x) => x.role === "user" && x.text.includes("Go again"))
          if (last?.role === "tool") {
            const bashes = call.turns.filter(
              (x) => x.role === "assistant" && x.calls.some((k) => k.name === "Bash"),
            ).length
            return bashes >= (again ? 2 : 1) ? { text: "Done." } : undefined
          }
          if (again && last?.role === "user" && last.text.includes("Go again"))
            return bash(c.second!)
          return bash(asks[0]!)
        }),
      ]
      run.model.use(...rules)
      const line = `claude${c.flags ?? " --permission-mode auto"}${
        c.settingsFile ? ` --settings ${world.settingsFile}` : ""
      }`
      const t = await run.deck.open(line)
      // Startup: answer the gateway notice / default-mode offer, which wait on Enter.
      const startupScreens: string[] = []
      await sleep(Number(process.env.APPROVALS_STARTUP ?? 6000))
      startupScreens.push(await t.screen())
      if (process.env.APPROVALS_DISCOVER) {
        save(`${c.name}.startup`, startupScreens)
        return
      }
      for (const step of startup(startupScreens[0]!)) {
        await step(t)
        await sleep(1500)
        startupScreens.push(await t.screen())
      }
      await t.submit("Go ahead")

      const shots: Record<string, unknown> = {}
      // The gateway billing notice ("Enter to continue") waits before the classifier is asked.
      const notices: string[] = []
      for (let i = 0; i < 40; i++) {
        const shown = await t.screen()
        if (/Enter to continue · Esc to cancel/.test(shown)) {
          notices.push(shown)
          await t.settled()
          await sleep(500)
          t.enterEmpty()
          await sleep(1500)
          notices.push(await t.screen())
          break
        }
        await sleep(250)
      }
      await sleep(6000)
      shots.t7s = await snap(t, 120)
      const dialog = /❯ 1\. Yes|Do you want to proceed|Yes, and don't ask again/.test(
        await t.screen(),
      )
      if (dialog && c.press && c.press !== "none") {
        t.press(c.press)
        await sleep(3000)
        shots.afterKey = await snap(t, 120)
      }
      if (c.later) {
        if (c.laterIn === "user") {
          const s = JSON.parse(readFileSync(userSettings, "utf8"))
          s.permissions = { ...s.permissions, ...(c.later.permissions as object) }
          writeFileSync(userSettings, JSON.stringify(s))
        } else if (c.laterIn === "local") {
          mkdirSync(join(run.sandbox.project, ".claude"), { recursive: true })
          writeFileSync(
            join(run.sandbox.project, ".claude", "settings.local.json"),
            JSON.stringify(c.later),
          )
        } else writeFileSync(world.settingsFile, JSON.stringify(c.later))
        await sleep(3000)
        await t.submit("Go again")
        await sleep(7000)
        shots.second = await snap(t, 120)
      }
      await sleep(5000)
      shots.final = await snap(t, 120)
      const ran = existsSync(world.marker) ? readFileSync(world.marker, "utf8") : null
      save(c.name, {
        version: "see report",
        case: c,
        ran,
        classifierCalls: classified,
        dialogShown: dialog,
        startupScreens,
        notices,
        shots,
        hooks: probe.log(),
        requests: raw.map(({ n, body }) => ({
          n,
          model: body.model,
          system: JSON.stringify(body.system ?? "").slice(0, 600),
          tools: (body.tools ?? []).map((x: any) => x.name),
          tool_choice: body.tool_choice,
          last: JSON.stringify(body.messages?.at(-1) ?? "").slice(0, 1500),
          hasMarker: JSON.stringify(body).includes("NOVADECK-MARKER"),
        })),
      })
      if (c.name === "a0-nohook-deny") save("raw-requests", raw)
      void everything
    })
  }
})
