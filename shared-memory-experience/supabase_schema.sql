-- Shared Memory (Join39 app) - Supabase schema
-- Run in Supabase SQL editor.

create table if not exists public.memories (
  key text primary key,
  url text,
  title text,
  content text not null,
  content_length int not null default 0,
  tags jsonb not null default '[]'::jsonb,
  tags_text text not null default '',
  stored_by text not null default 'anonymous',
  stored_at timestamptz not null default now(),
  access_count int not null default 0
);

create index if not exists memories_stored_at_idx on public.memories (stored_at desc);
create index if not exists memories_access_count_idx on public.memories (access_count desc);
create index if not exists memories_title_idx on public.memories using gin (to_tsvector('english', coalesce(title,'')));
create index if not exists memories_content_idx on public.memories using gin (to_tsvector('english', coalesce(content,'')));

-- Optional: simple agents table (not required for the app to function)
create table if not exists public.agents (
  agent_username text primary key,
  agent_name text,
  agent_facts_url text,
  mode text,
  registered_at timestamptz not null default now(),
  contributions int not null default 0
);
