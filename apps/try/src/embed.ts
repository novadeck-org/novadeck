// Framed in another page, as the website's hero frames it, the demo is addressed with
// `?embed` (see docs/development.md, "Visitor build"), and leaves the visitor strip and a
// phone's panel to that page. Opened on its own, as a copied frame address is, the page has
// no one around it to say the agents are simulated, so it shows both after all. The posters
// are the exception: they picture the hero's frame, opened alone at `?embed&still`.
export type Address = {
  readonly location: { readonly search: string }
  readonly parent: unknown
}

export const embeddedIn = (page: Address): boolean => {
  const params = new URLSearchParams(page.location.search)
  return params.has("embed") && (page.parent !== page || params.has("still"))
}
