import { useEffect, useRef, type RefObject } from "react"

// Whether the component is still in the page, for what settles after it may have gone.
export const useMounted = (): RefObject<boolean> => {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}
