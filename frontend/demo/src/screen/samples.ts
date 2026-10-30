import type { SampleOutput } from "../samples"
import type { Block } from "./screen"
import { columns, span, wrap, type Line, type Span, type Style } from "./vt"

// The sample output a demo shell opens with, by what it runs, as the program prints it.

const gap: Line = []
const lines =
  (...rows: readonly Line[]): Block =>
  (width) =>
    rows.flatMap((row) => (row.length ? wrap(row, width, { rest: [span("  ")] }) : [gap]))

// A command typed at the prompt, and what it printed, set apart from what came before.
export const commandBlock =
  (command: string, reply = ""): Block =>
  (width) => [
    gap,
    ...wrap([span(command)], width, { first: [span("❯ ", "bold", "green")], rest: [span("  ")] }),
    ...(reply ? wrap([span(reply, "muted")], width) : []),
  ]

const typed = (command: string): Line => [span("❯ ", "bold", "green"), span(command)]

// Labels and values in two columns, the labels muted and as wide as the widest.
const pairs =
  (rows: readonly (readonly [string, string])[]): Block =>
  (width) => {
    const label = Math.max(...rows.map(([name]) => name.length)) + 2
    return rows.flatMap(([name, value]) =>
      wrap([span(value)], width, {
        first: [span(name.padEnd(label), "muted")],
        rest: [span(" ".repeat(label))],
      }),
    )
  }

// What the dev server hot-updated since it was ready: the two it opened with, then one more
// each time it moves on.
const hotUpdates = [
  "/src/App.tsx",
  "/src/styles.css",
  "/src/checkout/OrderSummary.tsx",
  "/src/cart/CartSummary.tsx",
  "/src/checkout/Checkout.tsx",
  "/src/styles.css",
  "/src/cart/CartSummary.tsx",
]
// The seconds between two of its updates in the log, as the clock reads them.
const hotUpdateGapS = 14

