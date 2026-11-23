/**
 * The person's own allow rules, read and never written (see architecture/grants.md, review
 * point 9): where one covers a command, the harness had no gate there, so the shipping gate
 * adds none. Claude Code's are `permissions.allow` entries of its settings files, Codex's
 * `prefix_rule(... decision="allow")` lines of its rules files, Antigravity's `command(...)`
 * entries of its settings file.
 */
import { readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { parseShell } from "./words.js"

/** A rule that allows a shell command, as a test of one command's words. */
export type AllowRule = (text: string, words: readonly string[]) => boolean

const escaped = (text: string): string => text.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)

/** Claude Code's `Bash(...)` rule specifiers: `cmd:*` (prefix), `cmd *` (glob), or exact. */
export const claudeRule = (entry: string): AllowRule | undefined => {
  if (entry === "Bash" || entry === "Bash(*)") return () => true
  const match = /^Bash\((.*)\)$/s.exec(entry)
  if (!match) return undefined
  const spec = match[1]!.trim()
  if (spec.endsWith(":*")) {
    const prefix = spec.slice(0, -2)
    return (text) => text === prefix || text.startsWith(`${prefix} `)
  }
  if (spec.includes("*")) {
    const pattern = new RegExp(`^${spec.split("*").map(escaped).join(".*")}$`, "s")
    return (text) => pattern.test(text)
  }
  return (text) => text === spec
}

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}

/**
 * The folders whose project files a harness started in `folder` reads: it and each folder above
 * it up to its repository's top, the first with a `.git`; only `folder` outside a repository.
 * Claude Code and Codex both read them so (probed 2.1.330 and 0.171.0: a rule in the launch
 * folder's own files and one in its repository's top both count), and both read them where
 * they started, never where a command runs.
 */
export const projectFolders = async (folder: string): Promise<string[]> => {
  const start = resolve(folder)
  const folders: string[] = []
  for (let at = start; ; at = dirname(at)) {
    folders.push(at)
    // eslint-disable-next-line no-await-in-loop -- Each folder is looked at in turn, upwards.
    const top = await stat(join(at, ".git")).then(
      () => true,
      () => false,
    )
    if (top) return folders
    if (dirname(at) === at) return [start]
  }
}

/** The allow rules Claude Code reads for a session started in `folder`, from the person's settings files. */
export const claudeRules = async (
  folder: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<AllowRule[]> => {
  const config = env.CLAUDE_CONFIG_DIR || join(home, ".claude")
  const files = [
    join(config, "settings.json"),
    ...(await projectFolders(folder)).flatMap((each) => [
      join(each, ".claude", "settings.json"),
      join(each, ".claude", "settings.local.json"),
    ]),
  ]
  const rules: AllowRule[] = []
  for (const file of await Promise.all([...new Set(files)].map(readJson))) {
    const allow = (file as { permissions?: { allow?: unknown } } | undefined)?.permissions?.allow
    if (!Array.isArray(allow)) continue
    for (const entry of allow) {
      const rule = typeof entry === "string" ? claudeRule(entry) : undefined
      if (rule) rules.push(rule)
    }
  }
  return rules
}

/** Codex's `prefix_rule(pattern=["git", "push"], decision="allow")`: a prefix of a command's words. */
export const codexRulesOf = (text: string): AllowRule[] => {
  const rules: AllowRule[] = []
  for (const match of text.matchAll(/prefix_rule\(([^)]*(?:\[[^\]]*\][^)]*)*)\)/g)) {
    const body = match[1]!
    if (!/decision\s*=\s*["']allow["']/.test(body)) continue
    const pattern = /pattern\s*=\s*\[([^\]]*)\]/.exec(body)?.[1]
    if (pattern === undefined || pattern.includes("[")) continue
    const prefix = [...pattern.matchAll(/"([^"]*)"|'([^']*)'/g)].map((each) => each[1] ?? each[2]!)
    if (prefix.length === 0) continue
    rules.push((_text, words) => prefix.every((word, at) => words[at] === word))
  }
  return rules
}

/**
 * The allow rules Codex reads for a session started in `folder`: its home's rules files, and
 * those of the project's `.codex/rules` folders.
 */
export const codexRules = async (
  folder: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<AllowRule[]> => {
  const folders = [
    join(env.CODEX_HOME || join(home, ".codex"), "rules"),
    ...(await projectFolders(folder)).map((each) => join(each, ".codex", "rules")),
  ]
  const texts = await Promise.all(
    [...new Set(folders)].map(async (rules) => {
      const names = await readdir(rules).catch(() => [] as string[])
      return Promise.all(
        names
          .filter((name) => name.endsWith(".rules"))
          .map((name) => readFile(join(rules, name), "utf8").catch(() => "")),
      )
    }),
  )
  return texts.flat().flatMap(codexRulesOf)
}

/**
 * Whether the person's rules cover every command of `command` that isn't a `cd`: the harness
 * then had no gate on it, and the shipping gate stays silent too.
 */
export const covered = (rules: readonly AllowRule[], command: string): boolean => {
  if (rules.length === 0) return false
  const { commands } = parseShell(command)
  const segments = commands.filter((each) => each.words[0] !== "cd")
  return (
    segments.length > 0 &&
    segments.every((each) => rules.some((rule) => rule(each.text, each.words)))
  )
}

/**
 * Antigravity's `command(git push)`: a command's first words, as the program and subcommand
 * it names (probed 1.5.14: it covers `git push <args>`, and never a tail or `git push-x`).
 * Any other entry (`mcp(...)`, a glob) says nothing about a command here.
 */
export const agyRule = (entry: string): AllowRule | undefined => {
  const match = /^command\(([^*()]+)\)$/.exec(entry.trim())
  const prefix = match?.[1]?.trim().split(/\s+/)
  if (!prefix || prefix[0] === "") return undefined
  return (_text, words) => prefix.every((word, at) => words[at] === word)
}

/** The allow rules Antigravity reads from the person's settings file, read and never written. */
export const agyRules = async (home = homedir()): Promise<AllowRule[]> => {
  const file = await readJson(join(home, ".gemini", "antigravity-cli", "settings.json"))
  const allow = (file as { permissions?: { allow?: unknown } } | undefined)?.permissions?.allow
  if (!Array.isArray(allow)) return []
  return allow.flatMap((entry) => {
    const rule = typeof entry === "string" ? agyRule(entry) : undefined
    return rule ? [rule] : []
  })
}
