import type { ChatAnswer } from "@novadeck/core/conversation"
import type { TerminalKey } from "@novadeck/core/port"
import type { Store } from "@novadeck/core/store"
import type { AgentStatus, Project, TerminalMetadata } from "@novadeck/core/types"

import { demoHandle } from "./handles"
import type { DemoSessionMessages } from "./messages"
import { demoTerminalId, terminalSlot, type ChatAgent } from "./samples"
import { callBlock, requestBlock, resultBlock } from "./screen/agent"
import { banner } from "./screen/openings"
import type { Block } from "./screen/screen"
import { fixedIntro, type DemoIntro } from "./screen/terminal"
import { got, say, use, user, written, type DemoTranscript } from "./transcripts"

// What the one-off desk demos for videos (`babcia.ts`, `launch.ts`) share: a project of
// agents each at its own job, as terminals, as a conversation's first calls, as what their
// screens open on, and as the messages between them.

export const session = "initial"

export const directory = (project: string): string => `~/projects/${project}`

// A call a Claude Code or Codex agent made before the command it's on, as its harness records
// it: the tool, its input, what its screen shows it called on (a path, a command), its title as
// the harness's decoder gives it ("Wrote", "Edited", "Ran"), and its result. Antigravity's
// window has no room for them under its banner, as for its command.
export type DeskStep = {
  readonly tool: string
  readonly input: Readonly<Record<string, unknown>>
  readonly arg: string
  readonly title: "Wrote" | "Edited" | "Ran"
  readonly result: string
}

// A step's detail as the decoder writes it: a file by its last three segments (the harnesses'
// `shortPath`), a command as it is.
const detailOf = ({ input, arg }: DeskStep): string => {
  const path = input["file_path"]
  if (typeof path !== "string") return arg
  const parts = path.split("/").filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path
}

// One of the agents: its terminal's name, the agent, what the person asked it, what it said
// it'd do, the command it's on, what that has printed so far, and what it says when it's done;
// and any calls it made first, which its screen and an Inbox sheet show.
export type Job = {
  readonly name: string
  readonly agent: ChatAgent
  readonly ask: string
  readonly plan: string
  readonly command: string
  readonly progress: string
  readonly done: string
  readonly before?: readonly DeskStep[]
  // What its command prints once the person allows it, where it asks to run it: a test run's
  // summary, unless said.
  readonly ran?: string
}

export const project = (id: string): Project => ({ id, name: id, directory: directory(id) })

export const working: AgentStatus = { working: true }

export const agentTerminal = (
  projectId: string,
  number: number,
  name: string,
  agent: ChatAgent,
  status: AgentStatus,
  ledBy?: string,
  // The terminal's lead also opened it, which gave the agent its brief as a message.
  opened = false,
): TerminalMetadata => ({
  id: demoTerminalId({ projectId, workspaceSessionId: session }, number),
  name,
  directory: directory(projectId),
  command: agent,
  process: agent,
  state: "running",
  handle: demoHandle(number),
  agent: status,
  ...(ledBy ? { ledBy, ...(opened ? { openedBy: ledBy } : {}) } : {}),
})

export const deskKey = (projectId: string, number: number): TerminalKey => ({
  projectId,
  workspaceSessionId: session,
  terminalId: demoTerminalId({ projectId, workspaceSessionId: session }, number),
})

export const slot = (number: number): string => String(number).padStart(2, "0")

// The call an agent's harness names its command run with, in the project's folder `home`.
export const runCall = (job: Job, call: string, home: string) =>
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
          { cmd: job.command, workdir: home },
          { kind: "run", title: "Ran", detail: job.command },
        )
      : use(
          call,
          "run_command",
          {
            CommandLine: JSON.stringify(job.command),
            Cwd: JSON.stringify(home),
            toolAction: JSON.stringify(job.plan),
          },
          { kind: "run", title: "Ran", detail: job.command },
        )

