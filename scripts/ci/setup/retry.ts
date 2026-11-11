import { spawnSync } from "node:child_process"

// `node scripts/ci/setup/retry.ts <what failing means> -- <command> [args…]`: runs a setup
// command that reaches the network (apt's mirrors, the browser's download) up to `attempts`
// times, each bounded by `limitSeconds`, waiting longer before each retry. On 11-11 Ubuntu's
// mirrors failed for 40 minutes, and `playwright install-deps` ended each job with exit code
// 100 six or seven minutes after a warning. Here a failure that outlasts the retries ends the
// step with one `::error::` line saying what it means, after a few minutes at most.

export type Plan = {
  readonly attempts: number
  /** Each attempt's limit; a hung mirror is ended there and tried again. */
  readonly limitSeconds: number
  /** The wait before the first retry, doubled before each after it. */
  readonly firstWaitSeconds: number
}

export const plan: Plan = { attempts: 3, limitSeconds: 180, firstWaitSeconds: 30 }

/** The waits between the attempts: one fewer than the attempts, each twice the last. */
export const waits = ({ attempts, firstWaitSeconds }: Plan): readonly number[] =>
  Array.from({ length: Math.max(attempts - 1, 0) }, (_, index) => firstWaitSeconds * 2 ** index)

/** The longest the whole step can take: every attempt at its limit, and every wait. */
export const longest = (retries: Plan): number =>
  retries.attempts * retries.limitSeconds + waits(retries).reduce((sum, wait) => sum + wait, 0)

/** The line that ends a step whose every attempt failed. */
export const failure = (meaning: string, retries: Plan): string =>
  `::error title=Setup::${meaning} (${retries.attempts} attempts, ${waits(retries).join(" s, ")} s apart)`

const sleep = (seconds: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)

/**
 * The command an attempt runs. On Linux, under coreutils' `timeout`, which signals the whole
 * process group, `sudo apt-get` under pnpm and Playwright included: one left running would hold
 * dpkg's lock against the next attempt. Elsewhere as it is.
 */
export const bounded = (
  command: readonly string[],
  limitSeconds: number,
  platform: NodeJS.Platform = process.platform,
): readonly string[] =>
  platform === "linux" ? ["timeout", "--kill-after=15s", `${limitSeconds}s`, ...command] : command

/** Runs `command` as `retries` says; its status, 0 once an attempt passes. */
export const run = (meaning: string, command: readonly string[], retries: Plan = plan): number => {
  const pauses = waits(retries)
  let status = 1
  for (let attempt = 1; attempt <= retries.attempts; attempt += 1) {
    const [program, ...args] = bounded(command, retries.limitSeconds)
    const result = spawnSync(program!, args, {
      stdio: "inherit",
      // On Linux `timeout` bounds it (`bounded`); elsewhere this, which ends the command alone.
      ...(process.platform === "linux" ? {} : { timeout: retries.limitSeconds * 1000 }),
      // pnpm is a .cmd on Windows.
      shell: process.platform === "win32",
    })
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
  }
  console.log(failure(meaning, retries))
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
    const limit = Number(process.env.NOVADECK_RETRY_LIMIT)
    const retries = {
      ...plan,
      ...(process.env.NOVADECK_RETRY_FAST === "true" && { firstWaitSeconds: 0 }),
      ...(limit > 0 && { limitSeconds: limit }),
    }
    process.exitCode = run(meaning, process.argv.slice(split + 1), retries)
  }
}
