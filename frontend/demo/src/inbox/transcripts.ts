import type { WorkspaceSeed } from "@novadeck/core/seed"

import {
  got,
  say,
  use,
  user,
  written,
  type DemoDraft,
  type DemoTranscript,
} from "../agents/transcripts"
import { demoHandle } from "../handles"
import { partyOf, type DemoSessionMessages } from "../messages"
import { demoTerminalId } from "../samples"

// A line of the demo agent's own code. Put together here, so the repository's import scanner
// (scripts/packages) doesn't read the sample as this file's imports.
const sampleImport = (names: string, from: string): string => `import ${names} from "${from}"`

// What the Inbox demo's agents outside the storefront did before their row came, by
// `projectId/slot`, so each row's sheet has the person's words and the steps since, as
// each harness records them: Claude Code's Edit, Write and Bash with its `Exit code` on a
// failure, Codex's exec_command with its `Process exited with code` header, and
// Antigravity's edit_file and run_command, which says `The command exited with code`. The
// storefront's agents keep the agents demo's own transcripts.

const session = "initial"

// Codex's exec_command result, as its rollout records it.
const exec = (code: number, output: string): string =>
  `Chunk ID: 4f1a\nWall time: 1.2 seconds\nProcess exited with code ${code}\nOriginal token count: 12\nOutput:\n${output}\n`

const edit = (call: string, path: string, before: string, after: string): DemoDraft =>
  use(
    call,
    "Edit",
    { file_path: path, old_string: before, new_string: after },
    { kind: "write", title: "Edited", detail: path.replace(/^.*\/(?=[^/]+\/[^/]+\/[^/]+$)/, "…/") },
  )
const bash = (call: string, command: string): DemoDraft =>
  use(call, "Bash", { command }, { kind: "run", title: "Ran", detail: command })
const codexRun = (call: string, cmd: string): DemoDraft =>
  use(call, "exec_command", { cmd }, { kind: "run", title: "Ran", detail: cmd })

const root = "/Users/alex/projects"

// Antigravity's step result, and how it says a command ended.
const agyStep = (content: string): string =>
  `Created At: 2026-10-27T10:49:09+01:00\nCompleted At: 2026-10-27T10:49:10+01:00\n${content}`
const agyExited = (code: number, output: string): string =>
  `\nThe command exited with code ${code}.\nStdout:\n${output}\nStderr:\n\n`
const agyEdit = (call: string, path: string, target: string, replacement: string): DemoDraft =>
  use(
    call,
    "edit_file",
    { Path: `${root}/api-service/${path}`, Target: target, Replacement: replacement },
    { kind: "write", title: "Edited", detail: `…/${path}` },
  )
const agyRun = (call: string, command: string): DemoDraft =>
  use(call, "run_command", { CommandLine: command }, { kind: "run", title: "Ran", detail: command })

// The api-service agent that hit its usage limit got its task from its lead, the
// project's first terminal: Novadeck's doorbell line is its prompt, the brief a message.
const inboxLead = {
  projectId: "api-service",
  lead: 1,
  worker: 6,
  brief: "measure ping lag across 40 runs and plot it",
} as const

// The storefront's first terminal leads two of its agents, so the Grants list can say which
// of a team the grant's holders are at work.
const storefrontCrew = { projectId: "storefront", lead: 1, workers: [3, 4] } as const

const leadDrafts: readonly DemoDraft[] = [
  user("[Novadeck: automatic notice, agent messages waiting, Q7mT2c]"),
  bash("toolu_i61", "pnpm bench ping-lag --runs 40"),
  got("toolu_i61", "warming up…\nping-lag: p50 12 ms, p95 31 ms\n40 runs"),
  use(
    "toolu_i62",
    "Write",
    {
      file_path: `${root}/api-service/bench/ping-lag.csv`,
      content: Array.from({ length: 40 }, (_, run) => `${run + 1},${12 + (run % 7)}`).join("\n"),
    },
    { kind: "write", title: "Wrote", detail: "…/api-service/bench/ping-lag.csv" },
  ),
  got("toolu_i62", `File created successfully at: ${root}/api-service/bench/ping-lag.csv`),
  say("The numbers are in; plotting them next."),
]

