import { nextLimitReset, noInbox } from "@novadeck/core/inbox"
import { activeProject } from "@novadeck/core/state"
import { useState } from "react"

import { nextStatusChange } from "../projects/project-status"
import { sameSessionMarks, sessionMarks, type SessionMark } from "../projects/session-marks"
import { unreadEnd } from "../terminals/unread-state"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useStoreSelector } from "./controller/useStoreSelector"
import { useMoveOn } from "./useTerminalMarks"

// The earlier of two times, either of which may be none.
const soonest = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b)

// The marks of the open project's sessions, by id, read as the project rows read theirs: the
// raw Inbox, the unread turns, and a clock that moves on as a limit resets or an agent's wait
// passes its grace.
export const useSessionMarks = (): Readonly<Record<string, SessionMark>> => {
  const { backend } = useWorkspaceServices()
  const unread = useUiState((state) => state.unread)
  const items = useStoreSelector((backend.inbox ?? noInbox).state, (state) => state.items)
  const [now, setNow] = useState(() => Date.now())
  const waitEndsAt = useWorkspaceState((workspace) =>
    nextStatusChange([activeProject(workspace)!], now),
  )
  useMoveOn(soonest(nextLimitReset(items, now), waitEndsAt), setNow)
  return useWorkspaceState(
    (workspace) =>
      sessionMarks(
        activeProject(workspace)!,
        (context, id) => unreadEnd(unread, context, id),
        items,
        now,
      ),
    sameSessionMarks,
  )
}
