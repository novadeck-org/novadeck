import { clsx } from "clsx"
import { Layers3 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Link } from "react-router"

import { atlas } from "../atlas-data.ts"
import type { Dependency, PackageStack } from "../atlas.ts"
import { areaPath } from "../links.ts"
import { AnchorLink } from "./anchor.tsx"
import { Token } from "./viz.tsx"

// A family of dependencies shown as one: members of a scope that share a role, named by
// what their names share (`@lezer/*`, `@xterm/addon-*`); or a single library.
type Family = {
  name: string
  version: string
  role: string | null
  category: string | null
  size: number
}

const common = (a: string, b: string) => {
  let i = 0
  while (i < a.length && a[i] === b[i]) i += 1
  return a.slice(0, i)
}

const families = (deps: Dependency[]): Family[] => {
  const groups = new Map<string, { members: Dependency[] }>()
  for (const dep of deps) {
    const scope = dep.name.startsWith("@") && dep.role ? dep.name.split("/")[0] : null
    const key = scope ? `${scope}|${dep.role}` : dep.name
    groups.set(key, { members: [...(groups.get(key)?.members ?? []), dep] })
  }
  return [...groups.values()].map(({ members }) => {
    const first = members[0]!
    // Cut back to a whole segment: `@orpc/client` and `@orpc/contract` share `@orpc/`.
    const prefix = members
      .map((m) => m.name)
      .reduce(common)
      .replace(/[^/-]*$/, "")
    const versions = new Set(members.map((m) => m.version))
    return {
      name: members.length > 1 ? `${prefix}*` : first.name,
      version: versions.size === 1 ? first.version : "",
      role: first.role,
      category: first.category,
      size: members.length,
    }
  })
}

// `^19.3.0` → `19.3`, `1.2.0-beta.14` → `1.2.0-beta.14`, `node 26.x` → `node 26`.
const short = (version: string) =>
  version
    .replace(/^[\^~]/, "")
    .replace(/\.x$/, "")
    .replace(/^(\d+\.\d+)\.\d+$/, "$1")

const stackByToken = new Map(atlas.stacks.map((stack) => [stack.token, stack]))
const tokenByName = new Map(atlas.stacks.map((stack) => [stack.name, stack.token]))

// What the package stands on: its lead libraries first, wherever the manifest lists them,
// then the rest of what it ships with.
const headline = (stack: PackageStack) =>
  families([
    ...stack.deps.filter((d) => d.lead),
    ...stack.deps.filter((d) => !d.lead && d.kind === "runtime"),
  ])

const Chip = ({ family }: { family: Family }) => (
  <span
    title={family.role ?? undefined}
    className="badge inline-flex shrink-0 items-baseline gap-1 px-1.5 text-[11px] leading-5"
  >
    {family.name}
    {family.size > 1 ? <span className="text-muted">×{family.size}</span> : null}
    {family.version ? <span className="text-muted">{short(family.version)}</span> : null}
  </span>
)

const Shelf = ({ title, deps }: { title: string; deps: Dependency[] }) => (
  <div>
    <div className="section-label mb-1">{title}</div>
    <ul className="m-0 list-none p-0">
      {families(deps).map((f) => (
        <li
          key={f.name}
          className="grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)] items-baseline gap-3 py-0.5"
        >
          <span className="truncate font-mono text-control">
            {f.name}
            {f.size > 1 ? <span className="text-muted"> ×{f.size}</span> : null}
            {f.version ? <span className="text-muted"> {short(f.version)}</span> : null}
          </span>
          <span className="truncate text-caption text-muted">{f.role ?? ""}</span>
        </li>
      ))}
    </ul>
  </div>
)

const Detail = ({ stack }: { stack: PackageStack }) => {
  const runtime = stack.deps.filter((d) => d.kind === "runtime")
  const dev = stack.deps.filter((d) => d.kind === "dev")
  const workspace = stack.deps.filter((d) => d.kind === "workspace")
  const shelves = [...new Set(runtime.map((d) => d.category ?? "Other"))]
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-body font-medium">{stack.name}</span>
        <span className="ml-auto text-caption">
          <AnchorLink anchor={stack.manifest} />
        </span>
      </div>
      {shelves.map((shelf) => (
        <Shelf
          key={shelf}
          title={shelf}
          deps={runtime.filter((d) => (d.category ?? "Other") === shelf)}
        />
      ))}
      {workspace.length > 0 ? (
        <div>
          <div className="section-label mb-1">Uses packages</div>
          <div className="flex flex-wrap gap-1">
            {workspace.map((d) => {
              const token = tokenByName.get(d.name)
              return token ? (
                <Link
                  key={d.name}
                  to={areaPath(token)}
                  className="rounded-sm border border-[var(--window-border-color)] px-1.5 text-[11px] leading-5 no-underline"
                >
                  <Token id={token} />
                </Link>
              ) : (
                <span key={d.name} className="font-mono text-[11px]">
                  {d.name}
                </span>
              )
            })}
          </div>
        </div>
      ) : null}
      {dev.length > 0 ? <Shelf title="Builds and tests with" deps={dev} /> : null}
    </div>
  )
}

// A package's stack as a floating strip: the libraries it stands on, and everything its
// manifest lists, by shelf, a click away.
export const StackStrip = ({
  token,
  max = 6,
  fit = false,
}: {
  token: string
  max?: number
  // Fills its container instead of sizing to its chips, as in a narrow panel.
  fit?: boolean
}) => {
  const stack = stackByToken.get(token)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener("mousedown", close)
    return () => window.removeEventListener("mousedown", close)
  }, [open])
  if (!stack) return null
  const shown = headline(stack)
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title="What it is built with"
        className={clsx(
          "pane floating flex h-9 cursor-pointer items-center gap-1.5 overflow-hidden px-2",
          fit ? "w-full" : "max-w-[min(56rem,60vw)]",
          open && "selected",
        )}
      >
        <Layers3 size={13} className="shrink-0 text-muted" />
        {shown.slice(0, max).map((family) => (
          <Chip key={family.name} family={family} />
        ))}
        {stack.deps.length > 0 ? (
          <span className="shrink-0 px-1 text-caption text-muted">
            {shown.length > max ? `+${shown.length - max}` : "all"}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="pane floating absolute top-full right-0 z-30 mt-2 max-h-[70vh] w-[34rem] max-w-[90vw] overflow-auto p-3">
          <Detail stack={stack} />
        </div>
      ) : null}
    </div>
  )
}

// The package whose code a runtime node mostly runs: the first one placed in it.
export const stackOfNode = (node: string) =>
  atlas.stacks.find((stack) => atlas.areas.find((a) => a.id === stack.token)?.node === node)
    ?.token ?? null
