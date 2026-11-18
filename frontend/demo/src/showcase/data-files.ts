import type { FileContent } from "@novadeck/core/items"

import { fileLines, ready, type SampleArtifact } from "./artifacts"

// Data files the dev server's terminal shows, one of each way the tree reads them: YAML with
// anchors and two documents; a JSONL transcript read only in part, one record cut short; a
// YAML file that doesn't read, which goes to its source; and a long JSON file shown from
// its middle, which can't read as a whole.

const studio = "~/projects/studio"

const file = (id: string, path: string, content: FileContent, detail = path): SampleArtifact => ({
  item: {
    id,
    kind: "file",
    name: path.split("/").at(-1)!,
    detail,
    path: `${studio}/${path}`,
    url: null,
    lines: null,
    secret: false,
  },
  content: ready(content),
})

const composeLines = [
  "x-node: &node",
  "  image: node:26-alpine",
  "  restart: unless-stopped",
  "  environment:",
  "    NODE_ENV: development",
  "",
  "services:",
  "  web:",
  "    <<: *node",
  "    command: pnpm dev --host",
  "    ports: ['5173:5173']",
  "  api:",
  "    <<: *node",
  "    command: pnpm --filter api start",
  "    ports: ['8787:8787']",
  "    depends_on: [db]",
  "  db:",
  "    image: postgres:18",
  "    volumes: [db:/var/lib/postgresql/data]",
  "volumes:",
  "  db: {}",
  "---",
  "# Overrides for CI",
  "services:",
  "  web:",
  "    command: pnpm build && pnpm preview",
  "    healthcheck:",
  "      test: [CMD, wget, -q, http://localhost:4173]",
  "      interval: 5s",
]

// A session's transcript, as an agent writes one: a record per line.
const transcript = [
  { type: "summary", summary: "Studio site: case studies and the journal", leafUuid: "8c1e" },
  {
    type: "user",
    uuid: "1f04",
    timestamp: "2026-11-18T09:12:03.114Z",
    message: { role: "user", content: "Add a journal index page that lists posts by season." },
  },
  {
    type: "assistant",
    uuid: "2a77",
    parentUuid: "1f04",
    timestamp: "2026-11-18T09:12:09.880Z",
    message: {
      role: "assistant",
      model: "claude-opus-5-5",
      content: [
        { type: "text", text: "I'll read the content collection first." },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Read",
          input: { file_path: "src/content/config.ts" },
        },
      ],
      usage: { input_tokens: 5120, output_tokens: 86, cache_read_input_tokens: 48210 },
    },
  },
  {
    type: "user",
    uuid: "3b19",
    parentUuid: "2a77",
    timestamp: "2026-11-18T09:12:10.204Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: "export const collections = { journal, work }",
        },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "4c02",
    parentUuid: "3b19",
    timestamp: "2026-11-18T09:12:15.551Z",
    message: {
      role: "assistant",
      model: "claude-opus-5-5",
      content: [
        { type: "text", text: "The journal has a `season` field, so the index can group by it." },
      ],
      usage: { input_tokens: 5302, output_tokens: 41, cache_read_input_tokens: 48210 },
    },
  },
].map((record) => JSON.stringify(record))
// The runner cuts a line at 4096 characters: a record past that arrives cut short.
const cutRecord = JSON.stringify({
  type: "user",
  uuid: "5d88",
  message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(5000) }] },
}).slice(0, 4096)
const transcriptLines = [...transcript, cutRecord]

const brokenLines = [
  "name: deploy",
  "on:",
  "  push:",
  "    branches: [main]",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v6",
  "      - run: pnpm install",
  "     - run: pnpm build",
]

// A long JSON file's middle, around the lines an agent pointed at.
const lockLines = Array.from({ length: 60 }, (_, index) => {
  const at = index + 380
  return index % 4 === 0
    ? `    "node_modules/pkg-${at}": {`
    : index % 4 === 1
      ? `      "version": "1.${at}.0",`
      : index % 4 === 2
        ? `      "license": "MIT"`
        : "    },"
})

export const dataArtifacts: readonly SampleArtifact[] = [
  file(
    "data-compose",
    "compose.yaml",
    fileLines("compose.yaml", composeLines, { from: 1, to: composeLines.length }),
  ),
  file(
    "data-transcript",
    "logs/session.jsonl",
    {
      ...fileLines("logs/session.jsonl", transcriptLines, { from: 1, to: transcriptLines.length }),
      total: null,
      truncated: true,
    },
    "logs/session.jsonl · its start",
  ),
  file(
    "data-broken",
    ".github/workflows/deploy.yml",
    fileLines(".github/workflows/deploy.yml", brokenLines, { from: 1, to: brokenLines.length }),
  ),
  file(
    "data-lock",
    "package-lock.json",
    {
      ...fileLines("package-lock.json", lockLines, { from: 400, to: 420, firstLine: 380 }),
      total: 9214,
    },
    "package-lock.json · lines 400–420",
  ),
]
