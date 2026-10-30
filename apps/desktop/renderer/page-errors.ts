import type { DesktopApp, PageError } from "@novadeck/protocol/bridge"

/**
 * What the page tells the host of something thrown that nothing caught: an Error by its name,
 * message and stack; anything else by its type alone, as its value may be anything, such as
 * what a person typed.
 */
export const pageError = (kind: PageError["kind"], thrown: unknown, fallback = ""): PageError => {
  if (thrown instanceof Error)
    return {
      kind,
      name: thrown.name,
      message: thrown.message,
      ...(thrown.stack !== undefined && { stack: thrown.stack }),
    }
  if (thrown === undefined || thrown === null) return { kind, name: "Error", message: fallback }
  return { kind, name: typeof thrown, message: "A non-Error was thrown" }
}

/**
 * Tells the host, where it listens, of each error the page doesn't catch and each promise
 * that fails with nothing to catch it, for its log. What else the page does with them is as
 * it was.
 */
export const reportPageErrors = (page: Window, host: DesktopApp | undefined): void => {
  const report = host?.reportError
  if (!report) return
  page.addEventListener("error", (event) => report(pageError("error", event.error, event.message)))
  page.addEventListener("unhandledrejection", (event) =>
    report(pageError("rejection", event.reason)),
  )
}
