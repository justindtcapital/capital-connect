-- Phase 3.2 — Postgres schema scaffold (Supabase-ready).
-- Sheets remains the live store until dual-write cutover.
-- Apply when standing up the VenturePulse Supabase project.
--
-- Indexing that matters (playbook):
--   event(entity_id, event_type, first_seen_at)
--   metric_observation(entity_id, metric, observed_at)
--   document(url_key) unique

create extension if not exists "pgcrypto";

-- 1) Intel time series (unlocks Phase 4 trajectories)
create table if not exists metric_observation (
  id uuid primary key default gen_random_uuid(),
  entity_id text not null,
  metric text not null,
  value double precision,
  unit text,
  observed_at timestamptz not null,
  source_family text,
  evidence text,
  created_at timestamptz not null default now(),
  unique (entity_id, metric, observed_at, source_family)
);
create index if not exists metric_observation_entity_metric_at
  on metric_observation (entity_id, metric, observed_at desc);

-- 2) Entity + person (mirror of Intel Entities / CRM people)
create table if not exists entity (
  id text primary key,
  name text not null,
  domain text,
  aliases text[] not null default '{}',
  watch_tier int not null default 3,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists person (
  id text primary key,
  name text not null,
  email text,
  company_entity_id text references entity(id),
  title text,
  created_at timestamptz not null default now()
);
create index if not exists person_email_idx on person (lower(email));

-- 3) Stage A–C ledger
create table if not exists document (
  id uuid primary key default gen_random_uuid(),
  url_key text not null unique,
  url text not null,
  title text,
  source_host text,
  source_kind text not null,
  published_at timestamptz,
  retrieved_at timestamptz not null default now(),
  tier text,
  raw_text text
);

create table if not exists story (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null,
  subject_entity_id text references entity(id),
  event_type text,
  summary text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists story_fingerprint_idx on story (fingerprint);

create table if not exists event (
  id text primary key,
  entity_id text references entity(id),
  event_type text not null,
  first_seen_at timestamptz not null,
  last_updated_at timestamptz not null,
  status text not null default 'open',
  magnitude_json jsonb,
  rank_score double precision,
  badges text[] not null default '{}',
  score_breakdown jsonb
);
create index if not exists event_entity_type_seen
  on event (entity_id, event_type, first_seen_at desc);

create table if not exists evidence (
  id uuid primary key default gen_random_uuid(),
  event_id text not null references event(id) on delete cascade,
  document_id uuid references document(id),
  metric_observation_id uuid references metric_observation(id),
  quote text,
  created_at timestamptz not null default now(),
  check (document_id is not null or metric_observation_id is not null)
);

create table if not exists signal (
  id text primary key,
  event_id text references event(id),
  document_id uuid references document(id),
  company text,
  person_id text references person(id),
  category text,
  headline text,
  source_url text,
  rank_score double precision,
  badges text[] not null default '{}',
  score_breakdown jsonb,
  created_at timestamptz not null default now()
);

-- 4) Feedback (move tab; keep UI buttons)
create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  signal_id text,
  event_id text,
  action text not null,
  user_email text,
  rank_position int,
  features jsonb,
  created_at timestamptz not null default now()
);
create index if not exists feedback_created_idx on feedback (created_at desc);
