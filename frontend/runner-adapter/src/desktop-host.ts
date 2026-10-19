import type { Backend, Notice } from "@novadeck/core/port"
import { maxFixLength, type SandboxState } from "@novadeck/core/sandbox"
import {
  maxUninstallPath,
  maxUninstallReason,
  maxUninstallText,
  type UninstallPlan,
  type UninstallResult,
} from "@novadeck/core/uninstall"
import {
  noticeBodyLength,
  noticeIdPattern,
  noticeTitleLength,
  updateChannels,
  updateVersionPattern,
  type DesktopHost,
  parsePortableState,
  parseUpdateOffer,
} from "@novadeck/protocol/bridge"

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

// The host's self-updates, where it has them: what crosses the bridge is checked, so the
// page shows only what looks like a release's, and the channel only as one it knows.
export const desktopUpdates = (host: DesktopHost | undefined): Backend["updates"] => {
  const listen = host?.onUpdate
  const openPage = host?.openUpdatePage
  if (!listen || !openPage) return undefined
  const get = host.updateChannel
  const set = host.setUpdateChannel
  return {
    onOffer: (listener) =>
      listen((offer) => {
        const checked = parseUpdateOffer(offer)
        if (checked) listener(checked)
      }),
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

// The host's portable copy, where it has one: asked whether this is one, told how an
// install stands, and asked to install the app from it. What crosses the bridge is checked;
// a state that is none of the host's is not heard.
export const desktopPortable = (host: DesktopHost | undefined): Backend["portable"] => {
  const ask = host?.portable
  const install = host?.installApp
  const listen = host?.onPortableState
  if (!ask || !install || !listen) return undefined
  return {
    state: async () => {
      const state = parsePortableState(await ask())
      if (!state) throw new Error("Unknown portable state")
      return state
    },
    onState: (listener) =>
      listen((state) => {
        const checked = parsePortableState(state)
        if (checked) listener(checked)
      }),
    install: () => install(),
  }
}

// A command or path the person reads or runs: one plain line, within what fits.
const plainLine = (value: unknown, max = maxUninstallText): value is string =>
  typeof value === "string" &&
  value !== "" &&
  value.length <= max &&
  value.replace(controls, "") === value &&
  value.trim() === value

// The host's account of what uninstalling would do, as the page takes it. An answer that
// is none of the three, or whose command or paths are not plain lines, throws, and the
// page offers nothing.
export const hostUninstallPlan = (plan: unknown): UninstallPlan => {
  if (typeof plan !== "object" || plan === null) throw new Error("Unknown uninstall plan")
  const { kind, command, dataFolders, handoff } = plan as Record<string, unknown>
  if (kind === "unavailable") return { kind }
  if (kind === "manual" && plainLine(command)) return { kind, command }
  if (
    kind === "ready" &&
    Array.isArray(dataFolders) &&
    dataFolders.every((folder) => plainLine(folder, maxUninstallPath)) &&
    (handoff === "app" || handoff === "uninstaller")
  ) {
    return { kind, dataFolders: dataFolders as string[], handoff }
  }
  throw new Error("Unknown uninstall plan")
}

// How an uninstall went, as the page takes it. An answer that is none of the three is a
// failure, with a reason the person can read; a leftover command that is not one plain
// line is dropped.
export const hostUninstallResult = (result: unknown): UninstallResult => {
  const unknown: UninstallResult = {
    kind: "failed",
    reason: "Something went wrong.",
  }
  if (typeof result !== "object" || result === null) return unknown
  const { kind, leftover, reason } = result as Record<string, unknown>
  if (kind === "uninstalling") return { kind }
  if (kind === "removed") return plainLine(leftover) ? { kind, leftover } : { kind }
  if (kind !== "failed") return unknown
  // One more than fits, so a reason too long for the page is noticed, not cut.
  const text = typeof reason === "string" ? noticeText(reason, maxUninstallReason + 1) : ""
  return text && text.length <= maxUninstallReason ? { kind, reason: text } : unknown
}

// The host's uninstall, where it has one: asked what it would do, told to do it, and told
// to quit once it has.
export const desktopUninstall = (host: DesktopHost | undefined): Backend["uninstall"] => {
  const ask = host?.uninstallPlan
  const run = host?.uninstallApp
  const quit = host?.quitApp
  if (!ask || !run || !quit) return undefined
  return {
    plan: async () => hostUninstallPlan(await ask()),
    run: async (options) => {
      try {
        return hostUninstallResult(await run(options))
      } catch {
        return hostUninstallResult(undefined)
      }
    },
    quit: () => quit(),
  }
}
