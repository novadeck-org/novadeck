import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { context, describe, expect, it } from "../../test"
import { elfFiles, missingPackages, notFound, verdict } from "./browser-dependencies.ts"
import { bounded, failure, longest, plan, waits } from "./retry.ts"

const root = join(import.meta.dirname, "..", "..", "..")

describe("the test browser's dependencies", () => {
  context("as Playwright's dry run names them", () => {
    it("are none where it passed", () => {
      expect(missingPackages(0, "")).toEqual([])
    })

    it("are the packages it lists as missing", () => {
      const output = [
        "BEWARE: your OS is not officially supported by Playwright",
        "Missing system dependencies (3):",
        "  fonts-liberation",
        "  libgbm1",
        "  xvfb",
        "undefined",
      ].join("\n")
      expect(missingPackages(1, output)).toEqual(["fonts-liberation", "libgbm1", "xvfb"])
    })

    it.each([
      ["it failed without a list", "Error: spawn pnpm ENOENT"],
      ["its list is empty", "Missing system dependencies (0):\nundefined"],
    ])("can't be told where %s", (_name, output) => {
      expect(missingPackages(1, output)).toBeUndefined()
    })
  })

  it("read ldd's libraries not found, each once", () => {
    const output = [
      "\tlinux-vdso.so.1 (0x00007ffd)",
      "\tlibgbm.so.1 => not found",
      "\tlibc.so.6 => /lib64/libc.so.6 (0x00007f)",
      "\tlibgbm.so.1 => not found",
      "\tlibxkbcommon.so.0 => not found",
    ].join("\n")
    expect(notFound(output)).toEqual(["libgbm.so.1", "libxkbcommon.so.0"])
  })

  it("find the browser's ELF files and nothing else", () => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-browser-"))
    try {
      writeFileSync(join(folder, "chrome"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]))
      writeFileSync(join(folder, "LICENSE"), "text")
      expect(elfFiles(folder)).toEqual([join(folder, "chrome")])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  // `0` skips apt; anything else installs, `unknown` too, so a check that couldn't tell
  // installs them as before.
  it.each([
    [[], 20, [], "0"],
    [["xvfb"], 20, ["libgbm.so.1"], "2"],
    [undefined, 20, [], "unknown"],
    [[], 0, [], "unknown"],
  ] as const)(
    "say %j packages, %d binaries, %j libraries are %s missing",
    (packages, binaries, libraries, said) => {
      expect(verdict(packages, binaries, libraries)).toBe(said)
    },
  )
})

describe("a setup command's retries", () => {
  it("wait longer before each, one fewer than the attempts", () => {
    expect(waits(plan)).toEqual([30, 60])
    expect(waits({ ...plan, attempts: 1 })).toEqual([])
  })

  // Bounded: a mirror that never answers ends the step in about ten minutes, not the job's.
  it("end within a bound a few minutes long", () => {
    expect(longest(plan)).toBe(3 * 180 + 30 + 60)
    expect(longest(plan)).toBeLessThanOrEqual(11 * 60)
  })

  it("say what failing means in one error line", () => {
    expect(failure("Ubuntu's mirrors unreachable", plan)).toBe(
      "::error title=Setup::Ubuntu's mirrors unreachable (3 attempts, 30 s, 60 s apart)",
    )
  })

  it("bound each attempt on Linux with timeout, which ends the whole process group", () => {
    expect(bounded(["pnpm", "exec", "playwright"], 180, "linux")).toEqual([
      "timeout",
      "--kill-after=15s",
      "180s",
      "pnpm",
      "exec",
      "playwright",
    ])
    expect(bounded(["pnpm"], 180, "darwin")).toEqual(["pnpm"])
  })

  context("as the action runs them", () => {
    const script = join(import.meta.dirname, "retry.ts")
    const scratch = () => mkdtempSync(join(tmpdir(), "novadeck-retry-"))
    const fast = { ...process.env, NOVADECK_RETRY_FAST: "true" }

    it.skipIf(process.platform === "win32")("stop at the first attempt that passes", () => {
      const folder = scratch()
      try {
        const count = join(folder, "count")
        const result = spawnSync(
          process.execPath,
          [
            script,
            "mirrors",
            "--",
            "sh",
            "-c",
            `echo x >> '${count}'; [ $(wc -l < '${count}') -ge 2 ]`,
          ],
          { env: fast, encoding: "utf8" },
        )
        expect(result.status).toBe(0)
        expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(2)
        expect(result.stdout).not.toContain("::error")
      } finally {
        rmSync(folder, { recursive: true, force: true })
      }
    })

    it.skipIf(process.platform === "win32")(
      "fail with the command's code and the error line after the last",
      () => {
        const folder = scratch()
        try {
          const count = join(folder, "count")
          const result = spawnSync(
            process.execPath,
            [
              script,
              "Ubuntu's mirrors unreachable",
              "--",
              "sh",
              "-c",
              `echo x >> '${count}'; exit 100`,
            ],
            { env: fast, encoding: "utf8" },
          )
          expect(result.status).toBe(100)
          expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(3)
          expect(result.stdout).toContain(
            "::error title=Setup::Ubuntu's mirrors unreachable (3 attempts",
          )
        } finally {
          rmSync(folder, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(process.platform !== "linux")("end an attempt that outlasts its limit", () => {
      const started = Date.now()
      const result = spawnSync(process.execPath, [script, "mirrors", "--", "sleep", "30"], {
        env: { ...fast, NOVADECK_RETRY_LIMIT: "1" },
        encoding: "utf8",
      })
      expect(result.status).toBe(124)
      expect(Date.now() - started).toBeLessThan(15_000)
    })

    it("refuse a call without a command", () => {
      const result = spawnSync(process.execPath, [script, "mirrors"], { encoding: "utf8" })
      expect(result.status).toBe(2)
    })
  })
})

describe("a cached test browser's dependencies, where a job installs them", () => {
  // Quality's test jobs, the Counter run and the setup action (Nightly Quality's) each install
  // a cached browser's system packages on Linux: checked first, then with apt only where missing.
  const places = [
    [
      ".github/workflows/quality.yml",
      "matrix.browser && steps.browser-cache.outputs.cache-hit == 'true' && runner.os == 'Linux'",
    ],
    [
      ".github/workflows/benchmark.yml",
      "steps.changes.outputs.counts == 'true' && steps.browser-cache.outputs.cache-hit == 'true'",
    ],
    [
      ".github/actions/setup/action.yml",
      "inputs.browser == 'true' && steps.browser-cache.outputs.cache-hit == 'true' && runner.os == 'Linux'",
    ],
  ] as const
  const step = (text: string, name: string) => {
    const start = text.indexOf(`- name: ${name}\n`)
    return start < 0 ? "" : text.slice(start, text.indexOf("\n\n", start))
  }

  it.each(places)(
    "are checked in %s where the cache hit, and installed only where missing",
    (file, hit) => {
      const text = readFileSync(join(root, file), "utf8")
      const check = step(text, "Check Test Browser Dependencies")
      expect(check).toContain(`if: ${hit}`)
      expect(check).toContain("id: browser-dependencies")
      expect(check).toContain(
        'node scripts/ci/setup/browser-dependencies.ts "$PLAYWRIGHT_BROWSERS_PATH"',
      )
      const install = step(text, "Install Test Browser Dependencies")
      expect(install).toContain(`if: ${hit} && steps.browser-dependencies.outputs.missing != '0'`)
      expect(install).toMatch(
        /node scripts\/ci\/setup\/retry\.ts\n\s+"apt mirrors unreachable[^"]*"\n\s+-- pnpm --filter @novadeck\/specs exec playwright install-deps chromium/,
      )
      expect(text.indexOf("- name: Check Test Browser Dependencies")).toBeLessThan(
        text.indexOf("- name: Install Test Browser Dependencies"),
      )
    },
  )

  // A job that asks for a browser still gets one where the cache missed, as before.
  it.each(places)("leave %s installing the browser itself where the cache missed", (file) => {
    const text = readFileSync(join(root, file), "utf8")
    expect(step(text, "Install Test Browser")).toContain("playwright install --with-deps chromium")
  })

  // The check runs Playwright's dry run, which reads dpkg and reaches no network.
  it("is Playwright's dry run, which reaches no network", () => {
    const source = readFileSync(join(import.meta.dirname, "browser-dependencies.ts"), "utf8")
    expect(source).toContain('"install-deps", "--dry-run", "chromium"')
  })
})
