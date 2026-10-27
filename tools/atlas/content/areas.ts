import type { AnchorRef } from "../src/atlas.ts"

// Areas are named by tokens that mirror where the code lives: a package's token, then
// one segment per folder, as `backend/runner/terminals` or `frontend/ui/app`. The extractor
// derives them from the folders; this file only says which packages they start from and
// what each token is for.

export type Root = {
  // The package's token, the first segment of every token under it.
  token: string
  // The package's directory, repository-relative.
  dir: string
  // Where its folders become tokens; without it the package is one token.
  src?: string
  // The runtime node its code runs in.
  node: string
  // Folders under `src` whose own folders become tokens too.
  split?: string[]
  // Tokens that run in another node than the package's.
  nodes?: Record<string, string>
}

export type Note = {
  purpose: string
  entries?: AnchorRef[]
  docs?: string[]
}

// Source under these directories must belong to a package below, or the strict check fails.
export const covered = ["apps/", "backend/", "contract/", "frontend/", "harnesses/", "engines/"]

export const roots: Root[] = [
  { token: "backend/runner", dir: "backend/runner", src: "src", node: "runner" },
  { token: "contract/protocol", dir: "contract/protocol", node: "runner" },
  { token: "contract/runner-client", dir: "contract/runner-client", node: "renderer" },
  { token: "backend/relay", dir: "backend/relay", node: "relay" },
  { token: "harnesses/core", dir: "harnesses/core", node: "runner" },
  { token: "harnesses/claude", dir: "harnesses/claude", node: "runner" },
  { token: "harnesses/codex", dir: "harnesses/codex", node: "runner" },
  { token: "harnesses/agy", dir: "harnesses/agy", node: "runner" },
  {
    token: "apps/desktop",
    dir: "apps/desktop",
    src: "src",
    node: "electron-main",
    nodes: { "apps/desktop/preload": "preload", "apps/desktop/runner": "runner" },
  },
  { token: "frontend/ui", dir: "frontend/ui", src: "src", node: "renderer" },
  { token: "frontend/core", dir: "frontend/core", node: "renderer" },
  { token: "frontend/test-kit", dir: "frontend/test-kit", node: "renderer" },
  { token: "frontend/toolkit", dir: "frontend/toolkit", node: "renderer" },
  { token: "frontend/items", dir: "frontend/items", node: "renderer" },
  { token: "frontend/chat", dir: "frontend/chat", node: "renderer" },
  { token: "frontend/runner-adapter", dir: "frontend/runner-adapter", node: "renderer" },
  { token: "frontend/terminal-views", dir: "frontend/terminal-views", node: "renderer" },
  { token: "frontend/demo", dir: "frontend/demo", node: "renderer" },
  { token: "frontend/demo-debug", dir: "frontend/demo-debug", node: "renderer" },
  { token: "frontend/specs", dir: "frontend/specs", node: "renderer" },
  { token: "frontend/chat-contract", dir: "frontend/chat-contract", node: "renderer" },
  { token: "apps/try", dir: "apps/try", node: "renderer" },
  { token: "apps/previews", dir: "apps/previews", node: "renderer" },
  { token: "engines/whisper", dir: "engines/whisper", node: "whisper" },
  { token: "engines/ggml-build", dir: "engines/ggml-build", node: "whisper" },
  { token: "engines/murmur", dir: "engines/murmur", node: "murmur" },
]

const runner = "backend/runner/src"
const ui = "frontend/ui/src"
const core = "frontend/core/src"
const adapter = "frontend/runner-adapter/src"
const views = "frontend/terminal-views/src"
const demo = "frontend/demo/src"

