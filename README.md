# StreamPulse Live Hub

React + Vite + Tailwind CSS frontend for the StreamPulse Twitch live video/song request hub.

## Features retained from the modified source

- Request deck with queue, watch-later, watched, and pending states
- Title/category detection (labels only), unfiltered media requests, and queue moderation settings
- OBS overlay mode
- Read-only Twitch IRC chat panel; no fabricated chat messages or local fake sender; common bot accounts are filtered
- Optional Firebase Authentication + Cloud Firestore real-time sync
- Browser `localStorage` persistence when Firebase is not configured or unavailable

## Run locally

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

For local Firebase development, copy `.env.example` to `.env.local` and fill in the values. Do not commit `.env.local`.

### Security note

The supplied Firestore rules are deliberately a basic public-demo setup. Anonymous sign-in does not prove someone is the broadcaster or a moderator; the role switcher in this UI is only a simulation. Anyone using the public site can potentially alter public queue documents if these rules are deployed. Before relying on it for a real stream, add verified Twitch OAuth and enforce broadcaster/moderator permissions in trusted server-side code or stricter security rules.

## Important behavior

- `localStorage` persistence works automatically but is specific to the browser/device.
- Firebase sync only activates if all required Firebase environment variables are set and Anonymous Authentication + Firestore are enabled.
- Twitch IRC in this client is anonymous read-only chat. It cannot send chat messages to Twitch, authenticate a real Twitch user, or verify subscriber/moderator status.
- YouTube is driven by the YouTube IFrame Player API and requests autoplay with audio enabled; it advances the queue on the real ended event. Browsers may block autoplay with sound until the viewer clicks Play once. The app does not deliberately mute YouTube playback.
- TikTok requests with a full public video URL containing `/video/{numeric-id}` use TikTok's official embedded player; shortened `vm.tiktok.com` / `vt.tiktok.com` links must be opened and copied as a full video URL before submission. TikTok may still block autoplay due to browser or post-level restrictions.
- Twitch clips use Twitch's official clip embed with autoplay requested and muted=false so sound is enabled when the browser permits it. Twitch's clip iframe does not expose the same player-ended JavaScript API, so automatic queue advance at the end of a Twitch clip is not guaranteed; the Skip Next control remains available.
- The chat panel only displays messages received from the selected Twitch channel over anonymous read-only IRC. It filters several common bot accounts and any IRC bot tag if supplied, but unknown/custom bots cannot be perfectly identified from public chat data. Sending messages must be done directly in Twitch chat; the site does not send chat messages.
- Chat requests use `!assr <url> [optional title/note]`. The old `!sr`, `!songrequest`, and `!request` request triggers are no longer used. All recognized platforms and categories are accepted while the queue is open; category detection provides labels only. Optional moderator approval sends accepted requests to Pending instead of rejecting them.
- Broadcaster/moderator IRC commands: `!skip`; `!volume up` / `!volup`; `!volume down` / `!voldown`; `!volume 0-100`; `!mute`; `!unmute`. Commands are honored only when Twitch IRC tags identify the sender as broadcaster or moderator.
- Remote volume changes are fully adjustable for YouTube. TikTok’s official embed only supports remote mute/unmute, so use the TikTok player’s own slider for precise levels. Twitch Clip embeds do not expose a remote volume API, so adjust volume inside the Clip player.
