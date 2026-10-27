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
  // Windows file names are not case-sensitive.
  const bare = base.replace(/\.(?:exe|cmd)$/i, "")
  const program = platform === "win32" ? bare.toLowerCase() : bare
  return agents.find((agent) => agent === program) ?? null
}

/**
 * The agent whose interactive session a command would start, or null for any other program
 * and for an agent's other uses: its help and version flags, and its commands other than a
 * session (`harness.nonSession`). A bare launch, options only, a prompt argument, its print
 * and exec modes (they run it on a prompt) and resuming, continuing or forking a session all
 * start one.
 *
 * A command counts only as the first word after the program that is not an option, so a
 * prompt of loose words (`codex write a test`) is not read as one. The value of each option
 * the agent is known to take one (`harness.nonSession.takesValue`, as `codex -c key=value
 * mcp list`) is skipped first. One it does not know reads as the first word, so
 * `claude --unknown x mcp list` is refused though it need not be.
 * So does an option with an optional value (`claude -r x mcp`) and a Go-style long option
 * with one dash (`agy -model x mcp`), which the lists spell with two.
 *
 * Help and version flags count anywhere. So do the agent's print flags
 * (`harness.nonSession.print`), which run it on the words that follow: unless a help flag
 * is also there, the command is a session's use whatever else it has, as `agy -p mcp "do x"`.
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
  const { commands, flags, takesValue, print } = harnesses[agent].nonSession
  const rest = words.slice(1)
  if (rest.some((word) => flags.includes(word))) return null
  if (rest.some((word) => print.includes(word))) return agent
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index]!
    if (!word.startsWith("-")) return commands.includes(word) ? null : agent
    if (takesValue.includes(word)) index += 1
  }
  return agent
}
