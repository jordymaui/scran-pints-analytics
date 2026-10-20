# Scran & Pints Analytics

Branded analytics and YouTube title/thumbnail research dashboard.

Current deployed site: https://scran-pints-analytics.vercel.app

## Local development

This is a static HTML/CSS/JavaScript site. No package installation or build is required.

```sh
python3 -m http.server 8000
```

Open http://localhost:8000. Serve this repository root, because several requests use root-relative paths.

## Pages

- `index.html`: episode review and analytics
- `title-table.html`: cross-episode title research
- `thumbnail-lab.html`: thumbnail gallery and comparisons
- `winners-losers.html`: evidence-led working guidance
- `leaderboard.html`: comparative review

## Data and scope

`data.json` and `image-index.json` contain saved snapshots, not a live analytics feed. Preserve dates, provenance, unavailable values and test limitations. This repository contains the existing frontend, snapshot data, fonts and artwork. It does not contain OAuth credentials, a background collection pipeline or the full private research archive.

The wider cross-platform sponsor dashboard is planned work, not an existing feature claim. Native test watch-time shares are not variant CTR. Whole-video metrics do not establish individual title or thumbnail performance.

## Hosting

`vercel.json` preserves existing static-hosting headers. The existing production site has not been redeployed or reconnected as part of creating this repository. Local Vercel project metadata is intentionally excluded. Do not create a duplicate hosting project by accident; verify the existing project before linking or deploying.
