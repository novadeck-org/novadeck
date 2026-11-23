// PROBE, not a regression test: how Antigravity can be let write in the folder of agents'
// worktrees (`~/.novadeck/worktrees`, here the sandbox home's, which sorts before the project as
// the home's `.novadeck` sorts before `Projects`) without that folder becoming where it works.
// Each case starts agy past Novadeck's shim with the case's words and has the model write a file
// in a worktree's folder below it; it records what Antigravity told the model of its workspaces
// and working directory, whether the write ran without a dialog, and the screen.
// Found on 1.5.13 (2026-11-23, Windows): the workspaces are ordered by path, and the first is the
// "Command Working Directory", so `--add-dir` of the folder made it the session's from the
// project and from inside a worktree; without the flag a write there asks ("outside workspace").
// `permissions.additionalDirectories` in `--settings` is taken and does nothing; a top-level
// `additionalDirectories` is refused ("unknown setting"); a `write_file(<folder>)` rule lets the
// write run unasked, `write_file(<folder>/**)` doesn't match. Through Novadeck's shim, which now
// adds the folder only where it sorts after the session's own, the session works in its own.
// Runs only with NOVADECK_E2E_PROBES=1, by path; with PROBE_OUT set it writes
// $PROBE_OUT/agy.<case>.worktrees-folder.probe.json. PROBE_CASES picks cases by their slugs.
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { worktreesRoot } from "../../worktrees/root.js"
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

type Case = {
  readonly label: string
  /** The words after `agy`, given the folder of worktrees. */
  readonly words: (run: E2E, root: string) => string
  /** Starts agy in the worktree, not the project. */
  readonly inWorktree?: true
  /** Starts agy through Novadeck's own shim, as a person's `agy` in a terminal does. */
  readonly shim?: true
}

const allowing = (run: E2E, name: string, rules: readonly string[]): string =>
  settings(run, name, { permissions: { allow: ["mcp(novadeck_novadeck/*)", ...rules] } })

const settings = (run: E2E, name: string, value: object): string => {
  const path = join(run.sandbox.root, `${name}.json`)
  writeFileSync(path, JSON.stringify(value))
  return `--settings ${path}`
}

const cases: readonly Case[] = [
  { label: "nothing", words: () => "" },
  { label: "add-dir", words: (_, root) => `--add-dir=${root}` },
  {
    label: "settings permissions additionalDirectories",
    words: (run, root) =>
      settings(run, "permissions-dirs", {
        permissions: { allow: ["mcp(novadeck_novadeck/*)"], additionalDirectories: [root] },
      }),
  },
  {
    label: "write_file rule on the folder",
    words: (run, root) => allowing(run, "rule-folder", [`write_file(${root})`]),
  },
  {
    label: "write_file rule on the folder's files",
    words: (run, root) => allowing(run, "rule-glob", [`write_file(${join(root, "**")})`]),
  },
  {
    label: "add-dir from inside a worktree",
    inWorktree: true,
    words: (_, root) => `--add-dir=${root}`,
  },
  {
    label: "nothing from inside a worktree",
    inWorktree: true,
    words: () => "",
  },
  { label: "through the shim", shim: true, words: () => "" },
  {
    label: "through the shim from inside a worktree",
    shim: true,
    inWorktree: true,
    words: () => "",
  },
  {
    label: "settings additionalDirectories",
    words: (run, root) => settings(run, "top-dirs", { additionalDirectories: [root] }),
  },
]

// Starts agy past Novadeck's shim, in the terminal's own shell: cmd on Windows.
const past = process.platform === "win32" ? `set "NOVADECK_SHIMS=" & agy` : "NOVADECK_SHIMS= agy"

const slug = (label: string): string => label.replace(/[^a-z0-9]+/gi, "-")

describe.skipIf(!supported || process.env.NOVADECK_E2E_PROBES === undefined)(
  "probe: Antigravity let into the folder of worktrees",
  () => {
    const it = e2e(agy)
    const only = process.env.PROBE_CASES?.split(",")
    for (const probe of cases.filter((one) => !only || only.includes(slug(one.label))))
      it(
        probe.label,
        async ({ e2e: run }) => {
          bodies.length = 0
          const root = worktreesRoot(run.sandbox.home)
          const worktree = join(root, "project", "probe")
          mkdirSync(worktree, { recursive: true })
          const target = join(worktree, "probe.txt")
          const found: Record<string, unknown> = { case: probe.label }
          run.model.use(
            own((call) =>
              asked(call, "Write the file") && result(call) === undefined
                ? {
                    calls: [
                      {
                        name: "write_file",
                        input: { Path: target, Overwrite: true, Content: "probe\n" },
                      },
                    ],
                  }
                : undefined,
            ),
            own((call) => (result(call) !== undefined ? { text: "Wrote it." } : undefined)),
          )
          found.command = `${probe.shim ? "agy" : past} ${probe.words(run, root)}`.trim()
          const terminal = await run.deck.open(
            probe.inWorktree
              ? `${process.platform === "win32" ? "cd /d" : "cd"} "${worktree}" && ${found.command as string}`
              : (found.command as string),
          )
          try {
            // A worktree is a folder it hasn't been told to trust.
            if (probe.inWorktree) await terminal.confirm(/Yes, I trust this folder/, async () => {})
            await terminal.reached("ready", { timeoutMs: 60_000 })
            await prompted(terminal, agy)
            await terminal.submit("Write the file")
            found.until = await terminal.until(/Wrote it\.|Allow|Yes,/, 30_000)
          } catch (error) {
            found.error = String(error).slice(0, 600)
          }
          found.screen = await terminal.screen()
          found.written = existsSync(target)
          found.told = [
            ...new Set(
              bodies.flatMap((body) => {
                const at = body.indexOf("Active Workspaces:")
                return at < 0 ? [] : [body.slice(at, body.indexOf("Files relating", at))]
              }),
            ),
          ]
          if (out) {
            mkdirSync(out, { recursive: true })
            writeFileSync(
              join(out, `agy.${slug(probe.label)}.worktrees-folder.probe.json`),
              JSON.stringify(found, null, 2),
            )
          }
          expect(found).toBeDefined()
        },
        150_000,
      )
  },
)
