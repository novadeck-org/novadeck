-- The workspace schema at version 5, as that version's runner created it (sqlite3 .schema),
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
    project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
    -- Opaque client state, such as a UI layout; null until the first save.
    state TEXT
  ) STRICT;
CREATE INDEX sessions_project ON sessions(project_id, position);
CREATE TABLE terminals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    -- Its handle in its session, a word such as moth, given once (see session_handles).
    handle TEXT NOT NULL,
    -- The shell's last reported directory.
    cwd TEXT NOT NULL,
    -- The latest session each agent reported, as JSON: { "claude": { sessionId, seq } }.
    agents TEXT NOT NULL,
    -- When the shell last showed its prompt, in epoch milliseconds.
    prompted_at REAL,
    -- The screen and scrollback, serialized; null when not kept.
    transcript TEXT,
    updated_at REAL NOT NULL,
    -- The title the person gave it; null when its title is automatic.
    person_title TEXT,
    -- The latest title an agent gave it, and that agent's terminal's handle.
    agent_title TEXT,
    agent_titled_by TEXT,
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
    UNIQUE (session_id, handle)
  ) STRICT;
CREATE TABLE session_handles (
    session_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    PRIMARY KEY (session_id, handle)
  ) STRICT;
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
CREATE TABLE message_threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
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
    stopped_at REAL
  ) STRICT;
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    hop INTEGER NOT NULL,
    from_terminal TEXT NOT NULL,
    from_handle TEXT NOT NULL,
    from_agent TEXT,
    from_session TEXT,
    to_terminal TEXT NOT NULL,
    to_handle TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    -- Null while it waits for the first session of its agent to bind there.
    to_session TEXT,
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
    response TEXT
  ) STRICT;
CREATE TABLE asks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    terminal_id TEXT NOT NULL,
    at REAL NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
CREATE TABLE companion_windows (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    -- Undocked from a bar, or the session's project window, the one the person opens files in.
    home TEXT NOT NULL CHECK (home IN ('undocked', 'project')),
    -- The title the person gave it; null when it is named by its item.
    person_title TEXT,
    created_at REAL NOT NULL
  ) STRICT;
CREATE TABLE companion_items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    terminal_id TEXT REFERENCES terminals(id) ON DELETE CASCADE,
    window_id TEXT UNIQUE REFERENCES companion_windows(id) ON DELETE CASCADE,
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
    plan_session TEXT,
    plan_actor TEXT,
    plan_format TEXT CHECK (plan_format IN ('file', 'text')),
    name TEXT NOT NULL,
    detail TEXT NOT NULL,
    held INTEGER NOT NULL,
    shown_by TEXT NOT NULL CHECK (shown_by IN ('agent', 'person')),
    -- The terminal it was shown or attached in, and its handle; both null for a file the
    -- person opened in their project window.
    from_terminal TEXT,
    from_handle TEXT,
    version INTEGER NOT NULL,
    asked INTEGER NOT NULL,
    shown_at REAL NOT NULL,
    observed_at REAL,
    CHECK ((terminal_id IS NULL) <> (window_id IS NULL)),
    CHECK ((from_terminal IS NULL) = (from_handle IS NULL))
  ) STRICT;
CREATE UNIQUE INDEX companion_items_bar ON companion_items(terminal_id, pointer_key)
    WHERE terminal_id IS NOT NULL;
CREATE INDEX companion_items_session ON companion_items(session_id);
CREATE UNIQUE INDEX companion_windows_project ON companion_windows(session_id)
    WHERE home = 'project';
