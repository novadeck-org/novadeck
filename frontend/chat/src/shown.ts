import { isAgentProgram } from "@novadeck/core/terminals/process"
import type { TerminalMetadata } from "@novadeck/core/types"

import { keepTerminals, valueOf, withValue, type ByTerminal } from "./by-terminal"

// Whether a terminal has a conversation to show: an agent runs in it, as its status says
// or, where Novadeck hears nothing from the agent (Antigravity without hooks), as its
// foreground program does. Once the agent ends, so does the chat.
export const chatAvailable = (terminal: TerminalMetadata): boolean =>
  terminal.state === "running" && (terminal.agent !== undefined || isAgentProgram(terminal.process))

// Whether a terminal's chat is kept: while an agent runs, and through a restart
// (`starting`, as when the runner is reached again), which says nothing of whether the
// agent is gone, and through a sleep (the chat stays unavailable while it sleeps, and is
// there again once the agent wakes). They go once the terminal settles on something else, or closes.
export const chatKept = (terminal: TerminalMetadata): boolean =>
  chatAvailable(terminal) || terminal.state === "starting" || terminal.state === "sleeping"

// The terminals showing their screen though the chat view is on, by session context and
// terminal id: the person went to answer their agent there. None of it outlives the page.
export type TerminalAnswers = ByTerminal<true>

export const noTerminalAnswers: TerminalAnswers = {}

export const answeringInTerminal = (
  answers: TerminalAnswers,
  context: string,
  id: string,
): boolean => valueOf(answers, context, id) === true

// None left is none at all, which spares the watcher its work.
const settled = (answers: TerminalAnswers): TerminalAnswers =>
  Object.keys(answers).length > 0 ? answers : noTerminalAnswers

export const setAnsweringInTerminal = (
  answers: TerminalAnswers,
  context: string,
  id: string,
  on: boolean,
): TerminalAnswers => settled(withValue(answers, context, id, on ? true : undefined))

// Keeps only the terminals that `keep` says are still answered in.
export const keepTerminalAnswers = (
  answers: TerminalAnswers,
  keep: (context: string, id: string) => boolean,
): TerminalAnswers => settled(keepTerminals(answers, keep))

// Whether the terminal's agent is still starting, before its prompt shows or a session binds,
// or held at a screen of its own the person answers there (a folder-trust or sign-in one): what
// the chat's box sends meanwhile waits for it. Not one whose hooks are off, which nothing but the
// person's settings changes: what is sent to it is refused at once, saying why.
export const agentStarting = (terminal: TerminalMetadata): boolean =>
  terminal.state === "running" &&
  (terminal.expecting !== undefined ||
    (terminal.agent?.startup !== undefined && terminal.agent.startup !== "hooks"))

// Chat takes over once the agent's prompt or session is known, or from the start of an agent
// the terminal was opened or woken to run, so what the person types as it starts stays in the
// chat's box rather than landing in the agent's own as it draws. Its foreground program
// alone may still be at an update, trust or sign-in screen, including a manual launch
// that no startup watch follows. Keep the person's preference while its screen shows, or
// while its terminal holds what only the person can do there (a session not signed in,
// Novadeck's hooks off).
export const chatShown = (
  chatView: boolean,
  answers: TerminalAnswers,
  context: string,
  terminal: TerminalMetadata,
  boundSession = false,
): boolean =>
  chatView &&
  chatAvailable(terminal) &&
  !answeringInTerminal(answers, context, terminal.id) &&
  terminal.state === "running" &&
  (terminal.agent !== undefined || terminal.expecting !== undefined || boundSession) &&
  !terminal.agent?.startup
