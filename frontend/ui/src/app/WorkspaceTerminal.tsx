import {
  chatAttachmentsOf,
  chatAvailable,
  chatDraftOf,
  chatImageNoteOf,
  chatReplyOf,
  chatSendsOf,
  chatShellsOf,
  chatShown,
} from "@novadeck/chat/state"
import { useBoxHandover } from "@novadeck/chat/use-box-handover"
import { useChat } from "@novadeck/chat/use-chat"
import { agentStats } from "@novadeck/core/agents/stats"
import { noConversation, type ChatImage } from "@novadeck/core/conversation"
import {
  critterLive,
  ledTerminals,
  runningLeads,
  terminalOrigins,
} from "@novadeck/core/derivations"
import { isWindow } from "@novadeck/core/roster"
import { createStore } from "@novadeck/core/store"
import type { CompanionWindowMeta, TerminalMetadata, Tile } from "@novadeck/core/types"
import { Avatar } from "@novadeck/items/Avatar"
import { ProjectWindow } from "@novadeck/items/ProjectWindow"
import { useShellTails } from "@novadeck/items/shells"
import { TerminalCompanion } from "@novadeck/items/TerminalCompanion"
import { UndockedWindow } from "@novadeck/items/UndockedWindow"
import {
  memo,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react"

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
import { useChatTakesFocus } from "./chat-focus"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { DictationContext, useMicButton } from "./controller/dictation"
import { useDockTarget } from "./dock-target"
import { closeTip } from "./history-drops"
import { useMessageLinks } from "./message-links"
import { MountedTerminal } from "./MountedTerminal"
import { useMoveTo } from "./move-to"
import { plainTitle } from "./murmur-offer"
import { NameChip } from "./NameChip"
import { ChatWithPeers } from "./peer-looks"
import { useReleaseLead } from "./release-lead"
import {
  currentContext,
  currentState,
  currentTarget,
  sameTarget,
  shallowEqual,
  windowedDestination,
} from "./selectors"
import { useFoldTeam } from "./team-fold"
import { useTerminalBar } from "./terminal-bar"
import { agentAvatarsOn, chatViewOn } from "./ui-store"
import { useTerminalMarks } from "./useTerminalMarks"

const noChatConversation = createStore(noConversation)

// What every window in the current view takes from the workspace, a terminal's or one
// undocked from a companion: its header, its menu, and the controls its layout offers.
const useWindowFrame = (
  tile: Tile,
  { onFlyTo }: TerminalLayoutControls,
): Omit<WindowShellProps, "children" | "icon"> => {
  const { backend, commands } = useWorkspaceServices()
  const { openWindowed, openFocus, close, startRename, openSwitcher } = commands
  const { resetTitle, changeRenameDraft, saveRename, cancelRename } = commands
  const id = tile.id
  const { context, view, windowedView, active } = useWorkspaceState((workspace) => {
    const state = currentState(workspace)
    return {
      context: currentContext(workspace),
      view: state.view,
      windowedView: state.windowedView,
      active: state.selected === id,
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
  const { need, subject, dialog, snoozed, snoozedRequests } = useTerminalMarks(backend.inbox, {
    ...target,
    terminalId: id,
  })
  const compact = view !== "focus"
  const destination = windowedDestination(windowedView, enabledViews)
  const windowedLabel = destination === "canvas" ? "Canvas" : "Grid"
  const dockIn = useDockTarget(tile)
  const askFeedback = useAskFeedback(tile)
  const releaseLead = useReleaseLead(tile)
  const foldTeam = useFoldTeam(tile)
  const moveTo = useMoveTo(tile)
  return {
    terminal: tile,
    active,
    fresh,
    unread,
    need,
    needSubject: subject,
    needDialog: dialog,
    needSnoozed: snoozed,
    needSnoozedRequests: snoozedRequests,
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
      foldTeam,
      moveTo,
      onClose: () => close(id),
    }),
    compact,
    switcher: { onOpen: (button) => openSwitcher(id, button) },
    onClose: () => close(id),
    closeTip: closeTip(backend, tile),
    ...(onFlyTo ? { onFlyTo } : {}),
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
    const { onScreen = true, legible = true } = controls
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
    const { icon: Icon } = terminalProfile(terminal)
    // Agent avatars (experimental): the handle's critter in the program's place.
    const avatar = useUiState(agentAvatarsOn) ? terminal.handle : undefined
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
      icon: avatar ? (
        <Avatar handle={avatar} live={critterLive(terminal)} size={24} />
      ) : (
        <Icon size={14} strokeWidth={1.5} />
      ),
      ...(processWindow ? { processWindow } : {}),
    }
    // Chat is drawn over the mounted content, whose hidden terminal gets extra height for
    // dialogs while keeping its width and emulator state. The content is inert beneath, where
    // neither focus nor typing can reach it, and the chat's box takes keyboard focus.
    const conversations = backend.conversations
    // A terminal whose agent has a conversation to show, with the chat view on (an
    // experimental feature), on a backend that reads it.
    const chatView = useUiState(chatViewOn)
    // Listen before showing chat: an agent without reported activity can still have a
    // bound conversation. A program name or an empty, loaded transcript alone is no session.
    const available = chatView && chatAvailable(terminal)
    const candidate = useMemo(
      () => (available ? conversations?.conversation(terminalKey) : undefined),
      [available, conversations, terminalKey],
    )
    const observed =
      terminal.state === "running" && terminal.agent === undefined
        ? (candidate ?? noChatConversation)
        : noChatConversation
    const boundSnapshot = useCallback(() => {
      const { agent, session } = observed.getSnapshot()
      return agent === terminal.process && session !== null
    }, [observed, terminal.process])
    const boundSession = useSyncExternalStore(observed.subscribe, boundSnapshot, boundSnapshot)
    const showChat = useChat(
      chat,
      (state) =>
        conversations !== undefined &&
        chatShown(chatView, state.answering, chatContext, terminal, boundSession),
    )
    const draft = useChat(chat, (state) => chatDraftOf(state.drafts, chatContext, terminalId))
    const replyTo = useChat(chat, (state) => chatReplyOf(state.replies, chatContext, terminalId))
    const sending = useChat(chat, (state) => chatSendsOf(state.sends, chatContext, terminalId))
    const attachments = useChat(chat, (state) =>
      chatAttachmentsOf(state.attachments, chatContext, terminalId),
    )
    const imageNote = useChat(chat, (state) =>
      chatImageNoteOf(state.imageNotes, chatContext, terminalId),
    )
    const shells = useChat(chat, (state) => chatShellsOf(state.shells, chatContext, terminalId))
    const conversation = showChat ? candidate : undefined
    // The terminal's shells item, whose pane the chat's shell lines open, and whose output
    // gives each its last line.
    const shellsItem = items.find((item) => item.kind === "shells")
    const shellTarget = useMemo(
      () => ({ projectId, workspaceSessionId }),
      [projectId, workspaceSessionId],
    )
    const agentShells = terminal.state === "running" ? terminal.agent?.shells : undefined
    const shellTails = useShellTails(
      itemStore,
      shellTarget,
      shellsItem,
      conversation !== undefined && (agentShells?.length ?? 0) > 0,
    )
    // Stable while the terminal and the backend are: a new one would draw every thumbnail again.
    const onImage = useMemo(
      () =>
        conversations?.image
          ? (image: ChatImage) => conversations.image!(terminalKey, image)
          : undefined,
      [conversations, terminalKey],
    )
    // A shell line of the chat opens the shells item at that shell, bringing it back to the bar
    // if the person had hidden it. Without the item or its store the lines only stand there.
    const onOpenShell = useMemo(
      () =>
        itemStore && shellsItem
          ? (shellId: string) => {
              itemStore.unfold(shellsItem.id, shellId)
              commands.openBarTab(terminalId, shellsItem.id)
            }
          : undefined,
      [itemStore, shellsItem, commands, terminalId],
    )
    useBoxHandover(conversation, {
      take: (ahead) => commands.takeBox(terminalKey, { ahead }),
      put: () => void commands.putDraft(terminalKey),
      draft,
    })
    // Keyboard focus waits for the node to be on screen: its input is in a subtree a
    // Canvas node out of sight hides, and a request spent there would be lost. The request
    // stays until the surface can take it.
    // Failed shells offer to tell the agent, drafting into the chat's box: only where it shows.
    const tell = useMemo(
      () =>
        conversation !== undefined
          ? (words: string) => commands.appendChatDraft(chatContext, terminalId, words)
          : undefined,
      [conversation, commands, chatContext, terminalId],
    )
    const wanted = keyboardFocus?.view === view && active && onScreen
    const chatHost = useRef<HTMLDivElement>(null)
    useChatTakesFocus(chatHost, conversation !== undefined, active && onScreen)
    const withChat = (content: ReactNode): ReactNode =>
      conversations ? (
        <div
          ref={chatHost}
          className="chat-host relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          {/* Before the content, so the first terminal input in the window is the chat's. */}
          {conversation && (
            <div
              className="chat-pane absolute inset-0 z-10 nodrag nopan nowheel"
              data-workspace-chat=""
            >
              <ChatWithPeers
                conversation={conversation}
                terminalName={terminal.name}
                program={terminal.process}
                agent={terminal.state === "running" ? terminal.agent : undefined}
                compact={view !== "focus"}
                links={messageLinks}
                draft={draft}
                onDraft={(text) => commands.setChatDraft(terminalId, text)}
                replyTo={replyTo}
                onReplyTo={(to) => commands.setChatReply(chatContext, terminalId, to)}
                sending={sending}
                shells={shells}
                shellTails={shellTails}
                onOpenShell={onOpenShell}
                attachments={attachments}
                imageNote={imageNote}
                onRestore={(words, images) =>
                  commands.restoreChat(chatContext, terminalId, words, images)
                }
                onAttach={
                  conversations!.uploadImage
                    ? (files, selection) => commands.attachChatImages(terminalKey, files, selection)
                    : undefined
                }
                onDetach={(id) => commands.removeChatImage(chatContext, terminalId, id)}
                onImage={onImage}
                onSend={(text, to, images) => commands.sendChat(terminalKey, text, to, images)}
                // Words queued behind the stopped turn, the agent's and the chat's, come back
                // to the box, to send again.
                onInterrupt={() => commands.stopChat(terminalKey)}
                onClearBox={(seen) => commands.clearBox(terminalKey, seen)}
                onAnswer={(request, answer) => conversations!.answer(terminalKey, request, answer)}
                onWordsLost={(words) => commands.appendChatDraft(chatContext, terminalId, words)}
                onAnswerInTerminal={() => commands.showTerminal(terminalId)}
                focusInput={wanted}
                onInputFocused={onInputFocused}
                refused={conversations!.refused}
                onPassing={(state) => commands.setChatPassing(terminalId, state)}
                onLeftMenu={() => commands.setChatDraft(terminalId, "", chatContext)}
                onKeys={conversations!.keys && ((keys) => conversations!.keys!(terminalKey, keys))}
              />
            </div>
          )}
          {/* Keep the emulator's high-z-index scrollbar beneath the chat overlay. */}
          <div
            className="chat-terminal isolate flex min-w-0 flex-1 flex-col"
            aria-hidden={showChat || undefined}
            inert={showChat}
          >
            {content}
          </div>
        </div>
      ) : (
        content
      )
    // The terminal's content, with what its agent runs on floating over its top right, over the
    // chat as over the screen, and voice input's strip along an edge while it
    // dictates into the terminal. The host is there whatever runs, so the content never
    // remounts as an agent starts.
    const hosted = (content: ReactNode): ReactNode => (
      <div className="terminal-host relative flex min-h-0 min-w-0 flex-1 flex-col">
        {content}
        {terminal.state === "running" && (
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
    // One shell element and one content whatever runs, so a program starting or ending
    // changes only the header and the marks.
    const renderWindow = (surface: ReactNode): ReactNode => {
      const content = withChat(surface)
      return (
        <WindowShell {...frame}>
          {itemStore ? (
            <TerminalCompanion
              itemStore={itemStore}
              messages={backend.messages}
              links={messageLinks}
              terminalKey={terminalKey}
              view={view}
              bar={bar}
              items={items}
              fresh={fresh}
              terminalName={(id) => terminalName[id]}
              commands={commands}
              shells={agentShells}
              tell={tell}
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
        legible={legible}
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
