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
  for (const part of view.querySelectorAll(".changes-summary, .changes-body, .changes-hint"))
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
  for (const part of view.querySelectorAll(".changes-summary, .changes-body, .changes-hint"))
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
