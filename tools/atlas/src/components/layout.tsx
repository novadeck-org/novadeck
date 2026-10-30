import {
  Bot,
  Cable,
  Database,
  Layers,
  AppWindow,
  Map as MapIcon,
  Server,
  Search as SearchIcon,
  TriangleAlert,
  Workflow,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { Link, NavLink, Outlet, useLocation } from "react-router"

import { atlas } from "../atlas-data.ts"
import { ErrorBoundary } from "./error-boundary.tsx"
import { Search } from "./search.tsx"

export const nav = [
  { to: "/", label: "Map", icon: MapIcon },
  { to: "/areas", label: "Areas", icon: Layers },
  { to: "/ui", label: "UI", icon: AppWindow },
  { to: "/runner", label: "Runner", icon: Server },
  { to: "/api", label: "API", icon: Cable },
  { to: "/data", label: "Data", icon: Database },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/flows", label: "Flows", icon: Workflow },
]

// The Nova mark: four chevrons firing outward from a block cursor.
const NovaMark = () => (
  <svg aria-hidden="true" viewBox="3 3 58 58" width={28} height={28} className="nova-mark">
    <g fill="none" strokeWidth="7">
      <polyline className="nova-chevron" points="46,22 56,32 46,42" />
      <polyline className="nova-chevron" points="18,22 8,32 18,42" />
      <polyline className="nova-chevron" points="22,18 32,8 42,18" />
      <polyline className="nova-chevron" points="22,46 32,56 42,46" />
    </g>
    <rect className="nova-cursor" x="28" y="23" width="8" height="18" />
  </svg>
)

// The header, as the app's: the mark and the atlas's name, the page switch where the
// app switches views, and search.
const Header = ({ onSearch }: { onSearch: () => void }) => (
  <header className="app-header grid h-16 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-6 px-4">
    <Link to="/" className="flex min-w-0 items-center gap-4 text-fg no-underline hover:text-fg">
      <NovaMark />
      <span className="truncate text-body font-medium">Atlas</span>
    </Link>
    <nav aria-label="Pages" className="segmented">
      {nav.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          className="segment h-8 min-w-22 px-3 text-control max-[1001px]:min-w-0"
        >
          <Icon size={14} strokeWidth={1.6} aria-hidden="true" />
          <span className="max-[860px]:hidden">{label}</span>
        </NavLink>
      ))}
    </nav>
    <div className="flex items-center justify-self-end gap-2">
      <button
        type="button"
        onClick={onSearch}
        className="icon-button w-auto gap-2 px-2.5 text-control"
        aria-label="Search the atlas"
      >
        <SearchIcon size={15} />
        Search
        <kbd className="hint mb-[-2px] ml-3">Ctrl K</kbd>
      </button>
    </div>
  </header>
)

// The status bar: what the atlas holds, and the commit it was drawn from. Broken anchors
// tone the whole bar, as the app's does while its backend is in trouble.
const Footer = () => {
  const broken = atlas.broken.length
  const counts = [
    `${atlas.areas.length} areas`,
    `${atlas.api.procedures.length} procedures`,
    `${atlas.data.tables.length} tables`,
    `${atlas.agents.tools.length} agent tools`,
    `${atlas.flows.length} flows`,
  ]
  return (
    <footer
      data-tone={broken > 0 ? "warning" : undefined}
      className="app-footer flex h-7 shrink-0 items-center justify-between px-4 text-caption"
    >
      <span className="flex items-center">
        {counts.map((count, i) => (
          <span key={count} className={i === 0 ? "pr-3" : "footer-divider px-3"}>
            {count}
          </span>
        ))}
      </span>
      <span className="flex items-center gap-4">
        {broken > 0 ? (
          <span
            className="footer-status flex items-center gap-1.5 font-bold"
            title={atlas.broken.map((b) => `${b.where}: ${b.file} / ${b.text}`).join("\n")}
          >
            <TriangleAlert size={12} />
            {broken} broken anchor{broken === 1 ? "" : "s"}
          </span>
        ) : null}
        <a
          href={`${atlas.repository}/commit/${atlas.commit}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[inherit] no-underline hover:text-[inherit] hover:underline"
        >
          {atlas.commit.slice(0, 7)}
        </a>
        <span className="footer-divider pl-4 font-mono" title={atlas.generatedAt}>
          {atlas.generatedAt.replace("T", " ").slice(0, 16)}
        </span>
      </span>
    </footer>
  )
}

export const Layout = () => {
  const [searching, setSearching] = useState(false)
  const { key } = useLocation()
  const closeSearch = useCallback(() => setSearching(false), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setSearching((s) => !s)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <Header onSearch={() => setSearching(true)} />
      <main className="flex min-h-0 flex-1">
        <ErrorBoundary resetKey={key}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <Footer />
      <Search open={searching} onClose={closeSearch} />
    </div>
  )
}

export const NotFound = () => (
  <div className="workspace flex min-w-0 flex-1 items-start justify-center p-6">
    <div className="pane floating max-w-lg p-4">
      <h1 className="m-0 text-body font-medium">No such page</h1>
      <p className="mt-2 text-muted">Atlas has these pages:</p>
      <div className="flex flex-wrap gap-2">
        {nav.map(({ to, label }) => (
          <Link key={to} to={to} className="pane px-2 py-0.5 no-underline">
            {label}
          </Link>
        ))}
      </div>
    </div>
  </div>
)
