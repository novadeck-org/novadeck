import type { ChatAnswer, Conversations } from "@novadeck/core/conversation"
import type { InboxItem } from "@novadeck/core/inbox"
import { itemIdOf, type Item } from "@novadeck/core/items"
import type { Backend, BackendSink, TerminalKey } from "@novadeck/core/port"
import type { WorkspaceSeed } from "@novadeck/core/seed"
import { sessionName } from "@novadeck/core/session-name"
import type {
  AgentStatus,
  CanvasLayout,
  Project,
  TerminalMetadata,
  Workspace,
} from "@novadeck/core/types"

import { demoHandle } from "./handles"
import { isDemoInbox } from "./inbox"
import { createDemoMessages, type DemoMailbox } from "./messages"
import { demoTerminalId, terminalSlot, type ChatAgent } from "./samples"
import { callBlock, requestBlock, resultBlock } from "./screen/agent"
import { banner } from "./screen/openings"
import { fixedIntro, type DemoIntro } from "./screen/terminal"
import { ready, svg, type SampleArtifact } from "./showcase/artifacts"
import { createShowcase } from "./showcase/simulation"
import { terminalOf } from "./terminals"
import { got, say, use, user, written, type DemoTranscript } from "./transcripts"
import type { DemoTurns } from "./turns"

// The Babcia demo: a one-off for the runner-skits video "Babcia", where a grandmother who ran a
// milk bar for forty years minds her granddaughter's deck. Nyx's project, bar-mleczny (a site
// for that milk bar), has twelve agents on the Canvas, mixing Claude Code, Codex and Antigravity,
// all at work; a second project, setlist, works beside it. The video's beats are cues the
// debug panel's "Babcia" group fires (see `BabciaCues`), so a capture plan can time each to a
// frame: three asks that fill the Inbox, a failed turn, a lead that opens three helpers, a helper's
// question to the person and the message it then sends its lead, a page shown in the pane, and
// every agent finishing. It shows nothing the app doesn't do.

const session = "initial"
const bar = "bar-mleczny"
const gig = "setlist"
const directory = (project: string): string => `~/projects/${project}`

// One of the agents: its terminal's name, the agent, what Nyx asked it, what it said it'd do,
// the command it's on, what that has printed so far, and what it says when it's done.
type Job = {
  readonly name: string
  readonly agent: ChatAgent
  readonly ask: string
  readonly plan: string
  readonly command: string
  readonly progress: string
  readonly done: string
}

// The agents of bar-mleczny, by terminal number. The ones the cues act on:
export const babcia = {
  // Asks to run its tests, once the first cue rings.
  permission: 4,
  // Fails its turn.
  failing: 5,
  // Writes up a plan to approve.
  plan: 7,
  // Asks a question and marks its own pick.
  question: 1,
  // Shows a page in the pane.
  shows: 9,
  // Opens the helpers, numbered after it.
  lead: 10,
  // The helper that asks the person what only its lead knows.
  asking: 15,
  // Asks to force-push to main, is told no, and asks again, politely.
  manners: 12,
} as const

const jobs: readonly Job[] = [
  {
    name: "Menu page",
    agent: "claude",
    ask: "Build the menu page from menu.json.",
    plan: "Rendering the sections, then checking the long names.",
    command: "pnpm build",
    progress: "Built 14 of 22 routes",
    done: "The menu page is built from menu.json, long names wrapping.",
  },
  {
    name: "Opening hours",
    agent: "codex",
    ask: "Show the opening hours, and mark today.",
    plan: "Reading how the hours are stored.",
    command: "pnpm test --filter hours",
    progress: "",
    done: "Today's hours are marked, and the filter tests pass.",
  },
  {
    name: "Photo gallery",
    agent: "agy",
    ask: "Make the photo gallery lazy-load its images.",
    plan: "Measuring the page before and after.",
    command: "pnpm lighthouse --gallery",
    progress: "Scored 3 of 8 photos",
    done: "The gallery loads its photos as they scroll into view.",
  },
  {
    name: "Order form",
    agent: "claude",
    ask: "Add the pickup order form, with a phone field.",
    plan: "The form is in. Testing it next.",
    command: "pnpm test",
    progress: "",
    done: "The order form takes a phone number, and the tests pass.",
  },
  {
    name: "Prices table",
    agent: "codex",
    ask: "Put the prices in a table that reads on a phone.",
    plan: "Laying the table out at phone width.",
    command: "pnpm test --filter prices",
    progress: "",
    done: "The prices read as a table on a phone.",
  },
  {
    name: "Map embed",
    agent: "agy",
    ask: "Embed the map, without loading it until it's asked for.",
    plan: "Swapping the embed for a click-to-load card.",
    command: "pnpm check:embeds",
    progress: "Checked 2 of 5 embeds",
    done: "The map loads only when it's clicked.",
  },
  {
    name: "Accessibility",
    agent: "claude",
    ask: "Fix the accessibility problems the audit found.",
    plan: "Going through the audit's list.",
    command: "pnpm audit:a11y",
    progress: "Fixed 6 of 11 findings",
    done: "All eleven findings are fixed.",
  },
  {
    name: "Contact form",
    agent: "codex",
    ask: "Send the contact form's messages to the bar's inbox.",
    plan: "Wiring the form to the mail service.",
    command: "pnpm test --filter contact",
    progress: "",
    done: "Contact messages reach the bar's inbox.",
  },
  {
    name: "Seasonal specials",
    agent: "claude",
    ask: "Add a section for the seasonal specials.",
    plan: "Previewing the section on the dev server.",
    command: "pnpm dev",
    progress: "Ready on http://localhost:4321",
    done: "The seasonal specials have a section of their own.",
  },
  {
    name: "Site API",
    agent: "claude",
    ask: "Set up the API the site reads its menu, hours and orders from.",
    plan: "Splitting it into three endpoints, one helper for each.",
    command: "pnpm api:dev",
    progress: "Listening on :8787",
    done: "The three endpoints answer, and the site reads from them.",
  },
  {
    name: "Menu translations",
    agent: "codex",
    ask: "Translate the menu into English.",
    plan: "Translating section by section.",
    command: "pnpm i18n:extract",
    progress: "",
    done: "The menu reads in Polish and English.",
  },
  {
    name: "Deploy preview",
    agent: "agy",
    ask: "Get the deploy preview building on every push.",
    plan: "Reading the host's build settings.",
    command: "pnpm deploy:preview",
    progress: "Uploaded 120 of 340 files",
    done: "Every push builds a preview.",
  },
]

