import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// The required gates of the E2E and Quality workflows, run as Actions runs them: the script of
// their "Require Every Planned Job" step, taken from the workflow, under bash with the step's
// environment. The plans' tests run them with each outcome a job can have.

const workflows = join(import.meta.dirname, "..", "..", "..", ".github", "workflows")

/** The script of the gate step of a workflow, as bash gets it: its indentation taken off. */
export const gateScript = (workflow: string): string => {
  const lines = readFileSync(join(workflows, workflow), "utf8").split("\n")
  const step = lines.findIndex((line) => line.trim() === "- name: Require Every Planned Job")
  const run = lines.findIndex((line, index) => index > step && line.trim() === "run: |")
  if (step < 0 || run < 0) throw new Error(`${workflow} has no gate step with a script`)
  const body: string[] = []
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= lines[run]!.search(/\S/)) break
    body.push(line)
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)))
  return body.map((line) => line.slice(indent)).join("\n")
}

/** Whether a workflow's gate passes with the step's environment `env`, and what it said. */
export const runGate = (
  workflow: string,
  env: Readonly<Record<string, string>>,
): { passed: boolean; said: string } => {
  // As Actions runs a `run` step on Linux: bash, stopping at the first failure.
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", gateScript(workflow)],
    {
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    },
  )
  return { passed: result.status === 0, said: `${result.stdout}${result.stderr}`.trim() }
}
