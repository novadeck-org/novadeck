// Launches the unpacked packaged app and runs a real shell through its bundled runner.
// Usage (after `pnpm run package:<target>`): node scripts/smoke.mjs
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import * as esbuild from "esbuild"
import { chromium } from "playwright"

import { closeWithin, fuseProblems, killUnder, openedCopy, processesUnder } from "./fuses.mjs"

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const release = join(packageDir, "release")

const fail = (message) => {
  console.error(`::error::${message}`)
  process.exit(1)
}

const packaged = () => {
  if (process.platform === "win32") {
    const root = join(release, "win-unpacked")
    return {
      executable: join(root, "novadeck.exe"),
      resources: join(root, "resources"),
    }
  }
  if (process.platform === "darwin") {
    const folder = readdirSync(release).find((name) => name.startsWith("mac"))
    const bundle =
      folder && readdirSync(join(release, folder)).find((name) => name.endsWith(".app"))
    if (!folder || !bundle) fail("No unpacked macOS app bundle was found.")
    const root = join(release, folder, bundle, "Contents")
    return {
      executable: join(root, "MacOS", "novadeck"),
      resources: join(root, "Resources"),
    }
  }
  const root = join(release, "linux-unpacked")
  return {
    executable: join(root, "novadeck"),
    resources: join(root, "resources"),
  }
}

const { executable, resources } = packaged()
if (!existsSync(executable)) fail(`The packaged executable is missing: ${executable}`)

// The shipped binary must not run as Node, take NODE_OPTIONS or the inspect arguments, and must
// load only from a checked app.asar: its fuses are read back as they ship.
for (const problem of await fuseProblems(executable)) fail(`A fuse is wrong: ${problem}`)
console.log("The packaged binary's fuses are set: no RunAsNode, NODE_OPTIONS or inspect arguments.")

// The checks that need the binary to run as Node (the worker and koffi checks) use a copy of
// the app with only those three fuses turned on (on macOS the whole bundle, in a scratch
// folder); it finds the same app.asar and code, so what ships is what is tested. The runner round
// trip below drives the shipped app itself.
const opened = await openedCopy(executable)
process.on("exit", opened.remove)

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

// koffi reads Focus Assist on Windows, from its x64 binary unpacked beside node-pty's; without
// it the notification sound plays through Focus Assist. No other build carries it.
const koffi = join(resources, "app.asar.unpacked", "node_modules", "@koromix")
const ffi = join(koffi, `koffi-win32-${process.arch}`, `win32_${process.arch}`, "koffi.node")
if (process.platform === "win32") {
  if (!existsSync(ffi)) fail(`koffi's binary is missing: ${ffi}`)
  // Loaded as the app loads it, from app.asar with its binary unpacked beside it, making the
  // call quiet.ts declares: a build that can't would play the sound through Focus Assist.
  const probe = join(mkdtempSync(join(tmpdir(), "novadeck-smoke-koffi-")), "koffi.mjs")
  writeFileSync(
    probe,
    `import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
// Its module entry, as the app's import takes it, found from the app's own code.
const folder = dirname(createRequire(process.argv[2]).resolve("koffi"))
const { default: koffi } = await import(pathToFileURL(join(folder, "index.js")).href)
const query = koffi.load("ntdll.dll").func(
  "int __stdcall NtQueryWnfStateData(uint64_t *name, void *type, void *scope, _Out_ uint32_t *stamp, _Out_ uint32_t *buffer, _Inout_ uint32_t *size)",
)
const status = query(new BigUint64Array([0x0d83063ea3bf1c75n]), null, null, new Uint32Array(1), new Uint32Array(4), new Uint32Array([16]))
console.log((status >>> 0).toString(16))
`,
  )
  try {
    const status = execFileSync(
      opened.executable,
      [probe, join(resources, "app.asar", "out", "main", "index.js")],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    console.log(
      `koffi loads in the packaged app and reads Focus Assist (status ${status.toString().trim()}).`,
    )
  } catch (error) {
    fail(`koffi did not load in the packaged app: ${error.stderr?.toString().trim() || error}`)
  }
} else {
  for (const path of [koffi, join(resources, "app.asar.unpacked", "node_modules", "koffi")])
    if (existsSync(path)) fail(`koffi is packaged outside Windows: ${path}`)
}

// macOS plays the notification sound by name from the bundle's resources: every file of the
// page's sounds folder is copied in.
if (process.platform === "darwin")
  for (const sound of readdirSync(join(packageDir, "../../frontend/ui/src/sounds")))
    if (sound.endsWith(".wav") && !existsSync(join(resources, sound)))
      fail(`The notification sound is missing: ${join(resources, sound)}`)

// The relay agents start for Novadeck's MCP server and hooks ships beside the UI, and answers the
// handshake by itself outside Novadeck's terminals.
const relay = join(
  resources,
  "relay",
  `novadeck-relay${process.platform === "win32" ? ".exe" : ""}`,
)
if (!existsSync(relay)) fail(`The relay is missing: ${relay}`)
try {
  const hello = execFileSync(relay, ["mcp", "0.0.0", "2025-06-18"], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    // Outside a Novadeck terminal, even when the smoke test runs in one.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("NOVADECK_")),
    ),
    timeout: 10_000,
  })
  const answer = JSON.parse(hello.toString())
  if (answer?.result?.protocolVersion !== "2025-06-18") throw new Error(hello.toString())
  // A hook outside Novadeck still gives Antigravity the answer that lets its tools run,
  // as the runner's relay.json names it.
  const config = join(mkdtempSync(join(tmpdir(), "novadeck-smoke-relay-")), "relay.json")
  writeFileSync(
    config,
    JSON.stringify({
      fallbacks: { agy: { PreToolUse: '{"decision":"ask"}', "*": "{}" } },
    }),
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
  const version = execFileSync(relay, ["--version"], {
    timeout: 10_000,
  }).toString()
  if (!/^novadeck-relay \S+ \(protocol 2\)/.test(version)) {
    throw new Error(`version: ${version}`)
  }
} catch (error) {
  fail(`The relay didn't answer as an MCP server and hook: ${error}`)
}

