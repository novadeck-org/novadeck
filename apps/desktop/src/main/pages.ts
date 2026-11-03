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
  holdPhoneLoads,
  lockPagesSession,
  pagesSession,
  passkeyLabels,
  phonePage,
  pictureForApp,
  pickPasskeys,
  watchPageRequests,
} from "@novadeck/viewers/browser/host"
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

import { pageLookChannel, pagePhoneChannel, pagePictureChannel } from "../bridge.js"

/** The pages of the companion pane and the agents' looks; see `watch` and `registerIpc`. */
export const livePages = () => {
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
        if (contents.getType() === "webview") {
          guardPage(contents, (url) => shell.openExternal(url), pagesPartition)
          const { id } = contents
          contents.once("destroyed", () => pageRequests.forget(id))
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
          // Its sign-in windows' failed requests are counted too, under their own ids.
          contents.on("did-create-window", (window) => {
            const popup = window.webContents.id
            window.webContents.once("destroyed", () => pageRequests.forget(popup))
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
    },
  }
}
