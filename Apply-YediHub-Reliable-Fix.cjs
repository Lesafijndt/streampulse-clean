const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = __dirname;
const appPath = path.join(root, 'src', 'App.tsx');
const cssPath = path.join(root, 'src', 'index.css');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function countOf(text, needle) {
  return text.split(needle).length - 1;
}
function replaceRegion(text, startMarker, endMarker, replacement, label) {
  const start = text.indexOf(startMarker);
  assert(start >= 0, `Could not locate ${label} start. No files were changed.`);
  assert(countOf(text, startMarker) === 1, `Found multiple ${label} starts. No files were changed.`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert(end >= 0, `Could not locate ${label} end. No files were changed.`);
  return text.slice(0, start) + replacement + text.slice(end);
}

function effectCloseMatch(text, fromIndex) {
  // Locate a useEffect terminator by its dependency list, not by the next comment.
  // Comments can be rewritten while the actual React effect remains unchanged.
  const closePattern = /^[ \t]*\},\s*\[[^\]]*currentVideo[^\]]*\]\s*\);/gm;
  closePattern.lastIndex = fromIndex;
  return closePattern.exec(text);
}
function replaceEffectFromAnchor(text, anchor, replacement, label) {
  const anchorAt = text.indexOf(anchor);
  assert(anchorAt >= 0, `Could not locate ${label} anchor. No files were changed.`);
  assert(countOf(text, anchor) === 1, `Found multiple ${label} anchors. No files were changed.`);
  const effectAt = text.indexOf('useEffect(() => {', anchorAt + anchor.length);
  assert(effectAt >= 0, `Could not locate ${label} React effect. No files were changed.`);
  const close = effectCloseMatch(text, effectAt);
  assert(close, `Could not locate ${label} effect terminator. No files were changed.`);
  // Replace from the anchor comment through the real end of this useEffect.
  return text.slice(0, anchorAt) + replacement + text.slice(close.index + close[0].length);
}
function replaceTikTokEffect(text, fromIndex, replacement) {
  const effectPattern = /^[ \t]*useEffect\(\(\)\s*=>\s*\{/gm;
  effectPattern.lastIndex = fromIndex;
  let effectMatch;
  while ((effectMatch = effectPattern.exec(text))) {
    const effectAt = effectMatch.index;
    const close = effectCloseMatch(text, effectAt);
    if (!close) continue;
    const effectBody = text.slice(effectAt, close.index + close[0].length);
    if (!effectBody.includes('tiktokIframeRef') || !effectBody.includes('onPlayerReady')) continue;
    let replaceStart = effectAt;
    // Also replace the preceding TikTok comment when it is immediately before the effect.
    const beforeEffect = text.slice(0, effectAt).replace(/[\r\n \t]+$/, '');
    const previousLineStart = beforeEffect.lastIndexOf('\n') + 1;
    const previousLine = beforeEffect.slice(previousLineStart).trim();
    if (previousLine.startsWith('//') && /tiktok/i.test(previousLine)) replaceStart = previousLineStart;
    return text.slice(0, replaceStart) + replacement + text.slice(close.index + close[0].length);
  }
  assert(false, 'Could not locate TikTok player effect by its refs/events. No files were changed.');
}

function replaceFunction(text, signature, replacement, label) {
  const re = new RegExp('^  const ' + signature + '[\\s\\S]*?^  };', 'm');
  assert(re.test(text), `Could not locate ${label}. No files were changed.`);
  return text.replace(re, replacement);
}
function ensureFirestoreBatchImport(app) {
  if (/\bwriteBatch\b/.test(app.slice(0, app.indexOf("from 'firebase/firestore'")))) return app;
  const endImport = app.indexOf("from 'firebase/firestore';");
  assert(endImport >= 0, "Could not locate the Firebase Firestore import. No files were changed.");
  const startImport = app.lastIndexOf('import {', endImport);
  const closeBrace = app.lastIndexOf('}', endImport);
  assert(startImport >= 0 && closeBrace > startImport, "Could not safely edit the Firestore import. No files were changed.");
  const body = app.slice(startImport, closeBrace);
  const trimmed = body.trimEnd();
  const importBody = trimmed.endsWith(',') ? trimmed : trimmed + ',';
  return app.slice(0, startImport) + importBody + '\n  writeBatch\n' + app.slice(closeBrace);
}

function patchApp(original) {
  let app = original;
  assert(app.includes('export default function YediHubApp') || app.includes('export default function App'),
    'This does not look like the Yedi Hub App.tsx file. No files were changed.');
  assert(app.includes('youtubePlayerContainerRef') && app.includes('new YT.Player') && app.includes('handleMoveOrder') && app.includes('www.tiktok.com/player/v1'),
    'The player or queue code did not match a known Yedi Hub structure. No files were changed.');

  app = ensureFirestoreBatchImport(app);

  // A shared explicit queue order makes ordering independent of the media platform.
  const helpers = `  // YEDI_RELIABLE_PLAYER_QUEUE_FIX: one platform-independent, persisted queue order.\n` +
`  const queueOrderValue = (video) => {\n` +
`    const saved = Number(video?.queueOrder);\n` +
`    if (video?.queueOrder !== undefined && video?.queueOrder !== null && Number.isFinite(saved)) return saved;\n` +
`    const legacyTimestamp = Number(video?.timestamp);\n` +
`    return Number.isFinite(legacyTimestamp) ? legacyTimestamp : 0;\n` +
`  };\n` +
`  const compareQueueOrder = (a, b) => queueOrderValue(a) - queueOrderValue(b) ||\n` +
`    (Number(a?.timestamp) || 0) - (Number(b?.timestamp) || 0) || String(a?.id).localeCompare(String(b?.id));\n` +
`  const queueOrderSequenceRef = useRef(0);\n` +
`  const getNextQueueOrder = () => {\n` +
`    const maxOrder = videos.filter((video) => video.status === 'queue')\n` +
`      .reduce((max, video) => Math.max(max, queueOrderValue(video)), 0);\n` +
`    const next = Math.max(maxOrder + 1000, Date.now(), queueOrderSequenceRef.current + 1000);\n` +
`    queueOrderSequenceRef.current = next;\n` +
`    return next;\n` +
`  };\n\n`;
  const helperMarker = 'const queueOrderValue = (video) => {';
  const currentVideoMarker = '  const currentVideo = useMemo(() => {';
  if (app.includes(helperMarker)) {
    const helperAt = app.indexOf(helperMarker);
    const lineStart = app.lastIndexOf('\n', helperAt - 1) + 1;
    const currentAt = app.indexOf(currentVideoMarker, helperAt);
    assert(currentAt >= 0, 'Could not isolate the existing queue-order helper. No files were changed.');
    // Include any old helper comment immediately preceding the helper line.
    const commentStart = app.lastIndexOf('\n  // YEDI_', helperAt);
    const start = commentStart >= lineStart - 120 ? commentStart + 1 : lineStart;
    app = app.slice(0, start) + helpers + app.slice(currentAt);
  } else {
    const at = app.indexOf(currentVideoMarker);
    assert(at >= 0, 'Could not locate the active-video state. No files were changed.');
    app = app.slice(0, at) + helpers + app.slice(at);
  }

  // Make the currently selected item and the Next button use the same order.
  const legacySort = /\.sort\(\s*\(a,\s*b\)\s*=>\s*\(a\.pinned\s*!==\s*b\.pinned\s*\?\s*\(a\.pinned\s*\?\s*-1\s*:\s*1\)\s*:\s*\(a\.timestamp\s*\|\|\s*0\)\s*-\s*\(b\.timestamp\s*\|\|\s*0\)\)\s*\)/g;
  app = app.replace(legacySort, '.sort(compareQueueOrder)');

  // In the queue tab, manual order is authoritative. Other sort modes remain available until an arrow is clicked.
  app = replaceRegion(
    app,
    '  const filteredVideos = useMemo(() => {',
    '\n\n  const isStaff =',
`  const filteredVideos = useMemo(() => {\n` +
`    return videos\n` +
`      .filter((v) => v.status === activeTab)\n` +
`      .filter((v) => (selectedCategory === 'All' ? true : v.category === selectedCategory))\n` +
`      .filter((v) => {\n` +
`        if (!searchQuery.trim()) return true;\n` +
`        const q = searchQuery.toLowerCase();\n` +
`        return String(v.title || '').toLowerCase().includes(q) ||\n` +
`          String(v.requestedBy || '').toLowerCase().includes(q) ||\n` +
`          String(v.category || '').toLowerCase().includes(q) ||\n` +
`          String(v.note || '').toLowerCase().includes(q);\n` +
`      })\n` +
`      .sort((a, b) => {\n` +
`        if (sortBy === 'upvotes') return (Number(b.upvotes) || 0) - (Number(a.upvotes) || 0) || compareQueueOrder(a, b);\n` +
`        if (sortBy === 'newest') return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0) || compareQueueOrder(a, b);\n` +
`        return compareQueueOrder(a, b);\n` +
`      });\n` +
`  }, [videos, activeTab, selectedCategory, searchQuery, sortBy]);\n`,
    'filtered video list'
  );

  // New requests receive explicit order; pending requests are assigned order when approved.
  const newVideoStart = app.indexOf('const newVideo = {');
  if (newVideoStart >= 0) {
    const newVideoEnd = app.indexOf('syncAddVideo(newVideo);', newVideoStart);
    assert(newVideoEnd >= 0, 'Could not isolate the new request object. No files were changed.');
    const block = app.slice(newVideoStart, newVideoEnd);
    if (!/\bqueueOrder\s*:/.test(block)) {
      const timestampMatch = /^(\s*)timestamp:\s*Date\.now\(\),/m.exec(block);
      assert(timestampMatch, 'Could not locate the new-request timestamp. No files were changed.');
      const updated = block.slice(0, timestampMatch.index) +
        `${timestampMatch[1]}...(targetStatus === 'queue' ? { queueOrder: getNextQueueOrder() } : {}),\n` +
        block.slice(timestampMatch.index);
      app = app.slice(0, newVideoStart) + updated + app.slice(newVideoEnd);
    }
  }

  // Requests entering active queue join the end, regardless of source platform.
  const approveStart = app.indexOf('  const handleApprovePending = (video) => {');
  const requeueStart = app.indexOf('  const handleRequeue = (video) => {');
  assert(approveStart >= 0 && requeueStart > approveStart, 'Could not locate approval/requeue handlers. No files were changed.');
  let approveBlock = app.slice(approveStart, requeueStart);
  if (!/queueOrder\s*:/.test(approveBlock)) {
    approveBlock = approveBlock.replace("syncUpdateVideo(video.id, { status: 'queue' });", "syncUpdateVideo(video.id, { status: 'queue', queueOrder: getNextQueueOrder() });");
  }
  app = app.slice(0, approveStart) + approveBlock + app.slice(requeueStart);
  const freshRequeueStart = app.indexOf('  const handleRequeue = (video) => {');
  const requeueEnd = app.indexOf('  const handleTogglePin = (video) => {', freshRequeueStart);
  assert(freshRequeueStart >= 0 && requeueEnd > freshRequeueStart, 'Could not isolate the requeue handler. No files were changed.');
  let requeueBlock = app.slice(freshRequeueStart, requeueEnd);
  if (!/queueOrder\s*:/.test(requeueBlock)) {
    requeueBlock = requeueBlock.replace(/(status:\s*'queue',)/, "$1\n      queueOrder: getNextQueueOrder(),");
  }
  app = app.slice(0, freshRequeueStart) + requeueBlock + app.slice(requeueEnd);

  // Pinning moves the item to the top once; unpinning moves it to the end. Arrow ordering then works across all items.
  app = replaceFunction(app, 'handleTogglePin\\s*=\\s*\\(video\\)\\s*=>\\s*\\{',
`  const handleTogglePin = (video) => {\n` +
`    if (!isStaff) return;\n` +
`    const nextPinned = !video.pinned;\n` +
`    const otherQueued = videos.filter((item) => item.status === 'queue' && String(item.id) !== String(video.id));\n` +
`    const minOtherOrder = otherQueued.reduce((min, item) => Math.min(min, queueOrderValue(item)), Number.POSITIVE_INFINITY);\n` +
`    const queueOrder = nextPinned\n` +
`      ? (Number.isFinite(minOtherOrder) ? minOtherOrder - 1000 : queueOrderValue(video))\n` +
`      : getNextQueueOrder();\n` +
`    syncUpdateVideo(video.id, { pinned: nextPinned, queueOrder });\n` +
`    addToast(nextPinned ? 'Pinned priority to the top of the queue.' : 'Unpinned video and moved it to the end.', 'info');\n` +
`  };`, 'pin handler');

  // Atomic order update prevents two parallel timestamp writes from racing the Firestore listener.
  app = replaceFunction(app, 'handleMoveOrder\\s*=\\s*\\(videoId,\\s*direction\\s*\\)\\s*=>\\s*\\{',
`  const handleMoveOrder = (videoId, direction) => {\n` +
`    if (!isStaff || activeTab !== 'queue') return;\n` +
`    const visibleQueue = filteredVideos.filter((video) => video.status === 'queue');\n` +
`    const visibleIndex = visibleQueue.findIndex((video) => String(video.id) === String(videoId));\n` +
`    if (visibleIndex < 0) return;\n` +
`    const targetVisibleIndex = direction === 'up' ? visibleIndex - 1 : visibleIndex + 1;\n` +
`    if (targetVisibleIndex < 0 || targetVisibleIndex >= visibleQueue.length) return;\n` +
`\n` +
`    // Recreate the current visual sort over the full queue, then swap the two adjacent visible rows.\n` +
`    // This also works if search/category filters hide entries between those visible rows.\n` +
`    const fullQueue = videos.filter((video) => video.status === 'queue').sort((a, b) => {\n` +
`      if (sortBy === 'upvotes') return (Number(b.upvotes) || 0) - (Number(a.upvotes) || 0) || compareQueueOrder(a, b);\n` +
`      if (sortBy === 'newest') return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0) || compareQueueOrder(a, b);\n` +
`      return compareQueueOrder(a, b);\n` +
`    });\n` +
`    const movingId = String(visibleQueue[visibleIndex].id);\n` +
`    const targetId = String(visibleQueue[targetVisibleIndex].id);\n` +
`    const movingIndex = fullQueue.findIndex((video) => String(video.id) === movingId);\n` +
`    const targetIndex = fullQueue.findIndex((video) => String(video.id) === targetId);\n` +
`    if (movingIndex < 0 || targetIndex < 0 || movingIndex === targetIndex) return;\n` +
`\n` +
`    [fullQueue[movingIndex], fullQueue[targetIndex]] = [fullQueue[targetIndex], fullQueue[movingIndex]];\n` +
`    const updates = fullQueue.map((video, position) => ({ ...video, queueOrder: (position + 1) * 1000 }));\n` +
`    const orderById = new Map(updates.map((video) => [String(video.id), video.queueOrder]));\n` +
`    const nextVideos = videos.map((video) => {\n` +
`      const nextOrder = orderById.get(String(video.id));\n` +
`      return nextOrder === undefined ? video : { ...video, queueOrder: nextOrder };\n` +
`    });\n` +
`    queueOrderSequenceRef.current = Math.max(queueOrderSequenceRef.current, Date.now());\n` +
`    setSortBy('priority');\n` +
`    setVideos(nextVideos);\n` +
`\n` +
`    if (db && firebaseUser) {\n` +
`      void (async () => {\n` +
`        const batch = writeBatch(db);\n` +
`        updates.forEach((video) => {\n` +
`          const itemRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', String(video.id));\n` +
`          batch.set(itemRef, { id: String(video.id), queueOrder: video.queueOrder, channelRoom: normalizeRoomName(channelRoom) }, { merge: true });\n` +
`        });\n` +
`        try {\n` +
`          await batch.commit();\n` +
`        } catch (error) {\n` +
`          console.warn('Atomic queue reorder failed; attempting a merge-write fallback.', error);\n` +
`          try {\n` +
`            await Promise.all(updates.map((video) => setDoc(\n` +
`              doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', String(video.id)),\n` +
`              { id: String(video.id), queueOrder: video.queueOrder, channelRoom: normalizeRoomName(channelRoom) },\n` +
`              { merge: true }\n` +
`            )));\n` +
`          } catch (fallbackError) {\n` +
`            console.warn('Queue order could not sync to Firebase; the order remains stored locally.', fallbackError);\n` +
`            setCloudSynced(false);\n` +
`            setSyncStatusText('Queue order saved locally — cloud update failed');\n` +
`          }\n` +
`        }\n` +
`      })();\n` +
`    }\n` +
`  };`, 'queue-order handler');

  // Same ordering in auto-advance and Watch Later replacement paths.
  const nextTicker = "videos.filter((v) => v.status === 'queue')[0]?.title";
  app = app.replace(nextTicker, "videos.filter((v) => v.status === 'queue').sort(compareQueueOrder)[0]?.title");

  // Replace YouTube player lifecycle between stable comments, regardless of source formatting.
  const youtubeStart = '  // Mount the official YouTube IFrame API player, allowing reliable autoplay and end-of-video detection.';
  const tiktokStart = "  // TikTok's official embedded player sends state and time updates with postMessage.";
  const youtubeEffect = `  // Mount the official YouTube IFrame API player, allowing reliable autoplay and end-of-video detection.\n` +
`  // The API must receive an imperative child, never a DOM node React owns.\n` +
`  useEffect(() => {\n` +
`    const video = currentVideo;\n` +
`    const host = youtubePlayerContainerRef.current;\n` +
`    if (!video || video.platform !== 'youtube' || !video.videoId || !host) return undefined;\n` +
`\n` +
`    let cancelled = false;\n` +
`    let player = null;\n` +
`    let playerMountNode = null;\n` +
`\n` +
`    loadYouTubeIframeApi().then((YT) => {\n` +
`      if (cancelled || !host.isConnected) return;\n` +
`      playerMountNode = document.createElement('div');\n` +
`      playerMountNode.className = 'w-full h-full';\n` +
`      host.appendChild(playerMountNode);\n` +
`      try {\n` +
`        player = new YT.Player(playerMountNode, {\n` +
`          width: '100%',\n` +
`          height: '100%',\n` +
`          videoId: video.videoId,\n` +
`          playerVars: { autoplay: 1, controls: 1, playsinline: 1, rel: 0, modestbranding: 1, origin: window.location.origin },\n` +
`          events: {\n` +
`            onReady: (event) => {\n` +
`              if (cancelled) return;\n` +
`              youtubePlayerRef.current = event.target;\n` +
`              event.target.playVideo();\n` +
`            },\n` +
`            onStateChange: (event) => {\n` +
`              if (cancelled) return;\n` +
`              if (event.data === 0) handleMediaEndedRef.current?.(video.id);\n` +
`            },\n` +
`            onAutoplayBlocked: () => {\n` +
`              if (!cancelled) addToast('Your browser blocked autoplay with sound. Press Play once to allow playback.', 'info');\n` +
`            },\n` +
`            onError: () => {\n` +
`              if (!cancelled) addToast('YouTube could not play this video. It may be private, removed, or embedding-disabled.', 'warning');\n` +
`            }\n` +
`          }\n` +
`        });\n` +
`      } catch (error) {\n` +
`        console.warn('Could not create the YouTube player.', error);\n` +
`        if (!cancelled) addToast('YouTube player initialization failed.', 'warning');\n` +
`      }\n` +
`    }).catch((error) => {\n` +
`      console.warn('YouTube player API could not load.', error);\n` +
`      if (!cancelled) addToast('The YouTube player could not load. Check browser extensions or network access.', 'warning');\n` +
`    });\n` +
`\n` +
`    return () => {\n` +
`      cancelled = true;\n` +
`      const oldPlayer = player;\n` +
`      if (youtubePlayerRef.current === oldPlayer) youtubePlayerRef.current = null;\n` +
`      if (oldPlayer && typeof oldPlayer.destroy === 'function') {\n` +
`        try { oldPlayer.destroy(); } catch (error) { console.debug('YouTube player was already detached during cleanup.', error); }\n` +
`      }\n` +
`      // The API replaces playerMountNode with its iframe. Remove only the original node if it is still attached.\n` +
`      if (playerMountNode && playerMountNode.parentNode === host) {\n` +
`        try { host.removeChild(playerMountNode); } catch { /* already detached */ }\n` +
`      }\n` +
`    };\n` +
`  }, [currentVideo?.id, currentVideo?.videoId, currentVideo?.platform]);\n\n`;
  app = replaceEffectFromAnchor(app, youtubeStart, youtubeEffect, 'YouTube player effect');

  const tikTokEffect = `  useEffect(() => {\n` +
`    const video = currentVideo;\n` +
`    if (!video || video.platform !== 'tiktok' || !video.videoId) return undefined;\n` +
`    let cancelled = false;\n` +
`    const retryTimers = [];\n` +
`    const getWindow = () => tiktokIframeRef.current?.contentWindow;\n` +
`    const sendCommand = (type, targetWindow = getWindow()) => {\n` +
`      if (!cancelled && targetWindow && targetWindow === getWindow()) {\n` +
`        targetWindow.postMessage({ type, value: null, 'x-tiktok-player': true }, 'https://www.tiktok.com');\n` +
`      }\n` +
`    };\n` +
`    const handleTikTokMessage = (event) => {\n` +
`      if (event.origin !== 'https://www.tiktok.com' || event.source !== getWindow()) return;\n` +
`      let data = event.data;\n` +
`      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }\n` +
`      if (!data || data['x-tiktok-player'] !== true) return;\n` +
`      if (data.type === 'onPlayerReady') {\n` +
`        const playerWindow = getWindow();\n` +
`        sendCommand('play', playerWindow);\n` +
`        sendCommand('unMute', playerWindow);\n` +
`        [250, 800].forEach((delay) => {\n` +
`          retryTimers.push(window.setTimeout(() => {\n` +
`            if (!cancelled && getWindow() === playerWindow) {\n` +
`              sendCommand('unMute', playerWindow);\n` +
`              if (delay === 800) sendCommand('play', playerWindow);\n` +
`            }\n` +
`          }, delay));\n` +
`        });\n` +
`      } else if (data.type === 'onCurrentTime' && data.value) {\n` +
`        const duration = Number(data.value.duration) || 0;\n` +
`        const currentTime = Number(data.value.currentTime) || 0;\n` +
`        if (duration > 0) setSimProgress(Math.min(100, Math.max(0, (currentTime / duration) * 100)));\n` +
`      } else if (data.type === 'onStateChange') {\n` +
`        const state = Number(data.value);\n` +
`        if (state === 1) sendCommand('unMute');\n` +
`        if (state === 0) handleMediaEndedRef.current?.(video.id);\n` +
`      } else if (data.type === 'onPlayerError') {\n` +
`        const errorType = data.value?.errorType || 'playback error';\n` +
`        addToast('TikTok could not play this post (' + errorType + '). Try a public full video URL.', 'warning');\n` +
`      }\n` +
`    };\n` +
`    window.addEventListener('message', handleTikTokMessage);\n` +
`    return () => {\n` +
`      cancelled = true;\n` +
`      retryTimers.forEach((timer) => window.clearTimeout(timer));\n` +
`      window.removeEventListener('message', handleTikTokMessage);\n` +
`    };\n` +
`  }, [currentVideo?.id, currentVideo?.videoId, currentVideo?.platform]);\n\n`;
  const activeYouTubeEnd = app.indexOf(youtubeEffect);
  app = replaceTikTokEffect(app, Math.max(0, activeYouTubeEnd), tikTokEffect);

  // Use documented TikTok flags; creator attribution/identity cannot be removed via documented flags.
  const videoOnlyQuery = 'autoplay=1&muted=0&controls=0&progress_bar=0&play_button=0&volume_control=0&fullscreen_button=0&timestamp=0&description=0&music_info=0&closed_caption=0&native_context_menu=0&rel=0';
  const tiktokUrlRegex = /src=\{`https:\/\/www\.tiktok\.com\/player\/v1\/\$\{currentVideo\.videoId\}\?[^`]*`\}/g;
  const matches = [...app.matchAll(tiktokUrlRegex)];
  if (matches.length === 1) {
    app = app.replace(tiktokUrlRegex, 'src={`https://www.tiktok.com/player/v1/${currentVideo.videoId}?' + videoOnlyQuery + '`}');
  } else {
    assert(matches.length === 0 && app.includes(videoOnlyQuery), 'Could not safely identify the TikTok iframe URL. No files were changed.');
  }
  app = app.replace(/key=\{`tiktok-\$\{currentVideo\.videoId\}`\}/g, 'key={`tiktok-${currentVideo.id}-${currentVideo.videoId}`}');
  // Fullscreen is already disabled at the TikTok player level; remove permission props from TikTok iframe only.
  const ttStart = app.indexOf('className="gachi-tiktok-player border-0"');
  if (ttStart >= 0) {
    const iframeStart = app.lastIndexOf('<iframe', ttStart);
    const iframeEnd = app.indexOf('/>', ttStart);
    assert(iframeStart >= 0 && iframeEnd >= 0, 'Could not isolate TikTok iframe properties. No files were changed.');
    const iframeBlock = app.slice(iframeStart, iframeEnd + 2).replace(/\s+allowFullScreen\s*/g, '').replace(/allow="autoplay; encrypted-media; fullscreen; picture-in-picture"/g, 'allow="autoplay; encrypted-media; picture-in-picture"');
    app = app.slice(0, iframeStart) + iframeBlock + app.slice(iframeEnd + 2);
  }

  // Use a fresh React-owned host for every YouTube request; the inner player node is imperatively owned.
  app = app.replace(/<div(?=[^>]*ref=\{youtubePlayerContainerRef\})[^>]*\/>/g, (tag) => {
    if (/\bkey=/.test(tag)) return tag;
    return tag.replace('<div', '<div key={`youtube-${currentVideo.id}-${currentVideo.videoId}`}');
  });

  // Larger cinema viewport and quieter routine success/information toasts.
  app = app.replace(/isTheatreMode\s*\?\s*'[^']*h-\[[^']+\][^']*'\s*:\s*'[^']*h-\[[^']+\][^']*'/,
    "isTheatreMode ? 'h-[72vh] min-h-[560px] max-h-[900px]' : 'h-[55vh] min-h-[460px] max-h-[700px]'");
  if (!/if\s*\(type\s*===\s*['"]info['"]\s*\|\|\s*type\s*===\s*['"]success['"]\)\s*return/.test(app)) {
    const toast = /^([ \t]*const addToast\s*=\s*\(message,\s*type\s*=\s*['"]info['"]\)\s*=>\s*\{)/m.exec(app);
    assert(toast, 'Could not locate the toast handler. No files were changed.');
    app = app.slice(0, toast.index) + toast[1] + "\n    if (type === 'info' || type === 'success') return; // seamless mode: keep only actionable warnings/errors." + app.slice(toast.index + toast[0].length);
  }

  return app;
}

function patchCss(original) {
  const selector = '.gachi-tiktok-player {';
  const at = original.indexOf(selector);
  assert(at >= 0, 'Could not locate the TikTok player CSS. No files were changed.');
  const close = original.indexOf('\n}', at);
  assert(close >= 0, 'Could not isolate the TikTok player CSS. No files were changed.');
  const block = `.gachi-tiktok-player {\n  width: min(100%, calc(100vh * 9 / 16));\n  height: 100%;\n  max-width: 100%;\n  aspect-ratio: 9 / 16;\n  flex: 0 1 auto;\n  position: relative;\n  z-index: 1;\n  isolation: isolate;\n  border: 0;\n  border-radius: 0;\n  background: #000;\n  box-shadow: none;`;
  return original.slice(0, at) + block + original.slice(close);
}

function main() {
  assert(fs.existsSync(appPath), 'src/App.tsx was not found. Extract this ZIP into your repository root. No files were changed.');
  assert(fs.existsSync(cssPath), 'src/index.css was not found. Extract this ZIP into your repository root. No files were changed.');
  const originalApp = fs.readFileSync(appPath, 'utf8');
  const originalCss = fs.readFileSync(cssPath, 'utf8');
  const updatedApp = patchApp(originalApp);
  const updatedCss = patchCss(originalCss);
  const backupDir = path.join(os.tmpdir(), 'yedi-hub-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(backupDir, `App.tsx-${stamp}.bak`), originalApp, 'utf8');
  fs.writeFileSync(path.join(backupDir, `index.css-${stamp}.bak`), originalCss, 'utf8');
  fs.writeFileSync(appPath, updatedApp, 'utf8');
  fs.writeFileSync(cssPath, updatedCss, 'utf8');
  console.log('Yedi Hub player/queue fix applied.');
  console.log('Changed only src/App.tsx and src/index.css.');
  console.log(`Backups saved in: ${backupDir}`);
  console.log('Next: run npm run build. Commit/push only if the build succeeds.');
}

try {
  main();
} catch (error) {
  console.error('ERROR: ' + (error && error.message ? error.message : String(error)));
  console.error('No source files were written. Fix the issue before committing.');
  process.exitCode = 1;
}
