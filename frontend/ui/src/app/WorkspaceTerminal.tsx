import { ChatView } from "@novadeck/chat/ChatView"
import { chatDraftOf, chatReplyOf, chatSendOf, chatShown } from "@novadeck/chat/state"
import { useChat } from "@novadeck/chat/use-chat"
import { agentStats } from "@novadeck/core/agents/stats"
import { ledTerminals, runningLeads, terminalOrigins } from "@novadeck/core/derivations"
import { isWindow } from "@novadeck/core/roster"
import type { CompanionWindowMeta, TerminalMetadata, Tile } from "@novadeck/core/types"
import { ProjectWindow } from "@novadeck/items/ProjectWindow"
import { TerminalCompanion } from "@novadeck/items/TerminalCompanion"
import { UndockedWindow } from "@novadeck/items/UndockedWindow"
import { memo, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react"

import { shortcutBindings } from "../interaction/shortcuts"
import { presentedProgram, terminalProfile, windowProfile } from "../terminals/processes/profiles"
import { renameView } from "../terminals/rename-state"
import { unreadEnd } from "../terminals/unread-state"
import { windowMenu } from "../terminals/window-menu"
import {
  WindowShell,
  type TerminalLayoutControls,
  type WindowShellProps,
} from "../terminals/WindowShell"
import { WindowStats } from "../terminals/WindowStats"
import { DictationStrip } from "../voice/DictationStrip"
import { useAskFeedback } from "./ask-feedback"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { DictationContext, useMicButton } from "./controller/dictation"
import { useDockTarget } from "./dock-target"
import { useMessageLinks } from "./message-links"
import { MountedTerminal } from "./MountedTerminal"
import { plainTitle } from "./murmur-offer"
import { NameChip } from "./NameChip"
import { useReleaseLead } from "./release-lead"
import {
  currentContext,
  currentState,
  currentTarget,
  sameTarget,
  shallowEqual,
  windowedDestination,
} from "./selectors"
import { useTerminalBar } from "./terminal-bar"
import { chatViewOn } from "./ui-store"
import { useTerminalMarks } from "./useTerminalMarks"

// What every window in the current view takes from the workspace, a terminal's or one
// undocked from a companion: its header, its menu, and the controls its layout offers.
const useWindowFrame = (
  tile: Tile,
  { onFlyTo, onResizePreset }: TerminalLayoutControls,
): Omit<WindowShellProps, "children" | "icon"> => {
  const { backend, commands } = useWorkspaceServices()
  const { setSelected, openWindowed, openFocus, close, startRename, openSwitcher } = commands
  const { resetTitle, changeRenameDraft, saveRename, cancelRename } = commands
  const id = tile.id
  const { context, view, windowedView, active, large } = useWorkspaceState((workspace) => {
    const state = currentState(workspace)
    return {
      context: currentContext(workspace),
      view: state.view,
      windowedView: state.windowedView,
      active: state.selected === id,
      large: state.view === "grid" && state.layout.sizePresets.grid[id] === "large",
    }
  }, shallowEqual)
  const { fresh, rename, enabledViews, unread } = useUiState(
    (state) => ({
      fresh: state.created?.context === context && state.created.id === id,
      rename: state.rename?.context === context && state.rename.id === id ? state.rename : null,
      enabledViews: state.preferences.enabledViews,
      unread: unreadEnd(state.unread, context, id),
    }),
    shallowEqual,
  )
  const target = useWorkspaceState(currentTarget, sameTarget)
  // What the raw Inbox says of it, not the landing rule's, which hides rows from its list only.
  const { need, subject, dialog } = useTerminalMarks(backend.inbox, {
    ...target,
    terminalId: id,
  })
  const compact = view !== "focus"
  const destination = windowedDestination(windowedView, enabledViews)
  const windowedLabel = destination === "canvas" ? "Canvas" : "Grid"
  const dockIn = useDockTarget(tile)
  const askFeedback = useAskFeedback(tile)
  const releaseLead = useReleaseLead(tile)
  return {
    terminal: tile,
    active,
    fresh,
    unread,
    need,
    needSubject: subject,
    needDialog: dialog,
    rename: renameView(rename),
    onBeginRename: () => startRename(tile, "header"),
    onRenameDraft: (draft) => changeRenameDraft(id, draft),
    onRenameSave: () => saveRename(id),
    onRenameCancel: () => cancelRename(id),
    menu: windowMenu({
      terminal: tile,
      onRename: () => startRename(tile, "header"),
      onResetTitle: backend.resetTitle ? () => resetTitle(id) : undefined,
      dockIn,
      askFeedback,
      releaseLead,
      onClose: () => close(id),
    }),
    compact,
    switcher: { onOpen: (button) => openSwitcher(id, button) },
    onClose: () => close(id),
    ...(onFlyTo ? { onFlyTo } : {}),
    ...(onResizePreset
      ? {
          onResizePreset: (button: HTMLButtonElement) => {
            setSelected(id)
            onResizePreset(button)
          },
        }
      : {}),
    large,
    ...(compact && enabledViews.includes("focus")
      ? { onFocus: () => openFocus(id) }
      : !compact && destination
        ? {
            windowed: {
              destination: windowedLabel,
              onOpen: () => openWindowed(id),
            },
          }
        : {}),
  }
}

// A window holding one companion item, in the same frame as a terminal's: one undocked from
// a terminal's companion, or the session's project window, by its home.
const WorkspaceWindow = memo(
  ({
    window,
    controls,
  }: {
    readonly window: CompanionWindowMeta
    readonly controls: TerminalLayoutControls
  }): React.JSX.Element => {
    const { itemStore } = useWorkspaceServices()
    const frame = useWindowFrame(window, controls)
    const target = useWorkspaceState(currentTarget, sameTarget)
    const item = useWorkspaceState((workspace) =>
      currentState(workspace).items.find((each) => each.id === window.itemId),
    )
    const { icon: Icon } = windowProfile(item)
    // What it shows, where a terminal's content would be.
    return (
      <WindowShell {...frame} icon={<Icon size={14} strokeWidth={1.5} />}>
        {itemStore &&
          (window.home === "project" ? (
            <ProjectWindow itemStore={itemStore} target={target} item={item} />
          ) : (
            <UndockedWindow itemStore={itemStore} target={target} item={item} />
          ))}
      </WindowShell>
    )
  },
)

// What the terminal's agent runs on, floating over its window. It subscribes to its own
// usage, so an agent's status-line tick renders this alone.
const TerminalStats = memo(
  ({
    context,
    terminalId,
  }: {
    readonly context: string
    readonly terminalId: string
  }): React.JSX.Element | null => {
    const { telemetry } = useWorkspaceServices().backend
    const usage = useMemo(
      () => telemetry.entry({ context, terminalId }),
      [telemetry, context, terminalId],
    )
    const stats = agentStats(useSyncExternalStore(usage.subscribe, usage.getSnapshot))
    return stats ? <WindowStats stats={stats} /> : null
  },
)

// One terminal in the current view: the backend's surface, which keeps its controller
// mounted while the shared window, and the body its program calls for, wrap its content.
export const WorkspaceTerminal = memo(
  ({
    terminal,
    controls,
  }: {
    readonly terminal: TerminalMetadata
    readonly controls: TerminalLayoutControls
  }): React.JSX.Element => {
    const { onReveal, onScreen = true } = controls
    const { backend, commands, itemStore, navigation, chat } = useWorkspaceServices()
    const { setKeyboardFocus } = commands
    const dictation = useContext(DictationContext)
    const terminalId = terminal.id
    // Each terminal selects only what concerns it, so a rename keystroke or a keyboard
    // focus change re-renders just the terminals involved.
    const { view, active } = useWorkspaceState((workspace) => {
      const state = currentState(workspace)
      return {
        view: state.view,
        active: state.selected === terminalId,
      }
    }, shallowEqual)
    const { projectId, workspaceSessionId } = useWorkspaceState(currentTarget, sameTarget)
    const chatContext = `${projectId}/${workspaceSessionId}`
    const terminalName = useWorkspaceState(terminalOrigins, shallowEqual)
    const lead = useWorkspaceState((workspace) => runningLeads(workspace)[terminalId], shallowEqual)
    const leads = useWorkspaceState(
      (workspace) => ledTerminals(workspace, terminalId),
      shallowEqual,
    )
    const { keyboardFocus } = useUiState(
      (state) => ({
        keyboardFocus:
          state.shell.keyboardFocus?.id === terminalId ? state.shell.keyboardFocus : null,
      }),
      shallowEqual,
    )
    // Surfaces may depend on these in effects, so keep them stable across renders.
    const terminalKey = useMemo(
      () => ({ projectId, workspaceSessionId, terminalId }),
      [projectId, workspaceSessionId, terminalId],
    )
    const messageLinks = useMessageLinks()
    const onInputFocused = useCallback(() => setKeyboardFocus(null), [setKeyboardFocus])
    const { bar, items, fresh } = useTerminalBar(terminalId)
    const { icon: Icon, Body } = terminalProfile(terminal)
    const processWindow = presentedProgram(terminal)
    const mic = useMicButton(terminal, terminalKey)
    const frame: Omit<WindowShellProps, "children"> = {
      ...useWindowFrame(terminal, controls),
      ...(lead ? { lead } : {}),
      ...(leads ? { leads } : {}),
      ...(mic ? { dictation: mic } : {}),
      ...(terminal.state === "running" && terminal.agent && plainTitle(terminal)
        ? { titleExtra: <NameChip terminalId={terminalId} context={chatContext} /> }
        : {}),
      icon: <Icon size={14} strokeWidth={1.5} />,
      ...(processWindow ? { processWindow } : {}),
    }
    // The chat is drawn over the content, which stays mounted at its size, so the terminal
    // keeps its dimensions and its emulator its state. The content is inert beneath, where
    // neither focus nor typing can reach it, and the chat's box takes keyboard focus.
    const conversations = backend.conversations
    // A terminal whose agent has a conversation to show, with the chat view on (an
    // experimental feature), on a backend that reads it.
    const chatView = useUiState(chatViewOn)
    const showChat = useChat(
      chat,
      (state) =>
        conversations !== undefined && chatShown(chatView, state.answering, chatContext, terminal),
    )
    const draft = useChat(chat, (state) => chatDraftOf(state.drafts, chatContext, terminalId))
    const replyTo = useChat(chat, (state) => chatReplyOf(state.replies, chatContext, terminalId))
    const sending = useChat(chat, (state) => chatSendOf(state.sends, chatContext, terminalId))
    const conversation = useMemo(
      () => (showChat ? conversations?.conversation(terminalKey) : undefined),
      [showChat, conversations, terminalKey],
    )
    // Keyboard focus waits for the node to be on screen: its input is in a subtree a
    // Canvas node out of sight hides, and a request spent there would be lost. The request
    // stays until the surface can take it.
    const wanted = keyboardFocus?.view === view && active && onScreen
    const withChat = (content: ReactNode): ReactNode =>
      conversations ? (
        <div className="chat-host relative flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Before the content, so the first terminal input in the window is the chat's. */}
          {conversation && (
            <div
              className="chat-pane absolute inset-0 z-10 nodrag nopan nowheel"
              data-workspace-chat=""
            >
              <ChatView
                conversation={conversation}
                terminalName={terminal.name}
                program={terminal.process}
                agent={terminal.state === "running" ? terminal.agent : undefined}
                compact={view !== "focus"}
                draft={draft}
                onDraft={(text) => commands.setChatDraft(terminalId, text)}
                replyTo={replyTo}
                onReplyTo={(to) => commands.setChatReply(chatContext, terminalId, to)}
                sending={sending}
                onSend={(text, to) => commands.sendChat(terminalKey, text, to)}
                onInterrupt={async () => {
                  const returned = await conversations!.interrupt(terminalKey)
                  // Words queued behind the stopped turn come back to the box, to send again.
                  if (returned) commands.appendChatDraft(chatContext, terminalId, returned)
                }}
                onAnswer={(request, answer) => conversations!.answer(terminalKey, request, answer)}
                onWordsLost={(words) => commands.appendChatDraft(chatContext, terminalId, words)}
                onAnswerInTerminal={() => commands.showTerminal(terminalId)}
                focusInput={wanted}
                onInputFocused={onInputFocused}
                refused={conversations!.refused}
              />
            </div>
          )}
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            aria-hidden={showChat || undefined}
            inert={showChat}
          >
            {content}
          </div>
        </div>
      ) : (
        content
      )
    // The terminal's content, with what its agent runs on floating over its top right while
    // the terminal shows, not its chat, and voice input's strip along an edge while it
    // dictates into the terminal. The host is there whatever runs, so the content never
    // remounts as an agent starts.
    const hosted = (content: ReactNode): ReactNode => (
      <div className="terminal-host relative flex min-h-0 min-w-0 flex-1 flex-col">
        {Body ? <Body>{content}</Body> : content}
        {!showChat && terminal.state === "running" && (
          <TerminalStats context={chatContext} terminalId={terminalId} />
        )}
        {dictation && (
          <DictationStrip
            controller={dictation}
            terminalKey={terminalKey}
            edge={showChat ? "top" : "bottom"}
            stopKeys={shortcutBindings().voice.display}
            onSetup={() => navigation.go({ dialog: "preferences", section: "addons" })}
          />
        )}
      </div>
    )
    // One shell element whatever runs, so only the body around the content changes.
    const renderWindow = (surface: ReactNode): ReactNode => {
      const content = withChat(surface)
      return (
        <WindowShell {...frame}>
          {itemStore ? (
            <TerminalCompanion
              itemStore={itemStore}
              messages={backend.messages}
              links={messageLinks}
              companionKey={terminalKey}
              view={view}
              onReveal={onReveal}
              bar={bar}
              items={items}
              fresh={fresh}
              terminalName={(id) => terminalName[id]}
              commands={commands}
            >
              {hosted(content)}
            </TerminalCompanion>
          ) : (
            hosted(content)
          )}
        </WindowShell>
      )
    }
    return (
      <MountedTerminal
        mountTerminal={backend.mountTerminal}
        terminalKey={terminalKey}
        terminal={terminal}
        view={view}
        focusInput={wanted && !showChat}
        onInputFocused={onInputFocused}
        onScreen={onScreen}
        renderWindow={renderWindow}
      />
    )
  },
)

// Layouts call this for each terminal and window they place.
export const renderTerminal = (tile: Tile, controls: TerminalLayoutControls): React.JSX.Element =>
  isWindow(tile) ? (
    <WorkspaceWindow key={tile.id} window={tile} controls={controls} />
  ) : (
    <WorkspaceTerminal key={tile.id} terminal={tile} controls={controls} />
  )
