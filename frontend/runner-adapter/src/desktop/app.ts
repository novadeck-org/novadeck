import { maxFixLength, type SandboxState } from "@novadeck/core/desktop/sandbox"
import {
  maxUninstallPath,
  maxUninstallReason,
  maxUninstallText,
  type UninstallPlan,
  type UninstallResult,
} from "@novadeck/core/desktop/uninstall"
import type { Backend, Notice } from "@novadeck/core/port"
import { noticeSoundOf } from "@novadeck/core/sounds"
import {
  desktopBadgeOf,
  noticeBodyLength,
  noticeIdPattern,
  noticeTitleLength,
  updateChannels,
  updateVersionPattern,
  type DesktopApp,
  parsePortableState,
  parseUpdateOffer,
  parseWhatsNew,
} from "@novadeck/protocol/bridge"

import type { RunnerBackendOptions } from "../backend"

// What the desktop app's preload script offers the page; absent in a browser.
export const desktopApp = (): DesktopApp | undefined =>
  (globalThis as { novadeck?: DesktopApp }).novadeck

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

// A notice as the app takes it, or undefined for one it would drop: an id that is no
// terminal's, or nothing to say. A sound the app does not have is left off.
export const desktopNoticeOf = ({ id, title, body, silent, sound }: Notice): Notice | undefined => {
  const named = noticeSoundOf(sound)
  const notice = {
    id,
    title: noticeText(title, noticeTitleLength),
    body: noticeText(body, noticeBodyLength),
    ...(typeof silent === "boolean" ? { silent } : {}),
    ...(named ? { sound: named } : {}),
  }
  return noticeIdPattern.test(id) && notice.title ? notice : undefined
}

// The app's desktop notifications, where it has them: what crosses the bridge is
// checked both ways, so a click names only a terminal id.
export const desktopNotices = (app: DesktopApp | undefined): Backend["notices"] => {
  const show = app?.showNotice
  const listen = app?.onNoticeClick
  if (!show || !listen) return undefined
  const close = app?.closeNotice
  const quiet = app?.notificationsQuiet
  return {
    show: (notice) => {
      const shown = desktopNoticeOf(notice)
      if (shown) show(shown)
    },
    ...(close
      ? {
          close: (terminalId: string) => {
            if (typeof terminalId === "string" && noticeIdPattern.test(terminalId)) {
              close(terminalId)
            }
          },
        }
      : {}),
    ...(app?.notificationsSound === true ? { sounds: true } : {}),
    ...(quiet
      ? {
          quiet: async () => {
            try {
              return (await quiet()) === true
            } catch {
              return false
            }
          },
        }
      : {}),
    onClick: (listener) =>
      listen((id) => {
        if (typeof id === "string" && noticeIdPattern.test(id)) listener(id)
      }),
  }
}

// The app's icon badge, where it has one: only a badge the contract allows crosses.
export const desktopBadge = (app: DesktopApp | undefined): Backend["badge"] => {
  const set = app?.setBadge
  if (!set) return undefined
  return (badge) => {
    const checked = desktopBadgeOf(badge)
    if (checked) set(checked)
  }
}

// The app's report of its window's focus, where it has one: only a boolean crosses.
export const desktopWindowFocus = (app: DesktopApp | undefined): Backend["windowFocus"] => {
  const listen = app?.onWindowFocus
  if (!listen) return undefined
  return (listener) =>
    listen((focused) => {
      if (typeof focused === "boolean") listener(focused)
    })
}