const drafts: Readonly<Record<string, readonly DemoDraft[]>> = {
  // Waits for the person to log the Vercel CLI in, its deploy having failed for it.
  "docs-site/01": [
    user("deploy a preview of the docs site, then port the API reference to MDX"),
    bash("toolu_d11", "pnpm build:docs"),
    got("toolu_d11", "vite v8.0.3 building for production…\n✓ built 412 pages in 38s"),
    bash("toolu_d12", "vercel deploy --prebuilt"),
    got(
      "toolu_d12",
      "Exit code 1\nVercel CLI 48.2.0\nError: No existing credentials found. Please run `vercel login`.",
    ),
    edit(
      "toolu_d13",
      `${root}/docs-site/src/content/api/index.mdx`,
      "# API\n\nSee the reference below.",
      "# API reference\n\nEvery endpoint, its parameters and an example.\n\n<Endpoints />",
    ),
    got("toolu_d13", `The file ${root}/docs-site/src/content/api/index.mdx has been updated.`),
  ],
  [`${inboxLead.projectId}/0${inboxLead.worker}`]: leadDrafts,
  // Its turn failed on an overloaded API, after its edit and test run.
  "api-service/03": [
    user("make the webhook handler idempotent: dedupe by the event's id"),
    edit(
      "toolu_a31",
      `${root}/api-service/src/webhooks/handler.ts`,
      "export const handle = async (event: Event) => {\n  await apply(event)\n}",
      "export const handle = async (event: Event) => {\n  if (await seen(event.id)) return\n  await apply(event)\n  await remember(event.id)\n}",
    ),
    got("toolu_a31", `The file ${root}/api-service/src/webhooks/handler.ts has been updated.`),
    bash("toolu_a32", "pnpm test webhooks"),
    got("toolu_a32", " ✓ src/webhooks/handler.test.ts (12 tests)\n Tests  12 passed (12)"),
  ],
  // Codex waits to push, its rebase and tests done.
  "api-service/04": [
    user("rebase the webhook branch on main and push it"),
    codexRun("call_a41", "git fetch origin && git rebase origin/main"),
    got("call_a41", exec(0, "Successfully rebased and updated refs/heads/webhooks.")),
    codexRun("call_a42", "pnpm test"),
    got("call_a42", exec(0, " Test Files  9 passed (9)\n      Tests  48 passed (48)")),
    codexRun("call_a43", "git push origin main"),
  ],
  // Antigravity, stuck on the same failing test between its edits.
  "api-service/05": [
    user("fix the invoice totals: they round after tax, not before"),
    agyEdit("step:2", "src/invoices/totals.ts", "round(net + tax)", "round(net) + round(tax)"),
    got("step:2", agyStep(`Made 1 replacement in ${root}/api-service/src/invoices/totals.ts.`)),
    agyRun("step:4", "pnpm test invoices"),
    got("step:4", agyStep(agyExited(1, " FAIL  totals › rounds before tax\n Tests  1 failed (1)"))),
    agyEdit(
      "step:6",
      "src/invoices/totals.ts",
      "round(net) + round(tax)",
      "round(net + round(tax))",
    ),
    got("step:6", agyStep(`Made 1 replacement in ${root}/api-service/src/invoices/totals.ts.`)),
    agyRun("step:8", "pnpm test invoices"),
    got("step:8", agyStep(agyExited(1, " FAIL  totals › rounds before tax\n Tests  1 failed (1)"))),
  ],
  // Stopped at its limit with the cold start halved.
  "api-service/01": [
    user("profile the cold start and get it under 300 ms"),
    bash("toolu_a11", "node --cpu-prof dist/server.js"),
    got("toolu_a11", "listening on :8080 after 612 ms\nWrote cold-start.cpuprofile"),
    edit(
      "toolu_a12",
      `${root}/api-service/src/server.ts`,
      [
        sampleImport("{ pdf }", "./pdf"),
        sampleImport("{ mailer }", "./mailer"),
        sampleImport("{ search }", "./search"),
      ].join("\n"),
      `const pdf = () => ${"import"}("./pdf")`,
    ),
    got("toolu_a12", `The file ${root}/api-service/src/server.ts has been updated.`),
  ],
  // Asks how the date tests should run, its first test failing on the time zone.
  "infra/01": [
    user("set up tests for the date helpers before we change them"),
    use(
      "toolu_f11",
      "Write",
      {
        file_path: `${root}/infra/src/dates/format.test.ts`,
        content: Array.from({ length: 24 }, (_, line) => `// case ${line + 1}`).join("\n"),
      },
      { kind: "write", title: "Wrote", detail: "…/src/dates/format.test.ts" },
    ),
    got("toolu_f11", `File created successfully at: ${root}/infra/src/dates/format.test.ts`),
    bash("toolu_f12", "pnpm vitest run src/dates"),
    got(
      "toolu_f12",
      "Exit code 1\n FAIL  src/dates/format.test.ts > formats in the person's zone\nAssertionError: expected '14:17' to be '13:17'\n Tests  1 failed | 23 passed (24)",
    ),
  ],
}