// The three helpers the lead opens, numbered after its eleven fellows: they ask, plan and run
// like the jobs, and are led by the lead.
const helpers: readonly Job[] = [
  {
    name: "Menu endpoint",
    agent: "codex",
    ask: "Serve the menu from the API.",
    plan: "Reading menu.json into a route.",
    command: "pnpm test --filter menu-api",
    progress: "",
    done: "The menu endpoint answers.",
  },
  {
    name: "Hours endpoint",
    agent: "agy",
    ask: "Serve the opening hours from the API.",
    plan: "Writing the route for the hours.",
    command: "pnpm test --filter hours-api",
    progress: "Ran 2 of 6 checks",
    done: "The hours endpoint answers.",
  },
  {
    name: "Orders endpoint",
    agent: "claude",
    ask: "Take pickup orders in the API.",
    plan: "Writing the route that takes an order.",
    command: "pnpm test --filter orders-api",
    progress: "",
    done: "The orders endpoint takes an order.",
  },
]

// What the other project's agents are at.
const elsewhere: readonly (readonly [string, ChatAgent])[] = [
  ["Stage plot", "claude"],
  ["Merch store", "codex"],
  ["Tour dates", "agy"],
  ["Press kit", "claude"],
  ["Soundcheck notes", "codex"],
]

const allJobs: readonly Job[] = [...jobs, ...helpers]

const project = (id: string): Project => ({ id, name: id, directory: directory(id) })

const agentTerminal = (
  projectId: string,
  number: number,
  name: string,
  agent: ChatAgent,
  status: AgentStatus,
  ledBy?: string,
): TerminalMetadata => ({
  id: demoTerminalId({ projectId, workspaceSessionId: session }, number),
  name,
  directory: directory(projectId),
  command: agent,
  process: agent,
  state: "running",
  handle: demoHandle(number),
  agent: status,
  ...(ledBy ? { ledBy } : {}),
})

const working: AgentStatus = { working: true }

const keyOf = (number: number, projectId = bar): TerminalKey => ({
  projectId,
  workspaceSessionId: session,
  terminalId: demoTerminalId({ projectId, workspaceSessionId: session }, number),
})

// The Canvas: windows on a grid four across and four down, each a little off the line as windows
// end up when moved by hand. The twelve fill the first three rows but two places of the third,
// and the first of the fourth, which the camera's fit takes in: the lead (the tenth) has its
// right and the row below it empty for its three helpers, whose places `helpers` gives them.
// Each window's column and row, by its place in the list.
const cells = [
  [0, 0],
  [1, 0],
  [2, 0],
  [3, 0],
  [0, 1],
  [1, 1],
  [2, 1],
  [3, 1],
  [0, 2],
  [2, 2],
  [1, 2],
  [0, 3],
  // The helpers: beside the lead, and under it.
  [3, 2],
  [2, 3],
  [3, 3],
] as const
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
  [5, 5],
  [-5, 10],
  [10, -5],
] as const
const place = (index: number) => {
  const [dx, dy] = nudges[index]!
  const [column, row] = cells[index]!
  return {
    position: { x: column * 610 + dx, y: row * 440 + dy },
    width: 550,
    height: 380,
  }
}
const deskLayout = (): CanvasLayout => ({
  viewport: { x: 120, y: 60, zoom: 0.5 },
  geometry: Object.fromEntries(
    jobs.map((_, index) => [
      demoTerminalId({ projectId: bar, workspaceSessionId: session }, index + 1),
      place(index),
    ]),
  ),
})

const sessionOf = (now: number, terminals: TerminalMetadata[], canvasLayout?: CanvasLayout) => ({
  id: session,
  name: sessionName(now),
  terminals,
  items: [],
  windows: [],
  ...(canvasLayout && { canvasLayout }),
})

