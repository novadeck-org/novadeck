// Whether the desktop app is a portable copy: one that runs from wherever it was put,
// never installs updates itself, and can install the app that does. `version` is this
// build's, for display and diagnostics; nothing compares it with an offer. The model
// layer can't import the protocol, so this mirrors its `PortableState`, which
// backend/runner/desktop-host.test.ts checks it fits.
export type PortableState =
  | { readonly portable: false }
  | { readonly portable: true; readonly version: string }

// How installing from a portable copy went; mirrors the protocol's `InstallResult`.
// `installing`: the app is about to restart into the installed copy. `newer`: an installed
// copy of this `version`, newer than this one, was left alone. `failed`: nothing was
// installed, for the short `reason` given.
export type InstallResult =
  | { readonly kind: "installing" }
  | { readonly kind: "newer"; readonly version: string }
  | { readonly kind: "failed"; readonly reason: string }

// The longest reason the page shows; the host's are a short line.
export const maxReasonLength = 200
