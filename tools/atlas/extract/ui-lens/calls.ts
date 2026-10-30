import { stem } from "../files.ts"
import type { Fn, Source, UiScan } from "./scan.ts"
import {
  adapterDir,
  backendFile,
  blank,
  blockEnd,
  definitionOf,
  enclosing,
  indentOf,
  isComment,
} from "./scan.ts"

// How the runner adapter calls the runner, and which of its calls a commit reaches.

// A line of the adapter that calls a procedure.
export type Site = { procedure: string; file: string; line: number }

export const actionLiteral = /\btype\s*(?::|===)\s*"([a-z]+\/[a-z-]+)"/g
const caseLiteral = /\bcase\s+"([a-z]+\/[a-z-]+)"/g

const literalsIn = (text: string, known: Set<string>): string[] =>
  [...text.matchAll(actionLiteral), ...text.matchAll(caseLiteral)]
    .map((match) => match[1]!)
    .filter((type) => known.has(type))

// The procedure namespace each adapter file is handed: a file that gets `runner.<ns>` calls
// that namespace as plain `runner.x(`.
const namespaceAliases = (scan: UiScan, backend: Source | null): Map<string, string> => {
  const aliases = new Map<string, string>()
  if (!backend) return aliases
  const namespaces = new Set(scan.api.procedures.map((procedure) => procedure.namespace))
  const backendImports = scan.importsOf(backendFile)
  backend.lines.forEach((line, i) => {
    const match = /\b(create\w+)\s*(?:<[^>]*>)?\(/.exec(line)
    const target = match ? backendImports.get(match[1]!) : undefined
    if (!match || !target || !target.startsWith(adapterDir)) return
    const chunk = backend.lines.slice(i, i + 14).join("\n")
    const ns = [...chunk.matchAll(/\brunner\.(\w+)\b/g)]
      .map((found) => found[1]!)
      .find((name) => namespaces.has(name))
    if (ns && !aliases.has(target)) aliases.set(target, ns)
  })
  return aliases
}

// Every line of the runner adapter that calls a procedure.
export const findSites = (scan: UiScan, backend: Source | null): Site[] => {
  const aliases = namespaceAliases(scan, backend)
  const sites: Site[] = []
  for (const file of scan.files.filter((each) => each.startsWith(adapterDir))) {
    const src = scan.sources.get(file)!
    const alias = aliases.get(file)
    src.lines.forEach((line, i) => {
      if (isComment(line)) return
      for (const procedure of scan.api.procedures) {
        const direct = new RegExp(`\\.${procedure.namespace}\\.${procedure.name}\\(`)
        const viaAlias =
          alias === procedure.namespace
            ? new RegExp(`\\b(?:runner|calls|streams)\\.${procedure.name}\\(`)
            : null
        if (direct.test(line) || viaAlias?.test(line))
          sites.push({ procedure: procedure.id, file, line: i + 1 })
      }
    })
  }
  if (!backend) scan.anchors.report("ui adapter", backendFile, "file not found")
  if (sites.length === 0)
    scan.anchors.report(
      "ui adapter",
      adapterDir,
      "found 0 procedure call sites in the runner adapter",
    )
  return sites
}

export type Reached = { fn: Fn; parent: Reached | null; refLine: number | null }

const factoryCalls = (scan: UiScan, name: string): { file: string; line: number }[] =>
  scan.allSources.flatMap((src) =>
    src.lines.flatMap((line, i) =>
      !isComment(line) &&
      new RegExp(`\\b${name}\\s*(?:<[^>]*>)?\\(`).test(line) &&
      !definitionOf(line)?.member
        ? src.fns.some((fn) => fn.start === i + 1 && fn.name === name)
          ? []
          : [{ file: src.file, line: i + 1 }]
        : [],
    ),
  )

// The functions one function refers to.
const edgesOf = (scan: UiScan, reached: Reached): Reached[] => {
  const src = scan.sources.get(reached.fn.file)
  if (!src) return []
  const out: Reached[] = []
  const add = (fn: Fn, refLine: number) => {
    if (fn !== reached.fn) out.push({ fn, parent: reached, refLine })
  }
  const importMap = scan.importsOf(src.file)
  const factoryVars = new Map<string, string>()
  src.lines.forEach((line) => {
    const match = /(?:const|let)\s+(\w+)\s*=\s*(create\w+)/.exec(line)
    if (match) {
      const target = importMap.get(match[2]!) ?? src.file
      factoryVars.set(match[1]!, target)
    }
  })
  for (let n = reached.fn.start; n <= reached.fn.end; n++) {
    const line = src.lines[n - 1] ?? ""
    if (isComment(line)) continue
    for (const match of line.matchAll(/(?<![\w$])(?<!(?<!\.)\.)([A-Za-z_]\w*)/g)) {
      const name = match[1]!
      // Named bindings only: a bare member name (`open`) is far too common a word.
      const target = src.fns.find(
        (fn) => fn.name === name && !fn.member && !fn.built && fn.start !== n,
      )
      if (target && target !== reached.fn) add(target, n)
    }
    for (const match of line.matchAll(/\b(\w+)\.(\w+)\(/g)) {
      const file = factoryVars.get(match[1]!)
      const other = file ? scan.sources.get(file) : undefined
      const target =
        other?.fns.find((fn) => fn.name === match[2]! && !fn.member && !fn.built) ??
        other?.fns.find((fn) => fn.name === match[2]! && fn.member)
      if (!target || !other) continue
      add(target, n)
      // The callbacks a factory's caller hands it are reached when its body calls them.
      const factory = other.fns.findLast(
        (fn) => fn.name.startsWith("create") && fn.start <= target.start && target.end <= fn.end,
      )
      if (!factory) continue
      const body = other.lines.slice(factory.start - 1, factory.end).join("\n")
      for (const call of factoryCalls(scan, factory.name)) {
        const owner = scan.sources.get(call.file)
        const binding = owner?.fns.find((fn) => fn.start === call.line)
        if (!owner || !binding) continue
        for (const member of owner.fns) {
          if (
            member.member &&
            member.start > binding.start &&
            member.end <= binding.end &&
            member.indent === binding.indent + 2 &&
            new RegExp(`\\b${member.name}\\(`).test(body)
          )
            add(member, call.line)
        }
      }
    }
  }
  return out
}

// The functions reachable from `roots` within `depth` hops, each with how it was reached.
export const reach = (scan: UiScan, roots: Fn[], depth: number): Reached[] => {
  const seen = new Map<Fn, Reached>()
  let frontier: Reached[] = roots.map((fn) => ({ fn, parent: null, refLine: null }))
  for (const each of frontier) seen.set(each.fn, each)
  for (let level = 0; level < depth && frontier.length; level++) {
    const next: Reached[] = []
    for (const each of frontier)
      for (const edge of edgesOf(scan, each))
        if (!seen.has(edge.fn)) {
          seen.set(edge.fn, edge)
          next.push(edge)
        }
    frontier = next
  }
  return [...seen.values()]
}

// The action types that gate `line`: tested on the lines it is nested under, or on the
// variable (`removed`) one of those lines or the call itself reads.
const guards = (src: Source, line: number, from: number, known: Set<string>): string[] => {
  const found = new Set<string>()
  let threshold = indentOf(src.lines[line - 1] ?? "")
  const gating = [src.lines[line - 1] ?? ""]
  for (let i = line - 2; i >= from - 1 && i >= 0; i--) {
    const text = src.lines[i]!
    if (blank(text) || isComment(text)) continue
    if (indentOf(text) < threshold) {
      threshold = indentOf(text)
      gating.push(text)
    }
  }
  for (const text of gating) for (const type of literalsIn(text, known)) found.add(type)
  if (found.size) return [...found]
  const words = new Set(gating.flatMap((text) => text.match(/[A-Za-z_]\w*/g) ?? []))
  for (const word of words) {
    for (let i = from; i < line - 1 && i < src.lines.length; i++) {
      if (!new RegExp(`^\\s*(?:const|let)\\s+${word}\\b`).test(src.lines[i]!)) continue
      const block = src.lines.slice(i, blockEnd(src.lines, i) + 1).join("\n")
      for (const type of literalsIn(block, known)) found.add(type)
    }
  }
  return [...found]
}

const chainNames = (each: Reached): string[] => {
  const names: string[] = []
  for (let step: Reached | null = each; step; step = step.parent) {
    const crossed = step.parent && step.parent.fn.file !== step.fn.file && !step.fn.member
    names.unshift(crossed ? `${stem(step.fn.file)}.${step.fn.name}` : step.fn.name)
  }
  return names
}

// What changed in the workspace when a call reached by no action type fires, by the
// lifecycle function on its way or the procedure it calls.
const triggerOf = (chain: string[], procedure: string): string => {
  const lifecycle = chain.toReversed().find((name) => name === "open" || name === "close")
  return lifecycle === "open"
    ? "terminal appears"
    : lifecycle === "close"
      ? "terminal leaves"
      : procedure === "projects.create"
        ? "project appears"
        : procedure === "sessions.create"
          ? "session appears"
          : "any commit"
}

// A procedure call the adapter's `commit` reaches.
export type CommitSite = Site & {
  // The action types that gate it.
  types: string[]
  // What changes in the workspace for it to run, where no action type gates it.
  label: string | null
  // The chain of functions from `commit` to the call.
  effectFn: string
}

export const findCommitSites = (
  scan: UiScan,
  backend: Source | null,
  sites: Site[],
  known: Set<string>,
): CommitSite[] => {
  const commitFn = backend?.fns.find((fn) => fn.name === "commit" && !fn.member)
  if (!commitFn)
    scan.anchors.report("ui commit path", backendFile, "expected a function named `commit`")
  const reachedBy = new Map(
    (commitFn ? reach(scan, [commitFn], 5) : []).map((each) => [each.fn, each]),
  )

  const commitSites: CommitSite[] = []
  for (const site of sites) {
    const src = scan.sources.get(site.file)!
    const owner = enclosing(src, site.line).find((fn) => reachedBy.has(fn))
    if (!owner) continue
    const reached = reachedBy.get(owner)!
    let types = guards(src, site.line, owner.start, known)
    for (let step: Reached | null = reached; step && !types.length; step = step.parent) {
      if (!step.parent || step.refLine === null) break
      const parentSource = scan.sources.get(step.parent.fn.file)
      if (parentSource) types = guards(parentSource, step.refLine, step.parent.fn.start, known)
    }
    const chain = chainNames(reached)
    commitSites.push({
      ...site,
      types,
      label: types.length ? null : triggerOf(chain, site.procedure),
      effectFn: chain.join(" > "),
    })
  }
  return commitSites
}
