import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { PassThrough } from "node:stream"

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import { forgetTrust, hooksTrusted } from "./trust.js"

type Child = EventEmitter & {
  pid: number | undefined
  exitCode: number | null
  signalCode: string | null
  stdin: PassThrough
  stdout: PassThrough
  kill: Mock<() => void>
}
const transport = vi.hoisted(() => ({
  spawn: vi.fn<() => Child>(),
  execFile:
    vi.fn<
      (
        file: string,
        args: string[],
        options: { windowsHide: boolean; timeout: number },
        callback: () => void,
      ) => void
    >(),
}))
vi.mock("node:child_process", () => transport)

const listed = {
  data: [
    {
      hooks: ["sessionStart", "userPromptSubmit", "stop"].map((eventName) => ({
        pluginId: "novadeck@novadeck",
        eventName,
        trustStatus: "trusted",
      })),
    },
  ],
}

const where: Parameters<typeof hooksTrusted>[0] = {
  home: tmpdir(),
  env: {},
  platform: "win32",
  plugin: "",
}

describe("ending Codex's trust helper", () => {
  let child: Child
  let spawned: Promise<void>
  let cleaned: () => void

  beforeEach(() => {
    forgetTrust()
    transport.spawn.mockReset()
    transport.execFile.mockReset()
    child = Object.assign(new EventEmitter(), {
      pid: 42 as number | undefined,
      exitCode: null as number | null,
      signalCode: null as string | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn<() => void>(),
    })
    spawned = new Promise<void>((resolve) =>
      transport.spawn.mockImplementation(() => {
        resolve()
        return child
      }),
    )
    transport.execFile.mockImplementation((_file, _args, _options, callback) => {
      cleaned = callback
    })
  })

  afterEach(() => {
    child.stdin.destroy()
    child.stdout.destroy()
  })

  it("ends the Windows wrapper's tree before returning its answer, despite later close and error events", async () => {
    const check = hooksTrusted(where, "/work")
    await spawned
    child.stdout.write(`${JSON.stringify({ id: 2, result: listed })}\n`)
    expect(transport.execFile).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "42", "/T", "/F"],
      { windowsHide: true, timeout: 3_000 },
      expect.any(Function),
    )
    let returned = false
    void check.then(() => {
      returned = true
    })
    child.emit("close", 1, null)
    child.emit("error", new Error("late transport error"))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(returned).toBe(false)
    expect(transport.execFile).toHaveBeenCalledTimes(1)
    cleaned()
    expect(await check).toBe(true)
    expect(child.stdin.destroyed).toBe(true)
    expect(child.stdout.destroyed).toBe(true)
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  for (const ended of ["not-started", "exited", "signalled"] as const)
    it(`does not kill a Windows PID whose wrapper is ${ended}`, async () => {
      if (ended === "not-started") child.pid = undefined
      else if (ended === "exited") child.exitCode = 1
      else child.signalCode = "SIGTERM"
      const check = hooksTrusted(where, "/work")
      await spawned
      child.emit("close", 1, null)
      expect(await check).toBeUndefined()
      expect(transport.execFile).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
    })
})
