import { loadEnvFile } from "node:process"

import { readConfig } from "./config.js"
import { endOnSignals, superviseRunner } from "./lifecycle.js"
import { startServer } from "./server.js"

try {
  loadEnvFile()
} catch (error: unknown) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
}

const server = await startServer(readConfig())

console.log(`Novadeck runner listening at ${server.origin}`)
if (!process.env.NOVADECK_TOKEN) {
  console.log("Terminal API disabled. Set NOVADECK_TOKEN to enable authenticated access.")
}

// A system stop (systemd, Docker) or Ctrl+C saves every terminal, then ends the shells, as
// quitting the desktop app does; a second one a moment later exits at once.
endOnSignals(superviseRunner({ runner: server, exit: (code) => process.exit(code) }), {
  heard: (signal) => console.log(`Novadeck runner stopping (${signal}): saving terminals.`),
})
