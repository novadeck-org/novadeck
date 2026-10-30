// Stands in for llama-server in tests: it takes the real arguments, listens on --port, and
// behaves as the file given as its model says, so no test needs a real engine.
//   "fail:Vulkan0"  cannot load the model onto that device, and exits; with "said:<text>" (no
//                   spaces) it says that instead of why
//   "late"          takes half a second to listen, as a model loading
//   "crash"         exits when it is asked to complete
//   "slow"          takes half a second to answer
//   "copy"          answers with the first example of the kind asked for, whatever it is asked
//   "overflow"      answers 400 exceed_context_size_error, as the real server does for a request too big
//   "hang"          never answers a completion
//   "seen"          appends a line to the model's file name + ".seen" as each completion arrives,
//                   before anything else it does, so a test can wait for a request to be under way
//   "truncate"      answers 200 with a body cut off in the middle, as an engine that crashed while writing
//   "garbage"       answers with something that isn't the JSON asked for
//   "device"        puts the device it runs on in its title
//   "project"       answers a title that opens with the project "shopdeck", for a test of its removal
//   "verbose"       answers a title that breaks the title rules (a verb phrase), which the check still takes
//   "junk"          answers a title of symbols only, as a broken backend does under the grammar
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
  console.error(
    /said:(\S+)/.exec(behaviour)?.[1] ?? `ggml_vulkan: failed to allocate buffer on ${device}`,
  )
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
  if (mode.includes("seen")) appendFileSync(`${argument("-m")}.seen`, "\n")
  if (mode.includes("crash")) {
    console.error("GGML_ASSERT: out of memory")
    process.exit(3)
  }
  if (mode.includes("hang")) await new Promise(() => {})
  if (mode.includes("truncate")) {
    response.end('{"choices":[{"message":{"content":"{\\"tit')
    return
  }
  if (mode.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 500))
  if (mode.includes("overflow")) {
    response.statusCode = 400
    response.end(
      JSON.stringify({
        error: {
          code: 400,
          message:
            "request (5000 tokens) exceeds the available context size (4096 tokens), try increasing it",
          type: "exceed_context_size_error",
          n_prompt_tokens: 5000,
          n_ctx: 4096,
        },
      }),
    )
    return
  }
  completions += 1
  if (mode.includes("log"))
    appendFileSync(`${argument("-m")}.requests`, `${JSON.stringify(asked)}\n`)
  const text = (label, copied) =>
    mode.includes("copy")
      ? copied
      : mode.includes("device")
        ? `${label} on ${device}`
        : `${label} ${completions}`
  const answer = {
    title: mode.includes("project")
      ? "Shopdeck login redirect"
      : mode.includes("junk")
        ? "!!!!!!!!"
        : mode.includes("verbose")
          ? "Add retries with backoff to the payment client"
          : text("Fake title", "Webhook key rotation"),
  }
  const content = mode.includes("garbage")
    ? "Sure! Here is a title for your terminal."
    : JSON.stringify(answer)
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
