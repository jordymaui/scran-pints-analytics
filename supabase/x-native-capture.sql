-- Allow dated X native captures in existing private reporting storage.
-- Collector credentials, jobs, policies and grants stay unchanged.
begin;
alter table public.analytics_snapshots drop constraint analytics_snapshots_source_check;
alter table public.analytics_snapshots add constraint analytics_snapshots_source_check
  check (source in ('youtube','youtube-shorts','instagram','tiktok','x'));
alter table public.analytics_snapshot_history drop constraint analytics_snapshot_history_source_check;
alter table public.analytics_snapshot_history add constraint analytics_snapshot_history_source_check
  check (source in ('youtube','youtube-shorts','instagram','tiktok','x'));
commit;
