// The live pages in the companion pane, and the pages agents look at out of sight: their
// session, their sign-ins and failed requests, and what the app's own page asks of them.
// The rules live in @novadeck/viewers/browser/host; this hands them Electron.
import type { Log } from "@novadeck/log"
import { onThisMachine, pagesPartition } from "@novadeck/protocol/pages"
import {
  countSignIns,
  createLooker,
  emulatePhone,
  guardPage,
  holdLoupe,
  holdPhoneLoads,
  loupePage,
  lockPagesSession,
  ownZoom,
  pagesSession,
  passkeyLabels,
  phonePage,
  pictureForApp,
  pickPasskeys,
  watchLoupe,
  watchPageRequests,
  zoomPage,
} from "@novadeck/viewers/browser/host"
import { pageLoupeChannel } from "@novadeck/viewers/browser/loupe"
import { pageSignInChannel } from "@novadeck/viewers/browser/sign-in"
import { pageRequestChannel } from "@novadeck/viewers/browser/trouble"
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  webContents,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron"

import {
  pageLookChannel,
  pageLoupeHoldChannel,
  pageLoupeLookChannel,
  pagePhoneChannel,
  pagePictureChannel,
  pageZoomChannel,
} from "../bridge.js"

/** What `forgetWhenGone` needs of a page's contents: Electron's `WebContents`, or a test's. */
type Forgettable = {
  readonly id: number
  once(event: "destroyed", listener: () => void): unknown
  on(
    event: "did-create-window",
    listener: (window: { readonly webContents: Forgettable }) => void,
  ): unknown
}

/**
 * Calls `forget` with the id of `contents` once it is destroyed, and the same for every
 * window it opens, and each window those open, however deep.
 */
export const forgetWhenGone = (contents: Forgettable, forget: (id: number) => void): void => {
  const { id } = contents
  contents.once("destroyed", () => forget(id))
  contents.on("did-create-window", (window) => forgetWhenGone(window.webContents, forget))
}

/** What `createMenuGuard` needs of a window: Electron's `BrowserWindow`, or a test's. */
export type MenuBarWindow = {
  setAutoHideMenuBar(hide: boolean): void
  setMenuBarVisibility(visible: boolean): void
}

/**
 * Keeps a window's menu bar from toggling on Alt while the pointer is over one of its page
 * views or Alt is down, which would show it and move the page under the pointer, the loupe's
 * Alt (see `watchLoupe`) being just that. Its keys go on to the page as they are: only the
 * window's own handling of a bare Alt is switched off, and back once nothing holds it. The
 * menu stays reachable as before, through the accelerators it holds.
 */
export const createMenuGuard = <Contents extends { readonly id: number }>(
  windowOf: (contents: Contents) => MenuBarWindow | undefined,
  // How the restore waits, which a test stands in for.
  later: (run: () => void, ms: number) => unknown = setTimeout,
) => {
  const holding = new Map<MenuBarWindow, Set<number>>()
  const where = new Map<number, MenuBarWindow>()
  // The restore waiting for each window: the Alt key up that lets go of it is still being
  // handled by the window itself, which would toggle the menu bar if it were back by then.
  const restoring = new Map<MenuBarWindow, number>()
  let turn = 0
  return {
    set: (contents: Contents, on: boolean): void => {
      const window = on ? windowOf(contents) : where.get(contents.id)
      if (!window) return
      const held = holding.get(window) ?? new Set<number>()
      if (on) {
        held.add(contents.id)
        where.set(contents.id, window)
        holding.set(window, held)
        restoring.delete(window)
        window.setAutoHideMenuBar(false)
        window.setMenuBarVisibility(false)
        return
      }
      held.delete(contents.id)
      where.delete(contents.id)
      if (held.size > 0) return
      holding.delete(window)
      const mine = ++turn
      restoring.set(window, mine)
      later(() => {
        if (restoring.get(window) !== mine) return
        restoring.delete(window)
        window.setAutoHideMenuBar(true)
      }, menuRestoreMs)
    },
  }
}

/** How long a window waits to give its menu bar back once Alt and the pointer have left. */
export const menuRestoreMs = 200

