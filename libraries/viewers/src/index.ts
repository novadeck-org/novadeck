// The contract every viewer keeps. A viewer mounts into an element its host gives it,
// takes content, and keeps its own scroll and place: the host stores the viewer's state
// when it lets the viewer go, and hands it back to the next one it mounts for the same
// thing, so showing something again picks up where it was.

export { createKept, type Kept } from "./kept.js"

declare const opaque: unique symbol

/** What a viewer keeps of where it was, for its host to store and hand back. Opaque. */
export type ViewerState = { readonly [opaque]: true }

/** A place to jump to: a line by its number, or an offset into the text. */
export type Target = { readonly line: number } | { readonly offset: number }

export type Viewer<Content> = {
  /** An outside change to the content: scroll and place stay. */
  readonly update: (content: Content) => void
  readonly state: () => ViewerState
  readonly restore: (state: ViewerState) => void
  readonly jumpTo: (target: Target) => void
  readonly find?: (
    query: string,
    options?: { readonly backwards?: boolean },
  ) => { readonly matches: number; readonly current: number }
  readonly focus: () => void
  /** Takes everything the viewer added out of its element. */
  readonly destroy: () => void
}

/** What every viewer mounts with. */
export type MountOptions<Content> = {
  readonly content: Content
  /** The accessible name of what it shows. */
  readonly label: string
  /** Where an earlier viewer of the same thing was. */
  readonly saved?: ViewerState
}

/** Mounts a viewer: one of a kind may offer more than the contract, as an image's zoom. */
export type Mount<
  Content,
  Options = Record<never, never>,
  Kind extends Viewer<Content> = Viewer<Content>,
> = (element: HTMLElement, options: Options & MountOptions<Content>) => Kind
