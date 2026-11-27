import type { BackendConnection, ConnectFailure, ThemeSource } from "@novadeck/core/port"
import type { Project } from "@novadeck/protocol"
import { desktopApp } from "@novadeck/protocol/bridge"
import {
  connectRunner,
  desktop,
  hasCode,
  type Runner,
  type RunnerErrorCode,
} from "@novadeck/runner-client"
import { incompatibility, refusalOf, WireError } from "@novadeck/wire"
import { websocket, type Transport, type WireStatus } from "@novadeck/wire/client"

import { pause, runnerBackend, type RunnerBackend } from "./backend"
import { desktopOptions } from "./desktop/app"
import { reportPoolTo, sizePoolTo } from "./desktop/renderer-pool"
import { listProject } from "./sessions/listing"
import type { RunnerListing } from "./sessions/seed"
import { forgetClosedWindows } from "./sessions/views"

/** The desktop app's runner: the one the app starts, over a port it hands the page. */
export const desktopTransport = (): Transport => desktop()

/** A runner reached over a WebSocket, as `pnpm dev:web` starts one: its URL and token. */
export const webTransport = (): Transport => {
  const url = import.meta.env.VITE_NOVADECK_RUNNER_URL
  const token = import.meta.env.VITE_NOVADECK_RUNNER_TOKEN
  if (!url || !token)
    throw new WireError<RunnerErrorCode>(
      "CLOSED",
      "Set VITE_NOVADECK_RUNNER_URL and VITE_NOVADECK_RUNNER_TOKEN.",
    )
  return websocket(url, { token })
}

// Lists what the runner holds. A first run gets a "Home" project in the runner's home
// directory, and every project without a session gets one, so the workspace can open.
// A project removed meanwhile, as from another window, is left out.
export const loadListing = async (
  runner: Pick<Runner, "projects" | "sessions" | "terminals" | "companions">,
  newId: () => string,
  now: () => number,
): Promise<RunnerListing> => {
  const load = (project: Project) => listProject(runner, project, newId, now)
  const listed = await Promise.all((await runner.projects.list()).map(load))
  const loaded = listed.filter((item) => item !== undefined)
  if (loaded.length) return loaded
  const home = await load(await runner.projects.create({ id: newId(), name: "Home" }))
  if (!home)
    throw new WireError<RunnerErrorCode>("NOT_FOUND", "The runner removed the new Home project.")
  return [home]
}

const newId = (): string => crypto.randomUUID()

// How long closing waits for the last saves before disconnecting anyway.
const closeGraceMs = 2_000
// What went wrong, sorted by what the person can do about it, in words for them and
// with the code and the runner's own message for anyone reporting it.
const transient: readonly RunnerErrorCode[] = [
  "DISCONNECTED",
  "CLOSED",
  "CLOSING",
  "RESOURCE_LIMIT",
]
/**
 * Tells `listener`, once, that the runner's link ended for good for a reason the person must
 * act on (an unauthorized one: the reconnection's handshake says why, as that this device was
 * signed out); not a link closed here, nor one the desktop app starts a new runner for.
 * Returns what stops listening.
 */
export const watchEnd = (
  runner: Pick<Runner, "watch" | "status">,
  listener: (failure: ConnectFailure) => void,
): (() => void) => {
  const statuses = runner.watch()
  let stopped = false
  const tell = (status: WireStatus): boolean => {
    if (status.state !== "closed") return false
    const failure = status.error && connectFailure(status.error)
    if (!stopped && failure?.kind === "unauthorized") listener(failure)
    return true
  }
  void (async () => {
    for await (const status of statuses) if (stopped || tell(status)) return
    tell(runner.status)
  })().catch(() => {})
  return () => {
    stopped = true
    void statuses.return?.()
  }
}

