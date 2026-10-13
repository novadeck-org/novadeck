// An update the desktop app tells of. `downloading`: one the app is downloading, `percent`
// (a whole number from 0 to 100) along, which turns `ready` once downloaded, or
// `available` should the download fail. `ready`: downloaded, and installed on a restart.
// `available`: a newer release the app can't install itself, which the person gets from
// its release page. `notes` are the release's notes as plain-text lines.
export type UpdateOffer = {
  readonly kind: "downloading" | "ready" | "available"
  readonly version: string
  readonly notes: readonly string[]
  // Set only for `downloading`.
  readonly percent?: number
  // When this copy first learned a newer release exists, as an ISO 8601 date-time, which
  // the host remembers across launches; only for a portable copy, and absent otherwise.
  readonly outdatedSince?: string
}

// Which releases the desktop app follows: stable ones, or every release as it is published.
export type UpdateChannel = "stable" | "early"

// What the person has been shown of an offer: its version and kind, so an update that
// turns from ready to available, which the person must now fetch by hand, tells again.
export const updateKey = ({ kind, version }: UpdateOffer): string => `${kind}:${version}`

// How far behind a portable copy may fall before its notice comes up at every launch.
export const staleAfterMs = 14 * 24 * 60 * 60 * 1000

// Whether this copy has known of a newer release for `staleAfterMs` or more at `now`. A
// missing, unreadable or future date is not stale.
export const offerStale = ({ outdatedSince }: UpdateOffer, now: number): boolean => {
  const since = outdatedSince === undefined ? Number.NaN : Date.parse(outdatedSince)
  return now - since >= staleAfterMs
}

// Whether a portable copy is asked at every launch for this offer: a release to fetch,
// and a stale one.
export const portableNagged = (offer: UpdateOffer, now: number): boolean =>
  offer.kind === "available" && offerStale(offer, now)

// Whether an offer's notice comes up as the offer is heard. A download never raises it:
// the notice comes when it turns `ready`. Nor does a download that failed, which turns
// `available` after `previous`, the offer heard before, was its `downloading`: the host
// tries it again, soon the first time and then with its checks, or, should Squirrel.Mac
// have failed to stage it, tells of it at the next launch; the chip shows it meanwhile. Otherwise it does once per version and
// kind (`seen` is what was shown last). A portable copy, which can't update itself, is
// asked again at every launch once its release is stale: `shownThisRun` is whether this
// run has shown the offer's notice already, so a repeated offer does not bring it back
// after Later.
export const noticeRaised = (
  offer: UpdateOffer,
  {
    previous,
    seen,
    portable,
    shownThisRun,
    now,
  }: {
    readonly previous: UpdateOffer | null
    readonly seen: string | null
    readonly portable: boolean
    readonly shownThisRun: boolean
    readonly now: number
  },
): boolean =>
  offer.kind !== "downloading" &&
  !(
    offer.kind === "available" &&
    previous?.kind === "downloading" &&
    previous.version === offer.version
  ) &&
  (updateKey(offer) !== seen || (portable && !shownThisRun && portableNagged(offer, now)))
