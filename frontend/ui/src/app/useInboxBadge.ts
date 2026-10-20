import { noInbox } from "@novadeck/core/inbox"

import { inboxBadge, type BellBadge } from "../shell/inbox-badge"
import { useWorkspaceServices } from "./controller/context"
import { useStoreSelector } from "./controller/useStoreSelector"
import { shallowEqual } from "./selectors"

// The bell's badge alone, for the small components that draw it: they re-render only when
// the badge's count or tone does. It counts what in the Inbox isn't an update.
export const useInboxBadge = (): BellBadge | undefined =>
  useStoreSelector(
    (useWorkspaceServices().backend.inbox ?? noInbox).state,
    (state) => inboxBadge(state.items),
    shallowEqual,
  )
