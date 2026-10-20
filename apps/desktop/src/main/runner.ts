import { utilityProcess, type MessagePortMain, type UtilityProcess } from "electron"

import {
  databaseArgumentPrefix,
  murmurEngineArgumentPrefix,
  graphicsArgumentPrefix,
  logArgumentPrefix,
  murmurSourceArgumentPrefix,
  relayArgumentPrefix,
  voiceEngineArgumentPrefix,
  voiceSourceArgumentPrefix,
  type RunnerCommand,
  type RunnerReport,
} from "../bridge.js"
import { eachLine } from "./logs.js"

export type RunnerHost = {
  /**
   * Hands the runner a fresh port to serve, starting the runner again if it stopped; false
   * once it closes, as `brokerPorts` takes it.
   */
  deliver(port: MessagePortMain): boolean
  /**
   * Ends the runner's shells, then the process; forcibly after `timeoutMs`. Final:
   * later ports aren't delivered.
   */
  close(timeoutMs?: number): Promise<void>
  /** Saves every terminal's restore state now, as when the system session is ending. */
  persist(): void
}

const send = (worker: UtilityProcess, command: RunnerCommand, ports: MessagePortMain[] = []) =>
  worker.postMessage(command, ports)

/** What the host hears of each start of the runner, numbered from 1 within the launch. */
export type RunnerEvents = {
  /** The runner started, its process forked. */
  readonly spawned?: (run: number) => void
  /** It can serve, `ms` after it was forked. */
  readonly ready?: (run: number, ms: number) => void
  /**
   * Its process exited with `code`: `expected` when the host was closing it. A crash, a
   * kill or the system's OOM killer says more through `child-process-gone`.
   */
  readonly exited?: (run: number, code: number, expected: boolean) => void
  /** A line it wrote to its stdout or stderr, as V8 and native code write a fatal error. */
  readonly output?: (run: number, stream: "stdout" | "stderr", line: string) => void
  /** Its stdout or stderr ended, as it does once the process is gone. */
  readonly outputEnded?: (run: number, stream: "stdout" | "stderr") => void
}

/** Starts the runner in a utility process and hands out one MessagePort per connection. */
export const startRunner = (options: {
  entry: string
  database: string
  relay: string
  /** The voice engine's manifest and where its archive is downloaded from. */
  engine: string
  source: string
  /** The same for murmur's engine. */
  murmurEngine: string
  murmurSource: string
  /** The host saw only software rendering, so murmur can't run and voice input installs its small model. */
  softwareGraphics?: boolean
  /** How start `run` writes its log: the argument after `logArgumentPrefix`, if it keeps one. */
  log?: (run: number) => string
  events?: RunnerEvents
}): RunnerHost => {
  const { events = {} } = options
  let child: UtilityProcess | undefined
  let closing: Promise<void> | undefined
  let runs = 0
  const spawn = () => {
    runs += 1
    const run = runs
    const forkedAt = performance.now()
    const worker = utilityProcess.fork(
      options.entry,
      [
        `${databaseArgumentPrefix}${options.database}`,
        `${relayArgumentPrefix}${options.relay}`,
        `${voiceEngineArgumentPrefix}${options.engine}`,
        `${voiceSourceArgumentPrefix}${options.source}`,
        `${murmurEngineArgumentPrefix}${options.murmurEngine}`,
        `${murmurSourceArgumentPrefix}${options.murmurSource}`,
        ...(options.softwareGraphics ? [`${graphicsArgumentPrefix}software`] : []),
        ...(options.log ? [`${logArgumentPrefix}${options.log(run)}`] : []),
      ],
      // Its output is piped, so what only reaches stderr, as V8's out-of-memory report,
      // lands in the host's log.
      { serviceName: "Novadeck Runner", stdio: "pipe" },
    )
    events.spawned?.(run)
    for (const stream of ["stdout", "stderr"] as const)
      eachLine(
        worker[stream],
        (line) => events.output?.(run, stream, line),
        () => events.outputEnded?.(run, stream),
      )
    worker.on("message", (report: RunnerReport) => {
      if (report?.type === "ready") events.ready?.(run, Math.round(performance.now() - forkedAt))
    })
    worker.once("exit", (code) => {
      if (child === worker) child = undefined
      // The next connection request starts a new runner.
      events.exited?.(run, code, closing !== undefined)
    })
    child = worker
    return worker
  }
  spawn()
  return {
    deliver(port) {
      if (closing) return false
      send(child ?? spawn(), { type: "connect" }, [port])
      return true
    },
    persist() {
      if (child && !closing) send(child, { type: "persist" })
    },
    close(timeoutMs = 5_000) {
      closing ??= new Promise<void>((resolve) => {
        const worker = child
        if (!worker) {
          resolve()
          return
        }
        const timer = setTimeout(() => worker.kill(), timeoutMs)
        worker.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
        send(worker, { type: "close" })
      })
      return closing
    },
  }
}
