# Queue reliability

## Roles

`2o3a` sees streaming controls, queue controls, and statistics. Both staff accounts can view queue recovery history and action logs, and undo eligible queue changes. Technical connection badges, cloud/network status, payment journals/reconciliation, and raw crash diagnostics remain restricted to verified `paim_beach_pete`. Payment recovery independently enforces that identity; queue recovery independently enforces the staff allowlist.

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

Fair shuffle is optional beside regular Shuffle. It interleaves normalized requester buckets, preserves pinned and promoted slots and current playback, and uses the same version conflict checks, original-order snapshot and recovery log. A large requester can still have consecutive entries after other buckets run out.

The read-only /queue page supports title search and exact Twitch username filtering while retaining full-queue positions. It never authenticates as staff or writes queue data.

Quiet monitoring uses the existing moderator-only health poll (60 seconds; server receipt probe cached up to five minutes). It flags inactive intake, storage/read failure, buffered/error receipts and unconfirmed accepted writes. Thirty minutes without delivery is explicitly informational: quiet chat is not evidence of failure. This is dashboard monitoring, not an external notification service or paid background monitor. Only verified paim_beach_pete sees these details.


## Remembered categories and source hints

Changing a queue/history card category now saves the manual selection and a reusable example atomically in the room settings. Both staff accounts can correct categories. The last 200 examples are retained. Matching uses canonical media identity, non-generic exact titles, and explicit numbered episode/part families with at least three words. It never learns an entire channel from a single correction. Manual selection wins, followed by a remembered example, title rules, then available source hints. New Twitch requests use the same remembered rules even with the dashboard closed.

Metadata collection reuses existing bounded public page/oEmbed fetches and the seven-day cache. YouTube player metadata and the selected TikTok item can contribute creator/channel identity, tags, provider category and a short description. A source author can identify Forsen; ambiguous titles can use genre tags or provider categories. Descriptions are weak hints limited to their opening sentence, after stronger title signals. Unsupported or hidden metadata remains unknown. The active/waiting queue gets a one-time versioned content backfill; manual categories skip that extra lookup. No model API or paid metadata service is used.

## Private playback reports

Only verified paim_beach_pete can open, save or read reports. The Report playback issue control is beside the player controls and offers issue types plus recent reports. Reports retain the current request identity/title, platform, chosen issue, provider error code when available, timestamp, playback position, pause, mute and volume. OAuth credentials, signed media URLs, iframe contents and browser storage are not collected. The server derives media identity from the stored queue row and validates the playing generation. Reports are capped at 100 with one report per generation per minute. Saving a report never writes the playing or waiting queue rows. Existing session/store routes are reused, without another Vercel function or paid service.


## StreamElements paid queue promotions

Production uses the sensitive server-only STREAMELEMENTS_JWT for 2o3a's Twitch channel. It is never returned to browsers. The signed Twitch webhook handles commands, without staff/approved-account requirements, and the points API handles payment. No separate paid StreamElements custom command is required; configuring one could charge twice. GachiBot69 remains excluded as a bot, as previously requested.

!qpromote <queue position> <points> lets any viewer contribute to any waiting video. Points must be a positive multiple of 50; each 50 points buys one position of priority. Example: !qpromote 10 450 buys nine positions. Contributions are additive, including extra priority for a video already next up. Enough remaining contributions can keep it at the top after a contributor cancels. Spending does not interrupt the playing video. No video duration lookup is involved.

!qunpromote <queue position> cancels all of that payer's active contributions to that still-waiting, not-yet-played request, refunds their complete recorded amount, and removes exactly their priority credits. Other payers' points and credits remain intact. Waiting requests are ranked by an organic position minus active paid credits, with funded requests winning exact ties. The organic order is saved separately from applied queue order; completed/removed requests leave the baseline, new arrivals append, and explicit streamer reordering rebases positions while preserving contributions. Votes preserve paid requests' current slots rather than accidentally moving a partial promotion to the top. Shuffle, Fair shuffle and Unshuffle cannot move active promoted slots. Explicit manual streamer reordering remains available. Removing a request is separate from cancelling a contribution; use !qunpromote before !remove for a refund.

