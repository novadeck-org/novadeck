// The browser emulator: xterm's terminal in a view, and the pool that draws it with WebGL.
export { createView } from "./view.js"
export type { View, ViewLinks, ViewOptions, ViewRenderer } from "./view.js"
export { createRenderers, loadWebgl, webglRenderers } from "./renderer.js"
export type { Drawing, PoolStats, RendererDeps, Renderers, ScreenRenderer } from "./renderer.js"
export type { IDisposable, ITheme, Terminal } from "@xterm/xterm"
