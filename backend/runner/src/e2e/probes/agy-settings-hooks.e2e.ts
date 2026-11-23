// PROBE, not a regression test: which per-launch routes make Antigravity run a PreToolUse hook
// that neither its installed plugins nor its settings.json name, and what a folder added for it
// does to where the session works. Each case starts agy past Novadeck's shim with the case's
// words, has the model run a command that prints its working folder, and records whether the
// probe's hook ran (it logs its input and answers "ask", so the dialog shows and is answered
// "Yes"), where the command ran, the workspaces Antigravity told the model of, and the screen.
// Found on 1.5.13 (2026-11-23, Windows): `--settings` refuses `hooks` ("unknown setting"); a
// folder given with `--add-dir` whose `.agents/hooks.json` (or `.agents/plugins/<name>/`) holds
// the hook runs it; workspaces are ordered by path, case and all, and the first is the "Command
// Working Directory" a command without a `Cwd` runs in, so a folder that sorts before the
// project takes its place, and one whose drive letter is in lower case doesn't.
// Runs only with NOVADECK_E2E_PROBES=1, by path; with PROBE_OUT set it writes
// $PROBE_OUT/agy.<case>.settings-hooks.probe.json. PROBE_CASES picks cases by their slugs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { agy as plain } from "../agents/agy.js"
import { describe, e2e, expect, supported, type E2E } from "../fixture.js"
import { gemini } from "../model/gemini.js"
import { asked } from "../model/script.js"
import { own, prompted, result } from "../scenarios.js"

const out = process.env.PROBE_OUT

/** The bodies of the model requests, so what Antigravity tells the model can be read. */
const bodies: string[] = []
const agy = {
  ...plain,
  dialect: {
    ...gemini,
    handle: (
      request: Parameters<typeof gemini.handle>[0],
      reply: Parameters<typeof gemini.handle>[1],
    ) => {
      bodies.push(request.body ?? "")
      return gemini.handle(request, reply)
    },
  },
}

/** A hook that logs what it got to `<root>/probe-hook.log` and answers "ask". */
const probeHook = (run: E2E): { command: string; log: string } => {
  const root = run.sandbox.root
  const log = join(root, "probe-hook.log")
  const script = join(root, "probe-hook.mjs")
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs"
let input = ""
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(log)}, input.replace(/\\n/g, " ") + "\\n")
  process.stdout.write('{"decision":"ask"}')
})
`,
  )
  if (process.platform !== "win32") {
    const sh = join(root, "probe-hook.sh")
    writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, { mode: 0o755 })
    return { command: sh, log }
  }
  const cmd = join(root, "probe-hook.cmd")
  writeFileSync(cmd, `@"${process.execPath}" "${script}"\r\n`)
  return { command: cmd, log }
}

const hooks = (command: string) => ({
  probe: {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 20 }] }],
  },
})

/** A folder in the sandbox holding `files` (JSON) at their relative paths. */
const folder = (run: E2E, name: string, files: Record<string, object>): string => {
  const dir = join(run.sandbox.root, name)
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, JSON.stringify(content))
  }
  return dir
}

/** A Windows path's drive letter in lower case. */
const lower = (path: string): string => path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())

type Case = {
  readonly label: string
  /** The words after `agy`, given the hook's command. */
  readonly words: (run: E2E, command: string) => string
}

const cases: readonly Case[] = [
  { label: "bare", words: () => "" },
  {
    label: "settings hooks",
    words: (run, command) => {
      const path = join(run.sandbox.root, "settings-hooks.json")
      writeFileSync(path, JSON.stringify({ hooks: hooks(command) }))
      return `--settings ${path}`
    },
  },
  {
    label: "project workspace hooks",
    words: (run, command) => {
      folder(run, "project", { ".agents/hooks.json": hooks(command) })
      return ""
    },
  },
  {
    // "gate" sorts before "project".
    label: "add-dir workspace hooks",
    words: (run, command) =>
      `--add-dir ${folder(run, "gate", { ".agents/hooks.json": hooks(command) })}`,
  },
  {
    label: "add-dir workspace plugin",
    words: (run, command) =>
      `--add-dir ${folder(run, "gate-plugin", {
        ".agents/plugins/probe-gate/plugin.json": { name: "probe-gate" },
        ".agents/plugins/probe-gate/hooks.json": hooks(command),
      })}`,
  },
  {
    label: "add-dir sorting after the project",
    words: (run, command) =>
      `--add-dir ${folder(run, "zz-gate", { ".agents/hooks.json": hooks(command) })}`,
  },
  {
    label: "add-dir with its drive letter in lower case",
    words: (run, command) =>
      `--add-dir ${lower(folder(run, "gate", { ".agents/hooks.json": hooks(command) }))}`,
  },
]

// Starts agy past Novadeck's shim, in the terminal's own shell: cmd on Windows.
const past = process.platform === "win32" ? `set "NOVADECK_SHIMS=" & agy` : "NOVADECK_SHIMS= agy"

const slug = (label: string): string => label.replace(/[^a-z0-9]+/gi, "-")

describe.skipIf(!supported || process.env.NOVADECK_E2E_PROBES === undefined)(
  "probe: a PreToolUse hook Antigravity takes per launch",
  () => {
    const it = e2e(agy)
    const only = process.env.PROBE_CASES?.split(",")
    for (const probe of cases.filter((one) => !only || only.includes(slug(one.label))))
      it(
        probe.label,
        async ({ e2e: run }) => {
          bodies.length = 0
          const hook = probeHook(run)
          const found: Record<string, unknown> = { case: probe.label }
          run.model.use(
            own((call) =>
              asked(call, "Run the command") && result(call) === undefined
                ? {
                    calls: [
                      {
                        name: "run_command",
                        input: {
                          CommandLine: 'node -e "console.log(process.cwd())"',
                          WaitMsBeforeAsync: 5000,
                          toolSummary: "Folder",
                        },
                      },
                    ],
                  }
                : undefined,
            ),
            own((call) => {
              const said = result(call)
              return said !== undefined ? { text: `Result: ${said.slice(0, 400)}` } : undefined
            }),
          )
          found.command = `${past} ${probe.words(run, hook.command)}`.trim()
          const terminal = await run.deck.open(found.command as string)
          try {
            await terminal.reached("ready", { timeoutMs: 60_000 })
            await prompted(terminal, agy)
            await terminal.submit("Run the command")
            found.dialog = await terminal.until(/Yes, run command|Result:/, 30_000)
            if (/Yes, run command/.test(String(found.dialog))) {
              await terminal.settled()
              terminal.press("1")
              await terminal.until("Result:", 30_000)
            }
          } catch (error) {
            found.error = String(error).slice(0, 400)
          }
          found.screen = await terminal.screen()
          found.told = [
            ...new Set(
              bodies.flatMap(
                (body) =>
                  body.match(/Active Workspaces:.{0,600}?Command Working Directory:[^"]*?\\n/g) ??
                  [],
              ),
            ),
          ]
          found.hookRan = existsSync(hook.log)
          found.hookInputs = existsSync(hook.log)
            ? readFileSync(hook.log, "utf8")
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                  const input = JSON.parse(line) as Record<string, unknown>
                  return { cwd: input.cwd, workspacePaths: input.workspacePaths }
                })
            : []
          if (out) {
            mkdirSync(out, { recursive: true })
            writeFileSync(
              join(out, `agy.${slug(probe.label)}.settings-hooks.probe.json`),
              JSON.stringify(found, null, 2),
            )
          }
          expect(found).toBeDefined()
        },
        150_000,
      )
  },
)
