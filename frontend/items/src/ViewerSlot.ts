import {
  createKept,
  type Kept,
  type Mount,
  type MountOptions,
  type Viewer,
  type ViewerState,
} from "@novadeck/viewers"
import { useViewer, type UsedViewer } from "@novadeck/viewers/react"

// The one way a registration shows content through a viewers mount (`mountImage`,
// `mountCode`, `mountBrowser`): the mount, the content and the item's id, and the viewer's
// place is kept by id, so a thing shown again, as a view switch or a tab Focus no longer
// keeps builds its viewer again, opens where it was. Each mount keeps its own store, of the
// last 24 places.
//
// The editor is the exception: `mountMarkdown` stays inside the lazily loaded plan editor,
// so CodeMirror stays out of the first chunk, and keeps its own store there.
const stores = new WeakMap<object, Kept<ViewerState>>()
const keptOf = (mount: object): Kept<ViewerState> => {
  const kept = stores.get(mount) ?? createKept<ViewerState>(24)
  stores.set(mount, kept)
  return kept
}

export const useViewerSlot = <Content, Options, Kind extends Viewer<Content> = Viewer<Content>>(
  mount: Mount<Content, Options, Kind>,
  options: Options & Omit<MountOptions<Content>, "saved"> & { readonly id: string },
): UsedViewer<Kind> => useViewer(mount, { ...options, kept: keptOf(mount) })
