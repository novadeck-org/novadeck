import { useEffect, useRef, type RefObject } from "react"

// A local submit acknowledgement, independent of transcript rows and transport timing.
export const useTransmitPulse = (input: RefObject<HTMLTextAreaElement | null>): (() => void) => {
  const running = useRef<Animation[]>([])
  useEffect(() => {
    const cancel = (): void => {
      running.current.forEach((animation) => animation.cancel())
      running.current = []
    }
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)")
    preference?.addEventListener("change", cancel)
    return () => {
      preference?.removeEventListener("change", cancel)
      cancel()
    }
  }, [])
  return () => {
    running.current.forEach((animation) => animation.cancel())
    running.current = []
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    const composer = input.current?.closest(".chat-composer")
    const beam = composer?.querySelector<HTMLElement>(".chat-transmit-beam")
    const mark = composer?.querySelector<HTMLElement>(".chat-composer-box > .chat-mark")
    if (!beam || !mark || typeof beam.animate !== "function") return
    running.current = [
      beam.animate(
        [
          { transform: "translateX(-100%)", opacity: 0 },
          { opacity: 1, offset: 0.12 },
          { opacity: 1, offset: 0.8 },
          { transform: "translateX(360%)", opacity: 0 },
        ],
        { duration: 180, easing: "linear" },
      ),
      mark.animate(
        [
          { boxShadow: "0 0 0 transparent", filter: "brightness(1)" },
          {
            boxShadow: `0 0 8px ${getComputedStyle(mark).color}`,
            filter: "brightness(1.6)",
            offset: 0.25,
          },
          { boxShadow: "0 0 0 transparent", filter: "brightness(1)" },
        ],
        { duration: 180, easing: "ease-out" },
      ),
    ]
  }
}
