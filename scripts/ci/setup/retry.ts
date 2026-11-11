import { spawnSync } from "node:child_process"

// `node scripts/ci/setup/retry.ts <what failing means> -- <command> [args…]`: runs a setup
// command that reaches the network (apt's mirrors, the browser's download) up to `attempts`
// times, each bounded by `limitSeconds`, waiting longer before each retry. On 11-11 Ubuntu's
// mirrors couldn't be resolved for hours (Canonical's DNS), and `playwright install-deps` ended
// each job with exit code 100 six or seven minutes after a warning. Here a failure that
// outlasts the retries ends the step with one `::error::` line saying what failed, and that
// the mirrors were unreachable where the output says so, after about ten minutes at most.

export type Plan = {
  readonly attempts: number
  /** Each attempt's limit; a hung mirror is ended there and tried again. */
  readonly limitSeconds: number
  /** The wait before the first retry, doubled before each after it. */
  readonly firstWaitSeconds: number
  /** How long a retry waits for an apt or dpkg an ended attempt left running. */
  readonly settleSeconds: number
}

export const plan: Plan = {
  attempts: 3,
  limitSeconds: 180,
  firstWaitSeconds: 30,
  settleSeconds: 30,
}

/** The waits between the attempts: one fewer than the attempts, each twice the last. */
export const waits = ({ attempts, firstWaitSeconds }: Plan): readonly number[] =>
  Array.from({ length: Math.max(attempts - 1, 0) }, (_, index) => firstWaitSeconds * 2 ** index)

/** The longest the whole step can take: every attempt at its limit, every wait and settling. */
export const longest = (retries: Plan): number =>
  retries.attempts * retries.limitSeconds +
  waits(retries).reduce((sum, wait) => sum + wait + retries.settleSeconds, 0)

// What apt prints when it can't reach a mirror: the name unresolved, or a fetch that failed.
const unreachable = /Temporary failure resolving|Failed to fetch|Could not resolve/

/**
 * The line that ends a step whose every attempt failed: what failing means, and that Ubuntu's
 * mirrors were unreachable where the attempts' output says so, which the script can't know
 * otherwise.
 */
export const failure = (meaning: string, retries: Plan, output = ""): string =>
  `::error title=Setup::${meaning}${unreachable.test(output) ? ": Ubuntu's mirrors unreachable" : ""} (${retries.attempts} attempts, ${waits(retries).join(" s, ")} s apart)`

const sleep = (seconds: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)

/**
 * The command an attempt runs. On Linux, under coreutils' `timeout`, which sends SIGTERM to
 * the attempt's process group, and SIGKILL after 15 s to what is left of it. `sudo` (with
 * Ubuntu's `use_pty`) runs apt in a session of its own, outside that group: it relays the
 * SIGTERM to apt, but the SIGKILL reaches sudo alone, so an apt or dpkg can outlive the attempt
 * and hold dpkg's lock. A retry waits for them first (`settled`). Elsewhere as it is.
 */
export const bounded = (
  command: readonly string[],
  limitSeconds: number,
  platform: NodeJS.Platform = process.platform,
): readonly string[] =>
  platform === "linux" ? ["timeout", "--kill-after=15s", `${limitSeconds}s`, ...command] : command

/** Whether a process named `name` runs, by `pgrep -x`. */
const running = (name: string): boolean => spawnSync("pgrep", ["-x", name]).status === 0

/**
 * Waits up to `seconds` for no `apt-get`, `apt` or `dpkg` to run, so a retry doesn't fail at
 * once on the lock an ended attempt's apt still holds; whether none is left. Linux only.
 */
export const settled = (seconds: number, isRunning = running): boolean => {
  for (let waited = 0; ; waited += 1) {
    if (!["apt-get", "apt", "dpkg"].some(isRunning)) return true
    if (waited >= seconds) return false
    sleep(1)
  }
}

/** Runs `command` as `retries` says; its status, 0 once an attempt passes. */
export const run = (meaning: string, command: readonly string[], retries: Plan = plan): number => {
  const pauses = waits(retries)
  let status = 1
  let output = ""
  for (let attempt = 1; attempt <= retries.attempts; attempt += 1) {
    const [program, ...args] = bounded(command, retries.limitSeconds)
    const result = spawnSync(program!, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // On Linux `timeout` bounds it (`bounded`); elsewhere this, which ends the command alone.
      ...(process.platform === "linux" ? {} : { timeout: retries.limitSeconds * 1000 }),
      // pnpm is a .cmd on Windows.
      shell: process.platform === "win32",
    })
    // Kept to read why it failed, and printed as each attempt ends.
    process.stdout.write(result.stdout ?? "")
    process.stderr.write(result.stderr ?? "")
    output += `${result.stdout ?? ""}\n${result.stderr ?? ""}\n`
    status = result.status ?? 1
    if (status === 0) return 0
    const why = result.error
      ? ` (${result.error.message})`
      : ` (exit ${result.status ?? result.signal})`
    const wait = pauses[attempt - 1]
    if (wait === undefined) break
    console.log(
      `::warning title=Setup::attempt ${attempt} of ${retries.attempts} failed${why}; again in ${wait} s`,
    )
    sleep(wait)
    if (process.platform === "linux" && !settled(retries.settleSeconds))
      console.log("::warning title=Setup::an apt or dpkg from the last attempt is still running")
  }
  console.log(failure(meaning, retries, output))
  return status
}

if (import.meta.main) {
  const split = process.argv.indexOf("--")
  const meaning = process.argv[2]
  if (!meaning || split < 0 || split === process.argv.length - 1) {
    console.error("usage: retry.ts <what failing means> -- <command> [args…]")
    process.exitCode = 2
  } else {
    // The tests run it with no wait between attempts, and a short limit on each.
    const limit = Number(process.env.NOVADECK_SETUP_RETRY_LIMIT)
    const retries = {
      ...plan,
      ...(process.env.NOVADECK_SETUP_RETRY_FAST === "true" && {
        firstWaitSeconds: 0,
        settleSeconds: 0,
      }),
      ...(limit > 0 && { limitSeconds: limit }),
    }
    process.exitCode = run(meaning, process.argv.slice(split + 1), retries)
  }
}