// The milk bar's project first, which the demo's transcripts and screens belong to.
export const babciaSeed = (now: number): WorkspaceSeed => ({
  projects: [
    {
      ...project(bar),
      sessions: [
        sessionOf(
          now,
          jobs.map((job, index) => agentTerminal(bar, index + 1, job.name, job.agent, working)),
          deskLayout(),
        ),
      ],
    },
    {
      ...project(gig),
      sessions: [
        sessionOf(
          now,
          elsewhere.map(([name, agent], index) =>
            agentTerminal(gig, index + 1, name, agent, working),
          ),
        ),
      ],
    },
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
    : job.agent === "codex"
      ? use(
          call,
          "exec_command",
          { cmd: job.command, workdir: `/home/nyx/projects/${bar}` },
          { kind: "run", title: "Ran", detail: job.command },
        )
      : use(
          call,
          "run_command",
          {
            CommandLine: JSON.stringify(job.command),
            Cwd: JSON.stringify(`/home/nyx/projects/${bar}`),
            toolAction: JSON.stringify(job.plan),
          },
          { kind: "run", title: "Ran", detail: job.command },
        )

// What answering a request that is declined (No) leaves: the agent waits for what Nyx says
// next. So does a chat about a question with no words.
const declined = (answer: ChatAnswer): boolean =>
  (answer.type === "choice" && answer.option === "3" && !answer.text) ||
  (answer.type === "chat" && !answer.text)

// Claude Code's dialog for a command, as harnesses/claude's probes (2.1.287) show it.
const permission = (id: string, job: Job): DemoTranscript["requests"][number] => ({
  id: `${id}:permission`,
  kind: "permission",
  tool: "Bash",
  subject: job.command,
  choices: [],
  subagent: false,
  answered: false,
  dialog: {
    type: "choices",
    id: `${id}:d`,
    detail: job.command,
    title: "Do you want to proceed?",
    options: [
      { id: "1", label: "Yes", text: null },
      {
        id: "2",
        label: `Yes, and always allow access to /home/nyx/projects/${bar} from this project`,
        text: null,
      },
      { id: "3", label: "No", text: null },
    ],
  },
})

// What each conversation holds so far: Nyx's ask, the agent's plan, and the command it's on.
// Three agents also hold what they'll ask when the cues come: the order form a permission, the
// accessibility one a plan, the menu page a question with its own pick.
export const babciaTranscripts = (now: number): Readonly<Record<string, DemoTranscript>> =>
  Object.fromEntries(
    allJobs.map((job, index) => {
      const number = index + 1
      const id = slot(number)
      const call = `${job.agent === "claude" ? "toolu" : "call"}_${id}a`
      const items = written(id, now, [user(job.ask), say(job.plan), runCall(job, call)])
      const plain: DemoTranscript = { items, requests: [] }
      if (number === babcia.permission) {
        const request = permission(id, job)
        return [
          id,
          {
            items,
            requests: [request],
            outcomes: {
              [request.id]: (answer) =>
                declined(answer)
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
                          " Test Files  6 passed (6)\n      Tests  41 passed (41)\n   Duration  2.94s",
                        ),
                      ],
                      reply: job.done,
                    },
            },
          },
        ]
      }
      if (number === babcia.plan) {
        const request = {
          id: `${id}:plan`,
          kind: "plan" as const,
          tool: "ExitPlanMode",
          subject: "Accessibility plan",
          choices: [],
          subagent: false,
          answered: false,
          // Claude Code's plan dialog, as harnesses/claude's probes (2.1.287) show it: its third
          // option is a field for what to change.
          dialog: {
            type: "choices" as const,
            id: `${id}:d`,
            title: "Ready to code?",
            detail:
              "1. Lift the contrast on the menu headings\n2. Add skip links and focus rings\n3. Label every field of the order form",
            options: [
              { id: "1", label: "Yes, auto-accept edits", text: null },
              { id: "2", label: "Yes, manually approve edits", text: null },
              { id: "3", label: "Tell Claude what to change", text: "field" as const },
            ],
          },
        }
        return [
          id,
          {
            items,
            requests: [request],
            outcomes: {
              [request.id]: (answer) =>
                answer.type === "choice" && answer.option === "3"
                  ? answer.text
                    ? { items: [], prompt: answer.text }
                    : { items: [], waits: true }
                  : { items: [], reply: job.done },
            },
          },
        ]
      }
      if (number === babcia.question) {
        const request = {
          id: `${id}:question`,
          kind: "question" as const,
          tool: "AskUserQuestion",
          subject: "How should the menu list the daily soups?",
          choices: [],
          subagent: false,
          answered: false,
          // Claude marks the option it would pick with "(Recommended)" in its label.
          dialog: {
            type: "questions" as const,
            id: `${id}:d`,
            chat: "prompt" as const,
            questions: [
              {
                id: "soups",
                header: "Soups",
                question: "How should the menu list the daily soups?",
                multiSelect: false,
                text: true,
                options: [
                  {
                    id: "line",
                    label: "One line per soup (Recommended)",
                    description: "Reads fast, and matches the rest of the menu.",
                  },
                  {
                    id: "card",
                    label: "A card per soup",
                    description: "Room for a photo, but the page gets long.",
                  },
                  {
                    id: "day",
                    label: "Grouped by weekday",
                    description: "Follows the chalkboard, but needs the days kept up to date.",
                  },
                ],
              },
            ],
          },
        }
        return [
          id,
          {
            items,
            requests: [request],
            outcomes: {
              [request.id]: (answer, dialog) => {
                // Chatting about the question instead picks nothing: the agent takes the
                // person's words as its next prompt, or waits for them.
                if (answer.type === "chat")
                  return answer.text
                    ? { items: [], prompt: answer.text }
                    : { items: [], waits: true }
                const labels = new Map(
                  dialog.type === "questions"
                    ? dialog.questions.flatMap((each) =>
                        each.options.map((option) => [option.id, option.label] as const),
                      )
                    : [],
                )
                const said =
                  answer.type === "questions"
                    ? answer.answers
                        .flatMap((each) => [
                          ...each.options.map((option) => labels.get(option) ?? option),
                          ...(each.text ? [each.text] : []),
                        ])
                        .join(", ")
                        .replace(/ \(Recommended\)/g, "")
                        .toLowerCase()
                    : ""
                return { items: [], reply: `Going with: ${said}. ${job.done}` }
              },
            },
          },
        ]
      }
      return [id, plain]
    }),
  )

