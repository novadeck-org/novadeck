import { matchesGlob } from "node:path"

import type { Anchor, Area, Atlas, JsonSchema, Procedure, Table } from "../src/atlas.ts"

// Briefs: the atlas as short Markdown for an agent to read before it works in a part of
// the code. Each keeps to what fits in a glance (the index under 8000 characters, every
// other brief under 6000, about 1.5k tokens; brief.test.ts enforces both), names areas by
// their tokens, and says plainly where the static trace stops.

const at = (anchor: Anchor | null) =>
  anchor === null ? "?" : anchor.line === null ? anchor.file : `${anchor.file}:${anchor.line}`

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

// "a, b, c, +4 more"
const list = (items: string[], max = 12) =>
  items.length === 0
    ? "none"
    : items.length > max
      ? `${items.slice(0, max).join(", ")}, +${items.length - max} more`
      : items.join(", ")

const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`)

const areaOfFile = (atlas: Atlas, file: string) =>
  atlas.areas.find((area) => area.globs.some((glob) => matchesGlob(file, glob)))?.id ?? null

const nodeTitle = (atlas: Atlas, id: string) =>
  atlas.runtime.nodes.find((node) => node.id === id)?.title ?? id

const uncertain =
  "Static trace: read from the source a few calls deep; callbacks and dynamic dispatch are invisible."

// ---------------------------------------------------------------------------------------
// The index: every subject an agent can ask about.

// Whether an area is the one a token names or one below it.
const under = (prefix: string) => (area: Area) =>
  area.id === prefix || area.id.startsWith(`${prefix}/`)

export const renderIndex = (atlas: Atlas): string => {
  const byTop = new Map<string, Area[]>()
  for (const area of atlas.areas) {
    const top = area.id.split("/")[0]!
    byTop.set(top, [...(byTop.get(top) ?? []), area])
  }
  const lines = [
    `# Novadeck atlas (${atlas.commit.slice(0, 7)})`,
    "",
    "Areas are named by tokens that mirror where the code lives: a package, then a segment per",
    "folder (`backend/runner/terminals` is backend/runner/src/terminals). Use them when you talk",
    "about the code.",
    "",
    "Ask for a brief: `pnpm -s atlas:brief <subject>`. A subject is an area token, a procedure",
    "(`terminals.create`), a UI action (`terminal/add`), a table, an MCP tool or a flow; prefix",
    "with `area:`, `procedure:`, `action:`, `table:`, `tool:` or `flow:` when a name is ambiguous.",
    "Overviews: `api`, `data`, `state` (UI wiring), `flows`, `harnesses`.",
    "",
    "## Areas (lines)",
  ]
  for (const [top, areas] of byTop) {
    lines.push("", `### ${top}`)
    for (const area of areas)
      lines.push(
        `- \`${area.id}\` ${compact(area.lines)}${area.purpose ? ` — ${clip(area.purpose, 90)}` : ""}`,
      )
  }
  lines.push(
    "",
    "## Runtime: which process runs which areas",
    ...atlas.runtime.nodes.flatMap((node) => {
      const own = atlas.areas.filter((area) => area.node === node.id)
      if (own.length === 0) return []
      // A whole tree in one process reads as `frontend/*`, and a whole package as
      // `backend/runner/*`.
      const collapse = (prefix: string, depth: number): string[] => {
        const all = atlas.areas.filter(under(prefix))
        const here = own.filter(under(prefix))
        if (here.length === all.length && all.length > 1) return [`\`${prefix}/*\``]
        if (depth === 2) return here.map((area) => `\`${area.id}\``)
        const packages = [...new Set(here.map((area) => area.id.split("/").slice(0, 2).join("/")))]
        return packages.flatMap((each) => collapse(each, 2))
      }
      const tops = [...new Set(own.map((area) => area.id.split("/")[0]!))]
      const named = tops.flatMap((top) => collapse(top, 1))
      return [`- ${node.title}: ${named.join(", ")}`]
    }),
    "",
    `${atlas.api.procedures.length} procedures, ${atlas.data.tables.length} tables, ` +
      `${atlas.ui.actions.length} UI actions, ${atlas.agents.tools.length} MCP tools, ${atlas.flows.length} flows.`,
  )
  if (atlas.broken.length > 0)
    lines.push(
      `Warning: ${atlas.broken.length} broken anchors; run \`pnpm --filter @novadeck/atlas check\`.`,
    )
  return lines.join("\n")
}

