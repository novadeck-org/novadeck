import type {
  CompanionItem,
  FileContent,
  ItemContent,
  UnavailableReason,
} from "../../../model/companion"

// Something a sample agent shows: the item it points at, by an id that stays the same, and
// what it holds there, or why it can't show.
export type SampleArtifact = {
  readonly item: Pick<
    CompanionItem,
    "kind" | "name" | "detail" | "path" | "url" | "lines" | "held"
  > & {
    readonly id: string
    readonly plan?: CompanionItem["plan"]
  }
  readonly content: ItemContent
}

export type SampleArtifacts = {
  readonly shown: readonly SampleArtifact[]
  readonly opened?: readonly SampleArtifact[]
  readonly next: readonly SampleArtifact[]
}

export const ready = (
  content: Extract<ItemContent, { state: "ready" }>["content"],
): ItemContent => ({
  state: "ready",
  stamp: "1",
  content,
})

const studio = "~/projects/studio"

// A file's lines as the pane loads them: all of a short file, pointing at `from`–`to`.
export const fileLines = (
  path: string,
  lines: readonly string[],
  pointed: { readonly from: number; readonly to: number; readonly firstLine?: number },
): FileContent => ({
  kind: "file",
  path,
  firstLine: pointed.firstLine ?? 1,
  lines,
  from: pointed.from,
  to: pointed.to,
  total: (pointed.firstLine ?? 1) + lines.length - 1,
  truncated: false,
  clamped: false,
})

// What the sample Codex shows beside "Build Studio": drafts of the Studio site, drawn as
// SVG in its own palette, files from the project, a markdown document it wrote, and the
// site in the preview browser.

const ivory = "#f6f1e7"
const ink = "#2d2a24"
const olive = "#7d8454"
const clay = "#c4704f"
const sand = "#b9ae8e"
const serif = 'font-family="Georgia, serif"'

