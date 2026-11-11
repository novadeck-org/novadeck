import { spawnSync } from "node:child_process"
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// `node scripts/ci/setup/retry.ts <what failing means> -- <command> [args…]`: runs a setup
// command that reaches the network (apt's mirrors, the browser's download) up to `attempts`
// times, each bounded by `limitSeconds`, waiting longer before each retry. On 11-11 Ubuntu's
// mirrors couldn't be resolved for hours (Canonical's DNS), and `playwright install-deps` ended
// each job with exit code 100 six or seven minutes after a warning. Here a failure that
// outlasts the retries ends the step with one `::error::` line saying what failed, and that
// the mirrors were unreachable where the output says so, after about ten minutes at most for
// one call (a step can chain two).

export type Plan = {
  readonly attempts: number
  /** Each attempt's limit; a hung mirror is ended there and tried again. */
  readonly limitSeconds: number
  /** The wait before the first retry, doubled before each after it. */
  readonly firstWaitSeconds: number
  /** How long a retry waits for an apt or dpkg an ended attempt left running. */
  readonly settleSeconds: number
  /**
   * Whether an apt still running after the wait is ended, so the next attempt doesn't fail on
   * its lock: only for commands that never run dpkg (`apt-get update`, `--download-only`), and
   * never while a dpkg runs.
   */
  readonly reap?: boolean
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
export const failure = (meaning: string, retries: Plan, output = "", timedOut = false): string =>
  `::error title=Setup::${meaning}${
    unreachable.test(output)
      ? ": Ubuntu's mirrors unreachable"
      : timedOut
        ? `: no answer within ${retries.limitSeconds} s an attempt (the mirrors unreachable or slow)`
        : ""
  } (${retries.attempts} attempts, ${waits(retries).join(" s, ")} s apart)`

/**
 * Ends the apt an attempt left running, once the wait for it is over, where the plan allows
 * (`reap`): never while a dpkg runs, as ending one leaves dpkg half done. Whether none is left.
 */
export const reaped = (
  isRunning: (name: string) => boolean,
  kill: () => void,
  settle: (seconds: number) => boolean,
): boolean => {
  if (isRunning("dpkg")) return false
  kill()
  return settle(5)
}

/**
 * The download attempt's own `sh -c` wrapper, as `pgrep -f` reads its command line, with or
 * without the fallbacks' `-o` options: ended first, as an `sh` left alive could start the
 * download after its update is ended, and take the lock again. Matches that script alone.
 */
export const downloadWrapper =
  "^sh -c apt-get( -o [^ ]+)* update -qq && apt-get( -o [^ ]+)* install .*--download-only"

/**
 * The download's `sh`, then `apt-get`, `apt` and apt's fetchers, ended at once; never dpkg.
 * GitHub's hosted images may run apt's daily timers; one running dpkg would make `reaped`
 * leave everything alone, which is the safe way round.
 */
const killApt = () => {
  for (const pattern of [
    ["-f", downloadWrapper],
    ["-x", "apt-get"],
    ["-x", "apt"],
    ["-f", "^/usr/lib/apt/methods/"],
  ])
    spawnSync("sudo", ["pkill", "-KILL", ...pattern], { stdio: "ignore" })
}

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

/** How an attempt failed, which the next attempt's command may answer. */
export type Failure = {
  readonly status: number
  readonly output: string
  readonly timedOut: boolean
}

/** Whether a failure was a mirror that couldn't be reached: a name, a fetch, or no answer. */
export const unreached = ({ output, timedOut }: Failure): boolean =>
  timedOut || unreachable.test(output)

/**
 * A command, or one chosen for each attempt from the attempts that failed before it: the
 * browser packages' download turns to other mirrors where the image's can't be reached.
 */
export type Command = readonly string[] | ((failures: readonly Failure[]) => readonly string[])

/** Runs `command` as `retries` says; its status, 0 once an attempt passes. */
export const run = (meaning: string, command: Command, retries: Plan = plan): number => {
  const failures: Failure[] = []
  const pauses = waits(retries)
  let status = 1
  let output = ""
  let timedOut = true
  for (let attempt = 1; attempt <= retries.attempts; attempt += 1) {
    const [program, ...args] = bounded(
      typeof command === "function" ? command(failures) : command,
      retries.limitSeconds,
    )
    // Into a file, not a pipe: Node waits for every holder of a pipe to close it, and apt under
    // sudo, in a session of its own, outlived the limit and held it (#869 waited about 200 s
    // an attempt against a 90 s limit). A file's holders don't hold up the attempt.
    const scratch = mkdtempSync(join(tmpdir(), "novadeck-retry-"))
    const file = join(scratch, "output")
    const handle = openSync(file, "w")
    const result = spawnSync(program!, args, {
      stdio: ["ignore", handle, handle],
      // On Linux `timeout` bounds it (`bounded`); elsewhere this, which ends the command alone.
      ...(process.platform === "linux" ? {} : { timeout: retries.limitSeconds * 1000 }),
      // pnpm is a .cmd on Windows.
      shell: process.platform === "win32",
    })
    closeSync(handle)
    // Kept to read why it failed, and printed as each attempt ends.
    const said = readFileSync(file, "utf8")
    rmSync(scratch, { recursive: true, force: true })
    process.stdout.write(said)
    output += `${said}\n`
    status = result.status ?? 1
    if (status === 0) return 0
    // `timeout`'s exit, or Node's own where it bounds the attempt.
    const ranOut = status === 124 || result.error?.message.includes("ETIMEDOUT") === true
    timedOut &&= ranOut
    failures.push({ status, output: said, timedOut: ranOut })
    const why = result.error
      ? ` (${result.error.message})`
      : ` (exit ${result.status ?? result.signal})`
    const wait = pauses[attempt - 1]
    if (wait === undefined) break
    console.log(
      `::warning title=Setup::attempt ${attempt} of ${retries.attempts} failed${why}; again in ${wait} s`,
    )
    sleep(wait)
    if (process.platform === "linux" && !settled(retries.settleSeconds)) {
      if (retries.reap && reaped(running, killApt, (seconds) => settled(seconds)))
        console.log("::warning title=Setup::ended the apt the last attempt left running")
      else
        console.log("::warning title=Setup::an apt or dpkg from the last attempt is still running")
    }
  }
  console.log(failure(meaning, retries, output, timedOut))
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
