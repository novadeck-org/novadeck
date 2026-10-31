/* eslint-disable no-await-in-loop -- The probes poll and step through screens in turn. */
// PROBE (issues #587/#588), part C: Codex's default approval policy asks before an
// `exec_command` that needs to run outside its sandbox ("Would you like to run the
// following command?"). Can a hook approve ONE command, and can a PreToolUse hook see the
// command before the approval (Novadeck's plugin matches only the question tools today)?
// Registered hooks log their stdin; PreToolUse is registered with no matcher and with
// several (`exec_command`, `Bash`, `^exec_command$`), each logged under its own name.
// The command `touch`es a marker file, nothing else.
//
// Run (scrubbed env, see the report): NOVADECK_E2E_PROBES=1 NOVADECK_E2E_AGENTS=codex \
//   APPROVALS_CASE=<prefix> vitest run --config vitest.e2e.config.ts \
//   src/e2e/probes/approvals-codex.e2e.ts
// Captures: APPROVALS_OUT (default <tmp>/approvals-out), one codex-<case>.json each.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { codex } from "../agents/codex.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked } from "../model/script.js"
import { own, prompted } from "../scenarios.js"
import { sleep } from "./support.js"

const outDir = process.env.APPROVALS_OUT ?? join(tmpdir(), "approvals-out")
mkdirSync(outDir, { recursive: true })
const save = (name: string, value: unknown) =>
  writeFileSync(join(outDir, `codex-${name}.json`), JSON.stringify(value, null, 2))

const only = process.env.APPROVALS_CASE?.split(",")
const wants = (name: string) => !only || only.some((one) => name.startsWith(one))

// Logs every hook it runs; prints the `<event>.out` file's content if there is one.
const hookScript = `
import { appendFileSync, existsSync, readFileSync } from "node:fs"
const [dir, event] = process.argv.slice(2)
let input = ""
for await (const chunk of process.stdin) input += chunk
appendFileSync(dir + "/events.jsonl", JSON.stringify({ t: Date.now(), event, payload: JSON.parse(input) }) + "\\n")
const out = dir + "/" + event.split("[")[0] + ".out"
if (existsSync(out)) process.stdout.write(readFileSync(out, "utf8"))
`

type Case = {
  name: string
  /** What the PermissionRequest hook prints. */
  permission?: unknown
  /** What the PreToolUse hook prints (all matchers). */
  pre?: unknown
  press?: string
  /** The call's `workdir`, a folder other than the session's cwd. */
  workdir?: boolean
  /** A second, identical request in the same session; rules and config are compared. */
  again?: boolean
}

const permission = (behavior: string, extra: Record<string, unknown> = {}) => ({
  hookSpecificOutput: {
    hookEventName: "PermissionRequest",
    decision: { behavior, ...extra },
  },
})

const cases: Case[] = [
  { name: "i1-allow-then-again", permission: permission("allow"), again: true },
  { name: "i1b-nohook-yes-p-then-again", again: true, press: "p" },
  { name: "e1-workdir", workdir: true },
  { name: "e1b-workdir-allow", workdir: true, permission: permission("allow") },
  { name: "c0-nohook" },
  { name: "c1-permreq-allow", permission: permission("allow") },
  {
    name: "c1b-permreq-deny",
    permission: permission("deny", { message: "Not approved in Novadeck" }),
  },
  {
    name: "c2-pretool-allow",
    pre: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "approved in Novadeck's Inbox",
      },
    },
  },
  {
    name: "c2b-pretool-ask",
    pre: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "x",
      },
    },
  },
]

