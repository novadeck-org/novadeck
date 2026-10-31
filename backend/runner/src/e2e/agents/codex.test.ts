import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"

import { beforeEach, describe, expect, it, vi } from "vitest"

import { appServer } from "./codex.js"

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn<() => ReturnType<typeof child>>() }))
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}))

const child = () =>
  Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn<() => void>(),
    pid: undefined,
  })

beforeEach(() => spawn.mockReset())

describe("Codex's fixture app-server", () => {
  it("accepts a fragmented CRLF initialize response before notifying initialized", async () => {
    const process = child()
    spawn.mockReturnValue(process)
    const writes: string[] = []
    process.stdin.on("data", (chunk) => writes.push(String(chunk)))
    const server = appServer({ HOME: "/sandbox" }, 100)
    const starting = server.start()
    process.stdout.write('{"id":1,"res')
    process.stdout.write('ult":{}}\r\n')
    await starting
    expect(writes.join("")).toContain('"method":"initialized"')
    server.close()
  })

  it("fails immediately when stdin cannot accept initialize", async () => {
    const process = child()
    spawn.mockReturnValue(process)
    const server = appServer({ HOME: "/sandbox" }, 60_000)
    const starting = server.start()
    process.stdin.emit("error", new Error("write EPIPE"))
    await expect(starting).rejects.toThrow("app-server stdin failed: write EPIPE")
    server.close()
  })

  it("retains stderr, mismatched ids and partial stdout at the original deadline", async () => {
    const process = child()
    spawn.mockReturnValue(process)
    const server = appServer({ HOME: "/sandbox" }, 20)
    const starting = server.start()
    process.emit("spawn")
    process.stderr.write("startup failure")
    process.stdout.write('{"id":"1","result":{}}\n{"id":1')
    await expect(starting).rejects.toThrow(
      /didn't answer initialize in 20 ms[\s\S]*request 1 initialize[\s\S]*unmatched message id "1"[\s\S]*stderr: startup failure[\s\S]*partial stdout: \{"id":1/,
    )
    server.close()
  })

  it("tells the machine's processes and Codex's files and logs at the deadline", async () => {
    const home = await mkdtemp(join(tmpdir(), "novadeck-codex-scene-"))
    try {
      await mkdir(join(home, "log"))
      await writeFile(join(home, "log", "codex-tui.log"), `${"x".repeat(3000)}last words\n`)
      await writeFile(join(home, "state.sqlite"), "")
      const process = child()
      spawn.mockReturnValue(process)
      const server = appServer({ HOME: home, CODEX_HOME: home }, 20)
      const failed = server.start().catch((error: unknown) => String(error))
      const told = await failed
      expect(told).toMatch(/didn't answer initialize in 20 ms/)
      expect(told).toMatch(/processes:\n/)
      expect(told).toMatch(/CODEX_HOME:\n2 files/)
      expect(told).toMatch(/state\.sqlite 0 B, changed [+-]?\d+ ms/)
      expect(told).toMatch(/tail of log[\\/]codex-tui\.log:\nx*last words/)
      expect(told).not.toContain("x".repeat(1600))
      server.close()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it("keeps a complete answer sent just before process close", async () => {
    const process = child()
    spawn.mockReturnValue(process)
    const server = appServer({ HOME: "/sandbox" }, 100)
    const request = server.request("hooks/list", {})
    process.stdout.write('{"id":1,"result":{"data":[]}}\n')
    process.emit("close", 0, null)
    await expect(request).resolves.toEqual({ data: [] })
    server.close()
  })
})
