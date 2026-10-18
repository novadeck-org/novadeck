import { Hono } from "hono"
import { cors } from "hono/cors"

export type AppOptions = Readonly<{
  origins?: readonly string[]
}>

export const createApp = (options: AppOptions = {}): Hono => {
  const app = new Hono()

  app.use(
    "/api/*",
    cors({
      origin: [...(options.origins ?? ["http://127.0.0.1:5173"])],
    }),
  )
  app.get("/api/status", (context) => context.json({ status: "ready" } as const))
  app.all("/api/*", (context) => context.notFound())

  return app
}
