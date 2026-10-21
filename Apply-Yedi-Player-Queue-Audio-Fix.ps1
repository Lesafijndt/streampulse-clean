$ErrorActionPreference = 'Stop'

$appPath = Join-Path $PSScriptRoot 'src\App.tsx'
if (-not (Test-Path -LiteralPath $appPath)) {
    Write-Host 'ERROR: src\App.tsx was not found.' -ForegroundColor Red
    Write-Host 'Extract this ZIP into your existing Yedi Hub repository root (the folder containing package.json).'
    exit 1
}

$content = [System.IO.File]::ReadAllText($appPath)
if ($content.Contains('YEDI_PLAYER_QUEUE_AUDIO_FIX_V3')) {
    Write-Host 'The player/queue/audio fix is already installed.' -ForegroundColor Yellow
    exit 0
}

$required = @(
    'const currentVideo = useMemo(() => {',
    'const handleMoveOrder = (videoId, direction) => {',
    'ref={youtubePlayerContainerRef}',
    "data.type === 'onPlayerReady'",
    "data.type === 'onCurrentTime' && data.value"
)
foreach ($signature in $required) {
    if (-not $content.Contains($signature)) {
        Write-Host "ERROR: Expected player source signature was not found: $signature" -ForegroundColor Red
        Write-Host 'No files were changed. This source differs from the version this patch targets.'
        exit 1
    }
}

$original = $content

# Explicit, stable ordering fixes collisions caused by equal Date.now() values and async swaps.
if (-not $content.Contains('const queueOrderValue = (video) =>')) {
    $helperAnchor = '  const currentVideo = useMemo(() => {'
    $queueHelpers = @'
  // YEDI_PLAYER_QUEUE_AUDIO_FIX_V3: persist a stable FIFO order; old records fall back to timestamp.
  const queueOrderValue = (video) => {
    const storedOrder = Number(video?.queueOrder);
    if (Number.isFinite(storedOrder) && storedOrder > 0) return storedOrder;
    const legacyTimestamp = Number(video?.timestamp);
    return Number.isFinite(legacyTimestamp) ? legacyTimestamp : 0;
  };
  const compareQueueOrder = (a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return queueOrderValue(a) - queueOrderValue(b) || String(a.id).localeCompare(String(b.id));
  };
  const getNextQueueOrder = () => videos
    .filter((video) => video.status === 'queue')
    .reduce((maxOrder, video) => Math.max(maxOrder, queueOrderValue(video)), 0) + 1000;

'@
    $content = $content.Replace($helperAnchor, $queueHelpers + $helperAnchor)
}

# Replace all legacy FIFO timestamp comparisons with the stable comparator.
$content = $content.Replace('(a.timestamp || 0) - (b.timestamp || 0)', 'compareQueueOrder(a, b)')

# Assign an explicit queueOrder to newly submitted and re-queued entries.
if (-not $content.Contains('queueOrder: getNextQueueOrder()')) {
    # Locate the note field without relying on Windows/Linux line-ending conventions.
    $requestNoteMatch = [regex]::Match($content, '(?m)^      note: note \|\| `Added to \$\{channelRoom\} deck`,')
    if (-not $requestNoteMatch.Success) {
        Write-Host 'ERROR: Could not find the new-request note field. No files were changed.' -ForegroundColor Red
        exit 1
    }
    $content = $content.Insert($requestNoteMatch.Index, "      queueOrder: getNextQueueOrder(),`r`n")
}

if (-not $content.Contains("addedAt: 'Re-queued'")) {
    Write-Host 'ERROR: Could not find the re-queue action. No files were changed.' -ForegroundColor Red
    exit 1
}
if ($content -notmatch "(?s)status: 'queue',\s*timestamp: Date\.now\(\),\s*queueOrder: getNextQueueOrder\(\),\s*addedAt: 'Re-queued'") {
    $requeueAnchor = [regex]::Match($content, "(?m)^      addedAt: 'Re-queued'")
    if ($requeueAnchor.Success -and $content.Substring([Math]::Max(0, $requeueAnchor.Index - 120), [Math]::Min(120, $requeueAnchor.Index)) -notmatch 'queueOrder: getNextQueueOrder') {
        $content = $content.Insert($requeueAnchor.Index, "      queueOrder: getNextQueueOrder(),`r`n")
    }
}

# Legacy pending entries without a queueOrder join the end when approved.
$content = $content.Replace("syncUpdateVideo(video.id, { status: 'queue' });", "syncUpdateVideo(video.id, { status: 'queue', queueOrder: Number(video.queueOrder) > 0 ? video.queueOrder : getNextQueueOrder() });")

