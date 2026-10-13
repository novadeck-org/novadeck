import { atlas } from "../../atlas-data.ts"
import type { Hook } from "../../atlas.ts"
import { blobUrl } from "../../components/anchor.tsx"

const STAGES = [
  { id: "start", label: "start", events: ["SessionStart"] },
  { id: "prompt", label: "prompt", events: ["UserPromptSubmit", "PreInvocation"] },
  { id: "pre", label: "pre tool", events: ["PreToolUse"] },
  { id: "post", label: "post tool", events: ["PostToolUse", "PostToolUseFailure"] },
  { id: "sub", label: "subagent", events: ["SubagentStart", "SubagentStop"] },
  {
    id: "ask",
    label: "permission",
    events: ["PermissionRequest", "Elicitation", "ElicitationResult", "Notification"],
  },
  { id: "stop", label: "stop", events: ["Stop", "StopFailure", "Interrupt"] },
  { id: "end", label: "end", events: ["SessionEnd"] },
  { id: "status", label: "status", events: ["StatusLine"] },
  { id: "other", label: "other", events: [] as string[] },
]

const stageOf = (event: string) =>
  (STAGES.find((s) => s.events.includes(event)) ?? STAGES[STAGES.length - 1]!).id

export const harnessColor = (id: string) => `var(--h-${id})`

export const Lifecycle = () => {
  const { hooks, harnesses } = atlas.agents
  const used = STAGES.filter(
    (s) => s.id !== "other" || hooks.some((h) => stageOf(h.event) === "other"),
  )
  const W = 54
  const LABEL = 76
  const LANE = 40
  const width = LABEL + used.length * W
  const height = 34 + harnesses.length * LANE
  const lanes = harnesses.map((h) => ({ h, hooks: hooks.filter((k) => k.harness === h.id) }))
  return (
    <svg
      width={width}
      height={height}
      className="block max-w-full font-sans text-[10px]"
      role="img"
      aria-label="Hook lifecycle"
    >
      {used.map((s, i) => (
        <g key={s.id}>
          {i % 2 === 0 ? (
            <rect
              x={LABEL + i * W}
              y={0}
              width={W}
              height={height}
              fill="var(--color-soft)"
              opacity={0.6}
            />
          ) : null}
          <text x={LABEL + i * W + W / 2} y={20} textAnchor="middle" fill="var(--muted)">
            {s.label}
          </text>
        </g>
      ))}
      <line
        x1={LABEL}
        x2={width}
        y1={30}
        y2={30}
        stroke="var(--color-line-strong)"
        markerEnd="url(#lc-arrow)"
      />
      <defs>
        <marker
          id="lc-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0 0L10 5L0 10z" fill="var(--color-line-strong)" />
        </marker>
      </defs>
      {lanes.map(({ h, hooks: items }, li) => {
        const y = 34 + li * LANE + LANE / 2
        return (
          <g key={h.id}>
            <circle cx={10} cy={y} r={4} fill={harnessColor(h.id)} />
            <text x={20} y={y + 3.5} fill="var(--fg)" fontSize={11}>
              {h.title.replace(" Code", "")}
            </text>
            <line x1={LABEL} x2={width} y1={y} y2={y} stroke="var(--line)" />
            {used.map((s, si) => {
              const here = items.filter((k: Hook) => stageOf(k.event) === s.id)
              return here.map((k, ki) => (
                <a
                  key={k.event}
                  href={blobUrl(k.anchor.file, k.anchor.line)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <title>{`${k.event}: ${k.summary}`}</title>
                  <circle
                    cx={LABEL + si * W + W / 2 + (ki - (here.length - 1) / 2) * 16}
                    cy={y}
                    r={6}
                    fill={harnessColor(h.id)}
                    stroke="var(--panel)"
                    strokeWidth={1.5}
                    className="hover:stroke-[var(--accent)]"
                  />
                </a>
              ))
            })}
          </g>
        )
      })}
    </svg>
  )
}
