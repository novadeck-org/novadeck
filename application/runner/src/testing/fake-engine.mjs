// Stands in for whisper-server in tests: it takes the real arguments, listens on --port,
// and behaves as the file given as its model says, so no test needs a real engine.
//   "gpu"   logs that the model went onto a GPU
//   "crash" exits when it is asked to transcribe
//   "slow"  takes half a second to answer
//   "mute"  hears nothing
//   "late"  takes half a second to listen, as a model loading
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { Readable } from "node:stream"

const argument = (name) => process.argv[process.argv.indexOf(name) + 1]
const behaviour = readFileSync(argument("-m"), "utf8")
const language = argument("-l")
// As the real server with --request-path: nothing answers outside it.
const base = process.argv.includes("--request-path") ? argument("--request-path") : ""

// As the patched server does: the runner holds stdin open while it lives.
if (process.argv.includes("--exit-with-stdin")) {
  process.stdin.on("end", () => process.exit(0))
  process.stdin.resume()
}

console.error(
  behaviour.includes("gpu")
    ? "whisper_backend_init_gpu: using Vulkan0 backend"
    : "whisper_backend_init_gpu: no GPU found",
)

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname
  if (path === `${base}/health` && request.method === "GET") {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ status: "ok" }))
    return
  }
  if (path !== `${base}/inference` || request.method !== "POST") {
    response.statusCode = 404
    response.end("not found")
    return
  }
  const form = await new Request("http://localhost/", {
    method: "POST",
    headers: request.headers,
    body: Readable.toWeb(request),
    duplex: "half",
  }).formData()
  if (behaviour.includes("crash")) {
    console.error("GGML_ASSERT: out of memory")
    process.exit(3)
  }
  if (behaviour.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 500))
  const bytes = (await form.get("file").arrayBuffer()).byteLength
  const asked = form.get("language")
  const text = behaviour.includes("mute")
    ? ""
    : ` ${JSON.stringify({ asked, started: language, prompt: form.get("prompt"), bytes })} `
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify({ text, language: asked === "auto" ? "polish" : asked }))
})
const listen = () => server.listen(Number(argument("--port")), argument("--host"))
if (behaviour.includes("late")) setTimeout(listen, 500)
else listen()
