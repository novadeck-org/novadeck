import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { installRelay, installShellFiles } from "./install.js"

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
