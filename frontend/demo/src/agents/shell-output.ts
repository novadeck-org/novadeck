import type { ShellOutput } from "@novadeck/core/items"
import type { AgentShell } from "@novadeck/core/types"

// What the demo's background shells print, for the shells item to show. A demo shell's output
// path says how its output stands (`demoOutputPath`); the lines come from what the demo has for
// its command, and a running shell goes on printing, a line every few seconds, so a pane
// following its end has something to follow.

const prefix = "demo-output:"

export type DemoOutputState = "ready" | "none" | "unreadable" | "gone"

export const demoOutputPath = (state: DemoOutputState): string => `${prefix}${state}`

// How often a running shell prints a line, in milliseconds, and how many of the last lines the
// runner keeps for a shell.
export const printEveryMs = 3000
const keptLines = 400

type Sample = {
  // What it printed before the pane looked.
  readonly lines: readonly string[]
  // What a running one goes on printing, cycled, with `{n}` the number of the line.
  readonly goesOn?: readonly string[]
}

const samples: Readonly<Record<string, Sample>> = {
  "pnpm dev --filter storefront": {
    lines: [
      "> storefront@0.4.0 dev /home/you/projects/studio/apps/storefront",
      "> vite --port 5173",
      "",
      "  VITE v7.3.7  ready in 412 ms",
      "",
      "  ➜  Local:   http://localhost:5173/",
      "  ➜  Network: use --host to expose",
      "11:02:14 PM [vite] hmr update /src/routes/checkout.tsx",
      "11:03:57 PM [vite] hmr update /src/routes/checkout.tsx, /src/lib/totals.ts",
      "11:04:41 PM [vite] hmr update /src/lib/totals.ts",
      "11:04:42 PM [vite] page reload src/lib/totals.ts",
      "11:06:10 PM [vite] hmr update /src/components/CartLine.tsx",
    ],
    goesOn: [
      "11:07:{n} PM [vite] hmr update /src/components/CartLine.tsx",
      "11:07:{n} PM [vite] hmr update /src/lib/totals.ts",
    ],
  },
  "tail -f logs/api.log": {
    lines: [
      '{"level":"info","msg":"POST /api/cart/lines 201","ms":31}',
      '{"level":"warn","msg":"slow query: cart_lines by session","ms":412}',
      '{"level":"info","msg":"GET /api/checkout/total 200","ms":9}',
    ],
    goesOn: [
      '{"level":"info","msg":"GET /api/cart 200","ms":{n}}',
      '{"level":"info","msg":"POST /api/cart/lines 201","ms":{n}}',
    ],
  },
  "docker compose up postgres": {
    lines: [
      "[+] Running 1/1",
      " ✔ Container studio-postgres-1  Created",
      "Attaching to postgres-1",
      "postgres-1  | PostgreSQL init process complete; ready for start up.",
      "Error response from daemon: driver failed programming external connectivity on endpoint studio-postgres-1",
      "studio-postgres-1: Bind for 0.0.0.0:5432 failed: port is already allocated",
    ],
  },
  "pnpm build --filter storefront": {
    lines: [
      "> storefront@0.4.0 build /home/you/projects/studio/apps/storefront",
      "> vite build",
      "",
      "vite v7.3.7 building for production...",
      "✓ 184 modules transformed.",
      "dist/index.html                  0.62 kB",
      "dist/assets/index-9d2f1c.js    212.40 kB │ gzip: 68.31 kB",
      "✓ built in 3.20s",
    ],
  },
  "sleep 600": { lines: [] },
  "pytest -x tests/api": {
    lines: [
      "============ test session starts ============",
      "collected 42 items",
      "",
      "42 passed in 6.18s",
    ],
  },
  "npm run seed": { lines: [] },
}

// A shell's output as its path says it stands, the lines last printed at `now`.
export const demoShellOutput = (
  shell: Pick<AgentShell, "command" | "since" | "exit" | "output">,
  now: number,
): ShellOutput => {
  const state = shell.output?.startsWith(prefix) ? shell.output.slice(prefix.length) : "ready"
  if (state === "none" || state === "unreadable" || state === "gone") return { state }
  const sample = samples[shell.command] ?? { lines: [`$ ${shell.command}`] }
  const printed =
    shell.exit === null && sample.goesOn
      ? Math.min(900, Math.max(0, Math.floor((now - shell.since) / printEveryMs)))
      : 0
  const lines = [...sample.lines]
  for (let index = 0; index < printed; index += 1) {
    const line = sample.goesOn![index % sample.goesOn!.length]!
    lines.push(line.replace("{n}", String(10 + (index % 50)).padStart(2, "0")))
  }
  const kept = lines.slice(-keptLines)
  return {
    state: "ready",
    firstLine: lines.length - kept.length + 1,
    lines: kept,
    total: lines.length,
  }
}
