import type { ContextMenuAction, ContextMenuItem } from "@novadeck/toolkit/ContextMenu"
import type { PageMenu } from "@novadeck/viewers/browser"

import { describe, expect, it } from "../../test"
import { pageMenuItems, type PageMenuActions } from "./page-menu"

const nowhere: PageMenu = {
  x: 10,
  y: 20,
  selection: "",
  link: undefined,
  editable: false,
  can: { cut: false, copy: false, paste: false, selectAll: false },
}
const place = { url: "http://localhost:5173/work", back: true, forward: false }

// The menu's rows as labels, a hairline above a group as "—", and what each did when chosen.
const menuOf = (
  menu: Partial<PageMenu>,
  { live = true, leading = [] as ContextMenuItem[] } = {},
) => {
  const done: string[] = []
  const actions: PageMenuActions = {
    edit: (edit) => done.push(`edit ${edit}`),
    copy: (text) => done.push(`copy ${text}`),
    open: (url) => done.push(`open ${url}`),
  }
  const items = pageMenuItems({ menu: { ...nowhere, ...menu }, live, place, actions, leading })
  const rows = items.flatMap((item) => [
    ...("separated" in item && item.separated ? ["—"] : []),
    `${item.label}${"disabled" in item && item.disabled ? " (off)" : ""}`,
  ])
  const choose = (label: string) =>
    (items.find((item) => item.label === label) as ContextMenuAction).onSelect()
  return { rows, done, choose }
}

describe("a page's menu", () => {
  it("offers only opening the page in the person's browser on a blank spot", () => {
    const { rows, done, choose } = menuOf({})
    expect(rows).toEqual(["Open page in your browser"])
    choose("Open page in your browser")
    expect(done).toEqual([`open ${place.url}`])
  })

  it("copies what's selected, first", () => {
    const { rows, done, choose } = menuOf({
      selection: "some text",
      can: { ...nowhere.can, copy: true },
    })
    expect(rows.slice(0, 2)).toEqual(["Copy", "—"])
    choose("Copy")
    expect(done).toEqual(["edit copy"])
  })

  it("offers a field's edits, as the field can take them now", () => {
    const { rows, done, choose } = menuOf({
      editable: true,
      can: { cut: false, copy: false, paste: true, selectAll: true },
    })
    expect(rows.slice(0, 5)).toEqual(["Cut (off)", "Copy (off)", "Paste", "Select all", "—"])
    choose("Paste")
    choose("Select all")
    expect(done).toEqual(["edit paste", "edit selectAll"])
  })

  it("copies a link's address, or opens it in the person's browser", () => {
    const link = "https://example.com/docs"
    const { rows, done, choose } = menuOf({ link })
    expect(rows.slice(0, 3)).toEqual(["Copy link address", "Open link in your browser", "—"])
    choose("Copy link address")
    choose("Open link in your browser")
    expect(done).toEqual([`copy ${link}`, `open ${link}`])
  })

  it("copies a link that's no web page's, which the browser isn't to open", () => {
    expect(menuOf({ link: "mailto:me@example.com" }).rows.slice(0, 2)).toEqual([
      "Copy link address",
      "—",
    ])
  })

  it("offers only opening the page on a snapshot, which has no edits", () => {
    expect(menuOf({ selection: "text", editable: true }, { live: false }).rows).toEqual([
      "Open page in your browser",
    ])
  })

  it("puts what a later feature offers on the same spot first, as its own group", () => {
    const comment = { value: "comment", label: "Comment on this", onSelect: () => {} }
    expect(menuOf({}, { leading: [comment] }).rows).toEqual([
      "Comment on this",
      "—",
      "Open page in your browser",
    ])
  })
})
