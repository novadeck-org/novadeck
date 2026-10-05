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

// Whether a frame may use a permission: the clipboard only, and only from the main frame
// of a window showing the app's own page.
const allowed = (
  contents: WebContents | null,
  permission: string,
  mainFrame: boolean,
  own: (url: string) => boolean,
): boolean =>
  clipboard.has(permission) &&
  mainFrame &&
  contents?.getType() === "window" &&
  own(contents.getURL())

/**
 * Refuses the app's session every permission but the clipboard for the app's own page,
 * which `own` recognises by its address. Live pages have a session of their own, which
 * refuses them everything (see ./pages.ts).
 */
export const limitPermissions = (target: Session, own: (url: string) => boolean): void => {
  target.setPermissionCheckHandler((contents, permission, _origin, details) =>
    allowed(contents, permission, details.isMainFrame, own),
  )
  target.setPermissionRequestHandler((contents, permission, respond, details) =>
    respond(allowed(contents, permission, details.isMainFrame, own)),
  )
}
