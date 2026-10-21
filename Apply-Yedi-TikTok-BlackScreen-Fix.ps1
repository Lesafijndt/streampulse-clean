$ErrorActionPreference = 'Stop'

$appPath = Join-Path $PSScriptRoot 'src\App.tsx'
if (-not (Test-Path -LiteralPath $appPath)) {
    Write-Host 'ERROR: src\App.tsx was not found.' -ForegroundColor Red
    Write-Host 'Extract this ZIP into the root of your existing Yedi Hub repository (the folder containing package.json), then run this script again.'
    exit 1
}

$content = [System.IO.File]::ReadAllText($appPath)
if ($content -notmatch 'https://www\.tiktok\.com/player/v1/') {
    Write-Host 'ERROR: I could not find the official TikTok player iframe in src\App.tsx. No files were changed.' -ForegroundColor Red
    exit 1
}
if ($content -notmatch 'const handleSkipNext\s*=') {
    Write-Host 'ERROR: I could not find handleSkipNext in src\App.tsx. No files were changed.' -ForegroundColor Red
    exit 1
}
if ($content -notmatch 'const handlePlayNow\s*=') {
    Write-Host 'ERROR: I could not find handlePlayNow in src\App.tsx. No files were changed.' -ForegroundColor Red
    exit 1
}

$original = $content

# Hide routine success/info toast popups for a smoother playback experience.
# Keep warning/error toasts visible so failed requests and real problems are not silent.
$toastSignature = "const addToast = (message, type = 'info') => {"
$quietToastGuard = "if (type === 'info' || type === 'success') return;"
if ($content.Contains($toastSignature) -and -not $content.Contains($quietToastGuard)) {
    $content = $content.Replace(
        $toastSignature,
        $toastSignature + "`r`n    // Seamless mode: suppress routine informational/success popups.`r`n    " + $quietToastGuard
    )
}

# Add a cross-browser, best-effort fullscreen exit helper immediately before handlePlayNow.
if ($content -notmatch 'exitTikTokFullscreenBeforeTrackChange') {
    $helper = @'
  const exitTikTokFullscreenBeforeTrackChange = () => {
    if (typeof document === 'undefined') return;
    try {
      const doc = document as any;
      const fullscreenActive = Boolean(
        doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement
      );
      if (!fullscreenActive) return;
      const exit = doc.exitFullscreen || doc.webkitExitFullscreen ||
        doc.webkitCancelFullScreen || doc.msExitFullscreen;
      if (typeof exit !== 'function') return;
      const result = exit.call(doc);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Best-effort cleanup; switching tracks must continue even if the browser rejects it.
    }
  };

'@
    $playRegex = [regex]::new('(?m)^([ \t]*)const handlePlayNow\s*=\s*\([^\r\n]*\)\s*=>\s*\{\r?\n')
    $playMatch = $playRegex.Match($content)
    if (-not $playMatch.Success) {
        Write-Host 'ERROR: handlePlayNow was found by name, but its declaration format was not recognized. No files were changed.' -ForegroundColor Red
        exit 1
    }
    $content = $content.Insert($playMatch.Index, $helper)
}

# Call the cleanup in both manual Play Now and Skip Next handlers. This also covers the chat !skip command.
$playRegex = [regex]::new('(?m)^([ \t]*)const handlePlayNow\s*=\s*\([^\r\n]*\)\s*=>\s*\{\r?\n')
$playMatch = $playRegex.Match($content)
if ($playMatch.Success) {
    $start = $playMatch.Index + $playMatch.Length
    $windowLength = [Math]::Min(240, $content.Length - $start)
    if ($content.Substring($start, $windowLength) -notmatch 'exitTikTokFullscreenBeforeTrackChange\(\)') {
        $call = $playMatch.Groups[1].Value + '  exitTikTokFullscreenBeforeTrackChange();' + "`r`n"
        $content = $content.Insert($start, $call)
    }
}

$skipRegex = [regex]::new('(?m)^([ \t]*)const handleSkipNext\s*=\s*\([^\r\n]*\)\s*=>\s*\{\r?\n')
$skipMatch = $skipRegex.Match($content)
if ($skipMatch.Success) {
    $start = $skipMatch.Index + $skipMatch.Length
    $windowLength = [Math]::Min(240, $content.Length - $start)
    if ($content.Substring($start, $windowLength) -notmatch 'exitTikTokFullscreenBeforeTrackChange\(\)') {
        $call = $skipMatch.Groups[1].Value + '  exitTikTokFullscreenBeforeTrackChange();' + "`r`n"
        $content = $content.Insert($start, $call)
    }
}

# Give the iframe a request-specific identity when the source still keys it only by post ID.
# Do this before slicing the iframe block because the key appears above the ref prop in JSX.
$content = $content.Replace('key={`tiktok-${currentVideo.videoId}`}', 'key={`tiktok-${currentVideo.id}-${currentVideo.videoId}`}')

