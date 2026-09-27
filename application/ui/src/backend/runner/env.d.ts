// The runner a browser build connects to; the desktop app uses its own and ignores them.
interface ImportMetaEnv {
  readonly VITE_NOVADECK_RUNNER_URL?: string
  readonly VITE_NOVADECK_RUNNER_TOKEN?: string
}
