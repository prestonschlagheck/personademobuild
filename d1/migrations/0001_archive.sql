-- The archive: a copy of every session and its thread, written by each session's Durable Object after it commits.
-- Nothing on the request path reads it. It exists for what one object per session cannot answer: queries across
-- sessions, like transcript review and where people drop off. Deleting a session deletes its copy.

create table sessions (
  id text primary key,
  state text not null,
  version integer not null,
  created_at text not null,
  updated_at text not null
);

create table events (
  seq integer primary key autoincrement,
  id text not null unique,
  session_id text not null references sessions (id) on delete cascade,
  client_msg_id text,
  tool_call_id text,
  channel text not null check (channel in ('text', 'voice', 'system')),
  role text not null check (role in ('user', 'agent', 'tool', 'system')),
  content text not null,
  meta text,
  created_at text not null
);

create index events_session_seq_idx on events (session_id, seq);
