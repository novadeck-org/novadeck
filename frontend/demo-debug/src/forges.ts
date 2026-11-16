import type { PullRequest } from "@novadeck/core/forges"
import type { Backend } from "@novadeck/core/port"
import { isDemoForges, type ForgesScenario } from "@novadeck/demo/forges"
import { isDemoWorks, type DemoWorks } from "@novadeck/demo/works"

import type { DemoLaunch } from "./debug-demo"
import { pageUpdateChannel } from "./desktop/updates"
import type { DemoAction, DemoActionContext, DemoActionGroup } from "./types"
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
    hint: "Open Worktrees: the row has no #812 at its detail line's end, and its work's changes item no PR #812 link",
  },
  {
    label: "Pull request: draft",
    state: "draft",
    hint: "Open Worktrees: the row's detail line ends in a muted dashed glyph and #812, a link Tab reaches; select the row to open its changes item, whose header has PR #812 to open in the browser",
  },
  {
    label: "Pull request: open",
    state: "open",
    hint: "Open Worktrees: the row's detail line ends in #812 in the text color; its changes item's header has PR #812",
  },
  {
    label: "Pull request: merged",
    state: "merged",
    hint: "Open Worktrees: the row's #812 has a merge glyph, while the row's own merged icon follows git as before",
  },
  {
    label: "Pull request: closed",
    state: "closed",
    hint: "Open Worktrees: the row's #812 has a closed glyph, muted",
  },
]

// How a pull request's checks stand, set on the selected terminal's work: an open pull request
// is made where it had none.
const checks: readonly {
  readonly label: string
  readonly ci: NonNullable<PullRequest["ci"]>
  readonly hint: string
}[] = [
  {
    label: "CI failing",
    ci: "failing",
    hint: "Open Worktrees: the selected row's pull request #812 (made open where it had none) shows its checks failing, in the failing color",
  },
  {
    label: "CI running",
    ci: "running",
    hint: "Open Worktrees: the selected row's pull request #812 (made open where it had none) shows its checks running",
  },
  {
    label: "CI passed",
    ci: "passed",
    hint: "Open Worktrees: the selected row's pull request #812 (made open where it had none) shows its checks passed",
  },
  {
    label: "No CI",
    ci: "none",
    hint: "Open Worktrees: the selected row's pull request #812 (made open where it had none) shows no checks, as one that ran none does",
  },
]

// The selected terminal's work, else the first of its project, else one made now.
const target = (demo: DemoWorks, { selected, workspace }: DemoActionContext) => {
  const key = selected()
  if (!key) return undefined
  if (!demo.ownedBy(key.terminalId) && demo.worksOf(key.projectId).length === 0)
    demo.openClean(placed(workspace(), key))
  return demo.ownedBy(key.terminalId) ?? demo.worksOf(key.projectId)[0]
}

// The panel's group for the forge integrations: Preferences' section and the Worktrees rows' pull
// request marks. Nothing for a backend whose forges and works aren't the demo's.
export const forgesGroups = (
  launch: DemoLaunch,
  backend: Pick<Backend, "forges" | "works">,
): readonly DemoActionGroup[] => {
  const { forges, works } = backend
  const control = isDemoForges(forges) ? forges : undefined
  const marks: readonly DemoAction[] = isDemoWorks(works)
    ? [
        ...states.map(({ label, state, hint }) => ({
          label,
          hint,
          run: (context: DemoActionContext) => {
            const own = target(works, context)
            if (own) works.setPullRequest(own.root, state)
          },
        })),
        ...checks.map(({ label, ci, hint }) => ({
          label,
          hint,
          run: (context: DemoActionContext) => {
            const own = target(works, context)
            if (own) works.setCi(own.root, ci)
          },
        })),
      ]
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