The browser/public queue, player footer, history, !queue and !when show active spending, contributor count, pending refunds and refunded amounts. Full journals and technical diagnostics are only readable by verified paim_beach_pete. Browser writes cannot forge or erase server-owned promotion fields. History/replayed requests cannot refund a previous playback generation. Legacy single-payer promotions are converted using their original order snapshots when next touched, retaining the refund record.

Point purchases use a durable journal and single-owner state transitions. External writes never run inside retryable database callbacks. Duplicate deliveries cannot repeat acknowledged debits/refunds. Same-payer transactions and same-video transactions serialize; another attempt while a video transaction is in progress is rejected without charge and can be retried. New commands expire after two minutes; already-authorized refunds/fulfilment resume after expiry. If playback starts or a request disappears during payment, the debit is refunded.

StreamElements has no documented idempotency key or transaction spanning our database. Network/5xx ambiguity or a crash after an external write is quarantined as charge_unknown/refund_unknown, blocks further spending for that payer, and requires verified StreamElements reconciliation through the private moderator controls. Never blindly replay or delete an uncertain journal entry. Definite rejected refunds retry through durable intake. Balance checks cannot lock simultaneous spending in other StreamElements games/integrations. The moderator-only Check connection control verifies the JWT channel without changing points.

Validate with node --test tests/queuePromotion.test.js, the full unit suite and existing browser smoke suite. A real debit/refund requires a viewer's live test; automated tests do not manufacture production requests or spend viewer points.


## Promotion details and payment recovery

The commands are !qpromote <queue position> <points> and !qunpromote <queue position>. The old !promote/!unpromote aliases are intentionally not accepted because Nightbot owns !promote for its separate song queue. Help, copyable commands, public queue and dashboard instructions use the q-prefixed commands. Purchase replies include title, actual points charged and the rank recorded at fulfilment. Ordinary URL requests remain silent.

A shared pure priority helper computes the estimated minimum additional points to reach next up, including competing contributions and exact-score tie rules. It is used for public API projections and memoized dashboard quotes. Estimates belong to a queue snapshot and can change before a chat command arrives. No price estimate writes queue data or looks up a points balance. The waiting row displays the estimate and a copyable command. The public response whitelists only user-facing fields; it never returns room settings or payment journals.

Clicking a promotion badge loads per-payer active, refunded and pending-refund totals on demand (50 contributors per page). Public lookup is limited to the current queued/playing request identity; authenticated staff can also inspect history. Request timestamp and media URL isolate reused IDs, and a read transaction keeps request identity and contributions consistent. Journals, provider error codes, tokens, recovery decisions and receipt IDs are never exposed by this view.

Only paim_beach_pete can resolve uncertain payments. The recovery form requires selecting the independently checked StreamElements outcome, a verification note and typing VERIFIED. charge_confirmed resumes an acknowledged charge without debiting again; charge_absent marks it failed without changing points. refund_confirmed finalizes refund metadata without crediting again; refund_absent authorizes a single refund attempt. Known charged/refund_ready/refund_acknowledged states can resume with RESUME. Stalled charging/refunding states are quarantined only after 60 seconds, never blindly repeated. State and timestamp preconditions reject stale decisions. Each decision creates an append-only audit record with actor, prior/new state, evidence and server time. The same-origin staff route rechecks the paim identity server-side.

Refund acknowledgement is persisted before local settlement. The durable processor or recovery tool can finish refund metadata without making another external call. If an acknowledged charge can no longer fulfil its request, the existing compensation refund path applies. These controls rely on the moderator honestly verifying the external result; the points API provides no cross-service transaction or automatic proof of an ambiguous write. No live viewer points are spent by automated tests.
