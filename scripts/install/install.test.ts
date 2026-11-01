import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach } from "vitest"

import { context, describe, expect, it } from "../test"

const script = readFileSync(fileURLToPath(new URL("./install.sh", import.meta.url)), "utf8")

// The script is for Linux, and the tests stand in for the machine with a PATH of shims
// and the few real tools it needs, so which tools exist is theirs to choose.
const linux = process.platform === "linux"

const tools = [
  "awk",
  "cat",
  "chmod",
  "cmp",
  "cp",
  "grep",
  "ln",
  "mkdir",
  "mktemp",
  "mv",
  "readlink",
  "rm",
  "rmdir",
  "sed",
  "sha256sum",
]

const download = "novadeck-linux-x86_64.AppImage"
const image = "novadeck.AppImage"
const macDownload = "novadeck-mac-universal.zip"
const archive = "zip of novadeck.app"

// Where the host keeps a real tool.
const real = (tool: string) => ["/usr/bin", "/bin"].map((d) => join(d, tool)).find(existsSync)!

// This system's apparmor_parser, to check the profiles against, when it has one.
const parser = ["/usr/sbin/apparmor_parser", "/sbin/apparmor_parser"].find(existsSync)

// Root may write anywhere, so the tests of folders it cannot write to do not apply.
const asRoot = process.getuid?.() === 0

// The executable of the app installed in an Applications folder.
const executable = (folder: string) => join(folder, "novadeck.app/Contents/MacOS/novadeck")

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
  args?: string[]
  uname?: { system?: string; machine?: string }
  root?: boolean
  /** Whether sudo exists, or "denied" when it does but refuses to run anything. */
  sudo?: boolean | "denied" | "no-copy" | "interrupted"
  /** Replaces the content a download is checked against, to fake a corrupt file. */
  tamper?: string
  script?: string
  /** The value of apparmor_restrict_unprivileged_userns; the file is absent when unset. */
  restrict?: "0" | "1"
  /** apparmor_parser on the fake computer, which "rejects" every dry run when "invalid". */
  parser?: "valid" | "invalid" | "unloadable"
  /** Moves the data folder, as XDG_DATA_HOME does, to this folder inside the test's. */
  xdg?: string
  /** Makes that folder a symlink to a real one. */
  linked?: boolean
  /** Puts Homebrew's AppImage in place as a symlink to a file in the Caskroom. */
  brew?: "symlink"
  /** Gives Homebrew a cask folder for novadeck, as `brew install --cask` leaves. */
  cask?: boolean
  /** The uid that owns the home folder; the user's own when unset. */
  homeOwner?: number
  /** A profile file already installed, which a failed load must leave alone. */
  existing?: string
  /** The SUDO_UID sudo leaves in the environment. */
  sudoUid?: string
  /** Leaves HOME unset, or points it at a folder that is not there. */
  home?: "unset" | "missing"
  /** XDG_CONFIG_HOME, set to this value as is. */
  configHome?: string
  /** A relative XDG_DATA_HOME, which counts as unset. */
  relativeXdg?: string
  /**
   * A GitHub CLI on the PATH: `ok` verifies attestations, `invalid` rejects them,
   * `signed-out` is not signed in, `old` lacks `gh attestation`.
   */
  gh?: "ok" | "invalid" | "signed-out" | "old"
  /** Tools present on the PATH, such as fusermount3. */
  extra?: string[]
  /** Tools present only in the system folders a user's PATH lacks. */
  sbin?: string[]
  /** Pretends /dev/fuse exists. */
  fuseDevice?: boolean
  /** Leaves the download folder unset, so the script builds it from its repository. */
  rendered?: boolean
  /** The macOS side of the fake computer; uname then says Darwin. */
  mac?: {
    /** Whether codesign finds a Developer ID signature on the installed app. */
    signed?: boolean
    /**
     * Where a running Novadeck runs from: the folder to install to, another, or a folder
     * whose path matches the one to install to only when read as a regex.
     */
    running?: "installed" | "elsewhere" | "lookalike"
    /** The name of the folder that stands in for /Applications. */
    systemName?: string
    /**
     * Which renames fail: moving the old app aside, the new one in, or that and putting the
     * old one back; or "interrupted", where every rename works but the first is followed by
     * an interrupt, a hangup, a quit and a termination, as Ctrl-C or a closed terminal sends.
     */
    mv?: "aside" | "forward" | "both" | "interrupted"
    /** Whether removing the folder the new app was unpacked in fails. */
    rmFails?: boolean
    /** Whether this account may write to /Applications; it may when unset. */
    systemWritable?: boolean
    /** An app already installed in /Applications ("system") or ~/Applications ("user"). */
    existing?: "system" | "user"
    /** Whether that app in /Applications is this account's to replace; it is when unset. */
    existingWritable?: boolean
    /** Makes the archive unpack to nothing. */
    empty?: boolean
    /** Whether sha256sum exists; macOS has only shasum before 15. */
    sha256sum?: boolean
  }
}

// How the kernel lists a loaded profile: a folder named for it, with its name inside.
const load = (folder: string, ...names: string[]) => {
  for (const [index, name] of names.entries()) {
    mkdirSync(join(folder, `${name}.${index}`))
    writeFileSync(join(folder, `${name}.${index}`, "name"), `${name}\n`)
  }
}

const folders: string[] = []
// Folders a test made read-only, given their write access back so they can be removed.
const locked: string[] = []

const lock = (folder: string) => {
  chmodSync(folder, 0o555)
  locked.push(folder)
}

