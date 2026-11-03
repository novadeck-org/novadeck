// `pnpm transcripts:shapes [--all] [--newest N] [claude|codex|agy …]`: runs each harness's
// decoder shape lists (harnesses/<harness>/src/shapes.ts) over the transcripts on this
// machine, read-only: `~/.claude` (or CLAUDE_CONFIG_DIR), `~/.codex` (or CODEX_HOME) and
// `~/.gemini/antigravity-cli`. It prints the shapes no list names, which the chat drops
// without a word, with how many lines held each and the first file one was in; `--all`
// prints every shape with its verdict. Run it before a pin bump: the e2e suite drives a fake
// model, so the shapes only real models write (thinking, server tools, images) show only
// here and in use. It prints keys and counts, never what the transcripts say.
import { statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"

type Seen = {
  readonly verdict: "read" | "skipped" | "unknown"
  lines: number
  readonly file: string
}

type Shapes = {
  readonly transcriptFiles: (agent: string, harnessHome: string) => string[]
  readonly shapesIn: (agent: string, files: readonly string[]) => Map<string, Seen>
}

// The suite's own classifiers, loaded by address as `test:e2e:install` loads its installer,
// so the scripts' typecheck stays out of the runner's sources.
const classifiers = new URL("../../backend/runner/src/e2e/shapes.ts", import.meta.url)

/** Each harness's home, as its adapter finds it (`Harness.home`). */
export const homes = (env: NodeJS.ProcessEnv, home: string): Readonly<Record<string, string>> => ({
  claude: env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
  codex: env.CODEX_HOME || join(home, ".codex"),
  agy: join(home, ".gemini", "antigravity-cli"),
})

// When a file was last written, in epoch milliseconds; 0 for one gone since it was listed.
const written = (file: string): number => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** The newest `count` of the files, by when each was last written. */
const newest = (files: readonly string[], count: number | undefined): readonly string[] => {
  if (count === undefined) return files
  return files.toSorted((a, b) => written(b) - written(a)).slice(0, count)
}

export const main = async (args: readonly string[]): Promise<void> => {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { all: { type: "boolean" }, newest: { type: "string" } },
  })
  const count = values.newest === undefined ? undefined : Number(values.newest)
  if (count !== undefined && !(Number.isInteger(count) && count > 0))
    throw new Error(`--newest takes a count of files: ${values.newest}`)
  const { transcriptFiles, shapesIn } = (await import(classifiers.href)) as Shapes
  const where = homes(process.env, homedir())
  const agents = positionals.length > 0 ? positionals : Object.keys(where)
  const unknownAgent = agents.find((agent) => !(agent in where))
  if (unknownAgent)
    throw new Error(`No harness ${unknownAgent}: use ${Object.keys(where).join(", ")}`)
  let unknown = 0
  for (const agent of agents) {
    const files = newest(transcriptFiles(agent, where[agent]!), count)
    console.log(`\n${agent}: ${files.length} transcript(s) under ${where[agent]}`)
    const seen = [...shapesIn(agent, files)].toSorted(
      ([a, one], [b, other]) => other.lines - one.lines || a.localeCompare(b),
    )
    for (const [key, { verdict, lines, file }] of seen) {
      if (verdict === "unknown") unknown += 1
      if (verdict === "unknown")
        console.log(`  unknown  ${key}  ${lines} line(s), first in ${file}`)
      else if (values.all) console.log(`  ${verdict.padEnd(7)}  ${key}  ${lines}`)
    }
    if (!seen.some(([, { verdict }]) => verdict === "unknown")) console.log("  no unknown shapes")
  }
  if (unknown > 0)
    console.log(
      `\n${unknown} unknown shape(s): add each to its harness's shapes.ts, read or skipped, and teach the decoder any it should read.`,
    )
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
