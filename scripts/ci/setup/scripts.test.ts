import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, vi } from "vitest"

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
  alternateSources,
  aptPlan,
  attemptSources,
  downloadScript,
  failFast,
  fallbackFor,
  fallbacks,
  install,
  localInstall,
  type Machine,
  mirrorList,
  namesArchive,
  saves,
  tidy,
} from "./browser-packages.ts"
import {
  bounded,
  downloadWrapper,
  failure,
  longest,
  plan,
  reaped,
  run,
  settled,
  waits,
} from "./retry.ts"

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
  it("installs debs with apt, its sources pointed at nothing, never dpkg -i", () => {
    const source = readFileSync(join(import.meta.dirname, "browser-packages.ts"), "utf8")
    expect(source).toContain('local: (files) => sudo(["apt-get", ...localInstall(folder, files)])')
    expect(source).not.toMatch(/"dpkg",\s*"-i"/)
    expect(localInstall("/f", ["/f/a.deb"])).toEqual([
      "-o",
      "Dir::Etc::sourcelist=/dev/null",
      "-o",
      "Dir::Etc::sourceparts=/dev/null",
      "-o",
      "Dir::Cache::pkgcache=",
      "-o",
      "Dir::Cache::srcpkgcache=",
      "-o",
      "Dir::Cache::archives=/f",
      "-o",
      "APT::Sandbox::User=root",
      "install",
      "-y",
      "--no-install-recommends",
      "--no-download",
      "/f/a.deb",
    ])
  })

  // Each attempt refreshes the lists, so a mirror back mid-step serves the next one.
  it("refreshes apt's lists and downloads in one attempt, quoting what it passes", () => {
    expect(downloadScript("/tmp/browser packages", ["fonts-unifont", "x'y"])).toBe(
      "apt-get -o 'APT::Sandbox::User=root' update -qq && apt-get -o 'APT::Sandbox::User=root' install -y --no-install-recommends --download-only -o 'Dir::Cache::archives=/tmp/browser packages' 'fonts-unifont' 'x'\\''y'",
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

describe("the browser packages' download through other mirrors", () => {
  const ubuntuSources = [
    "Types: deb",
    "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
    "Suites: resolute resolute-updates resolute-backports resolute-security",
    "Components: main universe restricted multiverse",
    "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
    "",
    "Types: deb",
    "URIs: https://packages.microsoft.com/ubuntu/26.04/prod",
    "Suites: resolute",
    "Signed-By: /usr/share/keyrings/microsoft.gpg",
  ].join("\n")

  // apt shuffles mirrors of equal priority and tries the lower first.
  it("lists the fallback mirrors before the image's own by priority, without its comments", () => {
    const image =
      "# the image's\nhttp://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttp://archive.ubuntu.com/ubuntu/\n"
    expect(mirrorList(image, ["http://mirrors.kernel.org/ubuntu/"])).toBe(
      "http://mirrors.kernel.org/ubuntu/\tpriority:1\nhttp://azure.archive.ubuntu.com/ubuntu/\tpriority:10\nhttp://archive.ubuntu.com/ubuntu/\tpriority:10\n",
    )
  })

  // The mirrors only carry bytes: the image's keys verify them, so nothing about trust changes.
  it("points only the Ubuntu archive at its own list, keeping every Signed-By", () => {
    const alternate = alternateSources(ubuntuSources, "/tmp/m/apt-mirrors.txt")
    expect(alternate).toContain("URIs: mirror+file:/tmp/m/apt-mirrors.txt")
    expect(alternate).not.toContain("/etc/apt/apt-mirrors.txt")
    expect(alternate).toContain("URIs: https://packages.microsoft.com/ubuntu/26.04/prod")
    expect(alternate.match(/Signed-By:/g)).toHaveLength(2)
    expect(
      alternate.replace(
        "mirror+file:/tmp/m/apt-mirrors.txt",
        "mirror+file:/etc/apt/apt-mirrors.txt",
      ),
    ).toBe(ubuntuSources)
    expect(alternateSources("deb http://archive.ubuntu.com/ubuntu/ resolute main", "/l")).toBe(
      "deb mirror+file:/l resolute main",
    )
  })

  it.each([
    ["the image's mirror list", "URIs: mirror+file:/etc/apt/apt-mirrors.txt"],
    ["Azure's name", "deb http://azure.archive.ubuntu.com/ubuntu/ resolute main"],
    ["a country's, without the slash", "deb http://pl.archive.ubuntu.com/ubuntu resolute main"],
    ["security's, over https", "deb https://security.ubuntu.com/ubuntu/ resolute-security main"],
  ])("finds the archive by %s, and points it at the attempt's list", (_name, line) => {
    expect(namesArchive(line)).toBe(true)
    expect(alternateSources(line, "/l")).toMatch(/mirror\+file:\/l(\s|$)/)
    expect(alternateSources(line, "/l")).not.toMatch(/ubuntu\.com|apt-mirrors\.txt/)
  })

  it.each([
    ["Microsoft's", "deb https://packages.microsoft.com/ubuntu/26.04/prod resolute main"],
    ["a PPA", "URIs: https://ppa.launchpadcontent.net/git-core/ppa/ubuntu/"],
    [
      "a name that only contains the archive's",
      "deb http://archive.ubuntu.com.example/ubuntu x main",
    ],
  ])("leaves %s source alone", (_name, line) => {
    expect(namesArchive(line)).toBe(false)
    expect(alternateSources(line, "/l")).toBe(line)
  })

  // A third-party repository's hiccup would fail the update at every level with
  // `Error-Mode "any"`, where the fonts need only the archive.
  it("gives each attempt only the sources that name the archive, the image's list kept at level 0", () => {
    const files = [
      ["ubuntu.sources", ubuntuSources.split("\n\n")[0]!],
      [
        "microsoft-prod.list",
        "deb [arch=amd64] https://packages.microsoft.com/ubuntu/26.04/prod resolute main",
      ],
    ] as const
    expect(attemptSources(files, 0, "/l")).toEqual([["ubuntu.sources", files[0][1]]])
    expect(attemptSources(files, 1, "/l")).toEqual([
      ["ubuntu.sources", alternateSources(files[0][1], "/l")],
    ])
    expect(attemptSources(files, 1, "/l")[0]![1]).toContain(
      "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
    )
  })

  it("runs a fallback's apt on its own sources and lists, the system's left as they are", () => {
    const script = downloadScript("/r/browser-packages", ["fonts-unifont"], {
      parts: "/r/p",
      lists: "/r/l",
    })
    const own =
      "apt-get -o 'Dir::Etc::sourcelist=/dev/null' -o 'Dir::Etc::sourceparts=/r/p' -o 'Dir::State::Lists=/r/l' -o 'Dir::Cache::pkgcache=' -o 'Dir::Cache::srcpkgcache=' -o 'APT::Sandbox::User=root'"
    expect(script).toBe(
      `${own} update -qq && ${own} install -y --no-install-recommends --download-only -o 'Dir::Cache::archives=/r/browser-packages' 'fonts-unifont'`,
    )
    for (const unsafe of ["trusted", "allow-unauthenticated", "AllowInsecure", "allow-insecure"])
      expect(script).not.toContain(unsafe)
    expect(downloadScript("/r/b", ["x"])).not.toContain("Dir::Etc")
  })

  it("turns to the next mirror only after one couldn't be reached, and stays on the last", () => {
    const resolve = {
      status: 100,
      output: "E: Failed to fetch … Temporary failure resolving 'archive.ubuntu.com'",
      timedOut: false,
    }
    const hung = { status: 124, output: "", timedOut: true }
    const lock = {
      status: 100,
      output: "E: Could not get lock /var/lib/apt/lists/lock",
      timedOut: false,
    }
    expect(fallbackFor([])).toBe(0)
    expect(fallbackFor([lock])).toBe(0)
    expect(fallbackFor([resolve])).toBe(1)
    expect(fallbackFor([hung, resolve])).toBe(2)
    expect(fallbackFor([hung, hung, hung])).toBe(2)
    expect(fallbacks.map(({ name }) => name)).toEqual([
      "the image's mirrors",
      "Azure's mirror by its Traffic Manager name",
      "kernel.org's mirror",
    ])
    expect(fallbacks[0]!.mirrors).toEqual([])
    expect(fallbacks[1]!.mirrors).toEqual(["http://ubuntu-archive-asm.trafficmanager.net/ubuntu/"])
    expect(fallbacks[2]!.mirrors[0]).toBe("http://mirrors.kernel.org/ubuntu/")
  })

  // The download as the retry runs it, each fallback a command that fails as an unreachable
  // mirror does or passes: which were tried, and what the step ends with.
  context("as the retry runs it", () => {
    // Its lines are workflow commands: printed on CI they would read as the run's own errors.
    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {})
      vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    })
    afterEach(() => vi.restoreAllMocks())

    const quick = { ...plan, attempts: 3, firstWaitSeconds: 0, settleSeconds: 0, limitSeconds: 5 }
    const through = (passing: number | undefined) => {
      const tried: number[] = []
      const status = run(
        "Packages",
        (failures) => {
          const level = fallbackFor(failures)
          tried.push(level)
          return level === passing
            ? ["sh", "-c", "exit 0"]
            : [
                "sh",
                "-c",
                "echo \"E: Failed to fetch x  Temporary failure resolving 'archive.ubuntu.com'\"; exit 100",
              ]
        },
        quick,
      )
      return { tried, status }
    }

    it.skipIf(process.platform === "win32")(
      "never consults a fallback where the image's mirrors work",
      () => {
        expect(through(0)).toEqual({ tried: [0], status: 0 })
      },
    )

    it.skipIf(process.platform === "win32")(
      "turns to Azure's mirror by its other name where the image's can't be reached",
      () => {
        expect(through(1)).toEqual({ tried: [0, 1], status: 0 })
      },
    )

    it.skipIf(process.platform === "win32")(
      "turns to kernel.org's where Azure's can't be reached either",
      () => {
        expect(through(2)).toEqual({ tried: [0, 1, 2], status: 0 })
      },
    )

    it.skipIf(process.platform === "win32")(
      "fails saying the mirrors were unreachable where none could be reached",
      () => {
        expect(through(undefined)).toEqual({ tried: [0, 1, 2], status: 100 })
      },
    )
  })
})