// ---------------------------------------------------------------------------------------
// An area.

export const renderArea = (atlas: Atlas, area: Area): string => {
  const out = [`# Area \`${area.id}\``, ""]
  if (area.purpose) out.push(area.purpose, "")
  out.push(
    `Runs in ${nodeTitle(atlas, area.node)}. ${compact(area.lines)} lines in ${area.files} files ` +
      `(${area.tests} tests). Owns ${area.globs.join(", ")}.`,
  )
  const parent = area.id.includes("/") ? area.id.slice(0, area.id.lastIndexOf("/")) : null
  const children = atlas.areas
    .filter((a) => a.id.startsWith(`${area.id}/`) && !a.id.slice(area.id.length + 1).includes("/"))
    .map((a) => `\`${a.id}\``)
  if (parent && atlas.areas.some((a) => a.id === parent)) out.push(`Inside \`${parent}\`.`)
  if (children.length > 0) out.push(`Contains ${list(children, 20)}.`)
  if (area.entries.length > 0)
    out.push("", "Start reading at:", ...area.entries.map((e) => `- ${at(e)}`))
  if (area.docs.length > 0) out.push(`Docs: ${area.docs.join(", ")}`)

  const links = (side: "from" | "to") => {
    const other = side === "from" ? "to" : "from"
    const tally = new Map<string, Map<string, number>>()
    for (const link of atlas.links.filter((l) => l[side] === area.id && l[other] !== area.id)) {
      const kinds = tally.get(link[other]) ?? new Map<string, number>()
      kinds.set(link.kind, (kinds.get(link.kind) ?? 0) + link.weight)
      tally.set(link[other], kinds)
    }
    return [...tally]
      .map(([id, kinds]) => ({ id, kinds, weight: [...kinds.values()].reduce((a, b) => a + b, 0) }))
      .toSorted((a, b) => b.weight - a.weight)
      .map(({ id, kinds }) => `\`${id}\` (${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ")})`)
  }
  out.push("", `Depends on: ${list(links("from"), 10)}`, `Used by: ${list(links("to"), 10)}`)

  if (area.procedures.length > 0)
    out.push(`Serves procedures (${area.procedures.length}): ${list(area.procedures, 20)}`)
  const touched = (side: "readers" | "writers") =>
    atlas.data.tables
      .filter((t) => t[side].some((anchor) => areaOfFile(atlas, anchor.file) === area.id))
      .map((t) => t.name)
  const reads = touched("readers")
  const writes = touched("writers")
  if (reads.length + writes.length > 0)
    out.push(`Tables: reads ${list(reads)}; writes ${list(writes)}.`)
  if (area.tools.length > 0) out.push(`MCP tools: ${list(area.tools)}`)

  const stack = atlas.stacks.find((s) => s.token === area.id)
  if (stack) {
    const lead = stack.deps.filter((d) => d.lead || d.kind === "runtime")
    out.push(
      "",
      `Stack (${stack.name}, ${at(stack.manifest)}): ${list(
        lead.map((d) => `${d.name} ${d.version}`),
        14,
      )}`,
    )
  }
  if (area.id === "frontend/ui" || area.id.startsWith("frontend/ui/"))
    out.push("", "How UI state and calls are wired: `state`.")
  if (area.procedures.length > 0) out.push("Each procedure's path to the SQL: `procedure:<id>`.")
  return out.join("\n")
}

// ---------------------------------------------------------------------------------------
// A procedure, from the contract down to the SQL.

// `{ id: string, cols?: integer }`, top-level fields only.
const shape = (schema: JsonSchema | null): string => {
  if (schema === null || Object.keys(schema).every((key) => key === "$schema")) return "nothing"
  const props = schema["properties"] as Record<string, JsonSchema> | undefined
  if (!props) return typeOf(schema)
  const required = new Set((schema["required"] as string[] | undefined) ?? [])
  const fields = Object.entries(props).map(
    ([name, prop]) => `${name}${required.has(name) ? "" : "?"}: ${typeOf(prop)}`,
  )
  return `{ ${clip(fields.join(", "), 220)} }`
}

