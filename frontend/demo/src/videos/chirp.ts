import type { TerminalKey } from "@novadeck/core/port"
import type { WorkspaceSeed } from "@novadeck/core/seed"
import { sessionName } from "@novadeck/core/session-name"
import type { AgentStatus, CanvasLayout, Project, TerminalMetadata } from "@novadeck/core/types"

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
import { demoTerminalId, terminalSlot } from "../samples"
import { callBlock, requestBlock, resultBlock, textBlock } from "../screen/agent"
import { banner } from "../screen/openings"
import { fixedIntro, type DemoIntro } from "../screen/terminal"

// The Chirp demo: a one-off for the runner-skits video "Chirp", where a runner hunts the one
// agent waiting on her among the dozens she left running overnight, and finds it here. Her
// desk's project runs twelve agents, laid out on the Canvas, all working but one, which waits
// for her to allow a command; answered from its screen, it gets back to work. It shows nothing
// the app doesn't do.

const session = "initial"
const desk = "night-shift"

type Agent = "claude" | "codex"

// One of her agents: its terminal's name, the agent, what she asked it, what it said it'd do,
// the command it's on, and what that has printed so far.
type Job = {
  readonly name: string
  readonly agent: Agent
  readonly ask: string
  readonly plan: string
  readonly command: string
  readonly progress: string
}

// Her desk's agents, by terminal number. The eleventh waits: Claude Code, asking to run its
// tests, in its own words. Codex's asks, plans and commands are short, with no output yet, so its
// boxed banner stays in its window.
export const chirpWaiting = 11

const jobs: readonly Job[] = [
  {
    name: "Ledger migration",
    agent: "claude",
    ask: "Move the ledger to the new schema overnight.",
    plan: "Running the migration against a copy first.",
    command: "pnpm db:migrate --dry-run",
    progress: "Migrated 41 of 64 tables",
  },
  {
    name: "Drone firmware",
    agent: "codex",
    ask: "Move the drone build to new tools.",
    plan: "Rebuilding with the new toolchain.",
    command: "make firmware TARGET=drone",
    progress: "",
  },
  {
    name: "Price feed",
    agent: "claude",
    ask: "The price feed drops ticks under load. Find out why.",
    plan: "Replaying last night's feed to reproduce it.",
    command: "pnpm replay --feed prices",
    progress: "Replayed 1.2M of 3.4M ticks",
  },
  {
    name: "Flaky tests",
    agent: "claude",
    ask: "Fix the flaky tests in the payments suite.",
    plan: "Running the suite fifty times to catch them.",
    command: "pnpm test --repeat 50 payments",
    progress: "Run 23 of 50 · 2 flaky so far",
  },
  {
    name: "Auth refactor",
    agent: "codex",
    ask: "Split auth into tokens and sessions.",
    plan: "Moving the token code out first.",
    command: "pnpm typecheck",
    progress: "",
  },
  {
    name: "Backup job",
    agent: "codex",
    ask: "Make the nightly backup resumable.",
    plan: "Testing a backup that stops halfway.",
    command: "pnpm backup --resume-test",
    progress: "",
  },
  {
    name: "Docs rewrite",
    agent: "claude",
    ask: "Rewrite the setup docs for the new install.",
    plan: "Following the docs on a clean machine.",
    command: "pnpm docs:check",
    progress: "Checked 9 of 14 pages",
  },
  {
    name: "Search index",
    agent: "claude",
    ask: "Rebuild the search index with the new ranking.",
    plan: "Reindexing, then comparing the top results.",
    command: "pnpm search:reindex",
    progress: "Indexed 820k of 1.9M documents",
  },
  {
    name: "Image resizer",
    agent: "codex",
    ask: "Cut the image resizer's memory use.",
    plan: "Profiling a batch of large images.",
    command: "pnpm resize:bench",
    progress: "",
  },
  {
    name: "Rate limits",
    agent: "claude",
    ask: "Find out who keeps hitting the rate limits.",
    plan: "Grouping last night's 429s by client.",
    command: "pnpm logs:query --status 429",
    progress: "Read 3 of 7 log shards",
  },
  {
    name: "Cache warmer",
    agent: "claude",
    ask: "Warm the cache for the morning rush.",
    plan: "The warmer is in. Testing it next.",
    command: "pnpm test --filter cache",
    progress: "",
  },
  {
    name: "Release notes",
    agent: "codex",
    ask: "Draft the release notes from this week's merges.",
    plan: "Reading the merged changes.",
    command: "git log --merges --since=1.week",
    progress: "",
  },
]

