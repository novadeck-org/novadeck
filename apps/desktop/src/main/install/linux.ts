import { execFile } from "node:child_process"
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { updateVersionPattern } from "@novadeck/protocol/bridge"

import { isNewerVersion } from "../release/versions.js"
import { dataHome, installedImage, installedImages, type InstallLocationHost } from "./location.js"
import { reasonText } from "./reason.js"

// Where an AppImage keeps its icon at the size the installer extracts.
const iconPath = "usr/share/icons/hicolor/512x512/apps/novadeck.png"

/**
 * Every place an install writes to, as `scripts/install/install.sh` lays them out: the
 * AppImage, a `novadeck` command that links to it, a menu entry, and the icon the entry
 * names, under the data folder `XDG_DATA_HOME` names.
 */
export type InstallLayout = {
  readonly image: string
  readonly link: string
  readonly desktop: string
  readonly icon: string
}

export const installLayout = (host: Pick<InstallLocationHost, "env" | "home">): InstallLayout => {
  const data = dataHome(host)
  return {
    image: installedImage(host),
    link: `${host.home}/.local/bin/novadeck`,
    desktop: `${data}/applications/dev.mzpk.novadeck.desktop`,
    icon: `${data}/icons/hicolor/512x512/apps/novadeck.png`,
  }
}

/**
 * A path as the inside of a quoted `Exec` argument in a desktop entry, as `exec_quote`
 * in install.sh writes it. The desktop entry specification escapes `"`, `` ` ``, `$` and
 * `\\` with a backslash, and then, as `Exec` is a string, every backslash again, so a
 * backslash in a path becomes four and each of the others two. A percent sign is doubled,
 * as it starts a field code.
 */