const clock = (seconds: number): string =>
  [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")

// The dev server's `index`th hot update, as its log prints it.
const hotUpdateBlock = (index: number): Block =>
  lines([
    span(
      `${clock(9 * 3600 + 42 * 60 + 16 + (index < 2 ? index * 2 : 2 + (index - 1) * hotUpdateGapS))} [vite] hmr update ${hotUpdates[index % hotUpdates.length]!}`,
      "muted",
    ),
  ])

// The files the watching tests rerun for, one each time they move on.
const reruns = [
  { file: "src/cart/CartSummary.test.ts", tests: 5, ms: 14 },
  { file: "src/checkout/Checkout.test.ts", tests: 8, ms: 21 },
  { file: "src/checkout/OrderSummary.test.ts", tests: 6, ms: 12 },
]

const summaryRows = (files: number, tests: number, ms: number): Line[] => [
  [span(" Test Files  "), span(`${files} passed`, "bold", "green"), span(` (${files})`, "muted")],
  [span("      Tests  "), span(`${tests} passed`, "bold", "green"), span(` (${tests})`, "muted")],
  [span("   Duration  "), span(`${ms}ms`)],
]

const passed = (file: string, detail: string): Line => [
  span("✓ ", "green"),
  span(file),
  span(` ${detail}`, "muted"),
]

const waiting: Line[] = [
  gap,
  [span(" PASS ", "reverse", "bold", "green"), span(" Waiting for file changes…")],
  [span("press h to show help, press q to quit", "muted")],
]

// The watching tests' screen: the first run, or the rerun after `beats` changes, which
// clears the screen as Vitest's watch mode does.
const testsBlock = (directory: string, beats: number): Block => {
  if (beats === 0)
    return lines(
      typed("pnpm test --watch"),
      [
        span(" DEV ", "reverse", "bold", "blue"),
        span(" v5.0.1 "),
        span(directory.replace("~", ""), "muted"),
      ],
      gap,
      passed("workspace.spec.ts", "(8 tests) 24ms"),
      passed("terminal.spec.ts", "(6 tests) 18ms"),
      passed("canvas.spec.ts", "(4 tests) 12ms"),
      gap,
      ...summaryRows(3, 18, 684),
      ...waiting,
    )
  const { file, tests, ms } = reruns[(beats - 1) % reruns.length]!
  return lines(
    [span(" RERUN ", "reverse", "bold", "blue"), span(` ${file} x${beats}`, "muted")],
    gap,
    passed(file.split("/").at(-1)!, `(${tests} tests) ${ms}ms`),
    gap,
    ...summaryRows(1, tests, ms + 40 + (beats % 3) * 7),
    ...waiting,
  )
}

const files = [
  "application/",
  "package.json",
  "README.md",
  "node_modules/",
  "pnpm-lock.yaml",
  "tsconfig.json",
]
const folder = (name: string): Span =>
  span(name, ...(name.endsWith("/") ? (["bold", "blue"] as Style[]) : []))

const commits = [
  ["e9a4c21", "refine workspace layout"],
  ["82b6f09", "add terminal sessions"],
  ["7d1a308", "simplify navigation"],
  ["c4f8e62", "set up design tokens"],
  ["3a9b715", "initial commit"],
] as const

const requests = [
  ["09:41:02", "GET /api/health", "200", "2ms"],
  ["09:41:04", "GET /api/sessions", "200", "4ms"],
  ["09:41:04", "WS /terminal", "101", "1ms"],
  ["09:42:10", "GET /api/health", "200", "1ms"],
  ["09:42:16", "GET /api/sessions", "200", "3ms"],
] as const

const built = [
  ["dist/index.html", "0.64 kB"],
  ["dist/assets/index.css", "12.81 kB"],
  ["dist/assets/index.js", "184.32 kB"],
] as const

// What a shell opens with, by what it runs. The dev server shows the hot updates it has
// had so far: its log keeps them all, and a beat appends the next (`hotUpdateBlock`).
export const sampleBlocks = (
  output: SampleOutput,
  { directory, projectName, beats = 0 }: { directory: string; projectName: string; beats?: number },
): Block[] => {
  if (output === "shell")
    return [
      pairs([
        ["Last login", "Tue Sep 22, 09:41:08 on ttys001"],
        ["Workspace", directory],
      ]),
      lines(
        gap,
        typed("git status"),
        [span("On branch "), span("main", "bold")],
        [span("Your branch is up to date with 'origin/main'.", "muted")],
        gap,
        [span("Nothing to commit, working tree clean.")],
        gap,
        typed("ls"),
      ),
      (width) => columns(files.map(folder), width),
    ]
  if (output === "server")
    return [
      lines(
        typed("pnpm dev"),
        [span(`> @${projectName}/ui dev`, "muted")],
        [span("> vite", "muted")],
        gap,
        [
          span("  VITE", "bold", "green"),
          span(" v7.3.6  "),
          span("ready in", "muted"),
          span(" 184 ms"),
        ],
        gap,
        [span("  ➜  Local:   "), span("http://localhost:5173/", "underline", "cyan")],
        [span("  ➜  Network: use --host to expose", "muted")],
        gap,
      ),
      ...Array.from({ length: 2 + beats }, (_, index) => hotUpdateBlock(index)),
    ]
  if (output === "tests") return [testsBlock(directory, beats)]
  if (output === "git")
    return [
      lines(
        typed("git log --oneline -5"),
        ...commits.map(([hash, message]): Line => [span(hash, "yellow"), span(` ${message}`)]),
        gap,
        typed("git status --short"),
        [span("Working tree clean.", "muted")],
      ),
    ]
  if (output === "logs")
    return [
      lines(
        typed("pnpm dev"),
        gap,
        [span("Runtime listening on :3000")],
        [span("Watching for changes…", "muted")],
        gap,
        ...requests.map(([at, request, code, ms]): Line => [
          span(at, "muted"),
          span(` ${request} `),
          span(code, code.startsWith("1") ? "cyan" : "green"),
          span(` ${ms}`, "muted"),
        ]),
        gap,
        [span("Connection established. Listening.", "muted")],
      ),
    ]
  return [
    lines(
      typed("pnpm build"),
      gap,
      [span("vite v7.3.6 building for production…", "muted")],
      [span("✓ ", "green"), span("1,428 modules transformed.")],
      gap,
      ...built.map(([file, size]): Line => [
        span(file.padEnd(24)),
        span(size.padStart(9), "muted"),
      ]),
      gap,
      [span("✓ ", "green"), span("built in 1.24s")],
    ),
  ]
}
