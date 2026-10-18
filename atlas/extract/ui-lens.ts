import { dirname, posix } from "node:path"

import type { Anchor, UiLens } from "../src/atlas.ts"
import type {
  BoxItem,
  Dispatcher,
  Effect,
  UiAction,
  UiProcedure,
  UiStream,
  WiringBox,
} from "../src/lens-ui.ts"
import { sourceFiles } from "./files.ts"
import type { LensInput } from "./lens-input.ts"

// The UI from the inside, read by scanning its source (no type checker): the actions the
// workspace reducer takes, who builds them, what the runner adapter does on a commit, and
// which runner streams feed the store back. Indentation is relied on (the code is
// formatted), and every leg the scan cannot follow is left empty or flagged in the data.

const ui = "application/ui/src"
const stateFile = `${ui}/core/state.ts`
const portFile = `${ui}/backend/port.ts`
const adapterDir = `${ui}/backend/runner/`
const backendFile = `${adapterDir}backend.ts`

const isNoise = (file: string) =>
  /\/(demo|test|specs)\//.test(file) || /\/testing\.tsx?$/.test(file) || file.endsWith(".d.ts")

const indentOf = (line: string) => line.length - line.trimStart().length
const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line)
const blank = (line: string) => line.trim() === ""

// ---------------------------------------------------------------------------------------
// A light function index: named functions, arrow bindings and object members, with their
// line ranges found by indentation.

type Fn = {
  name: string
  file: string
  // 1-based, inclusive.
  start: number
  end: number
  indent: number
  member: boolean
  // `const x = createY(...)`: an object the factory built, not something to call.
  built?: boolean
}

type Source = { file: string; lines: string[]; fns: Fn[] }

const keywords = new Set(["if", "for", "while", "switch", "catch", "function", "return", "else"])

const definitionOf = (line: string): { name: string; member: boolean } | null => {
  let match = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)/.exec(line)
  if (match) return { name: match[1]!, member: false }
  match =
    /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\b[^=]*=\s*(?:async\s*)?(?:\(|<|\w+\s*=>|function\b|create\w+)/.exec(
      line,
    )
  if (match) return { name: match[1]!, member: false }
  match = /^\s*(?:async\s+)?(\w+)\s*:\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*[^=]+)?=>/.exec(
    line,
  )
  if (match) return { name: match[1]!, member: true }
  match = /^\s*(\w+):\s*(?:async\s*)?\($/.exec(line)
  if (match) return { name: match[1]!, member: true }
  match = /^\s*(?:async\s+)?(\w+)\([^)]*\)(?:\s*:\s*[^{;]+)?\s*\{$/.exec(line)
  if (match && !keywords.has(match[1]!)) return { name: match[1]!, member: true }
  return null
}

// The last line of the block that opens at `from` (0-based): until indentation returns.
const blockEnd = (lines: string[], from: number): number => {
  const indent = indentOf(lines[from]!)
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (blank(line)) continue
    const at = indentOf(line)
    if (at > indent) continue
    const text = line.trim()
    if (at === indent && text.startsWith(")") && (text.includes("=>") || text.endsWith("{")))
      continue
    return /^[)}\]]/.test(text) ? i : i - 1
  }
  return lines.length - 1
}

const indexSource = (file: string, text: string): Source => {
  const lines = text.split("\n")
  const fns: Fn[] = []
  lines.forEach((line, i) => {
    if (isComment(line)) return
    const found = definitionOf(line)
    if (!found) return
    fns.push({
      ...found,
      built: !found.member && /=\s*create\w+/.test(line) && !/=>/.test(line),
      file,
      start: i + 1,
      end: blockEnd(lines, i) + 1,
      indent: indentOf(line),
    })
  })
  return { file, lines, fns }
}

const enclosing = (source: Source, line: number): Fn[] =>
  source.fns
    .filter((fn) => fn.start <= line && line <= fn.end)
    .toSorted((a, b) => b.start - a.start || a.end - b.end)

// ---------------------------------------------------------------------------------------

