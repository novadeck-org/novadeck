import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach } from "vitest"

import { context, describe, expect, it } from "../test"

const script = readFileSync(fileURLToPath(new URL("./install.sh", import.meta.url)), "utf8")

// The script is for Linux, and the tests stand in for the machine with a PATH of shims
// and the few real tools it needs, so which package managers exist is theirs to choose.
const linux = process.platform === "linux"

const tools = [
  "awk",
  "cat",
  "chmod",
  "cp",
  "grep",
  "ln",
  "mkdir",
  "mktemp",
  "mv",
  "rm",
  "sha256sum",
  "sort",
  "tail",
]

const deb = "novadeck-linux-amd64.deb"
const rpm = "novadeck-linux-x86_64.rpm"
const image = "novadeck-linux-x86_64.AppImage"

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex")

const shim = (folder: string, name: string, body: string) => {
  const path = join(folder, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// An AppImage that answers the one option the installer uses, the way the real one
// unpacks part of itself without FUSE.
const appImage = `#!/bin/sh
if [ "$1" = --appimage-extract ]; then
  mkdir -p squashfs-root/usr/share/icons/hicolor/512x512/apps
  printf png > squashfs-root/usr/share/icons/hicolor/512x512/apps/novadeck.png
fi
`

type Scenario = {
  /** Package managers present on the fake computer. */
  managers?: string[]
  uname?: { system?: string; machine?: string }
  root?: boolean
  sudo?: boolean
  /** Replaces the content a download is checked against, to fake a corrupt file. */
  tamper?: string
  script?: string
  /** An installed novadeck deb (if any) and the version of the deb the release carries. */
  dpkg?: { installed?: string; available: string }
  /** Tools present beyond the package managers, such as transactional-update. */
  extra?: string[]
  /** What `ldconfig -p` lists; the computer has no ldconfig on its PATH when unset. */
  libraries?: string
  /** Tools present only in the system folders a user's PATH lacks. */
  sbin?: string[]
  /** Pretends the ostree marker file exists. */
  ostree?: boolean
  /** Leaves the download folder unset, so the script builds it from its repository. */
  rendered?: boolean
}

const folders: string[] = []

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

const run = (scenario: Scenario = {}) => {
  const root = mkdtempSync(join(tmpdir(), "novadeck-install-"))
  folders.push(root)
  const bin = join(root, "bin")
  const served = join(root, "served")
  const home = join(root, "home")
  const log = join(root, "log")
  for (const folder of [bin, served, home]) mkdirSync(folder)
  writeFileSync(log, "")

  const files: Record<string, string> = {
    [deb]: "deb",
    [rpm]: "rpm",
    [image]: appImage,
  }
  for (const [name, content] of Object.entries(files)) writeFileSync(join(served, name), content)
  writeFileSync(
    join(served, "SHA256SUMS"),
    Object.entries(files)
      .map(([name, content]) => `${sha256(scenario.tamper ?? content)}  ${name}`)
      .join("\n") + "\n",
  )

  for (const tool of tools) {
    symlinkSync(["/usr/bin", "/bin"].map((d) => join(d, tool)).find(existsSync)!, join(bin, tool))
  }
  const { system = "Linux", machine = "x86_64" } = scenario.uname ?? {}
  shim(bin, "uname", `[ "$1" = -s ] && echo ${system} || echo ${machine}`)
  shim(bin, "id", `echo ${scenario.root ? 0 : 1000}`)
  shim(
    bin,
    "curl",
    `while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
echo "curl $url" >> "${log}"
cp "${served}/\${url##*/}" "$out"`,
  )
  if (scenario.sudo ?? true) shim(bin, "sudo", `SUDO=sudo "$@"`)
  for (const manager of scenario.managers ?? []) {
    shim(bin, manager, `echo "\${SUDO:+sudo }${manager} $*" >> "${log}"`)
  }

  for (const name of scenario.extra ?? []) shim(bin, name, `echo "${name} $*" >> "${log}"`)
  // The system folders the script searches are the test's own, so the host's tools never leak in.
  const sbin = join(root, "sbin")
  mkdirSync(sbin)
  if (scenario.libraries !== undefined) shim(bin, "ldconfig", `echo "${scenario.libraries}"`)
  if (scenario.sbin)
    for (const name of scenario.sbin) shim(sbin, name, `echo "${name} $*" >> "${log}"`)
  if (scenario.dpkg) {
    const { installed, available } = scenario.dpkg
    shim(bin, "dpkg-query", installed ? `echo "installed ${installed}"` : "exit 1")
    shim(bin, "dpkg-deb", `echo "${available}"`)
    shim(
      bin,
      "dpkg",
      `[ "$2" != "$4" ] && [ "$(printf '%s\\n%s\\n' "$2" "$4" | sort -V | tail -n 1)" = "$2" ]`,
    )
  }
  const marker = join(root, "ostree-booted")
  if (scenario.ostree) writeFileSync(marker, "")

  const text = (scenario.script ?? script).replaceAll("@REPOSITORY@", "acme/novadeck")
  const entry = join(root, "install.sh")
  writeFileSync(entry, text)
  const start = () =>
    spawnSync("/bin/sh", [entry], {
      env: {
        PATH: bin,
        HOME: home,
        NOVADECK_INSTALL_OSTREE_MARKER: marker,
        NOVADECK_INSTALL_SBIN_DIRS: sbin,
        ...(scenario.rendered ? {} : { NOVADECK_INSTALL_BASE_URL: `http://mirror.test/dl/` }),
      },
      encoding: "utf8",
    })
  const result = start()
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean)
  return {
    ...result,
    home,
    lines,
    installs: lines.filter((line) => !line.startsWith("curl")),
    again: start,
  }
}

describe.skipIf(!linux)("install.sh", () => {
  context("on a system with apt", () => {
    it("installs the deb through sudo after checking its checksum", () => {
      const result = run({ managers: ["apt-get"] })
      expect(result.status).toBe(0)
      expect(result.lines).toContain("curl http://mirror.test/dl/SHA256SUMS")
      expect(result.lines).toContain(`curl http://mirror.test/dl/${deb}`)
      expect(result.installs).toEqual([`sudo apt-get install -y ./${deb}`])
    })

    it("skips sudo for root", () => {
      const result = run({ managers: ["apt-get"], root: true, sudo: false })
      expect(result.status).toBe(0)
      expect(result.installs).toEqual([`apt-get install -y ./${deb}`])
    })

    it("asks for root when there is neither root nor sudo", () => {
      const result = run({ managers: ["apt-get"], sudo: false })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("needs root")
      expect(result.installs).toEqual([])
    })

    it("installs when the installed deb is older or the same", () => {
      for (const installed of ["1.0.0", "1.0.5"]) {
        const result = run({ managers: ["apt-get"], dpkg: { installed, available: "1.0.5" } })
        expect(result.installs).toEqual([`sudo apt-get install -y ./${deb}`])
      }
    })

    it("installs when no deb is installed", () => {
      const result = run({ managers: ["apt-get"], dpkg: { available: "1.0.5" } })
      expect(result.installs).toEqual([`sudo apt-get install -y ./${deb}`])
    })

    it("leaves a newer installed deb alone instead of downgrading it", () => {
      const result = run({
        managers: ["apt-get"],
        dpkg: { installed: "1.0.9", available: "1.0.5" },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("already installed")
      expect(result.installs).toEqual([])
    })

    it("is preferred over dnf", () => {
      const result = run({ managers: ["apt-get", "dnf"] })
      expect(result.installs).toEqual([`sudo apt-get install -y ./${deb}`])
    })
  })

  context("on a system with dnf or zypper", () => {
    it("installs the rpm with dnf", () => {
      const result = run({ managers: ["dnf"] })
      expect(result.status).toBe(0)
      expect(result.installs).toEqual([`sudo dnf install -y ./${rpm}`])
    })

    it("installs the rpm with zypper without prompting", () => {
      const result = run({ managers: ["zypper"] })
      expect(result.status).toBe(0)
      expect(result.installs).toEqual([
        `sudo zypper --non-interactive install --allow-unsigned-rpm ./${rpm}`,
      ])
    })
  })

  context("on a system with no known package manager", () => {
    it("installs the AppImage with a menu entry, an icon and a command", () => {
      const result = run()
      const data = join(result.home, ".local/share")
      const target = join(data, "novadeck/novadeck.AppImage")
      expect(result.status).toBe(0)
      expect(result.installs).toEqual([])
      expect(lstatSync(target).mode & 0o111).not.toBe(0)
      expect(readlinkSync(join(result.home, ".local/bin/novadeck"))).toBe(target)
      expect(readFileSync(join(data, "icons/hicolor/512x512/apps/novadeck.png"), "utf8")).toBe(
        "png",
      )
      const entry = readFileSync(join(data, "applications/dev.mzpk.novadeck.desktop"), "utf8")
      expect(entry).toContain(`Exec="${target}" %U`)
      expect(entry).toContain(`Icon=${join(data, "icons/hicolor/512x512/apps/novadeck.png")}`)
    })

    it("says when ~/.local/bin is not on the PATH", () => {
      const result = run()
      expect(result.stdout).toContain("to your PATH")
    })

    it("replaces the installed AppImage when run again", () => {
      const result = run()
      const target = join(result.home, ".local/share/novadeck/novadeck.AppImage")
      writeFileSync(target, "old")
      expect(result.again().status).toBe(0)
      expect(readFileSync(target, "utf8")).toBe(appImage)
    })
  })

  context("on an image-based system", () => {
    it("installs the AppImage instead of using dnf when ostree booted it", () => {
      const result = run({ managers: ["dnf"], ostree: true })
      expect(result.status).toBe(0)
      expect(result.installs).toEqual([])
      expect(existsSync(join(result.home, ".local/bin/novadeck"))).toBe(true)
    })

    it("finds transactional-update in the system folders when the PATH lacks it", () => {
      const result = run({ managers: ["zypper"], sbin: ["transactional-update"] })
      expect(result.installs).toEqual([])
    })

    it("installs the AppImage instead of using zypper when transactional-update exists", () => {
      const result = run({ managers: ["zypper"], extra: ["transactional-update"] })
      expect(result.installs).toEqual([])
      expect(existsSync(join(result.home, ".local/bin/novadeck"))).toBe(true)
    })
  })

  context("when checking for FUSE", () => {
    it("says nothing without ldconfig", () => {
      expect(run().stdout).not.toContain("FUSE")
    })

    it("finds ldconfig in the system folders when the PATH lacks it", () => {
      const result = run({ sbin: ["ldconfig"] })
      expect(result.stdout).toContain("needs FUSE 2")
    })

    it("says nothing when libfuse2 is listed", () => {
      expect(run({ libraries: "libfuse.so.2 (libc6,x86-64)" }).stdout).not.toContain("FUSE")
    })

    it("explains when libfuse2 is missing", () => {
      expect(run({ libraries: "libc.so.6" }).stdout).toContain("needs FUSE 2")
    })
  })

  context("when told which way to install", () => {
    it("uses the AppImage even where apt exists", () => {
      const result = run({
        managers: ["apt-get"],
        script: script.replace(
          'method="$(detect_method)"',
          'NOVADECK_INSTALL_PACKAGE_MANAGER=appimage\n  method="$(detect_method)"',
        ),
      })
      expect(result.installs).toEqual([])
      expect(existsSync(join(result.home, ".local/bin/novadeck"))).toBe(true)
    })
  })

  context("when a download does not match its checksum", () => {
    it("installs nothing", () => {
      const result = run({ managers: ["apt-get"], tamper: "something else" })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("does not match its checksum")
      expect(result.installs).toEqual([])
    })
  })

  context("on another platform", () => {
    it("points macOS to the disk image and downloads nothing", () => {
      const result = run({ uname: { system: "Darwin" }, managers: ["apt-get"] })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        "acme/novadeck/releases/latest/download/novadeck-mac-universal.dmg",
      )
      expect(result.lines).toEqual([])
    })

    it("refuses other architectures", () => {
      const result = run({ uname: { machine: "aarch64" } })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("x86_64 only")
      expect(result.lines).toEqual([])
    })
  })

  context("when it is rendered for a repository", () => {
    it("downloads from that repository's latest release", () => {
      const result = run({ rendered: true })
      expect(result.lines[0]).toBe(
        "curl https://github.com/acme/novadeck/releases/latest/download/SHA256SUMS",
      )
    })
  })

  context("when the download is cut short", () => {
    it.each([0.3, 0.6, 0.99])("runs nothing at %s of the script", (share: number) => {
      const result = run({
        managers: ["apt-get"],
        script: script.slice(0, Math.floor(script.length * share)),
      })
      expect(result.lines).toEqual([])
    })
  })
})
