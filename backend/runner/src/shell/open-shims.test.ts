import { execFile, execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterAll, describe, expect, it } from "vitest"

import { onPath, openShim, openShims, type OpenProgram } from "./open-shims.js"

const root = mkdtempSync(join(tmpdir(), "open-shims-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// Novadeck's bin with the shims, and a folder later on PATH with each real program: one that
// says its words and its cgroup, and exits with 3.
const bin = join(root, "bin")
const real = join(root, "real")
mkdirSync(bin)
mkdirSync(real)
for (const file of openShims("linux", () => true)) {
  writeFileSync(join(bin, file.path), file.content)
  chmodSync(join(bin, file.path), file.mode!)
}
for (const program of ["xdg-open", "gio"] satisfies OpenProgram[]) {
  writeFileSync(
    join(real, program),
    `#!/bin/sh\nprintf '%s\\n' "${program}" "$@"\nhead -1 /proc/self/cgroup\nexit 3\n`,
  )
  chmodSync(join(real, program), 0o755)
}

const own = (): string => readFileSync("/proc/self/cgroup", "utf8").split("\n")[0]!

/** Runs `program` as a terminal's shell finds it, by PATH; its output and exit status. */
const run = async (
  program: OpenProgram,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
  path = `${bin}:${real}:/usr/bin:/bin`,
): Promise<{ lines: readonly string[]; code: number }> => {
  try {
    const { stdout } = await promisify(execFile)(program, [...args], {
      env: { ...process.env, ...env, PATH: path },
    })
    return { lines: stdout.trimEnd().split("\n"), code: 0 }
  } catch (error) {
    const failed = error as { stdout: string; code: number }
    return { lines: failed.stdout.trimEnd().split("\n"), code: failed.code }
  }
}

// Whether the user's systemd answers here, as it does in a desktop session and on CI.
const systemd = (() => {
  try {
    execFileSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(process.platform !== "linux")("the shims that open apps", () => {
  it("are Linux's alone, each where its program is there", () => {
    expect(openShims("darwin", () => true)).toEqual([])
    expect(openShims("win32", () => true)).toEqual([])
    expect(openShims("linux", () => true).map(({ path }) => path)).toEqual(["xdg-open", "gio"])
    expect(openShims("linux", (program) => program === "gio").map(({ path }) => path)).toEqual([
      "gio",
    ])
    expect(onPath("xdg-open", real)).toBe(true)
    expect(onPath("xdg-open", `${root}/nowhere`)).toBe(false)
  })

  it("run the real program with the same words, output and exit status", async () => {
    const words = ["https://example.com/a b?c=d&e", "--", "it's"]
    for (const scoped of [{}, { NOVADECK_OPEN: bin }]) {
      // eslint-disable-next-line no-await-in-loop -- One at a time, as a terminal runs them.
      const { lines, code } = await run("xdg-open", words, scoped)
      expect(lines.slice(0, 4)).toEqual(["xdg-open", ...words])
      expect(code).toBe(3)
    }
  })

  it("run it where it was called, outside a terminal with a scope of its own", async () => {
    const { lines } = await run("xdg-open", ["file.png"])
    expect(lines.at(-1)).toBe(own())
  })

  it.skipIf(!systemd)("give what they open a scope of its own in a scoped terminal", async () => {
    const { lines } = await run("xdg-open", ["file.png"], { NOVADECK_OPEN: bin })
    expect(lines.at(-1)).not.toBe(own())
    expect(lines.at(-1)).toMatch(/\.scope$/)
  })

  it.skipIf(!systemd)(
    "give gio's open and launch a scope, and leave its other commands be",
    async () => {
      for (const command of ["open", "launch"]) {
        // eslint-disable-next-line no-await-in-loop -- One at a time, as a terminal runs them.
        const { lines, code } = await run("gio", [command, "x.desktop"], { NOVADECK_OPEN: bin })
        expect(lines.slice(0, 3)).toEqual(["gio", command, "x.desktop"])
        expect(lines.at(-1)).not.toBe(own())
        expect(code).toBe(3)
      }
      const { lines } = await run("gio", ["info", "x"], { NOVADECK_OPEN: bin })
      expect(lines.at(-1)).toBe(own())
    },
  )

  it("run the program as it is where the user's systemd doesn't answer", async () => {
    // A systemctl that fails, as inside a sandbox without the user's bus.
    const broken = join(root, "broken")
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, "systemctl"), "#!/bin/sh\nexit 1\n")
    chmodSync(join(broken, "systemctl"), 0o755)
    const { lines, code } = await run(
      "xdg-open",
      ["file.png"],
      { NOVADECK_OPEN: bin },
      `${bin}:${broken}:${real}:/usr/bin:/bin`,
    )
    expect(lines.at(-1)).toBe(own())
    expect(code).toBe(3)
  })

  it("skip another Novadeck's shim, and say so where no program is there", async () => {
    const outer = join(root, "outer")
    mkdirSync(outer, { recursive: true })
    writeFileSync(join(outer, "xdg-open"), openShim("xdg-open"))
    chmodSync(join(outer, "xdg-open"), 0o755)
    const { lines } = await run("xdg-open", ["x"], {}, `${bin}:${outer}:${real}:/usr/bin:/bin`)
    expect(lines[0]).toBe("xdg-open")
    expect((await run("xdg-open", ["x"], {}, `${bin}:/nonexistent`)).code).toBe(127)
  })
})
