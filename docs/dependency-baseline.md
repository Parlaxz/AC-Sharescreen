# Dependency Baseline

> Pin all production dependencies to exact versions. Record resolution date and versions here.

| Package | Version | Resolved | Notes |
|---------|---------|----------|-------|
| @screenlink/shared | workspace:* | - | Internal |
| @screenlink/vdo-adapter | workspace:* | - | Internal |
| @screenlink/desktop | workspace:* | - | Internal |
| @screenlink/viewer | workspace:* | - | Internal |
| @screenlink/control-worker | workspace:* | - | Internal |
| electron | 42.4.1 | - | Pinned by spec |
| @vdoninja/sdk | 1.3.18 | - | Pinned by spec |
| react | ^19.0.0 | - | Must pin to exact |
| zustand | ^5.0.0 | - | Must pin to exact |
| zod | ^3.24.0 | - | Must pin to exact |

> **Resolution date:** 2026-06-20
> **Note:** Before release, run `pnpm view PACKAGE version` for each dep and pin exact versions.
