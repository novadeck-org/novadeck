// Probe-only stdio MCP server: a channel with permission relay, and a tool that elicits.
import { appendFileSync, existsSync, readFileSync, renameSync } from "node:fs"
import { createInterface } from "node:readline"
const dir = process.env.PROBE_DIR
const log = (x) =>
  appendFileSync(`${dir}/mcp.jsonl`, JSON.stringify({ t: Date.now(), ...x }) + "\n")
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n")
let nextId = 1000
const pending = new Map()
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line)
  log({ in: m })
  if (m.id !== undefined && m.method === undefined) return pending.get(m.id)?.(m)
  if (m.method === "initialize")
    return send({
      id: m.id,
      result: {
        protocolVersion: m.params.protocolVersion,
        serverInfo: { name: "probe", version: "0.0.1" },
        capabilities: {
          tools: {},
          experimental: {
            "claude/channel": {},
            "claude/channel/permission": {},
          },
        },
      },
    })
  if (m.method === "tools/list")
    return send({
      id: m.id,
      result: {
        tools: [
          {
            name: "elicit",
            description: "Asks the person for a name",
            inputSchema: { type: "object", properties: {} },
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
  if (m.method === "tools/call") {
    const id = nextId++
    pending.set(id, (r) =>
      send({
        id: m.id,
        result: {
          content: [
            {
              type: "text",
              text: "elicitation result: " + JSON.stringify(r.result ?? r.error),
            },
          ],
        },
      }),
    )
    return send({
      id,
      method: "elicitation/create",
      params:
        m.params?.name === "form"
          ? {
              message: m.params.arguments.message,
              requestedSchema: m.params.arguments.schema,
            }
          : {
              message: "What is your name?",
              requestedSchema: {
                type: "object",
                properties: { name: { type: "string", title: "Name" } },
                required: ["name"],
              },
            },
    })
  }
  if (m.method === "notifications/claude/channel/permission_request") {
    // Answer from a file the test writes: verdict.<request_id> or verdict.any
    const id = m.params.request_id
    const t = setInterval(() => {
      for (const f of [`${dir}/verdict.${id}`, `${dir}/verdict.any`])
        if (existsSync(f)) {
          const behavior = readFileSync(f, "utf8").trim()
          renameSync(f, f + ".done")
          clearInterval(t)
          log({ out: "verdict", behavior, id })
          send({
            method: "notifications/claude/channel/permission",
            params: { request_id: id, behavior },
          })
          return
        }
    }, 100)
  }
  if (m.id !== undefined && m.method === "ping") send({ id: m.id, result: {} })
})
