import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { flows } from "../content/flows.ts"
import { runtime } from "../content/runtime.ts"
import type { Area, Atlas, Flow, Runtime } from "../src/atlas.ts"
import { extractAgents } from "./agents.ts"
import { createAnchors, type Anchors } from "./anchors.ts"
import { extractApi } from "./api.ts"
import { areaOf, extractAreas } from "./areas.ts"
import { extractData } from "./data.ts"
import { extractLinks } from "./links.ts"
import { ensureProtocol } from "./protocol.ts"
import { extractRunnerLens } from "./runner-lens.ts"
import { extractStacks } from "./stack.ts"
import { extractUiLens } from "./ui-lens.ts"

const repo = resolve(import.meta.dirname, "../..")
const output = resolve(import.meta.dirname, "../src/generated/atlas.json")

const resolveRuntime = (anchors: Anchors, areas: Area[]): Runtime => ({
  nodes: runtime.nodes.map((node) => ({
    ...node,
    areas: areas.filter((area) => area.node === node.id).map((area) => area.id),
    anchor: anchors.resolve(node.anchor, `runtime node ${node.id}`),
  })),
  edges: runtime.edges.map((edge) => ({
    ...edge,
    anchor: anchors.resolve(edge.anchor, `runtime edge ${edge.id}`),
  })),
})

const resolveFlows = (anchors: Anchors): Flow[] =>
  flows.map((flow) => ({
    ...flow,
    steps: flow.steps.map((step, index) => ({
      ...step,
      label: step.label ?? step.text,
      anchor: anchors.resolve(step.anchor, `flow ${flow.id} step ${index + 1}`),
    })),
  }))

export const build = async (): Promise<Atlas> => {
  ensureProtocol(repo)
  const anchors = createAnchors(repo)
  const api = await extractApi(repo, anchors)
  const data = await extractData(repo, anchors)
  const agents = extractAgents(repo, anchors)
  const { areas, problems } = extractAreas(repo, anchors, { api, data, agents })
  const owner = (file: string | undefined): string | null =>
    file === undefined ? null : areaOf(areas, file)
  const lens = {
    repo,
    anchors,
    api,
    data,
    agents,
    areas,
    areaOf: (file: string) => areaOf(areas, file),
  }

  const runner = extractRunnerLens(lens)
  const ui = extractUiLens(lens)

  // The adapter calls some procedures through an alias (`runner.install(`) that a search for
  // `.voice.install(` cannot see; the UI lens resolved those. One caller per file.
  const procedures = api.procedures.map((procedure) => {
    const sites = ui.procedures.find((each) => each.id === procedure.id)?.sites ?? []
    const callers = [...procedure.callers]
    for (const site of sites) if (!callers.some((c) => c.file === site.file)) callers.push(site)
    return { ...procedure, callers, area: owner(procedure.handler?.file) }
  })
  const callerApi = { ...api, procedures }

  return {
    generatedAt: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    repository: "https://github.com/novadeck-org/novadeck",
    root: repo,
    runtime: resolveRuntime(anchors, areas),
    areas,
    links: extractLinks(repo, anchors, areas, { api: callerApi, data }),
    api: callerApi,
    data: {
      ...data,
      tables: data.tables.map((table) => ({ ...table, area: owner(table.anchor.file) })),
    },
    agents,
    flows: resolveFlows(anchors),
    runner,
    ui,
    stacks: extractStacks(repo, anchors, areas),
    broken: [...anchors.broken(), ...problems],
  }
}

if (import.meta.main) {
  const atlas = await build()
  mkdirSync(join(output, ".."), { recursive: true })
  writeFileSync(output, `${JSON.stringify(atlas, null, 2)}\n`)
  console.log(
    `atlas: ${atlas.areas.length} areas, ${atlas.api.procedures.length} procedures, ` +
      `${atlas.data.tables.length} tables, ${atlas.agents.tools.length} agent tools, ` +
      `${atlas.flows.length} flows`,
  )
  for (const broken of atlas.broken) {
    console.warn(
      broken.reason
        ? `broken: ${broken.where}: ${broken.file}: ${broken.reason}`
        : broken.text
          ? `broken anchor: ${broken.where}: "${broken.text}" not in ${broken.file}`
          : `broken: ${broken.where}: ${broken.file}`,
    )
  }
  if (process.argv.includes("--strict") && atlas.broken.length > 0) process.exitCode = 1
}
