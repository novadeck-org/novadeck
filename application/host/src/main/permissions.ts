import type { Session, WebContents } from "electron"

/**
 * Whether `url` shows the app's own page at `own`: the dev server's origin, or the
 * packaged page's file. An address that can't be parsed, as an empty one, is not.
 */
export const ownPage = (url: string, own: string): boolean => {
  let page: URL
  try {
    page = new URL(url)
  } catch {
    return false
  }
  const expected = new URL(own)
  if (expected.protocol !== "file:") return page.origin === expected.origin
  return page.protocol === "file:" && page.pathname === expected.pathname
}

// What Novadeck's own page may use: the clipboard, so an image pasted into a terminal
// reaches it and the page's copy buttons work.
const clipboard = new Set(["clipboard-read", "clipboard-sanitized-write"])

// Whether a frame may use anything at all: only the main frame of a window showing the
// app's own page.
const ownFrame = (
  contents: WebContents | null,
  mainFrame: boolean,
  own: (url: string) => boolean,
): contents is WebContents =>
  mainFrame && contents?.getType() === "window" && own(contents.getURL())

// The microphone, for voice input, and never the camera: a request for audio alone.
const audioOnly = (types: readonly string[] | undefined): boolean =>
  types !== undefined && types.length > 0 && types.every((type) => type === "audio")

/**
 * Refuses the app's session every permission but the clipboard and the microphone for
 * the app's own page, which `own` recognises by its address. Live pages have a session of
 * their own, which refuses them everything (see ./pages.ts).
 *
 * `microphone` asks the system to allow the microphone before a request is granted, as
 * macOS requires; the system's answer decides, and it is asked only for the page's own
 * requests. Other platforms have no such step.
 */
export const limitPermissions = (
  target: Session,
  own: (url: string) => boolean,
  microphone: () => Promise<boolean> = async () => true,
): void => {
  target.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (!ownFrame(contents, details.isMainFrame, own)) return false
    if (permission === "media") return "mediaType" in details && details.mediaType === "audio"
    return clipboard.has(permission)
  })
  target.setPermissionRequestHandler((contents, permission, respond, details) => {
    if (!ownFrame(contents, details.isMainFrame, own)) return respond(false)
    if (permission !== "media") return respond(clipboard.has(permission))
    if (!("mediaTypes" in details) || !audioOnly(details.mediaTypes)) return respond(false)
    // A refusal by the system, or a failure to ask, is a refusal.
    void microphone().then(respond, () => respond(false))
  })
}
