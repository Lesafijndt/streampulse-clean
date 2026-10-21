YEDI HUB — SEAMLESS TIKTOK TRANSITION PATCH

This is a targeted in-place patch. It does not replace the project or any Twitch login/API files.

APPLY
1. Extract this ZIP into the root of your existing Yedi Hub repository (the folder containing package.json).
2. Double-click APPLY-FIX.bat and read the PowerShell result.
3. The script backs up src/App.tsx to your Windows TEMP folder before editing. It modifies only src/App.tsx.
4. Delete APPLY-FIX.bat, Apply-Yedi-TikTok-BlackScreen-Fix.ps1, and README.txt from the repository root after it has run successfully.
5. Review src/App.tsx in GitHub Desktop, commit, and Push origin. After Vercel deploys, hard-refresh the site with Ctrl+F5.

CHANGES
- Attempts to exit fullscreen before Play Now / Skip Next transitions.
- Disables TikTok's fullscreen button and removes fullscreen permission from the TikTok iframe.
- Gives each queued request a fresh iframe identity to avoid reusing a stale embed.
- Hides optional TikTok description, music metadata, and timestamp while keeping player controls enabled.
- Suppresses routine success/info toast popups; warning/error messages remain so genuine failures aren't silent.
- Adds a top-level React error boundary that displays a recovery screen if a React render/lifecycle error occurs, instead of leaving a blank app.

LIMITATIONS
This is a best-effort fix, not a guarantee. TikTok owns the cross-origin iframe; this site cannot remove TikTok-controlled prompts, required notices, policy messages, blocked-video screens, or other content rendered inside that iframe. TikTok's supported player parameters only hide specific controls/metadata. A browser/GPU/renderer crash is not catchable by React's error boundary. Test after deployment.
