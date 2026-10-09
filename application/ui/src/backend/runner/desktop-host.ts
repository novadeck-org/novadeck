import {
  noticeBodyLength,
  noticeIdPattern,
  noticeTitleLength,
  updateVersionPattern,
  type DesktopHost,
} from "@novadeck/protocol/bridge"

import type { Backend, Notice } from "../port"

// What the desktop host's preload script offers the page; absent in a browser.
export const desktopHost = (): DesktopHost | undefined =>
  (globalThis as { novadeck?: DesktopHost }).novadeck

// Text a notice may show: one line, without control characters, cut to `length` with an
// ellipsis, never inside a character.
// eslint-disable-next-line no-control-regex -- These are the characters it replaces.
const controls = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g
export const noticeText = (text: string, length: number): string => {
  const line = text.replace(controls, " ").replace(/\s+/g, " ").trim()
  if (line.length <= length) return line
  let end = length - 1
  const last = line.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${line.slice(0, end).trimEnd()}…`
}

// A notice as the host takes it, or undefined for one it would drop: an id that is no
// terminal's, or nothing to say.
export const hostNotice = ({ id, title, body }: Notice): Notice | undefined => {
  const notice = {
    id,
    title: noticeText(title, noticeTitleLength),
    body: noticeText(body, noticeBodyLength),
  }
  return noticeIdPattern.test(id) && notice.title ? notice : undefined
}

// The host's desktop notifications, where it has them: what crosses the bridge is
// checked both ways, so a click names only a terminal id.
export const desktopNotices = (host: DesktopHost | undefined): Backend["notices"] => {
  const show = host?.showNotice
  const listen = host?.onNoticeClick
  if (!show || !listen) return undefined
  return {
    show: (notice) => {
      const shown = hostNotice(notice)
      if (shown) show(shown)
    },
    onClick: (listener) =>
      listen((id) => {
        if (typeof id === "string" && noticeIdPattern.test(id)) listener(id)
      }),
  }
}

// The host's self-updates, where it has them: a version crosses the bridge checked, so
// the page shows only what looks like a release's.
export const desktopUpdates = (host: DesktopHost | undefined): Backend["updates"] => {
  const listen = host?.onUpdateReady
  const install = host?.installUpdate
  if (!listen || !install) return undefined
  return {
    onReady: (listener) =>
      listen((version) => {
        if (typeof version === "string" && updateVersionPattern.test(version)) listener(version)
      }),
    install: () => install(),
  }
}
