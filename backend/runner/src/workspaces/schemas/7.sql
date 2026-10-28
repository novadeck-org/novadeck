-- The workspace schema at version 7, as that version's runner created it (sqlite3 .schema),
-- for store.test.ts to carry forward. Never edit it: a later version gets a file of its own.
CREATE TABLE projects (
    position INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
    cwd TEXT NOT NULL CHECK(length(cwd) > 0)
  ) STRICT;
CREATE TABLE sessions (
    position INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
    -- Opaque client state, such as a UI layout; null until the first save.
    client_state TEXT,
    -- When the person last visited it, in epoch milliseconds; null until they first do.
    visited_at REAL
  ) STRICT;
CREATE INDEX sessions_project ON sessions(project_id);
CREATE TABLE terminals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    -- Its handle in its session, a word such as moth, given once (see session_handles).
    handle TEXT NOT NULL,
    -- The shell's last reported directory.
    cwd TEXT NOT NULL,
    -- The latest session each agent reported, as JSON: { "claude": { sessionId, seq } }.
    agent_reports TEXT NOT NULL,
    -- When the shell last showed its prompt, in epoch milliseconds.
    prompted_at REAL,
    -- The screen and scrollback, serialized; null when not kept.
    transcript TEXT,
    saved_at REAL NOT NULL,
    -- The title the person gave it; null when its title is automatic.
    person_title TEXT,
    -- The title the agent that opened it asked for; its handle is opened_by.
    opener_title TEXT,
    -- The title murmur last wrote for it.
    murmur_title TEXT,
    -- What its own agent said it works on, through summarize.
    summary TEXT,
    -- The handle of the terminal whose agent opened it; null otherwise.
    opened_by TEXT,
    -- The handle of its lead: the terminal whose agent opened it with a brief for the agent
    -- there, until that agent exits; null otherwise.
    led_by TEXT,
    -- The command it was opened to run at its first prompt.
    command TEXT,
    -- The program in its foreground when its shell was last seen.
    last_program TEXT,
    -- What its root agent session worked on, for agents messaging each other, as JSON.
    work TEXT,
    UNIQUE (session_id, handle),
    -- What an item's foreign key names; a save may move a terminal to another session, and
    -- its items go with it.
    UNIQUE (id, session_id)
  ) STRICT;
CREATE TABLE session_handles (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    handle TEXT NOT NULL,
    PRIMARY KEY (session_id, handle)
  ) STRICT;
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
CREATE TABLE message_threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- Its two terminals, in the order its first message went.
    first_terminal TEXT NOT NULL,
    second_terminal TEXT NOT NULL,
    hops INTEGER NOT NULL,
    -- The hop from which its messages are held for the person, null when none is; held_for
    -- says why ('loop').
    held_from INTEGER,
    held_for TEXT CHECK (held_for IN ('loop')),
    last_at REAL NOT NULL,
    -- When the person stopped it; null if they have not, or released it since.
    stopped_at REAL,
    UNIQUE (id, project_id)
  ) STRICT;
CREATE INDEX message_threads_project ON message_threads(project_id);
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- The thread between two agents it belongs to; null for the person's and Novadeck's.
    thread_id TEXT,
    hop INTEGER NOT NULL,
    -- Who sent it. Only an agent's has a terminal, handle and thread: the person's carries
    -- the id of the Inbox entry it answers in its response, Novadeck's has nothing else.
    from_kind TEXT NOT NULL CHECK (from_kind IN ('agent', 'person', 'novadeck')),
    from_terminal TEXT,
    from_handle TEXT,
    from_agent TEXT,
    from_agent_session TEXT,
    to_terminal TEXT NOT NULL,
    to_handle TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    -- Null while it waits for the first session of its agent to bind there.
    to_agent_session TEXT,
    text TEXT NOT NULL,
    sent_at REAL NOT NULL,
    state TEXT NOT NULL,
    delivered_at REAL,
    -- Whether its sender was told it is gone.
    notified INTEGER NOT NULL,
    -- Whether the person stopped its thread before it was delivered.
    stopped INTEGER NOT NULL,
    -- Whether its sender was its recipient's lead when it was sent.
    from_lead INTEGER NOT NULL,
    -- Whether its recipient was its sender's lead when it was sent.
    to_lead INTEGER NOT NULL,
    response TEXT,
    FOREIGN KEY (thread_id, project_id) REFERENCES message_threads(id, project_id)
      ON DELETE CASCADE,
    CHECK (from_kind <> 'person' OR json_type(response, '$.askId') IS 'text'),
    CHECK ((from_kind = 'agent') = (from_terminal IS NOT NULL)),
    CHECK ((from_kind = 'agent') = (from_handle IS NOT NULL)),
    CHECK ((from_kind = 'agent') = (thread_id IS NOT NULL))
  ) STRICT;
CREATE INDEX messages_thread ON messages(thread_id);
CREATE INDEX messages_project ON messages(project_id);
CREATE TABLE inbox_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    terminal_id TEXT NOT NULL,
    at REAL NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
CREATE INDEX inbox_entries_project ON inbox_entries(project_id);
CREATE TABLE companion_windows (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    -- Undocked from a bar, or the session's project window, the one the person opens files in.
    home TEXT NOT NULL CHECK (home IN ('undocked', 'project')),
    -- The title the person gave it; null when it is named by its item.
    person_title TEXT,
    created_at REAL NOT NULL,
    UNIQUE (id, session_id)
  ) STRICT;
CREATE TABLE companion_items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    terminal_id TEXT,
    window_id TEXT UNIQUE,
    -- A file's resolved path, a page's pageKey, or a plan's slot, unique on one bar.
    pointer_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'file', 'page', 'plan', 'changes')),
    path TEXT,
    url TEXT,
    lines_from INTEGER,
    lines_to INTEGER,
    -- A plan's agent, session and actor (empty for the root), and whether it is a file
    -- or text in the transcript or rollout at path.
    plan_agent TEXT,
    plan_agent_session TEXT,
    plan_actor TEXT,
    plan_format TEXT CHECK (plan_format IN ('file', 'text')),
    name TEXT NOT NULL,
    detail TEXT NOT NULL,
    -- Whether it is a file that may hold secrets, which opens only when the person picks it.
    secret INTEGER NOT NULL,
    shown_by TEXT NOT NULL CHECK (shown_by IN ('agent', 'person')),
    -- The terminal it was shown or attached in, and its handle; both null for a file the
    -- person opened in their project window.
    from_terminal TEXT,
    from_handle TEXT,
    version INTEGER NOT NULL,
    -- Whether its latest show asked to open it.
    open_asked INTEGER NOT NULL,
    shown_at REAL NOT NULL,
    observed_at REAL,
    FOREIGN KEY (terminal_id, session_id) REFERENCES terminals(id, session_id)
      ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (window_id, session_id) REFERENCES companion_windows(id, session_id)
      ON DELETE CASCADE,
    CHECK ((terminal_id IS NULL) <> (window_id IS NULL)),
    CHECK ((from_terminal IS NULL) = (from_handle IS NULL))
  ) STRICT;
CREATE UNIQUE INDEX companion_items_bar ON companion_items(terminal_id, pointer_key)
    WHERE terminal_id IS NOT NULL;
CREATE INDEX companion_items_session ON companion_items(session_id);
CREATE UNIQUE INDEX companion_windows_project ON companion_windows(session_id)
    WHERE home = 'project';
