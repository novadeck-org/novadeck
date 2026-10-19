import { dirname, join } from "node:path"

import { createRunner } from "@novadeck/runner"
import { servePort } from "@novadeck/wire/server"
import type { MessagePortMain } from "electron"

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

const argument = (prefix: string): string | undefined =>
  process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)

// Runs in an Electron utility process, so PTYs live outside the main process.
const database = argument(databaseArgumentPrefix)
const relay = argument(relayArgumentPrefix)
const engine = argument(voiceEngineArgumentPrefix)
const source = argument(voiceSourceArgumentPrefix)
const murmurEngine = argument(murmurEngineArgumentPrefix)
const murmurSource = argument(murmurSourceArgumentPrefix)
const softwareGraphics = argument(graphicsArgumentPrefix) === "software"

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
  // Its installed engine and models live in a `voice` folder beside the database.
  voice: {
    ...(engine !== undefined && { engine }),
    ...(source !== undefined && { source }),
  },
  // Murmur's likewise, in a `murmur` folder.
  murmur: {
    ...(murmurEngine !== undefined && { engine: murmurEngine }),
    ...(murmurSource !== undefined && { source: murmurSource }),
  },
  // Told only when the host saw no graphics hardware; otherwise the installs' checks decide.
  ...(softwareGraphics && { softwareGraphics }),
})

process.parentPort.on(
  "message",
  ({ data, ports }: { data: RunnerCommand; ports: MessagePortMain[] }) => {
    if (data.type === "connect" && ports[0]) servePort(runner.sessions, ports[0])
    if (data.type === "persist") runner.persist()
    if (data.type === "close") void runner.close().finally(() => process.exit(0))
  },
)
