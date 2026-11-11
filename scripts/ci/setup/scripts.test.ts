import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { context, describe, expect, it } from "../../test"
import {
  cacheKey,
  cachePrefix,
  elfFiles,
  missingPackages,
  notFound,
  verdict,
} from "./browser-dependencies.ts"
import {
  aptPlan,
  downloadScript,
  failFast,
  install,
  type Machine,
  saves,
} from "./browser-packages.ts"
import { bounded, failure, longest, plan, reaped, settled, waits } from "./retry.ts"

const root = join(import.meta.dirname, "..", "..", "..")

describe("the test browser's dependencies", () => {
  context("as Playwright's dry run names them", () => {
    it("are none only where it passed saying so", () => {
      expect(missingPackages(0, "All system dependencies are installed.\n")).toEqual([])
    })

    // Playwright 1.64 exits 0 after "Cannot install dependencies for <platform>", and older
    // dry runs printed the apt command with exit 0: neither says none is missing.
    it.each([
      [
        "it couldn't install for the platform",
        "Cannot install dependencies for ubuntu99.04-x64 with Playwright 1.64.1!",
      ],
      [
        "it printed the apt command",
        'sudo -- sh -c "apt-get update && apt-get install -y fonts-unifont"',
      ],
      ["it printed nothing", ""],
    ])("can't be told where it passed but %s", (_name, output) => {
      expect(missingPackages(0, output)).toBeUndefined()
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
  // installs them as before. Before a cache miss's download there are no libraries to read,
  // and Playwright's list decides alone.
  it.each([
    [[], [], "0"],
    [["xvfb"], ["libgbm.so.1"], "2"],
    [undefined, [], "unknown"],
  ] as const)("say %j packages and %j libraries are %s missing", (packages, libraries, said) => {
    expect(verdict(packages, libraries)).toBe(said)
  })
})

describe("the cache of the browser's packages", () => {
  const found = {
    os: "ubuntu-24.04",
    arch: "amd64",
    playwright: "1.64.1",
    packages: ["fonts-unifont", "xvfb"],
  }

  it("is keyed by the image's OS, architecture and build, and Playwright's version with its list", () => {
    const image = { ...found, image: "ubuntu24-20261109.1" }
    const key = cacheKey(image)
    expect(key).toMatch(/^browser-packages-ubuntu-24\.04-amd64-[0-9a-f]{16}-ubuntu24-20261109\.1$/)
    expect(cacheKey({ ...image, packages: ["xvfb", "fonts-unifont"] })).toBe(key)
    for (const other of [
      { os: "ubuntu-26.04" },
      { arch: "arm64" },
      { playwright: "1.65.0" },
      { packages: ["fonts-unifont"] },
      { image: "ubuntu24-20261116.1" },
    ])
      expect(cacheKey({ ...image, ...other }), JSON.stringify(other)).not.toBe(key)
    // Where the runner names no image, its OS version stands for it.
    expect(cacheKey(found)).toBe(`${cachePrefix(found)}ubuntu-24.04`)
  })

  // A new image build restores an earlier build's debs by the prefix the builds share.
  it("shares its prefix across image builds, and only those", () => {
    const prefix = cachePrefix({ ...found, image: "ubuntu24-20261109.1" })
    expect(cacheKey({ ...found, image: "ubuntu24-20261116.1" }).startsWith(prefix)).toBe(true)
    expect(cachePrefix({ ...found, playwright: "1.65.0" })).not.toBe(prefix)
    expect(prefix.endsWith("-")).toBe(true)
  })

  // A machine whose answers the test sets: what the folder holds, whether dpkg and apt work,
  // and what Playwright's check names missing after each install.
  const machine = (given: {
    cached?: readonly string[]
    local?: boolean[]
    afterward?: (readonly string[] | undefined)[]
    download?: boolean
    installDeps?: boolean
  }) => {
    const calls: string[] = []
    let folder = [...(given.cached ?? [])]
    const afterward = [...(given.afterward ?? [[]])]
    const locals = [...(given.local ?? [])]
    const fake: Machine = {
      debs: () => folder,
      local: (files) => (calls.push(`install ${files.length}`), locals.shift() ?? true),
      // What the test scripted, `undefined` (couldn't tell) included; none once it runs out.
      missing: () => (afterward.length > 0 ? afterward.shift() : []),
      clear: () => {
        calls.push("clear")
        folder = []
      },
      download: (packages) => {
        calls.push(`download ${packages.join(" ")}`)
        if (given.download === false) return false
        folder = [...folder, "a.deb", "b.deb"]
        return true
      },
      installDeps: () => (calls.push("install-deps"), given.installDeps ?? true),
      log: () => {},
    }
    return { fake, calls }
  }
  const nine = ["fonts-unifont", "xfonts-utils"]

  it("installs from the cache with apt, downloading nothing, where the check then names none", () => {
    const { fake, calls } = machine({ cached: ["a.deb", "b.deb"] })
    expect(install(nine, fake)).toEqual({ path: "cache", fetched: false })
    expect(calls).toEqual(["install 2"])
  })

  it("downloads through apt where nothing is cached, installs the download and saves it", () => {
    const { fake, calls } = machine({})
    expect(install(nine, fake)).toEqual({ path: "apt", fetched: true })
    expect(calls).toEqual(["clear", "download fonts-unifont xfonts-utils", "install 2"])
  })

  it("goes to apt where the cache covers only some, as the check still names one", () => {
    const { fake, calls } = machine({ cached: ["a.deb"], afterward: [["xfonts-utils"], []] })
    expect(install(nine, fake)).toEqual({ path: "apt", fetched: true })
    // The download goes into an emptied folder: only its own two debs are installed.
    expect(calls).toEqual([
      "install 1",
      "clear",
      "download fonts-unifont xfonts-utils",
      "install 2",
    ])
  })

  it("goes to the download where the cache can't be installed (a stale cache, unchanged), or the check can't tell after it", () => {
    expect(install(nine, machine({ cached: ["a.deb"], local: [false, true] }).fake).path).toBe(
      "apt",
    )
    expect(
      install(nine, machine({ cached: ["a.deb"], afterward: [undefined, []] }).fake).path,
    ).toBe("apt")
  })

  it("fails where apt's download fails, or the check still names some after it", () => {
    expect(() => install(nine, machine({ download: false }).fake)).toThrow("couldn't be downloaded")
    expect(() => install(nine, machine({ afterward: [["xfonts-utils"]] }).fake)).toThrow(
      "still names some missing",
    )
  })

  context("as the cache ages across image builds", () => {
    it("never rewrites an exact hit", () => {
      const { fake, calls } = machine({ cached: ["a.deb", "b.deb"] })
      const outcome = install(nine, fake)
      expect(outcome.path).toBe("cache")
      expect(saves(outcome, true)).toBe(false)
      expect(calls).toEqual(["install 2"])
    })

    it("saves an earlier build's debs under the new key where they install, reaching no mirror", () => {
      const { fake, calls } = machine({ cached: ["a.deb", "b.deb"] })
      const outcome = install(nine, fake)
      expect(saves(outcome, false)).toBe(true)
      expect(calls).not.toContainEqual(expect.stringMatching(/^download/))
    })

    // Debs the new build can't take (a dependency's version moved): apt changes nothing, the
    // folder is emptied, and a fresh download is installed and saved under the new key.
    it("replaces an earlier build's debs that don't install with a fresh download, and saves that", () => {
      const { fake, calls } = machine({ cached: ["old.deb"], local: [false, true] })
      const outcome = install(nine, fake)
      expect(outcome).toEqual({ path: "apt", fetched: true })
      expect(saves(outcome, false)).toBe(true)
      expect(calls).toEqual([
        "install 1",
        "clear",
        "download fonts-unifont xfonts-utils",
        "install 2",
      ])
    })

    it("saves nothing Playwright installed itself", () => {
      expect(saves({ path: "install-deps", fetched: false }, false)).toBe(false)
    })
  })

  it("installs with Playwright where the check couldn't tell what's missing", () => {
    for (const unknown of [undefined, []]) {
      const { fake, calls } = machine({})
      expect(install(unknown, fake)).toEqual({ path: "install-deps", fetched: false })
      expect(calls).toEqual(["install-deps"])
    }
    expect(() => install(undefined, machine({ installDeps: false }).fake)).toThrow(
      "couldn't be installed",
    )
  })

  // `apt-get install --no-download` resolves first and changes nothing where it can't, so a
  // stale cache on a later image leaves the system as it was for the download after it; `dpkg -i`
  // would leave packages unconfigured, and apt would then refuse to download.
  it("installs debs with apt and no download, never dpkg -i", () => {
    const source = readFileSync(join(import.meta.dirname, "browser-packages.ts"), "utf8")
    expect(source).toContain(
      'sudo(["apt-get", "install", "-y", "--no-install-recommends", "--no-download", ...files])',
    )
    expect(source).not.toMatch(/"dpkg",\s*"-i"/)
  })

  // Each attempt refreshes the lists, so a mirror back mid-step serves the next one.
  it("refreshes apt's lists and downloads in one attempt, quoting what it passes", () => {
    expect(downloadScript("/tmp/browser packages", ["fonts-unifont", "x'y"])).toBe(
      "apt-get update -qq && apt-get install -y --no-install-recommends --download-only -o 'Dir::Cache::archives=/tmp/browser packages' 'fonts-unifont' 'x'\\''y'",
    )
    const said = spawnSync(
      "sh",
      [
        "-c",
        `set -- ${downloadScript("/a b", ["c'd"]).split("--download-only ")[1]}; printf '%s|' "$@"`,
      ],
      { encoding: "utf8" },
    )
    expect(said.stdout).toBe("-o|Dir::Cache::archives=/a b|c'd|")
  })

  // pnpm's "Scope:" preamble, printed where it finds the install stale, would change the key.
  it("runs Playwright through pnpm without its install check", () => {
    for (const file of ["browser-dependencies.ts", "browser-packages.ts"]) {
      const source = readFileSync(join(import.meta.dirname, file), "utf8")
      const calls = source.match(/"pnpm",\s*\[?\s*"[^"]+"/g) ?? []
      expect(calls.length, file).toBeGreaterThan(0)
      for (const call of calls)
        expect(call, file).toContain('"--config.verify-deps-before-run=false"')
    }
  })

  // apt's own retries over a dead mirror took the whole 180 s limit on each attempt on 11-11.
  it("has apt fail fast in its own calls, each bounded by a healthy install's time with room", () => {
    expect(failFast).toContain('Acquire::Retries "0";')
    // apt-get update exits 0 where it reached no mirror, unless told otherwise.
    expect(failFast).toContain('APT::Update::Error-Mode "any";')
    expect(failFast).toMatch(/Acquire::https::Timeout "10";/)
    expect(aptPlan.limitSeconds).toBe(90)
    const source = readFileSync(join(import.meta.dirname, "browser-packages.ts"), "utf8")
    // Written for this step's calls and removed after, never left for later steps.
    expect(source).toContain('sudo(["rm", "-f", failFastFile])')
    expect(source.match(/finally \{\n\s+sudo\(\["rm", "-f", failFastFile\]\)/g)).toHaveLength(2)
  })
})

describe("a setup command's retries", () => {
  it("wait longer before each, one fewer than the attempts", () => {
    expect(waits(plan)).toEqual([30, 60])
    expect(waits({ ...plan, attempts: 1 })).toEqual([])
  })

  // Bounded: a mirror that never answers ends the step in about ten minutes, not the job's.
  it("end within a bound a few minutes long", () => {
    expect(longest(plan)).toBe(3 * 180 + 30 + 60 + 2 * 30)
    expect(longest(plan)).toBeLessThanOrEqual(12 * 60)
  })

  it("say what failed in one error line, and that the mirrors were unreachable only where apt said so", () => {
    expect(failure("The test browser's system packages couldn't be installed", plan)).toBe(
      "::error title=Setup::The test browser's system packages couldn't be installed (3 attempts, 30 s, 60 s apart)",
    )
    for (const said of [
      "Temporary failure resolving 'azure.archive.ubuntu.com'",
      "E: Failed to fetch http://azure.archive.ubuntu.com/ubuntu/pool/main/x.deb",
    ])
      expect(failure("Packages", plan, `W: Some index files failed to download\n${said}`)).toBe(
        "::error title=Setup::Packages: Ubuntu's mirrors unreachable (3 attempts, 30 s, 60 s apart)",
      )
  })

  // In the outage apt's update outlived each 90 s attempt and printed nothing in it.
  it("say where every attempt ran out its time, and nothing of it where one didn't", () => {
    expect(failure("Packages", plan, "", true)).toBe(
      "::error title=Setup::Packages: no answer within 180 s an attempt (the mirrors unreachable or slow) (3 attempts, 30 s, 60 s apart)",
    )
    expect(failure("Packages", plan, "Temporary failure resolving 'x'", true)).toContain(
      ": Ubuntu's mirrors unreachable (",
    )
    expect(failure("Packages", plan, "", false)).toBe(
      "::error title=Setup::Packages (3 attempts, 30 s, 60 s apart)",
    )
  })

  // On #869's outage run attempt 1's apt still held the lists' lock past the wait, and attempt
  // 2 failed on it at once: where a command runs no dpkg, the leftover apt is ended.
  context("an apt left running past the wait", () => {
    it("is ended, and the retry goes on once none is left", () => {
      let killed = false
      expect(
        reaped(
          () => false,
          () => (killed = true),
          () => true,
        ),
      ).toBe(true)
      expect(killed).toBe(true)
    })

    it("is left alone while a dpkg runs, which ending would leave half done", () => {
      let killed = false
      expect(
        reaped(
          (name) => name === "dpkg",
          () => (killed = true),
          () => true,
        ),
      ).toBe(false)
      expect(killed).toBe(false)
    })

    it("is ended only on the download path, which runs no dpkg", () => {
      const source = readFileSync(join(import.meta.dirname, "browser-packages.ts"), "utf8")
      expect(source).toContain("{ ...aptPlan, reap: true }")
      expect(source.match(/reap: true/g)).toHaveLength(1)
      expect(plan.reap).toBeUndefined()
    })
  })

  // sudo runs apt in a session of its own, which timeout's SIGKILL doesn't reach.
  it("wait before a retry for an apt or dpkg the last attempt left, a bounded time", () => {
    const left = new Set(["dpkg"])
    let asked = 0
    // dpkg is still there for the first two looks, then gone.
    expect(settled(5, (name) => ((asked += 1), left.has(name) && asked < 6))).toBe(true)
    expect(asked).toBeGreaterThan(3)
    expect(settled(0, (name) => name === "apt-get")).toBe(false)
    expect(settled(0, () => false)).toBe(true)
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
    const fast = { ...process.env, NOVADECK_SETUP_RETRY_FAST: "true" }

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
        env: { ...fast, NOVADECK_SETUP_RETRY_LIMIT: "1" },
        encoding: "utf8",
      })
      expect(result.status).toBe(124)
      expect(Date.now() - started).toBeLessThan(15_000)
    })

    // apt under sudo runs in a session of its own and outlived the attempt, holding its output:
    // the attempt must still end at its limit, not when the escaped process does.
    it.skipIf(process.platform !== "linux")(
      "end at its limit though a process it started escaped its group",
      () => {
        const started = Date.now()
        const result = spawnSync(
          process.execPath,
          [script, "mirrors", "--", "sh", "-c", "setsid sleep 25 & sleep 25"],
          { env: { ...fast, NOVADECK_SETUP_RETRY_LIMIT: "1" }, encoding: "utf8" },
        )
        expect(result.status).toBe(124)
        expect(Date.now() - started).toBeLessThan(12_000)
      },
    )

    it("refuse a call without a command", () => {
      const result = spawnSync(process.execPath, [script, "mirrors"], { encoding: "utf8" })
      expect(result.status).toBe(2)
    })
  })
})

describe("the test browser's install, where a job makes it", () => {
  // Quality's test jobs, the Counter run, the setup action (Nightly Quality's) and Warm Caches
  // each install the browser alone where its cache missed, then its system packages on Linux
  // through the browser-packages action.
  const places = [
    [".github/workflows/quality.yml", "matrix.browser", " && runner.os == 'Linux'"],
    [".github/workflows/benchmark.yml", "steps.changes.outputs.counts == 'true'", ""],
    [".github/actions/setup/action.yml", "inputs.browser == 'true'", " && runner.os == 'Linux'"],
  ] as const
  const step = (text: string, name: string) => {
    const start = text.indexOf(`- name: ${name}\n`)
    return start < 0 ? "" : text.slice(start, text.indexOf("\n\n", start))
  }
  const read = (file: string) => readFileSync(join(root, file), "utf8")

  it.each(places)(
    "downloads %s's browser alone on Linux where the cache missed, through the retry",
    (file, asked) => {
      const download = step(read(file), "Install Test Browser")
      expect(download).toContain(`if: ${asked} && steps.browser-cache.outputs.cache-hit != 'true'`)
      expect(download).toContain('deps=--with-deps; [ "$RUNNER_OS" = Linux ] && deps=')
      expect(download).toMatch(
        /node scripts\/ci\/setup\/retry\.ts "[^"]+" \\\n\s+-- pnpm --filter @novadeck\/specs exec playwright install \$deps chromium/,
      )
    },
  )

  it.each(places)(
    "installs %s's browser's system packages on Linux after the browser",
    (file, asked, linux) => {
      const text = read(file)
      const packages = step(text, "Test Browser Packages")
      expect(packages).toContain(`if: ${asked}${linux}\n`)
      expect(packages).toContain("uses: ./.github/actions/browser-packages")
      expect(text.indexOf("- name: Install Test Browser\n")).toBeLessThan(
        text.indexOf("- name: Test Browser Packages"),
      )
      expect(text).not.toContain("playwright install-deps chromium")
    },
  )

  // A pull request reads main's caches, never another's: Warm Caches fills the debs' on main.
  it("has Warm Caches fill the packages' cache on main, on Linux", () => {
    const warm = read(".github/workflows/warm.yml")
    expect(step(warm, "Test Browser Packages")).toContain("if: runner.os == 'Linux'")
    expect(step(warm, "Test Browser Packages")).toContain(
      "uses: ./.github/actions/browser-packages",
    )
  })

  context("the browser-packages action", () => {
    const action = read(".github/actions/browser-packages/action.yml")

    // A check that fails leaves `missing` empty, which installs, as the action says.
    it("checks first, and a check that fails falls through to installing", () => {
      const check = step(action, "Check Test Browser Packages")
      expect(check).toContain("continue-on-error: true")
      expect(check).toContain(
        'node scripts/ci/setup/browser-dependencies.ts "$PLAYWRIGHT_BROWSERS_PATH"',
      )
      expect(step(action, "Install Test Browser Packages")).toContain(
        "if: steps.check.outputs.missing != '0'",
      )
    })

    it("restores the debs by the exact key, an earlier image build's by its prefix, and saves as the script says", () => {
      const restore = step(action, "Restore Test Browser Packages")
      expect(restore).toContain("key: ${{ steps.check.outputs.key }}")
      expect(restore).toContain("restore-keys: ${{ steps.check.outputs.prefix }}")
      expect(step(action, "Install Test Browser Packages")).toContain(
        "EXACT_HIT: ${{ steps.cache.outputs.cache-hit }}",
      )
      expect(step(action, "Save Test Browser Packages")).toContain(
        "if: steps.install.outputs.save == 'true' && steps.check.outputs.key != ''",
      )
      for (const name of ["Restore Test Browser Packages", "Save Test Browser Packages"])
        expect(step(action, name)).toContain("path: ${{ runner.temp }}/browser-packages")
      expect(step(action, "Install Test Browser Packages")).toContain(
        'node scripts/ci/setup/browser-packages.ts "$RUNNER_TEMP/browser-packages"',
      )
    })
  })

  // The skip in the install's shell: Linux downloads the browser alone.
  it.skipIf(process.platform === "win32").each([
    ["Linux", ""],
    ["macOS", "--with-deps"],
    ["Windows", "--with-deps"],
  ])("downloads on %s as `install %s chromium`", (os, deps) => {
    const line = 'deps=--with-deps; [ "$RUNNER_OS" = Linux ] && deps=; echo "$deps"'
    const said = spawnSync("bash", ["-ec", line], {
      env: { ...process.env, RUNNER_OS: os },
      encoding: "utf8",
    })
    expect(said.status).toBe(0)
    expect(said.stdout.trim()).toBe(deps)
  })

  it("is Playwright's dry run, which reaches no network", () => {
    const source = readFileSync(join(import.meta.dirname, "browser-dependencies.ts"), "utf8")
    expect(source).toMatch(/"install-deps",\s*"--dry-run",\s*"chromium"/)
  })
})
