import { execFile } from "node:child_process"
import { promisify } from "node:util"

/** A running process as its system lists it. */
export type Running = {
  readonly pid: number
  readonly parent: number
  /** Its command line, or its program's name where the system won't tell. */
  readonly command: string
}

/** How much of a command line a trace keeps. */
const commandChars = 300

/** Windows' list, as `ConvertTo-Json` gives it: one object alone isn't in a list. */
export const parseWindows = (output: string): readonly Running[] =>
  [JSON.parse(output) as Running[] | Running]
    .flat()
    .map((row) => ({ ...row, command: String(row.command) }))

/** The lines of `ps -o pid=,ppid=,args=`: two numbers and the command line. */
export const parsePs = (output: string): readonly Running[] =>
  output.split("\n").flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return row ? [{ pid: Number(row[1]), parent: Number(row[2]), command: row[3]! }] : []
  })

/**
 * Every process running, as this system lists them. On Windows this takes half a minute on a
 * CI runner, as CIM is slow to start there, and may not answer within its minute.
 */
export const runningProcesses = async (): Promise<readonly Running[]> => {
  const run = promisify(execFile)
  return process.platform === "win32"
    ? parseWindows(
        (
          await run(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine,Name | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; command = $(if ($_.CommandLine) { $_.CommandLine } else { $_.Name }) } } | ConvertTo-Json -Compress",
            ],
            { windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
          )
        ).stdout,
      )
    : parsePs(
        (
          await run("ps", ["-A", "-ww", "-o", "pid=,ppid=,args="], {
            timeout: 10_000,
            maxBuffer: 16 * 1024 * 1024,
          })
        ).stdout,
      )
}

/**
 * `root` and every process under it, root first, parents before children. Windows keeps a
 * parent's id after that parent ends, when another process may take it, so a line can name
 * a stranger: this is for reading, never for ending anything.
 */
export const treeOf = (running: readonly Running[], root: number): readonly Running[] => {
  const found = running.filter(({ pid }) => pid === root)
  const seen = new Set([root])
  for (const member of found)
    for (const child of running)
      if (child.parent === member.pid && !seen.has(child.pid)) {
        seen.add(child.pid)
        found.push(child)
      }
  return found
}

/** One process as a line of a trace, its command line cut short. */
export const processLine = ({ pid, parent, command }: Running): string =>
  `${pid} under ${parent}: ${command.slice(0, commandChars)}`
