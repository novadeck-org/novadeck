// Whether the desktop app runs inside Electron's security sandbox. When it doesn't, `fix`
// is the one command that lets it, run once and followed by a restart; empty where the
// app knows of none. The core can't import the protocol's wire contracts, so this mirrors its
// `SandboxState`, which frontend/runner-adapter/src/desktop/app.test.ts checks it fits.
export type SandboxState =
  | { readonly sandboxed: true }
  | { readonly sandboxed: false; readonly fix: string }

// The longest fix command the page shows; a longer one is not one command to run.
export const maxFixLength = 300
