# WHALE CUM — Private Twitch Request Deck

WHALE CUM is a private Vite + React dashboard for running a community media queue on Twitch channel `2o3a`. It combines a live player, a shared queue, Twitch chat requests and voting, activity analytics, local recovery snapshots, and optional Firebase cloud synchronization. The UI uses a dark crimson, wine, and purple gachi-wrestling theme.

## What it does

- **Shared queue:** Accepts supported YouTube videos and Shorts, TikTok videos, Twitch Clips, and Kick Clips. The dashboard can also add media directly; title-based chat requests search YouTube and use the best match returned by the search route.
- **Queue management:** Active Queue, Watch Later, and History views; search; category and media-type filters; sorting for non-active lists; upvotes; pinned priority; drag-and-drop ordering and move controls; Play Now; Previous Video and Next Video; and automatic advance when the player reports that media ended.
- **Playback:** A large theatre-style player for YouTube and vertical TikTok embeds, plus supported Twitch Clip embeds and source links for media that cannot play inline. Playback, mute, and volume controls vary by provider; the dashboard reports when a provider does not expose a remote control.
- **Twitch chat intake:** A signed EventSub webhook accepts viewer requests even with every dashboard closed. Vercel Queues buffers accepted messages for up to seven days and retries Firestore failures. No media-request acknowledgments are posted in chat.
- **Stats & analytics:** Requesters, request totals, completions, skips, votes, top platforms/categories/requesters, estimated queue runway, and media-duration lookup status. Activity can be viewed for lifetime, the last 24 hours, or the current browser-tab session.
- **Recovery:** Queue and settings are saved locally, with backup export/import and safety-snapshot recovery. Production uses private Postgres storage behind verified Twitch sessions. Existing browser queue rows are imported once without replacing newer cloud requests; the original Firebase project remains a backup.

## Production storage

The connected Neon Free integration supplies server-only `DATABASE_URL`. Queue, history, receipts, settings and activity share an atomic PostgreSQL transaction boundary. Browser reads and writes go through `/api/twitch/session?action=store`; database credentials and private analytics never go to the streamer. Unchanged queue polling fetches only the database version. Stale playback generations cannot overwrite newer requests.

When Postgres is configured, dashboard cloud sync does not require Firebase Authentication, custom-token creation, or Firestore reads/writes. Firebase remains a legacy fallback only when no Postgres connection is configured. Keep `firebase-admin` pinned to the tested version: `npm test` includes a real token-signing check with CommonJS require(ESM) disabled to match production.

## Access and authentication

Only the Twitch accounts below are allowed to sign in to the dashboard:

| Twitch account | Role |
|---|---|
| `2o3a` | Streamer |
| `paim_beach_pete` | Moderator |

The allowlist protects dashboard access only. All normal viewers can paste supported URLs without signing into the dashboard or Firebase. `PaIm_Beach_Pete` is Twitch's display name for login `paim_beach_pete`; `palm_beach_pete` is not a verified staff alias. Persistent intake uses a server webhook and private queue consumer; it needs no open browser. Technical diagnostics remain moderator-only.

## Chat commands

| Command | Behavior |
|---|---|
| `!assr <URL or title>` | Request supported media by URL or search YouTube by title. |
| A message containing only a supported media URL | Also treated as a request. |
| `!remove` / `!unrequest` | Remove your latest eligible waiting request. |
| `!when`, `!position`, `!myqueue`, `!queueposition` | Show your queue position/ETA where available. |
| `!queue` | Show queue status and summary. |
| `!bigcock` / `!bigcock 3` | Upvote the first or a numbered waiting queue item, respectively. You cannot vote for your own request and may vote only once per video. |
| `!help` | Show user and moderator command help. |
| Moderator/broadcaster: `!skip` | Advance to the next video. |
| Moderator/broadcaster: `!volume up/down`, `!volume 0-100`, `!mute`, `!unmute` | Control supported player audio; TikTok supports mute/unmute and endpoints rather than arbitrary remote volume levels. |

Requests are blocked while the streamer has closed the queue. The app keeps duplicate media identities out of the queue/history so the same video is not repeatedly requested by changing URL format or adding common tracking parameters.

## Twitch OAuth setup

1. Register an application in the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
2. Set the OAuth redirect URL to exactly `https://YOUR-VERCEL-DOMAIN/api/twitch/callback`.
3. Add these **server-only** environment variables in Vercel → Project → Settings → Environment Variables. Do not prefix these with `VITE_`:
   - `TWITCH_CLIENT_ID`
   - `TWITCH_CLIENT_SECRET`
   - `TWITCH_APP_URL` — `https://YOUR-VERCEL-DOMAIN`
   - `TWITCH_REDIRECT_URI` — `https://YOUR-VERCEL-DOMAIN/api/twitch/callback`
4. Redeploy after changing environment variables. Only the allowlisted Twitch accounts can sign in.

## Firebase cloud sync

Cloud sync is optional. Without a valid Firebase web configuration and server service account, approved staff can use local browser storage, but different browsers will not share changes.

1. Configure the public web-app values in Vercel: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, and `VITE_FIREBASE_APP_ID`. They must refer to the same Firebase project as the server service account. `VITE_FIREBASE_NAMESPACE` is optional; the default is `streampulse-live-deck`.
2. In Firebase Console → Project settings → Service accounts, create a Firebase Admin SDK private key.
3. Put the complete service-account JSON in the server-only Vercel environment variable `FIREBASE_SERVICE_ACCOUNT_JSON`. Never prefix it with `VITE_`, commit the JSON file, or expose its private key to the browser.
4. Publish this repository's `firestore.rules` to the same Firebase project. The rules require the server-issued authorization claims; do not restore permissive anonymous client access.
5. Redeploy after changing Firebase variables or rules.

The server issues a Firebase custom token only after validating an approved Twitch session. The token carries `yediAuthorized`, `twitchLogin`, and `role` claims. Firebase writes require these server-issued claims.

## Backups and troubleshooting

- Export a queue backup before major changes. The dashboard supports importing a valid JSON backup and restoring the last local safety snapshot.
- Treat the cloud-sync indicator as authoritative for cross-browser sync. A local save protects this browser, but local-only changes do not guarantee that another browser has received them.
- A provider may block autoplay with sound until a staff member starts playback manually. TikTok, Twitch Clips, and Kick Clips expose different embed/control capabilities; some items may have to be opened from their source page.
- If activity sync fails, use the Stats & analytics retry control and check the connection details in the top menu.

## Development and verification

Requires Node.js 22 (see `.nvmrc`). Install dependencies and run:

```sh
npm install
npm test
npm run build
```

The GitHub Actions build check runs the unit/regression tests, browser smoke tests for the player command bridge, a production build, and a non-blocking dependency audit. Passing automated tests does not replace checking real Twitch OAuth, Firebase rules/environment variables, or real third-party embeds in a browser.

## Deployment

The repository is connected to Vercel for production deployment from `main`. The app uses the Vite framework preset, `npm run build` as the build command, and `dist` as the output directory. Configure environment variables in Vercel, never in committed source files.
