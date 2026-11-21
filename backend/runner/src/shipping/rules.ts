/**
 * The person's own allow rules, read and never written (see architecture/grants.md, review
 * point 9): where one covers a command, the harness had no gate there, so the shipping gate
 * adds none. Claude Code's are `permissions.allow` entries of its settings files, Codex's
 * `prefix_rule(... decision="allow")` lines of its rules files.
 */
import { readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

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

/** The allow rules Claude Code reads for a project at `cwd`, from the person's settings files. */
export const claudeRules = async (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<AllowRule[]> => {
  const config = env.CLAUDE_CONFIG_DIR || join(home, ".claude")
  const files = [
    join(config, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ]
  const rules: AllowRule[] = []
  for (const file of await Promise.all(files.map(readJson))) {
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

export const codexRules = async (
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<AllowRule[]> => {
  const folder = join(env.CODEX_HOME || join(home, ".codex"), "rules")
  const names = await readdir(folder).catch(() => [] as string[])
  const texts = await Promise.all(
    names
      .filter((name) => name.endsWith(".rules"))
      .map((name) => readFile(join(folder, name), "utf8").catch(() => "")),
  )
  return texts.flatMap(codexRulesOf)
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
