import type { CheckoutState, CheckoutUpdate } from "@novadeck/core/files"
import { useCallback, useEffect, useRef, useState } from "react"

// How often the panel asks again how the checkout stands while it is shown: a fetch that moved
// it, or the person's own pull, shows within this.
export const checkoutPollMs = 20_000

// The project's own checkout against its remote's main, as the Files panel asks the backend.
export type Checkout = {
  readonly read: () => Promise<CheckoutState>
  readonly update: () => Promise<CheckoutUpdate>
}

// Follows the checkout while the panel shows: read when shown, when an agent's turn ends and
// every `checkoutPollMs`. `onMoved` is told when the backend moved the checkout, which changed
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
  const [refused, setRefused] = useState<string | undefined>()
  const moved = useRef<number | undefined>(undefined)
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
  const read = useCallback(async (): Promise<void> => {
    if (!checkout) return
    const next = await checkout.read().catch(() => undefined)
    if (!next || !alive.current) return
    setState((known) =>
      known &&
      known.moved === next.moved &&
      known.behind?.count === next.behind?.count &&
      known.behind?.remote === next.behind?.remote
        ? known
        : next,
    )
    if (moved.current !== undefined && moved.current !== next.moved) told.current()
    moved.current = next.moved
  }, [checkout])
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
    setRefused(undefined)
    checkout
      .update()
      .then((done) => {
        if (alive.current && !done.ok) setRefused(done.said)
      })
      .catch(() => alive.current && setRefused("Novadeck couldn't update it."))
      .finally(() => {
        if (alive.current) setUpdating(false)
        void read()
      })
  }, [checkout, updating, read])
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
