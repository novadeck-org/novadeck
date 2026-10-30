import type { TerminalKey, ThemeSource } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import { terminalKeyId } from "@novadeck/core/terminals/registry"
import type { RendererPool } from "@novadeck/emulator/browser"
import { maxUploadBytes } from "@novadeck/protocol"
import { hasCode, type AttachedTerminal } from "@novadeck/runner-client"
import type { AttachStream, Exit } from "@novadeck/terminal"
import { openEmulator } from "@novadeck/terminal-views/emulator"
import { screenMarkup } from "@novadeck/terminal-views/mount"
import { pasteNotice as sharedNotice } from "@novadeck/terminal-views/paste-notice"
import { pageRendererPool } from "@novadeck/terminal-views/renderer-pool"
import { terminalTheme } from "@novadeck/terminal-views/theme"
import type { PasteFailure } from "@novadeck/terminal/view"
import { parkedCap, parkMs, type TerminalScreensOptions } from "@novadeck/terminal/view"

import type { SurfaceRuntime } from "../backend"
import { desktopApp } from "../desktop/app"
import { exitStatus, restartable } from "./activity"

// How long a screen stays once its session leaves the screen, so going back to a session or
// a project within a working break finds its output in place instead of a screen to reopen.
export const retainMs = 30 * 60 * 1000

// The runner's attachment, which the screens follow as the terminal library's stream. The
// runtime notes the attachment itself, so the stream is mapped back to it.
const attachments = new WeakMap<AttachStream, AttachedTerminal>()
const streamOf = (attached: AttachedTerminal): AttachStream => {
  const stream: AttachStream = {
    mode: attached.mode,
    [Symbol.asyncIterator]: () => attached[Symbol.asyncIterator](),
    write: (data) => attached.write(data),
    resize: (cols, rows) => attached.resize({ cols, rows }),
    close: () => void attached.detach(),
  }
  attachments.set(stream, attached)
  return stream
}

// Whether a shell that exited like this waits for Enter to start again, rather than closing
// its terminal or having been asked to end.
const waitsForEnter = (exit: Exit): boolean => {
  const status = exitStatus(exit)
  return status !== "clean" && restartable(status)
}

// What a failed paste tells the person, in the app's words: a file the runner found too large
// is too large too.
const words = sharedNotice(maxUploadBytes)
export const pasteNotice = (failure: PasteFailure): string =>
  words(
    failure.kind === "file" && hasCode(failure.error, "UPLOAD_TOO_LARGE")
      ? { ...failure, tooLarge: true }
      : failure,
  )

// The runner backend's terminal screens: its runtime, the emulator drawn with the page's
// WebGL pool and theme, a screen reader's tree for the terminal in focus, and the app's
// words and policies.
export const screensOptions = (
  runtime: SurfaceRuntime,
  {
    pool = pageRendererPool(),
    cap = parkedCap,
    theme,
  }: { pool?: RendererPool; cap?: number; theme: ThemeSource },
): TerminalScreensOptions<TerminalKey> => ({
  keyOf: terminalKeyId,
  emulator: openEmulator({ pool, screenReader: true }),
  theme: terminalTheme(theme),
  store: createStore,
  markup: screenMarkup,
  attach: async (key) => streamOf(await runtime.attach(key.terminalId)),
  lifecycle: (key) => runtime.entry(key),
  connection: runtime.connection,
  reconnected: () => runtime.connected(),
  classify: (error) =>
    hasCode(error, "RESOURCE_LIMIT")
      ? "busy"
      : hasCode(error, "DISCONNECTED")
        ? "offline"
        : "fatal",
  waitsAfter: waitsForEnter,
  restart: (key) => runtime.restart(key),
  track: (work) => runtime.track(work),
  park: { afterMs: parkMs, keep: cap },
  retain: { afterMs: retainMs, shown: (key) => runtime.shown(key) },
  paste: {
    upload: (key, file) => runtime.upload(key.terminalId, file),
    // The desktop app's runner is on this machine, so a copied file's own path names it.
    pathOf: desktopApp()?.pathForFile,
    maxBytes: maxUploadBytes,
    trustedClipboard: desktopApp() !== undefined,
    notice: pasteNotice,
  },
  on: {
    exited: (key, exit) => runtime.exited(key, exit),
    resized: (key, size) => runtime.resized(key, size),
    stage: (key, stage) => runtime.screen(key, stage),
    lost: (key, error) => runtime.lost(key, error),
    attached: (key, stream) => runtime.attached(key, attachments.get(stream)!),
  },
})
