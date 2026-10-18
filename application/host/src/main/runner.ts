import { utilityProcess, type MessagePortMain, type UtilityProcess } from "electron"

import {
  databaseArgumentPrefix,
  murmurEngineArgumentPrefix,
  graphicsArgumentPrefix,
  murmurSourceArgumentPrefix,
  relayArgumentPrefix,
  voiceEngineArgumentPrefix,
  voiceSourceArgumentPrefix,
  type RunnerCommand,
} from "../bridge.js"

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
}): RunnerHost => {
  let child: UtilityProcess | undefined
  let closing: Promise<void> | undefined
  const spawn = () => {
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
      ],
      { serviceName: "Novadeck Runner" },
    )
    worker.once("exit", (code) => {
      if (child === worker) child = undefined
      // The next connection request starts a new runner.
      if (!closing) console.error(`Novadeck runner exited unexpectedly (code ${code})`)
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
