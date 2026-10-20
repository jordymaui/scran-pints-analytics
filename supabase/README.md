# Cloud schema

[`provision.sql`](provision.sql) defines six server-only tables and five security-invoker functions for reporting connections, snapshots and history, refresh outcomes and leases, and the shared workshop notebook. Every table has RLS enabled. Grants permit `service_role` access; `anon` and `authenticated` have neither table access nor function execution. The application verifies team identity before private operations.

## Provisioning record

The schema was applied to the existing approved Supabase project on **20 October 2026**, using its SQL editor after the MCP migration call rejected an expired request state. The initial application omitted only the unnecessary `DROP TRIGGER IF EXISTS` statement because the snapshot table was new. The checked-in script retains that statement so subsequent reviewed applications can replace the trigger safely.

This is an applied provisioning script, not a generated or recorded Supabase CLI migration. No migration filename or migration-history entry is claimed. Any later schema change should follow the project's chosen migration workflow.

## Verification

[`verify.sql`](verify.sql) confirmed all six tables have RLS and service-only access, and all five functions use invoker security with service-only execution. The advisor's absence-of-policy notices are expected for these tables: browser roles intentionally have no access.

Database behavior was also checked under `SET LOCAL ROLE service_role` within a transaction that ended in `ROLLBACK`:

- A newer snapshot replaced the current one and archived the exact previous payload and capture date.
- An older snapshot was rejected without changing either the current snapshot or its history.
- A competing lease owner could neither acquire nor release an active lease; the owner could release it and another owner could then acquire it.
- A notebook save incremented its version; a stale version returned a conflict without changing the saved draft.

All assertions passed. Follow-up queries found zero verification snapshots, history records, notebook drafts or remaining test leases. These checks read no connection credentials and persisted no test records.