// What each of the milk bar's agents shows on its screen as the demo opens: its banner, Nyx's
// ask, and the command it's running with what it has printed so far: no plan between, so the
// banner naming the agent stays on screen in a small window.
export const babciaIntroOf = (
  terminal: TerminalMetadata,
  key: TerminalKey,
): DemoIntro | undefined => {
  if (key.projectId !== bar) return undefined
  const job = allJobs[Number(terminalSlot(terminal.id)) - 1]
  if (!job) return undefined
  const tool = job.agent === "codex" ? "Ran" : "Bash"
  return fixedIntro([
    banner(job.agent, terminal.directory),
    requestBlock(job.agent, job.ask),
    // Antigravity's banner is five rows tall, so what it ran stays off its small window: its
    // name and model, which the banner is for, would scroll out of sight under it.
    ...(job.agent === "agy"
      ? []
      : [
          callBlock(job.agent, tool, job.command),
          ...(job.progress ? [resultBlock([job.progress], job.agent)] : []),
        ]),
  ])
}

// The mail between the milk bar's terminals: every one takes part, and none has yet written.
const mailbox = (): DemoMailbox => {
  const target = { projectId: bar, workspaceSessionId: session }
  return {
    target,
    terminals: allJobs.map((_, index) => ({
      terminalId: demoTerminalId(target, index + 1),
      handle: demoHandle(index + 1),
      agent: true,
    })),
    threads: [],
  }
}

// The page the seasonal-specials agent shows in the pane: its dev server's, as a snapshot. A
// proper site half built: the layout and type are in, the dish photo is still a placeholder.
const paper = "#faf7f2"
const ink = "#1d2433"
const muted = "#6b7280"
const rule = "#e7e1d6"
const accent = "#b4532a"
const sans = 'font-family="Helvetica, Arial, sans-serif"'
const serif = 'font-family="Georgia, serif"'
const mono = 'font-family="Menlo, Consolas, monospace"'
// The page 800 by 584, the shape of the pane beside its window in the 1280x720 window the
// launch video is captured in, so the pane is filled there (elsewhere it scrolls or leaves a band).
const page = (body: string): string => svg(1600, 1168, body, 584)
// A line of text the layout holds a place for: a grey bar.
const blank = (x: number, y: number, width: number): string =>
  `<rect x="${x}" y="${y}" width="${width}" height="9" rx="4.5" fill="#e4ddd0"/>`
const dish = (y: number, name: string, about: string, price: string): string =>
  `<text x="56" y="${y}" ${sans} font-size="15" font-weight="700" fill="${ink}">${name}</text>` +
  `<text x="440" y="${y}" ${sans} font-size="15" font-weight="700" fill="${ink}" text-anchor="end">${price}</text>` +
  `<text x="56" y="${y + 18}" ${sans} font-size="12" fill="${muted}">${about}</text>` +
  `<line x1="56" y1="${y + 32}" x2="440" y2="${y + 32}" stroke="${rule}"/>`
