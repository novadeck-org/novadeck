import { homedir } from "node:os"
import { join } from "node:path"

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
  return {
    hostname: environment.HOST?.trim() || "127.0.0.1",
    port: readPort(environment.PORT),
    origins: readOrigins(environment.CORS_ORIGINS),
    ...(token !== undefined && {
      token,
      database:
        environment.NOVADECK_DATABASE?.trim() ||
        join(homedir(), ".local", "share", "novadeck", "workspace.sqlite"),
    }),
  }
}
