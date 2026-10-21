YEDI HUB PATCH — TIKTOK NEXT-TRACK / BLACK-SCREEN FIX

Included files
--------------
src/App.tsx
api/twitch/login.js
api/twitch/callback.js
api/twitch/chat-message.js
api/twitch/bot-login.js
api/twitch/bot-session.js
api/twitch/bot-logout.js

What this patch changes
-----------------------
1. Next-track transitions are now atomic in local React state and sent to Firestore as one write batch. This prevents temporary zero/two-playing-item snapshots while skipping, which could tear down the media iframe as a TikTok item was becoming active.

2. TikTok's official player now receives a stable window reference for the specific iframe/request. Late messages from the previous track cannot issue commands to the next track.

3. TikTok players get a much larger responsive viewport (approximately a 9:16 portrait frame) rather than being squeezed into a narrow 180–220px iframe. This better matches TikTok's documented embed sizing expectations.

4. The app allows a longer startup window before changing players and no longer treats an ordinary pause as a stalled video.

5. If the official player really fails to start, the fallback is TikTok's documented blockquote + https://www.tiktok.com/embed.js embed—not the previous /embed/v2 iframe fallback. The retry/open-on-TikTok recovery controls remain available.

6. The existing one-time unmute request after actual playback remains. Browser autoplay restrictions can still require clicking Enable sound.

7. The existing queue position/vote commands and separate @gachibot69 chat integration are retained.

Install
-------
1. Extract this ZIP into the ROOT of the existing GitHub/Vercel repository. Let the included paths merge and replace matching files.
2. Review the changes in GitHub Desktop, commit, then click Push origin.
3. Wait for Vercel deployment to finish, reload Yedi Hub, and test skipping into at least two different TikTok requests.
4. Test the audio separately. If audible autoplay is blocked by the browser, click Enable sound once.

Important limitation
-------------------
TikTok controls the embed and may reject/limit a particular video or the site's embedding domain. This patch fixes the app-side transition race, improves the player size, and switches to TikTok's documented standard embed on failure, but no website code can guarantee playback for posts TikTok refuses to embed. If both official embed methods fail, the Open TikTok link is the reliable fallback.

Validation
----------
The ZIP is checked for integrity. The changed TSX was parser-checked with TypeScript, but a full production build and live browser playback test were not possible here because the project's npm dependencies are not installed and this patch has not been deployed to your live Vercel site.

Keep TWITCH_CLIENT_SECRET, Firebase service account JSON, and OAuth tokens only in Vercel environment variables. Do not paste secrets into source files or chat.
