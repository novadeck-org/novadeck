import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { cmdPrints, installRelay, installShellFiles } from "./install.js"

const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" })

// A folder's files in memory, with renames that fail as `failing` says.
const memory = (
  initial: { readonly [path: string]: string },
  failing: (from: string, to: string, attempt: number) => string | undefined,
) => {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, text]) => [path, Buffer.from(text)]),
  )
  let attempts = 0
  return {
    files,
    ops: {
      readFile: async (path: string) => files.get(path) ?? Promise.reject(missing()),
      readdir: async () => [...files.keys()].map((path) => path.split("/").at(-1)!),
      rm: async (path: string) => void files.delete(path),
      chmod: async () => {},
      writeFile: async (path: string, data: Uint8Array) => void files.set(path, data),
      rename: async (from: string, to: string) => {
        const code = failing(from, to, (attempts += 1))
        if (code) throw Object.assign(new Error(code), { code })
        const data = files.get(from)
        if (!data) throw missing()
        files.delete(from)
        files.set(to, data)
      },
    },
  }
}

// A stand-in for cmd, as an AutoRun of `chcp 65001` without `>nul` makes it, and not.
const node = (script: string) => ({ program: process.execPath, args: ["-e", script] })

describe("whether cmd prints of its own before a command", () => {
  it("is any output at all, a line break included", async () => {
    await expect(cmdPrints(node("process.stdout.write('Active code page: 65001.')"))).resolves.toBe(
      "prints",
    )
    await expect(cmdPrints(node("process.stdout.write('\\r\\n')"))).resolves.toBe("prints")
    await expect(cmdPrints(node(""))).resolves.toBeUndefined()
  })

  it("is nothing for a cmd that doesn't start, as it runs no hook either", async () => {
    await expect(cmdPrints({ program: join(tmpdir(), "no-such-cmd.exe") })).resolves.toBeUndefined()
  })

  it("fails safe: a cmd that failed after printing prints, and one that ran too long may", async () => {
    // As `chcp 65001 & cd /d D:\gone`: output, then an error level `rem` leaves.
    await expect(
      cmdPrints(node("process.stdout.write('Active code page: 65001.'); process.exit(1)")),
    ).resolves.toBe("prints")
    // An error level with nothing printed leaves the hook's answer alone.
    await expect(cmdPrints(node("process.exit(1)"))).resolves.toBeUndefined()
    // A slow AutoRun may print anything, after the probe gave up on it.
    await expect(
      cmdPrints({ ...node("setTimeout(() => {}, 10_000)"), timeoutMs: 200 }),
    ).resolves.toBe("slow")
  })

  it("answers by its time, safely, though something cmd started holds its output open", async () => {
    // As an AutoRun that starts a background program: cmd exits, its output stays open,
    // and what it printed can't be known read whole, so it may print.
    const began = Date.now()
    const answer = await cmdPrints({
      ...node(
        "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: true, windowsHide: true }).unref()",
      ),
      timeoutMs: 500,
    })
    expect(answer).toBe("slow")
    expect(Date.now() - began).toBeLessThan(4_000)
  })

  it("keeps the runner's own variables from the person's AutoRun", async ({ resources }) => {
    const before = process.env.NOVADECK_TOKEN
    resources.defer(() => {
      if (before === undefined) delete process.env.NOVADECK_TOKEN
      else process.env.NOVADECK_TOKEN = before
    })
    process.env.NOVADECK_TOKEN = "secret"
    await expect(
      cmdPrints(node("if (process.env.NOVADECK_TOKEN) process.stdout.write('leaked')")),
    ).resolves.toBeUndefined()
  })

  it.runIf(process.platform === "win32")(
    "is no for this machine's cmd, which has no AutoRun",
    async () => {
      await expect(cmdPrints()).resolves.toBeUndefined()
    },
  )
})

