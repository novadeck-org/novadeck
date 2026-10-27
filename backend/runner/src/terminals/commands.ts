import { basename, win32 } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import { agents, harnesses } from "../harnesses/registry.js"

// Text on one line and in one case, as prompts and commands are compared.
const oneLine = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()

/**
 * A command line's words, as a POSIX shell splits and unquotes them: single quotes keep
 * everything, double quotes keep all but a backslash before `"`, `\\`, `$` or a backtick,
 * and a backslash elsewhere keeps the next character. On Windows, whose shells take a
 * backslash as a path's, it is kept as it is.
 */
export const commandWords = (
  command: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] => {
  const escapes = platform !== "win32"
  const words: string[] = []
  let word = ""
  // Whether a word started, as `''` starts an empty one.
  let started = false
  let quote: "'" | '"' | undefined
  const chars = [...command]
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!
    const next = chars[index + 1] ?? ""
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
    } else if (quote === '"') {
      if (char === '"') quote = undefined
      else if (escapes && char === "\\" && /["\\$`]/.test(next)) {
        word += next
        index += 1
      } else word += char
    } else if (/\s/.test(char)) {
      if (started) words.push(word)
      word = ""
      started = false
    } else {
      started = true
      if (char === "'" || char === '"') quote = char
      else if (escapes && char === "\\") {
        word += next
        index += 1
      } else word += char
    }
  }
  if (started) words.push(word)
  return words
}

/**
 * Whether a prompt is the one in a command that started an agent with it, as an opener's
 * `claude "…"`, `codex "…"` or `agy -i "…"`: the prompt, on one line and in one case, is
 * one whole argument of the command, never a part of one.
 */
export const promptIn = (command: string, prompt: string): boolean => {
  const wanted = oneLine(prompt)
  return (
    wanted.length > 0 &&
    commandWords(command)
      .slice(1)
      .some((word) => oneLine(word) === wanted)
  )
}

/**
 * The agent a new terminal expects to bind, which messages may be sent to before it has:
 * the one it resumes, or whose program its command runs, quoted or not; null for a plain
 * shell or another program.
 */
export const expectedAgent = (
  command: string | undefined,
  resume: AgentName | undefined,
  platform: NodeJS.Platform = process.platform,
): AgentName | null => {
  if (resume) return resume
  return programOf(command === undefined ? [] : commandWords(command, platform), platform)
}

// The agent whose program a command's words start with, by its file name.
const programOf = (words: readonly string[], platform: NodeJS.Platform): AgentName | null => {
  const [first = ""] = words
  const base = platform === "win32" ? win32.basename(first) : basename(first)
  const program = base.replace(/\.(?:exe|cmd)$/i, "")
  return agents.find((agent) => agent === program) ?? null
}

/**
 * The agent whose interactive session a command would start, or null for any other program
 * and for an agent's other uses (its help, version, print mode and subcommands other than a
 * session, as `harness.nonSession` lists). A bare launch, options only, a prompt argument and
 * resuming, continuing or forking a session all start one.
 *
 * Options can take values (`codex -c key=value exec`, `claude --model opus "do x"`), so the
 * words are not read as options and arguments. The command is a non-session use if any word
 * after the program is one of the agent's `nonSession` words, and a session otherwise. The
 * trade-off: a prompt written as loose words (`claude fix the update`) that includes one is
 * let through, which is rare and only misses a refusal.
 *
 * This steers an agent to `open_agent`; it is not a security boundary, so a wrapper such as
 * `env X=1 claude`, `cd x && claude` or `npx` goes unseen.
 */
export const sessionLaunch = (
  command: string,
  platform: NodeJS.Platform = process.platform,
): AgentName | null => {
  const words = commandWords(command, platform)
  const agent = programOf(words, platform)
  if (agent === null) return null
  const outside = harnesses[agent].nonSession
  return words.slice(1).some((word) => outside.includes(word)) ? null : agent
}
