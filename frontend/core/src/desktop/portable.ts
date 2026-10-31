// Whether the desktop app is a portable copy: one that runs from wherever it was put,
// never installs updates itself, and can install the app that does. `version` is this
// build's, for display and diagnostics; nothing compares it with an offer. `run` names this
// run of the app, new at each launch, so a window opened again within one run is not taken
// for a launch (see portable-card-raised.ts). The core can't import the protocol's wire
// contracts, so this mirrors its `PortableState`, which
// frontend/runner-adapter/src/desktop/app.test.ts checks it fits.
export type PortableState =
  | { readonly portable: false }
  | {
      readonly portable: true
      readonly version: string
      readonly run: string
      // How installing the app from this copy stands in this run; the desktop app owns it.
      readonly install: PortableInstall
      // Where the workspace is kept, as the person finds it in their file manager; absent
      // when the desktop app can't say.
      readonly dataFolder?: string
    }

// How installing the app from a portable copy stands in this run; mirrors the protocol's
// `PortableInstall`. `idle`: not asked yet. `downloading`: the installer is being fetched,
// `percent` along (only Windows reports this). `installing`: being put in place, with no
// size to tell. `installed`: in place; this copy keeps running and the installed one takes
// effect when the person next opens Novadeck. `newer`: an installed copy of this newer
// `version` was left alone, and takes effect the same way. `failed`: nothing was
// installed, for the short `reason` given; asking again starts over.
export type PortableInstall =
  | { readonly phase: "idle" }
  | { readonly phase: "downloading"; readonly percent: number }
  | { readonly phase: "installing" }
  | { readonly phase: "installed" }
  | { readonly phase: "newer"; readonly version: string }
  | { readonly phase: "failed"; readonly reason: string }
