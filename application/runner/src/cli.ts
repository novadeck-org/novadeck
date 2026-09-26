import { loadEnvFile } from "node:process"

import { readConfig } from "./config.js"
import { startServer } from "./server.js"

try {
  loadEnvFile()
} catch (error: unknown) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
}

const server = await startServer(readConfig())

console.log(`NovaDeck runner listening at ${server.origin}`)
if (!process.env.NOVADECK_TOKEN) {
  console.log("Terminal API disabled. Set NOVADECK_TOKEN to enable authenticated access.")
}

const stop = (): void => {
  void server.close().then(() => process.exit(0))
}

process.once("SIGINT", stop)
process.once("SIGTERM", stop)
