import { execFileSync } from "node:child_process"

import type { DebUpdater } from "electron-updater"

/** The deb package's name, which `extraMetadata.name` in electron-builder.yml sets. */
export const debPackageName = "novadeck"

/**
 * The one privileged command that installs a downloaded deb, dependencies included, so
 * the person is asked for their password once. electron-updater tries `dpkg -i` first and,
 * if that fails, `apt-get install -f -y`, which is a second prompt after a dismissed
 * first one, and which installs nothing from the file but succeeds all the same. apt-get
 * waits up to a minute for the dpkg lock, which unattended-upgrades and PackageKit hold
 * for a while after a boot, rather than fail at once; apt releases before 1.9.11 ignore
 * the setting and fail at once. A lock that outlasts the wait still fails the install,
 * and cannot be told from other apt failures (they all exit 100) without apt's message.
 */
export const debInstallCommand = (path: string, hasAptGet: boolean): string[] =>
  hasAptGet
    ? ["apt-get", "-o", "DPkg::Lock::Timeout=60", "install", "-y", path]
    : ["dpkg", "-i", path]

/**
 * Whether the version dpkg reports for the installed package is the offered release's.
 * The package manager spells a prerelease with `~` and may add a revision, so
 * `1.2.3~beta.1-1` is the release `1.2.3-beta.1`.
 */
export const installedMatches = (installed: string, offered: string): boolean => {
  const version = installed.trim().replaceAll("~", "-")
  return version === offered || version.replace(/-\d+$/u, "") === offered
}

/** What installing a deb uses of the system. */
export type DebInstall = {
  /** Runs a command as root, asking for the person's password; throws unless it succeeds. */
  readonly run: (command: string[]) => void
  readonly hasCommand: (name: string) => boolean
  /** The installed package's version, or undefined when it cannot be asked. */
  readonly installed: () => string | undefined
}

/**
 * Installs the deb at `path` with a single privileged command and throws unless it
 * succeeded, which is when the command exits without error and, where dpkg can say, the
 * package it left is `offered`: a prompt that was dismissed, a missing polkit agent, or
 * a command that returned without installing this file all fail.
 */
export const installDeb = (
  { run, hasCommand, installed }: DebInstall,
  path: string,
  offered: string | undefined,
): void => {
  run(debInstallCommand(path, hasCommand("apt-get")))
  const version = installed()
  if (offered !== undefined && version !== undefined && !installedMatches(version, offered))
    throw new Error(`Installing the update left version ${version} installed, not ${offered}.`)
}

const queriedVersion = (): string | undefined => {
  try {
    return execFileSync("dpkg-query", ["-W", "-f=${Version}", debPackageName], {
      encoding: "utf8",
      timeout: 10_000,
    })
  } catch {
    return undefined
  }
}

/**
 * electron-updater's deb updater with an install that is one prompt and that checks
 * its result; the download and the rest are its own. `offered` is the version of the
 * downloaded release.
 */
export const verifiedDebUpdater = (
  Base: typeof DebUpdater,
  offered: () => string | undefined,
): DebUpdater =>
  new (class extends Base {
    protected override doInstall(options: { readonly isForceRunAfter: boolean }): boolean {
      const path = this.installerPath
      if (path == null) {
        this.dispatchError(new Error("No update filepath provided, can't quit and install"))
        return false
      }
      try {
        installDeb(
          {
            run: (command) => void this.runCommandWithSudoIfNeeded(command),
            hasCommand: (name) => this.hasCommand(name),
            installed: queriedVersion,
          },
          path,
          offered(),
        )
      } catch (error) {
        this.dispatchError(error as Error)
        return false
      }
      if (options.isForceRunAfter) this.app.relaunch()
      return true
    }
  })()