export const execQuote = (path: string): string =>
  path
    .replaceAll("\\", "\\\\\\\\")
    .replaceAll(/["`$]/gu, (character) => `\\\\${character}`)
    .replaceAll("%", "%%")

/**
 * The menu entry for the AppImage at `image`, byte for byte what install.sh writes. A
 * missing `icon` leaves the name `novadeck`, which the icon theme may still find.
 */
export const desktopEntry = (image: string, icon: string | undefined): string =>
  [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Novadeck",
    "Comment=A workspace for parallel terminals.",
    `Exec="${execQuote(image)}" %U`,
    `Icon=${icon ?? "novadeck"}`,
    "Terminal=false",
    "Categories=Utility;",
    "StartupWMClass=dev.mzpk.novadeck",
    "",
  ].join("\n")

/**
 * What looking at an installed AppImage's version found: the `version`; none, when the
 * file ran but names no readable one, so it is not known to be an app a release made; or
 * `unchecked`, when the look itself failed, say for want of a temporary folder, a timeout,
 * or the exec bit, and the file may well be a good copy.
 */
export type ImageVersion = {
  readonly version: string | undefined
  readonly unchecked: boolean
}

/** An installed AppImage and what looking at its version found. */
export type InstalledCopy = { readonly image: string } & ImageVersion

/**
 * The installed copy that is a newer version than `running`, or the newest if several
 * are. A copy whose version is not known is not known to be newer, so it does not count.
 */
export const newerCopy = (
  copies: readonly InstalledCopy[],
  running: string,
): (InstalledCopy & { readonly version: string }) | undefined => {
  let best: (InstalledCopy & { readonly version: string }) | undefined
  for (const copy of copies) {
    const { version } = copy
    if (version === undefined || !isNewerVersion(version, running)) continue
    if (best === undefined || isNewerVersion(version, best.version)) best = { ...copy, version }
  }
  return best
}

/**
 * The installed copy that is the same version as `running` or newer, the newest if several
 * are, preferring the earliest listed among equals. A copy whose version is not known does
 * not count.
 */
export const currentOrNewerCopy = (
  copies: readonly InstalledCopy[],
  running: string,
): (InstalledCopy & { readonly version: string }) | undefined => {
  const newer = newerCopy(copies, running)
  if (newer) return newer
  for (const copy of copies) {
    const { version } = copy
    if (version !== undefined && version.trim() === running.trim()) return { ...copy, version }
  }
  return undefined
}

/**
 * The version an AppImage's menu entry names, `X-AppImage-Version`, which electron-builder
 * writes from the package version, or undefined when it names none a release has.
 */
export const imageVersionOf = (desktop: string): string | undefined => {
  const version = /^X-AppImage-Version=(.*)$/mu.exec(desktop)?.[1]?.trim()
  return version !== undefined && updateVersionPattern.test(version) ? version : undefined
}

/**
 * Runs `image --appimage-extract <pattern>` with `into` as the working directory, which
 * leaves what matched under `into/squashfs-root`. The AppImage extracts itself without
 * mounting, so this needs no FUSE and starts no app.
 */
export type Extract = (image: string, pattern: string, into: string) => Promise<void>

/**
 * The extraction as a child process; a hung or failing AppImage ends it with an error.
 * It runs with `env` alone, which is this copy's less what its own AppImage runtime set
 * (see `installedEnvironment`), as the installed copy itself is started.
 */
export const extractWithProcess =
  (env: Readonly<Record<string, string | undefined>>): Extract =>
  (image, pattern, into) =>
    new Promise((resolve, reject) => {
      execFile(
        image,
        ["--appimage-extract", pattern],
        { cwd: into, env, timeout: 20_000, maxBuffer: 1 << 20 },
        (error) => (error ? reject(error) : resolve()),
      )
    })

// Runs `work` in a temporary folder, which is gone afterwards however it went.
const inTemporaryFolder = async <T>(work: (folder: string) => Promise<T>): Promise<T> => {
  const folder = await mkdtemp(join(tmpdir(), "novadeck-"))
  try {
    return await work(folder)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

// Whether the first bytes of a file are those of an AppImage: an ELF program, and at
// bytes 8 to 10 the type 2 AppImage marker "AI\x02".
const isAppImageHeader = (header: Buffer): boolean =>
  header.length >= 11 &&
  header.subarray(0, 4).equals(Buffer.from("\x7fELF", "latin1")) &&
  header.subarray(8, 11).equals(Buffer.from("AI\x02", "latin1"))

// The first bytes of `file`, or undefined when it cannot be read.
const readHeader = async (file: string): Promise<Buffer | undefined> => {
  try {
    const handle = await open(file, "r")
    try {
      const { bytesRead, buffer } = await handle.read(Buffer.alloc(11), 0, 11, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/**
 * The version of the AppImage at `image`, read from the menu entry inside it. This runs
 * the file's own AppImage runtime with `--appimage-extract`, which unpacks the entry
 * without starting the app. A file that is no AppImage by its first bytes, or the system
 * finds is no program, or whose runtime ran and found no menu entry or version, has none.
 * Anything else that goes wrong is the environment's doing, whatever the runtime then
 * exits with, say for a temporary folder it cannot write: the file is `unchecked`, and
 * may well be a good copy.
 */
export const readImageVersion = async (image: string, extract: Extract): Promise<ImageVersion> => {
  const header = await readHeader(image)
  if (header === undefined) return { version: undefined, unchecked: true }
  if (!isAppImageHeader(header)) return { version: undefined, unchecked: false }
  let folder: string
  try {
    folder = await mkdtemp(join(tmpdir(), "novadeck-"))
  } catch {
    return { version: undefined, unchecked: true }
  }
  try {
    await extract(image, "*.desktop", folder)
    const root = join(folder, "squashfs-root")
    // Nothing matched: the runtime ran, and the image holds no menu entry.
    const names = await readdir(root).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return []
      throw error
    })
    const entry = names.find((name) => name.endsWith(".desktop"))
    return {
      version:
        entry === undefined ? undefined : imageVersionOf(await readFile(join(root, entry), "utf8")),
      unchecked: false,
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return { version: undefined, unchecked: code !== "ENOEXEC" }
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/**
 * The AppImages already installed: each of the places the installer and Homebrew use that
 * holds a file, once even when one links to the other, with its version. A place with
 * nothing in it is left out.
 */
export const findInstalled = async (
  host: Pick<InstallLocationHost, "env" | "home">,
  extract: Extract,
): Promise<InstalledCopy[]> => {
  const files = await Promise.all(
    installedImages(host).map(async (image) => {
      const real = await realpath(image).catch(() => undefined)
      const file = real !== undefined && (await stat(real)).isFile()
      return file ? { image, real } : undefined
    }),
  )
  const found = files.filter((file) => file !== undefined)
  return Promise.all(
    found
      .filter(({ real }, index) => found.findIndex((other) => other.real === real) === index)
      .map(async ({ image, real }) => ({
        image,
        ...(await readImageVersion(real, extract)),
      })),
  )
}

/** How installing went: the AppImage now installed, or why nothing was. */
export type InstallOutcome =
  | { readonly kind: "installed"; readonly image: string }
  | { readonly kind: "failed"; readonly reason: string }

/** A short sentence for the person about why `error` stopped an install into `folder`. */
export const failureReason = (error: unknown, folder: string): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === "ENOSPC") return "There is no space left on the disk."
  if (code === "EACCES" || code === "EPERM" || code === "EROFS")
    return `Novadeck cannot write to ${folder}.`
  const reason = error instanceof Error ? reasonText(error.message) : ""
  return reason === "" ? "Something went wrong." : reason
}

// The icon from inside the AppImage, copied to `target`, or undefined when it has none.
const copyIcon = async (
  source: string,
  target: string,
  extract: Extract,
): Promise<string | undefined> => {
  try {
    return await inTemporaryFolder(async (folder) => {
      await extract(source, iconPath, folder)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(folder, "squashfs-root", iconPath), target)
      return target
    })
  } catch {
    return undefined
  }
}

/** The file operations an install makes that tests may replace. */
export type InstallFiles = { readonly copyFile: typeof copyFile }

/**
 * Installs the AppImage `source` as install.sh installs a download: the file copied
 * beside its destination and renamed over it, so a running install is replaced whole and
 * a copy that fails leaves the destination as it was, then the icon, the `novadeck`
 * command linked to it, and the menu entry. A file with no icon gets an entry without
 * one. The icon is copied only once the file is in place, so a failed install changes
 * nothing. Running it again repairs a step that failed, so a failure after the file moved
 * is reported, though the new copy is in place. A quit in the middle of the copy can leave
 * `<image>.new` behind, which the next install overwrites. The installed copy updates itself from
 * there; this needs no network.
 *
 * `target` is the file to write, the installed copy being replaced; it defaults to the
 * installer's own path. When it is a symlink, as Homebrew's in `~/Applications` is, the
 * file it leads to is replaced and the link stays. Only a write to the installer's path
 * adds the icon, command and menu entry: a copy elsewhere, such as Homebrew's, is
 * integrated by whatever put it there, and gets the file alone.
 */
export const installAppImage = async (
  source: string,
  layout: InstallLayout,
  extract: Extract,
  target: string = layout.image,
  files: InstallFiles = { copyFile },
): Promise<InstallOutcome> => {
  const { link, desktop } = layout
  const integrate = target === layout.image
  // A line break would end the entry's Exec line early.
  if (/[\p{Cc}]/u.test(target)) return { kind: "failed", reason: "The install path is not valid." }
  const image = await realpath(target).catch(() => target)
  const staged = `${image}.new`
  try {
    await mkdir(dirname(image), { recursive: true })
    await files.copyFile(source, staged)
    await chmod(staged, 0o755)
    await rename(staged, image)
    if (!integrate) return { kind: "installed", image: target }
    // Read from the copy now installed, which sits where the person keeps programs, not from
    // `source`, which may be in a temporary folder that cannot run programs.
    const icon = await copyIcon(image, layout.icon, extract)
    await mkdir(dirname(link), { recursive: true })
    await rm(link, { force: true })
    await symlink(target, link)
    await mkdir(dirname(desktop), { recursive: true })
    await writeFile(desktop, desktopEntry(target, icon))
    return { kind: "installed", image: target }
  } catch (error) {
    await rm(staged, { force: true }).catch(() => {})
    return { kind: "failed", reason: failureReason(error, dirname(image)) }
  }
}
