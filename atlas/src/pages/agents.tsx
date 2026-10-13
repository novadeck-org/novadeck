import { Eye, FileText, Monitor, Send, SquarePlus, SquareX, Users, Wrench, X } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useEffect, useState } from "react"

import { atlas, toolByName } from "../atlas-data.ts"
import type { McpTool } from "../atlas.ts"
import { AnchorIcon, AnchorLink } from "../components/anchor.tsx"
import { SchemaView } from "../components/schema.tsx"
import { Ground, Window } from "../components/ui.tsx"
import { useFocus } from "../components/use-focus.ts"
import { Lifecycle } from "./agents/lifecycle.tsx"
import { HarnessMatrix } from "./agents/matrix.tsx"
import { AreaChip, Label } from "./api/shared.tsx"

import "./visual-tokens.css"

const icons: Record<string, LucideIcon> = {
  show: Monitor,
  showing: Eye,
  close: X,
  open_terminal: SquarePlus,
  close_terminal: SquareX,
  send: Send,
  agents: Users,
  summarize: FileText,
}

const firstSentence = (text: string) => /^.*?[.!?](?=\s|$)/s.exec(text.trim())?.[0] ?? text.trim()

const Chip = ({
  tool,
  selected,
  onSelect,
}: {
  tool: McpTool
  selected: boolean
  onSelect: (n: string) => void
}) => {
  const { ref, visit } = useFocus<HTMLButtonElement>(`tool:${tool.name}`)
  // Every navigation to a tool selects it again, even when the hash did not change.
  useEffect(() => {
    if (visit) onSelect(tool.name)
  }, [visit, onSelect, tool.name])
  const Icon = icons[tool.name] ?? Wrench
  return (
    <button
      ref={ref}
      id={`tool:${tool.name}`}
      type="button"
      onClick={() => onSelect(tool.name)}
      title={firstSentence(tool.description)}
      data-selected={selected}
      className="item flex items-center gap-1.5 border-[var(--window-border-color)] px-2 py-1 font-mono text-[12px] data-[selected=true]:text-accent"
    >
      <Icon size={13} />
      {tool.name}
    </button>
  )
}

const ToolPanel = ({ tool }: { tool: McpTool }) => {
  const [more, setMore] = useState(false)
  const first = firstSentence(tool.description)
  const rest = tool.description.trim().slice(first.length).trim()
  const owner = atlas.areas.find((a) => a.tools.includes(tool.name))
  return (
    <div className="mt-3 space-y-3 border-t border-dashed border-line pt-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[13px] font-medium">{tool.name}</span>
        <AreaChip id={owner?.id ?? null} />
        <span className="flex items-center gap-1 text-[11px] text-muted">
          def <AnchorIcon anchor={tool.anchor} />
        </span>
        {tool.handler ? (
          <span className="flex items-center gap-1 text-[11px] text-muted">
            handler <AnchorIcon anchor={tool.handler} />
          </span>
        ) : null}
        {tool.handler ? (
          <span className="ml-auto text-[11px]">
            <AnchorLink anchor={tool.handler} />
          </span>
        ) : null}
      </div>
      <p className="text-[13px]">
        {first}{" "}
        {rest ? (
          <button
            type="button"
            onClick={() => setMore(!more)}
            className="cursor-pointer text-[11px] text-muted hover:text-fg"
          >
            {more ? "less" : "more"}
          </button>
        ) : null}
      </p>
      {more ? <p className="whitespace-pre-wrap text-[12px] text-muted">{rest}</p> : null}
      <div>
        <Label>Input</Label>
        <SchemaView schema={tool.input} />
      </div>
    </div>
  )
}

export const AgentsPage = () => {
  const [selected, setSelected] = useState<string | null>(null)
  const tool = selected ? toolByName.get(selected) : undefined
  return (
    <Ground title="Agents">
      <div className="space-y-3">
        <div className="grid items-start gap-3 xl:grid-cols-[auto_1fr]">
          <Window title="Harness parity">
            <HarnessMatrix />
          </Window>
          <Window title="Hook lifecycle">
            <Lifecycle />
          </Window>
        </div>
        <Window
          title="MCP tools"
          tools={
            <span className="font-mono text-caption text-muted">{atlas.agents.tools.length}</span>
          }
        >
          <div className="flex flex-wrap gap-2">
            {atlas.agents.tools.map((t) => (
              <Chip key={t.name} tool={t} selected={selected === t.name} onSelect={setSelected} />
            ))}
          </div>
          {tool ? <ToolPanel tool={tool} /> : null}
        </Window>
      </div>
    </Ground>
  )
}