afterEach(() => {
  for (const folder of locked.splice(0)) chmodSync(folder, 0o755)
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

const run = (scenario: Scenario = {}) => {
  const root = mkdtempSync(join(tmpdir(), "novadeck-install-"))
  folders.push(root)
  const bin = join(root, "bin")
  const served = join(root, "served")
  const home = join(root, "home")
  const apparmor = join(root, "apparmor.d")
  const log = join(root, "log")
  for (const folder of [bin, served, home, apparmor]) mkdirSync(folder)
  writeFileSync(log, "")

  const mac = scenario.mac
  const files: Record<string, string> = mac ? { [macDownload]: archive } : { [download]: appImage }
  for (const [name, content] of Object.entries(files)) writeFileSync(join(served, name), content)
  writeFileSync(
    join(served, "SHA256SUMS"),
    Object.entries(files)
      .map(([name, content]) => `${sha256(scenario.tamper ?? content)}  ${name}`)
      .join("\n") + "\n",
  )

  for (const tool of tools) {
    if (tool === "sha256sum" && mac && mac.sha256sum === false) continue
    if (tool === "mv" && mac?.mv) continue
    if (tool === "rm" && mac?.rmFails) continue
    symlinkSync(real(tool), join(bin, tool))
  }
  const applications = join(root, scenario.mac?.systemName ?? "Applications")
  if (mac) {
    // ditto unpacks the archive into a bundle whose executable holds the archive's text.
    shim(
      bin,
      "ditto",
      `echo "ditto $*" >> "${log}"
[ "$1" = -x ] || exit 1
${mac.empty ? 'mkdir -p "$4"' : `mkdir -p "$4/novadeck.app/Contents/MacOS" && cp "$3" "$4/novadeck.app/Contents/MacOS/novadeck"`}`,
    )
    shim(
      bin,
      "codesign",
      mac.signed
        ? `echo "Authority=Developer ID Application: Acme (TEAM)" >&2`
        : `echo "$3: code object is not signed at all" >&2; exit 1`,
    )
    // A process list, with the one Novadeck that runs, if any, by its executable's path.
    const running = {
      installed: `${applications}/novadeck.app/Contents/MacOS/novadeck --type=browser`,
      elsewhere: `/Volumes/novadeck/novadeck.app/Contents/MacOS/novadeck`,
      // "Apps+(1)" as a regex matches "Appss1".
      lookalike: `${join(root, "Appss1")}/novadeck.app/Contents/MacOS/novadeck`,
    }[mac.running ?? "elsewhere"]
    shim(
      bin,
      "ps",
      // printf, as dash's echo would read a backslash in a path as an escape.
      `printf '%s\\n' /sbin/launchd${mac.running ? ` '${running}'` : ""} 'awk ${applications}/novadeck.app/Contents/MacOS/'`,
    )
    const failing = {
      aside: "*/previous.app",
      forward: "*/.novadeck-install.*/novadeck.app",
      both: "*/.novadeck-install.*/*.app",
    }
    if (mac.mv === "interrupted") {
      shim(
        bin,
        "mv",
        `${real("mv")} "$@" || exit
case "$2" in */previous.app) for signal in INT HUP QUIT TERM; do kill -s $signal $PPID; done ;; esac`,
      )
    } else if (mac.mv) {
      shim(
        bin,
        "mv",
        `case "${mac.mv === "aside" ? "$2" : "$1"}" in ${failing[mac.mv]}) exit 1 ;; esac\nexec ${real("mv")} "$@"`,
      )
    }
    if (mac.rmFails) {
      shim(bin, "rm", `case "$*" in *.novadeck-install*) exit 1 ;; esac\nexec ${real("rm")} "$@"`)
    }
    shim(bin, "shasum", `[ "$1" = -a ] && shift 2; exec ${real("sha256sum")} "$@"`)
    mkdirSync(applications)
    const existing =
      mac.existing === "system"
        ? applications
        : mac.existing === "user"
          ? join(home, "Applications")
          : undefined
    if (existing) {
      mkdirSync(join(existing, "novadeck.app/Contents/MacOS"), { recursive: true })
      writeFileSync(join(existing, "novadeck.app/Contents/MacOS/novadeck"), "old")
      if (mac.existingWritable === false) lock(join(existing, "novadeck.app"))
    }
    if (mac.systemWritable === false) lock(applications)
  }
  const { system = mac ? "Darwin" : "Linux", machine = mac ? "arm64" : "x86_64" } =
    scenario.uname ?? {}
  shim(bin, "uname", `[ "$1" = -s ] && echo ${system} || echo ${machine}`)
  shim(bin, "id", `echo ${scenario.root ? 0 : 1000}`)
  shim(
    bin,
    "ls",
    `echo "drwx------ 2 ${scenario.homeOwner ?? (scenario.root ? 0 : 1000)} 4096 Jan 1 00:00 $3"`,
  )
  shim(
    bin,
    "curl",
    `while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
echo "curl $url" >> "${log}"
cp "${served}/\${url##*/}" "$out"`,
  )
  if (scenario.gh)
    shim(
      bin,
      "gh",
      `echo "gh $*" >> "${log}"
case "$1 $2" in
"auth status") [ "${scenario.gh}" != signed-out ] ;;
"attestation verify") [ "${scenario.gh}" != old ] && { [ "$3" = --help ] || [ "${scenario.gh}" = ok ]; } ;;
*) exit 1 ;;
esac`,
    )
  const sudo = scenario.sudo ?? true
  if (sudo === "denied") shim(bin, "sudo", `echo "sudo denied" >> "${log}"; exit 1`)
  else if (sudo === "no-copy") shim(bin, "sudo", `[ "$1" = cp ] && exit 1\nSUDO=sudo "$@"`)
  // As Ctrl-C at the password prompt: the script is interrupted, and sudo gives up.
  else if (sudo === "interrupted") shim(bin, "sudo", `kill -s INT $PPID; exit 1`)
  else if (sudo) shim(bin, "sudo", `SUDO=sudo "$@"`)

  // The system folders the script searches are the test's own, so the host's tools never leak in.
  const sbin = join(root, "sbin")
  mkdirSync(sbin)
  // The temporary folder, which every run must leave empty.
  const temporary = join(root, "tmp")
  mkdirSync(temporary)
  for (const name of scenario.extra ?? []) shim(bin, name, `echo "${name} $*" >> "${log}"`)
  for (const name of scenario.sbin ?? []) shim(sbin, name, `echo "${name} $*" >> "${log}"`)
  if (scenario.parser) {
    // A dry run is the only call without --replace; it leaves a line in the log too.
    shim(
      bin,
      "apparmor_parser",
      `echo "\${SUDO:+sudo }apparmor_parser $*" >> "${log}"
case "$*" in
*--skip-kernel-load*) [ "${scenario.parser}" != invalid ] ;;
*--replace*) [ "${scenario.parser}" = valid ] ;;
*--remove*) [ "${scenario.parser}" != unloadable ] ;;
esac`,
    )
  }
  const sysctl = join(root, "restrict")
  if (scenario.restrict) writeFileSync(sysctl, `${scenario.restrict}\n`)
  const device = join(root, "fuse")
  if (scenario.fuseDevice ?? true) writeFileSync(device, "")

  const text = (scenario.script ?? script).replaceAll("@REPOSITORY@", "acme/novadeck")
  const entry = join(root, "install.sh")
  writeFileSync(entry, text)
  const data = scenario.xdg ? join(root, scenario.xdg) : undefined
  const realData = join(root, "real-data")
  if (data && scenario.linked) {
    mkdirSync(realData)
    symlinkSync(realData, data)
  }
  const profiles = join(root, "profiles")
  mkdirSync(profiles)
  if (scenario.existing) writeFileSync(join(apparmor, `novadeck-appimage-1000`), scenario.existing)
  if (scenario.brew) {
    mkdirSync(join(home, "Applications"))
    mkdirSync(join(home, "Caskroom"))
    writeFileSync(join(home, "Caskroom/novadeck.AppImage"), appImage)
    symlinkSync(
      join(home, "Caskroom/novadeck.AppImage"),
      join(home, "Applications/novadeck.AppImage"),
    )
  }
  const caskrooms = join(root, "caskrooms")
  mkdirSync(caskrooms)
  if (scenario.cask) mkdirSync(join(caskrooms, "novadeck"))
  const start = (args = scenario.args ?? []) =>
    spawnSync("/bin/sh", [entry, ...args], {
      env: {
        PATH: bin,
        ...(scenario.home === "unset" ? {} : { HOME: scenario.home ? join(root, "gone") : home }),
        ...(scenario.sudoUid ? { SUDO_UID: scenario.sudoUid } : {}),
        NOVADECK_INSTALL_SBIN_DIRS: sbin,
        TMPDIR: temporary,
        NOVADECK_INSTALL_USERNS_SYSCTL: sysctl,
        NOVADECK_INSTALL_APPARMOR_DIR: apparmor,
        NOVADECK_INSTALL_FUSE_DEVICE: device,
        NOVADECK_INSTALL_PROFILES: profiles,
        NOVADECK_INSTALL_APPLICATIONS_DIR: applications,
        NOVADECK_INSTALL_CASKROOMS: caskrooms,
        ...(scenario.configHome ? { XDG_CONFIG_HOME: scenario.configHome } : {}),
        ...(data ? { XDG_DATA_HOME: data } : {}),
        ...(scenario.relativeXdg ? { XDG_DATA_HOME: scenario.relativeXdg } : {}),
        ...(scenario.rendered ? {} : { NOVADECK_INSTALL_BASE_URL: `http://mirror.test/dl/` }),
      },
      encoding: "utf8",
    })
  const result = start()
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean)
  const profile = join(apparmor, `novadeck-appimage-${scenario.root ? 0 : 1000}`)
  return {
    ...result,
    home,
    applications,
    data: scenario.linked ? realData : (data ?? join(home, ".local/share")),
    lines,
    commands: lines.filter((line) => !line.startsWith("curl")),
    profile: existsSync(profile) ? readFileSync(profile, "utf8") : undefined,
    profilePath: profile,
    leftovers: () => readdirSync(temporary),
    profiles,
    log: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    /** Runs the script again on the same fake computer, with other arguments if given. */
    again: start,
    trash: join(home, ".Trash"),
  }
}

describe.skipIf(!linux)("install.sh", () => {
  context("on any Linux system", () => {
    context("the build attestation", () => {
      it("says plainly that only checksums were checked without gh", () => {
        const result = run()
        expect(result.status).toBe(0)
        expect(result.stdout).toContain(`Checked ${download} against the release's checksums only`)
      })

      it("verifies the download against the repository when gh is signed in", () => {
        const result = run({ gh: "ok" })
        expect(result.status).toBe(0)
        expect(result.commands).toContain(`gh attestation verify ${download} --repo acme/novadeck`)
        expect(result.stdout).toContain("its build attestation from acme/novadeck")
      })

      it("installs nothing when the attestation does not hold", () => {
        const result = run({ gh: "invalid" })
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain("no valid build attestation")
        expect(existsSync(join(result.data, "novadeck", image))).toBe(false)
      })

      it("falls back to checksums when gh is signed out or too old to attest", () => {
        for (const gh of ["signed-out", "old"] as const) {
          const result = run({ gh })
          expect(result.status, gh).toBe(0)
          expect(result.stdout, gh).toContain("checksums only")
          expect(result.commands.join("\n"), gh).not.toMatch(/attestation verify \S+ --repo/)
        }
      })
    })

    it("installs the AppImage with a menu entry, an icon and a command after checking its checksum", () => {
      const result = run()
      const target = join(result.data, "novadeck", image)
      expect(result.status).toBe(0)
      expect(result.lines).toContain("curl http://mirror.test/dl/SHA256SUMS")
      expect(result.lines).toContain(`curl http://mirror.test/dl/${download}`)
      expect(result.commands).toEqual([])
      expect(lstatSync(target).mode & 0o111).not.toBe(0)
      expect(readlinkSync(join(result.home, ".local/bin/novadeck"))).toBe(target)
      expect(
        readFileSync(join(result.data, "icons/hicolor/512x512/apps/novadeck.png"), "utf8"),
      ).toBe("png")
      const entry = readFileSync(
        join(result.data, "applications/dev.mzpk.novadeck.desktop"),
        "utf8",
      )
      expect(entry).toContain(`Exec="${target}" %U`)
      expect(entry).toContain(
        `Icon=${join(result.data, "icons/hicolor/512x512/apps/novadeck.png")}`,
      )
    })

    it("says when ~/.local/bin is not on the PATH", () => {
      const result = run()
      expect(result.stdout).toContain("to your PATH")
    })

    it("replaces the installed AppImage when run again", () => {
      const result = run()
      const target = join(result.home, ".local/share/novadeck", image)
      writeFileSync(target, "old")
      expect(result.again().status).toBe(0)
      expect(readFileSync(target, "utf8")).toBe(appImage)
    })

    it("escapes the AppImage's path in the menu entry's Exec line", () => {
      const result = run({ xdg: 'a$b 100% "c" \\d' })
      const entry = readFileSync(
        join(result.data, "applications/dev.mzpk.novadeck.desktop"),
        "utf8",
      )
      const escaped = join(result.data, "novadeck", image)
        .replaceAll("\\", "\\\\\\\\")
        .replace(/["`$]/g, "\\\\$&")
        .replaceAll("%", "%%")
      expect(entry).toContain(`Exec="${escaped}" %U`)
    })

    it("leaves its temporary folder empty", () => {
      expect(run().leftovers()).toEqual([])
      expect(run({ mac: {} }).leftovers()).toEqual([])
    })

    it("installs under XDG_DATA_HOME when it is set", () => {
      const result = run({ xdg: "xdg" })
      expect(existsSync(join(result.data, "novadeck", image))).toBe(true)
    })
  })

  context("when checking for FUSE", () => {
    it("says nothing when fusermount3 and /dev/fuse exist", () => {
      expect(run({ extra: ["fusermount3"] }).stdout).not.toContain("FUSE")
    })

    it("accepts fusermount, which FUSE 2 systems have", () => {
      expect(run({ extra: ["fusermount"] }).stdout).not.toContain("FUSE")
    })

    it("looks only on the PATH, as the AppImage runtime does", () => {
      expect(run({ sbin: ["fusermount3"] }).stdout).toContain("needs FUSE 3")
    })

    it("explains when there is no fusermount", () => {
      const result = run()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("needs FUSE 3")
      expect(result.stdout).toContain("fuse3")
      expect(result.stdout).toContain("--appimage-extract-and-run")
    })

    it("explains when there is no /dev/fuse", () => {
      const result = run({ extra: ["fusermount3"], fuseDevice: false })
      expect(result.stdout).toContain("needs FUSE 3")
    })
  })

  context("on a system that restricts unprivileged user namespaces", () => {
    const restricted = { restrict: "1", parser: "valid" } as const

    it("installs an AppArmor profile through sudo and loads it", () => {
      const result = run(restricted)
      const target = join(result.data, "novadeck", image)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("so Novadeck's sandbox works on this system")
      expect(result.commands).toHaveLength(2)
      expect(result.commands[0]).toMatch(/^apparmor_parser --skip-kernel-load --debug \S+$/)
      expect(result.commands[1]).toMatch(/^sudo apparmor_parser --replace \/\S+\/profile$/)
      expect(basename(result.profilePath)).toBe("novadeck-appimage-1000")
      expect(result.profile).toBe(`abi <abi/4.0>,
include <tunables/global>

profile novadeck-appimage-1000 "${target}" flags=(unconfined) {
  userns,
  include if exists <local/novadeck-appimage-1000>
}

profile novadeck-appimage-1000-brew "${join(result.home, "Applications/novadeck.AppImage")}" flags=(unconfined) {
  userns,
  include if exists <local/novadeck-appimage-1000-brew>
}
`)
    })

    it("names the profile for root's uid and skips sudo for root", () => {
      const result = run({ ...restricted, root: true, sudo: false })
      expect(basename(result.profilePath)).toBe("novadeck-appimage-0")
      expect(result.commands[1]).toMatch(/^apparmor_parser --replace \/\S+\/profile$/)
      expect(result.profile).toContain("profile novadeck-appimage-0 ")
    })

    it("prefers the system folders' apparmor_parser to one on the PATH, as it runs as root", () => {
      // The one on the PATH rejects every profile; the system's accepts it.
      const result = run({ restrict: "1", parser: "invalid", sbin: ["apparmor_parser"] })
      expect(result.commands.every((line) => !line.startsWith("sudo"))).toBe(true)
      expect(result.profile).toContain("userns,")
    })

    it("leaves nothing behind when interrupted at the password prompt", () => {
      const result = run({ ...restricted, sudo: "interrupted" })
      expect(result.status).toBe(130)
      expect(result.leftovers()).toEqual([])
      expect(result.profile).toBeUndefined()
    })

    it("finds apparmor_parser in the system folders when the PATH lacks it", () => {
      const result = run({ restrict: "1", sbin: ["apparmor_parser"] })
      expect(result.commands).toHaveLength(2)
      expect(result.profile).toContain("userns,")
    })

    it("names the literal path of an install moved by XDG_DATA_HOME", () => {
      const result = run({ ...restricted, xdg: "xdg" })
      expect(result.profile).toContain(
        `profile novadeck-appimage-1000 "${join(result.data, "novadeck", image)}" flags=(unconfined)`,
      )
    })

    it("names the real path when the data folder is a symlink", () => {
      const result = run({ ...restricted, xdg: "xdg", linked: true })
      expect(result.profile).toContain(`"${join(realpathSync(result.data), "novadeck", image)}"`)
      expect(result.profile).not.toContain(`/xdg/`)
    })

    it("names the real path of Homebrew's AppImage when it is a symlink", () => {
      const result = run({ ...restricted, brew: "symlink" })
      expect(result.profile).toContain(`"${join(result.home, "Caskroom/novadeck.AppImage")}"`)
    })

    it("does not ask for sudo again when both profiles are already loaded", () => {
      const result = run(restricted)
      load(result.profiles, "novadeck-appimage-1000", "novadeck-appimage-1000-brew", "other")
      const before = result.log().length
      const again = result.again()
      expect(again.stdout).toContain("already set up")
      expect(again.stderr).toBe("")
      expect(
        result
          .log()
          .slice(before)
          .filter((line) => line.startsWith("sudo")),
      ).toEqual([])
    })

    it("asks again when a profile is not loaded, or none are", () => {
      const result = run(restricted)
      load(result.profiles, "novadeck-appimage-1000", "novadeck-appimage-1000-other")
      expect(result.again().stdout).toContain("Writing an AppArmor profile")
      rmSync(result.profiles, { recursive: true })
      expect(result.again().stdout).toContain("Writing an AppArmor profile")
    })

    it("asks again when the installed profile differs", () => {
      const result = run(restricted)
      load(result.profiles, "novadeck-appimage-1000", "novadeck-appimage-1000-brew")
      writeFileSync(result.profilePath, "old")
      expect(result.again().stdout).toContain("Writing an AppArmor profile")
      expect(readFileSync(result.profilePath, "utf8")).toContain("userns,")
    })

    it("treats a relative XDG_DATA_HOME as unset", () => {
      const result = run({ ...restricted, relativeXdg: "relative/data" })
      expect(result.status).toBe(0)
      expect(existsSync(join(result.home, ".local/share/novadeck", image))).toBe(true)
      expect(result.profile).toContain(join(result.home, ".local/share/novadeck", image))
    })

    it("names a path with UTF-8 characters, which AppArmor accepts", () => {
      const result = run({ ...restricted, xdg: "józef" })
      expect(result.profile).toContain(`"${join(result.data, "novadeck", image)}"`)
    })

    it("warns instead of writing a profile for a path with a control character", () => {
      const result = run({ ...restricted, xdg: "odd\tpath" })
      expect(result.status).toBe(0)
      expect(result.profile).toBeUndefined()
      expect(result.stdout).toContain("without its sandbox")
    })

    it("says the sandbox lasts until a restart when the loaded profile cannot be saved", () => {
      const result = run({ ...restricted, sudo: "no-copy" })
      expect(result.status).toBe(0)
      expect(result.profile).toBeUndefined()
      expect(result.commands[1]).toMatch(/^sudo apparmor_parser --replace \/\S+\/profile$/)
      expect(result.stdout).toContain("works until the next restart")
      expect(result.stdout).toContain("--sandbox")
      expect(result.stdout).not.toContain("without its sandbox")
    })

    it("leaves the install working and says how to retry when sudo refuses", () => {
      const result = run({ ...restricted, sudo: "denied" })
      expect(result.status).toBe(0)
      expect(result.profile).toBeUndefined()
      expect(result.stdout).toContain("without its sandbox")
      expect(result.stdout).toContain(
        "curl -fsSL http://mirror.test/dl/install.sh | sh -s -- --sandbox",
      )
      expect(existsSync(join(result.home, ".local/bin/novadeck"))).toBe(true)
    })

    it("leaves the install working when there is neither root nor sudo", () => {
      const result = run({ ...restricted, sudo: false })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("without its sandbox")
    })

    it("writes nothing when the dry run rejects the profile", () => {
      const result = run({ restrict: "1", parser: "invalid" })
      expect(result.status).toBe(0)
      expect(result.profile).toBeUndefined()
      expect(result.commands).toHaveLength(1)
      expect(result.stdout).toContain("without its sandbox")
    })

    it.each(["{", "}", '"', "\\", "*", "?", "[", "^", ","])(
      "warns instead of writing a profile for a path with %s, which it cannot name",
      (character) => {
        const result = run({ ...restricted, xdg: `odd${character}path` })
        expect(result.status).toBe(0)
        expect(result.profile).toBeUndefined()
        expect(result.stdout).toContain("without its sandbox")
      },
    )

    it.skipIf(!parser)("writes profiles this system's apparmor_parser accepts", () => {
      const functions = ["profile_block", "write_profile"]
        .map((name) => script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))![0])
        .join("\n")
      const folder = mkdtempSync(join(tmpdir(), "novadeck-profile-"))
      folders.push(folder)
      const profile = join(folder, "profile")
      const pairs: [string, string][] = [
        [
          "/home/a b/.local/share/novadeck/novadeck.AppImage",
          "/home/a b/Applications/novadeck.AppImage",
        ],
        ["/home/józef $x @y #z/novadeck.AppImage", "/home/józef $x @y #z/novadeck.AppImage"],
      ]
      for (const [one, other] of pairs) {
        const written = spawnSync(
          "/bin/sh",
          ["-c", `${functions}\nwrite_profile 1000 "$1" "$2" > "$3"`, "sh", one, other, profile],
          { encoding: "utf8" },
        )
        expect(written.status).toBe(0)
        const parsed = spawnSync(parser!, ["--skip-kernel-load", "--debug", profile], {
          encoding: "utf8",
        })
        expect(parsed.status).toBe(0)
        // One line per profile: one profile when both paths are the same.
        expect(parsed.stderr).toBe("Mode: unconfined\n".repeat(one === other ? 1 : 2))
      }
    })

    it("writes nothing when loading fails, and keeps a profile that was already there", () => {
      const fresh = run({ restrict: "1", parser: "unloadable" })
      expect(fresh.status).toBe(0)
      expect(fresh.profile).toBeUndefined()
      expect(fresh.stdout).toContain("without its sandbox")
      const old = run({ restrict: "1", parser: "unloadable", existing: "old" })
      expect(old.profile).toBe("old")
    })

    it("warns without apparmor_parser", () => {
      const result = run({ restrict: "1" })
      expect(result.status).toBe(0)
      expect(result.profile).toBeUndefined()
      expect(result.stdout).toContain("without its sandbox")
      expect(result.stdout).toContain("apparmor_parser")
    })
  })

  context("on a system that does not restrict unprivileged user namespaces", () => {
    it.each([{ restrict: "0" }, {}] as const)("writes no profile with %j", (restrict) => {
      const result = run({ ...restrict, parser: "valid" })
      expect(result.status).toBe(0)
      expect(result.commands).toEqual([])
      expect(result.profile).toBeUndefined()
      expect(result.stdout).not.toContain("sandbox")
    })
  })

  context("with --sandbox", () => {
    it("sets up the sandbox and downloads and installs nothing", () => {
      const result = run({ args: ["--sandbox"], restrict: "1", parser: "valid" })
      expect(result.status).toBe(0)
      expect(result.lines).toEqual(result.commands)
      expect(result.commands).toHaveLength(2)
      expect(result.profile).toContain("userns,")
      expect(existsSync(join(result.home, ".local"))).toBe(false)
    })

    it("works without curl", () => {
      const result = run({
        args: ["--sandbox"],
        restrict: "1",
        parser: "valid",
        script: script.replace('has curl || fail "curl is required."', 'fail "curl asked for"'),
      })
      expect(result.status).toBe(0)
      expect(result.profile).toContain("userns,")
    })

    it("says when the system needs no setup", () => {
      const result = run({ args: ["--sandbox"], restrict: "0", parser: "valid" })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("needs no setup")
      expect(result.profile).toBeUndefined()
    })

    it("warns without apparmor_parser too", () => {
      const result = run({ args: ["--sandbox"], restrict: "1" })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("without its sandbox")
    })

    it("names the real path of an AppImage that is not installed yet", () => {
      const result = run({
        args: ["--sandbox"],
        restrict: "1",
        parser: "valid",
        xdg: "xdg",
        linked: true,
      })
      expect(result.profile).toContain(`"${join(realpathSync(result.data), "novadeck", image)}"`)
    })

    it("warns with the same command when sudo refuses", () => {
      const result = run({ args: ["--sandbox"], restrict: "1", parser: "valid", sudo: "denied" })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("--sandbox")
    })
  })

  context("with --uninstall on Linux", () => {
    const uninstall = ["--uninstall"]
    const restricted = { restrict: "1", parser: "valid" } as const

    it("removes everything the install made and downloads nothing", () => {
      const result = run()
      const { data, home } = result
      const before = result.lines.length
      const again = result.again(uninstall)
      expect(again.status).toBe(0)
      expect(result.log()).toHaveLength(before)
      expect(existsSync(join(data, "novadeck"))).toBe(false)
      expect(existsSync(join(data, "applications/dev.mzpk.novadeck.desktop"))).toBe(false)
      expect(existsSync(join(data, "icons/hicolor/512x512/apps/novadeck.png"))).toBe(false)
      expect(() => lstatSync(join(home, ".local/bin/novadeck"))).toThrow()
      expect(again.stdout).toContain(`Removed ${join(data, "novadeck", image)}`)
      expect(again.stdout).toContain("Your data and any agent plugins stay")
      expect(again.stdout).toContain("claude plugin uninstall novadeck@novadeck")
      expect(again.stdout).toContain("codex plugin remove novadeck@novadeck")
      expect(again.stdout).toContain("agy plugin uninstall novadeck")
    })

    it("leaves a command that points elsewhere alone", () => {
      const result = run()
      const link = join(result.home, ".local/bin/novadeck")
      rmSync(link)
      symlinkSync("/usr/bin/env", link)
      expect(result.again(uninstall).status).toBe(0)
      expect(readlinkSync(link)).toBe("/usr/bin/env")
    })

    it("keeps the folder, and says where the data is, while the person's data is in it", () => {
      const result = run()
      const folder = join(result.data, "novadeck")
      writeFileSync(join(folder, "workspace.sqlite"), "projects")
      mkdirSync(join(folder, "shell"))
      const again = result.again(uninstall)
      expect(again.status).toBe(0)
      expect(readFileSync(join(folder, "workspace.sqlite"), "utf8")).toBe("projects")
      expect(existsSync(join(folder, "shell"))).toBe(true)
      expect(existsSync(join(folder, image))).toBe(false)
      expect(again.stdout).toContain(folder)
      expect(again.stdout).toContain("Your data and any agent plugins stay")
    })

    it("removes the folder when nothing else is in it", () => {
      const result = run()
      expect(existsSync(join(result.data, "novadeck"))).toBe(true)
      expect(result.again(uninstall).stdout).toContain(`Removed ${join(result.data, "novadeck")}`)
      expect(existsSync(join(result.data, "novadeck"))).toBe(false)
    })

    it("honours XDG_DATA_HOME", () => {
      const result = run({ xdg: "xdg" })
      expect(existsSync(join(result.data, "novadeck", image))).toBe(true)
      expect(result.again(uninstall).status).toBe(0)
      expect(existsSync(join(result.data, "novadeck"))).toBe(false)
      expect(existsSync(join(result.home, ".local/share/novadeck"))).toBe(false)
    })

    it("says so, and succeeds, when nothing is installed", () => {
      const result = run({ args: uninstall })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("not installed")
      expect(result.stdout).not.toContain("plugin")
      expect(result.lines).toEqual([])
      expect(existsSync(join(result.home, ".local"))).toBe(false)
      const first = run()
      expect(first.again(uninstall).status).toBe(0)
      const second = first.again(uninstall)
      expect(second.status).toBe(0)
      expect(second.stdout).toContain("not installed")
    })

    it("names the config folder from XDG_CONFIG_HOME when it is absolute", () => {
      const plain = run()
      expect(plain.again(uninstall).stdout).toContain(`delete ${plain.home}/.config/novadeck`)
      const set = run({ configHome: "/xdg/config" })
      expect(set.again(uninstall).stdout).toContain("delete /xdg/config/novadeck")
      const relative = run({ configHome: "xdg/config" })
      expect(relative.again(uninstall).stdout).toContain(`delete ${relative.home}/.config/novadeck`)
    })

    it("works without curl", () => {
      const result = run({
        args: uninstall,
        script: script.replace('has curl || fail "curl is required."', 'fail "curl asked for"'),
      })
      expect(result.status).toBe(0)
    })

    it("unloads and removes the AppArmor profile through sudo", () => {
      const result = run(restricted)
      expect(result.profile).toContain("userns,")
      const before = result.log().length
      const again = result.again(uninstall)
      expect(again.status).toBe(0)
      expect(existsSync(result.profilePath)).toBe(false)
      expect(result.log().slice(before)).toEqual([
        `sudo apparmor_parser --remove ${result.profilePath}`,
      ])
    })

    it("does nothing about AppArmor when there is no profile", () => {
      const result = run({ parser: "valid" })
      const again = result.again(uninstall)
      expect(again.status).toBe(0)
      expect(result.log()).toEqual([
        `curl http://mirror.test/dl/SHA256SUMS`,
        `curl http://mirror.test/dl/${download}`,
      ])
      expect(again.stdout).not.toContain("AppArmor")
    })

    it("finishes, and says how to retry, when sudo refuses", () => {
      // The install leaves no profile when sudo refuses, so one is put where the script looks.
      const refused = run({ ...restricted, sudo: "denied" })
      writeFileSync(refused.profilePath, "profile")
      const again = refused.again(uninstall)
      expect(again.status).toBe(0)
      expect(existsSync(refused.profilePath)).toBe(true)
      expect(existsSync(join(refused.data, "novadeck"))).toBe(false)
      expect(again.stdout).toContain("could not be removed as root")
      expect(again.stdout).toContain(
        "curl -fsSL http://mirror.test/dl/install.sh | sh -s -- --uninstall",
      )
    })

    it("still removes the profile file when it will not unload, and says it stays loaded", () => {
      const result = run({ restrict: "1", parser: "unloadable" })
      writeFileSync(result.profilePath, "profile")
      const again = result.again(uninstall)
      expect(again.status).toBe(0)
      expect(existsSync(result.profilePath)).toBe(false)
      expect(again.stdout).toContain("stays loaded until the next restart")
      expect(again.stdout).not.toContain("--uninstall")
    })

    it("removes the profile file where there is no apparmor_parser to unload it", () => {
      const result = run()
      writeFileSync(result.profilePath, "profile")
      const again = result.again(uninstall)
      expect(again.status).toBe(0)
      expect(existsSync(result.profilePath)).toBe(false)
      expect(again.stdout).toContain("until the next restart")
    })

    it("refuses to touch a Homebrew install, and says how to remove it", () => {
      const result = run({ brew: "symlink", args: uninstall })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("brew uninstall --cask novadeck")
      expect(readlinkSync(join(result.home, "Applications/novadeck.AppImage"))).toBe(
        join(result.home, "Caskroom/novadeck.AppImage"),
      )
    })

    it("refuses when Homebrew's cask folder holds novadeck", () => {
      const result = run({ cask: true })
      const again = result.again(uninstall)
      expect(again.status).toBe(1)
      expect(again.stderr).toContain("brew uninstall --cask novadeck")
      expect(existsSync(join(result.data, "novadeck", image))).toBe(true)
    })

    it("does not combine with --sandbox", () => {
      const result = run({ args: ["--sandbox", "--uninstall"] })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("usage")
    })
  })

  context("as root for another user's account", () => {
    const modes = [
      ["no arguments", []],
      ["--sandbox", ["--sandbox"]],
      ["--uninstall", ["--uninstall"]],
    ] as const

    it.each(modes)("installs nothing with %s when the home folder is the user's", (_, args) => {
      const result = run({ root: true, sudo: false, homeOwner: 1000, args: [...args] })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("without sudo")
      expect(result.lines).toEqual([])
      expect(existsSync(join(result.home, ".local"))).toBe(false)
    })

    it.each(modes)("installs nothing with %s when run through plain sudo", (_, args) => {
      const result = run({ root: true, sudo: false, sudoUid: "1000", args: [...args] })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("without sudo")
      expect(result.lines).toEqual([])
    })
  })

  context("as root", () => {
    it("installs for root's own home, with or without a SUDO_UID of 0", () => {
      for (const extra of [{}, { sudoUid: "0" }]) {
        const result = run({ root: true, sudo: false, ...extra })
        expect(result.status).toBe(0)
        expect(existsSync(join(result.home, ".local/bin/novadeck"))).toBe(true)
      }
    })
  })

  context("when HOME is not an existing folder", () => {
    it.each(["unset", "missing"] as const)("fails when it is %s", (home) => {
      const result = run({ root: true, sudo: false, home })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("HOME is not set to an existing folder")
      expect(result.lines).toEqual([])
    })
  })

  context("with an unknown argument", () => {
    it("prints the usage and installs nothing", () => {
      const result = run({ args: ["--nope"] })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("usage: install.sh [--sandbox | --uninstall]")
      expect(result.lines).toEqual([])
    })
  })

  context("when a download does not match its checksum", () => {
    it("installs nothing", () => {
      const result = run({ tamper: "something else", restrict: "1", parser: "valid" })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("does not match its checksum")
      expect(result.commands).toEqual([])
      expect(existsSync(join(result.home, ".local/bin/novadeck"))).toBe(false)
    })
  })

  context("on macOS", () => {
    it("installs the app to /Applications after checking its checksum", () => {
      const result = run({ mac: {} })
      expect(result.status).toBe(0)
      expect(result.lines).toContain("curl http://mirror.test/dl/SHA256SUMS")
      expect(result.lines).toContain(`curl http://mirror.test/dl/${macDownload}`)
      expect(readFileSync(executable(result.applications), "utf8")).toBe(archive)
      expect(result.stdout).toContain(`Installed Novadeck to ${result.applications}/novadeck.app`)
      expect(readdirSync(result.applications)).toEqual(["novadeck.app"])
      expect(existsSync(join(result.home, "Applications"))).toBe(false)
      expect(existsSync(join(result.home, ".local"))).toBe(false)
    })

    it("runs on Intel Macs too, as the app is universal", () => {
      expect(run({ mac: {}, uname: { system: "Darwin", machine: "x86_64" } }).status).toBe(0)
    })

    it("checks the download with shasum where there is no sha256sum", () => {
      expect(run({ mac: { sha256sum: false } }).status).toBe(0)
      const result = run({ mac: { sha256sum: false }, tamper: "something else" })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("does not match its checksum")
    })

    it.skipIf(asRoot)(
      "installs to ~/Applications when this account cannot write to /Applications",
      () => {
        const result = run({ mac: { systemWritable: false } })
        expect(result.status).toBe(0)
        expect(readFileSync(executable(join(result.home, "Applications")), "utf8")).toBe(archive)
      },
    )

    it("replaces a copy in /Applications", () => {
      const result = run({ mac: { existing: "system" } })
      expect(result.status).toBe(0)
      expect(readFileSync(executable(result.applications), "utf8")).toBe(archive)
      expect(readdirSync(result.applications)).toEqual(["novadeck.app"])
    })

    it("replaces a copy in ~/Applications rather than adding another", () => {
      const result = run({ mac: { existing: "user" } })
      expect(result.status).toBe(0)
      expect(readFileSync(executable(join(result.home, "Applications")), "utf8")).toBe(archive)
      expect(readdirSync(result.applications)).toEqual([])
    })

    it("replaces the app when run again", () => {
      const result = run({ mac: {} })
      writeFileSync(executable(result.applications), "old")
      expect(result.again().status).toBe(0)
      expect(readFileSync(executable(result.applications), "utf8")).toBe(archive)
    })

    it.skipIf(asRoot)(
      "leaves a copy in /Applications that is not this account's to replace",
      () => {
        const result = run({ mac: { existing: "system", existingWritable: false } })
        expect(result.status).toBe(1)
        expect(result.stderr).toContain("not this account's to replace")
        expect(result.lines).not.toContain(`curl http://mirror.test/dl/${macDownload}`)
        expect(readFileSync(executable(result.applications), "utf8")).toBe("old")
        expect(existsSync(join(result.home, "Applications"))).toBe(false)
      },
    )

    it("leaves a running copy alone", () => {
      const result = run({ mac: { existing: "system", running: "installed" } })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("Quit it and run this again")
      expect(readFileSync(executable(result.applications), "utf8")).toBe("old")
    })

    it("matches a running copy's path as plain text", () => {
      const lookalike = run({ mac: { systemName: "Apps+(1)", running: "lookalike" } })
      expect(lookalike.status).toBe(0)
      const running = run({ mac: { systemName: "Apps+(1)\\n", running: "installed" } })
      expect(running.status).toBe(1)
      expect(running.stderr).toContain("Quit it and run this again")
    })

    it("installs while a copy runs from somewhere else, such as the disk image", () => {
      const result = run({ mac: { existing: "system", running: "elsewhere" } })
      expect(result.status).toBe(0)
      expect(readFileSync(executable(result.applications), "utf8")).toBe(archive)
    })

    it("says how to allow a terminal macOS stops from replacing the app", () => {
      const result = run({ mac: { existing: "system", mv: "aside" } })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("App Management")
      expect(readFileSync(executable(result.applications), "utf8")).toBe("old")
      expect(readdirSync(result.applications)).toEqual(["novadeck.app"])
    })

    it("puts the old copy back when the new one cannot move in", () => {
      const result = run({ mac: { existing: "system", mv: "forward" } })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("could not move Novadeck into")
      expect(readFileSync(executable(result.applications), "utf8")).toBe("old")
      expect(readdirSync(result.applications)).toEqual(["novadeck.app"])
    })

    it("keeps the old copy, and says where, when it cannot be put back either", () => {
      const result = run({ mac: { existing: "system", mv: "both" } })
      expect(result.status).toBe(1)
      const kept = /which is now (\S+)\.$/m.exec(result.stderr)?.[1]
      expect(kept).toBeDefined()
      expect(readFileSync(join(kept!, "Contents/MacOS/novadeck"), "utf8")).toBe("old")
    })

    it("finishes replacing the app when interrupted between its renames", () => {
      const result = run({ mac: { existing: "system", mv: "interrupted" } })
      expect(result.status).toBe(0)
      expect(readFileSync(executable(result.applications), "utf8")).toBe(archive)
      expect(readdirSync(result.applications)).toEqual(["novadeck.app"])
    })

    it("succeeds when it cannot remove the copy it replaced, and the next run does too", () => {
      const result = run({ mac: { existing: "system", rmFails: true } })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("delete it by hand")
      expect(readFileSync(executable(result.applications), "utf8")).toBe(archive)
      expect(result.again().status).toBe(0)
    })

    it("keeps the installed copy when the archive holds no app", () => {
      const result = run({ mac: { existing: "system", empty: true } })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("holds no novadeck.app")
      expect(readFileSync(executable(result.applications), "utf8")).toBe("old")
      expect(readdirSync(result.applications)).toEqual(["novadeck.app"])
    })

    it("says a signed build updates itself", () => {
      const result = run({ mac: { signed: true } })
      expect(result.stdout).toContain("Novadeck updates itself from here.")
    })

    it("says an unsigned build only tells of new versions", () => {
      const result = run({ mac: { signed: false } })
      expect(result.status).toBe(0)
      expect(result.stdout).not.toContain("updates itself")
      expect(result.stdout).toContain("tells you of new versions")
    })

    it("needs no sandbox setup", () => {
      const result = run({ mac: {}, args: ["--sandbox"], restrict: "1", parser: "valid" })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("needs no setup on macOS")
      expect(result.lines).toEqual([])
      expect(existsSync(executable(result.applications))).toBe(false)
    })

    it("refuses to run through sudo", () => {
      const result = run({ mac: {}, root: true, sudo: false, sudoUid: "501" })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("without sudo")
      expect(result.lines).toEqual([])
    })
  })

  context("with --uninstall on macOS", () => {
    const uninstall = ["--uninstall"]

    it("moves the app to the Trash and downloads nothing", () => {
      const result = run({ mac: { existing: "system" }, args: uninstall })
      expect(result.status).toBe(0)
      expect(result.lines).toEqual([])
      expect(existsSync(join(result.applications, "novadeck.app"))).toBe(false)
      expect(readFileSync(join(result.trash, "novadeck.app/Contents/MacOS/novadeck"), "utf8")).toBe(
        "old",
      )
      expect(result.stdout).toContain(`Moved ${result.applications}/novadeck.app to the Trash`)
      expect(result.stdout).toContain("Your data and any agent plugins stay")
      expect(result.stdout).toContain("Library/Application Support/novadeck")
    })

    it("removes the copy in ~/Applications too", () => {
      const result = run({ mac: { existing: "user" }, args: uninstall })
      expect(result.status).toBe(0)
      expect(existsSync(join(result.home, "Applications/novadeck.app"))).toBe(false)
      expect(existsSync(join(result.trash, "novadeck.app"))).toBe(true)
    })

    it("keeps a copy already in the Trash", () => {
      const result = run({ mac: { existing: "system" }, args: uninstall })
      mkdirSync(join(result.applications, "novadeck.app/Contents/MacOS"), { recursive: true })
      expect(result.again(uninstall).status).toBe(0)
      expect(readdirSync(result.trash)).toHaveLength(2)
      expect(existsSync(join(result.applications, "novadeck.app"))).toBe(false)
    })

    it("refuses while Novadeck runs, and leaves the app", () => {
      const result = run({ mac: { existing: "system", running: "installed" }, args: uninstall })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("Quit it and run this again")
      expect(existsSync(executable(result.applications))).toBe(true)
      expect(existsSync(result.trash)).toBe(false)
    })

    it("leaves a link named novadeck.app alone", () => {
      const result = run({ mac: {}, args: uninstall })
      mkdirSync(join(result.home, "elsewhere"))
      symlinkSync(join(result.home, "elsewhere"), join(result.applications, "novadeck.app"))
      const again = result.again(uninstall)
      expect(again.status).toBe(0)
      expect(again.stdout).toContain("not installed")
      expect(existsSync(join(result.home, "elsewhere"))).toBe(true)
    })

    it("refuses an app Homebrew installed, and says how to remove it", () => {
      const result = run({ mac: { existing: "system" }, cask: true, args: uninstall })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("brew uninstall --cask novadeck")
      expect(existsSync(executable(result.applications))).toBe(true)
    })

    it("says so, and succeeds, when nothing is installed", () => {
      const result = run({ mac: {}, args: uninstall })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("not installed")
      expect(result.lines).toEqual([])
    })
  })

  context("on another platform", () => {
    it("points Windows to its installer and downloads nothing", () => {
      const result = run({ uname: { system: "MINGW64_NT-10.0" } })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        "acme/novadeck/releases/latest/download/novadeck-win-x64-setup.exe",
      )
      expect(result.lines).toEqual([])
    })

    it("refuses other architectures on Linux", () => {
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
        restrict: "1",
        parser: "valid",
        script: script.slice(0, Math.floor(script.length * share)),
      })
      expect(result.lines).toEqual([])
      expect(result.profile).toBeUndefined()
    })
  })

  context("when finding the real path of a relative one", () => {
    it("stops instead of looping", () => {
      const functionText = script.match(/^canonical_path\(\) \{[\s\S]*?^\}/m)![0]
      const result = spawnSync("/bin/sh", ["-c", `${functionText}\ncanonical_path no/such/file`], {
        encoding: "utf8",
        timeout: 5000,
      })
      expect(result.status).toBe(0)
      expect(result.stdout.trim().endsWith("/no/such/file")).toBe(true)
    })
  })
})
