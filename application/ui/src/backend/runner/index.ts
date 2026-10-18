import type { Project } from "@novadeck/protocol"
import {
  connectRunner,
  desktop,
  hasCode,
  type Runner,
  type RunnerErrorCode,
} from "@novadeck/protocol/client"
import { pause } from "@novadeck/terminal/view"
import { WireError } from "@novadeck/wire"
import { websocket, type Transport } from "@novadeck/wire/client"

import type { BackendConnection, ConnectFailure, ThemeSource } from "#core/port"
import { sessionName } from "#core/session-name"

import { runnerBackend, type RunnerBackend } from "./backend"
import {
  desktopHost,
  desktopNotices,
  desktopPortable,
  desktopSandbox,
  desktopUninstall,
  desktopUpdates,
  desktopVersion,
} from "./desktop-host"
import type { RunnerListing } from "./seed"

/** The desktop app's runner: the one its host starts, over a port the host hands the page. */
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
  const load = async (project: Project): Promise<RunnerListing[number] | undefined> => {
    try {
      const found = await runner.sessions.list({ projectId: project.id })
      const sessions = found.length
        ? found
        : [
            await runner.sessions.create({
              id: newId(),
              projectId: project.id,
              name: sessionName(now()),
            }),
          ]
      return {
        project,
        sessions: await Promise.all(
          sessions.map(async (session) => {
            const [terminals, companions] = await Promise.all([
              runner.terminals.list({ sessionId: session.id }),
              runner.companions.list({ sessionId: session.id }),
            ])
            return { session, terminals, companions }
          }),
        ),
      }
    } catch (error) {
      if (hasCode(error, "NOT_FOUND")) return undefined
      throw error
    }
  }
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
export const connectFailure = (error: unknown): ConnectFailure => {
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
  if (hasCode(error, "INCOMPATIBLE_PROTOCOL"))
    return {
      kind: "incompatible",
      message: "This runner is from a different Novadeck version.",
      code,
      detail,
    }
  if (hasCode(error, "WORKSPACE_TOO_NEW"))
    return {
      kind: "outdated",
      message:
        "A newer version of Novadeck has used this workspace. Open the newer Novadeck instead; this copy is out of date.",
      code,
      detail,
    }
  if (hasCode(error, "UNAUTHORIZED"))
    return { kind: "unauthorized", message: "The runner didn't accept this app.", code, detail }
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
  let runner: Runner
  try {
    runner = await connectRunner(transport(), { signal })
  } catch (error) {
    throw unavailable(error)
  }
  progress("loading")
  try {
    const listing = await loadListing(runner, newId, Date.now)
    const [{ transcripts, welcomed }, agents] = await Promise.all([
      runner.settings.get(),
      runner.agents.list(),
    ])
    const pick = desktopHost()?.pickDirectory
    const beforeQuit = desktopHost()?.beforeQuit
    const showAppearance = desktopHost()?.showAppearance
    const notices = desktopNotices(desktopHost())
    const updates = desktopUpdates(desktopHost())
    const version = desktopVersion(desktopHost())
    const sandbox = desktopSandbox(desktopHost())
    const portable = desktopPortable(desktopHost())
    const uninstall = desktopUninstall(desktopHost())
    // StrictMode creates a backend twice and keeps the first, so the last one created is
    // not necessarily the one running: close waits on them all (an unstarted one is idle).
    const created: RunnerBackend[] = []
    return {
      createBackend: () => {
        const next = runnerBackend(runner, listing, {
          newId,
          theme,
          ...(pick ? { pickDirectory: () => pick() } : {}),
          ...(beforeQuit ? { beforeQuit: (save) => beforeQuit(save) } : {}),
          ...(showAppearance ? { showAppearance: (look) => showAppearance(look) } : {}),
          ...(notices ? { notices } : {}),
          ...(updates ? { updates } : {}),
          ...(version ? { version } : {}),
          ...(sandbox ? { sandbox } : {}),
          ...(portable ? { portable } : {}),
          ...(uninstall ? { uninstall } : {}),
          livePages: desktopHost()?.livePages === true,
          transcripts,
          agents,
          welcomed,
        })
        created.push(next)
        return next.backend
      },
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
