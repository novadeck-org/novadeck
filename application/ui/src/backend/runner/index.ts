import {
  connectRunner,
  desktop,
  RunnerError,
  websocket,
  type Runner,
  type Transport,
} from "@novadeck/protocol/client"

import { sessionName } from "../../model/session-name"
import type { BootRehearsals } from "../boot-rehearsal"
import type { BackendConnection, ConnectFailure } from "../port"
import { runnerBackend, type RunnerBackend } from "./backend"
import { createRunnerDebug } from "./debug"
import { desktopHost } from "./desktop-host"
import { pause } from "./pause"
import type { RunnerListing } from "./seed"

const transport = (): Transport => {
  if (desktopHost()) return desktop()
  const url = import.meta.env.VITE_NOVADECK_RUNNER_URL
  const token = import.meta.env.VITE_NOVADECK_RUNNER_TOKEN
  if (!url || !token)
    throw new RunnerError("CLOSED", "Set VITE_NOVADECK_RUNNER_URL and VITE_NOVADECK_RUNNER_TOKEN.")
  return websocket(url, { token })
}

// Lists what the runner holds. A first run gets a "Home" project in the runner's home
// directory, and every project without a session gets one, so the workspace can open.
export const loadListing = async (
  runner: Pick<Runner, "projects" | "sessions" | "terminals">,
  newId: () => string,
  now: () => number,
): Promise<RunnerListing> => {
  const listed = await runner.projects.list()
  const projects = listed.length
    ? listed
    : [await runner.projects.create({ id: newId(), name: "Home" })]
  return Promise.all(
    projects.map(async (project) => {
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
          sessions.map(async (session) => ({
            session,
            terminals: await runner.terminals.list({ sessionId: session.id }),
          })),
        ),
      }
    }),
  )
}

const newId = (): string => crypto.randomUUID()

// How long closing waits for the last saves before disconnecting anyway.
const closeGraceMs = 2_000
// What went wrong, sorted by what the person can do about it, in words for them and
// with the code and the runner's own message for anyone reporting it.
const transient: ReadonlySet<RunnerError["code"]> = new Set([
  "DISCONNECTED",
  "CLOSED",
  "RUNTIME_CLOSING",
  "RESOURCE_LIMIT",
])
export const connectFailure = (error: unknown): ConnectFailure => {
  if (!(error instanceof RunnerError))
    return {
      kind: "unknown",
      message: "Something went wrong starting NovaDeck.",
      code: "UNKNOWN",
      detail: error instanceof Error ? error.message : String(error),
    }
  const { code } = error
  const detail = error.message
  if (transient.has(code))
    return { kind: "transient", message: "The runner didn't start.", code, detail }
  if (code === "INCOMPATIBLE_PROTOCOL")
    return {
      kind: "incompatible",
      message: "This runner is from a different NovaDeck version.",
      code,
      detail,
    }
  if (code === "UNAUTHORIZED")
    return { kind: "unauthorized", message: "The runner didn't accept this app.", code, detail }
  return { kind: "unknown", message: "Something went wrong starting NovaDeck.", code, detail }
}

const unavailable = (error: unknown): Error => {
  const failure = connectFailure(error)
  return Object.assign(new Error(failure.message, { cause: error }), { failure })
}

// Connects to the desktop app's own runner, or in a browser to the one the build
// names, and loads the workspace before the app renders. `rehearsals`, present where
// the debug panel is offered, can hold or fail this start and gives the panel its
// hooks.
export const connectRunnerBackend = async (
  signal: AbortSignal,
  progress: (stage: "loading") => void,
  rehearsals?: BootRehearsals,
): Promise<BackendConnection> => {
  await rehearsals?.beforeConnect(signal, (code) =>
    unavailable(new RunnerError(code as RunnerError["code"], "Simulated by the debug panel.")),
  )
  let runner: Runner
  try {
    runner = await connectRunner(transport(), { signal })
  } catch (error) {
    throw unavailable(error)
  }
  progress("loading")
  try {
    const listing = await loadListing(runner, newId, Date.now)
    const pick = desktopHost()?.pickDirectory
    const beforeQuit = desktopHost()?.beforeQuit
    const kill = desktopHost()?.debugKillRunner
    const debug = rehearsals
      ? createRunnerDebug({ rehearsals, killRunner: kill && (() => kill()) })
      : undefined
    // StrictMode creates a backend twice and keeps the first, so the last one created is
    // not necessarily the one running: close waits on them all (an unstarted one is idle).
    const created: RunnerBackend[] = []
    return {
      createBackend: () => {
        const next = runnerBackend(runner, listing, {
          newId,
          ...(pick ? { pickDirectory: () => pick() } : {}),
          ...(beforeQuit ? { beforeQuit: (save) => beforeQuit(save) } : {}),
          debug,
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
