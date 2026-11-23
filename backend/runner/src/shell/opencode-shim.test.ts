import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { hostless } from "../testing/host.js"
import { shellFiles, shellPaths } from "./scripts.js"
import { quotedPrompts } from "./shim-prompts.test-support.js"

type Received = { readonly args: string[]; readonly config: string | null }

type Fixture = {
  readonly shim: string
  readonly launch: (args: string[]) => {
    result: SpawnSyncReturns<string>
    received: Received | undefined
  }
}

// opencode's shim as the runner writes it, which only Windows has and only cmd can run, with its
// plugin where the runner puts it. The real opencode is a stand-in that records the arguments it
// received and the configuration the shim gave it (OPENCODE_CONFIG_CONTENT), which loads the
// plugin.
const it = base.extend<{ fixture: Fixture }>({
  fixture: async ({ resources }, use) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-opencode-shim-"))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const paths = shellPaths(join(root, "shell"), "win32")
    const written = shellFiles(paths, "win32", undefined, {
      cmdShimDir: join(root, "agy-cmd"),
      worktreesRoot: join(root, "worktrees"),
    }).find((file) => file.path === join(paths.bin, "opencode.cmd"))
    if (written === undefined) throw new Error("No shim for opencode")
    const real = join(root, "real")
    mkdirSync(paths.bin, { recursive: true })
    mkdirSync(real)
    writeFileSync(written.path, written.content)
    mkdirSync(paths.plugins.opencode, { recursive: true })
    writeFileSync(join(paths.plugins.opencode, "novadeck.mjs"), "export const NovadeckPlugin = 1\n")
    const log = join(root, "received.json")
    const recorder = join(root, "record.cjs")
    writeFileSync(
      recorder,
      `require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), config: process.env.OPENCODE_CONFIG_CONTENT ?? null }))`,
    )
    writeFileSync(join(real, "opencode.cmd"), `@"${process.execPath}" "${recorder}" %*\r\n`)
    const launch: Fixture["launch"] = (args) => {
      rmSync(log, { force: true })
      const result = spawnSync(
        process.env.COMSPEC ?? "cmd.exe",
        ["/d", "/c", written.path, ...args],
        {
          env: hostless({
            PATH: [paths.bin, real, process.env.PATH].join(delimiter),
            NOVADECK_TERMINAL_ID: "00000000-0000-4000-8000-000000000001",
            NOVADECK_SHIMS: "opencode",
          }),
          encoding: "utf8",
          timeout: 30_000,
        },
      )
      return {
        result,
        received: existsSync(log) ? (JSON.parse(readFileSync(log, "utf8")) as Received) : undefined,
      }
    }
    await use({ shim: written.path, launch })
  },
})

// The launch prompt Novadeck gives an agent it opens: the doorbell's line, a tag in quotes.
const doorbell = "<novadeck-doorbell from='' ring='RZUhpw'/>"

describe.runIf(process.platform === "win32")("opencode shim", { timeout: 60_000 }, () => {
  it("loads Novadeck's plugin for a launch prompt of the doorbell's, passed on whole", ({
    fixture,
  }) => {
    const { result, received } = fixture.launch(["--prompt", doorbell])
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(received?.args).toEqual(["--prompt", doorbell])
    expect(JSON.parse(received?.config ?? "{}").plugin?.[0]).toMatch(/novadeck\.mjs$/)
  })

  it.for(quotedPrompts)(
    "loads Novadeck's plugin, and passes on whole the quoted prompt %j",
    (prompt, { fixture }) => {
      const { result, received } = fixture.launch(["--prompt", prompt])
      expect(result.status).toBe(0)
      expect(received?.args).toEqual(["--prompt", prompt])
      expect(received?.config).toMatch(/novadeck\.mjs/)
    },
  )
})
