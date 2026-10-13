import {
  isUpdatePercent,
  noticeBodyLength,
  noticeIdPattern,
  noticeTitleLength,
  portableRunPattern,
  updateChannels,
  updateNoteLength,
  updateNotesLength,
  updateVersionPattern,
  type DesktopHost,
  type UpdateOffer,
} from "@novadeck/protocol/bridge"

import { maxReasonLength, type InstallResult, type PortableState } from "../../model/portable"
import { maxFixLength, type SandboxState } from "../../model/sandbox"
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

// The longest outdated-since date the page takes, an ISO 8601 date-time.
const maxDateLength = 40
const dated = (text: string): boolean => Number.isFinite(Date.parse(text))

// An offer as the page takes it, or undefined for one that isn't a release's: a kind it
// knows, a version that looks like a release's, and the notes cut to what the page
// shows, without control characters.
export const hostOffer = (offer: unknown): UpdateOffer | undefined => {
  if (typeof offer !== "object" || offer === null) return undefined
  const { kind, version, notes, percent, outdatedSince } = offer as Record<string, unknown>
  if (kind !== "downloading" && kind !== "ready" && kind !== "available") return undefined
  if (kind === "downloading" && !isUpdatePercent(percent)) return undefined
  if (typeof version !== "string" || !updateVersionPattern.test(version)) return undefined
  const lines = Array.isArray(notes) ? (notes as unknown[]) : []
  return {
    kind,
    version,
    ...(kind === "downloading" ? { percent: percent as number } : {}),
    notes: lines
      .filter((line): line is string => typeof line === "string")
      .map((line) => noticeText(line, updateNoteLength))
      .filter(Boolean)
      .slice(0, updateNotesLength),
    ...(typeof outdatedSince === "string" &&
    outdatedSince.length <= maxDateLength &&
    dated(outdatedSince)
      ? { outdatedSince }
      : {}),
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

// The host's version, where it gives one: what crosses the bridge must look like a
// release's, so the page shows nothing else.
export const desktopVersion = (host: DesktopHost | undefined): Backend["version"] => {
  const ask = host?.version
  if (!ask) return undefined
  return async () => {
    const version = await ask()
    if (typeof version !== "string" || !updateVersionPattern.test(version)) {
      throw new Error("Unknown version")
    }
    return version
  }
}

// The host's account of its sandbox, where it gives one: what crosses the bridge is
// checked, and a fix that is not a single plain line, which the person would paste into a
// terminal, is dropped, leaving the notice without a command.
export const hostSandbox = (state: unknown): SandboxState => {
  if (typeof state !== "object" || state === null) throw new Error("Unknown sandbox state")
  const { sandboxed, fix } = state as Record<string, unknown>
  if (sandboxed === true) return { sandboxed: true }
  if (sandboxed !== false) throw new Error("Unknown sandbox state")
  const command = typeof fix === "string" ? fix.trim() : ""
  const plain = command.length <= maxFixLength && command.replace(controls, "") === command
  return { sandboxed: false, fix: plain ? command : "" }
}

export const desktopSandbox = (host: DesktopHost | undefined): Backend["sandbox"] => {
  const ask = host?.sandbox
  if (!ask) return undefined
  return async () => hostSandbox(await ask())
}

// The host's account of whether it is a portable copy, as the page takes it: a boolean,
// and for a portable one the build's version, as a release's and the name of the run.
export const hostPortable = (state: unknown): PortableState => {
  if (typeof state !== "object" || state === null) throw new Error("Unknown portable state")
  const { portable, version, run } = state as Record<string, unknown>
  if (portable === false) return { portable: false }
  if (
    portable !== true ||
    typeof version !== "string" ||
    !updateVersionPattern.test(version) ||
    typeof run !== "string" ||
    !portableRunPattern.test(run)
  ) {
    throw new Error("Unknown portable state")
  }
  return { portable: true, version, run }
}

// How an install went, as the page takes it. An answer that is none of the three is a
// failure, with a reason the person can read.
export const hostInstall = (result: unknown): InstallResult => {
  const unknown: InstallResult = { kind: "failed", reason: "Something went wrong." }
  if (typeof result !== "object" || result === null) return unknown
  const { kind, version, reason } = result as Record<string, unknown>
  if (kind === "installing") return { kind }
  if (kind === "newer" && typeof version === "string" && updateVersionPattern.test(version)) {
    return { kind, version }
  }
  if (kind !== "failed") return unknown
  const text = typeof reason === "string" ? noticeText(reason, maxReasonLength) : ""
  return text ? { kind, reason: text } : unknown
}

// The host's portable copy, where it has one: asked whether this is one, to install the
// app from it, and to open an installed copy that is newer.
export const desktopPortable = (host: DesktopHost | undefined): Backend["portable"] => {
  const ask = host?.portable
  const install = host?.installApp
  const open = host?.openInstalled
  if (!ask || !install || !open) return undefined
  return {
    state: async () => hostPortable(await ask()),
    install: async () => {
      try {
        return hostInstall(await install())
      } catch {
        return hostInstall(undefined)
      }
    },
    openInstalled: () => open(),
  }
}
