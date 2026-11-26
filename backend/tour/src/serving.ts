import { execFile } from "node:child_process"
import { createServer } from "node:net"

import type { Serving } from "./brief.js"

// How the seed's dev server is run here: by Node (`dev.mjs`) or Python 3 (`dev.py`), whichever
// answers first, on a free port of this computer's own address.

/** The interpreters tried in turn, with the dev server's file each one runs. */
const interpreters = [
  { program: "node", file: "dev.mjs" },
  { program: "python3", file: "dev.py" },
  { program: "python", file: "dev.py" },
] as const

/**
 * What a program answers to `--version` in the environment `env` (its PATH decides which is
 * found), or none where it isn't there or can't be run in time.
 */
export type Probe = (program: string, env?: NodeJS.ProcessEnv) => Promise<string | undefined>

/**
 * The program of that name on the PATH of `env`, by its absolute path, trying `extensions` on
 * Windows, or undefined where there is none (the runner's `findProgram`).
 */
export type FindProgram = (
  name: string,
  options: { readonly env: NodeJS.ProcessEnv; readonly extensions: readonly string[] },
) => string | undefined

/** Asks the real program, found on the PATH of `env` by `findProgram`, with a short deadline. */
export const versionOf =
  (findProgram: FindProgram): Probe =>
  (program, env = process.env) =>
    new Promise((resolve) => {
      // By its absolute path, as the person's terminals find it; `.exe` alone on Windows, where a
      // `.cmd` doesn't run without a shell.
      const found = findProgram(program, { env, extensions: [".exe"] })
      if (found === undefined) return resolve(undefined)
      execFile(
        found,
        ["--version"],
        { env, timeout: 5_000, windowsHide: true },
        (error, out, err) =>
          // Python 2 printed its version on stderr.
          resolve(error ? undefined : `${out}${err}`.trim()),
      )
    })

// Whether the answer is the interpreter the dev server's file needs: Node's (`v26.9.0`) or
// Python 3's (`Python 3.12.1`). Windows' Store alias for `python` answers nothing like it.
const answers = (program: string, said: string | undefined): boolean =>
  said !== undefined && (program === "node" ? /^v\d+\./.test(said) : said.startsWith("Python 3."))

/** The free port of 127.0.0.1 the operating system gives, released again at once. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No port was given.")),
      )
    })
  })

/**
 * How to start the dev server, or none where no interpreter runs: Node, else Python 3 as
 * `python3`, else as `python`, each judged by its answer to `--version`.
 */
export const findServing = async (
  probe: Probe,
  port: () => Promise<number> = freePort,
  env?: NodeJS.ProcessEnv,
): Promise<Serving | null> => {
  for (const { program, file } of interpreters) {
    // eslint-disable-next-line no-await-in-loop -- Tried in turn: the first that runs wins.
    if (!answers(program, await probe(program, env))) continue
    // eslint-disable-next-line no-await-in-loop -- Reached once, by the interpreter that runs.
    const number = await port().catch(() => undefined)
    if (number === undefined) return null
    return {
      command: `${program} ${file} ${number}`,
      url: `http://127.0.0.1:${number}/`,
    }
  }
  return null
}
