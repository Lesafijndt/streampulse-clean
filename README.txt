Yedi Hub — TikTok autoplay resume fix

INSTALL
1. Extract this ZIP into the ROOT of your local Yedi Hub repository (the folder containing package.json).
2. Allow it to replace src/App.tsx.
3. In GitHub Desktop, review the changed file, commit, and Push origin.
4. Wait for Vercel to deploy, then test a TikTok queue request.

WHAT CHANGED
- Lets the TikTok iframe autoplay parameter start playback instead of sending a duplicate play command on readiness.
- Requests unmute only once after playback begins.
- If TikTok pauses immediately after the audio request, attempts one resume rather than leaving the player paused.
- Displays a clear fallback if the browser blocks autoplay with sound.

LIMITATION
Browsers can block autoplay with sound in cross-origin embeds. This patch can attempt playback and avoid repeated competing commands, but cannot override the browser's autoplay policy. The full production build was not run because project dependencies are not installed in this environment.
