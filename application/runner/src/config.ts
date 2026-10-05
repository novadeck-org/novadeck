import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import type { ServerOptions } from "./server.js"

const defaultCorsOrigins = ["http://127.0.0.1:5173"]

const readPort = (value: string | undefined): number => {
  const port = Number(value ?? "8787")

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535")
  }

  return port
}

const readOrigins = (value: string | undefined): readonly string[] => {
  if (value === undefined) return defaultCorsOrigins

  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)

  if (origins.length === 0) throw new Error("CORS_ORIGINS must contain at least one origin")

  return origins
}

export const readConfig = (environment: NodeJS.ProcessEnv = process.env): ServerOptions => {
  const token = environment.NOVADECK_TOKEN?.trim()
  if (token !== undefined && (token.length < 32 || token.length > 512)) {
    throw new Error("NOVADECK_TOKEN must contain between 32 and 512 characters")
  }
  // Absolute, so shells started anywhere find the shell integration beside it.
  const database = resolve(
    environment.NOVADECK_DATABASE?.trim() ||
      join(homedir(), ".local", "share", "novadeck", "workspace.sqlite"),
  )
  const relay = environment.NOVADECK_RELAY?.trim()
  return {
    hostname: environment.HOST?.trim() || "127.0.0.1",
    port: readPort(environment.PORT),
    origins: readOrigins(environment.CORS_ORIGINS),
    // The shell integration and pasted files live beside the metadata.
    ...(token !== undefined && {
      token,
      database,
      shell: join(dirname(database), "shell"),
      uploads: join(dirname(database), "uploads"),
    }),
    // Another build of the relay than `@novadeck/relay`'s, as a packaged one.
    ...(relay ? { relay: resolve(relay) } : {}),
  }
}
