import { describe, expect, it } from "vitest"

import { isHostname, parseRemote } from "./remote.js"

describe("parseRemote", () => {
  describe("https", () => {
    it("reads host and path, without .git", () => {
      expect(parseRemote("https://github.com/cli/cli.git")).toEqual({
        host: "github.com",
        path: ["cli", "cli"],
      })
      expect(parseRemote("https://github.com/cli/cli")).toEqual({
        host: "github.com",
        path: ["cli", "cli"],
      })
    })
    it("reads the user", () => {
      expect(parseRemote("https://me@github.com/cli/cli.git")).toEqual({
        host: "github.com",
        path: ["cli", "cli"],
        user: "me",
      })
    })
    it("drops a password and a port from the host", () => {
      expect(parseRemote("https://me:secret@ghe.example.com:8443/o/r.git")).toEqual({
        host: "ghe.example.com",
        path: ["o", "r"],
        user: "me",
      })
    })
    it("keeps GitLab subgroups", () => {
      expect(parseRemote("https://gitlab.com/a/b/c/d.git")?.path).toEqual(["a", "b", "c", "d"])
    })
    it("lowercases the host", () => {
      expect(parseRemote("https://GitHub.com/O/R")?.host).toBe("github.com")
    })
  })

  describe("ssh", () => {
    it("reads ssh:// with and without a port", () => {
      expect(parseRemote("ssh://git@github.com/o/r.git")).toEqual({
        host: "github.com",
        path: ["o", "r"],
        user: "git",
      })
      expect(parseRemote("ssh://git@git.example.com:2222/o/r.git")).toEqual({
        host: "git.example.com",
        path: ["o", "r"],
        user: "git",
      })
    })
    it("reads the scp form", () => {
      expect(parseRemote("git@github.com:o/r.git")).toEqual({
        host: "github.com",
        path: ["o", "r"],
        user: "git",
      })
      expect(parseRemote("git@gitlab.com:a/b/c/d.git")).toEqual({
        host: "gitlab.com",
        path: ["a", "b", "c", "d"],
        user: "git",
      })
      expect(parseRemote("host.example:o/r")).toEqual({ host: "host.example", path: ["o", "r"] })
      expect(parseRemote("git@host.example:/o/r.git")?.path).toEqual(["o", "r"])
    })
  })

  describe("Azure DevOps", () => {
    it("reads every form", () => {
      expect(parseRemote("https://dev.azure.com/org/proj/_git/repo")).toEqual({
        host: "dev.azure.com",
        path: ["org", "proj", "_git", "repo"],
      })
      expect(parseRemote("https://org@dev.azure.com/org/proj/_git/repo")?.user).toBe("org")
      expect(parseRemote("git@ssh.dev.azure.com:v3/org/proj/repo")).toEqual({
        host: "ssh.dev.azure.com",
        path: ["v3", "org", "proj", "repo"],
        user: "git",
      })
      expect(parseRemote("https://org.visualstudio.com/proj/_git/repo")?.host).toBe(
        "org.visualstudio.com",
      )
      expect(parseRemote("org@vs-ssh.visualstudio.com:v3/org/proj/repo")?.path).toEqual([
        "v3",
        "org",
        "proj",
        "repo",
      ])
    })
    it("decodes a project's spaces", () => {
      expect(parseRemote("https://dev.azure.com/org/My%20Project/_git/repo")?.path).toEqual([
        "org",
        "My Project",
        "_git",
        "repo",
      ])
    })
  })

  describe("what is not a remote", () => {
    it.each([
      "/home/me/repo",
      "./repo",
      "../repo",
      "~/repo",
      "C:\\repos\\repo",
      "C:/repos/repo",
      "file:///home/me/repo",
      "",
      "repo",
      "https://github.com/onlyone",
      "https://github.com/",
    ])("%s", (url) => {
      expect(parseRemote(url)).toBeUndefined()
    })
  })

  describe("a host that isn't a plain host name", () => {
    it("is no remote, so it never reaches a command line", () => {
      for (const url of [
        "git@evil;rm -rf ~:o/r.git",
        "git@$(touch x):o/r.git",
        "git@a`b`:o/r.git",
        "user@host name:o/r",
        "git@-lead.example.com:o/r",
      ])
        expect(parseRemote(url), url).toBeUndefined()
    })
    it("is told from one that is", () => {
      expect(isHostname("ghe.example.com")).toBe(true)
      expect(isHostname("localhost")).toBe(true)
      expect(isHostname("a;b")).toBe(false)
      expect(isHostname("")).toBe(false)
    })
  })
})
