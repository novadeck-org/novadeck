import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { constants, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  chooseMode,
  findTool,
  parseRequest,
  restoreFolder,
  signalCode,
  sudoArgs,
  tempFolder,
  type Tools,
  type User,
  userArgs,
} from "./isolated.ts"

// `node scripts/e2e/isolated/main.ts -- <command>`: runs the command in a network namespace
// whose only interface is loopback, as the user who ran it, with their environment. A
// program that ignores the e2e suite's proxy then has no route out, while the fake model
// on 127.0.0.1 still answers. Linux only.

const tool = (name: string): string => {
  const found = findTool(name, process.env.PATH, existsSync)
  if (!found) throw new Error(`isolated: no ${name} in the system's folders or on PATH`)
  return found
}

const tools = (): Tools => ({
  unshare: tool("unshare"),
  ip: tool("ip"),
  setpriv: tool("setpriv"),
  sh: tool("sh"),
})

const currentUser = (): User => {
  const groups = process.getgroups?.() ?? []
  return {
    uid: process.getuid?.() ?? -1,
    gid: process.getgid?.() ?? -1,
    groups: [...new Set(groups)],
  }
}

// Whether sudo is there and runs without asking for a password.
const sudoWorks = (): boolean => {
  const sudo = findTool("sudo", process.env.PATH, existsSync)
  if (!sudo) return false
  try {
    execFileSync(sudo, ["-n", "true"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/**
 * Runs the program with the terminal, passing on the signals that would stop this one,
 * and settles with its exit code, or the shell's code for the signal that ended it.
 */
const run = (file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> =>
  new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(file, args, { stdio: "inherit", env })
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
    const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(
      (signal) => [signal, forward(signal)] as const,
    )
    for (const [signal, handler] of handlers) process.on(signal, handler)
    const done = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler)
    }
    child.on("error", (error) => {
      done()
      reject(error)
    })
    child.on("exit", (code, signal) => {
      done()
      resolve(signal ? signalCode(constants.signals[signal]) : (code ?? 1))
    })
  })

/**
 * Through sudo: the environment goes in a file only the user can read, in a folder only
 * they can open, which the inner step reads and deletes before the command starts.
 */
const runWithSudo = async (command: readonly string[]): Promise<number> => {
  const sudo = tool("sudo")
  const folder = mkdtempSync(join(tmpdir(), "novadeck-isolated-"))
  const envFile = join(folder, "env.json")
  try {
    writeFileSync(envFile, JSON.stringify(process.env), { mode: 0o600 })
    const self = fileURLToPath(import.meta.url)
    const inner = [process.execPath, self, "--restore", envFile, "--", ...command]
    return await run(sudo, sudoArgs(tools(), currentUser(), inner), process.env)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

// Inside the namespace, as the user again: the environment back from its file, whose
// folder is deleted first, then the command. sudo dropped TMPDIR, so the folder is looked
// for where the user's own environment, the one in the file, puts temporary folders.
const restore = (envFile: string, command: readonly string[]): Promise<number> => {
  const parsed: unknown = JSON.parse(readFileSync(envFile, "utf8"))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`isolated: --restore takes an environment as a JSON object, not ${envFile}`)
  const env = parsed as NodeJS.ProcessEnv
  const folder = restoreFolder(envFile, tempFolder(env), realpathSync)
  if (folder instanceof Error) throw folder
  rmSync(folder, { recursive: true, force: true })
  const [file, ...args] = command
  return run(file!, args, env)
}

export const main = async (argv: readonly string[]): Promise<number> => {
  if (process.platform !== "linux") throw new Error("isolated: network namespaces are Linux only")
  const request = parseRequest(argv)
  if (request instanceof Error) throw request
  if (request.kind === "restore") return restore(request.envFile, request.command)
  if (process.getuid?.() === 0)
    throw new Error("isolated: run it as the user the command runs as, not root")
  const mode = chooseMode(process.env.NOVADECK_E2E_NETNS, sudoWorks)
  if (mode instanceof Error) throw mode
  if (mode === "sudo") return runWithSudo(request.command)
  return run(tool("unshare"), userArgs(tools(), currentUser(), request.command), process.env)
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 125
  }
}
