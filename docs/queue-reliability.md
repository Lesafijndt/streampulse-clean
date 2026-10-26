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