export const inboxTranscripts = (now: number): Readonly<Record<string, DemoTranscript>> =>
  Object.fromEntries(
    Object.entries(drafts).map(([key, each]) => [
      key,
      { items: written(key, now, each), requests: [] },
    ]),
  )

// The Inbox demo's workspace, its worker led by its lead, as the backend says of a
// terminal an agent opened with a brief.
export const withInboxLead = (seed: WorkspaceSeed): WorkspaceSeed => ({
  ...seed,
  projects: seed.projects.map((project) =>
    project.id === storefrontCrew.projectId
      ? {
          ...project,
          sessions: project.sessions.map((each) => ({
            ...each,
            terminals: each.terminals.map((terminal) =>
              storefrontCrew.workers.some(
                (number) =>
                  terminal.id ===
                  demoTerminalId({ projectId: project.id, workspaceSessionId: each.id }, number),
              )
                ? {
                    ...terminal,
                    ledBy: demoHandle(storefrontCrew.lead),
                    openedBy: demoHandle(storefrontCrew.lead),
                  }
                : terminal,
            ),
          })),
        }
      : project.id !== inboxLead.projectId
        ? project
        : {
            ...project,
            sessions: project.sessions.map((each) => ({
              ...each,
              terminals: each.terminals.map((terminal) =>
                terminal.id ===
                demoTerminalId(
                  { projectId: project.id, workspaceSessionId: each.id },
                  inboxLead.worker,
                )
                  ? {
                      ...terminal,
                      ledBy: demoHandle(inboxLead.lead),
                      openedBy: demoHandle(inboxLead.lead),
                    }
                  : terminal,
              ),
            })),
          },
  ),
})

// The lead's brief, delivered as its worker's turn began: just before its transcript's
// first record, as `written` times them.
export const inboxLeadMessages = (now: number): DemoSessionMessages => {
  const target = { projectId: inboxLead.projectId, workspaceSessionId: session }
  const lead = demoHandle(inboxLead.lead)
  const worker = demoHandle(inboxLead.worker)
  const at = now - leadDrafts.length * 30_000 - 1_000
  return {
    target,
    terminals: [
      { terminalId: demoTerminalId(target, inboxLead.lead), handle: lead, agent: true },
      { terminalId: demoTerminalId(target, inboxLead.worker), handle: worker, agent: true },
    ],
    threads: [
      {
        id: "demo-inbox-lead",
        between: [lead, worker],
        hops: 1,
        messages: [
          {
            id: "demo-inbox-brief",
            hop: 1,
            from: partyOf(lead),
            to: partyOf(worker),
            text: inboxLead.brief,
            sentAt: at - 2_000,
            state: "delivered",
            deliveredAt: at,
          },
        ],
      },
    ],
  }
}