const typeOf = (schema: JsonSchema): string => {
  if ("const" in schema) return JSON.stringify(schema["const"])
  if (Array.isArray(schema["enum"]))
    return (schema["enum"] as unknown[]).map((v) => JSON.stringify(v)).join(" | ")
  const union = (schema["anyOf"] ?? schema["oneOf"]) as JsonSchema[] | undefined
  if (union) return union.length > 3 ? `union of ${union.length}` : union.map(typeOf).join(" | ")
  if (typeof schema["$ref"] === "string") return (schema["$ref"] as string).split("/").at(-1)!
  const type = schema["type"]
  if (type === "array") return `${typeOf((schema["items"] as JsonSchema | undefined) ?? {})}[]`
  if (type === "object") return "object"
  return typeof type === "string" ? type : Array.isArray(type) ? type.join(" | ") : "unknown"
}

export const renderProcedure = (atlas: Atlas, procedure: Procedure): string => {
  const out = [
    `# Procedure \`${procedure.id}\` (${procedure.kind})`,
    "",
    `Area \`${procedure.area ?? "?"}\`. Contract ${at(procedure.anchor)}; handler ${at(procedure.handler)}.`,
    `Input: ${shape(procedure.input)}`,
    `${procedure.kind === "stream" ? "Yields" : "Output"}: ${shape(procedure.output)}`,
    `Errors: ${list(procedure.errors)} (from the handler and router only; deeper helpers may raise more)`,
  ]
  const callers = procedure.callers.map((c) => `${areaOfFile(atlas, c.file) ?? "?"} ${at(c)}`)
  out.push(`Called from: ${list(callers, 6)}`)

  const ui = atlas.ui.procedures.find((p) => p.id === procedure.id)
  if (ui) {
    const actions = atlas.ui.actions.flatMap((action) =>
      action.effects
        .filter((e) => e.procedures.includes(procedure.id))
        .map(
          (e) =>
            `\`${action.type}\`${e.basis === "diff" ? ` (inferred: ${e.trigger ?? "state diff"})` : ""}`,
        ),
    )
    out.push(
      ui.fromCommit
        ? `Reached by UI actions: ${list([...new Set(actions)], 10)}${
            atlas.ui.everyCommit.some((e) => e.procedures.includes(procedure.id))
              ? "; and every commit"
              : ""
          }`
        : "No path from a store commit was found by the static scan.",
    )
  }

  const trace = atlas.runner.procedures.find((p) => p.id === procedure.id)
  if (trace) {
    out.push("", "Down to the database:")
    for (const step of trace.steps)
      out.push(
        `${"  ".repeat(step.depth)}- ${step.label} (${at(step.anchor)})${
          step.store.length > 0 ? ` → store.${step.store.join(", store.")}` : ""
        }`,
      )
    if (!trace.traced) {
      out.push(`No store call found. That means unknown, not "no database". ${uncertain}`)
    } else {
      const methods = [...new Set(trace.reached.map((r) => r.method))]
      out.push("", "SQL it reaches:")
      for (const name of methods) {
        const method = atlas.runner.methods.find((m) => m.name === name)
        for (const statement of method?.statements ?? [])
          out.push(
            `- ${name} (${statement.kind}): \`${clip(statement.sql, 140)}\` ${at(statement.anchor)}`,
          )
      }
      out.push(uncertain)
    }
  }
  return out.join("\n")
}

// ---------------------------------------------------------------------------------------
// A UI action, from who dispatches it to what reaches the runner.

