// What the libraries in the manifests are for, in the order the strip prefers them. A name ending in `/*` covers a scope
// (`@lezer/*`); the strip shows such a family as one chip. Dependencies with no entry
// still show, without a role.

// `lead` marks what defines a package's stack; the strip shows those first, even when
// the manifest lists them as dev dependencies (Electron, Tailwind, Vite).
export type Role = { role: string; category: Category; lead?: true }

// Shelves, in the order the strip shows them.
export const categories = [
  "Platform",
  "UI",
  "Canvas",
  "Terminal",
  "Editor",
  "RPC",
  "Server",
  "Storage",
  "Desktop",
  "Styling",
  "Build",
  "Test",
] as const
export type Category = (typeof categories)[number]

export const roles: Record<string, Role> = {
  electron: { role: "Desktop shell", category: "Desktop", lead: true },
  "node:sqlite": { role: "SQLite, built into Node", category: "Storage", lead: true },
  "node-pty": { role: "Pseudo-terminals for shells", category: "Terminal", lead: true },
  react: { role: "UI library", category: "UI", lead: true },
  "react-dom": { role: "React's DOM renderer", category: "UI" },
  "react-router": { role: "Routing", category: "UI" },
  "@ark-ui/react": {
    role: "Headless components: dialogs, menus, segments",
    category: "UI",
    lead: true,
  },
  "lucide-react": { role: "Icons", category: "UI" },
  allotment: { role: "Resizable split panes", category: "UI" },
  "@dnd-kit/*": { role: "Drag and drop", category: "UI" },
  "react-grid-layout": { role: "The Grid view's layout", category: "Canvas" },
  "@xyflow/react": { role: "The Canvas view's pan and zoom", category: "Canvas", lead: true },
  "@xterm/xterm": { role: "Terminal renderer", category: "Terminal", lead: true },
  "@xterm/headless": { role: "Terminal state without a screen", category: "Terminal", lead: true },
  "@xterm/*": { role: "xterm add-ons", category: "Terminal" },
  "@codemirror/*": { role: "Code and plan viewer", category: "Editor", lead: true },
  "@lezer/*": { role: "Syntax grammars for highlighting", category: "Editor" },
  "@orpc/*": { role: "Typed RPC between UI and runner", category: "RPC", lead: true },
  zod: { role: "Schemas for the contract", category: "RPC", lead: true },
  hono: { role: "HTTP server", category: "Server", lead: true },
  "@hono/node-server": { role: "Hono on Node", category: "Server" },
  ws: { role: "WebSocket server", category: "Server", lead: true },
  "electron-updater": { role: "Auto-update from GitHub releases", category: "Desktop", lead: true },
  "electron-builder": { role: "Installers", category: "Build" },
  "electron-vite": { role: "Builds the desktop app", category: "Build" },
  tailwindcss: { role: "Utility CSS", category: "Styling", lead: true },
  "@tailwindcss/vite": { role: "Tailwind in Vite", category: "Styling" },
  clsx: { role: "Class names", category: "Styling" },
  "tailwind-merge": { role: "Merging Tailwind classes", category: "Styling" },
  "@fontsource-variable/*": { role: "Bundled fonts", category: "Styling" },
  "@fontsource/*": { role: "Bundled fonts", category: "Styling" },
  vite: { role: "Dev server and bundler", category: "Build", lead: true },
  "@vitejs/plugin-react": { role: "React in Vite", category: "Build" },
  esbuild: { role: "Bundler", category: "Build" },
  typescript: { role: "Types", category: "Build" },
  tsx: { role: "Runs TypeScript directly", category: "Build" },
  concurrently: { role: "Runs dev processes together", category: "Build" },
  vitest: { role: "Tests", category: "Test" },
  "@vitest/*": { role: "Vitest add-ons", category: "Test" },
  "vitest-browser-react": { role: "React in browser tests", category: "Test" },
  playwright: { role: "Browser and app automation", category: "Test" },
  jsdom: { role: "A DOM for tests", category: "Test" },
  "fast-check": { role: "Property-based tests", category: "Test" },
  tokio: { role: "Async runtime (Rust)", category: "Platform", lead: true },
  serde_json: { role: "JSON (Rust)", category: "Platform" },
  libc: { role: "System calls (Rust)", category: "Platform" },
}

// Built-in modules worth showing, found by their imports since no manifest lists them.
export const builtins = ["node:sqlite"]
