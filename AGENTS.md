# Project instructions

- This repository is the Scran & Pints analytics dashboard, not the main website or private finance ledger.
- Preserve the real logo, supplied fonts, cream/red/ink palette and football-programme/sticker-book visual identity.
- Keep language clear and mobile layouts usable. Prefer cross-episode comparisons over repeating episode sections in title/thumbnail research.
- Current data is a historical snapshot. Never describe it as live or invent unavailable metrics.
- Keep whole-video CTR, reach, retention and watch time distinct from native test watch-time share. Combined title/image tests support pairing conclusions, not causal attribution to one element.
- Preserve full test rounds and their source dates before replacing results. Label hypotheses and inconclusive results honestly.
- Never put credentials, OAuth tokens or private financial records in client assets or git.
- Editing this dashboard does not authorize changing YouTube titles, thumbnails, tests or publication settings.
- The existing live site is https://scran-pints-analytics.vercel.app. Repo creation did not change its deployment or access settings.
- Run `npm run dev` for development and `npm run build` before deployment. Serve only the generated `public-dist` directory through the application server; the repository root contains protected workshop evidence.
- Production runs on Vercel with private Supabase storage. Do not depend on local processes or local token files for reporting, account connections or workshop notes.
- Keep the existing main site's Supabase Auth configuration intact. Add this dashboard's callback to the redirect allowlist; do not replace the shared project's Site URL.
- Run `npm test` for the report projection, authorization, collectors, persistence and routing checks.
