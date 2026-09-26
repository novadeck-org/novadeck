import { format } from "node:url"

import { serve, type ServerType } from "@hono/node-server"

import { createApp } from "./app.js"

export type HttpOptions = Readonly<{
  hostname?: string
  port?: number
  origins?: readonly string[]
}>

export type HttpService = {
  attach(server: ServerType): void
  close(): Promise<void>
}

export type HttpServer = Readonly<{
  origin: string
  close: () => Promise<void>
}>

const close = (server: ServerType): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })

/**
 * Serves the HTTP status endpoint, plus an optional service on the same listener.
 * This entry stays free of native terminal code, so hosts can bundle it on its own.
 */
export const startHttpServer = async (
  options: HttpOptions = {},
  service?: HttpService,
): Promise<HttpServer> => {
  const hostname = options.hostname ?? "127.0.0.1"
  const port = options.port ?? 8787
  const app = options.origins ? createApp({ origins: options.origins }) : createApp()

  try {
    return await new Promise((resolve, reject) => {
      let closing: Promise<void> | undefined
      const server = serve(
        {
          fetch: app.fetch,
          hostname,
          port,
        },
        (info) => {
          server.off("error", reject)
          resolve({
            origin: format({ hostname, port: info.port, protocol: "http" }),
            close: () => {
              closing ??= (async () => {
                try {
                  await service?.close()
                } finally {
                  await close(server)
                }
              })()
              return closing
            },
          })
        },
      )

      server.once("error", reject)
      service?.attach(server)
    })
  } catch (error) {
    await service?.close()
    throw error
  }
}