// What answering a request that is declined (No) leaves: the agent waits for what the person
// says next. So does a chat about a question with no words.
export const declined = (answer: ChatAnswer): boolean =>
  (answer.type === "choice" && answer.option === "3" && !answer.text) ||
  (answer.type === "chat" && !answer.text)

// What each of a project's agents shows on its screen as the demo opens: its banner, the
// person's ask, and the command it's running with what it has printed so far: no plan
// between, so the banner naming the agent stays on screen in a small window. An agent that
// `liveOf` gives a store of blocks prints those under its command instead of its fixed
// progress, and its screen follows the store as it changes (Antigravity's, whose small window
// shows no command, stays as it is).
export const deskIntroOf =
  (
    projectId: string,
    jobs: readonly Job[],
    promptOf: (number: number, job: Job) => string = (_, job) => job.ask,
    liveOf?: (number: number, job: Job) => Store<readonly Block[]> | undefined,
  ) =>
  (terminal: TerminalMetadata, key: TerminalKey): DemoIntro | undefined => {
    if (key.projectId !== projectId) return undefined
    const number = Number(terminalSlot(terminal.id))
    const job = jobs[number - 1]
    if (!job) return undefined
    const tool = job.agent === "codex" ? "Ran" : "Bash"
    // Antigravity's banner is five rows tall, so what it ran stays off its small window: its
    // name and model, which the banner is for, would scroll out of sight under it.
    const head = [
      banner(job.agent, terminal.directory),
      requestBlock(job.agent, promptOf(number, job)),
      ...(job.agent === "agy"
        ? []
        : [
            ...(job.before ?? []).map((step) => callBlock(job.agent, step.tool, step.arg)),
            callBlock(job.agent, tool, job.command),
          ]),
    ]
    const live = job.agent === "agy" ? undefined : liveOf?.(number, job)
    if (live) {
      let made: { readonly tail: readonly Block[]; readonly blocks: readonly Block[] } | undefined
      return {
        getSnapshot: () => {
          const tail = live.getSnapshot()
          if (made?.tail !== tail) made = { tail, blocks: [...head, ...tail] }
          return made.blocks
        },
        subscribe: live.subscribe,
      }
    }
    return fixedIntro([
      ...head,
      ...(job.agent !== "agy" && job.progress ? [resultBlock([job.progress], job.agent)] : []),
    ])
  }

// The messages between a project's terminals: every one takes part, and none has yet written.
export const deskMessages = (projectId: string, count: number): DemoSessionMessages => {
  const target = { projectId, workspaceSessionId: session }
  return {
    target,
    terminals: Array.from({ length: count }, (_, index) => ({
      terminalId: demoTerminalId(target, index + 1),
      handle: demoHandle(index + 1),
      agent: true,
    })),
    threads: [],
  }
}

// The agents that hold a request for the cues to raise: the numbers of the ones that ask to run
// their command, each in its own harness's words, the one with a plan to approve (its subject
// and numbered steps), and the one with a question, its options the first of which carries
// "(Recommended)" as its own pick.
export type DeskAsks = {
  readonly permissions: readonly number[]
  readonly plan: { readonly number: number; readonly subject: string; readonly steps: string }
  readonly question: {
    readonly number: number
    readonly id: string
    readonly header: string
    readonly question: string
    readonly options: readonly {
      readonly id: string
      readonly label: string
      readonly description: string
    }[]
  }
}

