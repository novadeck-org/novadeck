// An update the desktop app tells of. `ready`: downloaded, and installed on a restart.
// `available`: a newer release the app can't install itself, which the person gets from
// its release page. `notes` are the release's notes as plain-text lines.
export type UpdateOffer = {
  readonly kind: "ready" | "available"
  readonly version: string
  readonly notes: readonly string[]
}

// Which releases the desktop app follows: stable ones, or every release as it is published.
export type UpdateChannel = "stable" | "early"

// What the person has been shown of an offer: its version and kind, so an update that
// turns from ready to available, which the person must now fetch by hand, tells again.
export const updateKey = ({ kind, version }: UpdateOffer): string => `${kind}:${version}`
