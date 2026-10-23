# WHALE CUM — Private Twitch Request Deck

WHALE CUM is a private Vite + React dashboard for running a community media queue on Twitch channel `2o3a`. It combines a live player, a shared queue, Twitch chat requests and voting, activity analytics, local recovery snapshots, and optional Firebase cloud synchronization. The UI uses a dark crimson, wine, and purple gachi-wrestling theme.

## What it does

- **Shared queue:** Accepts supported YouTube videos and Shorts, TikTok videos, Twitch Clips, and Kick Clips. The dashboard can also add media directly; title-based chat requests search YouTube and use the best match returned by the search route.
- **Queue management:** Active Queue, Watch Later, and History views; search; category and media-type filters; sorting for non-active lists; upvotes; pinned priority; drag-and-drop ordering and move controls; Play Now; Previous Video and Next Video; and automatic advance when the player reports that media ended.
- **Playback:** A large theatre-style player for YouTube and vertical TikTok embeds, plus supported Twitch Clip embeds and source links for media that cannot play inline. Playback, mute, and volume controls vary by provider; the dashboard reports when a provider does not expose a remote control.
- **Twitch chat requests:** Regular viewers can request supported links or use `!assr <URL or title>` in Twitch chat. Twitch EventSub stores eligible requests in a durable Firestore inbox when cloud intake is healthy. If it is inactive, the signed-in moderator dashboard runs the local IRC fallback and shows requests in that browser; those requests still require a working shared Firestore write to appear on other browsers. Volume controls depend on the browser playing the media.
- **Stats & analytics:** Request totals, completions, skips, votes, estimated queue runway, and a Top 10 Requesters list. Activity can be viewed for lifetime, the last 24 hours, or the current browser-tab session.
- **Recovery:** Queue and settings are saved locally, with backup export/import and safety-snapshot recovery. With Firebase configured, authorized sessions can synchronize the shared queue and activity log across browsers.

## Access and authentication

Only the Twitch accounts below are allowed to sign in to the dashboard:

| Twitch account | Role |
|---|---|
| `2o3a` | Streamer |
| `paim_beach_pete` | Moderator |

The allowlist is enforced by the Vercel OAuth/session API, not a client-side role selector. `2o3a` gets a playback-first dashboard and owns automatic playback advance. The moderator account `paim_beach_pete` runs the local IRC fallback when cloud intake is inactive and gets the connection controls plus an expanded, read-only **Technical diagnostics** panel with safe Firebase/EventSub diagnostics, last webhook and successful queue-write times, queue version, and configuration-presence checks; secret values are never shown. Healthy EventSub intake works without either dashboard staying open.

## Chat commands

| Command | Behavior |
|---|---|
| `!assr <URL or title>` | Request supported media by URL or search YouTube by title. YouTube links may include `?t=83`, `?start=83`, `#t=1m23s`, or a timestamp after the link such as `1:23`. |
| A supported media URL anywhere in a message | Direct YouTube, TikTok, Twitch Clip, or Kick Clip links are treated as requests even with surrounding text or trailing punctuation. |
| `!remove` / `!unrequest` | Remove your latest eligible waiting request. |
| `!when`, `!position`, `!myqueue`, `!queueposition` | Show your queue position/ETA where available. |
| `!queue` | Show queue status and summary. |
| `!bigcock` / `!bigcock 3` | Upvote the first or a numbered waiting queue item, respectively. You cannot vote for your own request and may vote only once per video. |
| `!help` | Show user and moderator command help. |
| Moderator/broadcaster: `!skip` | Advance to the next video. |
| Moderator/broadcaster: `!volume up/down`, `!volume 0-100`, `!volup`, `!voldown`, `!mute`, `!unmute` | Control supported player audio. TikTok remote commands support mute/unmute and volume 0/100; use the in-player slider for intermediate volume. Twitch Clips use their own controls. |

Requests are blocked while the streamer has closed the queue. Queue/playing items cannot be requested twice, and videos in History become requestable again 16 hours after their last `watchedAt` time. Media identity stays consistent across URL formats and tracking parameters. Twitch chat requests accept timestamps such as `1:23`, `1:02:03`, `83s`, or YouTube `?t=83` / `#t=1m23s` markers. The dashboard request form also has a dedicated YouTube start-time field; its offset is applied when the embed loads. Other provider embeds do not expose a consistent timestamp-seek API.

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

### Enable cloud chat intake (one time)

1. Open the production WHALE CUM dashboard and sign in as `2o3a`. The app attempts cloud intake setup automatically. If authorization is needed, use the moderator's connection details to identify the missing scope; Twitch must grant `channel:bot` to this app.
2. Use **Reconnect @gachibot69** if the dashboard prompts for it. That account must grant `user:read:chat`, `user:write:chat`, and `user:bot` to the same Twitch developer application.
3. Keep the dashboard open until **Cloud chat intake** reports **active**. Vercel creates a webhook subscription for `channel.chat.message`; Twitch verifies the callback and the app reports whether the subscription is active.
4. Once active, EventSub first persists supported media requests and queue commands in a durable inbox and acknowledges the webhook quickly. A Vercel `waitUntil` task processes the inbox, writes queue/stat updates transactionally, and leaves failures pending for a later retry. Server-side commands include `!queue`, `!when`, `!remove`, `!bigcock`, `!help`, and moderator/broadcaster `!skip`. Queue status shows the last successful server queue write. The streamer's browser does not need to be open to queue requests; volume changes still require the player browser.
5. If the status mentions Firestore unavailable, check service-account project/permissions and the Firebase usage/quota dashboard. Server-side writes still depend on the Firebase project being available and within quota; a webhook cannot save to the cloud when Firestore rejects the write.

The server issues a Firebase custom token only after validating an approved Twitch session. The token carries `yediAuthorized`, `twitchLogin`, and `role` claims. Firebase writes require these server-issued claims.

## Backups and troubleshooting

- Export a queue backup before major changes. The dashboard supports importing a valid JSON backup and restoring the last local safety snapshot.
- Treat the cloud-sync indicator as authoritative for cross-browser sync. A local save protects this browser, but local-only changes do not guarantee that another browser has received them.
- A provider may block autoplay with sound until a staff member starts playback manually. TikTok, Twitch Clips, and Kick Clips expose different embed/control capabilities; some items may have to be opened from their source page.
- If cloud chat intake is not **active**, the moderator dashboard provides a local IRC fallback while it stays open. Check its connection details for the missing Twitch scope, bot authorization, EventSub setup, or Firebase availability. A Firestore write failure leaves a pending local recovery item, not a confirmed shared request.

## Development and verification

Requires Node.js 22 (see `.nvmrc`). Install dependencies and run:

```sh
npm install
npm test
npm run build
```

The GitHub Actions build check runs the unit/regression tests, browser smoke tests for the player command bridge, a production build, and a non-blocking dependency audit. Passing automated tests does not replace checking real Twitch OAuth, Firebase rules/environment variables, or real third-party embeds in a browser.

## Deployment

The repository is connected to Vercel for production deployment from `main`. The app uses the Vite framework preset, `npm run build` as the build command, and `dist` as the output directory. The four Twitch login/logout URLs rewrite to one shared handler to stay under the Vercel Hobby limit of 12 serverless functions; `.github/workflows/build.yml` includes a test to prevent exceeding that limit. Configure environment variables in Vercel, never in committed source files.
