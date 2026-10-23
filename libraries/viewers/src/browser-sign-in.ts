// A live page's sign-in windows, as the desktop host tells its viewer of them: a page view
// closing closes them, so the viewer keeps its page live, not resting, while any is open.

/** The IPC channel on which the desktop's main process tells the app how many a view has open. */
export const pageSignInChannel = "novadeck:page-sign-in"

/** The window message by which the app's preload hands that to the viewer of the page. */
export const pageSignInMessage = "novadeck:page-sign-in"

/** How many sign-in windows the page view `contentsId` has open. */
export type PageSignInNotice = { readonly contentsId: number; readonly open: number }

/** `value` as a notice if it is one: a view's id and a count, both whole and not negative. */
export const parsePageSignIn = (value: unknown): PageSignInNotice | null => {
  if (typeof value !== "object" || value === null) return null
  const { contentsId, open } = value as Record<string, unknown>
  return typeof contentsId === "number" &&
    Number.isSafeInteger(contentsId) &&
    typeof open === "number" &&
    Number.isSafeInteger(open) &&
    open >= 0
    ? { contentsId, open }
    : null
}
