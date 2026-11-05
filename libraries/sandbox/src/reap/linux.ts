import { readdirSync, readFileSync, readlinkSync } from "node:fs"

import { sandboxed, signal, type Process, type Scope, type Table } from "./process.js"

/** A process as `/proc/<pid>/stat` gives it: with its parent, its group and its state. */
type Stat = {
  readonly pid: number
  readonly comm: string
  readonly state: string
  readonly ppid: number
  readonly pgid: number
  readonly start: number
}

/**
 * The process with the pid as its `stat` gives it, or undefined once it has gone. The
 * command, in parentheses, may hold anything, so the fields are read after its last `)`:
 * the state is field 3, the parent's pid field 4, the group field 5, the start field 22,
 * in clock ticks since boot.
 */
const stat = (pid: number): Stat | undefined => {
  let line: string
  try {
    line = readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch {
    return undefined
  }
  const close = line.lastIndexOf(")")
  const fields = line.slice(close + 2).split(" ")
  return {
    pid,
    comm: line.slice(line.indexOf("(") + 1, close),
    state: fields[0]!,
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    start: Number(fields[19]),
  }
}

/**
 * Whether the process works inside the sandbox, by the target of its `cwd`, or, should
 * that not be inside, has the sandbox's home, by its `environ`, searched only for
 * `HOME=<sandbox home>` and neither kept nor printed. False where either can't be read:
 * gone, another user's, or made non-dumpable (as setuid programs and ssh-agent are), which
 * hides both even from its own user while `stat` stays readable; such a process is the
 * sandbox's only through its parent or its group (see `list`).
 */
const scoped = (sandbox: Scope, pid: number): boolean => {
  try {
    const cwd = readlinkSync(`/proc/${pid}/cwd`)
    if (cwd === sandbox.root || cwd.startsWith(`${sandbox.root}/`)) return true
    return readFileSync(`/proc/${pid}/environ`, "latin1")
      .split("\0")
      .includes(`HOME=${sandbox.home}`)
  } catch {
    return false
  }
}

// The process alone, as the table gives it. T is stopped by a signal, t by a tracer.
const asProcess = ({ pid, comm, start, state }: Stat): Process => ({
  pid,
  comm,
  start,
  stopped: state === "T" || state === "t",
})

/**
 * The sandbox's processes, from /proc: of those that started since the sandbox was made,
 * zombies passed over, each working inside it or with its home, and, as on macOS, every
 * one whose parent is one of those or whose process group holds one, until no more join,
 * never through the caller's own group (see `sandboxed`). So a child that left the folder
 * with another HOME (`cd /tmp && env -i …`), or whose folder and environment can't be
 * read, is found while its parent, or one of its group, still runs; one whose parent and
 * group are gone, as a daemon's are, is not.
 */
const list = async (sandbox: Scope): Promise<readonly Process[]> => {
  const ownGroup = stat(process.pid)?.pgid
  if (ownGroup === undefined) throw new Error("reap: /proc holds no stat of the caller's")
  const recent = readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)
    .flatMap((name) => stat(Number(name)) ?? [])
    .filter((one) => one.state !== "Z" && one.start >= sandbox.started)
  const members = new Set(recent.filter((one) => scoped(sandbox, one.pid)).map(({ pid }) => pid))
  const all = sandboxed(recent, members, ownGroup)
  return recent.filter((one) => all.has(one.pid)).map(asProcess)
}

// The process found, as it is now, should it still be that one, by its pid and start, and
// not a zombie: never found again from scratch, as one found through its parent no longer
// is once that parent has gone.
const now = (one: Process): Process | undefined => {
  const it = stat(one.pid)
  return it && it.state !== "Z" && it.start === one.start ? asProcess(it) : undefined
}

/** Linux, from /proc, signalling a process only should it still be the one found. */
export const linux: Table = {
  list,
  alive: (_sandbox, one) => now(one) !== undefined,
  current: async (_sandbox, found) => found.flatMap((one) => now(one) ?? []),
  end: signal,
}
