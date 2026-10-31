import { z } from "zod"

import type { Api, ApiError, Anchor, JsonSchema, Procedure } from "../src/atlas.ts"
import { lineAt, type Anchors } from "./anchors.ts"
import { frontendSources, sourceFiles } from "./files.ts"
import {
  findDefinition,
  handlerBody,
  routerFile,
  servicesOf,
  type Service,
} from "./runner-services.ts"

const contractFile = "contract/protocol/src/contract.ts"
// The wire's sessions: the gate in front of every router procedure, and the handshake.
const sessionsFile = "libraries/wire/src/sessions.ts"

type Definition = { inputSchema?: unknown; outputSchema?: unknown }

const isProcedure = (value: unknown): value is { "~orpc": Definition } =>
  typeof value === "object" && value !== null && "~orpc" in value

const walk = (node: object, path: string[] = []): { path: string[]; definition: Definition }[] =>
  Object.entries(node).flatMap(([key, value]) =>
    isProcedure(value)
      ? [{ path: [...path, key], definition: value["~orpc"] }]
      : typeof value === "object" && value !== null
        ? walk(value, [...path, key])
        : [],
  )

// oRPC's event iterator schema carries the yielded schema under a symbol.
const streamed = (schema: unknown): { yields?: unknown } | null => {
  const standard = (schema as { "~standard"?: Record<symbol, unknown> } | undefined)?.["~standard"]
  if (!standard || (standard as { vendor?: string }).vendor !== "orpc") return null
  const symbol = Object.getOwnPropertySymbols(standard).find((each) =>
    each.description?.includes("EVENT_ITERATOR"),
  )
  return symbol ? (standard[symbol] as { yields?: unknown }) : { yields: undefined }
}

const toJson = (schema: unknown): JsonSchema | null => {
  if (schema === undefined || schema === null) return null
  try {
    return z.toJSONSchema(schema as z.ZodType, { unrepresentable: "any", io: "input" })
  } catch {
    return null
  }
}