// An engine's manifest, when the build ships one, names the archive it downloads.
for (const [name, label] of [
  ["voice", "voice engine"],
  ["murmur", "murmur engine"],
]) {
  const engine = join(resources, name, "engine.json")
  if (!existsSync(engine)) continue
  try {
    const manifest = JSON.parse(readFileSync(engine, "utf8"))
    if (
      typeof manifest.file !== "string" ||
      !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
      !Number.isInteger(manifest.size) ||
      manifest.size <= 0 ||
      // The runner reads a manifest whose interface it cannot parse as no manifest at all.
      !(Number.isSafeInteger(manifest.interface) && manifest.interface > 0)
    ) {
      throw new Error(JSON.stringify(manifest))
    }
  } catch (error) {
    fail(`The ${label} manifest is invalid: ${error}`)
  }
  console.log(`The packaged app carries its ${label} manifest.`)
}

// The threads the runner redacts in (murmur's digests, saved transcripts), started as the
// runner starts them: a worker on the script inside app.asar. The app's open copy runs the check as Node,
// which reads asar archives the same way the app does.
{
  const script = join(mkdtempSync(join(tmpdir(), "novadeck-smoke-worker-")), "start-worker.mjs")
  writeFileSync(
    script,
    `import { pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
const worker = new Worker(pathToFileURL(process.argv[2]))
const fail = (what) => {
  console.error(what)
  process.exit(1)
}
setTimeout(() => fail("no ready message in 20 s"), 20_000)
worker.once("error", (error) => fail(String(error?.stack ?? error)))
worker.once("exit", () => fail("the worker exited"))
worker.once("message", (reply) => {
  if (reply?.ready !== true) fail("unexpected first message: " + JSON.stringify(reply))
  process.exit(0)
})
`,
  )
  for (const [label, file] of [
    ["murmur", "murmurWorker.js"],
    ["transcript redaction", "redactionWorker.js"],
  ]) {
    try {
      execFileSync(opened.executable, [script, join(resources, "app.asar", "out", "main", file)], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      fail(
        `The packaged ${label} worker did not start: ${error.stderr?.toString().trim() || error}`,
      )
    }
    console.log(`The packaged ${label} worker started from app.asar.`)
  }
}

// The client as the app depends on it: its built code, which plain node resolves to, so the
// package can move without this changing.
const bundle = await esbuild.build({
  entryPoints: [createRequire(join(packageDir, "package.json")).resolve("@novadeck/runner-client")],
  bundle: true,
  format: "iife",
  globalName: "novadeckClient",
  platform: "browser",
  write: false,
})
const client = `${bundle.outputFiles[0].text};globalThis.novadeckClient = novadeckClient`

const userData = mkdtempSync(join(tmpdir(), "novadeck-smoke-data-"))
const work = mkdtempSync(join(tmpdir(), "novadeck-smoke-work-"))
// The shipped binary itself, not the open copy: Playwright's Electron driver needs the inspector
// the fuses shut, but Chromium's remote debugging port is no Node fuse, and drives the page as
// well. The app quits as it does for a person, by closing the browser.
const output = []
const child = spawn(
  executable,
  [
    "--remote-debugging-port=0",
    `--user-data-dir=${userData}`,
    // Hosted Linux runners forbid the unprivileged namespaces Chromium's sandbox needs.
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  ],
  // A release's version would otherwise let the packaged app look for updates.
  {
    env: { ...process.env, NOVADECK_UPDATES: "off" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  },
)
const exited = new Promise((settle) =>
  child.once("exit", (code, signal) => settle({ code, signal })),
)
const listening = new Promise((settle) => {
  const look = (chunk) => {
    output.push(String(chunk))
    const found = /DevTools listening on (ws:\/\/\S+)/.exec(output.join(""))
    if (found) settle(found[1])
  }
  child.stdout.on("data", look)
  child.stderr.on("data", look)
})
const endpoint = await Promise.race([
  listening,
  exited.then(() => undefined),
  new Promise((settle) => setTimeout(settle, 60_000, undefined)),
])
// Where the shipped app runs from, which a hung one is looked for under.
const shippedRoot =
  process.platform === "darwin"
    ? executable.slice(0, executable.indexOf(".app") + ".app".length)
    : executable
if (!endpoint) {
  killUnder(shippedRoot)
  fail(`The packaged app did not open its debugging port. Its output:\n${output.join("")}`)
}
let browser
const app = {
  process: () => child,
  windows: () => browser?.contexts().flatMap((context) => context.pages()) ?? [],
  close: async () => {
    if (!browser) throw new Error("the page was never reached")
    if (process.platform === "darwin") {
      // The browser is gone before it answers, so the command's own answer is not waited for.
      // This is the path of the menu's Quit: app.quit.
      void browser
        .newBrowserCDPSession()
        .then((session) => session.send("Browser.close"))
        .catch(() => {})
    } else {
      // As a person quits on Linux and Windows: closing the last window, which ends the app
      // through window-all-closed, the orderly quit that gates installing an update on quit.
      for (const page of app.windows()) void page.close({ runBeforeUnload: false }).catch(() => {})
    }
    await exited
  },
}
try {
  browser = await chromium.connectOverCDP(endpoint)
  const context = browser.contexts()[0]
  const page = context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 60_000 }))
  await page.waitForLoadState("domcontentloaded")
  await page.evaluate(client)
  // The typed echo differs from the output, so only the shell's answer matches.
  const input = process.platform === "win32" ? "echo NOVADECK_4^2\r" : 'echo NOVADECK_4""2\r'
  const result = await page.evaluate(
    async ({ cwd, typed }) => {
      const { connectRunner, desktop } = globalThis.novadeckClient
      // How long the first connection took, and why it failed: a runner slow to start
      // reads differently from one that never answers.
      const started = performance.now()
      let runner
      try {
        runner = await connectRunner(desktop())
      } catch (error) {
        return {
          connect: {
            ms: Math.round(performance.now() - started),
            code: error?.code,
            message: String(error?.message ?? error),
            cause: String(error?.cause?.message ?? error?.cause ?? ""),
          },
        }
      }
      globalThis.smoke = runner
      const project = await runner.projects.create({
        id: crypto.randomUUID(),
        name: "Smoke",
        cwd,
      })
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
      return {
        answered: await Promise.race([reading, timeout]),
        tail: text.slice(-400),
      }
    },
    { cwd: work, typed: input },
  )
  if (result.connect)
    fail(
      `The page could not reach the packaged runner after ${result.connect.ms} ms: ` +
        `${result.connect.message} (${result.connect.code}), caused by: ${result.connect.cause || "nothing given"}`,
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
  if (!browser) {
    // The page was never reached: nothing to close, only the spawned app to end.
    child.kill("SIGKILL")
    killUnder(shippedRoot)
    killUnder(opened.root)
  } else {
    const hung = await closeWithin(app, shippedRoot, output, userData)
    // What the app left running after its main process ended is looked for after a grace, and
    // killed only once it is named.
    const gone = (waited) =>
      processesUnder(shippedRoot).length === 0 || waited >= 5_000
        ? Promise.resolve()
        : new Promise((settle) => setTimeout(settle, 250)).then(() => gone(waited + 250))
    await gone(0)
    const left = processesUnder(shippedRoot)
    killUnder(shippedRoot)
    killUnder(opened.root)
    if (hung) fail(hung)
    const { code, signal } = await exited
    if (code !== 0 || signal)
      fail(`The packaged app ended with code ${code} and signal ${signal}, not 0 and none.`)
    if (left.length > 0)
      fail(
        `The packaged app left processes running after it quit:\n${left.map(([pid, command]) => `  ${pid} ${command.slice(0, 200)}`).join("\n")}`,
      )
    // A quit the app made itself, not one it was killed in: its log says it ran to its end,
    // and on Linux and Windows that it began the orderly way, as closing the window does.
    const hostLog = join(userData, "logs", "host.log")
    const ended = existsSync(hostLog) ? readFileSync(hostLog, "utf8") : ""
    const orderly = process.platform === "darwin" ? "" : '[^\\n]*"orderly":true'
    if (
      !new RegExp(`"evt":"app\\.quit"${orderly}`).test(ended) ||
      !/"evt":"session.end"[^\n]*"code":0/.test(ended)
    )
      fail(`The packaged app's log doesn't show an orderly quit:\n${ended.slice(-1500)}`)
    rmSync(work, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  }
}
console.log("The packaged app closed cleanly.")
