import {
  noticeBodyLength,
  noticeIdPattern,
  noticeTitleLength,
  updateChannels,
  updateNoteLength,
  updateNotesLength,
  updateVersionPattern,
  type DesktopHost,
  type UpdateOffer,
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

// An offer as the page takes it, or undefined for one that isn't a release's: a kind it
// knows, a version that looks like a release's, and the notes cut to what the page
// shows, without control characters.
export const hostOffer = (offer: unknown): UpdateOffer | undefined => {
  if (typeof offer !== "object" || offer === null) return undefined
  const { kind, version, notes } = offer as Record<string, unknown>
  if (kind !== "ready" && kind !== "available") return undefined
  if (typeof version !== "string" || !updateVersionPattern.test(version)) return undefined
  const lines = Array.isArray(notes) ? (notes as unknown[]) : []
  return {
    kind,
    version,
    notes: lines
      .filter((line): line is string => typeof line === "string")
      .map((line) => noticeText(line, updateNoteLength))
      .filter(Boolean)
      .slice(0, updateNotesLength),
  }
}

// The host's self-updates, where it has them: what crosses the bridge is checked, so the
// page shows only what looks like a release's, and the channel only as one it knows.
export const desktopUpdates = (host: DesktopHost | undefined): Backend["updates"] => {
  const listen = host?.onUpdate
  const install = host?.installUpdate
  const openPage = host?.openUpdatePage
  if (!listen || !install || !openPage) return undefined
  const get = host.updateChannel
  const set = host.setUpdateChannel
  return {
    onOffer: (listener) =>
      listen((offer) => {
        const checked = hostOffer(offer)
        if (checked) listener(checked)
      }),
    install: () => install(),
    openPage: () => openPage(),
    ...(get && set
      ? {
          channel: {
            get: async () => {
              const channel = await get()
              if (!updateChannels.includes(channel)) throw new Error("Unknown update channel")
              return channel
            },
            set: (channel) => set(channel),
          },
        }
      : {}),
  }
}
