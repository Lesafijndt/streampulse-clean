# Queue reliability

## Roles

`2o3a` sees streaming controls, queue controls, and statistics. Technical connection badges, cloud/network status, recovery history, action logs, and raw crash diagnostics are restricted to verified `paim_beach_pete`. The recovery API independently enforces the moderator role.

## Recovery

Queue removals, order changes, pins, Watch Later changes, shuffle, and resets create atomic server-side recovery records. Retention is 12 snapshots and 100 action-log entries. Metadata updates and ordinary playback transitions do not create recovery snapshots.

Undo restores only affected missing requests or unchanged fields. It preserves new arrivals, later metadata/vote updates, requests that changed again, and current playback. Restoring a removed playing request returns it to the waiting queue. Recovery never replaces the whole live queue.

## Metadata

Provider metadata is cached by canonical media identity for seven days. Missing duration retries use the existing signed durable intake message, with delays of 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, and 12 hours, stopping after six provider attempts. The queue request is committed before a metadata retry is scheduled; retry deliveries do not duplicate requests or send chat acknowledgements. Deleted requests are not recreated by metadata retries. Browser player metadata remains the fallback for provider restrictions.

## Playback failures

Temporary startup errors receive bounded retries. A retained failed request offers Retry, Open original, and Skip. Only explicit Skip or a real ended event advances playback. Retry preserves saved pause/position/audio intent.

## Release gate

The GitHub `Build on Node 22` job runs unit tests, actual-dashboard browser regressions, and a production build. Vercel's Production Deployment Checks require this job before automatic promotion. Job names must stay aligned with the Vercel check configuration.

`scripts/verify-reliability.mjs` exercises recovery and durable metadata retry in a disposable Postgres namespace. It never sends public chat messages or mutates the production queue.


## Playback preparation and recovery

The dashboard preconnects only to allowlisted origins for the next provider (disabled with Save-Data), never mounts a hidden autoplaying player or prefetches expiring media URLs. Existing bounded metadata enrichment prioritizes playing and upcoming requests. This reduces connection overhead, but cannot guarantee provider network performance.

Failed videos stay current until explicit retry or skip. YouTube 100 is reported as removed/private; 101/150 as embed restriction with possible age/sign-in/region limitations, not a proven age diagnosis. All provider failures offer the original link. No age gates are bypassed. A failure blocks subsequent ended notifications from advancing the queue until retry or next request.

Fair shuffle is optional beside regular Shuffle. It interleaves normalized requester buckets, preserves pinned slots and current playback, and uses the same version conflict checks, original-order snapshot and recovery log. A large requester can still have consecutive entries after other buckets run out.

The read-only /queue page supports title search and exact Twitch username filtering while retaining full-queue positions. It never authenticates as staff or writes queue data.

Quiet monitoring uses the existing moderator-only health poll (60 seconds; server receipt probe cached up to five minutes). It flags inactive intake, storage/read failure, buffered/error receipts and unconfirmed accepted writes. Thirty minutes without delivery is explicitly informational: quiet chat is not evidence of failure. This is dashboard monitoring, not an external notification service or paid background monitor. Only verified paim_beach_pete sees these details.
