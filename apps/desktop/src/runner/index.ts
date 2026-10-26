import { dirname, join } from "node:path"

import { createRunner, logDoorbell, useLogger } from "@novadeck/runner"
import { servePort } from "@novadeck/wire/server"
import type { MessagePortMain } from "electron"

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
import { openProcessLog, parseLogSetup } from "../logging.js"
import { watchHost } from "./host-watch.js"

const argument = (prefix: string): string | undefined =>
  process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)

// The runner's own log, runner.log beside the host's: the host may die and this one still
// lands. Opened first, so even a runner that fails to start says why. It shows nothing on
// the console: what the runner prints, the host logs as its output.
const setup = parseLogSetup(argument(logArgumentPrefix))
const logger = setup && openProcessLog("runner", setup, { echo: false })
const log = logger?.for("runner")
if (logger) {
  useLogger(logger)
  logDoorbell(logger.for("doorbell"), { verbose: setup?.verbose ?? false })
  log?.info("runner.start", "The runner started.", {
    data: {
      run: setup?.run ?? null,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
    },
  })
  // Logged as they happen, synchronously; what follows is as it ever was.
  process.on("uncaughtExceptionMonitor", (error, origin) =>
    log?.fatal("runner.uncaught", "The runner hit an error nothing caught.", {
      data: { origin },
      err: error,
    }),
  )
  process.on("unhandledRejection", (reason) =>
    log?.error("runner.rejection", "A promise in the runner failed with nothing to catch it.", {
      err: reason,
    }),
  )
  process.on("exit", (code) => {
    log?.info("runner.end", "The runner exited.", { data: { code } })
    logger.close()
  })
}

// Whether the host's main process still beats: a freeze of the whole app shows here,
// where the runner's log still lands. Its timer never keeps the runner alive.
const checkMs = 500
const host = logger && watchHost({ log: logger.for("host"), now: () => performance.now(), checkMs })
if (host) setInterval(() => host.check(), checkMs).unref()

// Runs in an Electron utility process, so PTYs live outside the main process.
const database = argument(databaseArgumentPrefix)
const relay = argument(relayArgumentPrefix)
const engine = argument(voiceEngineArgumentPrefix)
const source = argument(voiceSourceArgumentPrefix)
const murmurEngine = argument(murmurEngineArgumentPrefix)
const murmurSource = argument(murmurSourceArgumentPrefix)
const softwareGraphics = argument(graphicsArgumentPrefix) === "software"

// The key saved transcripts are encrypted with arrives from the host over the parent port
// once it has it, which may wait on the person; null where none can be kept safe. The
// runner starts at once and saves and shows no transcript until it settles.
let giveTranscriptKey: (key: Uint8Array | null) => void = () => {}
const transcriptKey = new Promise<Uint8Array | null>((resolve) => {
  giveTranscriptKey = resolve
})

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
  transcriptKey,
})

// The host times the runner's start up to here: it can serve.
log?.info("runner.ready", "The runner is ready.", {
  data: { ms: Math.round(performance.now()) },
})
// eslint-disable-next-line unicorn/require-post-message-target-origin -- Electron's parent port, not a window.
process.parentPort.postMessage({ type: "ready" } satisfies RunnerReport)

process.parentPort.on(
  "message",
  ({ data, ports }: { data: RunnerCommand; ports: MessagePortMain[] }) => {
    if (data.type === "connect" && ports[0]) servePort(runner.sessions, ports[0])
    // Only the first settles it; the host sends one per start.
    if (data.type === "transcriptKey")
      giveTranscriptKey(data.key === null ? null : Buffer.from(data.key, "base64"))
    if (data.type === "persist") runner.persist()
    if (data.type === "beat") host?.beat()
    if (data.type === "close") void runner.close().finally(() => process.exit(0))
  },
)