// The other projects on her desk, their agents at work too.
const elsewhere: Readonly<Record<string, readonly [string, Agent][]>> = {
  "ice-breaker": [
    ["Scanner", "claude"],
    ["Benchmarks", "codex"],
    ["Release notes", "claude"],
    ["Fuzzing", "codex"],
    ["Profiling", "claude"],
    ["Changelog", "claude"],
  ],
  "black-market": [
    ["Checkout", "codex"],
    ["Wishlist", "claude"],
    ["Coupons", "codex"],
    ["Fraud checks", "claude"],
    ["Price alerts", "codex"],
  ],
}

const project = (id: string): Project => ({ id, name: id, directory: `~/projects/${id}` })

// A terminal of a project, by its number there, with `agent` in it in the state `status`.
const agentTerminal = (
  projectId: string,
  number: number,
  name: string,
  agent: Agent,
  status: AgentStatus,
): TerminalMetadata => ({
  id: demoTerminalId({ projectId, workspaceSessionId: session }, number),
  name,
  directory: `~/projects/${projectId}`,
  command: agent,
  process: agent,
  state: "running",
  handle: demoHandle(number),
  agent: status,
})

const waiting: AgentStatus = { working: true, attention: { kind: "permission", count: 1 } }

// The open session was visited just now; the others a while before.
const sessionOf = (
  now: number,
  terminals: TerminalMetadata[],
  canvasLayout?: CanvasLayout,
  visitedAt = now,
) => ({
  id: session,
  name: sessionName(now),
  visitedAt,
  terminals,
  items: [],
  windows: [],
  ...(canvasLayout && { canvasLayout }),
})

// Her desk on the canvas: four across and three down, each a little off the line, as windows end
// up when moved by hand. The camera starts back far enough to see them all where the session opens
// on the Canvas; switched to from another view, the Canvas fits them itself.
const nudges = [
  [0, 10],
  [25, -15],
  [-10, 20],
  [15, 0],
  [-20, 5],
  [10, 25],
  [0, -10],
  [-15, 15],
  [20, -5],
  [-5, 20],
  [15, 10],
  [-10, -15],
] as const
const deskLayout = (): CanvasLayout => ({
  viewport: { x: 85, y: 91, zoom: 0.62 },
  geometry: Object.fromEntries(
    jobs.map((_, index) => {
      const [dx, dy] = nudges[index % nudges.length]!
      return [
        demoTerminalId({ projectId: desk, workspaceSessionId: session }, index + 1),
        {
          position: { x: (index % 4) * 610 + dx, y: Math.floor(index / 4) * 440 + dy },
          width: 550,
          height: 380,
        },
      ]
    }),
  ),
})

// Her desk's project first, which the demo's transcripts and screens belong to.
export const chirpSeed = (now: number): WorkspaceSeed => ({
  projects: [
    {
      ...project(desk),
      sessions: [
        sessionOf(
          now,
          jobs.map((job, index) =>
            agentTerminal(
              desk,
              index + 1,
              job.name,
              job.agent,
              index + 1 === chirpWaiting ? waiting : { working: true },
            ),
          ),
          deskLayout(),
        ),
      ],
    },
    ...Object.entries(elsewhere).map(([id, list], place) => ({
      ...project(id),
      sessions: [
        sessionOf(
          now,
          list.map(([name, agent], index) =>
            agentTerminal(id, index + 1, name, agent, { working: true }),
          ),
          undefined,
          now - (place + 1) * 20 * 60_000,
        ),
      ],
    })),
  ],
})

const slot = (number: number): string => String(number).padStart(2, "0")

// The call an agent's harness names its command run with.
const runCall = (job: Job, call: string) =>
  job.agent === "claude"
    ? use(
        call,
        "Bash",
        { command: job.command, description: job.plan },
        { kind: "run", title: "Ran", detail: job.command },
      )
    : use(
        call,
        "exec_command",
        { cmd: job.command, workdir: `/home/nyx/projects/${desk}` },
        { kind: "run", title: "Ran", detail: job.command },
      )

