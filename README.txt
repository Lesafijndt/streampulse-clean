YEDI HUB PLAYER + QUEUE FIX — VERSION 2

This version fixes the installer's brittle YouTube-effect boundary check. It locates the end of the React effect by its dependency list, and locates the TikTok effect by its actual iframe/event references rather than a specific comment. It has been tested against saved source variants with changed comments and already-applied TikTok video-only query settings, including a second run.

INSTALL
1. Extract this ZIP into the root of your existing streampulse-clean repository (the folder containing package.json). Allow these installer files to overwrite earlier patch installer files.
2. Run APPLY-FIX.bat.
3. If the patch stops with an error, do not commit anything. Send the full error text.
4. If successful, run `npm run build` from the repository root.
5. If the build succeeds, review changes in GitHub Desktop, commit, and push to Vercel.

WHAT IT CHANGES
- src/App.tsx: fixes the YouTube IFrame API mounting into a nested imperative child inside a stable React-owned container, addressing the reported removeChild crash during player switching.
- src/App.tsx: gives active queue entries a dedicated queueOrder, applies arrow reordering across media types, and writes reordered entries via an atomic Firestore batch when cloud sync is available.
- src/App.tsx: sends TikTok play/unMute messages when ready and during playback, with timers cleaned up during track changes.
- src/App.tsx: applies TikTok's supported options to hide playback controls, description, music information, timestamps and caption icon; refreshes the iframe key per request.
- src/App.tsx + src/index.css: retains cinema-sized player and suppresses routine informational/success toasts while preserving warnings/errors.
- No API/Twitch authentication files are changed.

BACKUPS
A copy of src/App.tsx and src/index.css is saved in your Windows temporary directory under yedi-hub-backups before writing.

LIMITS
TikTok's embed settings do not remove every creator attribution element; the account nickname/avatar may remain because the official player preserves attribution. Browser autoplay policy may also require a click before sound is allowed. This patch has not been tested in your live deployed browser. The test environment here lacks the project's Vite dependencies, so you must run `npm run build` locally before pushing.
