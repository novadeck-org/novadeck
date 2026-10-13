import { createRequire } from "node:module"

import { z } from "zod"

import type { Anchor, Column, Data, LocalKey, Setting, Table } from "../src/atlas.ts"
import type { Anchors } from "./anchors.ts"
import { sourceFiles } from "./files.ts"

const lineAt = (source: string, index: number): number => source.slice(0, index).split("\n").length

const splitTop = (body: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const char of body) {
    if (char === "(") depth += 1
    if (char === ")") depth -= 1
    if (char === "," && depth === 0) {
      parts.push(current)
      current = ""
    } else current += char
  }
  return [...parts, current].map((each) => each.trim()).filter(Boolean)
}

const tableConstraint = /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i

const columnOf = (text: string): Column => {
  const [name = "", type = "", ...rest] = text.split(/\s+/)
  const constraints = rest.join(" ")
  const references = /REFERENCES\s+(\w+)/i.exec(constraints)?.[1] ?? null
  return { name, type, constraints, references }
}

// SQL comments blanked out to the same length, so their commas and parentheses don't
// split columns while indices still match the source.
const uncommented = (source: string): string =>
  source.replace(/--[^\n]*/g, (comment) => " ".repeat(comment.length))

const tablesIn = (file: string, source: string): Table[] =>
  [...source.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+) \(/g)].map((match) => {
    const code = uncommented(source)
    const open = match.index + match[0].length
    let depth = 1
    let close = open
    while (depth > 0 && close < code.length) {
      const char = code[close++]
      if (char === "(") depth += 1
      if (char === ")") depth -= 1
    }
    const end = code.indexOf(";", close)
    const body = code.slice(open, close - 1)
    return {
      name: match[1]!,
      columns: splitTop(body)
        .filter((part) => !tableConstraint.test(part))
        .map(columnOf),
      sql: source.slice(match.index, end === -1 ? close : end + 1).trim(),
      anchor: { file, line: lineAt(source, match.index) },
      readers: [],
      writers: [],
      area: null,
    }
  })

const mentions = (text: string, table: string, verbs: RegExp[]): boolean =>
  verbs.some((verb) => new RegExp(`${verb.source}\\s+${table}\\b`, "i").test(text))

const readVerbs = [/\bFROM/, /\bJOIN/]
const writeVerbs = [/\bINSERT\s+(?:OR\s+\w+\s+)?INTO/, /\bUPDATE/, /\bDELETE\s+FROM/]

const usage = (anchors: Anchors, files: string[], tables: Table[]): void => {
  for (const file of files) {
    const lines = anchors.read(file)?.split("\n") ?? []
    lines.forEach((text, index) => {
      for (const table of tables) {
        if (table.anchor.file === file && table.sql.includes(text.trim()) && text.trim() !== "") {
          continue
        }
        const anchor: Anchor = { file, line: index + 1 }
        if (mentions(text, table.name, writeVerbs)) table.writers.push(anchor)
        else if (mentions(text, table.name, readVerbs)) table.readers.push(anchor)
      }
    })
  }
}

// A write that says `RETURNING` also reads the row it wrote; the statement spans lines, so
// it is found from the keyword back to the write that opened it: the first write in it, as
// an upsert's `ON CONFLICT … DO UPDATE SET` comes after its `INSERT INTO`.
const returning = (anchors: Anchors, files: string[], tables: Table[]): void => {
  for (const file of files) {
    const source = anchors.read(file) ?? ""
    for (const match of source.matchAll(/\bRETURNING\b/g)) {
      const before = source.slice(Math.max(0, match.index - 800), match.index)
      const statement = before.slice(Math.max(before.lastIndexOf("`"), before.lastIndexOf('"')) + 1)
      const write = [
        ...statement.matchAll(
          /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(\w+)/gi,
        ),
      ][0]
      const table = tables.find((each) => each.name === write?.[1])
      if (table) table.readers.push({ file, line: lineAt(source, match.index) })
    }
  }
}

const schemasFile = "application/protocol/src/schemas.ts"

const typeName = (schema: z.core.JSONSchema.JSONSchema): string => {
  if (schema.enum) return schema.enum.map((each) => JSON.stringify(each)).join(" | ")
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (schema.anyOf) return schema.anyOf.map((each) => typeName(each as never)).join(" | ")
  if (Array.isArray(schema.type)) return schema.type.join(" | ")
  return schema.type ?? "unknown"
}

const settingsIn = (anchors: Anchors): Setting[] => {
  const schemas = createRequire(import.meta.url)("@novadeck/protocol") as Record<string, unknown>
  const groups = { runnerSettings: "runner", voiceSettings: "voice", murmurSettings: "murmur" }
  const source = anchors.read(schemasFile) ?? ""
  return Object.entries(groups).flatMap(([name, group]) => {
    const schema = schemas[name] as z.ZodObject | undefined
    if (!schema) return []
    const start = source.indexOf(`export const ${name} =`)
    return Object.entries(schema.shape).map(([key, field]): Setting => {
      let type = "unknown"
      try {
        type = typeName(z.toJSONSchema(field as z.ZodType, { unrepresentable: "any", io: "input" }))
      } catch {}
      const at = source.indexOf(`  ${key}:`, start)
      return {
        key,
        group,
        type,
        anchor: { file: schemasFile, line: at === -1 ? null : lineAt(source, at) },
      }
    })
  })
}

const localIn = (anchors: Anchors, files: string[]): LocalKey[] =>
  files.flatMap((file) => {
    const source = anchors.read(file)
    if (source === null || !/(?:local|session)Storage/.test(source)) return []
    const lines = source.split("\n")
    return lines.flatMap((text, index) => {
      const match = /\bconst \w+ = "(novadeck\.[\w.-]*)"/.exec(text)
      if (!match) return []
      const comment: string[] = []
      for (let up = index - 1; up >= 0 && lines[up]!.trim().startsWith("//"); up -= 1) {
        comment.unshift(lines[up]!.trim().replace(/^\/\/\s?/, ""))
      }
      return [
        { key: match[1]!, summary: comment.join(" ") || null, anchor: { file, line: index + 1 } },
      ]
    })
  })

// The runner's SQLite tables, the settings it keeps, and the UI's browser storage.
export const extractData = (repo: string, anchors: Anchors): Data => {
  const runnerFiles = sourceFiles(repo, "application/runner/src")
  const tables = runnerFiles.flatMap((file) => tablesIn(file, anchors.read(file) ?? ""))
  usage(anchors, runnerFiles, tables)
  returning(anchors, runnerFiles, tables)
  if (tables.length === 0)
    anchors.report("data tables", "application/runner/src", "found 0 `CREATE TABLE` statements")
  return {
    tables,
    settings: settingsIn(anchors),
    local: localIn(anchors, sourceFiles(repo, "application/ui/src")),
  }
}
