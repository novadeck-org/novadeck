import type { CheckoutState, CheckoutUpdate } from "@novadeck/core/files"
import { useCallback, useEffect, useRef, useState } from "react"

// How often the panel asks again how the checkout stands while it is shown: a fetch that moved
// it, or the person's own pull or commit (the commit it is at changes), shows within this.
export const checkoutPollMs = 20_000

// The project's own checkout against its remote's main, as the Files panel asks the backend.
export type Checkout = {
  readonly read: () => Promise<CheckoutState>
  readonly update: () => Promise<CheckoutUpdate>
}

// Follows the checkout while the panel shows: read when shown, when an agent's turn ends and
// every `checkoutPollMs`, one read at a time (a big repository's can take long). `onMoved` is
// told when the backend moved the checkout or the commit it is at changed, which may have changed
// the files on disk: the panel reads its folders again. Reads that fail change nothing.
export const useCheckout = (
  checkout: Checkout | undefined,
  showing: boolean,
  turn: number,
  onMoved: () => void,
): {
  readonly state: CheckoutState | undefined
  readonly updating: boolean
  // Why the last update was refused, until the next one.
  readonly refused: string | undefined
  readonly update: () => void
} => {
  const [state, setState] = useState<CheckoutState | undefined>()
  const [updating, setUpdating] = useState(false)
  // Why the last update was refused, with the commit the checkout was at: another commit, or
  // nothing to update any more, and it no longer stands.
  const [refusal, setRefusal] = useState<{ readonly said: string; readonly head: string | null }>()
  const seen = useRef<{ readonly moved: number; readonly head: string | null } | undefined>(
    undefined,
  )
  const reading = useRef(false)
  // Asked for again while a read was out: it runs once more as that lands.
  const again = useRef(false)
  const alive = useRef(true)
  const told = useRef(onMoved)
  useEffect(() => {
    told.current = onMoved
  })
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  // One read, its answer taken in.
  const take = useCallback(async (from: Checkout): Promise<void> => {
    const next = await from.read().catch(() => undefined)
    if (!next || !alive.current) return
    setState((known) =>
      known &&
      known.moved === next.moved &&
      known.behind?.count === next.behind?.count &&
      known.behind?.remote === next.behind?.remote &&
      known.head === next.head
        ? known
        : next,
    )
    const before = seen.current
    if (before && (before.moved !== next.moved || before.head !== next.head)) told.current()
    seen.current = { moved: next.moved, head: next.head }
  }, [])
  const read = useCallback(
    async (queue = false): Promise<void> => {
      if (!checkout) return
      if (reading.current) {
        if (queue) again.current = true
        return
      }
      reading.current = true
      // Once, and again while it was asked for meanwhile (an update landed).
      do {
        again.current = false
        // eslint-disable-next-line no-await-in-loop -- One read at a time.
        await take(checkout)
      } while (again.current && alive.current)
      reading.current = false
    },
    [checkout, take],
  )
  useEffect(() => {
    if (!showing || !checkout) return
    void read()
    const timer = setInterval(() => void read(), checkoutPollMs)
    return () => clearInterval(timer)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A turn's end reads it again.
  }, [showing, checkout, turn, read])
  const update = useCallback((): void => {
    if (!checkout || updating) return
    setUpdating(true)
    setRefusal(undefined)
    checkout
      .update()
      .then((done) => {
        if (alive.current && !done.ok) setRefusal({ said: done.said, head: state?.head ?? null })
      })
      .catch(
        () =>
          alive.current &&
          setRefusal({ said: "Novadeck couldn't update it.", head: state?.head ?? null }),
      )
      .finally(() => {
        if (alive.current) setUpdating(false)
        void read(true)
      })
  }, [checkout, updating, read, state])
  const refused = state?.behind && refusal?.head === state.head ? refusal.said : undefined
  return { state, updating, refused, update }
}

// The panel's line when the checkout is on main, behind its remote and Novadeck left it alone
// (changes of its own, or an operation half done): how far behind, and Update.
export const CheckoutLine = ({
  state,
  updating,
  refused,
  onUpdate,
}: {
  state: CheckoutState
  updating: boolean
  refused: string | undefined
  onUpdate: () => void
}): React.JSX.Element | null => {
  const { behind } = state
  if (!behind) return null
  return (
    <div className="files-behind" data-refused={refused !== undefined || undefined}>
      <span className="min-w-0 truncate" title={refused}>
        {refused !== undefined
          ? `Can't update: ${refused}`
          : `${behind.branch} is ${behind.count} behind ${behind.remote.split("/")[0]}`}
      </span>
      <button type="button" className="files-update" disabled={updating} onClick={onUpdate}>
        {updating ? "Updating…" : refused !== undefined ? "Retry" : "Update"}
      </button>
    </div>
  )
}
