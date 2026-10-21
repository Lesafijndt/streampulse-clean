$ErrorActionPreference = 'Stop'

$appPath = Join-Path $PSScriptRoot 'src\App.tsx'
if (-not (Test-Path -LiteralPath $appPath)) {
    Write-Host 'ERROR: src\App.tsx was not found.' -ForegroundColor Red
    Write-Host 'Extract this ZIP into your existing Yedi Hub repository root (the folder containing package.json).'
    exit 1
}

$content = [System.IO.File]::ReadAllText($appPath)
$newQuery = 'autoplay=1&muted=0&controls=0&progress_bar=0&play_button=0&volume_control=0&fullscreen_button=0&timestamp=0&description=0&music_info=0&closed_caption=0&native_context_menu=0&rel=0'
if ($content.Contains($newQuery)) {
    Write-Host 'TikTok video-only embed settings are already installed.' -ForegroundColor Yellow
    exit 0
}

# Match only the TikTok iframe src template, regardless of the current query-string options.
# No React effect/cleanup/state-code signatures are required for this UI-only change.
$pattern = 'src=\{`https://www\.tiktok\.com/player/v1/\$\{currentVideo\.videoId\}\?[^`]*`\}'
$regex = [System.Text.RegularExpressions.Regex]::new($pattern)
$matches = $regex.Matches($content)
if ($matches.Count -ne 1) {
    Write-Host "ERROR: Expected exactly one TikTok player URL template; found $($matches.Count)." -ForegroundColor Red
    Write-Host 'No files were changed. Please send this message and do not push anything.'
    exit 1
}

$newSrc = 'src={`https://www.tiktok.com/player/v1/${currentVideo.videoId}?' + $newQuery + '`}'
$original = $content
$content = $regex.Replace($content, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $newSrc }, 1)
if ($content -eq $original -or -not $content.Contains($newQuery)) {
    Write-Host 'ERROR: The TikTok embed URL could not be updated safely. No files were changed.' -ForegroundColor Red
    exit 1
}

# Validate all the intended controls are explicitly disabled before writing anything.
foreach ($flag in @('controls=0','progress_bar=0','play_button=0','volume_control=0','fullscreen_button=0','timestamp=0','description=0','music_info=0','closed_caption=0','native_context_menu=0')) {
    if (-not $content.Contains($flag)) {
        Write-Host "ERROR: Validation failed for $flag. No files were changed." -ForegroundColor Red
        exit 1
    }
}

$backupPath = Join-Path $env:TEMP ('YediHub-App-before-video-only-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bak')
[System.IO.File]::WriteAllText($backupPath, $original, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($appPath, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host ''
Write-Host 'TikTok playback controls and optional metadata have been hidden.' -ForegroundColor Green
Write-Host 'Only src\App.tsx was changed. Queue logic and Twitch authentication were not touched.'
Write-Host "Original App.tsx backup: $backupPath"
Write-Host 'Review the diff in GitHub Desktop, then commit and Push origin.'
Write-Host 'Note: TikTok may still display creator/social overlays because these are not exposed as hideable player options.' -ForegroundColor Yellow
