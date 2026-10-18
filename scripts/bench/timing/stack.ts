import { type ChildProcess, spawn, type SpawnOptions } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { join } from "node:path"

import type { Sandbox } from "@novadeck/sandbox"

import { openSandbox } from "./sandbox.ts"

// What the timing run runs against: the UI's production build, served by `vite preview`, over
// a real runner inside the sandbox (see sandbox.ts), as the dev-web path wires them. The
// runner and every shell it starts get the sandbox's environment alone.

const root = join(import.meta.dirname, "..", "..", "..")
const ui = join(root, "application/ui")

/** The runner's environment: the sandbox's alone, with what the runner itself is told. */
export const runnerEnv = (
  sandbox: Pick<Sandbox, "env" | "root">,
  runner: { readonly token: string; readonly port: number; readonly origin: string },
): NodeJS.ProcessEnv => ({
  ...sandbox.env,
  NOVADECK_TOKEN: runner.token,
  HOST: "127.0.0.1",
  PORT: String(runner.port),
  NOVADECK_DATABASE: join(sandbox.root, "data", "workspace.sqlite"),
  CORS_ORIGINS: runner.origin,
})

/** Free ports on loopback, each held until all are known, so no two come out the same. */
const freePorts = async (count: number): Promise<readonly number[]> => {
  const servers = Array.from({ length: count }, () => createServer())
  try {
    return await Promise.all(
      servers.map(
        (server) =>
          new Promise<number>((resolve, reject) => {
            server.once("error", reject)
            server.listen(0, "127.0.0.1", () => {
              const address = server.address()
              if (typeof address === "object" && address) resolve(address.port)
              else reject(new Error("no port"))
            })
          }),
      ),
    )
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  }
}

/** Whether the child has ended, by its exit or by a signal. */
const ended = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

/** Waits until `url` answers at all, or fails once `ms` have passed or `child` has ended. */
const ready = async (url: string, child: ChildProcess, ms: number): Promise<void> => {
  const deadline = Date.now() + ms
  for (;;) {
    if (ended(child))
      throw new Error(`${url}: its process ended (${child.exitCode ?? child.signalCode})`)
    // eslint-disable-next-line no-await-in-loop -- Asks again until it answers.
    const answered = await fetch(url, { signal: AbortSignal.timeout(5000) }).then(
      () => true,
      () => false,
    )
    if (answered) return
    if (Date.now() > deadline) throw new Error(`${url} didn't answer in ${ms / 1000} s`)
    // eslint-disable-next-line no-await-in-loop -- As above.
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** Asks the child to end, and ends it forcibly should it outlive `ms`. */
const halt = async (child: ChildProcess, ms: number): Promise<void> => {
  if (ended(child)) return
  const exited = new Promise((resolve) => child.once("exit", resolve))
  child.kill("SIGTERM")
  let timer: NodeJS.Timeout | undefined
  const late = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, "late")
  })
  if ((await Promise.race([exited, late])) === "late") {
    child.kill("SIGKILL")
    await exited
  }
  clearTimeout(timer)
}

/** Starts a program that runs alongside, its failure to start kept for `ready` to report. */
const start = (file: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
  const child = spawn(file, [...args], options)
  // Without a listener a failure to start throws where nothing can catch it; `ready` sees
  // it ended.
  child.once("error", (error) => console.error(`${args[0] ?? file}: ${error.message}`))
  return child
}

/**
 * Runs a program to its end, its output passed through, handing it to `track` as it starts;
 * rejects should it fail.
 */
const run = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  track: (child: ChildProcess) => void,
) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(file, [...args], { ...options, stdio: ["ignore", "inherit", "inherit"] })
    child.once("error", reject)
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited with ${code}`)),
    )
    track(child)
  })

/** The stack once it runs. */
export type Running = {
  /** The UI's address. */
  readonly url: string
  /** Turns agent `seed` busy or idle (see agent.ts). */
  readonly busy: (seed: number, on: boolean) => void
  /** The shell command that starts agent `seed`. */
  readonly agent: (seed: number) => string
}

export type Stack = {
  /** Builds the UI and starts the runner in the sandbox and the UI's preview over it. */
  readonly start: () => Promise<Running>
  /**
   * Stops whatever started and removes the sandbox, once, however far `start` got.
   * Returns what went wrong inside the sandbox: processes it had to end, and the
   * developer's home written to from inside it.
   */
  readonly stop: () => Promise<readonly string[]>
}

/** A fresh sandbox, with the tripwire set over the developer's home; nothing runs yet. */
export const openStack = (): Stack => {
  const { sandbox, busy, agent, close } = openSandbox("novadeck-timing-")
  const children: ChildProcess[] = []
  let stopped: Promise<readonly string[]> | undefined
  // Once stopping, nothing more starts: what a start still under way just started ends at
  // once, as `stop` may be past ending the rest.
  const track = (child: ChildProcess) => {
    if (!stopped) {
      children.push(child)
      return
    }
    child.kill("SIGKILL")
    throw new Error("the stack is stopping")
  }
  const stop = () =>
    (stopped ??= (async () => {
      // The latest first, the preview before the runner it serves, until none is left, as a
      // start under way may have added one meanwhile.
      for (let child = children.pop(); child; child = children.pop())
        // eslint-disable-next-line no-await-in-loop -- One after another, as above.
        await halt(child, 10_000)
      return close()
    })())
  const vite = join(ui, "node_modules", "vite", "bin", "vite.js")
  return {
    stop,
    start: async () => {
      const [runnerPort, uiPort] = await freePorts(2)
      const token = randomBytes(32).toString("hex")
      const origin = `http://127.0.0.1:${uiPort}`
      const dist = join(sandbox.root, "ui")
      // The web app's entry, as the dev-web path serves it: the runner's address and token are
      // baked into the build.
      await run(
        process.execPath,
        [vite, "build", "--mode", "web", "--outDir", dist, "--emptyOutDir"],
        {
          cwd: ui,
          // A production build whatever the developer's shell says, as the numbers need one.
          env: {
            ...process.env,
            NODE_ENV: "production",
            VITE_NOVADECK_RUNNER_URL: `ws://127.0.0.1:${runnerPort}/api/rpc`,
            VITE_NOVADECK_RUNNER_TOKEN: token,
          },
        },
        track,
      )
      const runner = start(process.execPath, [join(root, "application/runner/dist/cli.js")], {
        cwd: sandbox.root,
        env: runnerEnv(sandbox, { token, port: runnerPort!, origin }),
        stdio: ["ignore", "inherit", "inherit"],
      })
      track(runner)
      await ready(`http://127.0.0.1:${runnerPort}/`, runner, 60_000)
      const preview = start(
        process.execPath,
        [
          vite,
          "preview",
          "--outDir",
          dist,
          "--host",
          "127.0.0.1",
          "--port",
          String(uiPort),
          "--strictPort",
        ],
        { cwd: ui, env: process.env, stdio: ["ignore", "ignore", "inherit"] },
      )
      track(preview)
      await ready(origin, preview, 60_000)
      return {
        url: `${origin}/`,
        busy,
        agent,
      }
    },
  }
}
