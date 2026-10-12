// Stands in for llama-server in tests: it takes the real arguments, listens on --port, and
// behaves as the file given as its model says, so no test needs a real engine.
//   "fail:Vulkan0"  cannot load the model onto that device, and exits
//   "late"          takes half a second to listen, as a model loading
//   "crash"         exits when it is asked to complete
//   "slow"          takes half a second to answer
//   "copy"          answers with the first example title of the prompt, whatever it is asked
//   "hang"          never answers a completion
//   "garbage"       answers with something that isn't the JSON asked for
//   "device"        puts the device it runs on in its title
//   "log"           appends each request it is sent, as a line of JSON, to the model's file name + ".requests"
// What the file says at the start steers loading ("fail", "late"); what it says at each
// request steers the answer, so a test can mend or break a running server by rewriting it.
// The real server lists devices before it has a model; here the test hands them over as
// `--fake-devices <json>`, each { id, name, free, total, kind }.
import { appendFileSync, readFileSync } from "node:fs"
import { createServer } from "node:http"

const argument = (name) => process.argv[process.argv.indexOf(name) + 1]
const has = (name) => process.argv.includes(name)

const devices = has("--fake-devices") ? JSON.parse(argument("--fake-devices")) : []
const listed = devices.map(
  (device) =>
    `  ${device.id}: ${device.name} (${device.total ?? 16000} MiB, ${device.free ?? 8000} MiB free) [${device.kind}]`,
)

if (has("--list-devices")) {
  console.log(["Available devices:", ...listed].join("\n"))
  process.exit(0)
}

const behaviour = readFileSync(argument("-m"), "utf8")
const current = () => readFileSync(argument("-m"), "utf8")
const device = argument("--device")
if (!devices.some((candidate) => candidate.id === device)) {
  console.error(`error: invalid device: ${device}`)
  process.exit(1)
}
if (behaviour.includes(`fail:${device}`)) {
  console.error(`ggml_vulkan: failed to allocate buffer on ${device}`)
  process.exit(1)
}

// As the patched server does: the runner holds stdin open while it lives.
if (has("--exit-with-stdin")) {
  process.stdin.on("end", () => process.exit(0))
  process.stdin.resume()
}

// As the real server reads it: from the environment, where no one lists it.
const key = process.env.LLAMA_API_KEY ?? ""
let completions = 0

const body = async (request) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname
  response.setHeader("content-type", "application/json")
  if (path === "/health" && request.method === "GET") {
    response.end(JSON.stringify({ status: "ok" }))
    return
  }
  if (path !== "/v1/chat/completions" || request.method !== "POST") {
    response.statusCode = 404
    response.end(JSON.stringify({ error: "not found" }))
    return
  }
  // As the real server: every endpoint but /health wants the key.
  if (request.headers.authorization !== `Bearer ${key}`) {
    response.statusCode = 401
    response.end(JSON.stringify({ error: { message: "Invalid API Key" } }))
    return
  }
  const asked = await body(request)
  const mode = current()
  if (mode.includes("crash")) {
    console.error("GGML_ASSERT: out of memory")
    process.exit(3)
  }
  if (mode.includes("hang")) await new Promise(() => {})
  if (mode.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 500))
  completions += 1
  if (mode.includes("log"))
    appendFileSync(`${argument("-m")}.requests`, `${JSON.stringify(asked)}\n`)
  const content = mode.includes("garbage")
    ? "Sure! Here is a title for your terminal."
    : JSON.stringify({
        title: mode.includes("copy")
          ? "Rotating billing webhook keys"
          : mode.includes("device")
            ? `Fake title on ${device}`
            : `Fake title ${completions}`,
      })
  response.end(
    JSON.stringify({
      model: "fake",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    }),
  )
})
const listen = () => server.listen(Number(argument("--port")), argument("--host"))
if (behaviour.includes("late")) setTimeout(listen, 500)
else listen()
