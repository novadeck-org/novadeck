import type { PullRequest } from "@novadeck/core/forges"
import type { Backend } from "@novadeck/core/port"
import { isDemoForges, type ForgesScenario } from "@novadeck/demo/forges"
import { isDemoWorks } from "@novadeck/demo/works"

import type { DemoLaunch } from "./debug-demo"
import { pageUpdateChannel } from "./desktop/updates"
import type { DemoAction, DemoActionGroup } from "./types"
import { placed } from "./works"

const where = "Preferences > Experimental > Forge integrations"

// One action per state the forges' rows can be in, each moving the demo's forges to it.
const scenarios: readonly {
  readonly label: string
  readonly scenario: ForgesScenario
  readonly hint: string
}[] = [
  {
    label: "GitHub signed in, GitLab signed out",
    scenario: "start",
    hint: `${where}: GitHub on, github.com Signed in; GitLab on, gitlab.com Signed out with a Sign in button; Azure DevOps not installed, with Install and its command (the state the demo starts in)`,
  },
  {
    label: "All signed in",
    scenario: "signed-in",
    hint: `${where}: the three forges on, each host Signed in, no buttons`,
  },
  {
    label: "All signed out",
    scenario: "signed-out",
    hint: `${where}: the three forges on, each host Signed out with a Sign in button; Sign in closes Preferences and runs the command in a terminal, and when it ends the host reads Signed in`,
  },
  {
    label: "CLI missing",
    scenario: "missing",
    hint: `${where}: GitHub reads Not installed. Needs gh with a disabled switch; GitLab and Azure DevOps offer Install with their command, which runs in a terminal, then the forge's switch appears`,
  },
  {
    label: "Token refused",
    scenario: "refused",
    hint: `${where}: the three forges on, each host reads Token refused with the command that mends it shown under it`,
  },
  {
    label: "Token refused, nothing to run",
    scenario: "refused-unmendable",
    hint: `${where}: GitHub's host reads Token refused with its command; GitLab's and Azure DevOps' read Token refused with no command, as their tools name none`,
  },
  {
    label: "Several hosts",
    scenario: "several-hosts",
    hint: `${where}: GitHub on with two hosts, github.com Signed in and github.example.com Signed out with a Sign in button; the others off`,
  },
  {
    label: "On, CLI since uninstalled",
    scenario: "on-but-missing",
    hint: `${where}: the three forges switched on but their tools gone: each row reads not installed, with Install where there is an installer, and lists no hosts`,
  },
  {
    label: "Switch under way",
    scenario: "busy",
    hint: `${where}: GitHub's switch is pending and its note reads Switching off…; the others are off`,
  },
  {
    label: "Switch failed",
    scenario: "error",
    hint: `${where}: GitHub is off and its note, in red, says gh could not read its token`,
  },
]

const states: readonly {
  readonly label: string
  readonly state: PullRequest["state"] | undefined
  readonly hint: string
}[] = [
  {
    label: "No pull request",
    state: undefined,
    hint: "Open Changes: the row's pull request mark is gone",
  },
  {
    label: "Pull request: draft",
    state: "draft",
    hint: "Open Changes: the row has a muted Draft #812 mark on its own line under the row's detail; click it to open the page, Tab reaches it",
  },
  {
    label: "Pull request: open",
    state: "open",
    hint: "Open Changes: the row's mark reads Open #812 in the text color",
  },
  {
    label: "Pull request: merged",
    state: "merged",
    hint: "Open Changes: the row's mark reads Merged #812 in green, while the row's own merged icon follows git as before",
  },
  {
    label: "Pull request: closed",
    state: "closed",
    hint: "Open Changes: the row's mark reads Closed #812 in red",
  },
]

// The panel's group for the forge integrations: Preferences' section and the Changes rows' pull
// request marks. Nothing for a backend whose forges and works aren't the demo's.
export const forgesGroups = (
  launch: DemoLaunch,
  backend: Pick<Backend, "forges" | "works">,
): readonly DemoActionGroup[] => {
  const { forges, works } = backend
  const control = isDemoForges(forges) ? forges : undefined
  const marks: readonly DemoAction[] = isDemoWorks(works)
    ? states.map(({ label, state, hint }) => ({
        label,
        hint,
        run: ({ selected, workspace }) => {
          const key = selected()
          if (!key) return
          // The selected terminal's work, else the first of its project, else one made now.
          if (!works.ownedBy(key.terminalId) && works.worksOf(key.projectId).length === 0)
            works.openClean(placed(workspace(), key))
          const own = works.ownedBy(key.terminalId) ?? works.worksOf(key.projectId)[0]
          if (own) works.setPullRequest(own.root, state)
        },
      }))
    : []
  return [
    {
      section: "App",
      title: "Forges",
      actions: [
        {
          label: "Offered, experimental channel",
          hint: `Boots on the experimental channel with forge integrations offered: ${where} shows the three forges as the demo starts`,
          reboots: true,
          run: () => {
            pageUpdateChannel.channel = "experimental"
            launch.setForges(true)
          },
        },
        {
          label: "Not offered",
          hint: `${where} has no section, as on a runner without forges (needs the experimental channel to see the tab)`,
          reboots: true,
          run: () => launch.setForges(false),
        },
        ...(control
          ? scenarios.map(({ label, scenario, hint }): DemoAction => ({
              label,
              hint,
              run: () => control.scenario(scenario),
            }))
          : []),
        ...marks,
      ],
    },
  ]
}
