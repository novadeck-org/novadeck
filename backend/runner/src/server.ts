import { maxWebSocketMessageBytes } from "@novadeck/protocol"

import { startHttpServer, type HttpOptions, type HttpServer } from "./http.js"
import type { RunnerOptions } from "./runner.js"
import type { TerminalOptions } from "./terminals/index.js"

export type ServerOptions = HttpOptions &
  Readonly<{
    token?: string
    database?: string
    /** Where the shell integration goes; see `RunnerOptions.shell`. */
    shell?: string
    /** Where pasted files go; see `RunnerOptions.uploads`. */
    uploads?: string
    /** Where saved dialogs go; see `RunnerOptions.dialogs`. */
    dialogs?: string
    /**
     * The file saved transcripts' key is kept in, made where missing (see
     * `loadTranscriptKeyFile`); without it no transcript is saved.
     */
    transcriptKeyFile?: string
    /** The relay agents start for Novadeck's MCP server and hooks; see `RunnerOptions.relay`. */
    relay?: string
    /** Voice input's engine and where it installs; see `RunnerOptions.voice`. */
    voice?: RunnerOptions["voice"]
    /** Murmur's engine and where it installs; see `RunnerOptions.murmur`. */
    murmur?: RunnerOptions["murmur"]
    terminals?: TerminalOptions
  }>

/** A standalone runner's listener, which `superviseRunner` ends. */
export type Server = HttpServer &
  Readonly<{
    /** Saves every terminal's restore state now; nothing without a token, as there is no runner. */
    persist: () => void
  }>

/** Standalone runner: HTTP status plus a token-authenticated WebSocket runner API. */
export const startServer = async (options: ServerOptions = {}): Promise<Server> => {
  if (options.token === undefined) return { ...(await startHttpServer(options)), persist: () => {} }
  const [{ createRunner }, { serveWebSocket }, { loadTranscriptKeyFile }, { logs }] =
    await Promise.all([
      import("./index.js"),
      import("@novadeck/wire/server"),
      import("./transcript-key-file.js"),
      import("./log.js"),
    ])
  const keyFile = options.transcriptKeyFile
  const runner = createRunner({
    ...(options.database !== undefined && { database: options.database }),
    ...(options.shell !== undefined && { shell: options.shell }),
    ...(options.uploads !== undefined && { uploads: options.uploads }),
    ...(options.dialogs !== undefined && { dialogs: options.dialogs }),
    ...(options.relay !== undefined && { relay: options.relay }),
    ...(options.voice !== undefined && { voice: options.voice }),
    ...(options.murmur !== undefined && { murmur: options.murmur }),
    // The runner starts at once and keeps no transcript until the key settles.
    ...(keyFile !== undefined && {
      transcriptKey: loadTranscriptKeyFile({
        path: keyFile,
        platform: process.platform,
        log: logs.for("transcript-key"),
      }),
    }),
    // A shared, network-reachable runner keeps a cap; the desktop runner has none.
    terminals: { maxTerminals: 32, ...options.terminals },
  })
  let sockets: ReturnType<typeof serveWebSocket>
  try {
    sockets = serveWebSocket(runner.sessions, {
      path: "/api/rpc",
      token: options.token,
      origins: options.origins ?? ["http://127.0.0.1:5173"],
      maxPayloadBytes: maxWebSocketMessageBytes,
      // Room for a terminal's largest initial snapshot, and the traffic beside it.
      sendBudgetBytes: runner.snapshotBytes + 8 * 1024 * 1024,
    })
  } catch (error) {
    await runner.close()
    throw error
  }
  const server = await startHttpServer(options, {
    attach: (listener) => listener.on("upgrade", sockets.upgrade),
    async close() {
      // The runner first: its last save is made while every shell still runs, before the
      // clients' sessions end, which can take a while.
      const closing = runner.close()
      try {
        await sockets.close()
      } finally {
        await closing
      }
    },
  })
  return { ...server, persist: () => runner.persist() }
}
