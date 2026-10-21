YEDI HUB — LOGIN RECOVERY + LATEST PLAYER/HELP PATCH

Why this patch exists
---------------------
The previous full-project ZIP accidentally replaced the newer Twitch auth/chat-bot files with older versions. This overlay restores the newer auth flow and dedicated gachibot69 chat account while keeping the queue/vote/position features, new !help command, and larger cinema player.

Files included
--------------
src/App.tsx
src/index.css
api/twitch/login.js
api/twitch/callback.js
api/twitch/chat-message.js
api/twitch/bot-login.js
api/twitch/bot-session.js
api/twitch/bot-logout.js

Install
-------
1. Extract this ZIP.
2. Copy its contents into the ROOT of your existing GitHub/Vercel repository, allowing these files to replace matching files. Do not replace or delete .git, package.json, .env files, api/twitch/session.js, or other files not included here.
3. In GitHub Desktop, review the changed files, commit, and Push origin.
4. Wait for the Vercel deployment to finish, then open https://streampulse-clean.vercel.app and sign in again.
5. In the dashboard, connect the separate @gachibot69 account using Connect Bot if its status is disconnected. The dashboard itself still only allows 2o3a and paim_beach_pete.

The login patch preserves OAuth state validation and does not weaken the account allowlist. It has been assembled and checked for ZIP integrity, but a production login test cannot be run from this environment.
