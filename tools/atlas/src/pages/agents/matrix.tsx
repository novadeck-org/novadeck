import { atlas } from "../../atlas-data.ts"
import { AnchorIcon } from "../../components/anchor.tsx"
import { harnessColor } from "./lifecycle.tsx"

export const HarnessMatrix = () => {
  const { contract, harnesses } = atlas.agents
  const required = contract.filter((m) => !m.optional)
  return (
    <div className="inline-block">
      <div className="flex items-end border-b border-line pb-1.5">
        <div className="w-56" />
        {harnesses.map((h) => {
          const have = required.filter((m) => h.implements.includes(m.name)).length
          return (
            <div key={h.id} className="w-24 text-center" title={h.package}>
              <div className="text-[12px] font-medium">{h.title.replace(" Code", "")}</div>
              <div
                className="mx-auto mt-1 h-1 w-14 bg-[var(--color-soft)]"
                title={`${have} of ${required.length} required`}
              >
                <div
                  className="h-full"
                  style={{
                    width: `${required.length > 0 ? (have / required.length) * 100 : 0}%`,
                    background: harnessColor(h.id),
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
      {contract.map((m) => {
        const has = harnesses.map((h) => h.implements.includes(m.name))
        const mixed = has.some(Boolean) && has.some((x) => !x)
        const gap = !m.optional && mixed
        return (
          <div
            key={m.name}
            title={m.summary}
            className={`flex h-[22px] items-center border-b border-line ${gap ? "bg-[var(--color-warning)]" : mixed ? "bg-[var(--color-soft)]" : ""}`}
          >
            <div
              className={`flex w-56 items-center gap-1.5 pl-1 font-mono text-[11px] ${m.optional ? "text-muted" : ""}`}
            >
              <span className="truncate">{m.name}</span>
              <AnchorIcon anchor={m.anchor} size={10} />
            </div>
            {harnesses.map((h, i) => (
              <div key={h.id} className="flex w-24 justify-center">
                <span
                  className={`size-3 rounded-full border-[1.5px] ${has[i] ? "" : mixed ? "border-[var(--color-warning-fg)]" : "border-line"}`}
                  style={
                    has[i]
                      ? {
                          background: harnessColor(h.id),
                          borderColor: harnessColor(h.id),
                          opacity: m.optional ? 0.5 : 1,
                        }
                      : undefined
                  }
                />
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
