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


## Remembered categories and source hints

Changing a queue/history card category now saves the manual selection and a reusable example atomically in the room settings. Both staff accounts can correct categories. The last 200 examples are retained. Matching uses canonical media identity, non-generic exact titles, and explicit numbered episode/part families with at least three words. It never learns an entire channel from a single correction. Manual selection wins, followed by a remembered example, title rules, then available source hints. New Twitch requests use the same remembered rules even with the dashboard closed.

Metadata collection reuses existing bounded public page/oEmbed fetches and the seven-day cache. YouTube player metadata and the selected TikTok item can contribute creator/channel identity, tags, provider category and a short description. A source author can identify Forsen; ambiguous titles can use genre tags or provider categories. Descriptions are weak hints limited to their opening sentence, after stronger title signals. Unsupported or hidden metadata remains unknown. The active/waiting queue gets a one-time versioned content backfill; manual categories skip that extra lookup. No model API or paid metadata service is used.

## Private playback reports

Only verified paim_beach_pete can open, save or read reports. The Report playback issue control is beside the player controls and offers issue types plus recent reports. Reports retain the current request identity/title, platform, chosen issue, provider error code when available, timestamp, playback position, pause, mute and volume. OAuth credentials, signed media URLs, iframe contents and browser storage are not collected. The server derives media identity from the stored queue row and validates the playing generation. Reports are capped at 100 with one report per generation per minute. Saving a report never writes the playing or waiting queue rows. Existing session/store routes are reused, without another Vercel function or paid service.


## StreamElements paid queue promotions

Production uses the sensitive server-only STREAMELEMENTS_JWT for 2o3a's Twitch channel. It is never returned to browsers. No StreamElements command-cost setting is required: our signed Twitch webhook handles the command and the points API handles payment. Do not configure another paid !promote command in StreamElements, which would charge separately.

!promote [queue position] lets any viewer pay to move any waiting request (their own or another viewer's) straight to next up. Without a position it selects their earliest waiting request. Price is 50 points for every position crossed in the queue snapshot accepting the command: #10 to #1 costs 450 points. Already-next requests are free and unchanged. Current playback is untouched. Unknown duration is allowed because pricing does not use duration. Each later promotion moves ahead of earlier promotions; streamer manual ordering/shuffle remains authoritative. Votes preserve promoted requests ahead of ordinary requests. !unpromote [position] lets only the payer cancel a still-waiting, not-yet-played promotion, refunds the complete recorded price, and restores its original relative slot using surviving nonpromoted neighbors. New arrivals and later promotions are preserved. Removal is separate from cancellation; use !unpromote before !remove if a refund is wanted.

Promotion spending/refund labels appear in waiting/history cards, the player footer, public queue, !queue and !when. The public projection exposes only the display label, never the purchase journal. Full purchase history/technical diagnostics are readable only by verified paim_beach_pete. Browser writes cannot forge or erase authoritative promotion fields. New history requests cannot refund an earlier request's purchase.

Point purchases use a durable journal and single-owner state transitions. External point writes never run inside a retryable database callback. Duplicate deliveries cannot repeat an acknowledged debit/refund; same-viewer purchases and same-video purchases serialize. New commands expire after two minutes, while already-authorized refunds/fulfilment resume after expiry. If playback starts or the request disappears before fulfilment, the charge is automatically refunded. StreamElements has no documented idempotency key or transaction spanning our database. Network/5xx ambiguity or a crash after an external write is quarantined as charge_unknown/refund_unknown, blocks further spending for that viewer, and requires manual StreamElements reconciliation. Never blindly replay or manually delete an uncertain journal entry. Definite rejected refunds retry through the existing durable intake. Balance checks cannot lock simultaneous spending from other StreamElements games/integrations.

Validate with node --test tests/queuePromotion.test.js, the full unit suite and existing browser smoke suite. Real deductions/refunds require a viewer's live test; do not manufacture production requests or spend viewer points for automated verification.
