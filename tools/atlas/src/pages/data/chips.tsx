import { useState } from "react"

import { atlas, groupBy } from "../../atlas-data.ts"
import { AnchorIcon } from "../../components/anchor.tsx"
import { useFocus } from "../../components/use-focus.ts"
import { settingId } from "../../links.ts"

const Chip = ({
  id,
  label,
  title,
  anchor,
}: {
  id: string
  label: string
  title: string
  anchor: Parameters<typeof AnchorIcon>[0]["anchor"]
}) => {
  const { ref, focused } = useFocus<HTMLSpanElement>(id)
  return (
    <span
      ref={ref}
      id={id}
      data-focused={focused}
      title={title}
      className="inline-flex items-center gap-1 rounded-sm border border-line bg-panel px-1.5 font-mono text-[11px] leading-5"
    >
      {label}
      <AnchorIcon anchor={anchor} size={10} />
    </span>
  )
}

export const StorageStrip = ({
  initial,
  navKey,
}: {
  initial: "settings" | "local" | null
  navKey: string
}) => {
  const [tab, setTab] = useState<"settings" | "local" | null>(initial)
  // A navigation that names a setting or a browser key opens the tab holding it.
  const [seen, setSeen] = useState(navKey)
  if (seen !== navKey) {
    setSeen(navKey)
    if (initial) setTab(initial)
  }
  const { settings, local } = atlas.data
  const tabs = [
    ["settings", "Settings", settings.length],
    ["local", "Browser storage", local.length],
  ] as const
  return (
    <div className="pane floating overflow-hidden">
      <div className="flex items-center gap-1 px-3">
        {tabs.map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(tab === id ? null : id)}
            className={`cursor-pointer border-b-2 px-2 py-1.5 text-[12px] ${tab === id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`}
          >
            {label} <span className="font-mono text-[10px]">{n}</span>
          </button>
        ))}
      </div>
      {tab === "settings" ? (
        <div className="max-h-44 space-y-1.5 overflow-auto px-3 pb-3 pt-1">
          {groupBy(settings, (s) => s.group).map(([group, items]) => (
            <div key={group} className="flex flex-wrap items-center gap-1">
              <span className="w-16 shrink-0 font-mono text-[10px] uppercase text-muted">
                {group}
              </span>
              {items.map((s) => (
                <Chip
                  key={s.key}
                  id={settingId(group, s.key)}
                  label={s.key}
                  title={`${s.key}: ${s.type}`}
                  anchor={s.anchor}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {tab === "local" ? (
        <div className="flex max-h-44 flex-wrap gap-1 overflow-auto px-3 pb-3 pt-1">
          {local.map((k) => (
            <Chip
              key={k.key}
              id={`local:${k.key}`}
              label={k.key}
              title={k.summary ?? k.key}
              anchor={k.anchor}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
