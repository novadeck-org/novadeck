import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import type { Machine } from "@novadeck/harness-core/harness"
import { relayPath } from "@novadeck/relay"

import { describe, expect, it as base } from "../test.js"
import { hostless } from "../testing/host.js"
import { shellFiles, shellPaths } from "./scripts.js"
import { pipedPrompt, quotedPrompts, splitPrompt } from "./shim-prompts.test-support.js"

type Fixture = {
  readonly shim: string
  /** The folder of agents' worktrees the shim was written with, not made. */
  readonly worktrees: string
  readonly real: string
  /** Installs the relay beside the shim, as the runner does. */
  readonly relay: () => void
  /** The person's Antigravity settings, in the shim's USERPROFILE. */
  readonly settings: string
  /** Novadeck's file of allow rules, as the shim names it. */
  readonly allow: string
  readonly launch: (
    program: string,
    args: string[],
    cwd?: string,
  ) => {
    result: SpawnSyncReturns<string>
    received: string[] | undefined
    /** The folder the real agy started in. */
    started: string | undefined
  }
}

// The shim as the runner writes it, which only Windows has and only cmd can run, for a machine
// that may also give it `extra`. The real agy is a stand-in that records the arguments it
// received and the folder it started in.
const prepared = async (
  resources: { defer: (undo: () => void) => void },
  extra: (root: string) => Machine,
): Promise<Fixture> => {
  const root = mkdtempSync(join(tmpdir(), "novadeck-agy-shim-"))
  resources.defer(() => rmSync(root, { recursive: true, force: true }))
  const paths = shellPaths(join(root, "shell"), "win32")
  const written = shellFiles(paths, "win32", undefined, {
    cmdShimDir: join(root, "agy-cmd"),
    worktreesRoot: join(root, "worktrees"),
    ...extra(root),
  }).find((file) => file.path === join(paths.bin, "agy.cmd"))
  if (written === undefined) throw new Error("No shim for agy")
  const real = join(root, "real")
  mkdirSync(paths.bin, { recursive: true })
  mkdirSync(real)
  writeFileSync(written.path, written.content)
  const profile = join(root, "profile")
  mkdirSync(join(profile, ".gemini", "antigravity-cli"), { recursive: true })
  const terminal = "00000000-0000-4000-8000-000000000001"
  const log = join(root, "args.json")
  const recorder = join(root, "record.cjs")
  writeFileSync(
    recorder,
    `require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))`,
  )
  writeFileSync(join(real, "agy.cmd"), `@"${process.execPath}" "${recorder}" %*\r\n`)
  const launch: Fixture["launch"] = (program, args, cwd) => {
    rmSync(log, { force: true })
    const result = spawnSync(process.env.COMSPEC ?? "cmd.exe", ["/d", "/c", program, ...args], {
      env: hostless({
        PATH: [paths.bin, real, process.env.PATH].join(delimiter),
        USERPROFILE: profile,
        NOVADECK_TERMINAL_ID: terminal,
        NOVADECK_SHIMS: "agy",
      }),
      encoding: "utf8",
      timeout: 30_000,
      ...(cwd !== undefined && { cwd }),
    })
    const recorded = existsSync(log)
      ? (JSON.parse(readFileSync(log, "utf8")) as { args: string[]; cwd: string })
      : undefined
    return {
      result,
      received: recorded?.args,
      started: recorded?.cwd,
    }
  }
  return {
    shim: written.path,
    worktrees: join(root, "worktrees"),
    real,
    relay: () => copyFileSync(relayPath, paths.relay),
    settings: join(profile, ".gemini", "antigravity-cli", "settings.json"),
    allow: `${paths.bin}\\..\\allow\\${terminal}.json`,
    launch,
  }
}

const it = base.extend<{ fixture: Fixture }>({
  fixture: async ({ resources }, use) => use(await prepared(resources, () => ({}))),
})

// Where cmd prints: the shim also adds the folder holding Antigravity's PreToolUse hook, with the
// shipping gate on.
const hooked = base.extend<{ fixture: Fixture & { readonly hooks: string } }>({
  fixture: async ({ resources }, use) => {
    let hooks = ""
    const fixture = await prepared(resources, (root) => {
      hooks = join(root, "agy-hooks")
      return { cmdPrints: true, hooksFolder: hooks, shippingGate: true }
    })
    await use({ ...fixture, hooks })
  },
})

