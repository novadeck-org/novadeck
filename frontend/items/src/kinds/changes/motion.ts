// The move between the files and a file: the row grows into the heading, and the heading
// shrinks back into its row. Web animations on the elements themselves, a plain cut under
// reduced motion (and in a page without them).

const duration = 280
const easing = "cubic-bezier(0.2, 0.7, 0.2, 1)"

export const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

const canAnimate = (element: Element): boolean =>
  typeof element.animate === "function" && !reducedMotion()

/** The heading starts where the row was and grows into place; what is under it rises after. */
export const growHeading = (view: HTMLElement, head: HTMLElement, from: DOMRect): void => {
  if (!canAnimate(head)) return
  const to = head.getBoundingClientRect()
  head.animate(
    [
      {
        transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`,
        width: `${from.width}px`,
        height: `${from.height}px`,
        opacity: 0.9,
      },
      { transform: "none", width: `${to.width}px`, height: `${to.height}px`, opacity: 1 },
    ],
    { duration, easing },
  )
  for (const part of view.querySelectorAll(".changes-summary, .changes-body"))
    part.animate(
      [
        { opacity: 0, transform: "translateY(10px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration, delay: duration * 0.45, easing, fill: "backwards" },
    )
}

/** The heading shrinks onto its row; resolves once the view can go. */
export const shrinkHeading = (view: HTMLElement, head: HTMLElement, to: DOMRect): Promise<void> => {
  if (!canAnimate(head)) return Promise.resolve()
  const from = head.getBoundingClientRect()
  for (const part of view.querySelectorAll(".changes-summary, .changes-body"))
    part.animate([{ opacity: 1 }, { opacity: 0 }], { duration: duration * 0.5, fill: "forwards" })
  return head
    .animate(
      [
        { transform: "none", opacity: 1 },
        {
          transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`,
          opacity: 0.2,
        },
      ],
      { duration, easing, fill: "forwards" },
    )
    .finished.then(
      () => {},
      () => {},
    )
}

/** The files fade in as the heading shrinks onto its row, and the row flashes once it lands. */
export const returnFiles = (files: HTMLElement, row: HTMLElement | null): void => {
  if (!canAnimate(files)) return
  files.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration,
    delay: duration * 0.3,
    easing,
    fill: "backwards",
  })
  row?.animate(
    [
      { background: "color-mix(in srgb, var(--color-strong) 22%, transparent)" },
      { background: "transparent" },
    ],
    { duration: 900, delay: duration },
  )
}

export const motionMs = duration

/** Where each file's row or heading in view is, by its path: what an expand or a collapse
 * starts from. */
export const placesIn = (scroller: HTMLElement, selector: string): Map<string, DOMRect> => {
  const box = scroller.getBoundingClientRect()
  const places = new Map<string, DOMRect>()
  for (const element of scroller.querySelectorAll<HTMLElement>(selector)) {
    const rect = element.getBoundingClientRect()
    const path = element.closest<HTMLElement>("[data-path]")?.dataset.path
    if (path !== undefined && rect.bottom > box.top && rect.top < box.bottom) places.set(path, rect)
  }
  return places
}

// Past this many in view, the rest come in together.
const mostStaggered = 8
const stagger = 18

/** The tree bursts into the files' diffs: each heading in view starts where its row was (or, a
 * row not drawn, a little above), and what is under it rises after. */
export const expandFrom = (scroller: HTMLElement, from: ReadonlyMap<string, DOMRect>): void => {
  if (!canAnimate(scroller)) return
  const box = scroller.getBoundingClientRect()
  let order = 0
  for (const section of scroller.querySelectorAll<HTMLElement>(".changes-stack-file")) {
    const head = section.querySelector<HTMLElement>(".changes-head")
    if (!head) continue
    const to = head.getBoundingClientRect()
    if (to.top >= box.bottom) break
    if (section.getBoundingClientRect().bottom <= box.top) continue
    const was = from.get(section.dataset.path ?? "")
    const delay = Math.min(order++, mostStaggered) * stagger
    head.animate(
      was
        ? [
            {
              transform: `translate(${was.left - to.left}px, ${was.top - to.top}px)`,
              opacity: 0.9,
            },
            { transform: "none", opacity: 1 },
          ]
        : [
            { transform: "translateY(-8px)", opacity: 0 },
            { transform: "none", opacity: 1 },
          ],
      { duration, delay, easing, fill: "backwards" },
    )
    for (const part of section.querySelectorAll(".changes-summary, .changes-stack-body"))
      part.animate(
        [
          { opacity: 0, transform: "translateY(10px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration, delay: delay + duration * 0.45, easing, fill: "backwards" },
      )
  }
}

/** The diffs fold back into the tree: each row in view starts where its heading was, the
 * others fade in. */
export const collapseFrom = (scroller: HTMLElement, from: ReadonlyMap<string, DOMRect>): void => {
  if (!canAnimate(scroller)) return
  const box = scroller.getBoundingClientRect()
  let order = 0
  for (const row of scroller.querySelectorAll<HTMLElement>(".files-row")) {
    const to = row.getBoundingClientRect()
    if (to.top >= box.bottom) break
    if (to.bottom <= box.top) continue
    const was = row.dataset.path === undefined ? undefined : from.get(row.dataset.path)
    const delay = Math.min(order++, mostStaggered) * stagger
    row.animate(
      was
        ? [
            { transform: `translateY(${was.top - to.top}px)`, opacity: 0.6 },
            { transform: "none", opacity: 1 },
          ]
        : [{ opacity: 0 }, { opacity: 1 }],
      { duration, delay, easing, fill: "backwards" },
    )
  }
}