describe("installing the relay", () => {
  it("puts the running copy back on Windows when the new one can't take its place", async () => {
    const { files, ops } = memory(
      { "/app/relay": "new", "/data/novadeck-relay.exe": "running" },
      (from) => (from.endsWith(".tmp") ? "EPERM" : undefined),
    )
    await expect(
      installRelay("/app/relay", "/data/novadeck-relay.exe", { platform: "win32", files: ops }),
    ).rejects.toThrow("EPERM")
    expect(Buffer.from(files.get("/data/novadeck-relay.exe") ?? []).toString()).toBe("running")
    expect([...files.keys()].toSorted()).toEqual(["/app/relay", "/data/novadeck-relay.exe"])
  })

  it("tries again while Windows holds the new copy for a moment", async () => {
    const { files, ops } = memory(
      { "/app/relay": "new", "/data/novadeck-relay.exe": "running" },
      (from, _to, attempt) => (from.endsWith(".tmp") && attempt < 4 ? "EBUSY" : undefined),
    )
    await installRelay("/app/relay", "/data/novadeck-relay.exe", { platform: "win32", files: ops })
    expect(Buffer.from(files.get("/data/novadeck-relay.exe") ?? []).toString()).toBe("new")
    // The running copy waits aside until nothing runs it.
    expect([...files.keys()].filter((path) => path.includes(".old-"))).toHaveLength(1)
  })

  it("copies the relay in once, and leaves an unchanged copy alone", async ({ resources }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-relay-install-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const relay = join(folder, "built")
    const path = join(folder, "novadeck-relay")
    writeFileSync(relay, "relay")
    await installRelay(relay, path)
    const first = statSync(path)
    await installRelay(relay, path)
    expect(readFileSync(path, "utf8")).toBe("relay")
    expect(statSync(path).ino).toBe(first.ino)
  })
})

// Windows' plugins start the relay itself, so NOVADECK_MCP is never set there.
describe.skipIf(process.platform === "win32")("the MCP server's launcher", () => {
  it("is named once the relay it starts is installed", async ({ resources }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-mcp-launcher-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const relay = join(folder, "built")
    writeFileSync(relay, "relay")
    const paths = await installShellFiles(join(folder, "shell"), { relay })
    expect(paths.mcpLauncher).toBe(paths.mcp)
    expect(statSync(paths.relay).mode & 0o100).not.toBe(0)
  })

  it("reports a narrowed terminal a previous runner left, before it deletes the settings", async ({
    resources,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-narrowed-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const relay = join(folder, "built")
    writeFileSync(relay, "relay")
    const first = await installShellFiles(join(folder, "shell"), { relay })
    expect(first.narrowedBefore).toBe(false)
    mkdirSync(first.narrow, { recursive: true })
    writeFileSync(join(first.narrow, "7.json"), "{}")
    const second = await installShellFiles(join(folder, "shell"), { relay })
    expect(second.narrowedBefore).toBe(true)
    expect(existsSync(second.narrow)).toBe(false)
    expect((await installShellFiles(join(folder, "shell"), { relay })).narrowedBefore).toBe(false)
  })

  it("leaves the relay as it is under a narrowed terminal a previous runner left, and replaces it after", async ({
    resources,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-narrowed-relay-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const relay = join(folder, "built")
    writeFileSync(relay, "relay one")
    const first = await installShellFiles(join(folder, "shell"), { relay })
    mkdirSync(first.narrow, { recursive: true })
    writeFileSync(join(first.narrow, "7.json"), "{}")
    writeFileSync(relay, "relay two")
    const held = await installShellFiles(join(folder, "shell"), { relay })
    expect(held.narrowedBefore).toBe(true)
    expect(readFileSync(held.relay, "utf8")).toBe("relay one")
    expect(held.mcpLauncher).toBe(held.mcp)
    await installShellFiles(join(folder, "shell"), { relay })
    expect(readFileSync(held.relay, "utf8")).toBe("relay two")
  })

  it("installs a held relay that isn't there yet", async ({ resources }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-held-relay-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const relay = join(folder, "built")
    const path = join(folder, "installed")
    writeFileSync(relay, "relay")
    await installRelay(relay, path, { held: true })
    expect(readFileSync(path, "utf8")).toBe("relay")
  })

  it("is left out when the relay can't be installed, so plugins start the connecting build's", async ({
    resources,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-mcp-launcher-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    resources.defer(() => logged.mockRestore())
    const paths = await installShellFiles(join(folder, "shell"), { relay: join(folder, "gone") })
    expect(paths.mcpLauncher).toBeUndefined()
    expect(logged).toHaveBeenCalledWith("Novadeck's relay is unavailable:", expect.anything())
  })
})