describe.runIf(process.platform === "win32")("agy shim", { timeout: 60_000 }, () => {
  it.for(quotedPrompts)("passes on whole the quoted prompt %j", (prompt, { fixture }) => {
    const { result, received } = fixture.launch(fixture.shim, [prompt])
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("")
    expect(result.status).toBe(0)
    expect(received).toEqual([prompt])
  })

  it("passes the person's allow rules with Novadeck's tools added, through the relay beside it", ({
    fixture,
  }) => {
    fixture.relay()
    writeFileSync(fixture.settings, JSON.stringify({ permissions: { allow: ["command(dir)"] } }))
    const { result, received } = fixture.launch(fixture.shim, ["fix a b"])
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(received).toEqual(["--settings", fixture.allow, "fix a b"])
    expect(JSON.parse(readFileSync(fixture.allow, "utf8"))).toEqual({
      permissions: { allow: ["command(dir)", "mcp(novadeck_novadeck/*)"] },
    })
    // Settings it can't read: none passed, so none of the person's rules is lost.
    writeFileSync(fixture.settings, "{ not json")
    expect(fixture.launch(fixture.shim, ["fix a b"]).received).toEqual(["fix a b"])
  })

  // Antigravity works in the first of its workspaces by path, case and all, and a folder sorts
  // before what it holds (e2e/probes/agy-worktrees-folder.e2e.ts).
  it("adds the worktrees' folder only where it sorts after the folder agy starts in, as the relay says", ({
    fixture,
  }) => {
    fixture.relay()
    const worktree = join(fixture.worktrees, "project", "fix")
    mkdirSync(worktree, { recursive: true })
    const before = join(fixture.worktrees, "..", "project")
    const after = join(fixture.worktrees, "..", "zz-project")
    mkdirSync(before)
    mkdirSync(after)
    const added = (where: string) =>
      fixture
        .launch(fixture.shim, ["fix"], where)
        .received?.filter((arg) => arg.startsWith("--add-dir"))
    const from = fixture.launch(fixture.shim, ["fix"], before)
    expect(from.result.stderr).toBe("")
    expect(from.received?.[0]).toBe(`--add-dir=${fixture.worktrees}`)
    expect(from.received?.at(-1)).toBe("fix")
    expect(from.started).toBe(before)
    // Case and all: a drive letter in lower case sorts after the folder's.
    const lower = before.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
    for (const where of [after, lower, worktree, fixture.worktrees])
      expect(added(where), where).toEqual([])
  })

  it("adds no worktrees' folder where the relay can't say where it sorts", ({ fixture }) => {
    mkdirSync(join(fixture.worktrees, "..", "project"), { recursive: true })
    mkdirSync(fixture.worktrees)
    const from = join(fixture.worktrees, "..", "project")
    expect(fixture.launch(fixture.shim, ["fix"], from).received).toEqual(["fix"])
  })

  // Help that printed would also page at a console, and wait there for a key.
  it("hands on a word that cmd's own commands take as a request for their help", ({ fixture }) => {
    const { result, received } = fixture.launch(fixture.shim, ["/?"])
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(received).toEqual(["/?"])
  })

  it("takes a prompt cmd splits first as the real agy does alone", ({ fixture }) => {
    const alone = fixture.launch(join(fixture.real, "agy.cmd"), [splitPrompt])
    const through = fixture.launch(fixture.shim, [splitPrompt])
    expect(alone.received).toBeDefined()
    expect(through.received).toEqual(alone.received)
    expect(through.result.status).toBe(alone.result.status)
    expect(through.result.stderr).toBe(alone.result.stderr)
  })

  it("starts nothing at a pipe cmd splits first, as the real agy alone", ({ fixture }) => {
    const alone = fixture.launch(join(fixture.real, "agy.cmd"), [pipedPrompt])
    const through = fixture.launch(fixture.shim, [pipedPrompt])
    expect(alone.received).toBeUndefined()
    expect(through.received).toBeUndefined()
    expect(through.result.status).toBe(alone.result.status)
  })
})

describe.runIf(process.platform === "win32")(
  "agy shim where cmd prints",
  { timeout: 60_000 },
  () => {
    hooked(
      "adds the folder of Antigravity's PreToolUse hook, its drive letter in lower case, and passes the gate's rules",
      ({ fixture }) => {
        fixture.relay()
        writeFileSync(fixture.settings, JSON.stringify({ permissions: { allow: [] } }))
        const { result, received } = fixture.launch(fixture.shim, ["fix a b"])
        expect(result.stderr).toBe("")
        expect(result.status).toBe(0)
        const lower = fixture.hooks.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
        expect(received).toEqual([`--add-dir=${lower}`, "--settings", fixture.allow, "fix a b"])
        expect(JSON.parse(readFileSync(fixture.allow, "utf8")).permissions.allow).toEqual([
          "mcp(novadeck_novadeck/*)",
          "command(gh pr create)",
          "command(gh pr merge)",
        ])
      },
    )

    // Antigravity orders its workspaces by path, case and all, and runs commands in the first.
    hooked(
      "starts agy in its folder with the drive letter in upper case, the terminal's own after",
      ({ fixture }) => {
        const folder = mkdtempSync(join(tmpdir(), "novadeck-agy-cwd-"))
        const lower = folder.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
        try {
          const { result, started } = fixture.launch(fixture.shim, ["fix"], lower)
          expect(result.status).toBe(0)
          expect(started).toBe(folder.replace(/^[a-z]:/, (drive) => drive.toUpperCase()))
          // A folder already named in upper case is left as it is.
          expect(fixture.launch(fixture.shim, ["fix"], folder).started).toBe(folder)
        } finally {
          rmSync(folder, { recursive: true, force: true })
        }
      },
    )
  },
)
