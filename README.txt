YEDI HUB — COMBINED PLAYER / QUEUE / AUDIO / VIDEO-ONLY PATCH

Included changes:
- Fixes the React removeChild crash by making the YouTube IFrame API replace a dynamically-created child inside a stable React-owned host.
- Replaces timestamp swaps in the queue arrows with stable queueOrder values, local reorder, and Firebase persistence when configured.
- Sends TikTok play + unMute when the player reports ready, retries unMute once shortly afterward, and sends another unMute when playback starts.
- Applies video-only TikTok embed settings: disables player controls, progress, play/volume/fullscreen buttons, timestamps, descriptions, music info, captions and the native context menu where supported by TikTok's player.
- Makes the video stage larger in cinema/theatre mode.
- Suppresses routine success/information toast popups while leaving actionable warnings and errors visible.
- Leaves existing authentication/API files untouched.

Install:
1. Extract this ZIP into the existing repository root (the same folder as package.json).
2. Double-click APPLY-FIX.bat. The patch uses Node.js, which is the runtime used by this Vite project.
3. If it reports success, open GitHub Desktop and review the changes to src/App.tsx and src/index.css.
4. From the repo root, run `npm run build`. Commit and push only if the build succeeds.

The patcher creates backups of both modified files in the Windows TEMP folder. It validates the edits before writing and refuses ambiguous source matches.

Limits:
- Browser autoplay policy may still require one manual click before audio is allowed. The patch retries unmute, but cannot override a browser's sound-autoplay policy.
- TikTok may still draw creator/social overlays that its embed settings do not expose for removal.
- This patch preserves existing chat-command code; it does not add a separate Twitch chat-send/OAuth endpoint. A working `!help` response in chat depends on the bot-send integration already being present in your current project.
