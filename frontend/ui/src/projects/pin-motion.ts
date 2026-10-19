// How long pins take to slide aside, settle or fade in, none for a person who asks for less
// motion, and how they ease.
export const slide = (): number =>
  matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180
export const ease = "cubic-bezier(0.16, 1, 0.3, 1)"