# Replace the fragile two-timestamp swap with one local transaction + persisted order updates.
$movePattern = '(?s)  const handleMoveOrder = \(videoId, direction\) => \{.*?^  \};(?=\r?\n\r?\n  // Room switching is disabled)'
$moveMatch = [regex]::Match($content, $movePattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
if (-not $moveMatch.Success) {
    Write-Host 'ERROR: Could not isolate handleMoveOrder. No files were changed.' -ForegroundColor Red
    exit 1
}
$newMove = @'
  const handleMoveOrder = (videoId, direction) => {
    if (!isStaff) return;

    // Capture the adjacent visible queue entry; the explicit queueOrder persists the move.
    const visibleQueue = filteredVideos.filter((video) => video.status === 'queue');
    const visibleIndex = visibleQueue.findIndex((video) => video.id === videoId);
    if (visibleIndex < 0) return;
    const targetIndex = direction === 'up' ? visibleIndex - 1 : visibleIndex + 1;
    if (targetIndex < 0 || targetIndex >= visibleQueue.length) return;

    const item = visibleQueue[visibleIndex];
    const target = visibleQueue[targetIndex];
    // Pinned entries intentionally remain above ordinary entries.
    if (Boolean(item.pinned) !== Boolean(target.pinned)) return;

    const orderedQueue = videos.filter((video) => video.status === 'queue').sort(compareQueueOrder);
    const itemIndex = orderedQueue.findIndex((video) => video.id === item.id);
    const destinationIndex = orderedQueue.findIndex((video) => video.id === target.id);
    if (itemIndex < 0 || destinationIndex < 0 || itemIndex === destinationIndex) return;

    const reordered = [...orderedQueue];
    [reordered[itemIndex], reordered[destinationIndex]] = [reordered[destinationIndex], reordered[itemIndex]];
    const orderById = new Map(reordered.map((video, index) => [video.id, (index + 1) * 1000]));
    const updates = reordered.map((video, index) => ({ ...video, queueOrder: (index + 1) * 1000 }));

    setSortBy('priority');
    setVideos((previous) => previous.map((video) => {
      const nextOrder = orderById.get(video.id);
      return nextOrder === undefined ? video : { ...video, queueOrder: nextOrder };
    }));

    // Persist order fields together so independent timestamp writes cannot race.
    if (db && firebaseUser) {
      Promise.all(updates.map(async (video) => {
        const itemRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', String(video.id));
        try {
          await updateDoc(itemRef, { queueOrder: video.queueOrder });
        } catch (error) {
          await setDoc(itemRef, { ...video, queueOrder: video.queueOrder, channelRoom: normalizeRoomName(channelRoom) }, { merge: true });
        }
      })).catch((error) => {
        console.warn('Could not persist queue ordering; the new order remains saved locally.', error);
        setCloudSynced(false);
        setSyncStatusText('Queue order saved locally — cloud update failed');
      });
    }
  };
'@
$content = $content.Substring(0, $moveMatch.Index) + $newMove + $content.Substring($moveMatch.Index + $moveMatch.Length)

# YouTube's IFrame API replaces its target div with an iframe. Nest that target inside a keyed,
# React-owned wrapper so React removes only the wrapper when the active platform changes.
$youtubeTarget = '                    <div ref={youtubePlayerContainerRef} className="w-full h-full" />'
if ($content.Contains($youtubeTarget)) {
    $youtubeWrapper = @'
                    <div key={`youtube-${currentVideo.id}-${currentVideo.videoId}`} className="w-full h-full">
                      <div ref={youtubePlayerContainerRef} className="w-full h-full" />
                    </div>
'@
    $content = $content.Replace($youtubeTarget, $youtubeWrapper.TrimEnd())
} elseif (-not $content.Contains('key={`youtube-${currentVideo.id}-${currentVideo.videoId}`}')) {
    Write-Host 'ERROR: Could not safely wrap the YouTube iframe API target. No files were changed.' -ForegroundColor Red
    exit 1
}

# TikTok supports unMute/play via postMessage. muted=0 enables its volume control but does not
# guarantee that the player will unmute after autoplay, so explicitly command and retry unmute.
$tiktokGuard = "    if (!currentVideo || currentVideo.platform !== 'tiktok' || !currentVideo.videoId) return undefined;"
if (-not $content.Contains('const postTikTokCommand = (targetWindow, type) =>')) {
    if (-not $content.Contains($tiktokGuard)) {
        Write-Host 'ERROR: Could not find the TikTok player effect guard. No files were changed.' -ForegroundColor Red
        exit 1
    }
    $tiktokHelpers = @'
    const retryTimers = [];
    const postTikTokCommand = (targetWindow, type) => {
      if (!targetWindow) return;
      try {
        targetWindow.postMessage({ type, value: null, 'x-tiktok-player': true }, 'https://www.tiktok.com');
      } catch { /* iframe may be navigating */ }
    };

'@
    $content = $content.Replace($tiktokGuard, $tiktokGuard + "`r`n`r`n" + $tiktokHelpers.TrimEnd())
}

$readyStart = $content.IndexOf("      if (data.type === 'onPlayerReady') {")
$readyEndMarker = "      } else if (data.type === 'onCurrentTime' && data.value) {"
$readyEnd = if ($readyStart -ge 0) { $content.IndexOf($readyEndMarker, $readyStart) } else { -1 }
if ($readyStart -lt 0 -or $readyEnd -lt 0) {
    Write-Host 'ERROR: Could not safely update the TikTok ready handler. No files were changed.' -ForegroundColor Red
    exit 1
}
$newReady = @'
      if (data.type === 'onPlayerReady') {
        const playerWindow = tiktokIframeRef.current?.contentWindow;
        if (playerWindow) {
          postTikTokCommand(playerWindow, 'unMute');
          postTikTokCommand(playerWindow, 'play');
          [250, 700, 1400].forEach((delay) => {
            const timer = window.setTimeout(() => {
              if (tiktokIframeRef.current?.contentWindow === playerWindow) postTikTokCommand(playerWindow, 'unMute');
            }, delay);
            retryTimers.push(timer);
          });
        }
      } else if (data.type === 'onCurrentTime' && data.value) {
'@
$content = $content.Substring(0, $readyStart) + $newReady + $content.Substring($readyEnd + $readyEndMarker.Length)

# Older and newer builds format the ended-state branch differently. Do not reject a source
# merely because that one line changed; instead, add unmute handling after the state is parsed.
$stateLine = "        if (state === 0) handleMediaEndedRef.current?.(currentVideo.id);"
if ($content.Contains($stateLine) -and -not $content.Contains("if (state === 1) postTikTokCommand(")) {
    $content = $content.Replace($stateLine, "        if (state === 1) postTikTokCommand(tiktokIframeRef.current?.contentWindow, 'unMute');`r`n" + $stateLine)
}
$statePattern = [System.Text.RegularExpressions.Regex]::new('(?m)^([ \t]*)const state = Number\(data\.value\);')
$stateMatch = $statePattern.Match($content)
if ($stateMatch.Success -and -not $content.Contains("if (state === 1) postTikTokCommand(")) {
    $indent = $stateMatch.Groups[1].Value
    $replacement = $stateMatch.Value + "`r`n" + $indent + "if (state === 1) postTikTokCommand(tiktokIframeRef.current?.contentWindow, 'unMute');"
    $content = $content.Remove($stateMatch.Index, $stateMatch.Length).Insert($stateMatch.Index, $replacement)
}

$simpleCleanup = "    return () => window.removeEventListener('message', handleTikTokMessage);"
if ($content.Contains($simpleCleanup)) {
    $cleanup = @'
    return () => {
      window.removeEventListener('message', handleTikTokMessage);
      retryTimers.forEach((timer) => window.clearTimeout(timer));
    };
'@
    $content = $content.Replace($simpleCleanup, $cleanup.TrimEnd())
} elseif (-not $content.Contains('retryTimers.forEach((timer) => window.clearTimeout(timer))')) {
    Write-Host 'ERROR: Could not safely update TikTok effect cleanup. No files were changed.' -ForegroundColor Red
    exit 1
}

# Keep the Next Up ticker consistent with the same explicit order.
$content = $content.Replace("{videos.filter((v) => v.status === 'queue')[0]?.title || 'Loading next item...'}", "{videos.filter((v) => v.status === 'queue').sort(compareQueueOrder)[0]?.title || 'Loading next item...'}")

if ($content -eq $original) {
    Write-Host 'No changes were made. The fix may already be present or the source differed.' -ForegroundColor Yellow
    exit 0
}

# Make a backup outside the repository so it cannot accidentally be committed.
$backupPath = Join-Path $env:TEMP ('YediHub-App-before-player-queue-audio-fix-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bak')
[System.IO.File]::WriteAllText($backupPath, $original, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($appPath, $content, [System.Text.UTF8Encoding]::new($false))

Write-Host ''
Write-Host 'Yedi Hub player, queue order, and TikTok audio fix applied.' -ForegroundColor Green
Write-Host 'Only src\App.tsx was changed. Twitch login/API files remain untouched.'
Write-Host "Original App.tsx backup: $backupPath"
Write-Host 'Review the diff in GitHub Desktop, commit, and Push origin.'
