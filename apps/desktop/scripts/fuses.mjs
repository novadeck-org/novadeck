// The Electron fuses the packaged app ships with (see `electronFuses` in electron-builder.yml),
// read back from the binary, and a copy of the app with the three that keep the Node entry
// points shut turned on, which is what launching the app under Playwright and running its
// code as Node, both of which the smoke test and the bench do, need.
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, extname, join, resolve } from "node:path"

import fuses from "@electron/fuses"

const { FuseV1Options, FuseVersion, flipFuses } = fuses

// The package declares its FuseState enum but does not export it at run time.
const FuseState = { DISABLE: 48, ENABLE: 49 }
// Where the fuse wire starts in the binary: this marker, then the wire's version and length.
const sentinel = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"

/** What a shipped binary must read back: the fuse, its name, and its state. */
export const shipped = [
  [FuseV1Options.RunAsNode, "RunAsNode", FuseState.DISABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, "NODE_OPTIONS", FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, "the inspect arguments", FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, "asar integrity", FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, "only-load-from-asar", FuseState.ENABLE],
]

// The file the fuses live in: the executable, or on macOS the framework beside it.
const fuseFile = (executable) =>
  executable.includes(".app")
    ? resolve(
        executable,
        "..",
        "..",
        "Frameworks",
        "Electron Framework.framework",
        "Electron Framework",
      )
    : executable

/**
 * The ways `executable`'s fuses differ from what ships, as sentences; none when they match.
 * A universal macOS binary holds the wire twice, one per architecture, and both are checked.
 */
export const fuseProblems = async (executable) => {
  const file = fuseFile(executable)
  const binary = readFileSync(file)
  const wires = []
  for (let at = binary.indexOf(sentinel); at !== -1; at = binary.indexOf(sentinel, at + 1))
    wires.push(at + sentinel.length)
  if (wires.length === 0) return [`${file} has no fuse wire`]
  return wires.flatMap((wire, index) =>
    shipped.flatMap(([fuse, name, wanted]) => {
      const state = binary[wire + 2 + fuse]
      return state === wanted
        ? []
        : [
            `${name} is ${state === FuseState.ENABLE ? "on" : "off"} in ${file}${wires.length > 1 ? ` (slice ${index + 1})` : ""}`,
          ]
    }),
  )
}

const open = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: true,
  [FuseV1Options.EnableNodeCliInspectArguments]: true,
}

// Removing a copy must not hide the result of the run it served: on Windows the crashpad
// handler can outlive the app and hold its executable.
const removing = (path) => () => {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {}
}

/**
 * A copy of the app that differs from `executable`'s only in RunAsNode, NODE_OPTIONS and the
 * inspect arguments being on, so it finds the same app.asar and runs the same code; `remove`
 * deletes it, and `root` is the path every process of it runs under. On Linux and Windows it is the executable beside the original. On macOS the fuses
 * live in the bundle's framework, so the whole `.app` is copied to a folder of its own and
 * signed there ad hoc, without the hardened runtime that would refuse the changed framework;
 * the bundle that ships is left as it is.
 */
export const openedCopy = async (executable) => {
  if (process.platform === "darwin") {
    const bundle = executable.slice(0, executable.indexOf(".app") + ".app".length)
    const folder = mkdtempSync(join(tmpdir(), "novadeck-open-"))
    const remove = removing(folder)
    try {
      const copy = join(folder, basename(bundle))
      execFileSync("ditto", [bundle, copy])
      const opened = join(copy, executable.slice(bundle.length + 1))
      await flipFuses(opened, open)
      execFileSync("codesign", ["--force", "--deep", "--sign", "-", copy], { stdio: "ignore" })
      return { executable: opened, root: folder, remove }
    } catch (error) {
      remove()
      throw error
    }
  }
  const extension = extname(executable)
  const copy = join(dirname(executable), `${basename(executable, extension)}-open${extension}`)
  const remove = removing(copy)
  try {
    copyFileSync(executable, copy)
    await flipFuses(copy, open)
  } catch (error) {
    remove()
    throw error
  }
  return { executable: copy, root: copy, remove }
}

// The processes whose command line names `root`, as [pid, command] pairs.
const processesUnder = (root) => {
  if (process.platform === "win32") {
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${root.replaceAll("'", "''")}*' } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`
    const out = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" })
    return lines(out.stdout)
  }
  return lines(spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout).filter(
    ([pid, command]) => command.includes(root) && Number(pid) !== process.pid,
  )
}
const lines = (text = "") =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ...rest] = line.split(" ")
      return process.platform === "win32" ? [pid, rest.join(" ")] : [pid, rest.join(" ").trim()]
    })
    .filter(([pid]) => /^\d+$/.test(pid))

/** Kills every process still running from `root`. */
export const killUnder = (root) => {
  for (const [pid] of processesUnder(root)) {
    try {
      if (process.platform === "win32")
        spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" })
      else process.kill(Number(pid), "SIGKILL")
    } catch {}
  }
}

/**
 * Closes a Playwright-launched app within `ms`. One that doesn't close is described (what it
 * printed, its windows, what still runs from `root`) and killed with everything of its,
 * so a hang ends the run with its cause in the log instead of at the step's timeout.
 * Returns the description of such a hang, or undefined when the app closed.
 */
export const closeWithin = async (app, root, output, userData, ms = 30_000) => {
  const closed = app.close().then(
    () => true,
    () => true,
  )
  let timer
  const late = new Promise((settle) => (timer = setTimeout(settle, ms, false)))
  const done = await Promise.race([closed, late])
  clearTimeout(timer)
  if (done) return undefined
  const windows = await Promise.race([
    Promise.all(
      app.windows().map(async (page) => `${await page.title().catch(() => "?")} ${page.url()}`),
    ),
    new Promise((settle) => setTimeout(settle, 5_000, ["(not answered)"])),
  ])
  const running = processesUnder(root)
    .map(([pid, command]) => `  ${pid} ${command.slice(0, 200)}`)
    .join("\n")
  const stuck = processesUnder(root)[0]?.[0]
  const sampled =
    process.platform === "darwin" && stuck !== undefined
      ? spawnSync("sample", [stuck, "1"], { encoding: "utf8", timeout: 20_000 }).stdout
      : ""
  killUnder(root)
  try {
    app.process().kill("SIGKILL")
  } catch {}
  return [
    `The app did not close within ${ms / 1000} s.`,
    `Windows: ${windows.join("; ") || "none"}`,
    `Still running from ${root}:\n${running || "  nothing"}`,
    `Its output:\n${output.join("").slice(-3000) || "  nothing"}`,
    `Its logs:\n${[userData, join(homedir(), "Library", "Logs", "Novadeck")].map(logsUnder).join("") || "  nothing"}`,
    ...(sampled ? [`What its main process was doing (sample):\n${sampled.slice(0, 6000)}`] : []),
  ].join("\n")
}

// The ends of the log files under `folder`, which tell how far a quit that never ended got.
const logsUnder = (folder) => {
  const found = []
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(log|json)$/.test(name) && /log|session/i.test(path)) found.push(path)
    }
  }
  try {
    walk(folder)
  } catch {}
  return found
    .slice(0, 8)
    .map((path) => `--- ${path}\n${readFileSync(path, "utf8").slice(-1500)}`)
    .join("\n")
}
