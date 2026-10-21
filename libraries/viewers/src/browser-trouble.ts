import { webAddress } from "./address.js"

// What went wrong on a live page, as the browser viewer sees it: the part of its work that
// needs no view. The page is the host's to distrust, so what it says is checked here.

/**
 * An `error` the page logged or threw, with the script and line it came from (0 when
 * unknown); a `request` of the page's own origin, the page itself or what it loaded
 * (`what`: "page", "script", "fetch", "img"...), answered with an HTTP error `status`, or
 * 0 for none at all; or a `load` of the page that failed outright, with Chromium's error.
 */
export type Trouble =
  | {
      readonly kind: "error"
      readonly text: string
      readonly source: string
      readonly line: number
    }
  | {
      readonly kind: "request"
      readonly url: string
      readonly status: number
      readonly what: string
    }
  | { readonly kind: "load"; readonly text: string }

/** How many troubles one document reports; a page logging in a loop can't flood. */
export const maxTroubles = 20

/** The origin of an http(s) address, or null for anything else. */
export const originOf = (url: string): string | null => {
  if (!webAddress(url)) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * A request the pages' session saw fail: its address, the HTTP error `status` or 0 for no
 * answer at all, and what it was (`page`, `frame`, `fetch`, `script`, `image`...).
 */
export type PageRequestFailure = {
  readonly url: string
  readonly status: number
  readonly what: string
}

/** The IPC channel on which the desktop's main process tells the app of a failed request. */
export const pageRequestChannel = "novadeck:page-request"

/** The window message by which the app's preload hands one to the viewer of the page. */
export const pageRequestMessage = "novadeck:page-request"

/** A failed request as the viewer is told, with the page view it was for. */
export type PageRequestNotice = PageRequestFailure & { readonly contentsId: number }

/** `text` cut to `max` UTF-16 units, as a schema counts them, never in a surrogate pair. */
export const clip = (text: string, max: number): string => {
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null

/** `value` as a notice if it is one: a whole status, strings, which it clips as the runner does. */
export const parsePageRequest = (value: unknown): PageRequestNotice | null => {
  const notice = record(value)
  if (!notice) return null
  const { contentsId, url, status, what } = notice
  return typeof contentsId === "number" &&
    Number.isSafeInteger(contentsId) &&
    typeof url === "string" &&
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 0 &&
    status <= 999 &&
    typeof what === "string"
    ? { contentsId, url: clip(url, 2048), status, what: clip(what, 32) }
    : null
}
