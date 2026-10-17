import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { judgeRun, parseRegister, verdictSummary } from "./match.ts"

const registerPath = "scripts/flakes/register.json"

// `node scripts/flakes/main.ts <logs dir> <verdict file> <comment file>`: judges a failed
// run's jobs against the register. The logs directory holds one `<job name>.log` per
// failed job, as the workflow downloads them. Writes the verdict's JSON for the workflow
// to act on, its summary to the job's and to the comment file, for the pull request.
// RUN_ATTEMPT, WORKFLOW and RUN_URL describe the run.
export const main = (
  logs = process.argv[2],
  verdictPath = process.argv[3],
  commentPath = process.argv[4],
): void => {
  if (!logs || !verdictPath || !commentPath)
    throw new Error("Usage: main.ts <logs dir> <verdict file> <comment file>")
  const register = parseRegister(JSON.parse(readFileSync(registerPath, "utf8")))
  const failed = readdirSync(logs)
    .filter((file) => file.endsWith(".log"))
    .toSorted()
    .map((file) => ({
      job: file.slice(0, -".log".length),
      log: readFileSync(join(logs, file), "utf8"),
    }))
  const verdict = judgeRun(register, failed, Number(process.env.RUN_ATTEMPT) || 1)
  writeFileSync(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`)
  const summary = verdictSummary(verdict, {
    workflow: process.env.WORKFLOW ?? "a run",
    run: process.env.RUN_URL ?? "",
  })
  console.log(summary)
  writeFileSync(commentPath, summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
