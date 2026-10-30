import type { AnchorRef, RuntimeEdge, RuntimeNode } from "../src/atlas.ts"

type Curated<T> = Omit<T, "anchor" | "areas"> & { anchor: AnchorRef }

// What runs when Novadeck runs, and the channels between the pieces.
export const runtime: {
  nodes: Curated<RuntimeNode>[]
  edges: (Omit<RuntimeEdge, "anchor"> & { anchor: AnchorRef })[]
} = {
  nodes: [
    {
      id: "electron-main",
      title: "Electron main",
      kind: "process",
      summary:
        "The desktop app's main process (`@novadeck/desktop`): owns windows, the menu, notices and updates, and starts the runner in a utility process. It never touches a terminal itself.",
      anchor: { file: "apps/desktop/src/main/index.ts", text: "runner = startRunner({" },
      position: { x: 40, y: 300 },
    },
    {
      id: "preload",
      title: "Preload bridge",
      kind: "process",
      summary:
        "The sandboxed preload script of each window. It exposes `window.novadeck` through the context bridge and relays the runner's MessagePort to the page, which cannot cross the bridge.",
      anchor: {
        file: "apps/desktop/src/preload/index.ts",
        text: 'contextBridge.exposeInMainWorld("novadeck"',
      },
      position: { x: 40, y: 60 },
    },
    {
      id: "renderer",
      title: "Renderer (UI)",
      kind: "process",
      summary:
        "The React app in the window. It connects to the runner with the runner client, loads the workspace before rendering, and draws terminals with xterm.js.",
      anchor: {
        file: "frontend/runner-adapter/src/index.ts",
        text: "export const connectRunnerBackend",
      },
      position: { x: 420, y: 60 },
    },
    {
      id: "runner",
      title: "Runner",
      kind: "process",
      summary:
        "An Electron utility process that owns the shells, the SQLite workspace, the harnesses, agent messaging and the companion items, and serves the oRPC router to the UI.",
      anchor: {
        file: "apps/desktop/src/runner/index.ts",
        text: "const runner = createRunner({",
      },
      position: { x: 560, y: 300 },
    },
    {
      id: "relay",
      title: "Relay",
      kind: "binary",
      summary:
        "A small Rust binary an agent starts for Novadeck's MCP server and for every hook. It only carries lines to the runner of its terminal and the answers back.",
      anchor: { file: "backend/relay/src/main.rs", text: "fn main() -> ExitCode" },
      position: { x: 1050, y: 140 },
    },
    {
      id: "agent",
      title: "Agent harness",
      kind: "external",
      summary:
        "Claude Code, Codex or Antigravity, running inside a Novadeck terminal. Novadeck installs a plugin into it, whose hooks and MCP server both start the relay.",
      anchor: {
        file: "harnesses/claude/src/index.ts",
        text: 'path: join("novadeck", "hooks", "hooks.json")',
      },
      position: { x: 1050, y: 460 },
    },
    {
      id: "whisper",
      title: "Whisper engine",
      kind: "server",
      summary:
        "A downloaded whisper speech-to-text server for voice input. The runner starts it on a free loopback port and sends it audio over HTTP.",
      anchor: { file: "backend/runner/src/voice/service.ts", text: "export class Voice" },
      position: { x: 420, y: 640 },
    },
    {
      id: "murmur",
      title: "Murmur engine",
      kind: "server",
      summary:
        "A downloaded local-LLM server that writes terminal titles and summaries. The runner starts it on a free loopback port and calls its chat completions API.",
      anchor: { file: "backend/runner/src/murmur/service.ts", text: "export class Murmur" },
      position: { x: 760, y: 640 },
    },
    {
      id: "github",
      title: "GitHub Releases",
      kind: "external",
      summary:
        "Where updates and the engine archives come from: electron-updater checks the repository's releases, and the runner downloads the engines from the release of the running version.",
      anchor: {
        file: "apps/desktop/src/main/releases/repository.ts",
        text: "export const releaseDownloadsUrl",
      },
      position: { x: 40, y: 640 },
    },
  ],
  edges: [
    {
      id: "main-runner",
      from: "electron-main",
      to: "runner",
      channel: "Utility process + MessagePort",
      summary:
        "The desktop app forks the runner as a utility process with its database, relay and engine paths as arguments, then sends it commands (connect, persist, close) and one MessagePort per renderer connection.",
      anchor: { file: "apps/desktop/src/main/runner.ts", text: "utilityProcess.fork(" },
    },
    {
      id: "main-renderer",
      from: "electron-main",
      to: "renderer",
      channel: "BrowserWindow load",
      summary:
        "The desktop app opens the window, loading the packaged UI from disk or the Vite dev server, and hands the page a loopback API URL for the status endpoint.",
      anchor: { file: "apps/desktop/src/main/index.ts", text: "void window.loadFile(" },
    },
    {
      id: "preload-main",
      from: "preload",
      to: "electron-main",
      channel: "Electron IPC",
      summary:
        "The bridge's calls (runner port, directory picker, notices, appearance, update offers) travel as ipcRenderer messages that the main process checks against its own window.",
      anchor: { file: "apps/desktop/src/main/index.ts", text: "brokerPorts({" },
    },
    {
      id: "preload-renderer",
      from: "preload",
      to: "renderer",
      channel: "contextBridge",
      summary:
        "The page sees `window.novadeck`; the runner's MessagePort cannot cross the context bridge, so the preload re-posts it as a window message tagged with the request id.",
      anchor: {
        file: "apps/desktop/src/preload/index.ts",
        text: "requestRunner: relayPorts(",
      },
    },
    {
      id: "renderer-runner",
      from: "renderer",
      to: "runner",
      channel: "oRPC over MessagePort",
      summary:
        "Everything the UI does goes through the typed oRPC contract over a MessagePort; holding the port is the credential. A browser build (`pnpm dev:web`) reaches a standalone runner over an authenticated WebSocket instead.",
      anchor: {
        file: "contract/runner-client/src/desktop.ts",
        text: "export const desktop = (): Transport",
      },
    },
    {
      id: "runner-agent",
      from: "runner",
      to: "agent",
      channel: "PTY (node-pty)",
      summary:
        "The runner spawns each terminal's shell in a pseudo-terminal; the agent runs inside it. Keys, pasted text, doorbell rings and dialog answers are all written to the PTY, and its output is read back.",
      anchor: {
        file: "libraries/terminal/src/host/terminal.ts",
        text: "pty = spawnPty({ ...spec, ...options.pty })",
      },
    },
    {
      id: "agent-relay-mcp",
      from: "agent",
      to: "relay",
      channel: "MCP over stdio",
      summary:
        "The plugin's MCP server entry starts the relay; the agent speaks JSON-RPC to it over stdin and stdout, and the relay forwards the lines unchanged.",
      anchor: { file: "backend/relay/src/mcp.rs", text: "async fn carry(" },
    },
    {
      id: "agent-relay-hook",
      from: "agent",
      to: "relay",
      channel: "Hook command",
      summary:
        "The plugin registers every hook event as a command that runs the relay with the agent's payload on stdin; whatever the relay prints is the hook's answer to the agent.",
      anchor: {
        file: "backend/relay/src/hook.rs",
        text: "pub fn run(agent: &str, event: &str, config: &Config)",
      },
    },
    {
      id: "relay-runner",
      from: "relay",
      to: "runner",
      channel: "Socket / pipe, JSON lines",
      summary:
        "The relay connects to the endpoint named in NOVADECK_REPORT, identifies its terminal and token, and exchanges one JSON message per line with the runner's report server.",
      anchor: {
        file: "backend/relay/src/endpoint.rs",
        text: "pub async fn connect(endpoint: &str)",
      },
    },
    {
      id: "runner-whisper",
      from: "runner",
      to: "whisper",
      channel: "Loopback HTTP",
      summary:
        "The shared engine server spawns the engine on a free 127.0.0.1 port and posts audio to its /inference endpoint.",
      anchor: {
        file: "backend/runner/src/voice/engine.ts",
        text: 'this.server.request(running, "/inference"',
      },
    },
    {
      id: "runner-murmur",
      from: "runner",
      to: "murmur",
      channel: "Loopback HTTP",
      summary:
        "The same engine server spawns the llama.cpp-style server and posts chat completions requests to it to describe terminals.",
      anchor: { file: "backend/runner/src/murmur/service.ts", text: '"/v1/chat/completions"' },
    },
    {
      id: "main-github",
      from: "electron-main",
      to: "github",
      channel: "electron-updater (HTTPS)",
      summary:
        "A packaged build loads the electron-updater class for its kind (NSIS, Mac, AppImage) and checks the releases on a schedule.",
      anchor: {
        file: "apps/desktop/src/main/index.ts",
        text: 'await import("electron-updater")',
      },
    },
    {
      id: "runner-github",
      from: "runner",
      to: "github",
      channel: "HTTPS download",
      summary:
        "Installing voice or murmur downloads the engine archive from the running version's release, or from a folder or address an environment variable names.",
      anchor: { file: "backend/runner/src/engines/download.ts", text: "export const download" },
    },
  ],
}