describe.skipIf(!supported)("Codex approvals (probe)", () => {
  const it = e2e(codex)
  for (const c of cases) {
    if (!wants(c.name)) continue
    it(c.name, async ({ e2e: run }) => {
      const dir = join(run.sandbox.root, "probe")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "hook.mjs"), hookScript)
      const handler = (name: string) => ({
        type: "command",
        command: `node ${join(dir, "hook.mjs")} ${dir} ${name}`,
        timeout: 60,
      })
      writeFileSync(
        join(run.sandbox.home, ".codex", "hooks.json"),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ hooks: [handler("UserPromptSubmit")] }],
            PreToolUse: [
              { hooks: [handler("PreToolUse")] },
              { matcher: "exec_command", hooks: [handler("PreToolUse[exec_command]")] },
              { matcher: "Bash", hooks: [handler("PreToolUse[Bash]")] },
              { matcher: "^exec_command$", hooks: [handler("PreToolUse[^exec_command$]")] },
              { matcher: "request_user_input", hooks: [handler("PreToolUse[request_user_input]")] },
            ],
            PermissionRequest: [{ hooks: [handler("PermissionRequest")] }],
            PostToolUse: [{ hooks: [handler("PostToolUse")] }],
            Stop: [{ hooks: [handler("Stop")] }],
          },
        }),
      )
      if (c.permission !== undefined)
        writeFileSync(join(dir, "PermissionRequest.out"), JSON.stringify(c.permission))
      if (c.pre !== undefined) writeFileSync(join(dir, "PreToolUse.out"), JSON.stringify(c.pre))
      mkdirSync(join(run.sandbox.root, "elsewhere"), { recursive: true })
      const marker = join(run.sandbox.root, "ran.txt")
      const command = `touch ${marker}`
      run.model.use(
        own((call) =>
          asked(call, "Run it")
            ? {
                calls: [
                  {
                    name: "exec_command",
                    input: {
                      cmd: command,
                      ...(c.workdir ? { workdir: join(run.sandbox.root, "elsewhere") } : {}),
                      sandbox_permissions: "require_escalated",
                      justification: "Touch a file outside the sandbox",
                    },
                  },
                ],
              }
            : call.turns.at(-1)?.role === "tool"
              ? { text: "Made it." }
              : undefined,
        ),
      )
      const t = await run.deck.open("codex --dangerously-bypass-hook-trust")
      await t.reached("ready", { timeoutMs: 60_000 })
      await prompted(t, codex)
      const home = join(run.sandbox.home, ".codex")
      const snapshot = () => {
        const out: Record<string, string> = {}
        for (const file of readdirSync(home, { recursive: true, encoding: "utf8" }))
          if (
            /(^|\/)(rules\/.*|config\.toml|.*\.rules)$/.test(file) &&
            existsSync(join(home, file)) &&
            !file.includes("sessions")
          )
            try {
              out[file] = readFileSync(join(home, file), "utf8")
            } catch {
              // A folder.
            }
        return out
      }
      const before = snapshot()
      await t.submit("Run it")
      await sleep(7000)
      const screen = await t.screen()
      const dialog = /Would you like to run the following command\?/.test(screen)
      const ranBeforeKeys = existsSync(marker)
      let second: string[] | undefined
      if (dialog && c.press) {
        t.press(c.press)
        await sleep(3000)
      } else if (dialog) {
        t.press("\x1b")
        await sleep(2500)
      }
      const afterFirst = snapshot()
      if (c.again) {
        await t.submit("Run it again")
        await sleep(7000)
        second = (await t.screen()).split("\n").filter((row) => row.trim() !== "")
        if (/Would you like to run/.test(second.join("\n"))) {
          t.press("\x1b")
          await sleep(2000)
        }
      }
      const log = existsSync(join(dir, "events.jsonl"))
        ? readFileSync(join(dir, "events.jsonl"), "utf8")
            .split("\n")
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as { t: number; event: string; payload: Record<string, unknown> },
            )
        : []
      save(c.name, {
        case: c,
        rulesBefore: before,
        rulesAfterFirst: afterFirst,
        rulesAfter: snapshot(),
        secondScreen: second,
        sessionCwd: run.sandbox.project,
        workdir: c.workdir ? join(run.sandbox.root, "elsewhere") : null,
        dialogShown: dialog,
        ranBeforeKeys,
        screen: screen.split("\n").filter((row) => row.trim() !== ""),
        hooks: log.map(({ t: at, event, payload }) => {
          return { at, event, payload }
        }),
      })
    })
  }
})
