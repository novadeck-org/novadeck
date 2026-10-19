// A stdio MCP server for the answers' scenarios: its `elicit` tool asks the person to fill
// a form (an elicitation) and answers with what it got back, as text the model reads.
import { createInterface } from "node:readline"

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
let next = 1000
const pending = new Map()

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.id !== undefined && message.method === undefined)
    return pending.get(message.id)?.(message)
  if (message.method === "initialize")
    return send({
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        serverInfo: { name: "elicit", version: "0.0.1" },
        capabilities: { tools: {} },
      },
    })
  if (message.method === "tools/list")
    return send({
      id: message.id,
      result: {
        tools: [
          {
            name: "elicit",
            description: "Asks the person to fill in a form",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    })
  if (message.method === "tools/call") {
    const id = next++
    pending.set(id, (reply) =>
      send({
        id: message.id,
        result: {
          content: [
            { type: "text", text: "elicited: " + JSON.stringify(reply.result ?? reply.error) },
          ],
        },
      }),
    )
    return send({
      id,
      method: "elicitation/create",
      params: {
        message: "Tell us about yourself",
        requestedSchema: {
          type: "object",
          properties: {
            name: { type: "string", title: "Name" },
            age: { type: "number", title: "Age" },
            subscribe: { type: "boolean", title: "Subscribe" },
            color: { type: "string", title: "Color", enum: ["Red", "Green"] },
          },
          required: ["name"],
        },
      },
    })
  }
  if (message.id !== undefined && message.method === "ping") send({ id: message.id, result: {} })
})
