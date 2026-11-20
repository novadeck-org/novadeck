import type { AgentMode } from "@novadeck/core/port"
import { useState, type CSSProperties } from "react"

// The map is drawn at 272 × 150 px, in the sidebar's own marks (agent-mode-map.css): you in
// the middle, three agents around you, the port two of them want, and Swarm's team off @owl's
// side. Every part names the modes it shows in (data-in); data-draw marks a wire that draws in
// when its mode is picked, after its own delay.
const ring = { left: 84, right: 268, top: 20, bottom: 132 }
const you = { x: 176, y: 76 }
const agents = { owl: { x: 118, y: 20 }, fern: { x: 234, y: 20 }, moss: { x: 176, y: 132 } }
const port = { x: 174, y: 20 }
const team = { x: 10, wren: 82, lark: 108 }

// Each wire, as an SVG path, the modes it shows in, its tone and its draw-in delay (ms).
type Wire = {
  readonly d: string
  readonly in: string
  readonly tone?: "lit" | "ask"
  readonly draw?: number
}

const spokes = {
  owl: `M${agents.owl.x} ${agents.owl.y + 9} V${you.y} H${you.x - 22}`,
  fern: `M${agents.fern.x} ${agents.fern.y + 9} V${you.y} H${you.x + 22}`,
  moss: `M${agents.moss.x} ${agents.moss.y - 9} V${you.y + 10}`,
}
const edges = {
  top: `M${agents.owl.x + 30} ${ring.top} H${agents.fern.x - 32}`,
  right: `M${agents.fern.x + 32} ${ring.top} H${ring.right} V${ring.bottom} H${agents.moss.x + 28}`,
  left: `M${agents.owl.x - 28} ${ring.top} H${ring.left} V${ring.bottom} H${agents.moss.x - 28}`,
}

// The wires that move with the ring: spokes into you, and the ring between the agents.
const ringWires: readonly Wire[] = [
  { d: spokes.owl, in: "herd swarm" },
  { d: spokes.fern, in: "herd swarm" },
  { d: spokes.moss, in: "solo herd swarm" },
  // In Solo the two that want the port ask you.
  { d: spokes.owl, in: "solo", tone: "ask", draw: 0 },
  { d: spokes.fern, in: "solo", tone: "ask", draw: 120 },
  // The ring rests in Herd, but for the one conversation over the port; Swarm lights it all.
  { d: edges.top, in: "herd swarm", draw: 0 },
  { d: edges.right, in: "herd swarm", draw: 120 },
  { d: edges.left, in: "herd swarm", draw: 240 },
  { d: edges.top, in: "herd swarm", tone: "lit", draw: 380 },
  { d: edges.right, in: "swarm", tone: "lit", draw: 480 },
  { d: edges.left, in: "swarm", tone: "lit", draw: 560 },
]

// Swarm's team, wired as the sidebar wires a team: out of its lead, a tick into each worker.
const teamWires: readonly Wire[] = [
  {
    d: `M${agents.owl.x - 28} ${ring.top} H${team.x} V${team.lark}`,
    in: "swarm",
    tone: "lit",
    draw: 300,
  },
  { d: `M${team.x} ${team.wren} H${team.x + 8}`, in: "swarm", tone: "lit", draw: 620 },
  { d: `M${team.x} ${team.lark} H${team.x + 8}`, in: "swarm", tone: "lit", draw: 700 },
]

// A wire is told apart by where it runs, when it shows and its tone.
const keyOf = (wire: Wire): string => `${wire.d}|${wire.in}|${wire.tone ?? "rest"}`

const delay = (ms: number | undefined): CSSProperties | undefined =>
  ms === undefined ? undefined : ({ "--agent-mode-map-delay": `${ms}ms` } as CSSProperties)

const WirePath = ({ wire }: { readonly wire: Wire }): React.JSX.Element => (
  <path
    className="agent-mode-map-wire"
    d={wire.d}
    data-in={wire.in}
    data-tone={wire.tone}
    data-draw={wire.draw === undefined ? undefined : ""}
    // Drawn in by its dash: one dash of the whole path, offset from 1 to 0.
    pathLength={wire.draw === undefined ? undefined : 1}
    style={delay(wire.draw)}
  />
)

// An agent as the Terminals list names it: its glyph and handle, and a `?` while it asks you.
const Agent = ({
  name,
  at,
  waitsIn,
  asksIn,
  showsIn,
  pop,
}: {
  readonly name: string
  readonly at: { readonly x: number; readonly y: number }
  readonly waitsIn?: AgentMode
  readonly asksIn?: AgentMode
  readonly showsIn?: string
  readonly pop?: number
}): React.JSX.Element => (
  <span
    className="agent-mode-map-agent"
    style={{ left: at.x, top: at.y, ...delay(pop) }}
    data-in={showsIn}
    data-pop={pop === undefined ? undefined : ""}
  >
    {/* A working agent's glyph held on its first frame; ⣀ while it waits on you. */}
    <span className="agent-mode-map-glyph" data-waits-in={waitsIn} />
    {name}
    {asksIn && (
      <span className="agent-mode-map-need" data-in={asksIn} data-pop="" style={delay(420)}>
        ?
      </span>
    )}
  </span>
)

// A small map of what a mode does to agents, under Preferences' choice of it. It plays once
// when the person picks a mode, never as Preferences opens.
export const AgentModeMap = ({
  mode,
  label,
}: {
  readonly mode: AgentMode
  readonly label: string
}): React.JSX.Element => {
  const [shown, setShown] = useState(mode)
  const [played, setPlayed] = useState(false)
  if (mode !== shown) {
    setShown(mode)
    setPlayed(true)
  }
  return (
    <div
      className="agent-mode-map"
      role="img"
      aria-label={label}
      data-mode={mode}
      data-play={played ? "" : undefined}
    >
      <svg viewBox="0 0 272 150" aria-hidden="true">
        <g className="agent-mode-map-ring">
          {ringWires.map((wire) => (
            <WirePath key={keyOf(wire)} wire={wire} />
          ))}
          <rect
            className="agent-mode-map-pulse"
            data-in="herd"
            x={agents.owl.x + 30}
            y={ring.top - 4}
            width={5}
            height={8}
          />
        </g>
        {teamWires.map((wire) => (
          <WirePath key={keyOf(wire)} wire={wire} />
        ))}
      </svg>
      <div className="agent-mode-map-ring" aria-hidden="true">
        <span className="agent-mode-map-port" style={{ left: port.x, top: port.y }}>
          :5173
        </span>
        <Agent name="@owl" at={agents.owl} waitsIn="solo" asksIn="solo" />
        <Agent name="@fern" at={agents.fern} waitsIn="solo" asksIn="solo" />
        <Agent name="@moss" at={agents.moss} />
        <span className="agent-mode-map-you" style={{ left: you.x, top: you.y }}>
          you
          <span className="agent-mode-map-cursor" />
          <span className="agent-mode-map-count" data-in="solo">
            2
          </span>
        </span>
      </div>
      <div aria-hidden="true">
        <span
          className="agent-mode-map-lead"
          data-in="swarm"
          data-pop=""
          style={{ left: team.x, top: ring.top, ...delay(300) }}
        />
        <Agent name="@wren" at={{ x: team.x + 34, y: team.wren }} showsIn="swarm" pop={640} />
        <Agent name="@lark" at={{ x: team.x + 34, y: team.lark }} showsIn="swarm" pop={720} />
      </div>
    </div>
  )
}
