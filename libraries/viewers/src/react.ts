import { useLayoutEffect, useRef, useState } from "react"

import type { Kept, Mount, MountOptions, Viewer, ViewerState } from "./index.js"

// A viewer in React: the ref to put on the element it mounts into, and the viewer once
// it's mounted, for what its kind offers beyond the contract. It mounts once the
// element is there, again when the thing it shows (`id`) or its name changes, and passes
// each new content on as an update. Letting it go keeps its state in `kept` by `id`, so
// the next viewer of the same thing, after a remount or a tab switch, picks up where it
// was. The other options are read at mount.
export type UsedViewer<Kind> = {
  readonly ref: (element: HTMLElement | null) => void
  /** Null until it mounts, and after it goes. */
  readonly viewer: Kind | null
}

export const useViewer = <Content, Options, Kind extends Viewer<Content> = Viewer<Content>>(
  mount: Mount<Content, Options, Kind>,
  options: Options &
    Omit<MountOptions<Content>, "saved"> & {
      readonly id: string
      readonly kept: Kept<ViewerState>
    },
): UsedViewer<Kind> => {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [used, setUsed] = useState<Kind | null>(null)
  const latest = useRef(options)
  const viewer = useRef<Kind | null>(null)
  // The content the viewer has, so one it mounted with isn't passed again as an update.
  const shown = useRef<Content | null>(null)
  const { id, label, kept, content } = options
  // Before the mount below, which reads it: layout effects run in order.
  useLayoutEffect(() => {
    latest.current = options
  })
  // Before paint, so a restored place shows from the first frame.
  useLayoutEffect(() => {
    if (!element) return
    const saved = kept.get(id)
    const mounted = mount(element, {
      ...latest.current,
      label,
      ...(saved === undefined ? {} : { saved }),
    })
    viewer.current = mounted
    shown.current = latest.current.content
    setUsed(mounted)
    return () => {
      kept.keep(id, mounted.state())
      mounted.destroy()
      viewer.current = null
      setUsed(null)
    }
  }, [element, mount, id, label, kept])
  // In the same commit as the content, as a render would draw it.
  useLayoutEffect(() => {
    if (!viewer.current || shown.current === content) return
    shown.current = content
    viewer.current.update(content)
  }, [content])
  return { ref: setElement, viewer: used }
}
