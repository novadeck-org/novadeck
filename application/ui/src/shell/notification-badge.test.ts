import { describe, expect, it } from "vitest"

import type { Notification, NotificationKind } from "../notifications/notifications"
import { notificationBadge } from "./notification-badge"

const entry = (kind: NotificationKind, index = 0): Notification => ({
  kind,
  context: "project/session",
  projectId: "project",
  projectName: "Project",
  sessionId: "session",
  sessionName: "Session",
  terminalId: `t${index}`,
  terminalName: "Agent",
  status: "Asks a question",
})

describe("notificationBadge", () => {
  it("shows nothing while no terminal asks", () => {
    expect(notificationBadge([])).toBeUndefined()
  })

  it("counts what waits and says so in the bell's name", () => {
    expect(notificationBadge([entry("done"), entry("done", 1)])).toEqual({
      text: "2",
      label: "Notifications, 2 waiting",
      status: "done",
    })
  })

  it("takes the tone of the most pressing kind", () => {
    expect(notificationBadge([entry("done"), entry("failed", 1)])?.status).toBe("failed")
    expect(notificationBadge([entry("done"), entry("plan", 1)])?.status).toBe("attention")
    expect(notificationBadge([entry("permission"), entry("question", 1)])?.status).toBe("question")
  })

  it("caps the printed count at 9+ but keeps the full count in the name", () => {
    const list = Array.from({ length: 12 }, (_, index) => entry("done", index))
    expect(notificationBadge(list)).toMatchObject({
      text: "9+",
      label: "Notifications, 12 waiting",
    })
  })
})
