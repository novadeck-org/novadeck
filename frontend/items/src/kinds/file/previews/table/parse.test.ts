import { context, describe, expect, it } from "../../../../test"
import { delimiterOf, parseDelimited } from "./parse"

describe("reading delimited text", () => {
  it("splits records by line and fields by the delimiter", () => {
    expect(parseDelimited("a,b,c\n1,2,3", ",").records).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ])
  })

  it("keeps a quoted field's delimiters, line breaks and doubled quotes", () => {
    const { records, lines } = parseDelimited(
      'name,note\n"Smith, J","said ""hi""\nthen left"\nx,y',
      ",",
    )
    expect(records).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
      ["x", "y"],
    ])
    expect(lines).toEqual([0, 1, 3])
  })

  it("leaves out a byte-order mark, a trailing line break and blank lines", () => {
    expect(parseDelimited("﻿id,name\r\n1,Ann\r\n\r\n2,Bo\r\n", ",").records).toEqual([
      ["id", "name"],
      ["1", "Ann"],
      ["2", "Bo"],
    ])
  })

  it("keeps empty fields, a record's last one too", () => {
    expect(parseDelimited("a,,c,\n,,,", ",").records).toEqual([
      ["a", "", "c", ""],
      ["", "", "", ""],
    ])
  })

  context("where a file strays", () => {
    it("joins text after a closing quote to its field, and keeps a quote inside a bare one", () => {
      expect(parseDelimited('"a"b,c"d', ",").records).toEqual([["ab", 'c"d']])
    })

    it("closes a quote left open at the end, and says so", () => {
      const parsed = parseDelimited('id,text\n1,"cut sho', ",")
      expect(parsed.records).toEqual([
        ["id", "text"],
        ["1", "cut sho"],
      ])
      expect(parsed.open).toBe(true)
    })
  })
})

describe("a file's delimiter", () => {
  it("is a tab for TSV", () => {
    expect(delimiterOf("data/people.TSV", "a,b,c")).toBe("\t")
  })

  it("is what a CSV's first line holds most of, outside quotes", () => {
    expect(delimiterOf("a.csv", "id,name,city")).toBe(",")
    expect(delimiterOf("a.csv", 'id;name;"Smith, J"')).toBe(";")
    expect(delimiterOf("a.csv", "id\tname\tcity")).toBe("\t")
    expect(delimiterOf("a.csv", "single")).toBe(",")
  })
})
