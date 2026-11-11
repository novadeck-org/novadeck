import type { AgentActivity } from "@novadeck/protocol"
import { redact } from "@novadeck/secrets"

import type { Background } from "../messaging/peers.js"
import { shorten } from "../text.js"
import { shownCommand } from "./shown-command.js"

/** How long a description of the agent's own shows, in characters. */
const nameChars = 40

/** How many running shells, and how many that failed, a listing names at most. */
export const shownRunning = 3
export const shownEnded = 2

/** How long ago a shell may have failed and still show, in milliseconds. */
export const endedWithinMs = 10 * 60_000

/** Characters that end a simple command and start another. */
const operators = new Set(["|", "&", ";", "\n", "(", ")"])

/**
 * A command line cut into its simple commands, each into words: split on whitespace and
 * on `|`, `&`, `;`, newlines and parentheses outside quotes; single and double quotes group
 * a word and are dropped. A backslash outside quotes keeps the space or quote after it.
 * This is no shell parser: it only has to find the first program and be safe where it is wrong.
 */
const simpleCommands = (command: string): string[][] => {
  const commands: string[][] = [[]]
  let word: string | null = null
  const endWord = () => {
    if (word !== null) commands.at(-1)!.push(word)
    word = null
  }
  let quote: string | null = null
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!
    if (quote) {
      if (char === quote) quote = null
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      word ??= ""
    } else if (char === "\\" && /[\s"'\\]/.test(command[at + 1] ?? "")) {
      word = (word ?? "") + command[++at]
    } else if (/\s/.test(char) && !operators.has(char)) {
      endWord()
    } else if (operators.has(char)) {
      endWord()
      if (commands.at(-1)!.length > 0) commands.push([])
    } else {
      word = (word ?? "") + char
    }
  }
  endWord()
  return commands.filter((each) => each.length > 0)
}

/** A word that sets a variable for the command after it: `KEY=value`. */
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Programs that only run the command after them, and their options that take a value. */
const wrappers: { readonly [program: string]: ReadonlySet<string> } = {
  env: new Set(["-u", "-C", "-S"]),
  sudo: new Set(["-u", "-g", "-C", "-h", "-p", "-U", "-r", "-t", "-D"]),
  nohup: new Set(),
  exec: new Set(["-a"]),
  command: new Set(),
  time: new Set(["-f", "-o"]),
  nice: new Set(["-n"]),
  timeout: new Set(["-s", "-k"]),
}

/** Shells whose `-c` (or `-lc` and the like) runs the string after it. */
const shellPrograms = new Set(["sh", "bash", "zsh", "dash"])

/** How many wrapping shells' strings are looked into, at most. */
const maxDepth = 2

/**
 * The words of the command a shell line runs first, as `shownCommand` takes them: any
 * leading `cd <dir>`, `export` and lone assignments are passed over, then the first simple
 * command (up to a pipe, `&&`, `||` or `;`) without its leading `VAR=value` words. A program
 * that only runs another (`env`, `sudo`, `nohup`, `timeout 60`, …) is looked through to it,
 * as is a shell's `-c` string, so the name says what runs. Empty where nothing runs.
 */
export const commandWords = (command: string, depth = 0): string[] => {
  const first = simpleCommands(command).find(
    (words) =>
      words[0] !== "cd" && words[0] !== "export" && !words.every((word) => assignment.test(word)),
  )
  if (!first) return []
  let words = first
  for (;;) {
    words = words.slice(
      Math.max(
        0,
        words.findIndex((word) => !assignment.test(word)),
      ),
    )
    if (words.every((word) => assignment.test(word))) return []
    const program = words[0]!
    const takes = wrappers[program]
    if (takes) {
      let at = 1
      while (at < words.length && (words[at]!.startsWith("-") || assignment.test(words[at]!)))
        at += takes.has(words[at]!) ? 2 : 1
      // `timeout` and `nice -n` take a duration or a number before the command.
      if ((program === "timeout" || program === "nice") && /^[\d.]+[smhd]?$/.test(words[at] ?? ""))
        at += 1
      words = words.slice(at)
      continue
    }
    if (shellPrograms.has(program)) {
      const flag = words.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word))
      const script = flag > 0 ? words[flag + 1] : undefined
      if (script !== undefined && depth < maxDepth) return commandWords(script, depth + 1)
    }
    return words
  }
}

/** What a shell is called to other agents: never its raw command, which may carry a secret. */
export const shellName = (command: string, description: string | null | undefined): string => {
  const own = description && shorten(description, nameChars)
  return redact(own || shownCommand(commandWords(command)) || "a command")
}

/**
 * The background work an agent's listing shows, at `now`: the shells it has running, newest
 * first, with the first few named, and the ones that failed lately (a non-zero exit within
 * ten minutes, newest first). A shell the agent also waits on is named by that job's
 * description, given for the same id or the same command. Null where there is nothing to say.
 */
export const backgroundOf = (
  activity: Partial<Pick<AgentActivity, "shells" | "waiting">> | null | undefined,
  now: number,
): Background | null => {
  const shells = activity?.shells ?? []
  const jobs = activity?.waiting?.jobs ?? []
  const named = (shell: { id: string; command: string }) =>
    shellName(
      shell.command,
      jobs.find((job) => job.id === shell.id || job.command === shell.command)?.description,
    )
  const running = shells.filter(({ exit }) => !exit).toSorted((a, b) => b.since - a.since)
  const ended = shells
    .flatMap((shell) =>
      shell.exit &&
      shell.exit.code !== null &&
      shell.exit.code !== 0 &&
      shell.exit.at > now - endedWithinMs
        ? [{ shell, exit: shell.exit }]
        : [],
    )
    .toSorted((a, b) => b.exit.at - a.exit.at)
  if (running.length === 0 && ended.length === 0) return null
  return {
    running: running
      .slice(0, shownRunning)
      .map((shell) => ({ name: named(shell), since: shell.since })),
    moreRunning: Math.max(0, running.length - shownRunning),
    ended: ended
      .slice(0, shownEnded)
      .map(({ shell, exit }) => ({ name: named(shell), code: exit.code!, at: exit.at })),
  }
}
