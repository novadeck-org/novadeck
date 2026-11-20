// Probe-only stdio MCP server whose `form` tool asks the person to fill the form it is given
// (an elicitation) and answers with what came back. Requests it doesn't know get "Method not
// found", as a client trying a newer handshake first (Antigravity's `server/discover`) needs
// before it falls back to `initialize`. Logs every message to `$PROBE_DIR/mcp.jsonl`.
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const dir = process.env.PROBE_DIR
const log = (x) =>
  appendFileSync(`${dir}/mcp.jsonl`, JSON.stringify({ t: Date.now(), ...x }) + "\n")
const send = (m) => {
  log({ out: m })
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n")
}
let nextId = 1000
const pending = new Map()
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line)
  log({ in: m })
  if (m.id !== undefined && m.method === undefined) return pending.get(m.id)?.(m)
  if (m.method === undefined || m.id === undefined) return undefined
  if (m.method === "initialize")
    return send({
      id: m.id,
      result: {
        protocolVersion: m.params.protocolVersion,
        serverInfo: { name: "probe", version: "0.0.1" },
        capabilities: { tools: {} },
      },
    })
  if (m.method === "ping") return send({ id: m.id, result: {} })
  if (m.method === "tools/list")
    return send({
      id: m.id,
      result: {
        tools: [
          {
            name: "create_pull_request_review_comment",
            description: "Comments on a pull request; it asks nothing of the person",
            inputSchema: { type: "object", properties: { body: { type: "string" } } },
          },
          {
            name: "form",
            description: "Asks the person to fill the form it is given",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" }, schema: { type: "object" } },
            },
          },
        ],
      },
    })
  if (m.method === "tools/call" && m.params?.name !== "form")
    return send({ id: m.id, result: { content: [{ type: "text", text: "commented" }] } })
  if (m.method === "tools/call") {
    const id = nextId++
    let args = m.params?.arguments ?? {}
    if (typeof args === "string") args = JSON.parse(args)
    pending.set(id, (r) =>
      send({
        id: m.id,
        result: {
          content: [
            { type: "text", text: "elicitation result: " + JSON.stringify(r.result ?? r.error) },
          ],
        },
      }),
    )
    return send({
      id,
      method: "elicitation/create",
      params: { mode: "form", message: args.message, requestedSchema: args.schema },
    })
  }
  return send({ id: m.id, error: { code: -32601, message: "Method not found" } })
})
