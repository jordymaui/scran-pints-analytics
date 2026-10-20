# Scran & Pints Analytics

Public social reporting, a YEET sponsor view, and the team's YouTube packaging workshop. The application targets the existing [Vercel site](https://scran-pints-analytics.vercel.app).

## Hosted architecture

GitHub holds application code and the agreed historical archive. Vercel serves the explicit `public-dist` build and Node API routes. Supabase stores reporting grants, successful snapshots, snapshot history, sync outcomes, and shared workshop notes. Production needs no running laptop or local token files.

The public API projects approved fields from saved cloud reports. If storage is unavailable or unconfigured, it returns the bundled historical reports with an explicit fallback label. Capture dates and reporting windows remain visible. Failed refreshes preserve the last successful snapshot; concurrent jobs use database leases and notebook edits use version checks.

| Route | Purpose and access |
| --- | --- |
| `/` | Public overview and advanced platform reporting |
| `/sponsor.html` | Public YEET report; confirmed campaign placements are separate from channel context |
| `/api/report` | Public, allowlisted reporting JSON |
| `/workshop.html`, `/connections.html` | Team workspace shells; data and actions require approved Google sign-in |
| `/api/workshop-data`, `/api/workshop-notebook`, `/api/connection-status` | Authenticated workshop data, shared notes and connection status |
| `/api/connections/youtube` | Team-authorized, read-only YouTube reporting consent |
| `/api/sync?source=…` | Authenticated same-origin manual refresh; cron requires its server secret |
| `/review-room.html` and legacy research pages | Authenticated historical review tools and evidence |

**Repository visibility:** this repository and its committed historical archive intentionally remain public, as agreed. Website authentication does not hide that existing GitHub content or history. New credentials, reporting grants and workshop notes belong in private cloud storage and must never be committed or included in public assets.

## Deploy to the existing project

1. Apply the reviewed [Supabase provisioning SQL](supabase/provision.sql), then run [verification queries](supabase/verify.sql). Tables have RLS enabled and access is restricted to the server role. The existing project's [provisioning and verification record](supabase/README.md) documents the initial application.
2. Set the following **server environment variables** in the existing Vercel project using [`.env.example`](.env.example):

   | Variables | Purpose |
   | --- | --- |
   | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | Team authentication |
   | `SUPABASE_SECRET_KEY` | Server-only cloud persistence |
   | `WORKSHOP_ALLOWED_EMAILS` | Comma-separated exact approved Google email addresses |
   | `APP_ORIGIN` | Exact deployed HTTPS origin |
   | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | Google reporting OAuth web client |
   | `CRON_SECRET` | Long random secret for scheduled refreshes |

3. Keep the shared Supabase project's existing main-site URL and redirect entries. Add this app's `/api/auth/callback**` redirect entry. Configure Google's reporting callback exactly as documented in [YouTube setup](docs/YOUTUBE.md), including `?action=callback`.
4. Deploy the verified GitHub revision to the existing Vercel project. [`vercel.json`](vercel.json) selects `npm run build`, publishes only `public-dist`, bundles protected files inside server functions, and schedules four daily refresh jobs at 04:00–07:00 UTC.
5. Verify public reporting, unauthenticated access denial, approved team sign-in, shared notebook saves, and a real reporting connection. Use Connections to authorize YouTube and refresh episodes and Shorts separately. A configured schedule or consent screen alone does not establish successful collection.

## Coverage and limitations

The bundled YouTube report covers five selected full episodes, not channel totals. Refreshing keeps that selected scope. Shorts has a separate adapter; Instagram reporting remains blocked pending professional-account/app setup and a verified adapter. TikTok's implemented Display adapter supplies lifetime counters; detailed watch-time and account insights need separate product approval and implementation. See [connection capabilities and setup](docs/CONNECTIONS.md).

Missing metrics remain unavailable. Cross-platform views are not unique people. YEET exposure or return on investment requires confirmed attribution. Native test watch-time shares are distinct from whole-video CTR, and combined title/thumbnail experiments support conclusions about the pairing. The workshop preserves dates and evidence; its collectors do not change YouTube publishing or packaging.

## Development and validation

Use Node 22 or later. The application has no runtime package dependencies.

```sh
npm test
npm run build
npm run dev
```

Open `http://localhost:5186` for development, matching the configured `APP_ORIGIN`. Optional ignored `.env.local` supplies real development configuration; authentication has no bypass. Serve through the application server, which exposes only the public build and explicit authenticated routes. Tests cover reporting integrity, authorization, private file boundaries, collectors, cloud persistence and notebook conflicts.

Developer-only import and collection commands are documented in [Connections](docs/CONNECTIONS.md) and [YouTube](docs/YOUTUBE.md); the hosted service does not depend on them.
