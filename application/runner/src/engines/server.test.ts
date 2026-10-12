import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { folder } from "../testing/engines.js"
import { engineEnvironment, runEngineOnce, Server, type Launch, type ServerSpec } from "./server.js"
import { EngineError } from "./unpack.js"

// A program of its own, not whisper's: it listens on --port and tells its environment
// at /env, logging one line to say it is up.
const script = `
import { createServer } from "node:http"
const port = Number(process.argv[process.argv.indexOf("--port") + 1])
if (process.argv.includes("--exit-with-stdin")) { process.stdin.on("end", () => process.exit(0)); process.stdin.resume() }
console.error("ready on the device " + process.env.TEST_DEVICE)
createServer((request, response) => {
  if (request.url === "/prefix/health") return response.end("ok")
  if (request.url === "/prefix/env") return response.end(process.env.TEST_KEY + "/" + process.env.TEST_DEVICE)
  if (request.url === "/prefix/echo")
    return response.end(JSON.stringify({
      llama: process.env.LLAMA_ARG_PORT ?? null,
      lower: process.env.aip_mode ?? null,
      hf: process.env.HF_TOKEN ?? null,
      ggml: process.env.GGML_VK_VISIBLE_DEVICES ?? null,
      launched: process.env.LLAMA_API_KEY ?? null,
      header: request.headers["x-spec"] ?? null,
      other: request.headers["x-call"] ?? null,
    }))
  response.statusCode = 404
  response.end()
}).listen(port, "127.0.0.1")
`

type Config = { readonly folder: string; readonly key: string }

const spec: ServerSpec<Config, { device: string | undefined }> = {
  program: "demo-server",
  subject: "Demo",
  health: "/health",
  key: (config) => config.key,
  facts: () => ({ device: undefined }),
  prepare: (config, port) => ({
    path: "/prefix",
    args: ["--port", String(port), "--exit-with-stdin"],
    env: { TEST_KEY: config.key, LLAMA_API_KEY: config.key },
    headers: { "x-spec": config.key, "x-call": "spec" },
  }),
  onLine(line, facts) {
    const heard = /device (\S+)/.exec(line)
    if (heard) facts.device = heard[1]
  },
}

const launchWith = async (
  resources: Parameters<typeof folder>[0],
  env?: Record<string, string>,
) => {
  const directory = await folder(resources)
  const file = join(directory, "demo.mjs")
  await writeFile(file, script)
  const launch: Launch = (_program, args) => ({
    command: process.execPath,
    args: [file, ...args],
    ...(env && { env }),
  })
  return { directory, launch }
}

describe("a server", () => {
  it("runs the program under a path of its own, with the environment its spec and the launch give", async ({
    resources,
  }) => {
    const { directory, launch } = await launchWith(resources, { TEST_DEVICE: "Vulkan0" })
    const server = new Server(spec, { launch })
    resources.defer(() => server.close())

    const running = await server.acquire({ folder: directory, key: "secret" })
    const response = await server.request(running, "/env", { signal: AbortSignal.timeout(5000) })

    expect(await response.text()).toBe("secret/Vulkan0")
    expect(server.facts?.device).toBe("Vulkan0")
    await server.stop()
    expect(server.facts).toBeUndefined()
  })

  it("starts another process for another key and shares one for the same", async ({
    resources,
  }) => {
    const { directory, launch } = await launchWith(resources)
    const server = new Server(spec, { launch })
    resources.defer(() => server.close())

    const first = await server.acquire({ folder: directory, key: "a" })
    const again = await server.acquire({ folder: directory, key: "a" })
    const other = await server.acquire({ folder: directory, key: "b" })

    expect(again).toBe(first)
    expect(other).not.toBe(first)
    expect(first.stopped).toBe(true)
  })

  it("explains a failed start by its cause, not by the generic lines the engine ends with", async ({
    resources,
  }) => {
    const lines = [
      "0.00.077.753 E llama_model_load_from_file_impl: failed to load model",
      "0.00.077.809 E common_fit_params: encountered an error while trying to fit params: failed to load model",
      "0.00.077.830 E gguf_init_from_reader: invalid magic characters: 'abcd', expected 'GGUF'",
      "0.00.077.840 E llama_model_load: error loading model: llama_model_loader: failed to load model from /m/x.gguf",
      "0.00.077.844 E cmn  common_init_: failed to load model '/m/x.gguf'",
      "0.00.077.850 I srv    operator(): operator(): cleaning up before exit...",
      "0.00.078.411 E srv  llama_server: exiting due to model loading error",
    ]
    const server = new Server(spec, {
      launch: () => ({
        command: process.execPath,
        args: ["-e", `console.error(${JSON.stringify(lines.join("\n"))}); process.exit(1)`],
      }),
    })
    resources.defer(() => server.close())
    const directory = await folder(resources)

    const failure = server.start({ folder: directory, key: "a" })

    await expect(failure).rejects.toThrow(
      "Demo failed: the engine stopped while starting. gguf_init_from_reader: invalid magic characters: 'abcd', expected 'GGUF'",
    )
    await expect(failure).rejects.not.toThrow("exiting due to")
  })

  it("does not blame a runtime crash on a warning the engine printed while starting", async ({
    resources,
  }) => {
    const lines = [
      "0.00.010.000 W srv  compute buffer allocation failed, retrying without pipeline parallelism",
      "0.00.020.000 I srv  llama_server: listening on http://127.0.0.1:1234",
      "0.00.030.000 I srv  update_slots: all slots are idle",
      "0.00.040.000 I srv  log_server_r: request: POST /v1/chat/completions 200",
    ]
    const server = new Server(spec, {
      launch: () => ({
        command: process.execPath,
        args: ["-e", `console.error(${JSON.stringify(lines.join("\n"))}); process.exit(1)`],
      }),
    })
    resources.defer(() => server.close())
    const directory = await folder(resources)

    const failure = server.start({ folder: directory, key: "a" })

    await expect(failure).rejects.toThrow(
      "srv  update_slots: all slots are idle srv  log_server_r: request: POST /v1/chat/completions 200",
    )
    await expect(failure).rejects.not.toThrow("compute buffer")
  })

  it("explains a failure without a recognisable cause by its last lines", async ({ resources }) => {
    const server = new Server(spec, {
      launch: () => ({
        command: process.execPath,
        args: ["-e", "console.error('one\\ntwo\\nthree'); process.exit(1)"],
      }),
    })
    resources.defer(() => server.close())
    const directory = await folder(resources)

    await expect(server.start({ folder: directory, key: "a" })).rejects.toThrow(
      "the engine stopped while starting. two three",
    )
  })

  it("words its failures with its subject", async ({ resources }) => {
    const server = new Server(spec, {
      launch: () => ({
        command: process.execPath,
        args: ["-e", "console.error('boom'); process.exit(2)"],
      }),
    })
    resources.defer(() => server.close())
    const directory = await folder(resources)

    const failure = server.start({ folder: directory, key: "a" })

    await expect(failure).rejects.toThrow(EngineError)
    await expect(failure).rejects.toThrow("Demo failed: the engine stopped")
  })
})

