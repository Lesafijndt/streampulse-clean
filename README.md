# Yedi Hub — Private Twitch Request Deck

A private Vite/React dashboard dedicated to `twitch.tv/2o3a`. Its job is to connect to 2o3a’s Twitch chat in the background and play the links requested with `!assr <URL>`. The public chat transcript is hidden. There is no web-submission form: links enter through `!assr <URL>` in Twitch chat. The app keeps the Gachi Arena / Swedish soap visual theme, with the queue, player, moderation and OBS overlay preserved.

## Access control

Only these Twitch accounts are permitted to sign in:

| Twitch account | Website role |
|---|---|
| `2o3a` | Streamer |
| `paim_beach_pete` | Moderator |

The allowlist is enforced in Vercel API routes after Twitch OAuth; it is not a client-side role selector. Other Twitch accounts receive an access-denied page. The channel is fixed in code to `2o3a`; there is no channel switcher or share-room control, and URL parameters cannot switch it. The IRC command bridge starts only after an approved account is authenticated.

For cloud sync, the server mints a Firebase custom token with `yediAuthorized`, `twitchLogin`, and `role` claims. The supplied `firestore.rules` rejects anonymous users and all sessions lacking these server-issued claims. Keep the Firebase service-account key in Vercel server-only environment variables; never expose it in the browser or commit it to GitHub.

## Twitch OAuth setup

1. Register an application at <https://dev.twitch.tv/console/apps>.
2. Set the app’s OAuth redirect URL to exactly `https://YOUR-VERCEL-DOMAIN/api/twitch/callback`.
3. Add these server-only environment variables in Vercel → Project → Settings → Environment Variables. Do not prefix any with `VITE_`:
   - `TWITCH_CLIENT_ID`
   - `TWITCH_CLIENT_SECRET`
   - `TWITCH_APP_URL` — `https://YOUR-VERCEL-DOMAIN`
   - `TWITCH_REDIRECT_URI` — `https://YOUR-VERCEL-DOMAIN/api/twitch/callback`
4. Redeploy. Only `2o3a` and `paim_beach_pete` will be allowed through the sign-in flow.

## Secure Firebase cloud sync

Cloud sync is optional. Without Firebase configuration, approved users can use local browser storage, but the queue will not sync between devices.

1. Configure these public web-app values in Vercel if you want cross-device queue sync: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`. They must reference the same Firebase project as the service account below. `VITE_FIREBASE_NAMESPACE` is optional; default is `streampulse-live-deck`.
2. In Firebase Console → Project settings → Service accounts, generate a Firebase Admin SDK private key.
3. Add a server-only Vercel environment variable `FIREBASE_SERVICE_ACCOUNT_JSON` containing the full contents of that service-account JSON. Do not prefix it with `VITE_`, do not commit the JSON file, and do not share its private key.
4. Publish this project’s `firestore.rules` in the same Firebase project. Remove the old permissive anonymous-client rules.
5. Redeploy after adding/changing environment variables and rules.

The Firebase Admin SDK signs custom tokens only after Twitch login has been checked against the allowlist. The service-account key stays on the server. Anonymous Firebase sign-in is intentionally not used.

## Deploy with GitHub Desktop

1. Extract this ZIP.
2. In GitHub Desktop choose Repository → Show in Explorer.
3. Copy the **contents** of the extracted folder into your repository folder, including `index.html`, `package.json`, `src/`, `api/`, `firestore.rules`, and `vercel.json`. Keep the repository’s `.git` folder.
4. Commit to `main`, then click **Push origin**.
5. In Vercel deploy the pushed commit using framework preset **Vite**, build command `npm run build`, and output directory `dist`.
6. Add the environment variables above and redeploy.

## Main behavior

- The page is fixed to `twitch.tv/2o3a`.
- `!assr <URL>` requests enter the queue from Twitch chat. The site does not render a chat transcript or show a manual website-request form.
- The hidden Twitch IRC bridge runs only while the site or OBS browser source is open and an approved user is signed in. Vercel does not keep a browser WebSocket alive while every browser is closed.
- YouTube/TikTok/Twitch clip embeds and queue controls are retained. Some browsers may block autoplay with sound until playback is started manually once.
- Twitch OAuth cookies are HttpOnly and SameSite=Lax; production cookies use Secure. Logging out clears the Twitch session and signs out Firebase.
