import type { ChatAnswer, ChatDialog, ChatRequest } from "@novadeck/core/conversation"

import type { DemoOutcome } from "./transcripts"

export type DemoRequestOutcome = (answer: ChatAnswer, dialog: ChatDialog) => DemoOutcome

// A request the demo makes up for an agent that reports one its transcript doesn't hold,
// with what answering it does. Each is a dialog the screen can answer, whichever the
// agent and project.
const picked = (answer: ChatAnswer): string | undefined =>
  answer.type === "choice" ? answer.option : undefined

// What a permission asks to run, each with what running it says. A terminal that waits on
// several gets a different one for each, so answering one visibly moves to the next.
const commands = [
  { command: "pnpm lint", ran: "Ran it. The lint passes, and nothing else changed." },
  { command: "pnpm typecheck", ran: "Ran it. The types check, and nothing else changed." },
  { command: "git diff --stat", ran: "Ran it. Three files changed, all in src/checkout." },
  { command: "pnpm test --filter cart", ran: "Ran it. The cart specs pass." },
]

// What a question asks, each with the options it offers.
const approaches = [
  {
    header: "Approach",
    question: "Which approach should I take?",
    options: ["Keep the current approach", "Try the simpler one", "Whichever you think is best"],
  },
  {
    header: "Scope",
    question: "How much should I change?",
    options: ["Only the failing file", "The whole module", "Whatever the tests need"],
  },
  {
    header: "Order",
    question: "What should I do first?",
    options: ["Write the tests", "Make the change", "Ask me again later"],
  },
]

// `index` is the request's place among those the agent waits on, which picks what it asks.
export const madeRequest = (
  kind: ChatRequest["kind"],
  id: string,
  name: string,
  index = 0,
): { readonly request: ChatRequest; readonly outcome: DemoRequestOutcome } => {
  const dialog = `${id}:d`
  if (kind === "permission") {
    const { command, ran } = commands[index % commands.length]!
    return {
      request: {
        id,
        kind,
        tool: "Bash",
        subject: command,
        choices: ["Yes, proceed", `No, and tell ${name} what to do differently`],
        subagent: false,
        answered: false,
        dialog: {
          type: "choices",
          id: dialog,
          title: "Would you like to run the following command?",
          detail: command,
          options: [
            { id: "1", label: "Yes, proceed", text: null },
            {
              id: "2",
              label: `No, and tell ${name} what to do differently`,
              text: "prompt",
            },
          ],
        },
      },
      outcome: (answer) =>
        picked(answer) === "2"
          ? {
              items: [],
              prompt: answer.type === "choice" ? (answer.text ?? "Don't run that.") : "",
            }
          : { items: [], reply: ran },
    }
  }
  if (kind === "plan")
    return {
      request: {
        id,
        kind,
        tool: "ExitPlanMode",
        subject: "The plan",
        choices: [
          "Yes, and auto-accept edits",
          "Yes, and manually approve edits",
          "No, keep planning",
        ],
        subagent: false,
        answered: false,
        dialog: {
          type: "choices",
          id: dialog,
          title: `${name} has written up a plan and is ready to execute. Would you like to proceed?`,
          detail: "The plan",
          options: [
            { id: "1", label: "Yes, and auto-accept edits", text: null },
            { id: "2", label: "Yes, and manually approve edits", text: null },
            { id: "3", label: "No, keep planning", text: null },
          ],
        },
      },
      outcome: (answer) =>
        picked(answer) === "3"
          ? { items: [], waits: true }
          : {
              items: [],
              reply: "Starting on the plan. The first step is done.",
            },
    }
  const asked = approaches[index % approaches.length]!
  const options = asked.options.map((label, at) => ({
    id: String(at + 1),
    label,
    description: null,
  }))
  return {
    request: {
      id,
      kind,
      tool: "AskUserQuestion",
      subject: asked.question,
      choices: options.map((option) => option.label),
      subagent: false,
      answered: false,
      dialog: {
        type: "questions",
        id: dialog,
        chat: null,
        questions: [
          {
            id: "approach",
            header: asked.header,
            question: asked.question,
            options,
            multiSelect: false,
            text: false,
          },
        ],
      },
    },
    outcome: (answer) => {
      const option = answer.type === "questions" ? answer.answers[0]?.options[0] : undefined
      const label = options.find((each) => each.id === option)?.label ?? options[2]!.label
      return { items: [], reply: `Going with: ${label.toLowerCase()}. Done.` }
    },
  }
}
