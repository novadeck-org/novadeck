import { cssNames, folderOf, nameOf, typeOf } from "./refs.js"

// A web page, as the frame draws it: the page's text with what it names beside it put in, so
// the frame needs fetch nothing. Its stylesheets become `<style>`s (with their `@import`s and
// `url()`s resolved the same way), its pictures and fonts data addresses, and what could run or
// load by itself (scripts, frames, plugins, a base address, a refresh) is taken out. Written
// over the page's DOM, which a DOMParser makes without loading or running anything.

/** A file the page names, as the runner read it, by its name from the page's folder. */
export type PageFile = { readonly name: string; readonly bytes: Uint8Array<ArrayBuffer> }

// The pictures a page names by an attribute, as `[element, attribute]`; the media (`video`,
// `audio`) the frame's policy doesn't allow are left as they are.
const pictureAttributes = [
  ["img", "src"],
  ["source", "src"],
  ["input", "src"],
  ["video", "poster"],
  ["image", "href"],
  ["image", "xlink:href"],
] as const
const setAttributes = [
  ["img", "srcset"],
  ["source", "srcset"],
] as const

const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html")

const isStylesheetLink = (link: Element): boolean =>
  (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet")

// The candidates of a `srcset`: each an address and what follows it (its density or width).
const candidates = (set: string): { readonly address: string; readonly rest: string }[] =>
  set
    .split(/\s*,\s+/)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => {
      const space = candidate.search(/\s/)
      return space < 0
        ? { address: candidate, rest: "" }
        : { address: candidate.slice(0, space), rest: candidate.slice(space) }
    })

/** The names a page's text draws with beside it, each once. */
export const pageNames = (html: string): string[] => {
  const doc = parse(html)
  const names = new Set<string>()
  const add = (ref: string | null): void => {
    const name = ref === null ? undefined : nameOf("", ref)
    if (name !== undefined) names.add(name)
  }
  for (const link of doc.querySelectorAll("link[href]"))
    if (isStylesheetLink(link)) add(link.getAttribute("href"))
  for (const [element, attribute] of pictureAttributes)
    for (const each of doc.querySelectorAll(element)) add(each.getAttribute(attribute))
  for (const [element, attribute] of setAttributes)
    for (const each of doc.querySelectorAll(element))
      for (const { address } of candidates(each.getAttribute(attribute) ?? "")) add(address)
  for (const style of doc.querySelectorAll("style"))
    for (const name of cssNames(style.textContent ?? "", "")) names.add(name)
  for (const each of doc.querySelectorAll("[style]"))
    for (const name of cssNames(each.getAttribute("style") ?? "", "")) names.add(name)
  return [...names]
}

// How deep a stylesheet's `@import`s are followed.
const importDepth = 6

const base64 = (bytes: Uint8Array): string => {
  let text = ""
  for (let at = 0; at < bytes.length; at += 0x8000)
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(text)
}

const dataAddress = (file: PageFile): string =>
  `data:${typeOf(file.name)};base64,${base64(file.bytes)}`

type Files = ReadonlyMap<string, PageFile>

// A stylesheet with the files it names put in: its `@import`s as its imported text (inside the
// `@media` the import gives, if any), its `url()`s as data addresses. What it names that isn't
// there is left as it is, and loads nothing under the frame's policy.
const inlined = (css: string, folder: string, files: Files, seen: readonly string[]): string => {
  const imported = css.replace(
    /@import\s+(?:url\(\s*(['"]?)(.*?)\1\s*\)|(['"])(.*?)\3)\s*([^;]*);/gis,
    (
      _all,
      _quote: string,
      url: string | undefined,
      _other: string,
      text: string,
      media: string,
    ) => {
      const name = nameOf(folder, url ?? text)
      const file = name === undefined ? undefined : files.get(name)
      if (!name || !file || seen.includes(name) || seen.length >= importDepth) return ""
      const inner = inlined(new TextDecoder().decode(file.bytes), folderOf(name), files, [
        ...seen,
        name,
      ])
      return media.trim() === "" ? inner : `@media ${media.trim()} {${inner}}`
    },
  )
  return imported.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gis, (all, _quote: string, ref: string) => {
    const name = nameOf(folder, ref)
    const file = name === undefined ? undefined : files.get(name)
    return file ? `url("${dataAddress(file)}")` : all
  })
}

// What a page's own text carries that would run or load by itself.
const taken = "script, base, iframe, frame, frameset, object, embed, portal, meta[http-equiv]"

/**
 * The page's text, drawn from `html` with the files it names (`files`, by name from its folder)
 * put in. Its doctype stays, as a page without one is drawn in quirks mode.
 */
export const buildPage = (html: string, files: Files): string => {
  const doc = parse(html)
  for (const each of doc.querySelectorAll(taken)) each.remove()
  for (const link of doc.querySelectorAll("link")) {
    const name = isStylesheetLink(link) ? nameOf("", link.getAttribute("href") ?? "") : undefined
    const file = name === undefined ? undefined : files.get(name)
    if (!name || !file) {
      link.remove()
      continue
    }
    const style = doc.createElement("style")
    style.textContent = inlined(new TextDecoder().decode(file.bytes), folderOf(name), files, [name])
    const media = link.getAttribute("media")
    if (media !== null) style.setAttribute("media", media)
    link.replaceWith(style)
  }
  for (const style of doc.querySelectorAll("style"))
    if (style.textContent !== null) style.textContent = inlined(style.textContent, "", files, [])
  for (const each of doc.querySelectorAll("[style]"))
    each.setAttribute("style", inlined(each.getAttribute("style") ?? "", "", files, []))
  for (const [element, attribute] of pictureAttributes) {
    for (const each of doc.querySelectorAll(element)) {
      const name = nameOf("", each.getAttribute(attribute) ?? "")
      const file = name === undefined ? undefined : files.get(name)
      if (file) each.setAttribute(attribute, dataAddress(file))
    }
  }
  for (const [element, attribute] of setAttributes) {
    for (const each of doc.querySelectorAll(element)) {
      const set = each.getAttribute(attribute)
      if (set === null) continue
      each.setAttribute(
        attribute,
        candidates(set)
          .map(({ address, rest }) => {
            const name = nameOf("", address)
            const file = name === undefined ? undefined : files.get(name)
            return `${file ? dataAddress(file) : address}${rest}`
          })
          .join(", "),
      )
    }
  }
  return `${doc.doctype ? "<!doctype html>" : ""}${doc.documentElement.outerHTML}`
}
