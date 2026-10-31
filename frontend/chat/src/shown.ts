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
// agent is gone. They go once the terminal settles on something else, or closes.
export const chatKept = (terminal: TerminalMetadata): boolean =>
  chatAvailable(terminal) || terminal.state === "starting"

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

// Whether a terminal shows its agent's conversation rather than its screen: the chat view
// is on, an agent runs in it, and the person hasn't gone to its screen to answer it.
export const chatShown = (
  chatView: boolean,
  answers: TerminalAnswers,
  context: string,
  terminal: TerminalMetadata,
): boolean =>
  chatView && chatAvailable(terminal) && !answeringInTerminal(answers, context, terminal.id)