export const renderAction = (atlas: Atlas, type: string): string => {
  const action = atlas.ui.actions.find((a) => a.type === type)!
  const out = [
    `# UI action \`${action.type}\``,
    "",
    `Declared ${at(action.declared)}; reducer ${at(action.reducer)}.`,
  ]
  if (action.fromUi.length > 0) {
    out.push("", "Dispatched by:")
    for (const d of action.fromUi)
      out.push(
        `- \`${d.area}\` ${d.fn ? `${d.fn}()` : "?"} ${at(d.anchor)}${
          d.callers
            ? d.callers.files === 0
              ? " (no caller found in files that reach its module; used inside it, or through wiring the scan does not follow)"
              : ` (used in ${d.callers.files} file${d.callers.files === 1 ? "" : "s"} that reach its module, in ${list(
                  d.callers.areas.map((a) => `\`${a}\``),
                  6,
                )})`
            : ""
        }`,
      )
  }
  if (action.fromAdapter.length > 0)
    out.push(
      `Dispatched back by the runner adapter: ${list(
        action.fromAdapter.map((s) => `${s.fn ?? "?"} ${at(s.anchor)}`),
        4,
      )}`,
    )
  out.push("", "Reaches the runner:")
  if (action.effects.length === 0)
    out.push(
      "- no runner call found by the static scan for this action (below: calls on the commit path)",
    )
  for (const effect of action.effects)
    out.push(
      `- ${list(effect.procedures.map((p) => `\`${p}\``))} via ${effect.via} ${at(effect.anchor)} — ${
        effect.basis === "action"
          ? "the adapter tests this action"
          : `inferred from the state diff: ${effect.trigger ?? "?"}`
      }`,
    )
  const onCommit = atlas.ui.everyCommit.map(
    (e) =>
      `${list(e.procedures.map((p) => `\`${p}\``))} via ${e.via} (${e.trigger === null || e.trigger === "any commit" ? "trigger not found" : e.trigger}) ${at(e.anchor)}`,
  )
  if (onCommit.length > 0)
    out.push(
      "On the commit path, not tied to this action; whether a given commit runs them depends on conditions the scan did not read:",
      ...onCommit.map((line) => `- ${line}`),
    )
  if (action.returns.length > 0)
    out.push(`Comes back from streams: ${list(action.returns.map((s) => `\`${s}\``))}`)
  if (action.untraced) out.push(`Not traced: ${action.untraced}`)
  out.push("", uncertain)
  return out.join("\n")
}

// ---------------------------------------------------------------------------------------
// A table.

export const renderTable = (atlas: Atlas, table: Table): string => {
  const out = [
    `# Table \`${table.name}\``,
    "",
    `Defined ${at(table.anchor)}${table.area ? ` in \`${table.area}\`` : ""}.`,
    "",
    "Columns:",
    ...table.columns.map(
      (c) =>
        `- ${c.name} ${c.type}${c.constraints ? ` ${c.constraints}` : ""}${c.references ? ` → ${c.references}` : ""}`,
    ),
  ]
  const methods = atlas.runner.methods.filter((m) => m.touches.some((t) => t.table === table.name))
  if (methods.length > 0) {
    out.push("", "Store methods:")
    for (const m of methods)
      out.push(
        `- ${m.name} (${m.touches
          .filter((t) => t.table === table.name)
          .map((t) => t.verb)
          .join(
            ", ",
          )}) ${at(m.anchor)}${m.usedBy.length > 0 ? `; reached by ${list(m.usedBy, 5)}` : ""}`,
      )
  }
  const areas = (anchors: Anchor[]) => [
    ...new Set(anchors.map((a) => areaOfFile(atlas, a.file) ?? a.file)),
  ]
  const found = (anchors: Anchor[]) => {
    const names = areas(anchors).map((a) => `\`${a}\``)
    return names.length === 0 ? "none found" : list(names)
  }
  out.push("", `Read in: ${found(table.readers)}`)
  out.push(`Written in: ${found(table.writers)}`)
  out.push(
    "Found by matching SQL text in single lines and statements (`RETURNING` counts as a read); SQL built another way is invisible. " +
      'Before you act on an absence ("nothing writes this table"), check the source.',
  )
  return out.join("\n")
}

// ---------------------------------------------------------------------------------------
// MCP tools and flows.

export const renderTool = (atlas: Atlas, name: string): string => {
  const tool = atlas.agents.tools.find((t) => t.name === name)!
  return [
    `# MCP tool \`${tool.name}\``,
    "",
    clip(tool.description, 600),
    "",
    `Input: ${shape(tool.input)}`,
    `Defined ${at(tool.anchor)}; handled ${at(tool.handler)}.`,
  ].join("\n")
}

export const renderFlow = (atlas: Atlas, id: string): string => {
  const flow = atlas.flows.find((f) => f.id === id)!
  return [
    `# Flow \`${flow.id}\`: ${flow.title}`,
    "",
    flow.summary,
    "",
    "Hand-written path: each anchor is checked to exist, the steps themselves are not traced by Atlas.",
    "",
    ...flow.steps.map(
      (s, i) =>
        `${i + 1}. ${nodeTitle(atlas, s.from)} → ${nodeTitle(atlas, s.to)}: ${s.label} (${at(s.anchor)})`,
    ),
  ].join("\n")
}

// ---------------------------------------------------------------------------------------
// Overviews.