// The dialog for a command: Claude Code's, as harnesses/claude's probes (2.1.287) show it, or
// Codex's, as harnesses/codex's adapter reads it (its probe, 0.159.3). Either way its third
// option declines; Codex's takes the person's words as the next prompt.
const permission = (id: string, job: Job, home: string): DemoTranscript["requests"][number] => ({
  id: `${id}:permission`,
  kind: "permission",
  tool: "Bash",
  subject: job.command,
  choices: [],
  subagent: false,
  answered: false,
  dialog:
    job.agent === "codex"
      ? {
          type: "choices",
          id: `${id}:d`,
          detail: job.command,
          title: "Would you like to run the following command?",
          options: [
            { id: "1", label: "Yes, proceed", text: null },
            {
              id: "2",
              label: `Yes, and don't ask again for commands that start with \`${job.command}\``,
              text: null,
            },
            { id: "3", label: "No, and tell Codex what to do differently", text: "prompt" },
          ],
        }
      : {
          type: "choices",
          id: `${id}:d`,
          detail: job.command,
          title: "Do you want to proceed?",
          options: [
            { id: "1", label: "Yes", text: null },
            {
              id: "2",
              label: `Yes, and always allow access to ${home} from this project`,
              text: null,
            },
            { id: "3", label: "No", text: null },
          ],
        },
})

// What a command an agent was allowed prints, as its harness records the result.
const ranOf = (job: Job): string =>
  job.ran ?? " Test Files  6 passed (6)\n      Tests  41 passed (41)\n   Duration  2.94s"

/** What each conversation holds so far: the person's ask, the agent's plan, and the command it's
 * on. Some agents also hold what they'll ask when the cues come: a permission, a plan, a
 * question with its own pick. */
export const deskTranscripts = (
  now: number,
  allJobs: readonly Job[],
  home: string,
  asks: DeskAsks,
  // What an agent's conversation opens on: the person's ask, unless a lead briefed it.
  promptOf: (number: number, job: Job) => string = (_, job) => job.ask,
): Readonly<Record<string, DemoTranscript>> =>
  Object.fromEntries(
    allJobs.map((job, index) => {
      const number = index + 1
      const id = slot(number)
      const call = `${job.agent === "claude" ? "toolu" : "call"}_${id}a`
      const items = written(id, now, [
        user(promptOf(number, job)),
        ...(job.agent === "agy" ? [] : (job.before ?? [])).flatMap((step, at) => [
          use(`${call}${at}`, step.tool, step.input, {
            kind: step.title === "Ran" ? "run" : "write",
            title: step.title,
            detail: detailOf(step),
          }),
          got(`${call}${at}`, step.result),
        ]),
        say(job.plan),
        runCall(job, call, home),
      ])
      const plain: DemoTranscript = { items, requests: [] }
      if (asks.permissions.includes(number)) {
        const request = permission(id, job, home)
        return [
          id,
          {
            items,
            requests: [request],
            outcomes: {
              [request.id]: (answer) =>
                answer.type === "choice" && answer.option === "3" && answer.text
                  ? { items: [], prompt: answer.text }
                  : declined(answer)
                    ? // Codex aborts the turn and records no result; Claude Code records its refusal.
                      job.agent === "codex"
                      ? { items: [], waits: true }
                      : {
                          items: [
                            got(
                              call,
                              "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
                            ),
                          ],
                          waits: true,
                        }
                    : { items: [got(call, ranOf(job))], reply: job.done },
            },
          },
        ]
      }
      if (number === asks.plan.number) {
        const request = {
          id: `${id}:plan`,
          kind: "plan" as const,
          tool: "ExitPlanMode",
          subject: asks.plan.subject,
          choices: [],
          subagent: false,
          answered: false,
          // Claude Code's plan dialog, as harnesses/claude's probes (2.1.287) show it: its third
          // option is a field for what to change.
          dialog: {
            type: "choices" as const,
            id: `${id}:d`,
            title: "Ready to code?",
            detail: asks.plan.steps,
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
      if (number === asks.question.number) {
        const request = {
          id: `${id}:question`,
          kind: "question" as const,
          tool: "AskUserQuestion",
          subject: asks.question.question,
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
                id: asks.question.id,
                header: asks.question.header,
                question: asks.question.question,
                multiSelect: false,
                text: true,
                options: asks.question.options,
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
