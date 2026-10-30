import { execFileSync } from "node:child_process"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach } from "vitest"

import { context, describe, expect, it } from "../../test"
import {
  desktopEntry,
  execQuote,
  extractWithProcess,
  failureReason,
  findInstalled,
  imageVersionOf,
  installAppImage,
  installLayout,
  newerCopy,
  readImageVersion,
  type Extract,
  type InstallFiles,
} from "./linux"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "novadeck-install-test-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// The install script's own exec_quote, taken out of the file so that the port is held to it.
const shellQuote = (path: string): string => {
  const script = execFileSync(
    "cat",
    [new URL("../../../../../scripts/install/install.sh", import.meta.url).pathname],
    {
      encoding: "utf8",
    },
  )
  const definition = /^exec_quote\(\) \{\n[\s\S]*?\n\}$/mu.exec(script)?.[0]
  if (!definition) throw new Error("install.sh has no exec_quote")
  return execFileSync("sh", ["-c", `${definition}\nexec_quote "$1"`, "sh", path], {
    encoding: "utf8",
  }).replace(/\n$/u, "")
}

// What runs sh, sets file modes or links files: the Linux install, which Windows never runs.
// "Reading an AppImage's version" also points TMPDIR at a missing folder, which Windows'
// os.tmpdir ignores.
const posix = describe.skipIf(process.platform === "win32")

posix("the quoted path of a menu entry", () => {
  it("escapes quotes, backticks, dollars, backslashes and percent signs as the install script does", () => {
    expect(execQuote("/home/me/plain")).toBe("/home/me/plain")
    expect(execQuote('a"b')).toBe('a\\\\"b')
    expect(execQuote("a`b")).toBe("a\\\\`b")
    expect(execQuote("a$b")).toBe("a\\\\$b")
    expect(execQuote("a\\b")).toBe("a\\\\\\\\b")
    expect(execQuote("100%")).toBe("100%%")
  })

  it("matches the install script's exec_quote on awkward paths", () => {
    for (const path of [
      "/home/me/.local/share/novadeck/novadeck.AppImage",
      "/home/me/my apps/n.AppImage",
      '/home/"quoted"/n.AppImage',
      "/home/$HOME/`x`/n.AppImage",
      "/home/back\\slash/100%/n.AppImage",
      '/home/\\\\"$`%/n.AppImage',
    ])
      expect(execQuote(path)).toBe(shellQuote(path))
  })
})

describe("the menu entry", () => {
  it("is what the install script writes, with the icon when there is one", () => {
    expect(
      desktopEntry("/home/me/.local/share/novadeck/novadeck.AppImage", "/home/me/icon.png"),
    ).toBe(
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Novadeck",
        "Comment=A workspace for parallel terminals.",
        'Exec="/home/me/.local/share/novadeck/novadeck.AppImage" %U',
        "Icon=/home/me/icon.png",
        "Terminal=false",
        "Categories=Utility;",
        "StartupWMClass=dev.mzpk.novadeck",
        "",
      ].join("\n"),
    )
  })

  it("names the icon novadeck without one", () => {
    expect(desktopEntry("/x/n.AppImage", undefined)).toContain("\nIcon=novadeck\n")
  })
})

describe("the version an AppImage reports", () => {
  it("is the X-AppImage-Version of its menu entry", () => {
    expect(imageVersionOf("[Desktop Entry]\nX-AppImage-Version=0.0.71\nName=x\n")).toBe("0.0.71")
    expect(imageVersionOf("X-AppImage-Version=1.2.3-beta.1\n")).toBe("1.2.3-beta.1")
  })

  it("is nothing when the entry names none, or one a release cannot have", () => {
    expect(imageVersionOf("Name=x\n")).toBeUndefined()
    expect(imageVersionOf("X-AppImage-Version=latest\n")).toBeUndefined()
    expect(imageVersionOf("X-AppImage-Version=\n")).toBeUndefined()
  })
})

// An AppImage as `--appimage-extract` leaves it: what it holds under squashfs-root.
const extractFrom =
  (contents: Readonly<Record<string, string>>): Extract =>
  async (_image, pattern, into) => {
    const files = Object.entries(contents).filter(([name]) =>
      pattern === "*.desktop" ? name.endsWith(".desktop") && !name.includes("/") : name === pattern,
    )
    await Promise.all(
      files.map(async ([name, text]) => {
        const path = join(into, "squashfs-root", name)
        await mkdir(join(path, ".."), { recursive: true })
        await writeFile(path, text)
      }),
    )
  }

const icon = "usr/share/icons/hicolor/512x512/apps/novadeck.png"
const appImage = (version: string): Record<string, string> => ({
  "dev.mzpk.novadeck.desktop": `[Desktop Entry]\nX-AppImage-Version=${version}\n`,
  [icon]: "png",
})

