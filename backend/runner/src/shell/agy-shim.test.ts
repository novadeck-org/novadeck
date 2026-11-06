import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { shellFiles, shellPaths } from "./scripts.js"
import { quotedPrompts, splitPrompts } from "./shim-prompts.test-support.js"

type Fixture = {
  readonly shim: string
  readonly real: string
  readonly launch: (
    program: string,
    args: string[],
  ) => { result: SpawnSyncReturns<string>; received: string[] | undefined }
}

// The shim as the runner writes it, which only Windows has and only cmd can run. The real agy is
// a stand-in that records the arguments it received.
const it = base.extend<{ fixture: Fixture }>({
  fixture: async ({ resources }, use) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-agy-shim-"))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const paths = shellPaths(join(root, "shell"), "win32")
    const written = shellFiles(paths, "win32", undefined, {
      cmdShimDir: join(root, "agy-cmd"),
    }).find((file) => file.path === join(paths.bin, "agy.cmd"))
    if (written === undefined) throw new Error("No shim for agy")
    const real = join(root, "real")
    mkdirSync(paths.bin, { recursive: true })
    mkdirSync(real)
    writeFileSync(written.path, written.content)
    const log = join(root, "args.json")
    const recorder = join(root, "record.cjs")
    writeFileSync(
      recorder,
      `require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))`,
    )
    writeFileSync(join(real, "agy.cmd"), `@"${process.execPath}" "${recorder}" %*\r\n`)
    const launch: Fixture["launch"] = (program, args) => {
      rmSync(log, { force: true })
      const result = spawnSync(process.env.COMSPEC ?? "cmd.exe", ["/d", "/c", program, ...args], {
        env: {
          ...process.env,
          PATH: [paths.bin, real, process.env.PATH].join(delimiter),
          NOVADECK_TERMINAL_ID: "00000000-0000-4000-8000-000000000001",
          NOVADECK_SHIMS: "agy",
        },
        encoding: "utf8",
      })
      return {
        result,
        received: existsSync(log) ? (JSON.parse(readFileSync(log, "utf8")) as string[]) : undefined,
      }
    }
    await use({ shim: written.path, real, launch })
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

  it.for(splitPrompts)(
    "takes the prompt %j, which cmd splits first, as the real agy does alone",
    (prompt, { fixture }) => {
      const alone = fixture.launch(join(fixture.real, "agy.cmd"), [prompt])
      const through = fixture.launch(fixture.shim, [prompt])
      expect(alone.received).toBeDefined()
      expect(through.received).toEqual(alone.received)
      expect(through.result.status).toBe(alone.result.status)
      expect(through.result.stderr).toBe(alone.result.stderr)
    },
  )
})
