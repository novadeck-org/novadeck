import { dirname, join } from "node:path"

import { createRunner, servePort } from "@novadeck/runner"
import type { MessagePortMain } from "electron"

import { databaseArgumentPrefix, relayArgumentPrefix, type RunnerCommand } from "../bridge.js"

const argument = (prefix: string): string | undefined =>
  process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)

// Runs in an Electron utility process, so PTYs live outside the main process.
const database = argument(databaseArgumentPrefix)
const relay = argument(relayArgumentPrefix)

// Without `maxTerminals`, the desktop runner starts as many terminals as the user opens.
// Its shell integration and pasted files live beside the database, in the app's own data
// directory.
const runner = createRunner({
  ...(database !== undefined && {
    database,
    shell: join(dirname(database), "shell"),
    uploads: join(dirname(database), "uploads"),
  }),
  ...(relay !== undefined && { relay }),
})

process.parentPort.on(
  "message",
  ({ data, ports }: { data: RunnerCommand; ports: MessagePortMain[] }) => {
    if (data.type === "connect" && ports[0]) servePort(runner, ports[0])
    if (data.type === "persist") runner.persist()
    if (data.type === "close") void runner.close().finally(() => process.exit(0))
  },
)