export const renderApi = (atlas: Atlas): string => {
  const traced = new Map(atlas.runner.procedures.map((p) => [p.id, p.traced]))
  const namespaces = new Map<string, Procedure[]>()
  for (const p of atlas.api.procedures)
    namespaces.set(p.namespace, [...(namespaces.get(p.namespace) ?? []), p])
  const out = [
    `# API: ${atlas.api.procedures.length} oRPC procedures the runner serves`,
    "",
    '`*` stream, `°` no store call found by the static trace (unknown, not "no database").',
    "",
  ]
  for (const [ns, procs] of namespaces)
    out.push(
      `- ${ns}: ${procs.map((p) => `${p.name}${p.kind === "stream" ? "*" : ""}${traced.get(p.id) === false ? "°" : ""}`).join(", ")}`,
    )
  out.push("", "Brief one with `procedure:<namespace.name>`.")
  return out.join("\n")
}

export const renderData = (atlas: Atlas): string => {
  const out = [`# Data: ${atlas.data.tables.length} SQLite tables (runner)`, ""]
  for (const t of atlas.data.tables) {
    const statements = atlas.runner.methods
      .flatMap((m) => m.statements)
      .filter((s) => s.touches.some((x) => x.table === t.name))
    const verbs = (verb: string) =>
      statements.filter((s) => s.touches.some((x) => x.table === t.name && x.verb === verb)).length
    out.push(
      `- ${t.name}: ${t.columns.length} columns; statements read ${verbs("read")}, write ${verbs("write")}, delete ${verbs("delete")}`,
    )
  }
  out.push(
    "",
    `Settings keys: ${atlas.data.settings.length}; browser storage keys: ${atlas.data.local.length}.`,
    "Brief one with `table:<name>`.",
  )
  return out.join("\n")
}

export const renderState = (atlas: Atlas): string => {
  const { totals } = atlas.ui
  const out = [
    "# UI state and calls",
    "",
    `${totals.actions} workspace actions: ${totals.dispatchedFromUi} dispatched by the UI, ${totals.dispatchedFromAdapter} by the runner adapter.`,
    `${totals.reachingBackend} reach the runner (${totals.byAction} tested by type, ${totals.byDiff} inferred from a state diff); the rest have no runner call found by the scan.`,
    `${totals.procedures} procedures called, ${totals.streams} streams, ${totals.streamsToStore} of them traced into a store.`,
    "",
    "Wiring:",
  ]
  for (const box of atlas.ui.boxes)
    out.push(
      `- ${box.title}: ${box.count} ${box.unit} (e.g. ${list(
        box.items.slice(0, 4).map((i) => i.label),
        4,
      )})`,
    )
  out.push(
    "",
    "Streams back: " +
      atlas.ui.streams
        .map(
          (s) =>
            `${s.procedure} → ${s.dispatches.length > 0 ? s.dispatches.join(", ") : (s.feeds ?? "not traced")}`,
        )
        .join("; "),
    "",
    "Brief an action with `action:<type>` (types: " +
      list(
        atlas.ui.actions.map((a) => a.type),
        40,
      ) +
      ").",
    uncertain,
  )
  return out.join("\n")
}

export const renderFlows = (atlas: Atlas): string =>
  [
    "# Flows: hand-written end-to-end paths",
    "",
    "Written by hand in tools/atlas/content/flows.ts; each step's anchor is checked to still exist in the code, but the steps are not traced by Atlas.",
    "",
    ...atlas.flows.map((f) => `- \`${f.id}\` ${f.title}: ${clip(f.summary, 120)}`),
    "",
    "Brief one with `flow:<id>`.",
  ].join("\n")

export const renderAgents = (atlas: Atlas): string =>
  [
    "# Agents: what Novadeck offers the agent harnesses",
    "",
    `MCP tools: ${atlas.agents.tools.map((t) => `\`${t.name}\``).join(", ")}`,
    `Harness contract: ${atlas.agents.contract.length} members (${atlas.agents.contract.filter((m) => !m.optional).length} required).`,
    ...atlas.agents.harnesses.map(
      (h) =>
        `- ${h.title} (${h.package}): implements ${h.implements.length} members, ${at(h.anchor)}`,
    ),
    `Hooks: ${atlas.agents.hooks.length} across harnesses.`,
    "",
    "Brief a tool with `tool:<name>`.",
  ].join("\n")