const preview: SampleArtifact = {
  item: {
    id: "bar-specials-preview",
    kind: "page",
    name: "localhost:4321",
    detail: "Dev server preview",
    path: null,
    url: "http://localhost:4321/",
    lines: null,
    held: false,
  },
  content: ready({
    kind: "page",
    url: "http://localhost:4321/",
    shown: 1,
    live: false,
    snapshot: page(
      `<rect width="800" height="584" fill="${paper}"/>` +
        // The header: the bar's mark and name, the links, and the one button.
        `<rect width="800" height="60" fill="#ffffff"/>` +
        `<line x1="0" y1="60" x2="800" y2="60" stroke="${rule}"/>` +
        `<circle cx="70" cy="30" r="13" fill="none" stroke="${accent}" stroke-width="2.5"/>` +
        `<path d="M64 36 L64 27 Q70 20 76 27 L76 36 Z" fill="${accent}"/>` +
        `<text x="94" y="37" ${serif} font-size="21" font-weight="700" fill="${ink}">Milk Bar</text>` +
        `<text x="470" y="35" ${sans} font-size="13" fill="${muted}">Menu</text>` +
        `<text x="524" y="35" ${sans} font-size="13" fill="${muted}">Hours</text>` +
        `<text x="580" y="35" ${sans} font-size="13" fill="${muted}">Find us</text>` +
        `<rect x="646" y="16" width="112" height="30" rx="15" fill="${accent}"/>` +
        `<text x="702" y="35" ${sans} font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">Order ahead</text>` +
        // The specials.
        `<text x="56" y="100" ${sans} font-size="11" font-weight="700" letter-spacing="2" fill="${accent}">THIS MONTH</text>` +
        `<text x="56" y="136" ${serif} font-size="32" fill="${ink}">Seasonal specials</text>` +
        `<text x="56" y="160" ${sans} font-size="13" fill="${muted}">Cooked every morning, served until they run out.</text>` +
        dish(
          198,
          "Beet soup with dumplings",
          "Clear and ruby red, with mushroom dumplings.",
          "¤1,640",
        ) +
        dish(250, "Potato pancakes", "Crisp at the edges, with sour cream.", "¤1,950") +
        dish(
          302,
          "Sweet cheese crêpes",
          "Folded, browned in butter, dusted with sugar.",
          "¤1,720",
        ) +
        dish(354, "Rhubarb compote", "Lorem ipsum dolor sit amet.", "¤680") +
        // The dish photo, not in yet: the layout's placeholder.
        `<rect x="490" y="92" width="254" height="214" rx="10" fill="#efe9de" stroke="#cfc6b4" stroke-dasharray="6 5"/>` +
        `<line x1="490" y1="92" x2="744" y2="306" stroke="#d9d1c1"/>` +
        `<line x1="744" y1="92" x2="490" y2="306" stroke="#d9d1c1"/>` +
        `<rect x="554" y="186" width="126" height="26" rx="4" fill="${paper}"/>` +
        `<text x="617" y="203" ${mono} font-size="11" fill="${muted}" text-anchor="middle">specials-hero.jpg</text>` +
        `<text x="490" y="334" ${sans} font-size="13" font-weight="700" fill="${ink}">Open weekdays, 8 to 17</text>` +
        `<text x="490" y="354" ${sans} font-size="12" fill="${muted}">Closed weekends and holidays.</text>` +
        // The everyday menu below, laid out but not written yet.
        `<rect y="400" width="800" height="184" fill="#f3eee5"/>` +
        `<text x="56" y="440" ${sans} font-size="11" font-weight="700" letter-spacing="2" fill="${accent}">EVERY DAY</text>` +
        [56, 296, 536]
          .map(
            (x) =>
              `<rect x="${x}" y="456" width="208" height="100" rx="8" fill="#ffffff" stroke="${rule}"/>` +
              blank(x + 16, 476, 120) +
              blank(x + 16, 498, 176) +
              blank(x + 16, 514, 150) +
              blank(x + 16, 536, 44),
          )
          .join(""),
    ),
  }),
}

// The question the asking helper puts to the person: only its lead can answer it.
const helperAskId = "babcia-helper-ask"
const helperAsk = (helper: number, now: number): InboxItem => ({
  id: helperAskId,
  source: {
    projectId: bar,
    workspaceSessionId: session,
    terminalId: demoTerminalId({ projectId: bar, workspaceSessionId: session }, helper),
    handle: demoHandle(helper),
    agent: helpers[helper - jobs.length - 1]!.agent,
    title: helpers[helper - jobs.length - 1]!.name,
    projectName: bar,
  },
  at: now,
  stopped: false,
  seen: false,
  kind: "ask",
  ask: {
    subject: "Which API does the site call?",
    body: "The orders route has to match what the site sends. I can't tell from the code which API it talks to: the old one or the new one. I'd rather not guess.",
    details: null,
    hardToUndo: null,
    shape: { type: "text" },
  },
})

// The two asks of the agent with manners: the same agent, one after the other. Its harness
// (Antigravity) ships Novadeck's `ask` as Claude Code's and Codex's do.
const mannersIds = { rude: "babcia-rude-ask", polite: "babcia-polite-ask" } as const
const mannersAsks = {
  rude: {
    subject: "Can I force-push to main?",
    body: "The preview branch has fallen behind main, and a normal push is rejected.",
  },
  polite: {
    subject: "Could I open a pull request instead, please?",
    body: "I would push to a branch of its own and leave main as it is.",
  },
} as const
const yesOrNo = ["Yes", "No"].map((label) => ({
  label,
  summary: null,
  details: null,
  code: null,
}))
const mannersAsk = (kind: keyof typeof mannersIds, now: number): InboxItem => {
  const job = jobs[babcia.manners - 1]!
  return {
    id: mannersIds[kind],
    source: {
      projectId: bar,
      workspaceSessionId: session,
      terminalId: demoTerminalId({ projectId: bar, workspaceSessionId: session }, babcia.manners),
      handle: demoHandle(babcia.manners),
      agent: job.agent,
      title: job.name,
      projectName: bar,
    },
    at: now,
    stopped: false,
    seen: false,
    kind: "ask",
    ask: {
      ...mannersAsks[kind],
      details: null,
      hardToUndo: null,
      shape: { type: "options", options: yesOrNo, recommend: null },
    },
  }
}

// How long after the person's No the same agent asks again, politely.
export const politeAfterMs = 1000

// How long the lead takes to answer its helper once the doorbell rang it awake.
const answersMs = 1500

// How far apart the agents finish, so the Canvas turns green in a ripple.
const rippleMs = 60
const finishesAfterMs = 200