// The app's self-updates, where it has them: what crosses the bridge is checked, so the
// page shows only what looks like a release's, and the channel only as one it knows.
export const desktopUpdates = (app: DesktopApp | undefined): Backend["updates"] => {
  const listen = app?.onUpdate
  const openPage = app?.openUpdatePage
  if (!listen || !openPage) return undefined
  const get = app.updateChannel
  const set = app.setUpdateChannel
  const allow = app.allowUpdates
  return {
    onOffer: (listener) =>
      listen((offer) => {
        const checked = parseUpdateOffer(offer)
        if (checked) listener(checked)
      }),
    openPage: () => openPage(),
    ...(allow ? { allow: () => allow() } : {}),
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

// What is new in the version the app updated to, where the app tells: what crosses the
// bridge is checked, so the page shows only highlights the contract allows, as plain text.
// The two calls come together; an app with some of them is taken as having none.
export const desktopWhatsNew = (app: DesktopApp | undefined): Backend["whatsNew"] => {
  const read = app?.whatsNew
  const dismiss = app?.dismissWhatsNew
  if (!read || !dismiss) return undefined
  return {
    get: async () => parseWhatsNew(await read()),
    dismiss: () => dismiss(),
  }
}

// The app's version, where it gives one: what crosses the bridge must look like a
// release's, so the page shows nothing else.
export const desktopVersion = (app: DesktopApp | undefined): Backend["version"] => {
  const read = app?.version
  if (!read) return undefined
  return async () => {
    const version = await read()
    if (typeof version !== "string" || !updateVersionPattern.test(version)) {
      throw new Error("Unknown version")
    }
    return version
  }
}

// The OS as the card shows it, by the name the website takes it under.
const osLabels = { macos: "macOS", windows: "Windows", linux: "Linux" } as const

// The app's feedback, where it sends notes: what it says goes along with a note is checked,
// and the card shows it as the demo does (`Linux x64`). A note crosses as its kind and text.
export const desktopFeedback = (app: DesktopApp | undefined): Backend["feedback"] => {
  const about = app?.feedbackAbout
  const send = app?.sendFeedback
  if (app?.feedback !== true || !about || !send) return undefined
  return {
    about: async () => {
      const found: unknown = await about()
      const { version, os, arch } = (typeof found === "object" && found !== null ? found : {}) as {
        version?: unknown
        os?: unknown
        arch?: unknown
      }
      if (
        typeof version !== "string" ||
        !updateVersionPattern.test(version) ||
        typeof os !== "string" ||
        !Object.hasOwn(osLabels, os) ||
        typeof arch !== "string" ||
        !/^[a-z0-9_]{2,16}$/.test(arch)
      )
        throw new Error("Unknown feedback details")
      return { version, os: `${osLabels[os as keyof typeof osLabels]} ${arch}` }
    },
    send: (note) => send({ kind: note.kind, text: note.text }),
  }
}

// The app's account of its sandbox, where it gives one: what crosses the bridge is
// checked, and a fix that is not a single plain line, which the person would paste into a
// terminal, is dropped, leaving the notice without a command.
export const sandboxStateOf = (state: unknown): SandboxState => {
  if (typeof state !== "object" || state === null) throw new Error("Unknown sandbox state")
  const { sandboxed, fix } = state as Record<string, unknown>
  if (sandboxed === true) return { sandboxed: true }
  if (sandboxed !== false) throw new Error("Unknown sandbox state")
  const command = typeof fix === "string" ? fix.trim() : ""
  const plain = command.length <= maxFixLength && command.replace(controls, "") === command
  return { sandboxed: false, fix: plain ? command : "" }
}

export const desktopSandbox = (app: DesktopApp | undefined): Backend["sandbox"] => {
  const read = app?.sandbox
  if (!read) return undefined
  return async () => sandboxStateOf(await read())
}

// The app's portable copy, where it has one: asked whether this is one, told how an
// install stands, and asked to install the app from it or to open the newest portable's
// download page. What crosses the bridge is checked; a state that is none of the app's is
// not heard.
export const desktopPortable = (app: DesktopApp | undefined): Backend["portable"] => {
  const read = app?.portable
  const install = app?.installApp
  const listen = app?.onPortableState
  if (!read || !install || !listen) return undefined
  // The newer calls come one by one: an app that came before them has none, and the card
  // then offers nothing for it.
  const openDownload = app?.openPortableDownload
  const showDataFolder = app?.showDataFolder
  const news = app?.updateNews
  return {
    state: async () => {
      const state = parsePortableState(await read())
      if (!state) throw new Error("Unknown portable state")
      return state
    },
    onState: (listener) =>
      listen((state) => {
        const checked = parsePortableState(state)
        if (checked) listener(checked)
      }),
    install: () => install(),
    ...(openDownload ? { openDownload: () => openDownload() } : {}),
    ...(showDataFolder ? { showDataFolder: () => showDataFolder() } : {}),
    ...(news ? { news: async () => parseWhatsNew(await news()) } : {}),
  }
}

// A command or path the person reads or runs: one plain line, within what fits.
const plainLine = (value: unknown, max = maxUninstallText): value is string =>
  typeof value === "string" &&
  value !== "" &&
  value.length <= max &&
  value.replace(controls, "") === value &&
  value.trim() === value

// The app's account of what uninstalling would do, as the page takes it. An answer that
// is none of the three, or whose command or paths are not plain lines, throws, and the
// page offers nothing.
export const uninstallPlanOf = (plan: unknown): UninstallPlan => {
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
export const uninstallResultOf = (result: unknown): UninstallResult => {
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

// The app's uninstall, where it has one: asked what it would do, told to do it, and told
// to quit once it has.
export const desktopUninstall = (app: DesktopApp | undefined): Backend["uninstall"] => {
  const read = app?.uninstallPlan
  const run = app?.uninstallApp
  const quit = app?.quitApp
  if (!read || !run || !quit) return undefined
  return {
    plan: async () => uninstallPlanOf(await read()),
    run: async (options) => {
      try {
        return uninstallResultOf(await run(options))
      } catch {
        return uninstallResultOf(undefined)
      }
    },
    quit: () => quit(),
  }
}

// What the desktop app's bridge gives the backend, each part checked as above where it
// crosses; a browser gives none of it.
export const desktopOptions = (
  app: DesktopApp | undefined,
): Omit<RunnerBackendOptions, "theme"> => {
  const pick = app?.pickDirectory
  const beforeQuit = app?.beforeQuit
  const showAppearance = app?.showAppearance
  const openLogs = app?.openLogs
  const pagePicture = app?.pagePicture
  const pageLook = app?.lookAtPage
  const pagePhone = app?.pagePhone
  const notices = desktopNotices(app)
  const badge = desktopBadge(app)
  const windowFocus = desktopWindowFocus(app)
  const updates = desktopUpdates(app)
  const whatsNew = desktopWhatsNew(app)
  const version = desktopVersion(app)
  const feedback = desktopFeedback(app)
  const sandbox = desktopSandbox(app)
  const portable = desktopPortable(app)
  const uninstall = desktopUninstall(app)
  return {
    ...(pick ? { pickDirectory: () => pick() } : {}),
    ...(beforeQuit ? { beforeQuit: (save) => beforeQuit(save) } : {}),
    ...(showAppearance ? { showAppearance: (look) => showAppearance(look) } : {}),
    ...(notices ? { notices } : {}),
    ...(badge ? { badge } : {}),
    ...(windowFocus ? { windowFocus } : {}),
    ...(updates ? { updates } : {}),
    ...(whatsNew ? { whatsNew } : {}),
    ...(version ? { version } : {}),
    ...(openLogs ? { openLogs: () => openLogs() } : {}),
    ...(feedback ? { feedback } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(portable ? { portable } : {}),
    ...(uninstall ? { uninstall } : {}),
    livePages: app?.livePages === true,
    ...(pagePicture ? { pagePicture: (page, width) => pagePicture(page, width) } : {}),
    ...(pageLook ? { pageLook: (request) => pageLook(request) } : {}),
    ...(pagePhone ? { pagePhone: (page, phone) => pagePhone(page, phone) } : {}),
  }
}
