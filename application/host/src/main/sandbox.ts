import type { SandboxState } from "@novadeck/protocol/bridge"
import type { IpcMainInvokeEvent } from "electron"

import { sandboxChannel } from "../bridge.js"
import type { ReleaseRepository } from "./update-release.js"

/** What choosing a fix looks at of the machine; the caller reads it. */
export type SandboxHost = {
  readonly platform: NodeJS.Platform
  readonly repository: ReleaseRepository | undefined
  /** What `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` says; undefined without it. */
  readonly restricted: string | undefined
  /** This process's AppArmor label, such as `novadeck-appimage-1000 (unconfined)`; undefined without one. */
  readonly label: string | undefined
  /** The environment: `APPIMAGE`, the running AppImage's file, and `XDG_DATA_HOME`. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  /** The canonical form of a path, or undefined when it cannot be had. */
  readonly realpath: (path: string) => string | undefined
}

// The label of a process under one of the installer's profiles, `novadeck-appimage-<uid>`
// or `novadeck-appimage-<uid>-brew`, which may be followed by a mode in parentheses.
const profiled = /^novadeck-appimage-\d+(?:-brew)?(?: \(|$)/u

/**
 * The command that turns the sandbox on, or undefined where none can work. It is for
 * Linux with a release repository, and only where the system restricts unprivileged user
 * namespaces and the installer's profile is not already in effect, which the process's
 * AppArmor label shows. Otherwise there is none, though the cause is not always a choice:
 * a flag or `ELECTRON_DISABLE_SANDBOX` turns the sandbox off on purpose, but a system
 * without user namespaces (a kernel setting, a container, no `unshare`) makes the AppImage
 * start without it too. A relative `XDG_DATA_HOME` counts as unset, as the XDG
 * specification says and the installer does. The installer's AppArmor profile covers the AppImage at
 * the two places it installs to, so an AppImage there needs only the installer's
 * `--sandbox` mode, which writes the profile; one anywhere else, such as Downloads, needs
 * the plain install, which puts it where the profile applies.
 */
export const sandboxFix = ({
  platform,
  repository,
  restricted,
  label,
  env,
  home,
  realpath,
}: SandboxHost): string | undefined => {
  if (platform !== "linux" || !repository || restricted?.trim() !== "1") return undefined
  if (label !== undefined && profiled.test(label)) return undefined
  const appImage = env.APPIMAGE
  if (!appImage) return undefined
  const installer = `curl -fsSL https://github.com/${repository.owner}/${repository.repo}/releases/latest/download/install.sh | sh`
  const data = env.XDG_DATA_HOME?.startsWith("/") ? env.XDG_DATA_HOME : `${home}/.local/share`
  const running = realpath(appImage)
  const covered = [
    `${data}/novadeck/novadeck.AppImage`,
    `${home}/Applications/novadeck.AppImage`,
  ].map(realpath)
  return running !== undefined && covered.includes(running)
    ? `${installer} -s -- --sandbox`
    : installer
}

/**
 * Whether Electron's sandbox is on. It is off when Electron was started with
 * `--no-sandbox`, as the AppImage launcher does when the system refuses it an
 * unprivileged user namespace. The `fix` is empty when there is no command to offer; see
 * `sandboxFix`.
 */
export const sandboxState = (disabled: boolean, host: SandboxHost): SandboxState =>
  disabled ? { sandboxed: false, fix: sandboxFix(host) ?? "" } : { sandboxed: true }

type SandboxIpc = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent) => unknown): unknown
}

/**
 * Answers the app's own pages whether the sandbox is on. `window` names the window of a
 * request from the main frame of the app's own page, or undefined for any other sender,
 * which is told the sandbox is on, as it may learn nothing. The request carries no value.
 */
export const registerSandboxIpc = <Window>(
  ipc: SandboxIpc,
  {
    window,
    state,
  }: {
    readonly window: (event: IpcMainInvokeEvent) => Window | undefined
    readonly state: () => Promise<SandboxState>
  },
): void => {
  ipc.handle(sandboxChannel, (event) =>
    window(event) === undefined ? { sandboxed: true } : state(),
  )
}
