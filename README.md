# StreamPulse Gachi Arena — Live Hub

React + Vite + Tailwind CSS frontend for the StreamPulse Gachi Arena Twitch media request hub, with a crimson-neon gym/retro-meme aesthetic.

## Features retained from the modified source

- Request deck with queue, watch-later, watched, and pending states
- Title/category detection (labels only), unfiltered media requests, and queue moderation settings
- Gachi Arena visual theme: crimson neon, warm amber, steel-black panels, and bold arena-style headings
- OBS overlay mode
- Hidden/read-only Twitch IRC command bridge (no visible chat transcript); supports `!assr`, `!skip`, `!hype`, and staff volume commands
- Optional Firebase Authentication + Cloud Firestore real-time queue and per-channel settings sync
- Browser `localStorage` fallback when Firebase is not configured or unavailable
- Auto reconnects the Twitch IRC bridge while the site/OBS browser source remains open
- Automatic Music/Non-Music labels, enriched with public oEmbed titles when providers allow it

## Run locally

The `api/resolve-tiktok.js` and `api/media-metadata.js` endpoints run as Vercel Functions. They are included for TikTok short-link resolution and best-effort title lookup for Music/Non-Music classification. A plain local Vite dev server does not automatically run these endpoints; use full links while developing locally, or test with Vercel CLI. `vercel.json` intentionally avoids a catch-all SPA rewrite so `/api/*` requests are not rewritten to `index.html`; the app uses query parameters, not pathname-based client routes.

1. Install Node.js LTS.
2. Run `npm install`.
3. Run `npm run dev` and open the local URL printed by Vite.
4. Run `npm run build` to make a production build in `dist/`.

## Deploy to Vercel without Firebase

No environment variables are required. Browser-local persistence works by default. The queue is saved separately for each room in the browser's `localStorage`; it does not automatically synchronize with a different browser or device.

Push this project to your existing GitHub repository, then import or redeploy that repository in Vercel. Vercel settings:

- Framework preset: Vite
- Install command: `npm install`
- Build command: `npm run build`
- Output directory: `dist`

## Optional Firebase cloud sync

Firebase is optional. Configure it to share a queue in real time across browsers/devices.

1. Create/select a Firebase project at https://console.firebase.google.com/.
2. Register a Web App and copy its config values.
3. In **Authentication → Sign-in method**, enable **Anonymous**.
4. Create a **Cloud Firestore** database.
5. Publish the contents of `firestore.rules` in Firestore's Rules tab.
6. Add these variables in Vercel under **Project → Settings → Environment Variables** (Production and Preview as needed):
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_STORAGE_BUCKET`
   - `VITE_FIREBASE_MESSAGING_SENDER_ID`
   - `VITE_FIREBASE_APP_ID`
   - optionally `VITE_FIREBASE_NAMESPACE` (default `streampulse-live-deck`)
7. Redeploy after adding or changing environment variables.

To open a broadcaster's saved room on another browser/device, visit `https://YOUR-VERCEL-DOMAIN/?channel=their_twitch_login`. The site loads that room's cloud queue/settings and automatically starts the IRC bridge while the page remains open.

For local Firebase development, copy `.env.example` to `.env.local` and fill in the values. Do not commit `.env.local`.

### Security note

The supplied Firestore rules are deliberately a basic public-demo setup. Anonymous sign-in does not prove someone is the broadcaster or a moderator; the role switcher in this UI is only a simulation. Anyone using the public site can potentially alter public queue documents if these rules are deployed. Before relying on it for a real stream, add verified Twitch OAuth and enforce broadcaster/moderator permissions in trusted server-side code or stricter security rules.

## Important behavior

- `localStorage` persistence works automatically but is specific to the browser/device. Cloud queue/settings are cross-device only after Firebase config, Anonymous Authentication, Firestore and the supplied rules are set up.
- Firebase sync only activates if all required Firebase environment variables are set and Anonymous Authentication + Firestore are enabled.
- The visible chat panel is removed. The hidden Twitch IRC command bridge is anonymous/read-only, auto-connects to the saved channel when the page opens, and retries transient disconnects. It can read IRC role tags, but it does not authenticate a Twitch account and cannot send messages to Twitch.
- YouTube is driven by the YouTube IFrame Player API and requests autoplay with audio enabled; it advances the queue on the real ended event. Browsers may block autoplay with sound until the viewer clicks Play once. The app does not deliberately mute YouTube playback.
- TikTok requests with a full public video URL containing `/video/{numeric-id}` use TikTok's official embedded player, shown in a portrait frame centered in the main player. Short TikTok share links are sent to the `/api/resolve-tiktok` Vercel function for domain-restricted redirect resolution; if TikTok blocks the redirect or the post is private/removed, the user is asked to supply a full URL. TikTok may still block autoplay due to browser or post-level restrictions.
- Twitch clips use Twitch's official clip embed with autoplay requested and muted=false so sound is enabled when the browser permits it. Twitch's clip iframe does not expose the same player-ended JavaScript API, so automatic queue advance at the end of a Twitch clip is not guaranteed; the Skip Next control remains available.
- Incoming chat is never rendered in the site. Twitch IRC is used only to process commands from the selected channel. The bridge filters known bot names and available bot tags, though anonymous IRC is not a reliable bot-classification service.
- Twitch chat requests use `!assr <url> [optional title/note]`. The old `!sr`, `!songrequest`, and `!request` request triggers are no longer used. All recognized platforms and categories are accepted while the queue is open; category detection provides labels only. Optional moderator approval sends accepted requests to Pending instead of rejecting them.
- Broadcaster/moderator IRC commands: `!skip`; `!volume up` / `!volup`; `!volume down` / `!voldown`; `!volume 0-100`; `!mute`; `!unmute`. Commands are honored only when Twitch IRC tags identify the sender as broadcaster or moderator.
- Remote volume changes are fully adjustable for YouTube. TikTok’s official embed only supports remote mute/unmute, so use the TikTok player’s own slider for precise levels. Twitch Clip embeds do not expose a remote volume API, so adjust volume inside the Clip player.

## Always-on and cloud behavior

Vercel keeps the deployed website available, but it does not keep a client-side WebSocket running when every browser/OBS source is closed. Queue/settings data remain stored in Firestore when cloud sync is configured. The Twitch IRC bridge auto-connects and reconnects whenever the page is open; an actual always-on Twitch listener while all browsers are closed requires a separately hosted worker or Twitch EventSub-based server integration.

Security note: the included Firestore rules are permissive demo rules for signed-in anonymous clients, so anyone who can reach the public app can potentially edit public room settings or queue documents. Do not treat this as production-secure multi-tenant storage without verified Twitch identity and server-side authorization.


## Custom Gachi background and channel defaults

The app now uses `public/gachi-arena-bg.webp` as a darkened, softened background with visible crimson/purple gachi artwork and ♂ accents. The default channel is intentionally blank: enter the intended Twitch login in the header and press Enter, or share a URL using `?channel=TWITCH_LOGIN`. A new local-storage namespace prevents the prior hard-coded room/profile from being silently restored.


### Optional default Twitch channel

Set `VITE_DEFAULT_TWITCH_CHANNEL` in Vercel if this deployment is dedicated to one broadcaster. Leave it blank for a neutral site that asks the operator to choose a channel, or use the `?channel=TWITCH_LOGIN` room link for each channel. A selected room is saved in the current browser; the shareable channel URL is the portable way to open the same room on another device.
