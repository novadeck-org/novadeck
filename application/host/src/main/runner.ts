import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
  type WebContents,
} from "electron"

import { databaseArgumentPrefix, runnerPortChannel, type RunnerCommand } from "../bridge.js"

export type RunnerHost = {
  /** Gives a renderer a fresh port to the runner, starting the runner again if it stopped. */
  connect(contents: WebContents, id: string): void
  /**
   * Ends the runner's shells, then the process; forcibly after `timeoutMs`. Final:
   * later connection requests are ignored.
   */
  close(timeoutMs?: number): Promise<void>
}

const send = (worker: UtilityProcess, command: RunnerCommand, ports: MessagePortMain[] = []) =>
  worker.postMessage(command, ports)

/** Starts the runner in a utility process and hands out one MessagePort per connection. */
export const startRunner = (options: { entry: string; database: string }): RunnerHost => {
  let child: UtilityProcess | undefined
  let closing: Promise<void> | undefined
  const spawn = () => {
    const worker = utilityProcess.fork(
      options.entry,
      [`${databaseArgumentPrefix}${options.database}`],
      { serviceName: "NovaDeck Runner" },
    )
    worker.once("exit", (code) => {
      if (child === worker) child = undefined
      // The next connection request starts a new runner.
      if (!closing) console.error(`NovaDeck runner exited unexpectedly (code ${code})`)
    })
    child = worker
    return worker
  }
  spawn()
  return {
    connect(contents, id) {
      if (closing) return
      const { port1, port2 } = new MessageChannelMain()
      send(child ?? spawn(), { type: "connect" }, [port1])
      contents.postMessage(runnerPortChannel, id, [port2])
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