// The extraction fails as running a file does: with a status, a spawn error, or a timeout.
const failing =
  (failure: Error): Extract =>
  () =>
    Promise.reject(failure)

// The first 11 bytes of an AppImage: ELF magic, then the type 2 marker at bytes 8 to 10.
const appImageHeader = "\x7fELF\0\0\0\0AI\x02"

// A file with `text` after `header` in the test folder, and its path.
const imageFile = async (
  text = "",
  header = appImageHeader,
  name = "x.AppImage",
): Promise<string> => {
  const file = join(root, name)
  await writeFile(file, header + text)
  return file
}

posix("reading an AppImage's version", () => {
  it("extracts its menu entry and reads it, leaving nothing behind", async () => {
    let folder = ""
    const extract: Extract = (image, pattern, into) => {
      folder = into
      return extractFrom(appImage("0.0.71"))(image, pattern, into)
    }
    expect(await readImageVersion(await imageFile(), extract)).toEqual({
      version: "0.0.71",
      unchecked: false,
    })
    await expect(stat(folder)).rejects.toThrow()
  })

  it("has no version when the runtime ran but the image names none", async () => {
    const none = { version: undefined, unchecked: false }
    const file = await imageFile()
    expect(await readImageVersion(file, extractFrom({}))).toEqual(none)
    expect(await readImageVersion(file, extractFrom({ "n.desktop": "[Desktop Entry]\n" }))).toEqual(
      none,
    )
    expect(
      await readImageVersion(file, extractFrom({ "n.desktop": "X-AppImage-Version=latest\n" })),
    ).toEqual(none)
  })

  it("has no version when the file is no AppImage, by its first bytes, or the system says it is no program", async () => {
    const none = { version: undefined, unchecked: false }
    let ran = false
    const extract: Extract = () => {
      ran = true
      return Promise.resolve()
    }
    const headers = ["", "#!/bin/sh\n", "\x7fELF\0\0\0\0AI\x01", "\x7fELF", "garbage!!!!"]
    const found = await Promise.all(
      headers.map(async (header, index) =>
        readImageVersion(await imageFile("", header, `${index}.AppImage`), extract),
      ),
    )
    expect(found).toEqual(headers.map(() => none))
    expect(ran).toBe(false)
    expect(await readImageVersion(await imageFile(), failing(error("ENOEXEC")))).toEqual(none)
  })

  it("could not be checked when the look itself failed, whatever the file is", async () => {
    const unchecked = { version: undefined, unchecked: true }
    // A status (the runtime printing "mkdir_p error: Permission denied" and exiting 1 in a
    // temporary folder it cannot use), a missing exec bit, a timeout (the child is killed:
    // no status), and anything else unknown.
    const failures = [
      Object.assign(new Error("exit 1"), { code: 1 }),
      error("EACCES"),
      error("ENOENT"),
      Object.assign(new Error("timed out"), { killed: true, code: null, signal: "SIGTERM" }),
      new Error("odd"),
    ]
    const file = await imageFile()
    const found = await Promise.all(
      failures.map((failure) => readImageVersion(file, failing(failure))),
    )
    expect(found).toEqual(failures.map(() => unchecked))
  })

  it("could not be checked when the file cannot be read", async () => {
    expect(await readImageVersion(join(root, "missing"), extractFrom(appImage("1.0.0")))).toEqual({
      version: undefined,
      unchecked: true,
    })
  })

  it("could not be checked when there is no temporary folder", async () => {
    const file = await imageFile()
    const before = process.env.TMPDIR
    process.env.TMPDIR = join(root, "missing")
    try {
      expect(await readImageVersion(file, extractFrom(appImage("1.0.0")))).toEqual({
        version: undefined,
        unchecked: true,
      })
    } finally {
      if (before === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = before
    }
  })
})

posix("the AppImages already installed", () => {
  const env = {}
  const layout = (): ReturnType<typeof installLayout> => installLayout({ env, home: root })

  it("are those of the installer and of Homebrew that exist, with their versions", async () => {
    const { image } = layout()
    await mkdir(join(image, ".."), { recursive: true })
    await writeFile(image, `${appImageHeader}one`)
    await mkdir(join(root, "Applications"), { recursive: true })
    await writeFile(join(root, "Applications", "novadeck.AppImage"), `${appImageHeader}two`)
    const versions = new Map([
      [`${appImageHeader}one`, "0.0.5"],
      [`${appImageHeader}two`, "0.0.9"],
    ])
    const extract: Extract = async (path, pattern, into) =>
      extractFrom(appImage(versions.get(await readFile(path, "utf8"))!))(path, pattern, into)
    expect(await findInstalled({ env, home: root }, extract)).toEqual([
      { image, version: "0.0.5", unchecked: false },
      {
        image: join(root, "Applications", "novadeck.AppImage"),
        version: "0.0.9",
        unchecked: false,
      },
    ])
  })

  it("are none where nothing is installed, and one where Homebrew's links to the installer's", async () => {
    expect(await findInstalled({ env, home: root }, extractFrom(appImage("1.0.0")))).toEqual([])
    const { image } = layout()
    await mkdir(join(image, ".."), { recursive: true })
    await writeFile(image, `${appImageHeader}one`)
    await mkdir(join(root, "Applications"), { recursive: true })
    await symlink(image, join(root, "Applications", "novadeck.AppImage"))
    expect(await findInstalled({ env, home: root }, extractFrom(appImage("1.0.0")))).toEqual([
      { image, version: "1.0.0", unchecked: false },
    ])
  })
})

const copy = (version: string | undefined, image = "/i") => ({
  image,
  version,
  unchecked: false,
})

describe("the installed copy that is newer", () => {
  it("is the newest of those newer than the running one", () => {
    expect(
      newerCopy([copy("1.2.0", "/a"), copy("1.3.0", "/b"), copy("0.9.0", "/c")], "1.0.0"),
    ).toEqual(copy("1.3.0", "/b"))
  })

  it("is nothing when each is the same, older, or reports no version", () => {
    expect(newerCopy([copy("1.0.0"), copy("0.9.0"), copy(undefined)], "1.0.0")).toBeUndefined()
    expect(newerCopy([], "1.0.0")).toBeUndefined()
    expect(newerCopy([{ ...copy(undefined), unchecked: true }], "1.0.0")).toBeUndefined()
  })
})

posix("installing an AppImage", () => {
  const layout = (): ReturnType<typeof installLayout> => installLayout({ env: {}, home: root })
  const source = (): string => join(root, "Downloads", "novadeck.AppImage")
  const write = async (): Promise<void> => {
    await mkdir(join(root, "Downloads"), { recursive: true })
    await writeFile(source(), "the app", { mode: 0o644 })
  }

  it("puts the file, command, icon and menu entry where the install script does", async () => {
    await write()
    const result = await installAppImage(source(), layout(), extractFrom(appImage("1.0.0")))
    const { image, link, desktop, icon: iconFile } = layout()
    expect(result).toEqual({ kind: "installed", image })
    expect(image).toBe(join(root, ".local/share/novadeck/novadeck.AppImage"))
    expect(await readFile(image, "utf8")).toBe("the app")
    expect((await stat(image)).mode & 0o111).not.toBe(0)
    expect(await readlink(link)).toBe(image)
    expect(await readFile(iconFile, "utf8")).toBe("png")
    expect(await readFile(desktop, "utf8")).toBe(desktopEntry(image, iconFile))
    expect(await readdir(join(image, ".."))).toEqual(["novadeck.AppImage"])
  })

  it("reads the icon from the installed copy, not from where the source is", async () => {
    await write()
    const asked: string[] = []
    const extract: Extract = (image, pattern, into) => {
      asked.push(image)
      return extractFrom(appImage("1.0.0"))(image, pattern, into)
    }
    await installAppImage(source(), layout(), extract)
    expect(asked).toEqual([layout().image])
  })

  it("writes only the file when replacing a copy elsewhere, such as Homebrew's", async () => {
    await write()
    const target = join(root, "Applications", "novadeck.AppImage")
    await mkdir(join(target, ".."), { recursive: true })
    await writeFile(target, "old")
    const result = await installAppImage(source(), layout(), extractFrom(appImage("1.0.0")), target)
    expect(result).toEqual({ kind: "installed", image: target })
    expect(await readFile(target, "utf8")).toBe("the app")
    expect(await readdir(join(target, ".."))).toEqual(["novadeck.AppImage"])
    expect(await readdir(root)).toEqual(["Applications", "Downloads"])
  })

  it("follows XDG_DATA_HOME", async () => {
    await write()
    const data = join(root, "data")
    const result = await installAppImage(
      source(),
      installLayout({ env: { XDG_DATA_HOME: data }, home: root }),
      extractFrom(appImage("1.0.0")),
    )
    expect(result).toEqual({
      kind: "installed",
      image: join(data, "novadeck/novadeck.AppImage"),
    })
    expect(await stat(join(data, "applications/dev.mzpk.novadeck.desktop"))).toBeTruthy()
  })

  it("replaces an installed file and an old command", async () => {
    await write()
    const { image, link } = layout()
    await mkdir(join(image, ".."), { recursive: true })
    await mkdir(join(link, ".."), { recursive: true })
    await writeFile(image, "old")
    await writeFile(link, "not a link")
    await installAppImage(source(), layout(), extractFrom(appImage("1.0.0")))
    expect(await readFile(image, "utf8")).toBe("the app")
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })

  context("when the AppImage has no icon", () => {
    it("writes an entry without one and still installs", async () => {
      await write()
      const result = await installAppImage(source(), layout(), extractFrom({}))
      expect(result.kind).toBe("installed")
      expect(await readFile(layout().desktop, "utf8")).toContain("\nIcon=novadeck\n")
    })
  })

  context("when the file cannot be copied", () => {
    // Writes some of the file, as a full disk does, then fails.
    const filling: InstallFiles = {
      copyFile: async (_source, target) => {
        await writeFile(String(target), "the a")
        throw Object.assign(new Error("no space"), { code: "ENOSPC" })
      },
    }

    it("fails with a reason, removes the partial copy and leaves the installed file", async () => {
      await write()
      const { image } = layout()
      await mkdir(join(image, ".."), { recursive: true })
      await writeFile(image, "old")
      const result = await installAppImage(
        source(),
        layout(),
        extractFrom(appImage("1.0.0")),
        image,
        filling,
      )
      expect(result).toEqual({ kind: "failed", reason: "There is no space left on the disk." })
      expect(await readFile(image, "utf8")).toBe("old")
      expect(await readdir(join(image, ".."))).toEqual(["novadeck.AppImage"])
    })

    it("changes nothing else: no icon, command or menu entry", async () => {
      await write()
      await installAppImage(source(), layout(), extractFrom(appImage("1.0.0")), undefined, filling)
      const { icon: iconFile, link, desktop } = layout()
      await Promise.all(
        [iconFile, link, desktop].map((path) => expect(lstat(path)).rejects.toThrow()),
      )
    })

    it("fails when the source is missing", async () => {
      const result = await installAppImage(source(), layout(), extractFrom({}))
      expect(result).toMatchObject({ kind: "failed" })
      await expect(lstat(layout().icon)).rejects.toThrow()
    })
  })

  context("when the installed place is a symlink, as Homebrew's is", () => {
    it("replaces the file it leads to and keeps the link", async () => {
      await write()
      const real = join(root, "Caskroom", "novadeck.AppImage")
      const place = join(root, "Applications", "novadeck.AppImage")
      await mkdir(join(real, ".."), { recursive: true })
      await mkdir(join(place, ".."), { recursive: true })
      await writeFile(real, "old")
      await symlink(real, place)
      const result = await installAppImage(
        source(),
        layout(),
        extractFrom(appImage("1.0.0")),
        place,
      )
      expect(result).toEqual({ kind: "installed", image: place })
      expect((await lstat(place)).isSymbolicLink()).toBe(true)
      expect(await readlink(place)).toBe(real)
      expect(await readFile(real, "utf8")).toBe("the app")
      expect(await readdir(join(real, ".."))).toEqual(["novadeck.AppImage"])
      expect(await readdir(join(place, ".."))).toEqual(["novadeck.AppImage"])
    })
  })

  it("fails for an install path with a line break", async () => {
    await write()
    const result = await installAppImage(
      source(),
      { ...layout(), image: join(root, "a\nb.AppImage") },
      extractFrom({}),
    )
    expect(result).toEqual({
      kind: "failed",
      reason: "The install path is not valid.",
    })
  })
})

const error = (code: string): Error => Object.assign(new Error(code), { code })

describe("why an install failed", () => {
  it("says so for a full disk and a folder that cannot be written", () => {
    expect(failureReason(error("ENOSPC"), "/x")).toBe("There is no space left on the disk.")
    for (const code of ["EACCES", "EPERM", "EROFS"])
      expect(failureReason(error(code), "/x")).toBe("Novadeck cannot write to /x.")
  })

  it("gives the error's own message otherwise", () => {
    expect(failureReason(new Error("boom"), "/x")).toBe("boom")
    const cut = failureReason(new Error("x".repeat(500)), "/x")
    expect(cut).toBe(`${"x".repeat(199)}…`)
    // A surrogate pair is never split at the cut.
    const emoji = failureReason(new Error("😀".repeat(300)), "/x")
    expect(Array.from(emoji)).toHaveLength(200)
    expect(emoji.endsWith("😀…")).toBe(true)
    expect(failureReason(new Error("y".repeat(200)), "/x")).toBe("y".repeat(200))
    expect(failureReason("odd", "/x")).toBe("Something went wrong.")
  })
})

posix("the extraction as a child process", () => {
  it("runs the AppImage with the environment it is given and nothing else", async () => {
    const program = join(root, "program.AppImage")
    await writeFile(program, '#!/bin/sh\nenv > "$PWD/environment"\n', { mode: 0o755 })
    const into = join(root, "into")
    await mkdir(into)
    await extractWithProcess({ KEPT: "yes" })(program, "*.desktop", into)
    const seen = await readFile(join(into, "environment"), "utf8")
    expect(seen).toContain("KEPT=yes")
    expect(seen).not.toContain("HOME=")
  })
})