// The video's beats, one cue each, for the debug panel's "Babcia" group to fire at the frame
// a capture wants (see `babciaGroups`). Each does nothing twice, nor before it can: a cue
// already fired, or one whose ground isn't there yet (the helper's ask before the helpers
// open), is ignored. `finishAll` leaves an agent waiting on the person to wait, as it would:
// the cues that make it ask are for the person to answer first.
export type BabciaCues = {
  // A permission ("Run `pnpm test`?"), a plan to approve and a question with the agent's pick:
  // the Inbox's badge reads 3. Each can be rung alone.
  readonly asks: () => void
  readonly permission: () => void
  readonly plan: () => void
  readonly question: () => void
  // One agent's turn ends in an error: a Trouble row, and its line goes red.
  readonly fail: () => void
  // The lead opens three helper terminals, which its team wire draws to, and rests while they
  // work.
  readonly helpers: () => void
  // The agent with manners asks to force-push to main (an Ask row, Yes or No). Told No, its
  // turn goes on, and a moment later it asks, politely, to open a pull request instead; told
  // Yes to that, it works on.
  readonly manners: () => void
  // A helper asks the person what only its lead knows. Answered from the Inbox, it writes to
  // its lead; the idle lead, rung awake, works and answers it.
  readonly helperAsks: () => void
  // The seasonal-specials agent shows its page in the pane beside its window.
  readonly show: () => void
  // Every agent of both projects ends its turn, one after another, but the ones still waiting
  // on the person: an unanswered request or a helper's unanswered ask.
  readonly finishAll: () => void
}

const cuesOf = new WeakMap<Backend, BabciaCues>()

/** The cues of a backend `createBabcia` made, however wrapped. Nothing for any other. */
export const babciaCuesOf = (backend: Backend): BabciaCues | undefined => cuesOf.get(backend)

