import { readdirSync, readFileSync, readlinkSync } from "node:fs"

import { signal, type Process, type Scope, type Table } from "./process.js"

/**
 * The process with the pid, should it belong to the sandbox. It reads the process's
 * `stat` for its state and start, and passes over a zombie and any process that started
 * before the sandbox. Only for the rest does it read the target of `cwd`, then, should
 * that not be inside the sandbox, `environ`, searched only for `HOME=<sandbox home>`
 * and neither kept nor printed, and last its `comm`.
 */
const read = (sandbox: Scope, pid: number): Process | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    // Fields after the command, which is in parentheses and may hold anything: the state
    // is field 3, the start field 22.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const start = Number(fields[19])
    if (fields[0] === "Z" || !(start >= sandbox.started)) return undefined
    const cwd = readlinkSync(`/proc/${pid}/cwd`)
    const inside = cwd === sandbox.root || cwd.startsWith(`${sandbox.root}/`)
    if (
      !inside &&
      !readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`HOME=${sandbox.home}`)
    )
      return undefined
    return {
      pid,
      start,
      comm: readFileSync(`/proc/${pid}/comm`, "utf8").trim(),
      // T is stopped by a signal, t by a tracer.
      stopped: fields[0] === "T" || fields[0] === "t",
    }
  } catch {
    // Gone, or another user's, which a sandbox's process never is.
    return undefined
  }
}

/** Linux, from /proc, signalling a process only should it still be the one found. */
export const linux: Table = {
  list: async (sandbox) =>
    readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)
      .flatMap((name) => read(sandbox, Number(name)) ?? []),
  alive: (sandbox, one) => read(sandbox, one.pid)?.start === one.start,
  current: async (sandbox, found) =>
    found.flatMap((one) => {
      const now = read(sandbox, one.pid)
      return now?.start === one.start ? [now] : []
    }),
  end: signal,
}
