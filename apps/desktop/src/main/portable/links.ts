import type { WhatsNew } from "@novadeck/protocol/bridge"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import {
  openPortableDownloadChannel,
  showDataFolderChannel,
  updateNewsChannel,
} from "../../bridge.js"

/**
 * A path as the person finds it in their file manager: relative to their home as `~` on
 * Linux and macOS, where paths are written so, and in full on Windows.
 */
export const shownPath = (
  path: string,
  { platform, home }: { readonly platform: NodeJS.Platform; readonly home: string },
): string =>
  platform !== "win32" && home !== "/" && path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path

/** The website's download page, at the section for this system's portable copy. */
export const portableDownloadUrl = (platform: NodeJS.Platform): string | undefined => {
  const section =
    platform === "darwin"
      ? "macos"
      : platform === "win32"
        ? "windows"
        : platform === "linux"
          ? "linux"
          : undefined
  return section === undefined ? undefined : `https://novadeck.dev/download#${section}`
}

type LinksIpc = {
  on(channel: string, listener: (event: IpcMainEvent) => void): unknown
  handle(channel: string, listener: (event: IpcMainInvokeEvent) => unknown): unknown
}

/**
 * Answers the app's own pages a portable copy shows: the requests to open the download
 * page and to show the data folder, which take no value, and the one for what is new in the
 * offered version. `window` names the window of a request from the main frame of the app's
 * own page, or undefined for any other sender, which is ignored (and told there is nothing
 * new). The download page opens only from a portable copy, at an address built here.
 */
export const registerPortableLinksIpc = <Window>(
  ipc: LinksIpc,
  {
    window,
    portable,
    openDownload,
    showDataFolder,
    news,
    log,
  }: {
    readonly window: (event: IpcMainEvent | IpcMainInvokeEvent) => Window | undefined
    readonly portable: boolean
    /** Opens the address in the browser. */
    readonly openDownload: (url: string) => Promise<void> | void
    readonly showDataFolder: () => void
    readonly news: () => Promise<WhatsNew | undefined>
    readonly log: (message: string, error: unknown) => void
  },
): void => {
  // Nothing waits on a request, so a failure is logged here.
  const guarded = (what: string, act: () => unknown): void => {
    try {
      Promise.resolve(act()).catch((error: unknown) => log(what, error))
    } catch (error) {
      log(what, error)
    }
  }
  ipc.on(openPortableDownloadChannel, (event) => {
    if (window(event) === undefined || !portable) return
    const url = portableDownloadUrl(process.platform)
    if (url !== undefined) guarded("The download page did not open.", () => openDownload(url))
  })
  ipc.on(showDataFolderChannel, (event) => {
    if (window(event) !== undefined) guarded("The data folder was not shown.", showDataFolder)
  })
  ipc.handle(updateNewsChannel, (event) =>
    window(event) === undefined ? undefined : news().catch(() => undefined),
  )
}
