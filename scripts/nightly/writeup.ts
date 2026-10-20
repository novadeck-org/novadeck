import { cleanLog, readLog } from "../flakes/match.ts"
import { ask, type Answer, type Client, type Question } from "../openrouter/ask.ts"
import { Skip } from "../openrouter/skip.ts"

// A model's guess at why a night failed, for the tracking issue (report.ts): from each failed
// job's log, its failed tests with their errors and the harness versions it installed. It
// leads, it doesn't decide: the issue keeps the failed jobs as facts, and says whose words
// these are. With no key, a failed call or an answer that isn't what was asked, there is none.

/** A failed job's log, as Actions keeps it. */
export type JobLog = { readonly job: string; readonly log: string }

/** What the model is asked to return. */
export type Writeup = { readonly cause: string; readonly evidence: readonly string[] }

const schema = {
  type: "object",
  properties: {
    cause: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
  },
  required: ["cause", "evidence"],
  additionalProperties: false,
}

// Bounds on what is read, so a night of many failures stays one cheap question.
const testsPerJob = 6
const reportChars = 800
const messageChars = 40_000

const system = `You read the failures of a nightly CI run of Novadeck, a desktop terminal app
that runs AI coding agents (Claude Code, Codex, Antigravity) in its terminals. The nightly E2E
runs each agent harness's newest release against a fake model, and the probes record how each
harness behaves; pull requests run the pinned versions, which pass. So a failure here is most
often a harness's new release changing something the tests rely on: a tool renamed or refused,
a screen or dialog drawn differently, a hook or setting changed. It may also be a flaky test or
a change in Novadeck itself.

Say what most likely broke, in at most three plain sentences in "cause": name the harness and
version when the logs show one, and what changed for it, as the errors show it. In "evidence",
quote or name up to five short lines from the logs that support it, each with its job. Don't
guess beyond the logs; when they don't show a cause, say so in "cause". Write for an engineer
who will fix it. No headings, no markdown beyond inline code.`

/** The harness versions a job installed, as the installer prints them: `claude 2.1.304: …`. */
export const versionsOf = (log: string): string[] => [
  ...new Set(
    cleanLog(log).flatMap((line) => {
      const match = /^(claude|codex|agy) (\d[\w.+-]*): /.exec(line.trim())
      return match ? [`${match[1]} ${match[2]}`] : []
    }),
  ),
]

/** What the model reads: each job by name, its versions, and its failed tests' first reports. */
export const userMessage = (workflow: string, logs: readonly JobLog[]): string => {
  const blocks = logs.map(({ job, log }) => {
    const { failures, unreadable } = readLog(log)
    const versions = versionsOf(log)
    const tests = failures
      .slice(0, testsPerJob)
      .map(({ test, reports }) => `- ${test}\n${(reports[0] ?? "").slice(0, reportChars)}`)
    return [
      `## ${job}`,
      versions.length ? `Installed: ${versions.join(", ")}` : "",
      tests.length
        ? tests.join("\n")
        : `No failed test in its log.${unreadable.length ? ` ${unreadable.slice(0, 3).join("; ")}` : ""}`,
      failures.length > testsPerJob
        ? `…and ${failures.length - testsPerJob} more failed tests.`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  })
  // Each job an equal share, so the first few can't crowd out the rest.
  const share = Math.floor(messageChars / Math.max(blocks.length, 1))
  return `Workflow: ${workflow}\n\n${blocks.map((block) => block.slice(0, share)).join("\n\n")}`
}

/** The answer as a `Writeup`, or a `Skip` saying where it broke. */
export const parseWriteup = (text: string): Writeup => {
  let json: unknown
  try {
    // Some models wrap JSON in a code fence whatever they are told.
    json = JSON.parse(text.trim().replace(/^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/, "$1"))
  } catch {
    throw new Skip("The answer was not JSON", text)
  }
  const { cause, evidence } = (json ?? {}) as { cause?: unknown; evidence?: unknown }
  if (
    typeof cause !== "string" ||
    !cause.trim() ||
    !Array.isArray(evidence) ||
    !evidence.every((line) => typeof line === "string")
  )
    throw new Skip("The answer had the wrong shape", text)
  return {
    cause: cause.trim(),
    evidence: evidence.map((line: string) => line.trim()).filter(Boolean),
  }
}

/** The writeup as the issue shows it, saying whose words these are. */
export const render = (writeup: Writeup, model: string): string =>
  [
    "### Likely cause",
    "",
    `> Written by a model (\`${model}\`) from the failed tests' errors: a lead to check, not a verdict.`,
    "",
    writeup.cause,
    ...(writeup.evidence.length
      ? ["", ...writeup.evidence.slice(0, 5).map((line) => `- ${line}`)]
      : []),
  ].join("\n")

/** The model the writeup asks unless NIGHTLY_REPORT_MODEL names another: a cheap one. */
export const defaultModel = "deepseek/deepseek-v4-pro"

export const clientFor = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Client => ({
  fetch,
  apiKey: env.OPENROUTER_API_KEY?.trim() || undefined,
  model: env.NIGHTLY_REPORT_MODEL?.trim() || defaultModel,
  timeout: 120_000,
})

export const question = (workflow: string, logs: readonly JobLog[]): Question => ({
  title: "Novadeck nightly report",
  system,
  user: userMessage(workflow, logs),
  schema: { name: "nightly_writeup", json: schema },
  // The model reasons before it answers, and its reasoning counts: 2,000 ran out first.
  maxTokens: 8_000,
})

/** The writeup for a failed night's logs, rendered, or `Skip` with the reason there is none. */
export const writeup = async (
  client: Client,
  workflow: string,
  logs: readonly JobLog[],
  asking: (client: Client, question: Question) => Promise<Answer> = ask,
): Promise<string> => {
  if (logs.length === 0) throw new Skip("No failed job's log to read")
  const answer = await asking(client, question(workflow, logs))
  return render(parseWriteup(answer.text), answer.model)
}