# Update only the TikTok iframe block, leaving Twitch/YouTube embeds untouched.
$iframeStart = $content.IndexOf('ref={tiktokIframeRef}', [System.StringComparison]::Ordinal)
if ($iframeStart -lt 0) {
    Write-Host 'ERROR: Could not find the TikTok iframe ref. No files were changed.' -ForegroundColor Red
    exit 1
}
$iframeEnd = $content.IndexOf('/>', $iframeStart, [System.StringComparison]::Ordinal)
if ($iframeEnd -lt 0) {
    Write-Host 'ERROR: Could not find the end of the TikTok iframe element. No files were changed.' -ForegroundColor Red
    exit 1
}
$iframeEnd += 2
$block = $content.Substring($iframeStart, $iframeEnd - $iframeStart)

# Reduce optional TikTok player clutter while preserving play/progress/volume controls.
$block = $block.Replace('timestamp=1', 'timestamp=0')
$block = $block.Replace('description=1', 'description=0')
$block = $block.Replace('music_info=1', 'music_info=0')

# Disable TikTok's own fullscreen button while keeping its other controls enabled.
if ($block -match 'fullscreen_button=1') {
    $block = $block.Replace('fullscreen_button=1', 'fullscreen_button=0')
} elseif ($block -notmatch 'fullscreen_button=0' -and $block -match 'controls=1') {
    $block = [regex]::Replace($block, 'controls=1(?!&fullscreen_button=)', 'controls=1&fullscreen_button=0', 1)
}

# Do not grant fullscreen permission to the cross-origin TikTok iframe.
$block = [regex]::Replace($block, '(allow="[^\"]*?)(?:;\s*)fullscreen(?:;\s*)?([^\"]*")', '$1; $2')
$block = [regex]::Replace($block, '(?m)^[ \t]*allowFullScreen[ \t]*\r?\n', '')

$content = $content.Substring(0, $iframeStart) + $block + $content.Substring($iframeEnd)

# Wrap the app in a top-level error boundary. It cannot catch browser/GPU crashes, but it
# prevents React render/lifecycle errors from taking down the entire dashboard silently.
if ($content -notmatch 'class YediHubAppErrorBoundary') {
    $exportPattern = [regex]::new('(?m)^export default function ([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\{')
    $exportMatch = $exportPattern.Match($content)
    if ($exportMatch.Success) {
        $componentName = $exportMatch.Groups[1].Value
        $replacement = 'function ' + $componentName + 'Content() {'
        $content = $content.Substring(0, $exportMatch.Index) + $replacement + $content.Substring($exportMatch.Index + $exportMatch.Length)
        $boundary = @'

class YediHubAppErrorBoundary extends React.Component<React.PropsWithChildren<{}>, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError(_error: Error): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Yedi Hub render failure', error, info);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <main className="min-h-screen bg-[#090a0f] text-white grid place-items-center p-6">
          <section className="max-w-lg rounded-2xl border border-rose-500/30 bg-[#121622] p-6 space-y-4">
            <h1 className="text-lg font-black">Yedi Hub recovered from a player error</h1>
            <p className="text-sm text-slate-300">The dashboard hit a rendering error. You can try rendering it again or reload the page; this fallback keeps the screen from appearing completely blank when React can recover.</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => this.setState({ hasError: false })} className="rounded-xl bg-purple-600 px-4 py-2 text-sm font-bold">Try again</button>
              <button type="button" onClick={() => window.location.reload()} className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-bold">Reload dashboard</button>
            </div>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

export default function __COMPONENT__() {
  return <YediHubAppErrorBoundary><__COMPONENT__Content /></YediHubAppErrorBoundary>;
}
'@
        $content += $boundary.Replace('__COMPONENT__', $componentName)
    } else {
        Write-Host 'WARNING: Could not recognize the default App component; the TikTok fix will proceed without the React recovery boundary.' -ForegroundColor Yellow
    }
}

if ($content -eq $original) {
    Write-Host 'No changes were needed: the fullscreen guard appears to be already installed.' -ForegroundColor Yellow
    exit 0
}

# Back up the source outside the repository so no backup file is accidentally committed.
$backupPath = Join-Path $env:TEMP ('YediHub-App.tsx-before-tiktok-fix-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bak')
[System.IO.File]::WriteAllText($backupPath, $original, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($appPath, $content, [System.Text.UTF8Encoding]::new($false))

Write-Host ''
Write-Host 'Yedi Hub TikTok transition fix applied.' -ForegroundColor Green
Write-Host 'Changed only src\App.tsx. Login/API files and your other app features were left untouched.'
Write-Host "Backup saved outside the repository: $backupPath"
Write-Host 'Next: open GitHub Desktop, review src/App.tsx, commit, and Push origin.'
