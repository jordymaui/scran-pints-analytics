-- Read-only verification after provisioning. Expect 6 tables with RLS enabled;
-- anon/authenticated privileges false; service_role true; 5 invoker functions
-- with anon/authenticated execution false and service_role execution true.
select c.relname, c.relrowsecurity as rls_enabled,
  has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as anon_access,
  has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as authenticated_access,
  has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as server_access
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in (
  'analytics_connections', 'analytics_snapshots', 'analytics_snapshot_history',
  'analytics_sync_runs', 'analytics_sync_locks', 'analytics_workshop_notebook'
) order by c.relname;

select p.proname, not p.prosecdef as security_invoker,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as server_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in (
  'analytics_archive_snapshot', 'analytics_save_snapshot',
  'analytics_acquire_sync_lock', 'analytics_release_sync_lock', 'analytics_save_notebook'
) order by p.proname;