// The Babcia demo's parts, for `plainDemo` to put round the demo's own: `under` the
// conversations (the seed, its mail, its pane, and a view of the workspace and the sink), `wrap`
// round them (an agent that is answered or told goes back to work, and works until it finishes),
// and `over` the whole (the cues). The helper's ask, once the person's answer reaches it, goes
// on to its lead.
export const createBabcia = (turns: DemoTurns, now: number) => {
  const messages = createDemoMessages([mailbox()], false, (target, terminalId) =>
    latest === undefined ? true : terminalOf(latest, { ...target, terminalId }) !== undefined,
  )
  const showcase = createShowcase({
    agents: [],
    shown: [
      {
        key: keyOf(babcia.shows),
        handle: demoHandle(babcia.shows),
        artifacts: [preview],
      },
    ],
  })
  let latest: Workspace | undefined
  let sink: BackendSink | undefined
  const terminal = (number: number): TerminalMetadata | undefined =>
    terminalOf(latest, keyOf(number))

  const work = (key: TerminalKey): void => {
    const found = terminalOf(latest, key)
    if (found?.state === "running" && found.agent) turns.work(key, found)
  }

  // A cue that acts on one terminal's agent, if it's there.
  const on = (number: number, act: (key: TerminalKey, found: TerminalMetadata) => void): void => {
    const found = terminal(number)
    if (found) act(keyOf(number), found)
  }
  const asks = new Set<string>()
  const ask = (number: number, kind: "permission" | "plan" | "question"): void => {
    if (asks.has(kind)) return
    on(number, (key, found) => {
      asks.add(kind)
      turns.ask(key, found, kind, 1)
    })
  }
  // The agents the person told no, or whose words they took without going on: they wait at
  // their prompt for the person's next words, and no cue ends a turn for them.
  const declinedIds = new Set<string>()
  let opened = false
  let asked = false
  let answered = false
  let failed = false
  let shown = false
  // Where the agent with manners is: not yet asked, on its first ask, between the No and its
  // second ask, on its second, or done with both.
  let manners: "idle" | "rude" | "between" | "polite" | "done" = "idle"
  // Whether the helper and its lead have had their exchange out: the lead's reply landed, or
  // a stop ended it.
  let exchanged = false

  const cues: BabciaCues = {
    permission: () => ask(babcia.permission, "permission"),
    plan: () => ask(babcia.plan, "plan"),
    question: () => ask(babcia.question, "question"),
    asks: () => {
      cues.permission()
      cues.plan()
      cues.question()
    },
    fail: () => {
      if (failed) return
      on(babcia.failing, (key, found) => {
        failed = true
        // Cue 6 leaves it as it is from now, though its turn ends only after a moment.
        declinedIds.add(found.id)
        // As Codex records a turn the API cut short: its `task_complete` carries the error, and
        // the agent said nothing. The message is the one harnesses/codex/src/failures.test.ts
        // uses for such a turn.
        turns.finish(key, found, "failed", { after: finishesAfterMs, error: "stream disconnected" })
      })
    },
    helpers: () => {
      if (opened || !sink) return
      opened = true
      const lead = demoHandle(babcia.lead)
      sink.dispatch(
        helpers.map((job, index) => ({
          type: "terminal/add" as const,
          target: { projectId: bar, workspaceSessionId: session },
          terminal: agentTerminal(bar, jobs.length + index + 1, job.name, job.agent, working, lead),
          // At the desk's window size, in the places beside and under the lead, wherever the
          // person's selection is.
          canvasGeometry: place(jobs.length + index),
          anchor: keyOf(babcia.lead).terminalId,
          select: false,
        })),
      )
      on(babcia.lead, (key, found) => turns.rest(key, found))
    },
    manners: () => {
      if (manners !== "idle" || !terminal(babcia.manners)) return
      const inbox = backendInbox()
      if (!inbox) return
      manners = "rude"
      inbox.add(mannersAsk("rude", Date.now()))
    },
    helperAsks: () => {
      // Its helper has to be there to ask.
      if (asked || !opened) return
      const inbox = backendInbox()
      if (!inbox) return
      asked = true
      inbox.add(helperAsk(babcia.asking, Date.now()))
    },
    show: () => {
      if (shown || !sink) return
      shown = true
      const holder = keyOf(babcia.shows)
      const item: Item = {
        id: itemIdOf(preview.item.id),
        holder: { terminalId: holder.terminalId },
        kind: "page",
        name: preview.item.name,
        detail: preview.item.detail,
        path: null,
        url: preview.item.url,
        lines: null,
        held: false,
        by: "agent",
        from: { terminalId: holder.terminalId, handle: demoHandle(babcia.shows) },
        version: 1,
        // The agent opens it for the person, as the show tool does.
        asked: true,
        shownAt: Date.now(),
        plan: null,
      }
      sink.dispatch([{ type: "item/upsert", target: holder, item }])
    },
    finishAll: () => {
      if (!latest) return
      let count = 0
      for (const each of latest.projects)
        for (const history of each.history)
          for (const found of history.state.roster.terminals) {
            if (found.state !== "running") continue
            const key = {
              projectId: each.id,
              workspaceSessionId: history.id,
              terminalId: found.id,
            }
            if (waitsOnPerson(found)) continue
            const job = each.id === bar ? allJobs[Number(terminalSlot(found.id)) - 1] : undefined
            turns.finish(key, found, "completed", {
              after: finishesAfterMs + count * rippleMs,
              reply: job?.done ?? "Done. Everything is in, and the checks pass.",
            })
            count += 1
          }
    },
  }

  // The final backend's Inbox, which the cues add the helper's ask to.
  let inboxOf: (() => Backend["inbox"]) | undefined
  const backendInbox = () => {
    const inbox = inboxOf?.()
    return isDemoInbox(inbox) ? inbox : undefined
  }

  // Whether cue 6 leaves an agent as it is: it ended its turn already (a failed one stays failed
  // until the person prompts it again, which takes it back to work), it waits on a request, was
  // told no, or it is the helper whose ask is open or whose answer is on its way, or the lead
  // that helper is to write to: neither can say what it hasn't been asked.
  const waitsOnPerson = (found: TerminalMetadata): boolean => {
    if (found.state !== "running") return true
    const { agent } = found
    if (agent?.attention || declinedIds.has(found.id)) return true
    if (agent?.lastTurn && !agent.working) return true
    if (
      found.id === keyOf(babcia.manners).terminalId &&
      (manners === "rude" || manners === "between" || manners === "polite")
    )
      return true
    if (!asked || exchanged) return false
    return (
      found.id === keyOf(babcia.asking).terminalId || found.id === keyOf(babcia.lead).terminalId
    )
  }

  // The helper's ask closed with no answer reaching it (the reply was not delivered, or the
  // item was cleared): it waits for the person's words at its prompt, as an agent told no does,
  // and cue 6 no longer holds it or its lead.
  const released = (): void => {
    if (!asked || exchanged) return
    exchanged = true
    declinedIds.add(keyOf(babcia.asking).terminalId)
    on(babcia.asking, (key, found) => turns.rest(key, found))
  }

  // The helper's answer reaches the helper, which the Inbox's record of it says: only then does
  // the helper write to its lead, of what it was told. The idle lead, rung awake, works, and
  // answers.
  const relay = (told: string): void => {
    const target = { projectId: bar, workspaceSessionId: session }
    const helper = demoHandle(babcia.asking)
    const lead = demoHandle(babcia.lead)
    const said = told.trim()
    const quoted = said
      ? `Nyx's answer: "${said}"${/[.!?…]$/.test(said) ? "" : "."}`
      : "Nyx had nothing to add."
    const leadKey = keyOf(babcia.lead)
    const sent = messages.send(
      target,
      helper,
      lead,
      `${quoted} Do you know which API the site calls? I need it for the orders route.`,
      () => {
        work(leadKey)
        // The lead answers unless the person took it some other way meanwhile, as Escape does.
        const epoch = turns.epoch(leadKey)
        setTimeout(() => {
          if (turns.epoch(leadKey) !== epoch) {
            exchanged = true
            return
          }
          const replied = messages.send(
            target,
            lead,
            helper,
            "The site calls the new API, on port 8787. The old one is retired.",
            () => {
              exchanged = true
            },
            () => {
              exchanged = true
            },
          )
          if (!replied) exchanged = true
        }, answersMs)
      },
      () => {
        exchanged = true
      },
    )
    // Refused, as the lead closed: nothing is on its way to wait for.
    if (!sent) exchanged = true
  }
  const answerLetter = `answer:${helperAskId}`
  messages.state.subscribe(() => {
    if (answered) return
    const letter = Object.values(messages.state.getSnapshot().terminals)
      .flatMap((each) => each.threads)
      .flatMap((thread) => thread.messages)
      .find((each) => each.id === answerLetter && each.state !== "queued")
    if (!letter) return
    if (letter.state !== "delivered") return released()
    answered = true
    relay(letter.text)
  })
  // The Inbox clears the helper's ask with no answer made: nothing will reach the helper.
  const watchInbox = (inbox: NonNullable<ReturnType<typeof backendInbox>>): void => {
    inbox.state.subscribe(() => {
      if (!asked || answered || exchanged) return
      const { items, answering } = inbox.state.getSnapshot()
      if (answering[helperAskId] || items.some((item) => item.id === helperAskId)) return
      const answerMade = Object.values(messages.state.getSnapshot().terminals)
        .flatMap((each) => each.threads)
        .some((thread) => thread.messages.some((each) => each.id === answerLetter))
      if (!answerMade) released()
    })
  }

  // The agent with manners: its answer, once the mail has delivered it. Told No to the first
  // ask, its turn carries on (an answered ask is a tool result) and it asks again; told No to
  // the second, it waits for the person's words; anything else, it works on.
  const mannersKey = keyOf(babcia.manners)
  const heard = (kind: "rude" | "polite", told: string): void => {
    const said = told.split("\n")[0]!.trim()
    if (kind === "polite" && said === "No") {
      manners = "done"
      declinedIds.add(mannersKey.terminalId)
      on(babcia.manners, (key, found) => turns.rest(key, found))
      return
    }
    work(mannersKey)
    if (kind === "polite" || said !== "No") {
      manners = "done"
      return
    }
    manners = "between"
    const epoch = turns.epoch(mannersKey)
    setTimeout(() => {
      // Not if the person took the agent some other way meanwhile, as Escape does.
      const inbox = backendInbox()
      if (turns.epoch(mannersKey) !== epoch || !inbox) {
        manners = "done"
        return
      }
      manners = "polite"
      inbox.add(mannersAsk("polite", Date.now()))
    }, politeAfterMs)
  }
  const mannersLetter = (kind: "rude" | "polite") =>
    Object.values(messages.state.getSnapshot().terminals)
      .flatMap((each) => each.threads)
      .flatMap((thread) => thread.messages)
      .find((each) => each.id === `answer:${mannersIds[kind]}`)
  // An ask whose answer will not reach the agent: it waits for the person's words, as one told
  // no does.
  const abandoned = (): void => {
    manners = "done"
    declinedIds.add(mannersKey.terminalId)
    on(babcia.manners, (key, found) => turns.rest(key, found))
  }
  messages.state.subscribe(() => {
    if (manners !== "rude" && manners !== "polite") return
    const letter = mannersLetter(manners)
    if (!letter || letter.state === "queued") return
    if (letter.state !== "delivered") return abandoned()
    heard(manners, letter.text)
  })
  const watchManners = (inbox: NonNullable<ReturnType<typeof backendInbox>>): void => {
    inbox.state.subscribe(() => {
      if (manners !== "rude" && manners !== "polite") return
      const { items, answering } = inbox.state.getSnapshot()
      const id = mannersIds[manners]
      if (answering[id] || items.some((item) => item.id === id)) return
      if (!mannersLetter(manners)) abandoned()
    })
  }

  return {
    transcripts: babciaTranscripts(now),
    // The seed with its mail and pane, and a view of the workspace and the sink.
    under: (backend: Backend): Backend => ({
      ...backend,
      seed: babciaSeed(now),
      messages,
      companions: showcase,
      commit: (workspace, actions) => {
        latest = workspace
        backend.commit(workspace, actions)
        // A terminal that closed turns what waits for it into gone messages.
        messages.refresh()
      },
      start: (next) => {
        sink = next
        const stop = backend.start?.(next)
        return () => {
          stop?.()
          if (sink === next) sink = undefined
        }
      },
    }),
    // An agent that has been answered or told goes back to work, and works until the cue that
    // finishes it: unless it was told no, and waits for Nyx.
    wrap: (conversations: Conversations): Conversations => ({
      ...conversations,
      send: async (key, text) => {
        await conversations.send(key, text)
        // Prompted again, it is at work, and cue 6 ends its turn like any other's.
        declinedIds.delete(key.terminalId)
        work(key)
      },
      answer: async (key, request, answer) => {
        // Claude Code's plan dialog takes words only in its third option, which needs them
        // (harnesses/claude's dialogs refuse the others, as dialogs.test.ts has it).
        if (request === `${slot(babcia.plan)}:plan` && answer.type === "choice") {
          const words = (answer.text ?? "").trim() !== ""
          if (answer.option === "3" ? !words : words)
            throw new Error("Couldn't answer that here. Answer it in the terminal.")
        }
        await conversations.answer(key, request, answer)
        // Told no, or chatting about a question without words: it waits for the person's next
        // words, and no cue ends a turn for it.
        if (declined(answer)) {
          declinedIds.add(key.terminalId)
          return
        }
        declinedIds.delete(key.terminalId)
        work(key)
      },
    }),
    // The cues belong to the backend returned, and add to its Inbox.
    over: (backend: Backend): Backend => {
      const wrapped = backend
      inboxOf = () => wrapped.inbox
      const own = backendInbox()
      if (own) {
        watchInbox(own)
        watchManners(own)
      }
      cuesOf.set(wrapped, cues)
      return wrapped
    },
  }
}
