import { desktopBadgeOf, type DesktopBadge } from "@novadeck/protocol/bridge"
import type { IpcMainEvent } from "electron"

import { badgeChannel } from "../../bridge.js"

type BadgeIpc = {
  on(channel: string, listener: (event: IpcMainEvent, value: unknown) => void): unknown
}

/**
 * Takes the page's Inbox count for the app icon. `window` names the window of a report
 * from the app's own page, or undefined for any other sender, whose reports are dropped,
 * as are badges that are not valid (`desktopBadgeOf`). `apply` gets the window and the
 * badge.
 */
export const registerBadgeIpc = <Window>(
  ipc: BadgeIpc,
  {
    window,
    apply,
  }: {
    readonly window: (event: IpcMainEvent) => Window | undefined
    readonly apply: (window: Window, badge: DesktopBadge) => void
  },
): void => {
  ipc.on(badgeChannel, (event, value) => {
    const target = window(event)
    const badge = desktopBadgeOf(value)
    if (target === undefined || !badge) return
    apply(target, badge)
  })
}

/** The text of the macOS dock badge: the count, "99+" beyond what the dock shows well. */
export const dockBadgeText = (count: number): string =>
  count <= 0 ? "" : count > 99 ? "99+" : String(count)

/** What applying a badge takes of Electron. */
export type BadgeTarget = {
  readonly platform: NodeJS.Platform
  readonly app: {
    setBadgeCount(count: number): unknown
    readonly dock?: { setBadge(text: string): unknown } | undefined
  }
  readonly nativeImage: { createFromDataURL(url: string): unknown }
  readonly window: {
    isDestroyed(): boolean
    setOverlayIcon(image: unknown, description: string): void
  }
}

/**
 * Shows the badge on the app's icon: on macOS the dock's text, on Linux the launcher's
 * count (Unity and KDE show it, other desktops ignore it), on Windows the taskbar overlay
 * drawn from the badge's image with a description screen readers speak. A count of 0, or
 * on Windows no image, clears it. Nothing happens on Windows for a window that is gone.
 */
export const applyBadge = (
  { platform, app, nativeImage, window }: BadgeTarget,
  { count, image }: DesktopBadge,
): void => {
  if (platform === "darwin") {
    app.dock?.setBadge(dockBadgeText(count))
  } else if (platform === "win32") {
    if (window.isDestroyed()) return
    if (count > 0 && image) {
      const icon = nativeImage.createFromDataURL(image)
      window.setOverlayIcon(icon, `${count} waiting in the Inbox`)
    } else {
      window.setOverlayIcon(null, "")
    }
  } else {
    app.setBadgeCount(count)
  }
}
