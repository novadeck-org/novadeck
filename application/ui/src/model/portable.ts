// Whether the desktop app is a portable copy: one that runs from wherever it was put,
// never installs updates itself, and can install the app that does. `version` is this
// build's, for display and diagnostics; nothing compares it with an offer. `run` names this
// run of the app, new at each launch, so a window opened again within one run is not taken
// for a launch (see backend/portable-card-raised.ts). The model
// layer can't import the protocol, so this mirrors its `PortableState`, which
// backend/runner/desktop-host.test.ts checks it fits.
export type PortableState =
  | { readonly portable: false }
  | {
      readonly portable: true
      readonly version: string
      readonly run: string
      // Whether this run already installed the app, so a window opened again shows it done.
      readonly installed: boolean
    }

// How installing from a portable copy went; mirrors the protocol's `InstallResult`.
// `installed`: the installed copy is in place; this copy keeps running, and the installed
// one takes effect when the person next opens Novadeck. `newer`: an installed
// copy of this `version`, newer than this one, was left alone, and also takes effect when
// the person next opens Novadeck. `failed`: nothing was
// installed, for the short `reason` given.
export type InstallResult =
  | { readonly kind: "installed" }
  | { readonly kind: "newer"; readonly version: string }
  | { readonly kind: "failed"; readonly reason: string }

// How far an install under way has got; mirrors the protocol's `InstallProgress`. Only some
// hosts report a download, with its whole `percent`; `installing` has no size to tell.
export type InstallProgress =
  | { readonly phase: "downloading"; readonly percent: number }
  | { readonly phase: "installing" }

// The longest reason the page shows; the host's are a short line.
export const maxReasonLength = 200