type Reached = { fn: Fn; parent: Reached | null; refLine: number | null }

const actionLiteral = /\btype\s*(?::|===)\s*"([a-z]+\/[a-z-]+)"/g
const caseLiteral = /\bcase\s+"([a-z]+\/[a-z-]+)"/g

const literalsIn = (text: string, known: Set<string>): string[] =>
  [...text.matchAll(actionLiteral), ...text.matchAll(caseLiteral)]
    .map((match) => match[1]!)
    .filter((type) => known.has(type))

const at = (file: string, line: number): Anchor => ({ file, line })

export const extractUiLens = (input: LensInput): UiLens => {
  const { repo, anchors, api } = input
  const area = (file: string) => input.areaOf(file) ?? "ui"

  const files = sourceFiles(repo, ui).filter((file) => !isNoise(file))
  const sources = new Map<string, Source>()
  const source = (file: string): Source | null => {
    const cached = sources.get(file)
    if (cached) return cached
    const text = anchors.read(file)
    if (text === null) return null
    const made = indexSource(file, text)
    sources.set(file, made)
    return made
  }
  for (const file of files) source(file)
  const allSources = [...sources.values()]

  // ---- the actions -------------------------------------------------------------------
  const state = source(stateFile)
  const stateLines = state?.lines ?? []
  const unionStart = stateLines.findIndex((line) =>
    line.startsWith("export type WorkspaceAction ="),
  )
  if (unionStart === -1)
    anchors.report("ui actions", stateFile, 'expected "export type WorkspaceAction ="')
  const unionEnd = stateLines.findIndex(
    (line, i) => i > unionStart && /^export (const|type) /.test(line),
  )
  const declared = new Map<string, number>()
  for (let i = unionStart; i >= 0 && i < unionEnd; i++) {
    for (const match of stateLines[i]!.matchAll(/\btype:\s*"([a-z]+\/[a-z-]+)"/g))
      if (!declared.has(match[1]!)) declared.set(match[1]!, i + 1)
  }
  const known = new Set(declared.keys())
  if (unionStart !== -1 && declared.size === 0)
    anchors.report("ui actions", stateFile, "found 0 actions in `WorkspaceAction`")

  const reducerStart = stateLines.findIndex((line) =>
    line.startsWith("export const workspaceReducer"),
  )
  const caseLines = new Map<string, number>()
  for (let i = reducerStart; i >= 0 && i < stateLines.length; i++) {
    const match = /^ {4}case "([a-z]+\/[a-z-]+)":/.exec(stateLines[i]!)
    if (match && !caseLines.has(match[1]!)) caseLines.set(match[1]!, i + 1)
  }
  if (reducerStart === -1)
    anchors.report("ui reducer", stateFile, 'expected "export const workspaceReducer"')
  else if (caseLines.size === 0)
    anchors.report("ui reducer", stateFile, "found 0 `case` lines in `workspaceReducer`")
  const reducerText = (type: string): string => {
    const line = caseLines.get(type)
    if (!line) return ""
    let end = line
    while (end < stateLines.length && !/^ {4}(case "|default:)|^ {2}\}/.test(stateLines[end]!))
      end++
    return stateLines.slice(line - 1, end).join("\n")
  }

  // ---- procedure call sites in the adapter -------------------------------------------
  const adapterFiles = files.filter((file) => file.startsWith(adapterDir))
  const procById = new Map(api.procedures.map((procedure) => [procedure.id, procedure]))
  const namespaces = new Set(api.procedures.map((procedure) => procedure.namespace))

  // A file that gets `runner.<ns>` handed to it calls that namespace as plain `runner.x(`.
  const aliasNs = new Map<string, string>()
  const backend = source(backendFile)
  const imports = (file: string): Map<string, string> => {
    const map = new Map<string, string>()
    const text = anchors.read(file) ?? ""
    for (const match of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(\.[^"]*)"/g)) {
      const base = posix.normalize(posix.join(dirname(file), match[2]!))
      const target = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((each) =>
        sources.has(each),
      )
      if (!target) continue
      for (const name of match[1]!.split(",")) {
        const clean = name
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop()!
          .trim()
        if (clean) map.set(clean, target)
      }
    }
    return map
  }
  const backendImports = imports(backendFile)
  if (backend) {
    backend.lines.forEach((line, i) => {
      const match = /\b(create\w+)\s*(?:<[^>]*>)?\(/.exec(line)
      const target = match ? backendImports.get(match[1]!) : undefined
      if (!match || !target || !target.startsWith(adapterDir)) return
      const chunk = backend.lines.slice(i, i + 14).join("\n")
      const ns = [...chunk.matchAll(/\brunner\.(\w+)\b/g)]
        .map((found) => found[1]!)
        .find((name) => namespaces.has(name))
      if (ns && !aliasNs.has(target)) aliasNs.set(target, ns)
    })
  }

  type Site = { procedure: string; file: string; line: number }
  const sites: Site[] = []
  for (const file of adapterFiles) {
    const src = sources.get(file)!
    const alias = aliasNs.get(file)
    src.lines.forEach((line, i) => {
      if (isComment(line)) return
      for (const procedure of api.procedures) {
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

  if (!backend) anchors.report("ui adapter", backendFile, "file not found")
  if (sites.length === 0)
    anchors.report("ui adapter", adapterDir, "found 0 procedure call sites in the runner adapter")

  // ---- reachability ------------------------------------------------------------------
  const factoryCalls = (name: string): { file: string; line: number }[] =>
    allSources.flatMap((src) =>
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

  const edgesOf = (reached: Reached): Reached[] => {
    const src = sources.get(reached.fn.file)
    if (!src) return []
    const out: Reached[] = []
    const add = (fn: Fn, refLine: number) => {
      if (fn !== reached.fn) out.push({ fn, parent: reached, refLine })
    }
    const importMap = imports(src.file)
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
        const other = file ? sources.get(file) : undefined
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
        for (const call of factoryCalls(factory.name)) {
          const owner = sources.get(call.file)
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

  const reach = (roots: Fn[], depth: number): Reached[] => {
    const seen = new Map<Fn, Reached>()
    let frontier: Reached[] = roots.map((fn) => ({ fn, parent: null, refLine: null }))
    for (const each of frontier) seen.set(each.fn, each)
    for (let level = 0; level < depth && frontier.length; level++) {
      const next: Reached[] = []
      for (const each of frontier)
        for (const edge of edgesOf(each))
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
  const guards = (src: Source, line: number, from: number): string[] => {
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

  // ---- the commit path ---------------------------------------------------------------
  const commitFn = backend?.fns.find((fn) => fn.name === "commit" && !fn.member)
  if (!commitFn) anchors.report("ui commit path", backendFile, "expected a function named `commit`")
  const commitReach = commitFn ? reach([commitFn], 5) : []
  const reachedBy = new Map(commitReach.map((each) => [each.fn, each]))

  const chainNames = (each: Reached): string[] => {
    const names: string[] = []
    for (let step: Reached | null = each; step; step = step.parent) {
      const base = step.fn.file
        .split("/")
        .at(-1)!
        .replace(/\.tsx?$/, "")
      const crossed = step.parent && step.parent.fn.file !== step.fn.file && !step.fn.member
      names.unshift(crossed ? `${base}.${step.fn.name}` : step.fn.name)
    }
    return names
  }

  type CommitSite = Site & {
    reached: Reached
    types: string[]
    label: string | null
    effectFn: string
  }
  const commitSites: CommitSite[] = []
  for (const site of sites) {
    const src = sources.get(site.file)!
    const owner = enclosing(src, site.line).find((fn) => reachedBy.has(fn))
    if (!owner) continue
    const reached = reachedBy.get(owner)!
    let types = guards(src, site.line, owner.start)
    for (let step: Reached | null = reached; step && !types.length; step = step.parent) {
      if (!step.parent || step.refLine === null) break
      const parentSource = sources.get(step.parent.fn.file)
      if (parentSource) types = guards(parentSource, step.refLine, step.parent.fn.start)
    }
    let label: string | null = null
    if (!types.length) {
      const chain = chainNames(reached)
      const lifecycle = chain.toReversed().find((name) => name === "open" || name === "close")
      label =
        lifecycle === "open"
          ? "terminal appears"
          : lifecycle === "close"
            ? "terminal leaves"
            : site.procedure === "projects.create"
              ? "project appears"
              : site.procedure === "sessions.create"
                ? "session appears"
                : "any commit"
    }
    commitSites.push({ ...site, reached, types, label, effectFn: chainNames(reached).join(" > ") })
  }

  // ---- streams (the return path) -----------------------------------------------------
  const streamSites = sites.filter((site) => procById.get(site.procedure)?.kind === "stream")
  const streams: UiStream[] = []
  const streamReach = new Map<string, Reached[]>()
  for (const site of streamSites) {
    const src = sources.get(site.file)!
    const line = src.lines[site.line - 1]!
    const variable = /(\w+)\s*=\s*(?:await\s+)?[\w.]*\.\w+\(/.exec(line)?.[1]
    let handler: Fn | undefined
    let rootFns: Fn[] = []
    const consumed = variable
      ? new RegExp(`consume\\(\\s*${variable}\\s*,\\s*(\\w+)`).exec(src.lines.join("\n"))?.[1]
      : undefined
    if (consumed) handler = src.fns.find((fn) => fn.name === consumed && !fn.member)
    if (handler) rootFns = [handler]
    else {
      // A `for await` over the stream: that loop is the handler.
      const loop = src.lines.findIndex(
        (text, i) =>
          i >= site.line - 1 &&
          /for await/.test(text) &&
          (variable ? new RegExp(`\\bof\\s+${variable}\\b`).test(text) : text.includes(".")),
      )
      const loopStart =
        loop === -1
          ? src.lines.findIndex((text, i) => i >= site.line - 1 && /for await/.test(text))
          : loop
      const within = enclosing(src, site.line)[0]
      if (loopStart !== -1 && within && loopStart + 1 <= within.end) {
        handler = {
          name: `${within.name} loop`,
          file: site.file,
          start: loopStart + 1,
          end: blockEnd(src.lines, loopStart) + 1,
          indent: indentOf(src.lines[loopStart]!),
          member: false,
        }
        rootFns = [handler]
      } else if (within) rootFns = [within]
    }
    const reached = rootFns.length ? reach(rootFns, 3) : []
    streamReach.set(site.procedure, reached)
    const text = reached
      .map((each) =>
        (sources.get(each.fn.file)?.lines ?? []).slice(each.fn.start - 1, each.fn.end).join("\n"),
      )
      .join("\n")
    const opens = /\b(?:next|sink)\.open\(/.test(text)
    const dispatches = opens
      ? []
      : [
          ...new Set(
            [...text.matchAll(actionLiteral)]
              .map((match) => match[1]!)
              .filter((type) => known.has(type)),
          ),
        ].toSorted()
    const base = site.file
      .split("/")
      .at(-1)!
      .replace(/\.tsx?$/, "")
    streams.push({
      procedure: site.procedure,
      site: at(site.file, site.line),
      handler: handler ? at(handler.file, handler.start) : null,
      dispatches,
      feeds: dispatches.length
        ? "workspace"
        : /\b(?:next|sink)\.open\(/.test(text)
          ? "sink.open: the app adds the terminal"
          : /\.update\(/.test(text)
            ? `${base} store`
            : null,
    })
  }
  // One entry per stream procedure; the first call site that resolves a handler wins.
  const streamById = new Map<string, UiStream>()
  for (const each of streams) {
    const have = streamById.get(each.procedure)
    if (!have || (!have.handler && each.handler)) streamById.set(each.procedure, each)
  }
  const uniqueStreams = [...streamById.values()].toSorted((a, b) =>
    a.procedure.localeCompare(b.procedure),
  )

  // ---- who dispatches ----------------------------------------------------------------
  // Files that import the module `defining`, or a module that does (the app hands its
  // commands around through a context), and use `name`: the name alone is too common a word
  // (`add`) to count every file that mentions it.
  const importsCache = new Map<string, Map<string, string>>()
  const importsOf = (file: string): Map<string, string> => {
    const cached = importsCache.get(file)
    if (cached) return cached
    const made = imports(file)
    importsCache.set(file, made)
    return made
  }
  const reaches = (file: string, target: string, hops: number): boolean => {
    const next = new Set(importsOf(file).values())
    return (
      next.has(target) || (hops > 1 && [...next].some((each) => reaches(each, target, hops - 1)))
    )
  }
  const callersOf = (name: string, defining: string): { files: number; areas: string[] } => {
    const pattern = new RegExp(`(?:\\.${name}\\b|(?<![.\\w])${name}\\()`)
    const hits = allSources.filter(
      (src) =>
        src.file !== defining &&
        !src.file.startsWith(adapterDir) &&
        reaches(src.file, defining, 2) &&
        src.lines.some((line) => !isComment(line) && pattern.test(line)),
    )
    return { files: hits.length, areas: [...new Set(hits.map((hit) => area(hit.file)))].toSorted() }
  }

  const fromUi = new Map<string, Dispatcher[]>()
  const fromAdapter = new Map<string, { anchor: Anchor; fn: string | null }[]>()
  for (const src of allSources) {
    if (src.file === stateFile || src.file.endsWith(".d.ts")) continue
    src.lines.forEach((line, i) => {
      if (isComment(line)) return
      for (const match of line.matchAll(/\btype:\s*"([a-z]+\/[a-z-]+)"/g)) {
        const type = match[1]!
        if (!known.has(type)) continue
        const fn = enclosing(src, i + 1)[0] ?? null
        if (src.file.startsWith(adapterDir)) {
          fromAdapter.set(type, [
            ...(fromAdapter.get(type) ?? []),
            { anchor: at(src.file, i + 1), fn: fn?.name ?? null },
          ])
        } else if (src.file !== portFile) {
          // A command is an object member or a binding; the name the callers use is its own.
          const named = enclosing(src, i + 1).find((each) => !/^(commit|dispatch)$/.test(each.name))
          fromUi.set(type, [
            ...(fromUi.get(type) ?? []),
            {
              area: area(src.file),
              anchor: at(src.file, i + 1),
              fn: named?.name ?? null,
              callers: named ? callersOf(named.name, src.file) : null,
            },
          ])
        }
      }
    })
  }

  // ---- actions -----------------------------------------------------------------------
  const diffLinks: Record<string, (type: string, text: string) => boolean> = {
    "terminal appears": (_, text) => /\baddTerminal\(/.test(text),
    "terminal leaves": (type, text) =>
      /\b(closeTerminal|removeTerminal)\(/.test(text) || type === "project/remove",
    "project appears": (type) => type === "project/add",
    "session appears": (type, text) =>
      /history: \[|initialSession/.test(text) && type !== "project/remove",
  }

  const actions: UiAction[] = [...declared.entries()].map(([type, line]) => {
    const text = reducerText(type)
    const effects: Effect[] = []
    for (const site of commitSites) {
      const label = site.label
      const direct = site.types.includes(type)
      const diff = label !== null && diffLinks[label]?.(type, text) === true
      if (!direct && !diff) continue
      // One effect per procedure: the first site that reaches it names the chain.
      const basis = direct ? "action" : "diff"
      const trigger = direct ? null : label
      if (
        effects.some(
          (effect) =>
            effect.basis === basis &&
            effect.trigger === trigger &&
            effect.procedures[0] === site.procedure,
        )
      )
        continue
      effects.push({
        basis,
        via: site.effectFn,
        trigger,
        anchor: at(site.file, site.line),
        procedures: [site.procedure],
      })
    }
    // Items and windows are tested by action type in the adapter; their procedures are
    // reached through the closure handed to `send`, so those are found above as guarded.
    const fromApp = fromUi.get(type) ?? []
    const adapter = fromAdapter.get(type) ?? []
    return {
      type,
      prefix: type.split("/")[0]!,
      declared: at(stateFile, line),
      reducer: caseLines.has(type) ? at(stateFile, caseLines.get(type)!) : null,
      fromUi: fromApp,
      fromAdapter: adapter,
      returns: uniqueStreams
        .filter((stream) => stream.dispatches.includes(type))
        .map((s) => s.procedure),
      effects,
      untraced:
        fromApp.length || adapter.length
          ? null
          : "no dispatch site found: built by a helper the scan does not follow, or never dispatched",
    }
  })

  // ---- effects of every commit -------------------------------------------------------
  const everyCommit: Effect[] = []
  for (const site of commitSites) {
    if (site.label !== "any commit") continue
    everyCommit.push({
      basis: "diff",
      via: site.effectFn,
      trigger: "any commit",
      anchor: at(site.file, site.line),
      procedures: [site.procedure],
    })
  }
  // Session saves go through a callback the commit only marks, so name them from the wiring.
  const saveSite = sites.find((site) => site.procedure === "sessions.save")
  if (saveSite && !everyCommit.some((effect) => effect.procedures.includes("sessions.save")))
    everyCommit.push({
      basis: "diff",
      via: "commit > saves.note > save",
      trigger: "session state changed",
      anchor: at(saveSite.file, saveSite.line),
      procedures: ["sessions.save"],
    })

  // ---- procedures --------------------------------------------------------------------
  const procedures: UiProcedure[] = [...new Set(sites.map((site) => site.procedure))]
    .toSorted()
    .map((id) => {
      const viaActions = actions
        .filter((action) => action.effects.some((effect) => effect.procedures.includes(id)))
        .map((action) => action.type)
      return {
        id,
        kind: procById.get(id)!.kind,
        sites: sites
          .filter((site) => site.procedure === id)
          .map((site) => at(site.file, site.line)),
        actions: viaActions,
        fromCommit:
          viaActions.length > 0 || everyCommit.some((effect) => effect.procedures.includes(id)),
      }
    })

  // ---- the wiring boxes --------------------------------------------------------------
  const item = (
    label: string,
    file: string | null,
    line: number | null,
    note?: string,
  ): BoxItem => ({
    label,
    area: file ? area(file) : null,
    anchor: file ? at(file, line ?? 1) : null,
    ...(note === undefined ? {} : { note }),
  })
  const perFile = (hits: Map<string, { count: number; first: number }>, noun: string): BoxItem[] =>
    [...hits.entries()]
      .toSorted((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .map(([file, hit]) =>
        item(
          file.slice(ui.length + 1),
          file,
          hit.first,
          `${hit.count} ${noun}${hit.count === 1 ? "" : "s"}`,
        ),
      )
  const scan = (pattern: RegExp, include: (file: string) => boolean) => {
    const hits = new Map<string, { count: number; first: number }>()
    let total = 0
    for (const src of allSources) {
      if (!include(src.file)) continue
      src.lines.forEach((line, i) => {
        if (isComment(line) || /^\s*export (const|function)/.test(line)) return
        const count = [...line.matchAll(pattern)].length
        if (!count) return
        total += count
        const have = hits.get(src.file)
        hits.set(src.file, { count: (have?.count ?? 0) + count, first: have?.first ?? i + 1 })
      })
    }
    return { hits, total }
  }

  const readers = scan(
    /\b(?:useWorkspaceState|useUiState|useStoreSelector|useSyncExternalStore)\(/g,
    (f) => f !== `${ui}/core/store.ts`,
  )
  const writers = scan(
    /\b(?:workspace|store)\.(?:dispatch|transact)\(/g,
    (f) => !f.startsWith(`${ui}/backend/`) && f !== `${ui}/core/store.ts`,
  )
  const uiWrites = scan(/\b(?:ui\.update|updateShell)\(/g, (f) => !f.startsWith(`${ui}/backend/`))
  const featureStores = scan(/\bcreateStore\s*(?:<[^(]*>)?\(/g, (f) => f !== `${ui}/core/store.ts`)

  const uiStateLines = source(`${ui}/app/ui-store.ts`)?.lines ?? []
  const uiStateStart = uiStateLines.findIndex((l) => l.startsWith("export type UiState"))
  if (uiStateStart === -1)
    anchors.report("ui store", `${ui}/app/ui-store.ts`, 'expected "export type UiState"')
  const uiSlices: BoxItem[] = []
  for (
    let i = uiStateStart + 1;
    i < uiStateLines.length && !uiStateLines[i]!.startsWith("}");
    i++
  ) {
    const match = /^ {2}readonly (\w+):/.exec(uiStateLines[i]!)
    if (match) uiSlices.push(item(match[1]!, `${ui}/app/ui-store.ts`, i + 1))
  }

  if (uiStateStart !== -1 && uiSlices.length === 0)
    anchors.report("ui store", `${ui}/app/ui-store.ts`, "found 0 slices in `UiState`")

  const prefixes = new Map<string, UiAction[]>()
  for (const action of actions)
    prefixes.set(action.prefix, [...(prefixes.get(action.prefix) ?? []), action])

  const portLines = source(portFile)?.lines ?? []
  const backendStart = portLines.findIndex((l) => l.startsWith("export type BackendFields = {"))
  if (backendStart === -1)
    anchors.report("ui backend port", portFile, 'expected "export type BackendFields = {"')
  const portMembers: BoxItem[] = []
  for (let i = backendStart + 1; i < portLines.length && !portLines[i]!.startsWith("}"); i++) {
    const match = /^ {2}readonly (\w+)\??[:=]/.exec(portLines[i]!)
    if (match)
      portMembers.push(
        item(
          match[1]!,
          portFile,
          i + 1,
          match[1] === "commit" ? "called inside every commit" : undefined,
        ),
      )
  }
  if (backendStart !== -1 && portMembers.length === 0)
    anchors.report("ui backend port", portFile, "found 0 members in `BackendFields`")
  portMembers.sort((a, b) => Number(b.label === "commit") - Number(a.label === "commit"))

  // The action types the adapter may dispatch back: the quoted types in `BackendAction`.
  const sinkTypes: BoxItem[] = []
  const sinkStart = portLines.findIndex((l) => l.startsWith("export type BackendAction"))
  if (sinkStart === -1)
    anchors.report("ui backend port", portFile, 'expected "export type BackendAction"')
  for (let i = sinkStart + 1; i < portLines.length; i++) {
    if (sinkStart === -1) break
    if (/^(?:>|\}|export )/.test(portLines[i]!)) break
    for (const match of portLines[i]!.matchAll(/"([a-z]+\/[a-z-]+)"/g))
      sinkTypes.push(item(match[1]!, portFile, i + 1))
  }
  if (sinkStart !== -1 && sinkTypes.length === 0)
    anchors.report("ui backend port", portFile, "found 0 action types in `BackendAction`")

  const adapterHits = new Map<string, { count: number; first: number }>()
  for (const site of sites) {
    const have = adapterHits.get(site.file)
    adapterHits.set(site.file, { count: (have?.count ?? 0) + 1, first: have?.first ?? site.line })
  }

  const calledIds = new Set(procedures.map((procedure) => procedure.id))
  const byNs = new Map<string, { served: number; called: number }>()
  for (const procedure of api.procedures) {
    const have = byNs.get(procedure.namespace) ?? { served: 0, called: 0 }
    byNs.set(procedure.namespace, {
      served: have.served + 1,
      called: have.called + Number(calledIds.has(procedure.id)),
    })
  }

  const boxes: WiringBox[] = [
    {
      id: "components",
      title: "Components & hooks",
      count: readers.total,
      unit: "selectors",
      items: perFile(readers.hits, "read"),
    },
    {
      id: "commands",
      title: "Commands & controller",
      count: writers.total,
      unit: "dispatch sites",
      items: perFile(writers.hits, "site"),
    },
    {
      id: "workspace",
      title: "Workspace store",
      count: actions.length,
      unit: "action types",
      items: [
        item(
          "createWorkspaceStore",
          `${ui}/core/store.ts`,
          anchors.find(`${ui}/core/store.ts`, "export const createWorkspaceStore"),
        ),
        ...[...prefixes.entries()].map(([prefix, list]) =>
          item(
            `${prefix}/`,
            stateFile,
            list[0]!.reducer?.line ?? 1,
            `${list.length} action${list.length === 1 ? "" : "s"}`,
          ),
        ),
      ],
    },
    {
      id: "ui",
      title: "UI store",
      count: uiSlices.length,
      unit: "slices",
      items: [
        item(
          "update() sites",
          `${ui}/app/ui-store.ts`,
          1,
          `${uiWrites.total} in ${uiWrites.hits.size} files`,
        ),
        ...uiSlices,
      ],
    },
    {
      id: "feature",
      title: "Feature stores",
      count: featureStores.total,
      unit: "createStore",
      items: perFile(featureStores.hits, "store"),
    },
    {
      id: "port",
      title: "Backend port",
      count: portMembers.length,
      unit: "members",
      items: portMembers,
    },
    {
      id: "adapter",
      title: "Runner adapter",
      count: adapterHits.size,
      unit: "files call it",
      items: perFile(adapterHits, "call"),
    },
    {
      id: "procedures",
      title: "oRPC procedures",
      count: procedures.filter((procedure) => procedure.kind === "call").length,
      unit: "calls",
      items: procedures
        .filter((procedure) => procedure.kind === "call")
        .map((procedure) =>
          item(
            procedure.id,
            procedure.sites[0]!.file,
            procedure.sites[0]!.line,
            procedure.fromCommit ? "from a commit" : "other",
          ),
        ),
    },
    {
      id: "runner",
      title: "Runner",
      count: api.procedures.length,
      unit: "procedures served",
      items: [...byNs.entries()].map(([ns, counts]) =>
        item(
          ns,
          "application/protocol/src/contract.ts",
          1,
          `${counts.called} of ${counts.served} called by the UI`,
        ),
      ),
    },
    {
      id: "streams",
      title: "Runner streams",
      count: uniqueStreams.length,
      unit: "streams",
      items: uniqueStreams.map((stream) =>
        item(
          stream.procedure,
          stream.site.file,
          stream.site.line,
          stream.dispatches.length
            ? `${stream.dispatches.length} actions`
            : (stream.feeds ?? "no store write found"),
        ),
      ),
    },
    {
      id: "consumers",
      title: "Stream handlers",
      count: uniqueStreams.filter((stream) => stream.handler).length,
      unit: "handlers",
      items: uniqueStreams
        .filter((stream) => stream.handler)
        .map((stream) => item(stream.procedure, stream.handler!.file, stream.handler!.line)),
    },
    {
      id: "sink",
      title: "Sink dispatch",
      count: sinkTypes.length,
      unit: "action types",
      items: sinkTypes,
    },
  ]

  const dispatchedFromUi = actions.filter((action) => action.fromUi.length).length
  return {
    boxes,
    actions,
    procedures,
    streams: uniqueStreams,
    everyCommit,
    totals: {
      actions: actions.length,
      dispatchedFromUi,
      dispatchedFromAdapter: actions.filter((action) => action.fromAdapter.length).length,
      withoutDispatcher: actions.filter((action) => action.untraced).length,
      reachingBackend: actions.filter((action) => action.effects.length).length,
      byAction: actions.filter((action) => action.effects.some((e) => e.basis === "action")).length,
      byDiff: actions.filter((action) => action.effects.some((e) => e.basis === "diff")).length,
      procedures: procedures.length,
      streams: uniqueStreams.length,
      streamsToStore: uniqueStreams.filter((stream) => stream.feeds).length,
    },
  }
}
