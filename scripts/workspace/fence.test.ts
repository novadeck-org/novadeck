import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { lint, probeConfig } from "./oxlint.ts"

const root = join(import.meta.dirname, "..", "..")

// The fence around neutral packages (fence.ts), proven as the libraries' is: probe files in a
// workspace of their own, linted with the real config, and the lines the fence refuses read
// back. Each probe file holds one import or one read per line.

const refused = [
  `import { execFile } from "node:child_process"`,
  `import { spawn } from "child_process"`,
  `import * as os from "node:os"`,
  `import { homedir, tmpdir as temporary } from "node:os"`,
  `import system from "os"`,
  `import { createServer } from "node:net"`,
  `import "node:tty"`,
  `import { app } from "electron"`,
  `import { spawn as pty } from "node-pty"`,
  `import koffi from "koffi"`,
  `import { sandbox } from "@novadeck/sandbox"`,
  `import { open } from "@novadeck/terminal/pty"`,
  `import { host } from "@novadeck/terminal/host"`,
  `import { broker } from "@novadeck/wire/electron"`,
  `import { look } from "@novadeck/viewers/browser/host"`,
  `export * from "node:child_process"`,
  `export { fork } from "node:child_process"`,
  `await import("node:child_process")`,
  `require("node-pty")`,
  `export const platform = process.platform`,
  `export const arch = process.arch`,
  `process.kill(1)`,
  `import { type ChildProcess as Child, spawn as run } from "node:child_process"`,
]
// Each binding its own, as a file that declares one twice doesn't parse, and isn't linted.
const allowed = [
  `import type { ChildProcess } from "node:child_process"`,
  `import { type Serializable } from "node:child_process"`,
  `import type { BrowserWindow } from "electron"`,
  `export type { StdioOptions } from "node:child_process"`,
  `import { tmpdir } from "node:os"`,
  `import { readFileSync } from "node:fs"`,
  `import { join } from "node:path"`,
  `import { setTimeout } from "node:timers/promises"`,
  `import { createServer as serve } from "node:http"`,
  `import { Terminal } from "@novadeck/terminal"`,
  `import { view } from "@novadeck/terminal/view"`,
  `import { client } from "@novadeck/wire/client"`,
  `import { Headless } from "@novadeck/emulator/headless"`,
  `import { own } from "./pty"`,
  `export const env = process.env.HOME`,
  `export const at = process.cwd()`,
]
const probe = [...refused, ...allowed].join("\n")

/** The probe packages: where each sits, what it declares, and whether its lines are fenced. */
const packages = [
  { folder: "frontend/probe", platform: "neutral", fenced: true },
  { folder: "libraries/probe", platform: "neutral", fenced: true },
  { folder: "contract/probe", platform: "neutral", fenced: true },
  { folder: "backend/probe", platform: "system", fenced: false },
  // A missing or unknown declaration reads as system: the fence is for what says it's neutral.
  { folder: "apps/probe", platform: undefined, fenced: false },
  { folder: "tools/probe", platform: "Neutral", fenced: false },
] as const
// Where each probe package's lines go: its code, its tests, deeper, in TSX and in JS.
const files = ["src/probe.ts", "src/probe.test.ts", "src/deep/probe.tsx", "scripts/probe.mts"]
// Outside every package, as the repository's scripts are, nothing is fenced.
const outside = ["scripts/probe.ts", "probe.ts", "unlisted/probe/src/probe.ts"]

let refusals: ReadonlyMap<string, readonly number[]> = new Map()
let workspace = ""

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "novadeck-platform-fence-"))
  writeFileSync(join(workspace, ".oxlintrc.json"), probeConfig())
  copyFileSync(join(root, "pnpm-workspace.yaml"), join(workspace, "pnpm-workspace.yaml"))
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "root", private: true }))
  const written = [
    ...packages.flatMap(({ folder, platform }) => {
      mkdirSync(join(workspace, folder), { recursive: true })
      writeFileSync(
        join(workspace, folder, "package.json"),
        JSON.stringify({ name: `@probe/${folder}`, ...(platform && { novadeck: { platform } }) }),
      )
      return files.map((file) => `${folder}/${file}`)
    }),
    ...outside,
  ]
  mkdirSync(join(workspace, "unlisted/probe"), { recursive: true })
  writeFileSync(join(workspace, "unlisted/probe/package.json"), "{}")
  for (const file of written) {
    mkdirSync(dirname(join(workspace, file)), { recursive: true })
    writeFileSync(join(workspace, file), `${probe}\n`)
  }
  const found = new Map<string, number[]>()
  for (const { code, filename, labels } of lint(workspace)) {
    const line = labels?.[0]?.span.line
    if (code !== "novadeck(platform)" || line === undefined) continue
    found.set(filename, [...(found.get(filename) ?? []), line])
  }
  refusals = found
})

afterAll(() => rmSync(workspace, { recursive: true, force: true }))

const lines = (file: string): readonly string[] =>
  [...new Set(refusals.get(file))]
    .toSorted((a, b) => a - b)
    .map((line) => probe.split("\n")[line - 1] ?? `${line}`)

describe("the neutral packages' lint fence", () => {
  it.each(
    packages
      .filter(({ fenced }) => fenced)
      .flatMap(({ folder }) => files.map((file) => ({ file: `${folder}/${file}` }))),
  )("refuses in $file exactly what reaches the system", ({ file }) => {
    expect(lines(file)).toEqual(refused)
  })

  it.each(
    packages
      .filter(({ fenced }) => !fenced)
      .flatMap(({ folder }) => files.map((file) => ({ file: `${folder}/${file}` })))
      .concat(outside.map((file) => ({ file }))),
  )("refuses nothing in $file, which isn't in a neutral package", ({ file }) => {
    expect(lines(file)).toEqual([])
  })
})
