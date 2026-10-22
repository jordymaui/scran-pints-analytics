# Hosted Instagram scans

The optional Browserbase connection runs the Instagram browser in the cloud. Vercel starts each scan; private Supabase storage holds the provider key, Context ID and reporting captures. No local browser, computer, exported cookie file or Meta developer account is required at runtime.

## Connect

1. Create a Browserbase account and check its current allowance and persistent Context access. The free allowance is a pilot, not a promise of unlimited reporting. No paid plan is selected by this application.
2. Sign into the team area on Connections. Save the provider API key in **Instagram browser scans**. The optional project ID can be omitted when the key identifies its project.
3. Open the private cloud login and sign into `@scranpints` directly on Instagram. The application never receives the Instagram password. The bounded login window lasts around four minutes; reopen it if it expires.
4. The app verifies the own-profile controls, closes the session to persist its Context, then marks the connection ready. Run Refresh and verify a successful real scan before treating this integration as operational.

The cloud provider holds a persistent Instagram session, so it must be treated as sensitive account access. Session recording, provider logs, CAPTCHA solving and optional stealth/proxy features are disabled. Verification challenges require the owner; the application does not bypass them. Rotate the provider key or revoke the Instagram session if access must be removed.

## Refresh

YEET's existing anonymous Refresh starts the same fixed-account scan used by team refresh and the scheduled job. The Instagram lease prevents concurrent Context use, and the existing server cooldown limits repeated refreshes. Provider quotas still apply.

The collector reads rendered native account Insights for 7, 30 and 90 days. It refreshes saved accepted FootyScran collab Insights and checks new links on the own-profile grid. New posts must show both accounts in Instagram's Collaborators dialog before collection. FootyScran's unrelated posts are excluded.

Account reports advance together only when all three selected windows parse successfully. Each collab retains its own observation date. Failed or unavailable sections keep their earlier values; a partial run is labeled partial. Browser login expiry, provider failure or exhausted allowance never relabels an old report as fresh. The public report contains selected analytics only; API keys, browser Contexts and private login links are never public.

Native relative windows do not supply daily history or exact reporting boundaries. A cloud scan does not manufacture those values, turn post lifetime counters into period views, or add collab views again on top of Instagram's account total.

## Deployment

`playwright-core` connects to the hosted browser; no local Chromium installation is needed. The login task uses Vercel `waitUntil` within the existing 300-second function budget. The private browser endpoint rewrites through the existing Instagram function to preserve the twelve-function deployment limit. New server modules remain outside the public static build.
