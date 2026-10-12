import { availableParallelism } from "node:os"

import { z } from "zod"

import { Server, token, type Launch, type ServerSpec } from "../engines/server.js"
import { EngineError, programFile } from "../engines/unpack.js"
import { languageCode } from "./languages.js"

/** The engine's program inside its folder. */
export const engineProgram = programFile("whisper-server")

/** What a running engine needs: its program, the speech model and the voice activity model. */
export type EngineConfig = {
  readonly folder: string
  readonly model: string
  readonly vad: string
  readonly language: string
}

type Facts = {
  /** Whether the engine put the model on a GPU, from its log; unknown until it says. */
  gpu: boolean | undefined
}

const spec: ServerSpec<EngineConfig, Facts> = {
  program: engineProgram,
  subject: "Voice input",
  health: "/health",
  key: (config) => [config.folder, config.model].join("\n"),
  facts: () => ({ gpu: undefined }),
  prepare(config, port) {
    const path = `/${token()}`
    const threads = Math.min(8, Math.max(2, Math.floor(availableParallelism() / 2)))
    // Changing these flags, or the requests this class makes of the server, changes the
    // interface: bump `engineInterface` in application/whisper/scripts/build.ts with it.
    return {
      path,
      args: [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--request-path",
        path,
        "-m",
        config.model,
        "-l",
        config.language,
        "-nt",
        "-t",
        String(threads),
        "--vad",
        "-vm",
        config.vad,
        // Ends the engine once its stdin closes, which is when this runner is gone, however
        // it went: a runner killed outright never stops it otherwise (see whisper patches).
        "--exit-with-stdin",
      ],
    }
  },
  onLine(line, facts) {
    // The first of these is the speech model's: the voice model loads later.
    if (facts.gpu !== undefined) return
    const backend = /whisper_backend_init_gpu: using (\S+) backend/.exec(line)
    if (backend) facts.gpu = !/^cpu/i.test(backend[1] ?? "cpu")
    else if (/whisper_backend_init_gpu: no GPU found/.test(line)) facts.gpu = false
  },
}

const reply = z.looseObject({ text: z.string(), language: z.string().optional() })

/**
 * The speech engine, `whisper-server` on a loopback port: started when first needed,
 * kept warm for a while, and started again after it stops or its model changes.
 */
export class Engine {
  private readonly server: Server<EngineConfig, Facts>

  constructor(options: { launch?: Launch; idleMs?: number; startMs?: number } = {}) {
    this.server = new Server(spec, options)
  }

  /** Whether the running engine uses a GPU; `undefined` when none runs or it has not said. */
  get gpu(): boolean | undefined {
    return this.server.facts?.gpu
  }

  /** Starts the engine, or finds it started, and answers when it can transcribe. */
  start(config: EngineConfig): Promise<void> {
    return this.server.start(config)
  }

  /** Transcribes a WAV file; `language` of `auto` lets the engine tell. */
  async transcribe(
    config: EngineConfig,
    audio: Uint8Array,
    options: { language: string; prompt?: string | undefined; timeoutMs?: number },
  ): Promise<{ text: string; language: string }> {
    const running = await this.server.acquire(config)
    const form = new FormData()
    form.set("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "clip.wav")
    form.set("response_format", "verbose_json")
    form.set("language", options.language)
    form.set("temperature", "0")
    // The server would otherwise detect the language again, to report odds nobody reads.
    form.set("no_language_probabilities", "true")
    if (options.prompt) form.set("prompt", options.prompt)
    const response = await this.server.request(running, "/inference", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
    })
    if (!response.ok)
      throw new EngineError(this.server.explain(running, `the engine answered ${response.status}`))
    const body = reply.safeParse(await response.json().catch(() => undefined))
    if (!body.success)
      throw new EngineError(this.server.explain(running, "the engine's answer made no sense"))
    this.server.touch(running)
    return {
      text: body.data.text.trim(),
      language:
        options.language === "auto" ? languageCode(body.data.language ?? "") : options.language,
    }
  }

  /** Ends the engine, if it runs, once it has stopped. */
  stop(): Promise<void> {
    return this.server.stop()
  }

  /** Ends the engine and refuses to start another. */
  close(): Promise<void> {
    return this.server.close()
  }
}
