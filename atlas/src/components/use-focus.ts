import { useEffect, useRef } from "react"
import { useLocation } from "react-router"

import { hashId } from "../links.ts"

// A row whose id matches the URL hash scrolls into view and reports `focused`. `visit` is
// the key of the navigation that named it, so a repeat visit to the same hash is told apart.
export const useFocus = <T extends HTMLElement = HTMLDivElement>(id: string) => {
  const { hash, key } = useLocation()
  const ref = useRef<T>(null)
  const focused = hashId(hash) === id
  const visit = focused ? key : null
  useEffect(() => {
    if (visit) ref.current?.scrollIntoView({ block: "center" })
  }, [visit])
  return { ref, focused, visit }
}