// `terminals.create` → the line of the service method the router calls for it, else the
// router's own handler.
const handlerOf = (
  anchors: Anchors,
  runnerFiles: string[],
  router: string,
  known: Service[],
  id: string,
): Anchor | null => {
  const handler = handlerBody(router, id)
  if (handler === null) {
    // The wire's own procedures are answered in its sessions.
    const sessions = anchors.read(sessionsFile) ?? ""
    const own = sessions.indexOf(`.${id}.handler(`)
    return own === -1 ? null : { file: sessionsFile, line: lineAt(sessions, own) }
  }
  const rank = (call: RegExpMatchArray): number =>
    (call[2] === id.split(".").at(-1) ? 0 : 2) + (call[1] === "store" ? 1 : 0)
  const calls = [...handler.body.matchAll(/\b(\w+)\.(\w+)\(/g)].toSorted(
    (a, b) => rank(a) - rank(b),
  )
  for (const call of calls) {
    const service = known.find((each) => each.field === call[1])
    if (!service) continue
    const found = findDefinition(anchors, runnerFiles, service, call[2]!)
    if (found) return found
  }
  return { file: routerFile, line: lineAt(router, handler.start) }
}

// The text from `from` to the close of the first block (or call) that opens at paren depth 0.
const blockFrom = (source: string, from: number, open: "{" | "("): string => {
  let paren = 0
  let start = -1
  let depth = 0
  for (let i = from; i < source.length; i++) {
    const ch = source[i]!
    if (start === -1) {
      if (ch === "(") paren += 1
      else if (ch === ")") paren -= 1
      const typeBrace = /[<:|,&;=]\s*$/.test(source.slice(Math.max(0, i - 4), i))
      if (ch === open && (open === "(" || (paren === 0 && !typeBrace))) {
        start = i
        depth = 1
        if (open === "(") paren = 0
      }
      continue
    }
    if (ch === "{" || ch === "(") depth += 1
    else if (ch === "}" || ch === ")") depth -= 1
    if (depth === 0) return source.slice(start, i + 1)
  }
  return start === -1 ? "" : source.slice(start)
}

const errorPattern = /new (?:DomainError|ORPCError)\(\s*"([A-Z_]+)"|\berrors\.([A-Z_]+)\b/g

// Codes the procedure raises: in its router handler and in the method that handler calls.
// Helpers further down the call chain are not followed.
const errorsOf = (
  anchors: Anchors,
  router: string,
  handler: Anchor | null,
  id: string,
  known: Set<string>,
  routerWide: string[],
): string[] => {
  const texts: string[] = []
  const at = router.indexOf(`.${id}.handler(`)
  if (at !== -1) texts.push(blockFrom(router, at + id.length + 1, "("))
  if (handler && handler.line !== null && handler.file === sessionsFile) {
    const source = anchors.read(sessionsFile) ?? ""
    const own = source.indexOf(`.${id}.handler(`)
    if (own !== -1) texts.push(blockFrom(source, own + id.length + 1, "("))
  } else if (handler && handler.line !== null && handler.file !== routerFile) {
    const source = anchors.read(handler.file)
    if (source) {
      const offset = source
        .split("\n")
        .slice(0, handler.line - 1)
        .join("\n").length
      texts.push(blockFrom(source, offset, "{"))
    }
  }
  const found = texts.flatMap((text) =>
    [...text.matchAll(errorPattern)].map((match) => match[1] ?? match[2]!),
  )
  // Every procedure the runner's router serves is behind the sessions' gate.
  const gated = router.includes(`api.${id}.handler(`)
  return [...new Set([...(gated ? routerWide : []), ...found])].filter((code) => known.has(code))
}

const callersOf = (anchors: Anchors, uiFiles: string[], id: string): Anchor[] => {
  const pattern = new RegExp(`\\.${id.replaceAll(".", "\\.")}\\(`)
  return uiFiles.flatMap((file) => {
    const lines = anchors.read(file)?.split("\n") ?? []
    const index = lines.findIndex((text) => pattern.test(text))
    return index === -1 ? [] : [{ file, line: index + 1 }]
  })
}

// The wire's own codes, which the contract spreads into its errors (`...wireErrors`).
const wireErrorsFile = "libraries/wire/src/errors.ts"

// An error map's codes, each with the comment above it: `//` lines in the contract,
// one-line `/** … */` in the wire's.
const errorsIn = (body: string, wire: () => ApiError[]): ApiError[] => {
  const found: ApiError[] = []
  let note: string[] = []
  for (const text of body.split("\n").map((each) => each.trim())) {
    if (text.startsWith("//")) note.push(text.replace(/^\/\/\s?/, ""))
    else if (text.startsWith("/**")) note.push(text.replace(/^\/\*\*\s?|\s?\*\/$/g, ""))
    else {
      if (/^\.\.\.wireErrors,?$/.test(text)) found.push(...wire())
      const match = /^([A-Z_]+): \{ status: (\d+)/.exec(text)
      if (match)
        found.push({ code: match[1]!, status: Number(match[2]), note: note.join(" ") || null })
      note = []
    }
  }
  return found
}

const extractErrors = (anchors: Anchors, source: string): ApiError[] => {
  const from = anchors.expect(contractFile, "export const errors = {", "api errors")
  const to = anchors.expect(contractFile, "const procedure =", "api errors")
  if (from === null || to === null) return []
  const body = source.slice(
    source.indexOf("export const errors"),
    source.indexOf("const procedure ="),
  )
  const wire = (): ApiError[] => {
    const start = "export const wireErrors = {"
    if (anchors.expect(wireErrorsFile, start, "api errors") === null) return []
    const wireSource = anchors.read(wireErrorsFile) ?? ""
    const at = wireSource.indexOf(start)
    return errorsIn(wireSource.slice(at, wireSource.indexOf("} as const", at)), () => [])
  }
  return errorsIn(body, wire)
}

// Every procedure in the protocol contract, with its schemas, handler and callers.
export const extractApi = async (repo: string, anchors: Anchors): Promise<Api> => {
  const { contract } = await import("@novadeck/protocol")
  const source = anchors.read(contractFile) ?? ""
  const router = anchors.read(routerFile) ?? ""
  const routed = servicesOf(anchors, router)
  const runnerFiles = sourceFiles(repo, "backend/runner/src")
  // The runner client calls some procedures (write, resize, ack) for the UI.
  const callerFiles = [...frontendSources(repo), ...sourceFiles(repo, "contract/runner-client/src")]

  const apiErrors = extractErrors(anchors, source)
  if (apiErrors.length === 0 && source !== "")
    anchors.report("api errors", contractFile, "found 0 errors in `export const errors`")
  anchors.expect(contractFile, "export const contract", "api procedures")
  anchors.expect(sessionsFile, "const gate", "api router middleware")
  const known = new Set(apiErrors.map((each) => each.code))
  // What the sessions' gate raises for every procedure behind it.
  const sessions = anchors.read(sessionsFile) ?? ""
  const middleware = blockFrom(
    sessions,
    sessions.indexOf(".middleware(", sessions.indexOf("const gate")),
    "(",
  )
  const routerWide = [...middleware.matchAll(/new ORPCError\("([A-Z_]+)"/g)].map((m) => m[1]!)

  const procedures = walk(contract).map(({ path, definition }): Procedure => {
    const id = path.join(".")
    const name = path[path.length - 1]!
    const stream = streamed(definition.outputSchema)
    const handler = handlerOf(anchors, runnerFiles, router, routed, id)
    return {
      id,
      namespace: path.slice(0, -1).join("."),
      name,
      kind: stream ? "stream" : "call",
      input: toJson(definition.inputSchema),
      output: toJson(stream ? stream.yields : definition.outputSchema),
      anchor: { file: contractFile, line: findProcedureLine(source, path) },
      handler,
      errors: errorsOf(anchors, router, handler, id, known, routerWide),
      callers: callersOf(anchors, callerFiles, id),
      area: null,
    }
  })

  if (procedures.length === 0)
    anchors.report("api procedures", contractFile, "found 0 procedures in the contract")
  for (const procedure of procedures)
    if (procedure.handler === null)
      anchors.report("api handlers", routerFile, `no router handler for ${procedure.id}`)
  const resolved = procedures.filter(
    (procedure) => procedure.handler !== null && procedure.handler.file !== routerFile,
  ).length
  // A namespace whose handlers all stay in the router has lost its service (an import the
  // scan no longer reads); a lone procedure the router answers itself (handshake) is fine.
  for (const namespace of new Set(procedures.map((p) => p.namespace))) {
    const members = procedures.filter((p) => p.namespace === namespace)
    if (
      members.length > 1 &&
      members.every((p) => p.handler === null || p.handler.file === routerFile)
    )
      anchors.report(
        "api handlers",
        routerFile,
        `no handler in ${namespace}.* resolves to a service method`,
      )
  }
  // A service the router calls but no handler resolves into: its import or file moved.
  for (const service of routed) {
    const dir = service.file.slice(0, service.file.lastIndexOf("/") + 1)
    const called = new RegExp(`\\b${service.field}\\.\\w+\\(`).test(router)
    const reached = procedures.some(
      (p) =>
        p.handler !== null && (p.handler.file === service.file || p.handler.file.startsWith(dir)),
    )
    if (called && !reached)
      anchors.report(
        "api handlers",
        routerFile,
        `the router calls ${service.field}, but no handler resolves into ${service.file}`,
      )
  }
  if (resolved * 2 < procedures.length)
    anchors.report(
      "api handlers",
      routerFile,
      `only ${resolved} of ${procedures.length} handlers resolve to a service method`,
    )
  return { procedures, errors: apiErrors }
}

// The `name:` line inside its namespace's block, not an earlier procedure of the same name.
const findProcedureLine = (source: string, path: string[]): number | null => {
  const from =
    path.length > 1 ? source.indexOf(`  ${path[0]}: {`, source.indexOf("export const contract")) : 0
  const index = source.indexOf(`    ${path[path.length - 1]}: `, Math.max(from, 0))
  return index === -1 ? null : lineAt(source, index)
}
