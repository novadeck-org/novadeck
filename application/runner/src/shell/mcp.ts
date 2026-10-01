/**
 * NovaDeck's MCP server, run by a connected agent's plugin through the launcher on
 * NovaDeck's own runtime, so it needs no dependencies. It speaks MCP over stdio, one
 * JSON message per line, just enough for one tool: `show`, which puts an image or a text
 * file from the project in front of the user, beside the terminal the agent runs in. It
 * forwards the call to that terminal's runner over the endpoint the agent's hooks
 * report to, with the terminal's own token, and returns the runner's answer. Outside
 * NovaDeck's terminals it offers no tools, so agents there aren't pointed at it.
 */
import { plugin } from "../harnesses/harness.js"

/** The MCP versions NovaDeck's server speaks, newest first; it answers others with the newest. */
export const mcpVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

export const mcpScript = `// NovaDeck MCP server. Written by NovaDeck into its own data directory, and
// overwritten on each start. Only agents started from NovaDeck's terminals get its tool.
import { connect } from "node:net"

const env = process.env
const terminalId = env.NOVADECK_TERMINAL_ID
const endpoint = env.NOVADECK_REPORT
const token = env.NOVADECK_REPORT_TOKEN
const inTerminal = Boolean(terminalId && endpoint && token)

const tool = {
  name: "show",
  description:
    "Show the user an image or a text file from this project, or a web page, in NovaDeck, " +
    "beside the terminal they're talking to you in. Give either path or url. Use it when they " +
    "ask to see something, or when a screenshot, mockup, diagram, the lines you mean or the " +
    "running app (as a local dev server's address) would help them follow. Set open to true " +
    "only when they asked to see it; otherwise it waits for them in NovaDeck, marked new.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "The file: an image (PNG, JPEG, GIF, WebP, SVG) or a text file, absolute or relative " +
          "to the terminal's current directory. It must be inside this project.",
      },
      url: {
        type: "string",
        description:
          "Instead of path: a web page's http or https address, such as http://localhost:5173/, " +
          "which NovaDeck opens live in its browser view.",
      },
      lines: {
        type: "object",
        description: "For a text file, the lines to point at.",
        properties: {
          from: { type: "integer", minimum: 1 },
          to: { type: "integer", minimum: 1 },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
      title: { type: "string", description: "A short name to show instead of the file's." },
      open: {
        type: "boolean",
        description: "True only when the user asked to see it: it opens at once.",
      },
    },
    additionalProperties: false,
  },
}

// The MCP versions this server speaks, newest first; it answers others with the newest.
const versions = ${JSON.stringify(mcpVersions)}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n")

// One call to the terminal's runner, answered with one line; it gives up within 10 s.
const present = (request) =>
  new Promise((resolve) => {
    let text = ""
    let settled = false
    const socket = connect(endpoint)
    const done = (answer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(answer)
    }
    const timer = setTimeout(() => done({ ok: false, reason: "NovaDeck didn't answer." }), 10_000)
    socket.setEncoding("utf8")
    socket.on("connect", () =>
      socket.write(JSON.stringify({ type: "present", terminalId, token, request }) + "\\n"),
    )
    socket.on("data", (chunk) => {
      text += chunk
      const end = text.indexOf("\\n")
      if (end < 0) return
      try {
        done(JSON.parse(text.slice(0, end)))
      } catch {
        done({ ok: false, reason: "NovaDeck's answer was unreadable." })
      }
    })
    socket.on("error", () => done({ ok: false, reason: "NovaDeck isn't reachable." }))
    socket.on("close", () => done({ ok: false, reason: "NovaDeck didn't answer." }))
  })

// Only what the tool takes goes on; the runner checks it all again.
const requestOf = (args) => {
  const input = typeof args === "object" && args !== null ? args : {}
  return {
    ...(input.path !== undefined && { path: input.path }),
    ...(input.url !== undefined && { url: input.url }),
    ...(input.lines !== undefined && { lines: input.lines }),
    ...(input.title !== undefined && { title: input.title }),
    ...(input.open !== undefined && { open: input.open }),
  }
}

const call = async (id, params) => {
  if (!inTerminal || params?.name !== tool.name) {
    send({ id, error: { code: -32602, message: "Unknown tool: " + params?.name } })
    return
  }
  const request = requestOf(params.arguments)
  const answer = await present(request)
  const text = answer?.ok
    ? request.open
      ? "Showing " + answer.name + " to the user in NovaDeck."
      : answer.name + " is waiting for the user in NovaDeck, marked new."
    : answer?.reason || "NovaDeck couldn't show it."
  send({ id, result: { content: [{ type: "text", text }], isError: !answer?.ok } })
}

const handle = (message) => {
  // One request per line: a batch, or anything but an object, is refused.
  if (typeof message !== "object" || message === null || Array.isArray(message))
    return send({ id: null, error: { code: -32600, message: "Invalid Request" } })
  const { id, method, params } = message
  // Notifications, such as notifications/initialized, need no answer; nor do answers,
  // since this server asks nothing.
  if (id === undefined || id === null || typeof method !== "string") return
  if (method === "initialize")
    return send({
      id,
      result: {
        protocolVersion: versions.includes(params?.protocolVersion)
          ? params.protocolVersion
          : versions[0],
        capabilities: { tools: {} },
        serverInfo: { name: "novadeck", version: "${plugin.version}" },
      },
    })
  if (method === "ping") return send({ id, result: {} })
  if (method === "tools/list") return send({ id, result: { tools: inTerminal ? [tool] : [] } })
  if (method === "tools/call") return void call(id, params)
  send({ id, error: { code: -32601, message: "Method not found: " + method } })
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      send({ id: null, error: { code: -32700, message: "Parse error" } })
      continue
    }
    handle(message)
  }
})
// No exit when the agent closes its side: calls under way still answer, then the server
// ends by itself.
`
