import type { DesktopFeedbackAbout, DesktopFeedbackNote } from "@novadeck/protocol/bridge"
import type { IpcMain } from "electron"

import { feedbackAboutChannel, feedbackSendChannel } from "../bridge.js"
import { localOrigin, novadeckSite } from "./releases/site.js"

/** How long a note may take to be answered before it counts as not sent. */
export const feedbackTimeoutMs = 15_000

const systems: Readonly<Record<string, DesktopFeedbackAbout["os"]>> = {
  darwin: "macos",
  win32: "windows",
  linux: "linux",
}

/**
 * The website that takes the person's feedback notes, or undefined where this build sends
 * none. A packaged build sends to novadeck.dev; `NOVADECK_FEEDBACK_ORIGIN` replaces it for
 * testing, and only with an address on this computer (as `NOVADECK_UPDATE_URL` does). A
 * build that is not packaged posts only there, never to the real website, and sends nothing
 * without it. Neither does a packaged build of version 0.0.0, which is what pull-request
 * builds are, so testers of those never send real notes. A system the website has no name
 * for sends nothing either.
 */
export const feedbackOrigin = (options: {
  readonly packaged: boolean
  readonly platform: string
  readonly version: string
  readonly env: string | undefined
}): string | undefined => {
  if (!(options.platform in systems)) return undefined
  const local = options.env === undefined ? undefined : localOrigin(options.env)
  return local ?? (options.packaged && options.version !== "0.0.0" ? novadeckSite : undefined)
}

/** What goes along with a note: the version, the OS and the architecture. */
export const feedbackAbout = (options: {
  readonly version: string
  readonly platform: string
  readonly arch: string
}): DesktopFeedbackAbout => ({
  version: options.version,
  os: systems[options.platform] ?? "linux",
  arch: options.arch,
})

const kinds = new Set(["bug", "idea", "other"])

/** A note when it is one the website takes: a kind or none, and text. Otherwise undefined. */
export const feedbackNoteOf = (value: unknown): DesktopFeedbackNote | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { kind, text } = value as Record<string, unknown>
  if (typeof text !== "string") return undefined
  if (kind === null) return { kind: null, text }
  return typeof kind === "string" && kinds.has(kind)
    ? { kind: kind as DesktopFeedbackNote["kind"], text }
    : undefined
}

/**
 * Posts a note to `<origin>/feedback` as JSON: the note, the version, the OS and the
 * architecture, with the content type as its only header and no cookies (`credentials:
 * "omit"`). Electron's own request adds its User-Agent, accept-language, accept-encoding and
 * sec-fetch-* headers; the website keeps none of them. Resolves on 204. Anything else
 * rejects: another status, the network failing, or no answer in `timeoutMs`.
 */
export const sendFeedback = async (
  note: DesktopFeedbackNote,
  options: {
    readonly origin: string
    readonly about: DesktopFeedbackAbout
    readonly fetch: (url: string, init: RequestInit) => Promise<{ readonly status: number }>
    readonly timeoutMs?: number
  },
): Promise<void> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? feedbackTimeoutMs)
  try {
    const response = await options.fetch(`${options.origin}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Never follows a redirect: the note goes where the contract says.
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
      body: JSON.stringify({
        kind: note.kind,
        text: note.text,
        version: options.about.version,
        os: options.about.os,
        arch: options.about.arch,
      }),
    })
    if (response.status !== 204) throw new Error(`Feedback was not taken (${response.status}).`)
  } finally {
    clearTimeout(timer)
  }
}

/** The page's questions about feedback, answered only for the app's own windows. */
export const registerFeedbackIpc = <Window>(
  ipc: Pick<IpcMain, "handle">,
  options: {
    readonly window: (event: Parameters<Parameters<IpcMain["handle"]>[1]>[0]) => Window | undefined
    readonly about: () => DesktopFeedbackAbout
    readonly send: (note: DesktopFeedbackNote) => Promise<void>
  },
): void => {
  ipc.handle(feedbackAboutChannel, (event) => {
    if (!options.window(event)) throw new Error("Not the app's page.")
    return options.about()
  })
  ipc.handle(feedbackSendChannel, async (event, value: unknown) => {
    if (!options.window(event)) throw new Error("Not the app's page.")
    const note = feedbackNoteOf(value)
    if (!note) throw new Error("Not a feedback note.")
    await options.send(note)
  })
}
