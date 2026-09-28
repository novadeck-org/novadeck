import { once } from "node:events"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { MessageChannel, Worker } from "node:worker_threads"

import { connectRunner, messagePort } from "@novadeck/protocol/client"

import { databaseArgumentPrefix } from "../bridge"
import { context, describe, expect, it } from "../test"

const entry = pathToFileURL(join(process.cwd(), "out", "main", "runner.js")).href

// Stands in for Electron's utility process: `process.parentPort` relays worker messages.
const utility = `
const { parentPort, workerData } = require("node:worker_threads")
process.parentPort = {
  on: (_type, listener) => parentPort.on("message", ({ data, ports }) => listener({ data, ports })),
}
import(workerData.entry)
`

const start = (database: string) => {
  const worker = new Worker(utility, {
    eval: true,
    argv: [`${databaseArgumentPrefix}${database}`],
    workerData: { entry },
  })
  const connect = async () => {
    const { port1, port2 } = new MessageChannel()
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- A Node worker, not a window.
    worker.postMessage({ data: { type: "connect" }, ports: [port1] }, [port1])
    return connectRunner(messagePort(port2), { timeout: 10_000 })
  }
  const persist = () =>
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- A Node worker, not a window.
    worker.postMessage({ data: { type: "persist" }, ports: [] })
  const close = async () => {
    const exited = once(worker, "exit")
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- A Node worker, not a window.
    worker.postMessage({ data: { type: "close" }, ports: [] })
    await exited
  }
  return { worker, connect, persist, close }
}

describe("compiled desktop runner", () => {
  context("in a utility process given a port by the host", () => {
    it("serves shells and stores metadata in the given database", async () => {
      const directory = await mkdtemp(join(tmpdir(), "novadeck-host-runner-"))
      const database = join(directory, "workspace.sqlite")
      const runner = start(database)
      try {
        const client = await runner.connect()
        const project = await client.projects.create({
          id: crypto.randomUUID(),
          name: "Desktop",
          cwd: directory,
        })
        const session = await client.sessions.create({
          id: crypto.randomUUID(),
          projectId: project.id,
          name: "Shell",
        })
        const created = await client.terminals.create({
          id: crypto.randomUUID(),
          sessionId: session.id,
          cols: 80,
          rows: 24,
        })
        const terminal = await client.terminals.attach(created.id)
        let text = ""
        const reading = (async () => {
          for await (const event of terminal) {
            if (event.type === "snapshot") text = event.data
            if (event.type === "output") text += event.data
            if (text.includes("DESKTOP_42")) return
          }
        })()
        // The typed echo differs from the output, so only the shell's answer matches.
        await terminal.write(
          process.platform === "win32" ? "echo DESKTOP_4^2\r" : 'echo DESKTOP_4""2\r',
        )
        await reading
        // Asked to before the system session ends, it saves the terminal's screen.
        runner.persist()
        const saved = new DatabaseSync(database, { readOnly: true })
        try {
          await expect
            .poll(
              () =>
                (
                  saved.prepare("SELECT transcript FROM terminals WHERE id = ?").get(created.id) as
                    | { transcript: string | null }
                    | undefined
                )?.transcript ?? "",
            )
            .toContain("DESKTOP_42")
        } finally {
          saved.close()
        }
        await client.close()
        expect((await stat(database)).isFile()).toBe(true)
        // Its shell integration, and the plugins agents install from, live beside the
        // database, in the app's own directory.
        expect((await readdir(join(directory, "shell", "plugins"))).toSorted()).toEqual([
          "agy",
          "claude",
          "codex",
        ])
      } finally {
        await runner.close()
        await rm(directory, { recursive: true, force: true })
      }
    }, 20_000)

    it("has no terminal limit, unlike a standalone runner", async () => {
      const directory = await mkdtemp(join(tmpdir(), "novadeck-host-runner-"))
      const runner = start(join(directory, "workspace.sqlite"))
      try {
        const client = await runner.connect()
        const project = await client.projects.create({
          id: crypto.randomUUID(),
          name: "Many",
          cwd: directory,
        })
        const session = await client.sessions.create({
          id: crypto.randomUUID(),
          projectId: project.id,
          name: "Many",
        })
        // All at once: the desktop MessagePort connection allows 1,024 calls in flight.
        const created = await Promise.all(
          Array.from({ length: 33 }, () =>
            client.terminals.create({
              id: crypto.randomUUID(),
              sessionId: session.id,
              cols: 80,
              rows: 24,
            }),
          ),
        )
        expect(created.filter((terminal) => terminal.exit === null)).toHaveLength(33)
        await client.close()
      } finally {
        await runner.close()
        await rm(directory, { recursive: true, force: true })
      }
    }, 20_000)

    it("keeps metadata when the host starts a new runner", async () => {
      const directory = await mkdtemp(join(tmpdir(), "novadeck-host-runner-"))
      const database = join(directory, "workspace.sqlite")
      try {
        const first = start(database)
        const client = await first.connect()
        await client.projects.create({ id: crypto.randomUUID(), name: "Persisted", cwd: directory })
        await client.close()
        await first.close()

        const second = start(database)
        const again = await second.connect()
        await expect(again.projects.list()).resolves.toEqual([
          expect.objectContaining({ name: "Persisted" }),
        ])
        await again.close()
        await second.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }, 20_000)
  })
})
