import { spawn } from "node:child_process"

import { Trees } from "@novadeck/terminal/pty"

import { withoutInherited } from "./inherited.js"

/**
 * What a cmd run printed: "clean" for nothing on stdout or stderr, "prints" for something,
 * "slow" for a run still going at the time limit (what it printed by then can't be known to be
 * all of it), "error" for a cmd that did not start.
 */
export type CmdOutput = "clean" | "prints" | "slow" | "error"

/**
 * Starts `program` with `args` in the runner's child environment (without what children never
 * inherit: the AutoRun is the person's own code) and reports what it printed on stdout or
 * stderr, once its output closes or at `timeoutMs`. At the limit the whole tree is ended, not
 * cmd alone, through the relay's `tree` and `end` where there is one (Windows): an AutoRun
 * may have started a process that would hold the output open for good.
 */
export const cmdOutput = ({
  program,
  args,
  timeoutMs,
  relay,
  verbatim = false,
}: {
  readonly program: string
  readonly args: readonly string[]
  readonly timeoutMs: number
  /** The relay that ends the tree at the limit; cmd alone is killed without one. */
  readonly relay?: string | undefined
  readonly verbatim?: boolean
}): Promise<CmdOutput> =>
  new Promise((resolve) => {
    let printed = false
    let settled = false
    const finish = (answer: CmdOutput) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(answer)
    }
    const child = spawn(program, [...args], {
      env: withoutInherited(process.env),
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const timer = setTimeout(() => {
      void (async () => {
        const trees =
          relay !== undefined && process.platform === "win32" && child.pid !== undefined
            ? new Trees(() => Promise.resolve(relay))
            : undefined
        // Read before cmd goes: a process keeps its parent's pid after the parent ends.
        const members = trees && (await trees.read(child.pid!, 2_000).catch(() => undefined))
        child.kill()
        if (trees && members) await trees.end(members, 2_000).catch(() => {})
        finish(printed ? "prints" : "slow")
      })()
    }, timeoutMs)
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", () => {
        printed = true
      })
    child.on("error", () => finish("error"))
    child.on("close", () => finish(printed ? "prints" : "clean"))
  })
