import type { UpdateOffer, WhatsNew } from "@novadeck/core/desktop/update"
import { useCallback, useEffect, useRef, useState } from "react"

// How long the card's automatic raise waits for the host's notes: the host's own read gives
// up after about this long, so a later answer would be none anyway.
export const newsWaitMs = 10_000

type Heard = {
  readonly version: string
  readonly news: WhatsNew | undefined
  // Whether the first answer for this version came, or the wait ran out.
  readonly settled: boolean
}

// What is new in the release a portable copy is offered, asked of the host when an offer
// shows up and gone with it. `news` is undefined where the host has none to tell, can't, or
// told those of another version. `settled` says the first answer for the offer is in (or
// none is coming: no host that tells, no offer, the wait over), so the card can hold its
// first automatic raise for it. A host answers undefined too for a failure that may pass, so
// `askAgain` asks once more, for the same version, while no notes are held and no ask is
// out; the card calls it each time it comes up.
export const useOfferNews = (
  ask: (() => Promise<WhatsNew | undefined>) | undefined,
  offer: UpdateOffer | null,
): {
  readonly news: WhatsNew | undefined
  readonly settled: boolean
  readonly askAgain: () => void
} => {
  const version = offer?.kind === "available" ? offer.version : undefined
  const [heard, setHeard] = useState<Heard | undefined>()
  // The offer being asked about, and the ask out for it, for answers to find out they are late.
  const current = useRef<string | undefined>(undefined)
  const asking = useRef<string | undefined>(undefined)
  const held = useRef(false)
  const latest = useRef(ask)
  useEffect(() => {
    latest.current = ask
  })
  const run = useCallback((): void => {
    const question = latest.current
    const wanted = current.current
    if (!question || wanted === undefined || held.current || asking.current === wanted) return
    asking.current = wanted
    const answer = (news: WhatsNew | undefined): void => {
      if (asking.current === wanted) asking.current = undefined
      if (current.current !== wanted) return
      const fits = news?.version === wanted ? news : undefined
      held.current = fits !== undefined
      setHeard({ version: wanted, news: fits, settled: true })
    }
    question().then(answer, () => answer(undefined))
  }, [])
  useEffect(() => {
    current.current = version
    asking.current = undefined
    held.current = false
    if (!ask || version === undefined) return undefined
    run()
    const timer = setTimeout(
      () =>
        setHeard((was) =>
          was?.version === version ? was : { version, news: undefined, settled: true },
        ),
      newsWaitMs,
    )
    return () => {
      clearTimeout(timer)
      current.current = undefined
    }
  }, [ask, version, run])
  const mine = heard?.version === version ? heard : undefined
  return {
    news: mine?.news,
    settled: !ask || version === undefined || mine?.settled === true,
    askAgain: run,
  }
}