export const svg = (width: number, height: number, body: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 800 450">${body}</svg>`,
  )}`

const image = (id: string, name: string, detail: string, body: string): SampleArtifact => ({
  item: {
    id,
    kind: "image",
    name,
    detail,
    path: `${studio}/drafts/${name}`,
    url: null,
    lines: null,
    held: false,
  },
  content: ready({ kind: "image", src: svg(1600, 900, body) }),
})

const hero = image(
  "studio-hero",
  "hero.png",
  "1600 × 900 PNG",
  `<rect width="800" height="450" fill="${ivory}"/>
  <rect x="470" y="60" width="270" height="330" rx="6" fill="${olive}"/>
  <circle cx="605" cy="190" r="70" fill="${clay}"/>
  <rect x="470" y="300" width="270" height="90" fill="#6b7148"/>
  <text x="60" y="120" ${serif} font-size="22" fill="${olive}">Studio</text>
  <text x="60" y="200" ${serif} font-size="46" fill="${ink}">Careful work,</text>
  <text x="60" y="254" ${serif} font-size="46" fill="${ink}">made slowly.</text>
  <rect x="60" y="300" width="130" height="36" rx="18" fill="${ink}"/>
  <text x="92" y="323" font-family="Arial, sans-serif" font-size="14" fill="${ivory}">See the work</text>`,
)

const about = image(
  "studio-about",
  "about.png",
  "1600 × 900 PNG",
  `<rect width="800" height="450" fill="${ivory}"/>
  <rect x="60" y="60" width="300" height="330" rx="4" fill="${clay}"/>
  <circle cx="210" cy="190" r="60" fill="${sand}"/>
  <text x="420" y="130" ${serif} font-size="40" fill="${ink}">About Studio</text>
  <rect x="420" y="170" width="300" height="10" rx="5" fill="${sand}"/>
  <rect x="420" y="195" width="270" height="10" rx="5" fill="${sand}"/>
  <rect x="420" y="220" width="290" height="10" rx="5" fill="${sand}"/>
  <rect x="420" y="280" width="140" height="36" rx="18" fill="${ink}"/>`,
)

const mobile = image(
  "studio-mobile",
  "home-mobile.png",
  "390 × 844 PNG",
  `<rect width="800" height="450" fill="#e9e4d8"/>
  <rect x="310" y="20" width="180" height="410" rx="22" fill="${ivory}" stroke="${ink}" stroke-width="4"/>
  <text x="332" y="90" ${serif} font-size="20" fill="${ink}">Careful work,</text>
  <text x="332" y="114" ${serif} font-size="20" fill="${ink}">made slowly.</text>
  <rect x="332" y="140" width="136" height="90" rx="3" fill="${olive}"/>
  <rect x="332" y="240" width="136" height="90" rx="3" fill="${clay}"/>
  <rect x="332" y="340" width="136" height="60" rx="3" fill="${sand}"/>`,
)

const home: SampleArtifact = {
  item: {
    id: "studio-home",
    kind: "file",
    name: "Home.tsx",
    detail: "src/pages/Home.tsx · lines 12–24",
    path: `${studio}/src/pages/Home.tsx`,
    url: null,
    lines: { from: 12, to: 24 },
    held: false,
  },
  content: ready({
    kind: "file",
    path: "src/pages/Home.tsx",
    firstLine: 9,
    from: 12,
    to: 24,
    total: 25,
    truncated: false,
    clamped: false,
    lines: [
      'import { ProjectCard } from "../components/ProjectCard"',
      'import { projects } from "../content/projects"',
      "",
      "export default function Home() {",
      "  const featured = projects.slice(0, 3)",
      "  return (",
      "    <main>",
      '      <Intro title="Careful work, made slowly." />',
      '      <section aria-label="Selected work">',
      "        {featured.map((project) => (",
      "          <ProjectCard key={project.slug} project={project} />",
      "        ))}",
      "      </section>",
      "      <Contact />",
      "    </main>",
      "  )",
      "}",
    ],
  }),
}

const voiceLines = [
  "# Studio voice",
  "",
  "How Studio sounds on the site, in proposals and in captions. Written from the interviews in March; the founders signed off on it.",
  "",
  "## In a sentence",
  "",
  "Plain, warm and exact: we say what the work is and why it matters, and stop.",
  "",
  "## Principles",
  "",
  '- **Name the thing.** "A type system for a quarterly journal", not "a holistic brand experience".',
  "- **Credit the people.** Every project names its collaborators, from the architect to the photographer.",
  "- **Let the work lead.** Copy sits beside images, never over them; captions are one line.",
  "- **Slow is a value, not an excuse.** Say how long things took when it helps the reader trust the result.",
  "",
  "## Words we use, and don't",
  "",
  "| Prefer | Avoid |",
  "| --- | --- |",
  "| identity | branding solution |",
  "| publication | content |",
  "| place, wayfinding | spatial experience |",
  "| we made | we delivered |",
  "",
  "## Headlines",
  "",
  "Short, sentence case, no exclamation marks. The home page leads with *Careful work, made slowly.*; project pages lead with the project's name and one line on what it is.",
  "",
  "## Open questions",
  "",
  "1. Do we sign case studies with a person's name, or as Studio?",
  "2. Should the journal keep its own voice, closer to the publisher's?",
  "",
  "> Write as you would explain the work to a friend who asked, across a table.",
]

const voice: SampleArtifact = {
  item: {
    id: "studio-voice",
    kind: "file",
    name: "brand-voice.md",
    detail: "docs/brand-voice.md",
    path: `${studio}/docs/brand-voice.md`,
    url: null,
    lines: null,
    held: false,
  },
  content: ready(fileLines("docs/brand-voice.md", voiceLines, { from: 1, to: voiceLines.length })),
}

const projectLines = [
  "[",
  "  {",
  '    "slug": "harbour-press",',
  '    "title": "Harbour Press",',
  '    "year": 2025,',
  '    "discipline": ["identity", "publication"],',
  '    "summary": "A new identity, type system and quarterly journal for an independent publisher on the north coast, built around a single condensed serif that carries everything from the masthead to the smallest colophon.",',
  '    "cover": "/work/harbour-press.jpg",',
  '    "featured": true',
  "  },",
  "  {",
  '    "slug": "field-notes",',
  '    "title": "Field Notes",',
  '    "year": 2024,',
  '    "discipline": ["publication"],',
  '    "cover": "/work/field-notes.jpg",',
  '    "featured": false',
  "  },",
  "  {",
  '    "slug": "the-orchard",',
  '    "title": "The Orchard",',
  '    "year": 2023,',
  '    "discipline": ["place", "wayfinding"],',
  '    "cover": "/work/the-orchard.jpg",',
  '    "credits": "Wayfinding with Hollis & Reyes Architects; signage fabricated by Northfield Metalworks; photography by Ana Lindqvist; additional illustration by the studio team over two seasons of site visits.",',
  '    "featured": false',
  "  }",
  "]",
]

const projects: SampleArtifact = {
  item: {
    id: "studio-projects",
    kind: "file",
    name: "projects.json",
    detail: "src/content/projects.json · lines 2–10",
    path: `${studio}/src/content/projects.json`,
    url: null,
    lines: { from: 2, to: 10 },
    held: false,
  },
  content: ready(fileLines("src/content/projects.json", projectLines, { from: 2, to: 10 })),
}

const preview: SampleArtifact = {
  item: {
    id: "studio-preview",
    kind: "page",
    name: "localhost:5173",
    detail: "Dev server preview",
    path: null,
    url: "http://localhost:5173/",
    lines: null,
    held: false,
  },
  content: ready({
    kind: "page",
    url: "http://localhost:5173/",
    live: false,
    snapshot: svg(
      1600,
      900,
      `<rect width="800" height="450" fill="${ivory}"/>
  <text x="48" y="58" ${serif} font-size="18" font-weight="600" fill="${ink}">Studio</text>
  <text x="652" y="58" font-family="Arial, sans-serif" font-size="12" letter-spacing="1" fill="${ink}">WORK</text>
  <text x="706" y="58" font-family="Arial, sans-serif" font-size="12" letter-spacing="1" fill="${ink}">ABOUT</text>
  <text x="48" y="148" ${serif} font-size="42" fill="${ink}">Careful work, made slowly.</text>
  <text x="48" y="186" font-family="Arial, sans-serif" font-size="15" fill="#5c574d">An independent design practice working on identities, publications and places.</text>
  <rect x="48" y="226" width="224" height="180" rx="3" fill="${olive}"/>
  <rect x="288" y="226" width="224" height="180" rx="3" fill="${clay}"/>
  <rect x="528" y="226" width="224" height="180" rx="3" fill="${sand}"/>`,
    ),
  }),
}

// Shown before the demo starts; opened for the user as the demo starts; then one at a
// time as the user types `show` or `open`.
export const studioArtifacts: SampleArtifacts = {
  shown: [hero, about, voice],
  opened: [projects],
  next: [home, preview, mobile],
}

// What the dev server's terminal holds that can't show, one of each reason, and text that
// shows only in part: so each looks as it would.
const unavailable = (
  id: string,
  item: Partial<SampleArtifact["item"]> & Pick<SampleArtifact["item"], "name">,
  content: ItemContent,
): SampleArtifact => ({
  item: {
    id,
    kind: "file",
    detail: item.name,
    path: `${studio}/${item.name}`,
    url: null,
    lines: null,
    held: false,
    ...item,
  },
  content,
})

const cannot = (reason: UnavailableReason, size: number | null = null): ItemContent => ({
  state: "unavailable",
  reason,
  size,
})

const logLines = Array.from(
  { length: 200 },
  (_, index) =>
    `12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}  GET /work/${index % 7} 200 ${3 + (index % 11)}ms`,
)

const routeLines = [
  'import { Route, Routes } from "react-router"',
  "",
  'import Home from "./pages/Home"',
  'import Work from "./pages/Work"',
  "",
  "export const routes = (",
  "  <Routes>",
  '    <Route path="/" element={<Home />} />',
  '    <Route path="/work/:slug" element={<Work />} />',
  "  </Routes>",
  ")",
]

const envLines = [
  "# Local settings for the dev server",
  "VITE_API_URL=http://localhost:8787",
  "VITE_PREVIEW_TOKEN=demo-only-not-a-secret",
]

export const devServerArtifacts: readonly SampleArtifact[] = [
  unavailable(
    "dev-plan",
    {
      kind: "plan",
      name: "old-migration.md",
      detail: "In Codex's conversation",
      path: "~/.codex/sessions/2026/09/rollout-old-migration.jsonl",
      plan: { agent: "Codex", role: "subagent", source: "text" },
    },
    cannot("gone"),
  ),
  unavailable("dev-notes", { name: "notes.md" }, cannot("missing")),
  unavailable("dev-log", { name: "server.log" }, cannot("unreadable")),
  unavailable("dev-dist", { name: "dist" }, cannot("not-a-file")),
  unavailable(
    "dev-recording",
    { kind: "image", name: "screen-recording.png", detail: "3840 × 2160 PNG" },
    cannot("too-large", 14_680_064),
  ),
  unavailable("dev-archive", { name: "studio.zip" }, cannot("binary", 2_310_144)),
  unavailable(
    "dev-env",
    { name: ".env.local", held: true },
    ready(fileLines(".env.local", envLines, { from: 1, to: envLines.length })),
  ),
  unavailable(
    "dev-build",
    { name: "build.log", detail: "build.log · its start" },
    ready({
      ...fileLines("build.log", logLines, { from: 1, to: 40 }),
      total: null,
      truncated: true,
    }),
  ),
  unavailable(
    "dev-routes",
    { name: "routes.tsx", detail: "src/routes.tsx · lines 6–60", lines: { from: 6, to: 60 } },
    ready({
      ...fileLines("src/routes.tsx", routeLines, { from: 6, to: routeLines.length }),
      clamped: true,
    }),
  ),
]