/** The pages of the companion pane and the agents' looks; see `watch` and `registerIpc`. */
export const livePages = () => {
  // Not on macOS, whose menu bar is the system's, and no window's.
  const menuGuard = createMenuGuard<WebContents>((contents) => {
    if (process.platform === "darwin") return undefined
    const embedder = contents.hostWebContents
    return (embedder && BrowserWindow.fromWebContents(embedder)) || undefined
  })
  // What a look's failed requests keep by view, set once the pages' session is watched.
  let forgetPageRequests: ((contentsId: number) => void) | undefined

  // Looks at pages for agents, out of sight, in the pages' session; see `createLooker`.
  // Only pages on this machine, as the runner checks too.
  const looker = createLooker({
    partition: pagesSession(pagesPartition),
    create: (options) => new BrowserWindow(options),
    allow: onThisMachine,
    emulate: emulatePhone,
    forget: (contentsId) => forgetPageRequests?.(contentsId),
  })

  return {
    looker,

    /**
     * Sets up the pages' session as the app is ready: locked to the pages' partition, phone
     * views from their first document, passkey choices, failed requests told to the app's
     * page, and sign-in windows counted. `appPage` is handed every other window's page.
     */
    watch: (log: Log, appPage: (contents: WebContents) => void): void => {
      lockPagesSession((partition) => session.fromPartition(partition), pagesPartition)
      const pages = session.fromPartition(pagesSession(pagesPartition))
      // A page view named a phone's loads as one from its first document.
      holdPhoneLoads(pages, (id) => webContents.fromId(id))
      // A page signing in with a passkey it doesn't name, when more than one fits.
      pickPasskeys(pages, async ({ relyingPartyId, accounts, frame }) => {
        // A page view's window is the app's window it shows in; a sign-in window's is its own.
        const contents = frame ? webContents.fromFrame(frame) : undefined
        const owner = contents?.hostWebContents ?? contents
        const window = owner ? BrowserWindow.fromWebContents(owner) : null
        // A look's window is out of sight: no one is there to pick, so the sign-in is cancelled.
        if (window && looker.is(window)) return undefined
        const labels = passkeyLabels(accounts)
        const options = {
          type: "question" as const,
          message: `Which passkey do you sign in to ${relyingPartyId} with?`,
          buttons: [...labels, "Cancel"],
          cancelId: labels.length,
          noLink: true,
        }
        const { response } = await (window
          ? dialog.showMessageBox(window, options)
          : dialog.showMessageBox(options))
        return accounts[response]?.credentialId
      })
      // The app's page hears of the requests a page in its view sees fail, to tell the agent.
      const pageRequests = watchPageRequests(pages, (contentsId, failure) => {
        // A look's own window, out of sight, hears its failures itself.
        if (looker.failed(contentsId, failure)) return
        const embedder = webContents.fromId(contentsId)?.hostWebContents
        if (!embedder || embedder.isDestroyed()) return
        // A window closing or reloading meanwhile must not throw into the main process.
        try {
          embedder.send(pageRequestChannel, contentsId, failure)
        } catch (error) {
          log.warn(
            "pages.request-send-failed",
            "A failed page request was not sent to its window.",
            { err: error },
          )
        }
      })
      forgetPageRequests = pageRequests.forget
      app.on("web-contents-created", (_event, contents) => {
        ownZoom(contents, pages)
        if (contents.getType() === "webview") {
          guardPage(contents, (url) => shell.openExternal(url), pagesPartition)
          // Its loupe's pointer, wheel and keys, which only this process sees.
          watchLoupe(
            contents,
            (notice) => {
              const embedder = contents.hostWebContents
              if (!embedder || embedder.isDestroyed()) return
              try {
                embedder.send(pageLoupeChannel, notice.contentsId, notice)
              } catch (error) {
                log.warn("pages.loupe-send-failed", "A loupe notice was not sent.", { err: error })
              }
            },
            (on) => menuGuard.set(contents, on),
          )
          contents.once("destroyed", () => menuGuard.set(contents, false))
          const { id } = contents
          // Its sign-in windows' failed requests are counted too, under their own ids, as are
          // those of the windows they open in turn, as an account chooser.
          forgetWhenGone(contents, pageRequests.forget)
          // Its viewer keeps the page live while a sign-in window of it is open, as the window
          // closes with the page.
          countSignIns(contents, (count) => {
            // A view that went with its windows open is gone before they close: nothing to tell.
            if (contents.isDestroyed()) return
            try {
              const embedder = contents.hostWebContents
              if (!embedder || embedder.isDestroyed()) return
              embedder.send(pageSignInChannel, id, count)
            } catch (error) {
              log.warn("pages.sign-in-send-failed", "A sign-in window count was not sent.", {
                err: error,
              })
            }
          })
        }
        // A page's sign-in window (see `guardPage`) is a page's, not the app's.
        if (contents.getType() === "window" && contents.session !== pages) appPage(contents)
      })
    },

    /**
     * Answers what the app's own page asks of its page views: a picture of one, to show
     * while it rests; an agent's look at a page no pane shows live; a view made a phone's.
     * `fromApp` tells a request of the app's own page from any other.
     */
    registerIpc: (fromApp: (event: IpcMainInvokeEvent) => boolean): void => {
      ipcMain.handle(pagePictureChannel, (event, id: unknown, width: unknown, forLook: unknown) =>
        fromApp(event)
          ? pictureForApp(
              event.sender,
              id,
              (page) => webContents.fromId(page),
              width,
              forLook,
              onThisMachine,
            )
          : undefined,
      )
      // Loaded afresh, out of sight, and pictured.
      ipcMain.handle(pageLookChannel, (event, request: unknown) => {
        if (!fromApp(event)) return { reason: "Not from the app's own page." }
        const { url, layout, before } = (request ?? {}) as {
          url?: unknown
          layout?: unknown
          before?: unknown
        }
        // The looker checks the address too; this is the door, so it asks first.
        if (typeof url !== "string" || !onThisMachine(url))
          return { reason: "Novadeck only looks at pages on this machine." }
        return looker.look({ url, layout, before })
      })
      ipcMain.handle(pagePhoneChannel, (event, id: unknown, phone: unknown) =>
        fromApp(event)
          ? phonePage(event.sender, id, phone, (page) => webContents.fromId(page))
          : false,
      )
      ipcMain.handle(pageLoupeLookChannel, (event, id: unknown, rect: unknown) =>
        fromApp(event)
          ? loupePage(event.sender, id, rect, (page) => webContents.fromId(page))
          : undefined,
      )
      ipcMain.handle(pageLoupeHoldChannel, (event, id: unknown, on: unknown, away: unknown) =>
        fromApp(event)
          ? holdLoupe(event.sender, id, on, away, (page) => webContents.fromId(page))
          : false,
      )
      ipcMain.handle(pageZoomChannel, (event, id: unknown, factor: unknown) =>
        fromApp(event)
          ? zoomPage(event.sender, id, factor, (page) => webContents.fromId(page))
          : false,
      )
    },
  }
}