export const connectFailure = (
  error: unknown,
  // Whether this page is the desktop app's, which updates itself, or a browser's, which
  // loads the runner's newer page when it reloads.
  inApp: boolean = desktopApp() !== undefined,
): ConnectFailure => {
  if (!(error instanceof WireError))
    return {
      kind: "unknown",
      message: "Something went wrong starting Novadeck.",
      code: "UNKNOWN",
      detail: error instanceof Error ? error.message : String(error),
    }
  const { code } = error
  const detail = error.message
  if (hasCode(error, ...transient))
    return { kind: "transient", message: "The runner didn't start.", code, detail }
  if (hasCode(error, "INCOMPATIBLE_PROTOCOL")) {
    // The wire says which side is behind; a refusal it couldn't place came from a runner
    // older than every window.
    if (incompatibility(error)?.behind !== "client")
      return {
        kind: "incompatible",
        update: "runner",
        message: "The runner is older than this app. Update Novadeck where the runner runs.",
        code,
        detail,
      }
    return inApp
      ? {
          kind: "incompatible",
          update: "app",
          message: "This app is older than its runner. Update Novadeck to connect.",
          code,
          detail,
        }
      : {
          kind: "incompatible",
          update: "app",
          reload: true,
          message: "This page is older than its runner. Reload it to load the newer Novadeck.",
          code,
          detail,
        }
  }
  if (hasCode(error, "WORKSPACE_TOO_NEW"))
    return {
      kind: "outdated",
      message:
        "A newer version of Novadeck has used this workspace, so this copy is out of date. Open the newer one.",
      code,
      detail,
    }
  if (hasCode(error, "UNAUTHORIZED"))
    return refusalOf(error) === "revoked"
      ? {
          kind: "unauthorized",
          revoked: true,
          message:
            "This device was signed out of the runner. The runner's owner can let it in again with a new credential.",
          code,
          detail,
        }
      : { kind: "unauthorized", message: "The runner didn't accept this app.", code, detail }
  return { kind: "unknown", message: "Something went wrong starting Novadeck.", code, detail }
}

const unavailable = (error: unknown): Error => {
  const failure = connectFailure(error)
  return Object.assign(new Error(failure.message, { cause: error }), { failure })
}

// Connects to the desktop app's own runner, or in a browser to the one the build
// names, and loads the workspace before the app renders. The counter run passes the
// transport to its scripted runner. The entry hands over the page's theme, which the
// terminals draw in.
export const connectRunnerBackend = async (
  signal: AbortSignal,
  progress: (stage: "loading") => void,
  { transport, theme }: { readonly transport: () => Transport; readonly theme: ThemeSource },
): Promise<BackendConnection> => {
  const app = desktopApp()
  // Before anything makes the page's pool (the backend's views do, below).
  sizePoolTo(app)
  let runner: Runner
  try {
    runner = await connectRunner(transport(), { signal })
  } catch (error) {
    throw unavailable(error)
  }
  progress("loading")
  try {
    const listing = await loadListing(runner, newId, Date.now)
    const [
      {
        transcripts,
        transcriptsAvailable,
        welcomed,
        inboxOrder,
        inboxSnoozed,
        inboxHistory,
        hibernateAfterMinutes,
        agentModes,
        agentMode,
        shippingGate,
        worktrees,
        bundledPi,
        bundledPiFetch,
        murmur,
        keepMain,
      },
      agents,
      forges,
    ] = await Promise.all([
      runner.settings.get(),
      runner.agents.list(),
      // A runner from before forges has none, and the person is offered none. Cached: the
      // start waits on no forge's tool; Preferences looks again as it opens.
      runner.forges.list({ cached: true }).catch(() => undefined),
    ])
    const appOptions = desktopOptions(app)
    reportPoolTo(app)
    // What windows gone for good kept in this device's storage goes, once the app says which
    // windows it still has.
    void app
      ?.windowKeys?.()
      .then((live) => live && forgetClosedWindows(live))
      .catch(() => {})
    // StrictMode creates a backend twice and keeps the first, so the last one created is
    // not necessarily the one running: close waits on them all (an unstarted one is idle).
    const created: RunnerBackend[] = []
    return {
      createBackend: () => {
        const next = runnerBackend(runner, listing, {
          newId,
          theme,
          ...appOptions,
          transcripts,
          transcriptsAvailable,
          agents,
          ...(forges !== undefined && { forges }),
          welcomed,
          inboxOrder,
          inboxSnoozed,
          inboxHistory,
          hibernateAfterMinutes,
          agentModes,
          agentMode,
          shippingGate,
          worktrees,
          // Only from a runner that reports the switch (revision 16 on).
          ...(bundledPi !== undefined && { bundledPi }),
          ...(bundledPiFetch !== undefined && { bundledPiFetch }),
          // Only from a runner that reports the switch (revision 20 on).
          ...(murmur !== undefined && { murmur }),
          // Only from a runner that reports the switch (revision 24 on).
          ...(keepMain !== undefined && { keepMain }),
        })
        created.push(next)
        return next.backend
      },
      // A link refused for good once connected, as when this device's credential is revoked.
      ended: (listener) => watchEnd(runner, listener),
      // The app closes the connection before its workspace stops, and stopping sends
      // the last saves: let that happen, and let them land, before disconnecting.
      close: () => {
        setTimeout(() => {
          const idle = Promise.all(created.map((backend) => backend.idle()))
          void Promise.race([idle, pause(closeGraceMs)]).finally(() => runner.close())
        }, 0)
      },
    }
  } catch (error) {
    void runner.close()
    throw unavailable(error)
  }
}
