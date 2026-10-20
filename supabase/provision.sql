-- Reviewed provisioning script, not an applied CLI migration.
-- Run against the existing approved Supabase project, then run verify.sql.
-- Contains no credentials. Application access is service_role only.
begin;

create table if not exists public.analytics_connections (
  platform text primary key check (platform in ('youtube', 'youtube-shorts', 'instagram', 'tiktok')),
  credentials jsonb not null check (jsonb_typeof(credentials) = 'object'),
  account_id text,
  scopes text[] not null default '{}',
  updated_at timestamptz not null default now()
);
create table if not exists public.analytics_snapshots (
  source text primary key check (source in ('youtube', 'youtube-shorts', 'instagram', 'tiktok')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  captured_at timestamptz not null,
  updated_at timestamptz not null default now(),
  status text not null check (status in ('ready', 'partial'))
);
create table if not exists public.analytics_snapshot_history (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('youtube', 'youtube-shorts', 'instagram', 'tiktok')),
  payload jsonb not null,
  captured_at timestamptz not null,
  status text not null,
  archived_at timestamptz not null default now()
);
create table if not exists public.analytics_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('youtube', 'youtube-shorts', 'instagram', 'tiktok')),
  status text not null check (status in ('ready', 'not-connected', 'blocked', 'failed', 'busy')),
  error_code text check (error_code is null or error_code ~ '^[a-z][a-z0-9_-]{0,63}$'),
  message text,
  completed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);
create index if not exists analytics_sync_runs_source_completed_idx
  on public.analytics_sync_runs (source, completed_at desc);
create index if not exists analytics_snapshot_history_source_capture_idx
  on public.analytics_snapshot_history (source, captured_at desc);
create table if not exists public.analytics_sync_locks (
  source text primary key check (source in ('youtube', 'youtube-shorts', 'instagram', 'tiktok')),
  owner uuid not null,
  expires_at timestamptz not null
);
create table if not exists public.analytics_workshop_notebook (
  id text primary key check (id = 'team'),
  version bigint not null check (version > 0),
  drafts jsonb not null check (jsonb_typeof(drafts) = 'array' and jsonb_array_length(drafts) <= 200),
  updated_by uuid not null,
  updated_at timestamptz not null default now()
);

alter table public.analytics_connections enable row level security;
alter table public.analytics_snapshots enable row level security;
alter table public.analytics_snapshot_history enable row level security;
alter table public.analytics_sync_runs enable row level security;
alter table public.analytics_sync_locks enable row level security;
alter table public.analytics_workshop_notebook enable row level security;
-- Intentionally no anon/authenticated policies. The server authorizes requests.
revoke all on public.analytics_connections, public.analytics_snapshots,
  public.analytics_snapshot_history, public.analytics_sync_runs, public.analytics_sync_locks, public.analytics_workshop_notebook
  from public, anon, authenticated;
grant select, insert, update, delete on public.analytics_connections, public.analytics_snapshots,
  public.analytics_snapshot_history, public.analytics_sync_runs, public.analytics_sync_locks, public.analytics_workshop_notebook
  to service_role;

create or replace function public.analytics_archive_snapshot()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if old.payload is distinct from new.payload or old.captured_at is distinct from new.captured_at then
    insert into public.analytics_snapshot_history (source, payload, captured_at, status)
    values (old.source, old.payload, old.captured_at, old.status);
  end if;
  return new;
end;
$$;
drop trigger if exists analytics_archive_snapshot on public.analytics_snapshots;
create trigger analytics_archive_snapshot before update on public.analytics_snapshots
  for each row execute function public.analytics_archive_snapshot();

create or replace function public.analytics_save_snapshot(
  p_source text, p_payload jsonb, p_captured_at timestamptz, p_status text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare affected integer;
begin
  insert into public.analytics_snapshots (source, payload, captured_at, status)
  values (p_source, p_payload, p_captured_at, p_status)
  on conflict (source) do update
    set payload = excluded.payload, captured_at = excluded.captured_at,
        status = excluded.status, updated_at = now()
    where public.analytics_snapshots.captured_at <= excluded.captured_at;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.analytics_acquire_sync_lock(
  p_source text, p_owner uuid, p_expires_at timestamptz
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare affected integer;
begin
  if p_expires_at <= now() or p_expires_at > now() + interval '15 minutes' then
    raise exception 'Invalid sync lease expiry';
  end if;
  insert into public.analytics_sync_locks (source, owner, expires_at)
  values (p_source, p_owner, p_expires_at)
  on conflict (source) do update set owner = excluded.owner, expires_at = excluded.expires_at
    where public.analytics_sync_locks.expires_at <= now()
       or public.analytics_sync_locks.owner = excluded.owner;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.analytics_release_sync_lock(p_source text, p_owner uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare affected integer;
begin
  delete from public.analytics_sync_locks where source = p_source and owner = p_owner;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.analytics_save_notebook(
  p_drafts jsonb, p_expected_version bigint, p_updated_by uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare saved public.analytics_workshop_notebook;
begin
  if p_expected_version < 0 then raise exception 'Invalid notebook version'; end if;
  -- A missing notebook accepts only version zero. Existing rows update only
  -- when the reader's version still matches, inside the same atomic statement.
  if p_expected_version = 0 then
    insert into public.analytics_workshop_notebook (id, version, drafts, updated_by)
    values ('team', 1, p_drafts, p_updated_by)
    on conflict (id) do nothing returning * into saved;
  else
    update public.analytics_workshop_notebook
      set version = version + 1, drafts = p_drafts, updated_by = p_updated_by, updated_at = now()
      where id = 'team' and version = p_expected_version returning * into saved;
  end if;
  if saved.id is null then return null; end if;
  return jsonb_build_object('version', saved.version, 'drafts', saved.drafts, 'updatedAt', saved.updated_at);
end;
$$;

revoke all on function public.analytics_archive_snapshot() from public, anon, authenticated;
revoke all on function public.analytics_save_snapshot(text, jsonb, timestamptz, text) from public, anon, authenticated;
revoke all on function public.analytics_acquire_sync_lock(text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.analytics_release_sync_lock(text, uuid) from public, anon, authenticated;
revoke all on function public.analytics_save_notebook(jsonb, bigint, uuid) from public, anon, authenticated;
grant execute on function public.analytics_archive_snapshot() to service_role;
grant execute on function public.analytics_save_snapshot(text, jsonb, timestamptz, text) to service_role;
grant execute on function public.analytics_acquire_sync_lock(text, uuid, timestamptz) to service_role;
grant execute on function public.analytics_release_sync_lock(text, uuid) to service_role;
grant execute on function public.analytics_save_notebook(jsonb, bigint, uuid) to service_role;

notify pgrst, 'reload schema';
commit;
