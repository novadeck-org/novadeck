import { appendFileSync, rmSync, writeFileSync } from "node:fs"

import { generatePromote, generateRelease, type Ask, type Generated } from "./generate.ts"
import { ask as askModel, clientFor as defaultClientFor, type Client } from "./model.ts"
import { renderBody } from "./render.ts"
import { Skip } from "./skip.ts"
import { gitSources, type Sources } from "./sources.ts"

const usage = "Usage: main.ts <release|promote> <tag> <out file> [--dry-run]"

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

/** The short account of a run that wrote notes, for the log and the job's summary. */
export const summaryOf = (mode: string, tag: string, generated: Generated): string => {
  const { notes, considered, outputTokens, model, dropped } = generated
  const lines = notes.highlights.length + notes.changes.length
  return [
    `Release notes for ${tag} (${mode}): ${plural(lines, "line", "lines")} from ${plural(considered, "change", "changes")}, ${plural(notes.fixes, "smaller fix", "smaller fixes")} counted. Model ${model}, ${outputTokens} output tokens.`,
    ...dropped.map((line) => `Dropped: ${line}.`),
    "",
  ].join("\n")
}

/** The account of a run that wrote nothing: the release keeps the body it has. */
export const skippedSummary = (mode: string, tag: string, skip: Skip): string =>
  `No release notes written for ${tag} (${mode}), so the release keeps its body: ${skip.message}.\n`

/**
 * `node scripts/release-notes/main.ts release <tag> <out file>`: the body for one prerelease,
 * from the commits since the release before it.
 * `node scripts/release-notes/main.ts promote <tag> <out file>`: the body for a promotion,
 * covering every release since the latest stable one.
 *
 * Whatever goes wrong with the model, its answer or `gh` writes no file and still exits 0,
 * saying why: the workflows edit a release only when the file exists, so it keeps its body.
 * A usage error or a failure of git exits non-zero. `--dry-run` prints the body and the
 * model's answer, or the reason there is no body, and writes no file. OPENROUTER_API_KEY is
 * the model's key and RELEASE_NOTES_MODEL names the model; GH_REPO and GH_TOKEN are `gh`'s, and GH_REPO also names the repository
 * the pull request links point at.
 */
export const main = async (
  args = process.argv.slice(2),
  sources: Sources = gitSources,
  clientFor: (mode: "release" | "promote") => Client = defaultClientFor,
  log: (message: string) => void = console.log,
): Promise<void> => {
  const dryRun = args.includes("--dry-run")
  const [mode, tag, out, ...rest] = args.filter((arg) => arg !== "--dry-run")
  if ((mode !== "release" && mode !== "promote") || !tag || (!out && !dryRun) || rest.length > 0)
    throw new Error(usage)
  const repo = process.env.GH_REPO ?? "novadeck-org/novadeck"
  const client = clientFor(mode)
  const ask: Ask = (kind, version, items) => askModel(client, kind, version, items)
  let summary: string
  try {
    const generated =
      mode === "release"
        ? await generateRelease(tag, sources, ask)
        : await generatePromote(tag, sources, ask, repo)
    let body: string
    try {
      body = renderBody(generated.notes, generated.original, repo, generated.compare)
    } catch (error) {
      throw new Skip(
        `The notes could not be written: ${error instanceof Error ? error.message : String(error)}`,
        generated.raw,
      )
    }
    summary = summaryOf(mode, tag, generated)
    if (dryRun) {
      log(`${summary}\n--- model answer ---\n${generated.raw}\n\n--- body ---\n${body}`)
    } else {
      writeFileSync(out!, body)
      log(summary)
    }
  } catch (error) {
    if (!(error instanceof Skip)) throw error
    summary = skippedSummary(mode, tag, error)
    // A file left from an earlier run would be taken for this run's notes.
    if (!dryRun) rmSync(out!, { force: true })
    log(dryRun && error.raw ? `${summary}\n--- model answer ---\n${error.raw}` : summary)
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