// What the waiting agent did before it asked, as Claude Code records it (its paths shortened as the
// harness's decoder does), so its Inbox sheet shows its steps between her ask and the command.
const warmerSteps = (id: string): DemoDraft[] => {
  const home = `/home/nyx/projects/${desk}`
  const steps = [
    {
      tool: "Write",
      input: {
        file_path: `${home}/src/cache/warmer.ts`,
        content: `export const warm = async (keys: string[]) => {\n  await Promise.all(keys.map((key) => cache.fill(key)))\n}`,
      },
      run: { kind: "write", title: "Wrote", detail: "…/src/cache/warmer.ts" },
      result: `File created successfully at: ${home}/src/cache/warmer.ts`,
    },
    {
      tool: "Edit",
      input: {
        file_path: `${home}/src/jobs/schedule.ts`,
        old_string: `nightly(backup)`,
        new_string: `nightly(backup)\nat("05:30", () => warm(hotKeys))`,
      },
      run: { kind: "write", title: "Edited", detail: "…/src/jobs/schedule.ts" },
      result: `The file ${home}/src/jobs/schedule.ts has been updated successfully.`,
    },
    {
      tool: "Bash",
      input: { command: "pnpm typecheck", description: "Check the warmer's types" },
      run: { kind: "run", title: "Ran", detail: "pnpm typecheck" },
      result: "Done in 2.4s",
    },
  ] as const
  return steps.flatMap((step, index) => {
    const call = `toolu_${id}s${index + 1}`
    return [use(call, step.tool, step.input, step.run), got(call, step.result)]
  })
}

// What each conversation holds so far: her ask, the agent's plan, and the command it's on;
// the one that waits asks to run its command, and once allowed reports the tests passed.
export const chirpTranscripts = (now: number): Readonly<Record<string, DemoTranscript>> =>
  Object.fromEntries(
    jobs.map((job, index) => {
      const id = slot(index + 1)
      const call = `${job.agent === "claude" ? "toolu" : "call"}_${id}a`
      const asks = index + 1 === chirpWaiting
      const items = written(id, now, [
        user(job.ask),
        ...(asks ? warmerSteps(id) : []),
        say(job.plan),
        runCall(job, call),
      ])
      if (!asks) return [id, { items, requests: [] }]
      const transcript: DemoTranscript = {
        items,
        requests: [
          {
            id: `${id}:permission`,
            kind: "permission",
            tool: "Bash",
            subject: job.command,
            // As the harness reports a command: the dialog holds the answers.
            choices: [],
            subagent: false,
            answered: false,
            dialog: {
              type: "choices",
              id: `${id}:d`,
              detail: job.command,
              // Claude Code's dialog for a command, as harnesses/claude's probes (2.1.287) show it:
              // its title and Yes and No are its own; the second option's wording varies with the
              // command, and the probes have it for commands that touch a folder.
              title: "Do you want to proceed?",
              options: [
                { id: "1", label: "Yes", text: null },
                {
                  id: "2",
                  label: `Yes, and always allow access to /home/nyx/projects/${desk} from this project`,
                  text: null,
                },
                { id: "3", label: "No", text: null },
              ],
            },
          },
        ],
        outcomes: {
          [`${id}:permission`]: (answer) =>
            // No stops the turn, and Claude Code waits for her to say what instead.
            answer.type === "choice" && answer.option === "3"
              ? {
                  items: [
                    got(
                      call,
                      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
                    ),
                  ],
                  waits: true,
                }
              : {
                  items: [
                    got(
                      call,
                      " Test Files  4 passed (4)\n      Tests  52 passed (52)\n   Duration  3.81s",
                    ),
                  ],
                  reply: "The cache holds under the morning load. Done.",
                },
        },
      }
      return [id, transcript]
    }),
  )

// What each of her desk's agents shows on its screen as the demo opens: its banner, her ask,
// its plan, and the command it's running with what it has printed so far. The one that waits
// shows its command, and its request under it.
export const chirpIntroOf = (
  terminal: TerminalMetadata,
  key: TerminalKey,
): DemoIntro | undefined => {
  if (key.projectId !== desk) return undefined
  const job = jobs[Number(terminalSlot(terminal.id)) - 1]
  if (!job) return undefined
  const tool = job.agent === "claude" ? "Bash" : "Ran"
  return fixedIntro([
    banner(job.agent, terminal.directory),
    requestBlock(job.agent, job.ask),
    textBlock(job.plan),
    callBlock(job.agent, tool, job.command),
    ...(job.progress ? [resultBlock([job.progress])] : []),
  ])
}
