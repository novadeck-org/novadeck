import { createRunner, servePort } from "@novadeck/runner"
import type { MessagePortMain } from "electron"

import { databaseArgumentPrefix, type RunnerCommand } from "../bridge.js"

// Runs in an Electron utility process, so PTYs live outside the main process.
const database = process.argv
  .find((value) => value.startsWith(databaseArgumentPrefix))
  ?.slice(databaseArgumentPrefix.length)

const runner = createRunner(database === undefined ? {} : { database })

process.parentPort.on(
  "message",
  ({ data, ports }: { data: RunnerCommand; ports: MessagePortMain[] }) => {
    if (data.type === "connect" && ports[0]) servePort(runner, ports[0])
    if (data.type === "close") void runner.close().finally(() => process.exit(0))
  },
)