// The real command against real debs, as the fake machine stands in for apt: on #869's run of
// 11-11 the command it faked installed nothing. Unprivileged: apt simulates the install and
// runs its fetch stage, where that run failed, with its locking off; only dpkg's unpack, which
// needs root, is left out. Where apt and dpkg-deb are (Linux CI's Ubuntu).
describe.skipIf(!existsSync("/usr/bin/apt-get") || !existsSync("/usr/bin/dpkg-deb"))(
  "installing debs with apt, for real",
  () => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-debs-"))
    afterAll(() => rmSync(folder, { recursive: true, force: true }))
    // A package of one file, depending on `depends` where given, its file named as apt names
    // what it downloads (`<package>_<version>_<arch>.deb`), which `--no-download` looks for.
    const deb = (name: string, depends?: string): string => {
      const tree = join(folder, name)
      mkdirSync(join(tree, "DEBIAN"), { recursive: true })
      mkdirSync(join(tree, "usr", "share", "doc", name), { recursive: true })
      writeFileSync(
        join(tree, "DEBIAN", "control"),
        [
          `Package: ${name}`,
          "Version: 1.0",
          "Architecture: all",
          "Maintainer: Novadeck <ci@novadeck.invalid>",
          "Description: a probe of installing local debs",
          ...(depends ? [`Depends: ${depends}`] : []),
          "",
        ].join("\n"),
      )
      writeFileSync(join(tree, "usr", "share", "doc", name, "README"), "probe\n")
      execFileSync(
        "dpkg-deb",
        ["--root-owner-group", "--build", tree, join(folder, `${name}_1.0_all.deb`)],
        {
          stdio: "ignore",
        },
      )
      return join(folder, `${name}_1.0_all.deb`)
    }
    const apt = (args: readonly string[]) =>
      spawnSync("apt-get", ["-o", "Debug::NoLocking=1", ...args], { encoding: "utf8" })

    // apt's install phase without root: dpkg works on a copy of its state in a folder of its
    // own (`target`), so nothing of the machine's changes.
    const relocatedRoot = (name: string) => {
      const target = join(folder, name)
      const dpkg = join(target, "var", "lib", "dpkg")
      mkdirSync(join(dpkg, "updates"), { recursive: true })
      mkdirSync(join(dpkg, "info"), { recursive: true })
      mkdirSync(join(target, "log"), { recursive: true })
      writeFileSync(join(dpkg, "status"), readFileSync("/var/lib/dpkg/status"))
      writeFileSync(join(dpkg, "available"), "")
      const relocated = [
        "-o",
        `Dir::State::status=${join(dpkg, "status")}`,
        "-o",
        `Dir::State::extended_states=${join(target, "extended_states")}`,
        "-o",
        `Dir::Log=${join(target, "log")}`,
        "-o",
        `DPkg::Options::=--admindir=${dpkg}`,
        "-o",
        `DPkg::Options::=--root=${target}`,
        "-o",
        "DPkg::Options::=--force-not-root",
        "-o",
        "DPkg::Options::=--force-script-chrootless",
        "-o",
        "DPkg::Options::=--log=/dev/null",
        "-o",
        "DPkg::NoTriggers=1",
        "-o",
        "DPkg::ConfigurePending=0",
        "-o",
        "Dpkg::Use-Pty=0",
        "-o",
        `APT::Sandbox::User=${userInfo().username}`,
      ]
      return { target, relocated }
    }

    it("installs the files, a dependency among them ordered first, from no mirror", () => {
      const a = deb("novadeck-probe-a")
      const b = deb("novadeck-probe-b", "novadeck-probe-a")
      const said = apt(["-s", ...localInstall(folder, [b, a])])
      expect(said.status, said.stderr).toBe(0)
      expect(said.stdout).toMatch(/^Inst novadeck-probe-a \(1\.0 local-deb/m)
      expect(said.stdout).toMatch(/^Inst novadeck-probe-b \(1\.0 local-deb/m)
      expect(said.stdout.indexOf("Inst novadeck-probe-a")).toBeLessThan(
        said.stdout.indexOf("Inst novadeck-probe-b"),
      )
    })

    // The stage #869's run failed at: apt "fetches" local debs, which reaches no network.
    it("fetches the files themselves, with --no-download", () => {
      const a = deb("novadeck-probe-c")
      mkdirSync(join(folder, "partial"), { recursive: true })
      const said = apt(["--download-only", ...localInstall(folder, [a])])
      expect(said.status, said.stderr).toBe(0)
      expect(said.stdout).toContain("Download complete and in download only mode")
      expect(said.stdout).not.toMatch(/https?:\/\//)
    })

    // #869's run on 11-11: the system's sources knew the archive's copy of each font at the
    // same version, apt took that as the candidate, which needs a download, and --no-download
    // refused it ("Unable to fetch some archives"). A source at an address nothing answers,
    // its index written straight into the lists, stands in for the archive here.
    it("takes the files, not a source's copy of the same version, which would need a download", () => {
      const a = deb("novadeck-probe-e")
      const lists = join(folder, "lists")
      const archives = join(folder, "archives-e")
      mkdirSync(join(lists, "partial"), { recursive: true })
      mkdirSync(join(archives, "partial"), { recursive: true })
      const control = execFileSync("dpkg-deb", ["-f", a, "Package", "Version", "Architecture"], {
        encoding: "utf8",
      })
      const digest = execFileSync("sha256sum", [a], { encoding: "utf8" }).split(" ")[0]
      writeFileSync(
        join(lists, "127.0.0.1:9_repo_._Packages"),
        `${control.trim()}\nFilename: ./novadeck-probe-e_1.0_all.deb\nSize: ${readFileSync(a).length}\nSHA256: ${digest}\n\n`,
      )
      const sources = join(folder, "remote.list")
      writeFileSync(sources, "deb [trusted=yes] http://127.0.0.1:9/repo ./\n")
      const at = [
        "-o",
        `Dir::State::Lists=${lists}`,
        "-o",
        `Dir::Cache::archives=${archives}`,
        "-o",
        "Dir::Cache::pkgcache=",
        "-o",
        "Dir::Cache::srcpkgcache=",
        "-o",
        "Dir::Etc::sourceparts=/dev/null",
        "-o",
        `Dir::Etc::sourcelist=${sources}`,
        "--download-only",
      ]
      // As before: the source's copy is the candidate, and nothing can be fetched.
      const before = apt([...at, "install", "-y", "--no-install-recommends", "--no-download", a])
      expect(before.status).toBe(100)
      expect(`${before.stdout}${before.stderr}`).toContain("Unable to fetch some archives")
      // As now: its own options, after, point the sources at nothing, and the file is taken.
      const now = apt([...at, ...localInstall(folder, [a])])
      expect(now.status, now.stderr).toBe(0)
      expect(now.stdout).toContain("Download complete and in download only mode")
    })

    // The install phase itself, which simulating and fetching never reach: the run after the
    // sources were pointed at nothing failed there, on the file's bare name, as apt's archives
    // were elsewhere. dpkg works on a copy of its state in a folder of its own, so no root is
    // needed and nothing of the machine's changes.
    it("unpacks the files, where apt's archives are their folder", () => {
      const a = deb("novadeck-probe-f")
      const { target, relocated } = relocatedRoot("root")
      const elsewhere = join(folder, "elsewhere")
      mkdirSync(join(elsewhere, "partial"), { recursive: true })
      const own = localInstall(folder, [a])
      // As before: apt's archives elsewhere, and its install phase failed on the bare name.
      const before = apt([
        ...own.slice(0, 8),
        "-o",
        `Dir::Cache::archives=${elsewhere}`,
        ...own.slice(10, -5),
        ...relocated,
        ...own.slice(-5),
      ])
      expect(`${before.stdout}${before.stderr}`).toContain("Pathname to install is not absolute")
      // As now, with apt reading the files as this user, who owns them here.
      // The relocated options' sandbox user, after, reads the files as this user, who owns them.
      const now = apt([...own.slice(0, -5), ...relocated, ...own.slice(-5)])
      expect(now.status, `${now.stdout}${now.stderr}`).toBe(0)
      expect(existsSync(join(target, "usr", "share", "doc", "novadeck-probe-f", "README"))).toBe(
        true,
      )
    })

    // On the run after, apt (as root) left its archives lock and partial/ in the folder, and
    // the cache's save, as the runner, could read neither and saved nothing.
    it("leaves the folder only the runner's debs once tidied after an install", () => {
      const debs = join(folder, "tidy")
      mkdirSync(debs, { recursive: true })
      const a = deb("novadeck-probe-g")
      const kept = join(debs, "novadeck-probe-g_1.0_all.deb")
      writeFileSync(kept, readFileSync(a))
      const { relocated } = relocatedRoot("root-g")
      const own = localInstall(debs, [kept])
      const said = apt([...own.slice(0, -5), ...relocated, ...own.slice(-5)])
      expect(said.status, `${said.stdout}${said.stderr}`).toBe(0)
      // apt made partial/ in it; with its locking on (as root, on a runner) its lock too, which
      // this unprivileged run can't take, so it is written here as apt would.
      expect(readdirSync(debs)).toContain("partial")
      writeFileSync(join(debs, "lock"), "")
      const as = (args: readonly string[]) => spawnSync(args[0]!, args.slice(1)).status === 0
      tidy(debs, as, process.getuid!())
      expect(readdirSync(debs)).toEqual(["novadeck-probe-g_1.0_all.deb"])
      expect(statSync(kept).uid).toBe(process.getuid!())
    })

    it("changes nothing where a dependency can't be met", () => {
      const lone = deb("novadeck-probe-d", "novadeck-probe-missing")
      const said = apt(["-s", ...localInstall(folder, [lone])])
      expect(said.status).toBe(100)
      // In apt 2.8's words and apt 3's alike (the runners have apt 3): the dependency named,
      // and nothing to install.
      expect(`${said.stdout}${said.stderr}`).toContain(
        "novadeck-probe-d : Depends: novadeck-probe-missing but it is not installable",
      )
      expect(said.stdout).not.toMatch(/^Inst /m)
    })
  },
)

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

    // An `sh` left alive could start the download after its update is ended, taking the lock
    // again: it is ended first, by a pattern that matches that script alone.
    it("ends the download's own sh first, matched by its script alone", () => {
      const wrapper = new RegExp(downloadWrapper)
      for (const script of [
        downloadScript("/r/b", ["fonts-unifont"]),
        downloadScript("/r/b", ["fonts-unifont"], { parts: "/r/p", lists: "/r/l" }),
      ])
        expect(wrapper.test(`sh -c ${script}`), script).toBe(true)
      for (const other of [
        "sh -c apt-get update -qq && apt-get install -y --no-install-recommends fish",
        "apt-get update -qq",
        "sh -c pnpm exec playwright install-deps chromium",
      ])
        expect(wrapper.test(other), other).toBe(false)
      const source = readFileSync(join(import.meta.dirname, "retry.ts"), "utf8")
      expect(source.indexOf('["-f", downloadWrapper]')).toBeLessThan(
        source.indexOf('["-x", "apt-get"]'),
      )
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

    // A save that couldn't read the folder saved nothing, with a warning only: every run after
    // would go back to the mirrors without a word.
    it("says so loudly where the folder was to be saved and the key has no entry", () => {
      const saved = step(action, "Check Test Browser Packages Saved")
      expect(saved).toContain(
        "if: steps.install.outputs.save == 'true' && steps.check.outputs.key != ''",
      )
      expect(saved).toContain("lookup-only: true")
      expect(saved).toContain("key: ${{ steps.check.outputs.key }}")
      const say = step(action, "Say Test Browser Packages Weren't Saved")
      expect(say).toContain(
        "if: steps.saved.outcome == 'success' && steps.saved.outputs.cache-hit != 'true'",
      )
      expect(say).toContain(
        "::error title=Setup::The test browser's packages weren't saved under $KEY",
      )
      expect(action.indexOf("- name: Save Test Browser Packages")).toBeLessThan(
        action.indexOf("- name: Check Test Browser Packages Saved"),
      )
    })

    // apt, as root, leaves its lock and partial/ in the folder whenever it downloads or
    // installs from it: tidied after the install, however it ended, before the save reads it.
    it("tidies the folder after the install, however it ended", () => {
      const source = readFileSync(join(import.meta.dirname, "browser-packages.ts"), "utf8")
      expect(source).toMatch(
        /try \{\n\s+outcome = install\(named, machine\)\n\s+\} finally \{\n(?:\s+\/\/[^\n]*\n)*\s+tidy\(folder, sudo, process\.getuid\?\.\(\) \?\? 0\)/,
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
