import {
  accountUsage,
  sameAccounts,
  type AgentAccount,
  type AgentSeat,
} from "@novadeck/core/account-usage"
import type { Store } from "@novadeck/core/store"
import type { Telemetry } from "@novadeck/core/telemetry"
import { useCallback } from "react"

import { useStoreSelector } from "./useStoreSelector"

// The footer's subscriptions, worked out from what the running agents report: a new list
// only when what it shows changed, so a report that moves only a context leaves it be.
export const useAccounts = (
  telemetry: Store<Telemetry>,
  seats: readonly AgentSeat[],
  now: number,
  order: readonly string[],
): readonly AgentAccount[] =>
  useStoreSelector(
    telemetry,
    useCallback((held: Telemetry) => accountUsage(seats, held, now, order), [seats, now, order]),
    sameAccounts,
  )