export const notes: Record<string, Note> = {
  "backend/runner": {
    purpose:
      "Builds the runner from its parts and serves the protocol contract through the wire's sessions over a WebSocket or a port, with the router that maps procedures to domain objects, HTTP status, and the CLI that starts it.",
    entries: [
      { file: `${runner}/runner.ts`, text: "export const createRunner" },
      { file: `${runner}/router.ts`, text: "export const createRouter" },
      { file: `${runner}/server.ts`, text: "serveWebSocket(runner.sessions" },
    ],
    docs: ["docs/backend-api.md", "docs/backend-plan.md"],
  },
  "backend/runner/terminals": {
    purpose:
      "Owns every terminal: spawns shells, keeps their screen, scrollback and transcripts, tracks the foreground process and its agent, handles prompts, answers, naming and nudges, and performs the calls agents make through the MCP server.",
    entries: [
      { file: `${runner}/terminals/manager.ts`, text: "export class Terminals" },
      { file: `${runner}/terminals/opens.ts` },
      { file: `${runner}/messaging/doorbell.ts` },
    ],
    docs: ["docs/agent-workspace.md"],
  },
  "backend/runner/workspaces": {
    purpose:
      "Projects and sessions with their SQLite store; settings, terminal order and layouts live there too.",
    entries: [
      { file: `${runner}/workspaces/store.ts`, text: "CREATE TABLE projects" },
      { file: `${runner}/workspaces/projects.ts` },
    ],
    docs: ["docs/agent-workspace.md"],
  },
  "backend/runner/companions": {
    purpose:
      "The items an agent shows beside its terminal (files, pages, plans), their records, content and the requests that open them.",
    entries: [{ file: `${runner}/companions/items.ts`, text: "export class CompanionItems" }],
    docs: ["docs/agent-workspace.md"],
  },
  "backend/runner/messaging": {
    purpose:
      "Lets agents in one project and session message each other: size and rate limits, leads and peers, held threads, and delivery through each harness's hooks and the terminal doorbell.",
    entries: [
      { file: `${runner}/messaging/messaging.ts`, text: "export type Scope" },
      { file: `${runner}/messaging/messages.ts`, text: "export const maxMessageBytes" },
      { file: `${runner}/messaging/delivery.ts` },
    ],
    docs: ["docs/agent-messaging.md"],
  },
  "backend/runner/harnesses": {
    purpose:
      "The runner's side of the agent harnesses: the registry of adapters, connecting and disconnecting their plugins, binding hook reports to sessions, and deriving activity, replies, plans and typed prompts from what they report.",
    entries: [
      { file: `${runner}/harnesses/registry.ts`, text: "export const harnesses" },
      { file: `${runner}/harnesses/service.ts`, text: "export const createHarnesses" },
      { file: `${runner}/harnesses/bindings.ts` },
    ],
    docs: ["docs/harness-adapters.md", "docs/harness-coverage.md"],
  },
  "backend/runner/shell": {
    purpose:
      "Writes the shell files and agent plugin files Novadeck puts in front of each terminal, receives hook reports from the relay, and serves the MCP tools agents call.",
    entries: [
      { file: `${runner}/shell/mcp.ts`, text: "const tools: readonly Tool<unknown>[]" },
      { file: `${runner}/shell/reports.ts`, text: "const callTypes" },
      { file: `${runner}/shell/install.ts` },
    ],
    docs: ["docs/agent-messaging.md"],
  },
  "backend/runner/engines": {
    purpose:
      "Downloads, verifies, unpacks and tracks the native inference engines from their manifests, with progress and cancellation.",
    entries: [
      { file: `${runner}/engines/install.ts`, text: "export const fetchEngine" },
      { file: `${runner}/engines/download.ts` },
    ],
  },
  "backend/runner/voice": {
    purpose:
      "Voice dictation: language and model catalog, the whisper engine process, audio converted to WAV, and the settings and state the UI reads.",
    entries: [
      { file: `${runner}/voice/service.ts`, text: "export class Voice" },
      { file: `${runner}/voice/engine.ts` },
    ],
  },
  "backend/runner/murmur": {
    purpose:
      "The optional small local model that names and summarizes terminals: runs the llama.cpp server, builds redacted digests of a terminal's activity, and keeps descriptions stable.",
    entries: [
      { file: `${runner}/murmur/service.ts`, text: "export class Murmur" },
      { file: `${runner}/murmur/describer.ts`, text: "export type Digest" },
    ],
    docs: ["docs/murmur.md"],
  },
  "backend/runner/e2e": {
    purpose: "End-to-end scenarios that drive real harness CLIs against a runner.",
    entries: [{ file: `${runner}/e2e/scenarios.ts` }],
    docs: ["docs/e2e-testing.md"],
  },
  "backend/runner/testing": {
    purpose:
      "Test doubles the runner's tests share: fake engines and models, PTY children, adapters and workers.",
  },
  "contract/protocol": {
    purpose:
      "The contract between UI and runner: the oRPC procedures with Zod schemas and error codes, and the Electron bridge types. It never imports its client, which is a package of its own.",
    entries: [{ file: "contract/protocol/src/contract.ts", text: "export const contract" }],
    docs: ["docs/backend-api.md"],
  },
  "contract/runner-client": {
    purpose:
      "The connectRunner client UIs reach a runner with, over the wire library (libraries/wire), which holds the channels, transports and the wire's own error codes; the desktop app's transport to its bundled runner, and the error codes a client reports.",
    entries: [
      { file: "contract/runner-client/src/index.ts" },
      { file: "contract/runner-client/src/runner.ts", text: "export const connectRunner" },
    ],
    docs: ["docs/backend-api.md"],
  },
  "backend/relay": {
    purpose:
      "A small Rust binary agents start for Novadeck: it runs hooks and the status line by forwarding them to the runner and printing its answer, and carries the MCP server's JSON-RPC.",
    entries: [
      { file: "backend/relay/src/main.rs" },
      { file: "backend/relay/src/hook.rs" },
      { file: "backend/relay/src/mcp.rs", text: "pub fn run" },
    ],
    docs: ["docs/agent-messaging.md"],
  },
  "harnesses/core": {
    purpose:
      "The contract every harness adapter implements, and what they share: hook commands, events, reports, dialogs and shell quoting, and the `Harness` type whose `box` is a tui-input `BoxProfile`.",
    entries: [
      { file: "harnesses/core/src/harness.ts", text: "export type Harness = {" },
      { file: "harnesses/core/src/events.ts" },
    ],
    docs: ["docs/harness-adapters.md"],
  },
  "harnesses/claude": {
    purpose:
      "The Claude Code adapter: its plugin and hooks, hook reports, transcripts, dialogs, input box and sessions.",
    entries: [{ file: "harnesses/claude/src/index.ts", text: "export const claude" }],
    docs: ["docs/harness-coverage.md"],
  },
  "harnesses/codex": {
    purpose: "The Codex adapter, the same shape as harnesses/claude.",
    entries: [{ file: "harnesses/codex/src/index.ts", text: "export const codex" }],
    docs: ["docs/harness-coverage.md"],
  },
  "harnesses/agy": {
    purpose: "The Antigravity adapter, the same shape as harnesses/claude.",
    entries: [{ file: "harnesses/agy/src/index.ts", text: "export const agy" }],
    docs: ["docs/harness-coverage.md"],
  },
  "apps/desktop": {
    purpose: "The desktop package's build, packaging scripts and the bridge types it shares.",
  },
  "apps/desktop/main": {
    purpose:
      "The desktop app's main process: windows and menus, starting the runner in a utility process, permissions and sandbox choices, installation, auto-update and quitting.",
    entries: [
      { file: "apps/desktop/src/main/index.ts", text: "const createWindow" },
      { file: "apps/desktop/src/main/updater.ts" },
    ],
    docs: ["docs/auto-update.md", "docs/release-signing.md"],
  },
  "apps/desktop/preload": {
    purpose:
      "The narrow, validated API the window gets from the host: the runner's port and the desktop actions it may request.",
    entries: [{ file: "apps/desktop/src/preload/index.ts" }],
  },
  "apps/desktop/runner": {
    purpose: "The utility process entry that creates the runner inside the desktop app.",
    entries: [{ file: "apps/desktop/src/runner/index.ts" }],
  },
  "frontend/ui": {
    purpose: "The UI package's entry and global styles.",
    entries: [{ file: `${ui}/entries/start.tsx` }],
  },
  "frontend/ui/app": {
    purpose:
      "The composition root: boot and backend selection, routing, the UI store, selectors, commands and key commands, and the controller hooks that sync React with the stores.",
    entries: [
      { file: `${ui}/app/App.tsx`, text: "export const App" },
      { file: `${ui}/app/commands/context.ts`, text: "export type CommandContext" },
    ],
  },
  "frontend/core": {
    purpose:
      "The pure domain of the workspace: state, reducer and store, seed data, layout rules, roster, conversations and the answers to their questions, messages, companions and usage, the terminal lifecycle registry the backends share, and the port the UI talks to its backend through, with no React.",
    entries: [
      { file: `${core}/store.ts`, text: "export const createStore" },
      { file: `${core}/types.ts` },
      { file: `${core}/registry.ts` },
      { file: `${core}/port.ts`, text: "export type MountTerminal" },
    ],
  },
  "frontend/runner-adapter": {
    purpose:
      "The backend port against the runner: connection and reconnects, seeding, saves, conversations, companions, messages and its terminals' streams.",
    entries: [
      { file: `${adapter}/backend.ts`, text: "export type RunnerBackendOptions" },
      { file: `${adapter}/view-options.ts`, text: "export const viewOptions" },
    ],
    docs: ["docs/backend-api.md"],
  },
  "frontend/terminal-views": {
    purpose:
      "The xterm mount every backend draws its terminals with: the page's theme, the WebGL pool, links and the screens' styles.",
    entries: [{ file: `${views}/mount.ts`, text: "export const createTerminalMount" }],
  },
  "frontend/demo": {
    purpose: "The demo backend with sample data that tests, specs and the web preview run on.",
    entries: [{ file: `${demo}/index.ts`, text: "export const createDemoBackend" }],
  },
  "frontend/ui/test": {
    purpose:
      "The command harness for the UI's tests: the real stores, navigator and commands over a workspace fixture.",
    entries: [{ file: `${ui}/test/commands.ts` }],
  },
  "frontend/ui/terminals": {
    purpose: "Terminal frames and tabs.",
    entries: [{ file: `${ui}/terminals/TerminalTabs.tsx` }],
  },
  "frontend/ui/layouts": {
    purpose: "The Focus, Grid and Canvas views that arrange terminals, and the workspace ground.",
    entries: [{ file: `${ui}/layouts/transition.ts` }],
  },
  "frontend/ui/shell": {
    purpose:
      "The chrome around the workspace: header, footer, rail and panels, empty states and crash notices.",
    entries: [{ file: `${ui}/shell/shell-state.ts` }],
  },
  "frontend/ui/sidebar": { purpose: "The sidebar's panels and the sessions list." },
  "frontend/ui/projects": { purpose: "The project list, its pins bar, arrangement and statuses." },
  "frontend/ui/preferences": {
    purpose: "Preferences, the welcome dialog and the voice and murmur add-ons.",
  },
  "frontend/ui/search": { purpose: "Finding a terminal." },
  "frontend/ui/inbox": {
    purpose:
      "The Inbox: what agents ask of the person, as sidebar rows and the sheet that answers.",
    entries: [{ file: `${ui}/inbox/inbox-state.ts` }],
  },
  "frontend/ui/voice": {
    purpose: "Dictation: audio capture, resampling and the dictation overlay.",
    entries: [{ file: `${ui}/voice/dictation.ts` }],
  },
  "frontend/ui/theme": {
    purpose: "Themes (Graphite, Phosphor), their tokens and contract.",
    entries: [{ file: `${ui}/theme/apply.ts` }],
    docs: ["docs/theming.md"],
  },
  "frontend/ui/interaction": {
    purpose: "Shortcuts, the keymap and focus helpers.",
    entries: [{ file: `${ui}/interaction/keymap.ts` }],
  },
  "frontend/specs": { purpose: "Behaviour specs that exercise the whole UI on the demo backend." },
  "frontend/chat-contract": {
    purpose:
      "The chat's contract test: recorded harness transcripts run through every stage to the rendered chat, against goldens.",
  },
  "frontend/test-kit": { purpose: "Fixtures and render helpers the UI's tests share." },
  "frontend/toolkit": {
    purpose:
      "Reusable controls, their recipes, class-name composition, the sidebar item and the Markdown every feature draws with.",
  },
  "frontend/items": {
    purpose:
      "The items package: the kinds of thing a terminal or a window shows, their store, taskbar, peek and bar drag, the plan editor, the companion pane beside a terminal and the window an item undocks into.",
    entries: [
      {
        file: "frontend/items/src/homes/terminal/TerminalCompanion.tsx",
        text: "export const TerminalCompanion",
      },
      { file: "frontend/items/src/drag-session.ts" },
    ],
  },
  "frontend/chat": {
    purpose:
      "The chat view: a conversation's blocks as a transcript, the requests an agent waits on, the composer, and the chat's own store and commands.",
    entries: [{ file: "frontend/chat/src/ChatView.tsx", text: "export const ChatView" }],
  },
  "frontend/demo-debug": {
    purpose: "The demo's debug panel and rehearsals, for the content preview and the specs.",
  },
  "apps/try": { purpose: "The visitor build of the demo, which the website embeds." },
  "apps/previews": { purpose: "The content preview: the demo with its debug panel." },
  "engines/whisper": {
    purpose:
      "Builds whisper.cpp into the downloadable voice engine and its engine.json, with the patches Novadeck applies.",
    entries: [{ file: "engines/whisper/index.js", text: "export const engineManifest" }],
  },
  "engines/ggml-build": {
    purpose: "The shared ggml build the engines use.",
    entries: [{ file: "engines/ggml-build/index.ts", text: "export const buildEngine" }],
  },
  "engines/murmur": {
    purpose:
      "Builds llama.cpp into the downloadable murmur engine and its engine.json, with the patches Novadeck applies.",
    entries: [{ file: "engines/murmur/index.js", text: "export const engineManifest" }],
    docs: ["docs/murmur.md"],
  },
}
