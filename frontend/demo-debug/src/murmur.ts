import type { DemoMurmur } from "@novadeck/demo/addons/murmur"

import type { DemoActionGroup } from "./types"

// The panel's Murmur group: the states of Murmur's one-time offer (a chip beside a terminal's
// title, with its popover), of its install in the footer (a ring and "Murmur 42%", with a
// sheet), and of Preferences' Addons card. The chip also comes up on its own at the next agent
// finish (Agent › Completes) while Murmur is not installed, once per page load.
export const murmurGroups = (murmur: DemoMurmur | undefined): readonly DemoActionGroup[] =>
  murmur
    ? [
        {
          section: "App",
          title: "Murmur",
          actions: [
            {
              label: "Installed",
              hint: "On, Runs on Intel Arc Graphics; no chip, nothing in the footer",
              run: () => murmur.show("installed"),
            },
            {
              label: "Not installed",
              hint: "Addons shows Install; the chip comes up at the next agent finish, once per page load",
              run: () => murmur.show("uninstalled"),
            },
            {
              label: "Offer the chip now",
              hint: "Not installed; the chip sits beside the selected terminal's title, which must be a running agent still under its plain name (icon alone in a narrow Grid tile or window); click it for the popover with No thanks and Turn on",
              run: () => murmur.show("offer"),
            },
            {
              label: "Installing",
              hint: "Footer: ring and Murmur 63%; click it for the step, the bar and Cancel. Addons shows the same",
              run: () => murmur.show("installing"),
            },
            {
              label: "Checking this computer",
              hint: "Footer: a turning ring and Murmur, no percent; the sheet's bar moves with no end",
              run: () => murmur.show("checking"),
            },
            {
              label: "Install done",
              hint: "Footer: checking, then Terminals name themselves now for a few seconds, then it leaves",
              run: () => murmur.show("done"),
            },
            {
              label: "Install fails (network)",
              hint: "Footer item turns danger and its sheet opens once, with Try again and Not now (hides it, no decline)",
              run: () => murmur.show("network-failure"),
            },
            {
              label: "Install ends Not available",
              hint: "Footer: checking, then its sheet says Not available on this computer, with Details; the item leaves with it",
              run: () => murmur.show("unavailable-after-check"),
            },
            {
              label: "Next install ends Not available",
              hint: "Not installed; the next Turn on or Install ends in Not available",
              run: () => murmur.show("unsupported-after-install"),
            },
            {
              label: "Not available",
              hint: "Addons shows Not available on this computer, with Details and Check again; no chip",
              run: () => murmur.show("unsupported"),
            },
            {
              label: "Not available, files left",
              hint: "Addons shows Not available with Details and Check again beside Uninstall, no switch",
              run: () => murmur.show("unsupported-with-files"),
            },
            {
              label: "Not available (software rendering)",
              hint: "As Not available, from the app: Details has the reason, no Check again",
              run: () => murmur.show("unsupported-app"),
            },
          ],
        },
      ]
    : []
