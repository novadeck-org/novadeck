// Launches the unpacked packaged app and runs a real shell through its bundled runner.
// Usage (after `pnpm run package:<target>`): node scripts/smoke.mjs
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import * as esbuild from "esbuild"
import { _electron } from "playwright"

const host = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const release = join(host, "release")

const fail = (message) => {
  console.error(`::error::${message}`)
  process.exit(1)
}

const packaged = () => {
  if (process.platform === "win32") {
    const root = join(release, "win-unpacked")
    return { executable: join(root, "novadeck.exe"), resources: join(root, "resources") }
  }
  if (process.platform === "darwin") {
    const folder = readdirSync(release).find((name) => name.startsWith("mac"))
    const bundle =
      folder && readdirSync(join(release, folder)).find((name) => name.endsWith(".app"))
    if (!folder || !bundle) fail("No unpacked macOS app bundle was found.")
    const root = join(release, folder, bundle, "Contents")
    return { executable: join(root, "MacOS", "novadeck"), resources: join(root, "Resources") }
  }
  const root = join(release, "linux-unpacked")
  return { executable: join(root, "novadeck"), resources: join(root, "resources") }
}

const { executable, resources } = packaged()
if (!existsSync(executable)) fail(`The packaged executable is missing: ${executable}`)

// A compiled build/Release binary would shadow the prebuilds, which carry the bundled
// ConPTY files. node-pty's Windows install script also copies those files into
// build/Release/conpty; without a compiled .node beside them, that folder is inert.
const pty = join(resources, "app.asar.unpacked", "node_modules", "node-pty")
const build = join(pty, "build")
const compiled = existsSync(build)
  ? readdirSync(build, { recursive: true }).filter((file) => String(file).endsWith(".node"))
  : []
if (compiled.length > 0) fail(`node-pty was rebuilt from source: ${compiled.join(", ")}`)
if (process.platform === "win32") {
  for (const file of ["conpty.dll", "OpenConsole.exe"]) {
    const path = join(pty, "prebuilds", `win32-${process.arch}`, "conpty", file)
    if (!existsSync(path)) fail(`The bundled ConPTY file is missing: ${path}`)
  }
}

// The relay agents start for NovaDeck's MCP server and hooks ships beside the UI, and answers the
// handshake by itself outside NovaDeck's terminals.
const relay = join(
  resources,
  "relay",
  `novadeck-relay${process.platform === "win32" ? ".exe" : ""}`,
)
if (!existsSync(relay)) fail(`The relay is missing: ${relay}`)
try {
  const hello = execFileSync(relay, ["mcp", "0.0.0", "2025-06-18"], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    // Outside a NovaDeck terminal, even when the smoke test runs in one.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("NOVADECK_")),
    ),
    timeout: 10_000,
  })
  const answer = JSON.parse(hello.toString())
  if (answer?.result?.protocolVersion !== "2025-06-18") throw new Error(hello.toString())
  // A hook outside NovaDeck still gives Antigravity the answer that lets its tools run,
  // as the runner's relay.json names it.
  const config = join(mkdtempSync(join(tmpdir(), "novadeck-smoke-relay-")), "relay.json")
  writeFileSync(
    config,
    JSON.stringify({ fallbacks: { agy: { PreToolUse: '{"decision":"ask"}', "*": "{}" } } }),
  )
  const hook = execFileSync(relay, ["hook", "--config", config, "agy", "PreToolUse"], {
    input: "{}",
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("NOVADECK_")),
    ),
    timeout: 10_000,
  })
  if (hook.toString() !== '{"decision":"ask"}\n') throw new Error(`hook: ${hook}`)
  // It names its build, in the protocol the runner speaks.
  const version = execFileSync(relay, ["--version"], { timeout: 10_000 }).toString()
  if (!/^novadeck-relay \S+ \(protocol 2\)/.test(version)) {
    throw new Error(`version: ${version}`)
  }
} catch (error) {
  fail(`The relay didn't answer as an MCP server and hook: ${error}`)
}

const bundle = await esbuild.build({
  entryPoints: [join(host, "..", "protocol", "dist", "client.js")],
  bundle: true,
  format: "iife",
  globalName: "NovaDeck",
  platform: "browser",
  write: false,
})
const client = `${bundle.outputFiles[0].text};globalThis.NovaDeck = NovaDeck`

const userData = mkdtempSync(join(tmpdir(), "novadeck-smoke-data-"))
const work = mkdtempSync(join(tmpdir(), "novadeck-smoke-work-"))
const app = await _electron.launch({
  executablePath: executable,
  // Hosted Linux runners forbid the unprivileged namespaces Chromium's sandbox needs.
  args: [`--user-data-dir=${userData}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
  timeout: 60_000,
})
try {
  const page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  await page.evaluate(client)
  // The typed echo differs from the output, so only the shell's answer matches.
  const input = process.platform === "win32" ? "echo NOVADECK_4^2\r" : 'echo NOVADECK_4""2\r'
  const result = await page.evaluate(
    async ({ cwd, typed }) => {
      const { connectRunner, desktop } = globalThis.NovaDeck
      const runner = await connectRunner(desktop())
      globalThis.smoke = runner
      const project = await runner.projects.create({ id: crypto.randomUUID(), name: "Smoke", cwd })
      const session = await runner.sessions.create({
        id: crypto.randomUUID(),
        projectId: project.id,
        name: "Smoke",
      })
      const created = await runner.terminals.create({
        id: crypto.randomUUID(),
        sessionId: session.id,
        cols: 80,
        rows: 24,
      })
      const terminal = await runner.terminals.attach(created.id)
      globalThis.smokeTerminal = terminal
      let text = ""
      const reading = (async () => {
        for await (const event of terminal) {
          if (event.type === "snapshot") text = event.data
          if (event.type === "output") text += event.data
          if (text.includes("NOVADECK_42")) return true
        }
        return false
      })()
      await terminal.write(typed)
      const timeout = new Promise((settle) => setTimeout(() => settle(false), 20_000))
      return { answered: await Promise.race([reading, timeout]), tail: text.slice(-400) }
    },
    { cwd: work, typed: input },
  )
  if (!result.answered) fail(`The packaged shell did not answer: ${JSON.stringify(result.tail)}`)
  console.log("A shell in the packaged app answered through the runner.")

  if (process.platform === "win32") {
    const tasks = execFileSync("tasklist", ["/FI", "IMAGENAME eq OpenConsole.exe", "/NH"], {
      encoding: "utf8",
    })
    if (!tasks.includes("OpenConsole.exe")) fail("The bundled ConPTY host is not running.")
    console.log("The terminal runs on the bundled ConPTY host (OpenConsole.exe).")
  }
} finally {
  await app.close()
  rmSync(work, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
}
console.log("The packaged app closed cleanly.")
