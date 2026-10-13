import type { Area, Atlas, McpTool, Procedure, RuntimeNode, Table } from "./atlas.ts"
import raw from "./generated/atlas.json"

export const atlas = raw as unknown as Atlas

const index = <T>(items: T[], key: (item: T) => string) =>
  new Map(items.map((item) => [key(item), item]))

export const nodeById: Map<string, RuntimeNode> = index(atlas.runtime.nodes, (n) => n.id)
export const areaById: Map<string, Area> = index(atlas.areas, (a) => a.id)
export const procedureById: Map<string, Procedure> = index(atlas.api.procedures, (p) => p.id)
export const tableByName: Map<string, Table> = index(atlas.data.tables, (t) => t.name)
export const toolByName: Map<string, McpTool> = index(atlas.agents.tools, (t) => t.name)

export const nodeTitle = (id: string) => nodeById.get(id)?.title ?? id

export const groupBy = <T>(items: T[], key: (item: T) => string): [string, T[]][] => {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    groups.set(k, [...(groups.get(k) ?? []), item])
  }
  return [...groups]
}
