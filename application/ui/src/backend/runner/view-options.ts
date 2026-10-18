import { createView, type Renderers } from "@novadeck/emulator/browser"
import { maxUploadBytes } from "@novadeck/protocol"
import { hasCode, type AttachedTerminal } from "@novadeck/protocol/client"
import type { AttachStream, Exit } from "@novadeck/terminal"

import { createStore } from "#core/store"

import type { TerminalKey } from "../port"
import { exitStatus, restartable } from "./activity"
import type { SurfaceRuntime } from "./backend"
import { desktopHost } from "./desktop-host"
import { linkOptions } from "./links"
import type { PasteFailure } from "./paste"
import { pageRenderers } from "./renderers"
import { parkedCap, parkMs, type TerminalViewOptions } from "./screens"
import { terminalTheme } from "./theme"

// How long a screen stays once its session leaves the screen, so going back to a session or
// a project within a working break finds its output in place instead of a screen to reopen.
export const retainMs = 30 * 60 * 1000

// The runner's attachment, which the views follow as the terminal library's stream. The
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

// What a failed paste tells the person: that the clipboard could not be read, or which
// file could not be saved, and why when it was too large.
export const pasteNotice = (failure: PasteFailure): string => {
  if (failure.kind === "clipboard") return "Novadeck can't read the clipboard"
  const pasted = failure.type.startsWith("image/") ? "image" : "file"
  return failure.tooLarge || hasCode(failure.error, "UPLOAD_TOO_LARGE")
    ? `Couldn't paste the ${pasted}: it's over ${maxUploadBytes / 1024 / 1024} MB`
    : `Couldn't paste the ${pasted}`
}

// The runner backend's terminal views: its runtime, the emulator drawn with the page's
// WebGL pool and theme, and the app's words and policies.
export const viewOptions = (
  runtime: SurfaceRuntime,
  { renderers = pageRenderers(), cap = parkedCap }: { renderers?: Renderers; cap?: number } = {},
): TerminalViewOptions<TerminalKey> => ({
  keyOf: ({ projectId, workspaceSessionId, terminalId }) =>
    `${projectId}\u0000${workspaceSessionId}\u0000${terminalId}`,
  emulator: (element, open) =>
    createView(element, {
      ...open,
      // Programs and agents pick their own colours, often greys meant for another ground;
      // xterm darkens or lightens any that would read under 4.5:1 against the background.
      minimumContrastRatio: 4.5,
      scrollback: 1000,
      links: linkOptions(),
      renderers,
    }),
  theme: terminalTheme,
  store: createStore,
  markup: { input: { "data-terminal-input": "" }, hostClass: "runner-screen min-h-0 flex-1" },
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
    pathOf: desktopHost()?.pathForFile,
    maxBytes: maxUploadBytes,
    trustedClipboard: desktopHost() !== undefined,
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