// Sets variables of this process for one test, and puts them back.
const withEnvironment = async (set: Record<string, string>, run: () => Promise<void>) => {
  const before = Object.fromEntries(Object.keys(set).map((name) => [name, process.env[name]]))
  Object.assign(process.env, set)
  try {
    await run()
  } finally {
    for (const [name, value] of Object.entries(before))
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
  }
}

describe("an engine's environment", () => {
  it("leaves out the settings llama.cpp and its libraries read, in any case, and keeps the rest", async () => {
    await withEnvironment(
      {
        LLAMA_ARG_PORT: "1",
        llamacpp_x: "1",
        AIP_MODE: "1",
        Hf_Token: "1",
        LLGUIDANCE_LOG: "1",
        GGML_VK_VISIBLE_DEVICES: "0",
        NOVADECK_TEST_KEEP: "yes",
      },
      async () => {
        const environment = engineEnvironment({ LLAMA_API_KEY: "mine" })

        expect(
          Object.keys(environment).filter((name) => /^(llama|aip|hf|llgui)/i.test(name)),
        ).toEqual(["LLAMA_API_KEY"])
        expect(environment).toMatchObject({
          GGML_VK_VISIBLE_DEVICES: "0",
          NOVADECK_TEST_KEEP: "yes",
        })
        await Promise.resolve()
      },
    )
  })

  it("is what a server runs in, whatever the launch adds, and its headers go with its requests", async ({
    resources,
  }) => {
    const { directory, launch } = await launchWith(resources)
    const server = new Server(spec, { launch })
    resources.defer(() => server.close())

    await withEnvironment(
      { LLAMA_ARG_PORT: "1", aip_mode: "1", HF_TOKEN: "1", GGML_VK_VISIBLE_DEVICES: "0" },
      async () => {
        const running = await server.acquire({ folder: directory, key: "secret" })
        const response = await server.request(running, "/echo", {
          headers: { "x-call": "caller" },
          signal: AbortSignal.timeout(5000),
        })

        expect(await response.json()).toEqual({
          llama: null,
          lower: null,
          hf: null,
          ggml: "0",
          launched: "secret",
          header: "secret",
          other: "caller",
        })
      },
    )
  })
})

const printing: Launch = (_program, args) => ({
  command: process.execPath,
  args: [
    "-e",
    "console.log(process.env.LLAMA_ARG_HOST ?? 'clean', process.env.EXTRA); console.error(process.argv[1])",
    "--",
    ...args,
  ],
  env: { EXTRA: "launched" },
})
const missing: Launch = () => ({ command: "novadeck-no-such-program", args: [] })
const hangs: Launch = () => ({
  command: process.execPath,
  args: ["-e", "setTimeout(() => {}, 60000)"],
})

const exits: Launch = () => ({ command: process.execPath, args: ["-e", "process.exit(3)"] })

const printsALot: Launch = () => ({
  command: process.execPath,
  args: ["-e", "process.stdout.write('x'.repeat(2e6))"],
})

describe("running an engine once", () => {
  it("answers with what it printed, from the engine environment", async () => {
    await withEnvironment({ LLAMA_ARG_HOST: "0.0.0.0" }, async () => {
      const printed = await runEngineOnce(printing, "llama-server", ["--list-devices"], {
        signal: AbortSignal.timeout(10_000),
      })

      expect(printed.stdout.trim()).toBe("clean launched")
      expect(printed.stderr.trim()).toBe("--list-devices")
    })
  })

  it("says why a program could not run or finish, and reports its exit code", async () => {
    const missed = await runEngineOnce(missing, "x", [])
    expect(missed).toMatchObject({ stdout: "", stderr: "", code: null })
    expect(missed.failure).toContain("ENOENT")
    const late = await runEngineOnce(hangs, "x", [], { timeoutMs: 200 })
    expect(late).toMatchObject({ code: null, failure: "timed out after 200 ms" })
    await expect(runEngineOnce(hangs, "x", [], { signal: AbortSignal.abort() })).resolves.toEqual({
      stdout: "",
      stderr: "",
      code: null,
    })
    const loud = await runEngineOnce(printsALot, "x", [])
    expect(loud).toMatchObject({ code: null, failure: "printed more than its output may hold" })
    await expect(runEngineOnce(exits, "x", [])).resolves.toEqual({
      stdout: "",
      stderr: "",
      code: 3,
    })
  })
})
