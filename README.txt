YEDI HUB PATCH — TIKTOK RECOVERY + GACHIBOT69 CHAT REPLIES

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
1. TikTok player transitions
   - Ensures every requested TikTok post gets a fresh iframe instance.
   - Waits for actual player playback signals instead of treating iframe load / player-ready as proof it is playing.
   - Tries TikTok's standard embed if the official player does not start or stalls.
   - Shows a recovery prompt if the fallback loads but still appears black, with a direct Open TikTok link and a Retry player button.
   - Does not automatically force sound on, since browser autoplay restrictions can pause embedded playback.
   NOTE: TikTok's own player or browser policies can still block playback on some posts. No third-party embed patch can guarantee sound/autoplay for every TikTok post.

2. Chat replies through @gachibot69
   - Dashboard sign-in remains restricted to 2o3a and paim_beach_pete.
   - The bot account has a separate OAuth login and separate HttpOnly cookies; it does not gain dashboard access.
   - Outgoing queue-position/voting replies are sent through Twitch's Send Chat Message API as gachibot69.
   - The send API validates both the staff dashboard session and the bot session, and only targets 2o3a's channel.
   - Staff and bot tokens can refresh independently.

3. Queue features retained
   - !position / !queue / !when and aliases report the requester's queue positions and estimated waiting time.
   - !bigcock [position] upvotes a queued video; upvotes affect queue priority.
   - A requester cannot upvote their own request; each username may vote once per video and can vote on different videos.

Install instructions
--------------------
1. Extract this ZIP into the ROOT of the existing Vercel/GitHub repository. Allow the listed files to merge/replace their matching paths.
2. In GitHub Desktop, review the changes, commit, and click Push origin.
3. Wait until Vercel finishes deploying. This ZIP has not been deployed to your live site by this tool.
4. Open the deployed dashboard and sign in with 2o3a or paim_beach_pete as usual.
5. In the top header, click "Connect @gachibot69". Complete Twitch login as gachibot69 and approve the chat-write permission. If Twitch starts with the wrong account, sign out of Twitch in that browser or switch accounts, then retry.
6. The bot account must be allowed to chat in 2o3a's Twitch channel. Test a queue-position command such as !position, and confirm the reply appears as gachibot69.
7. Test skipping into a TikTok. If the embedded player remains black, use the on-screen Open TikTok or Retry player prompt; TikTok can restrict playback in third-party embeds.

Environment variables
---------------------
No new Vercel environment variables or callback URLs are required. Keep the existing TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_APP_URL and TWITCH_REDIRECT_URI values unchanged. The callback URI remains:
https://streampulse-clean.vercel.app/api/twitch/callback

Security note
-------------
Never place Twitch client secrets, Firebase service-account JSON, or OAuth tokens in this ZIP, frontend source, or chat. Keep secret values only in Vercel environment variables.

Validation note
---------------
The updated API JavaScript and TSX syntax were checked. A full production build and live browser/Twitch test were not run in this environment.
