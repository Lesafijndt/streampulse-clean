const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const appPath = path.join(__dirname, 'src', 'App.tsx');
const cssPath = path.join(__dirname, 'src', 'index.css');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function replaceFirst(text, regex, replacement, label, required = false) {
  const matches = [...text.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`))];
  if (matches.length === 0) {
    if (required) throw new Error(`Could not find ${label}. No files were changed.`);
    return text;
  }
  if (matches.length > 1) throw new Error(`Found more than one ${label}; refusing an ambiguous edit. No files were changed.`);
  return text.replace(regex, replacement);
}

function patchApp(original) {
  let app = original;
  const has = (s) => app.includes(s);
  assert(has('youtubePlayerContainerRef') && /new\s+YT\.Player\s*\(/.test(app) && has('handleMoveOrder') && has('www.tiktok.com/player/v1'),
    'This App.tsx does not look like the expected Yedi Hub player source. No files were changed.');

  // Stable order values: older saved videos still use their timestamp until reordered.
  if (!has('const queueOrderValue = (video) =>')) {
    const anchor = /^(\s*)const currentVideo = useMemo\(\(\) => \{/m.exec(app);
    assert(anchor, 'Could not locate the currentVideo state section. No files were changed.');
    const helper = `  // YEDI_ALL_FIXES_V1: stable FIFO priority order; older saved entries fall back to timestamp.\n` +
`  const queueOrderValue = (video) => {\n` +
`    const savedOrder = Number(video?.queueOrder);\n` +
`    if (Number.isFinite(savedOrder) && savedOrder > 0) return savedOrder;\n` +
`    const oldTimestamp = Number(video?.timestamp);\n` +
`    return Number.isFinite(oldTimestamp) ? oldTimestamp : 0;\n` +
`  };\n` +
`  const compareQueueOrder = (a, b) => {\n` +
`    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;\n` +
`    return queueOrderValue(a) - queueOrderValue(b) || String(a.id).localeCompare(String(b.id));\n` +
`  };\n` +
`  const getNextQueueOrder = () => videos\n` +
`    .filter((video) => video.status === 'queue')\n` +
`    .reduce((maxOrder, video) => Math.max(maxOrder, queueOrderValue(video)), 0) + 1000;\n\n`;
    app = app.slice(0, anchor.index) + helper + app.slice(anchor.index);
  }

  // Replace FIFO timestamp comparators, without touching newest/upvotes sorting.
  const legacyPinnedSort = /\.sort\(\s*\(a,\s*b\)\s*=>\s*\(a\.pinned\s*!==\s*b\.pinned\s*\?\s*\(a\.pinned\s*\?\s*-1\s*:\s*1\s*\)\s*:\s*\(a\.timestamp\s*\|\|\s*0\)\s*-\s*\(b\.timestamp\s*\|\|\s*0\)\s*\)\s*\)/g;
  app = app.replace(legacyPinnedSort, '.sort(compareQueueOrder)');
  app = app.replace(/return\s*\(a\.timestamp\s*\|\|\s*0\)\s*-\s*\(b\.timestamp\s*\|\|\s*0\);\s*\/\/\s*Priority\s*\/\s*FIFO/g,
    'return compareQueueOrder(a, b); // Priority / FIFO');

  // Add queueOrder to newly submitted requests.
  const newVideoStart = app.indexOf('const newVideo = {');
  if (newVideoStart >= 0) {
    const newVideoEnd = app.indexOf('syncAddVideo(newVideo);', newVideoStart);
    assert(newVideoEnd >= 0, 'Could not isolate the new-video object. No files were changed.');
    let block = app.slice(newVideoStart, newVideoEnd);
    if (!/queueOrder\s*:/.test(block)) {
      const timestamp = /^(\s*)timestamp:\s*Date\.now\(\),/m.exec(block);
      assert(timestamp, 'Could not locate the new request timestamp. No files were changed.');
      block = block.slice(0, timestamp.index) + `${timestamp[1]}queueOrder: getNextQueueOrder(),\n` + block.slice(timestamp.index);
      app = app.slice(0, newVideoStart) + block + app.slice(newVideoEnd);
    }
  }

  // Approv​ed and requeued entries should join the end of the active queue.
  const approveStart = app.indexOf('const handleApprovePending');
  if (approveStart >= 0) {
    let approveEnd = app.indexOf('const handleRequeue', approveStart);
    if (approveEnd < 0) approveEnd = Math.min(app.length, approveStart + 2500);
    let block = app.slice(approveStart, approveEnd);
    if (!/queueOrder\s*:/.test(block)) {
      block = block.replace(/syncUpdateVideo\(video\.id,\s*\{\s*status:\s*'queue'\s*\}\);/,
        "syncUpdateVideo(video.id, { status: 'queue', queueOrder: getNextQueueOrder() });");
    }
    app = app.slice(0, approveStart) + block + app.slice(approveEnd);
  }
  const requeueStart = app.indexOf('const handleRequeue');
  if (requeueStart >= 0) {
    let requeueEnd = app.indexOf('const handleTogglePin', requeueStart);
    if (requeueEnd < 0) requeueEnd = Math.min(app.length, requeueStart + 3000);
    let block = app.slice(requeueStart, requeueEnd);
    if (!/queueOrder\s*:/.test(block)) {
      block = block.replace(/(syncUpdateVideo\(video\.id,\s*\{\s*status:\s*['"]queue['"]\s*,)/,
        '$1\n      queueOrder: getNextQueueOrder(),');
    }
    app = app.slice(0, requeueStart) + block + app.slice(requeueEnd);
  }

  // Atomic local reorder plus persisted queueOrder updates; no timestamp swaps to race.
  const moveRegex = /^  const handleMoveOrder\s*=\s*\(videoId,\s*direction\)\s*=>\s*\{[\s\S]*?^  \};/m;
  assert(moveRegex.test(app), 'Could not locate handleMoveOrder safely. No files were changed.');
  const moveReplacement = `  const handleMoveOrder = (videoId, direction) => {\n` +
`    if (!isStaff) return;\n\n` +
`    // Use explicit order values so quick consecutive arrow clicks cannot collide.\n` +
`    const queue = videos.filter((video) => video.status === 'queue').sort(compareQueueOrder);\n` +
`    const index = queue.findIndex((video) => video.id === videoId);\n` +
`    if (index < 0) return;\n` +
`    const targetIndex = direction === 'up' ? index - 1 : index + 1;\n` +
`    if (targetIndex < 0 || targetIndex >= queue.length) return;\n\n` +
`    const item = queue[index];\n` +
`    const target = queue[targetIndex];\n` +
`    // Pinned requests stay in their own priority group.\n` +
`    if (Boolean(item.pinned) !== Boolean(target.pinned)) return;\n\n` +
`    const reordered = [...queue];\n` +
`    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];\n` +
`    const updates = reordered.map((video, position) => ({ ...video, queueOrder: (position + 1) * 1000 }));\n` +
`    const orderById = new Map(updates.map((video) => [video.id, video.queueOrder]));\n\n` +
`    setSortBy('priority');\n` +
`    setVideos((previous) => previous.map((video) => {\n` +
`      const nextOrder = orderById.get(video.id);\n` +
`      return nextOrder === undefined ? video : { ...video, queueOrder: nextOrder };\n` +
`    }));\n\n` +
`    if (db && firebaseUser) {\n` +
`      void Promise.all(updates.map(async (video) => {\n` +
`        const itemRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', String(video.id));\n` +
`        try {\n` +
`          await updateDoc(itemRef, { queueOrder: video.queueOrder });\n` +
`        } catch (error) {\n` +
`          await setDoc(itemRef, { ...video, channelRoom: normalizeRoomName(channelRoom) }, { merge: true });\n` +
`        }\n` +
`      })).catch((error) => {\n` +
`        console.warn('Queue order could not sync to Firebase; the updated order remains in this browser.', error);\n` +
`        setCloudSynced(false);\n` +
`        setSyncStatusText('Queue order saved locally — cloud update failed');\n` +
`      });\n` +
`    }\n` +
`  };`;
  app = app.replace(moveRegex, moveReplacement);

  // TikTok player ready handler: play, unmute, and one guarded retry. No long-lived retry timers.
  const readyRegex = /if\s*\(\s*data\.type\s*===\s*['"]onPlayerReady['"]\s*\)\s*\{/;
  const ready = readyRegex.exec(app);
  assert(ready, 'Could not locate the TikTok player-ready handler. No files were changed.');
  const bodyStart = ready.index + ready[0].length;
  const tailRegex = /\}\s*else\s*if\s*\(\s*data\.type\s*===\s*['"]onCurrentTime['"]/;
  const tail = tailRegex.exec(app.slice(bodyStart));
  assert(tail, 'Could not locate the TikTok current-time handler boundary. No files were changed.');
  const branchEnd = bodyStart + tail.index;
  const readyBody = `\n\n        const playerWindow = tiktokIframeRef.current?.contentWindow;\n` +
`        if (playerWindow) {\n` +
`          const sendTikTokCommand = (type) => playerWindow.postMessage(\n` +
`            { type, value: null, 'x-tiktok-player': true },\n` +
`            'https://www.tiktok.com'\n` +
`          );\n` +
`          sendTikTokCommand('unMute');\n` +
`          sendTikTokCommand('play');\n` +
`          window.setTimeout(() => {\n` +
`            if (tiktokIframeRef.current?.contentWindow === playerWindow) sendTikTokCommand('unMute');\n` +
`          }, 350);\n` +
`        }\n` +
'      ';
  app = app.slice(0, bodyStart) + readyBody + app.slice(branchEnd);

  // Also send unMute if TikTok reports playback has started.
  if (!/state\s*===\s*1[\s\S]{0,240}unMute/.test(app)) {
    const stateRegex = /^(\s*)const state\s*=\s*Number\(data\.value\);/m;
    const stateMatch = stateRegex.exec(app);
    if (stateMatch) {
      const inserted = `${stateMatch[0]}\n${stateMatch[1]}if (state === 1) tiktokIframeRef.current?.contentWindow?.postMessage({ type: 'unMute', value: null, 'x-tiktok-player': true }, 'https://www.tiktok.com');`;
      app = app.slice(0, stateMatch.index) + inserted + app.slice(stateMatch.index + stateMatch[0].length);
    }
  }

  // Video-only TikTok embed. Works over the user's latest video-only URL, whatever its previous query was.
  const videoOnlyQuery = 'autoplay=1&muted=0&controls=0&progress_bar=0&play_button=0&volume_control=0&fullscreen_button=0&timestamp=0&description=0&music_info=0&closed_caption=0&native_context_menu=0&rel=0';
  const tiktokUrlRegex = /src=\{`https:\/\/www\.tiktok\.com\/player\/v1\/\$\{currentVideo\.videoId\}\?[^`]*`\}/g;
  const srcMatches = [...app.matchAll(tiktokUrlRegex)];
  if (srcMatches.length === 1) {
    const newSrc = 'src={`https://www.tiktok.com/player/v1/${currentVideo.videoId}?' + videoOnlyQuery + '`}';
    app = app.replace(tiktokUrlRegex, () => newSrc);
  } else {
    assert(srcMatches.length === 0 && app.includes(videoOnlyQuery), 'Could not uniquely identify the TikTok embed URL. No files were changed.');
  }
  app = app.replace(/key=\{`tiktok-\$\{currentVideo\.videoId\}`\}/g,
    'key={`tiktok-${currentVideo.id}-${currentVideo.videoId}`}');

  // Cinema-style viewport.
  const heightRegex = /isTheatreMode\s*\?\s*'[^']*h-\[[^']+\][^']*'\s*:\s*'[^']*h-\[[^']+\][^']*'/;
  const height = heightRegex.exec(app);
  if (height && !height[0].includes('h-[72vh]')) {
    app = app.slice(0, height.index) +
      "isTheatreMode ? 'h-[72vh] min-h-[560px] max-h-[900px]' : 'h-[55vh] min-h-[460px] max-h-[700px]'" +
      app.slice(height.index + height[0].length);
  }

  // Silence routine info/success toasts but keep actionable warnings/errors.
  if (!/if\s*\(type\s*===\s*['"]info['"]\s*\|\|\s*type\s*===\s*['"]success['"]\)\s*return/.test(app)) {
    const toast = /(^[ \t]*const addToast\s*=\s*\(message,\s*type\s*=\s*['"]info['"]\)\s*=>\s*\{)/m.exec(app);
    assert(toast, 'Could not locate the toast handler. No files were changed.');
    const injection = `${toast[1]}\n    // Seamless mode: suppress routine info/success popups; keep warning/error feedback.\n    if (type === 'info' || type === 'success') return;`;
    app = app.slice(0, toast.index) + injection + app.slice(toast.index + toast[0].length);
  }

  // Fix React removeChild by making YouTube replace a dynamic child, not React's own host node.
  const ytCtorRegex = /^(\s*)player\s*=\s*new\s+YT\.Player\(\s*youtubePlayerContainerRef\.current\s*,/m;
  const ytCtor = ytCtorRegex.exec(app);
  if (ytCtor) {
    const indent = ytCtor[1];
    const replacement = `${indent}const playerMountNode = document.createElement('div');\n` +
      `${indent}playerMountNode.className = 'w-full h-full';\n` +
      `${indent}youtubePlayerContainerRef.current.appendChild(playerMountNode);\n` +
      `${indent}player = new YT.Player(playerMountNode,`;
    app = app.slice(0, ytCtor.index) + replacement + app.slice(ytCtor.index + ytCtor[0].length);
  } else {
    assert(/new\s+YT\.Player\(\s*playerMountNode\s*,/.test(app), 'Could not safely isolate the YouTube player target. No files were changed.');
  }

  // Key the host by request ID where it is a self-closing React node, so track swaps create a fresh mount.
  const hostRegex = /<div(?=[^>]*ref=\{youtubePlayerContainerRef\})[^>]*\/>/;
  const host = hostRegex.exec(app);
  if (host && !/\bkey=/.test(host[0])) {
    const newHost = host[0].replace('<div', '<div key={`youtube-${currentVideo.id}-${currentVideo.videoId}`}');
    app = app.slice(0, host.index) + newHost + app.slice(host.index + host[0].length);
  }

  // Next-Up display uses the same order comparator.
  app = app.replace(/videos\.filter\(\(v\)\s*=>\s*v\.status\s*===\s*'queue'\)\[0\]/g,
    "videos.filter((v) => v.status === 'queue').sort(compareQueueOrder)[0]");

  assert(/const queueOrderValue = \(video\) =>/.test(app), 'Queue-order helper validation failed. No files were written.');
  assert(/new\s+YT\.Player\(\s*playerMountNode\s*,/.test(app), 'YouTube target validation failed. No files were written.');
  assert(app.includes(videoOnlyQuery), 'TikTok video-only option validation failed. No files were written.');
  assert(/const handleMoveOrder\s*=\s*\(videoId,\s*direction\)\s*=>/.test(app), 'Queue reordering validation failed. No files were written.');
  assert(/sendTikTokCommand\('unMute'\)/.test(app), 'TikTok player-ready audio validation failed. No files were written.');
  assert(/state\s*===\s*1[^\n]*unMute/.test(app), 'TikTok playback-state audio validation failed. No files were written.');
  return app;
}

function patchCss(original) {
  let css = original;
  const newBlock = `.gachi-tiktok-player {\n` +
`  width: auto;\n` +
`  height: 100%;\n` +
`  max-width: 100%;\n` +
`  aspect-ratio: 9 / 16;\n` +
`  flex: 0 1 auto;\n` +
`  position: relative;\n` +
`  z-index: 1;\n` +
`  isolation: isolate;\n` +
`  border: 0;\n` +
`  border-radius: 0;\n` +
`  background: #000;\n` +
`  box-shadow: none;\n` +
`}`;
  const blockRegex = /^\.gachi-tiktok-player\s*\{[\s\S]*?^\}/m;
  if (blockRegex.test(css)) css = css.replace(blockRegex, newBlock);
  else if (!css.includes('gachi-tiktok-player')) css += `\n\n${newBlock}\n`;
  css = css.replace(/\/\* YEDI_ALL_FIXES_V1: TikTok clean frame \*\/\s*\.gachi-theme \.gachi-tiktok-player\s*\{[^}]*\}\s*/g, '');
  css = css.trimEnd() + `\n\n/* YEDI_ALL_FIXES_V1: TikTok clean frame */\n.gachi-theme .gachi-tiktok-player { border-radius: 0 !important; box-shadow: none !important; }\n`;
  return css;
}

try {
  assert(fs.existsSync(appPath), 'src/App.tsx was not found. Extract this ZIP into the repository root beside package.json.');
  assert(fs.existsSync(cssPath), 'src/index.css was not found. No files were changed.');
  const oldApp = fs.readFileSync(appPath, 'utf8');
  const oldCss = fs.readFileSync(cssPath, 'utf8');
  const newApp = patchApp(oldApp);
  const newCss = patchCss(oldCss);
  if (newApp === oldApp && newCss === oldCss) {
    console.log('All combined fixes are already present; no changes were needed.');
    process.exit(0);
  }
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const backupApp = path.join(os.tmpdir(), `YediHub-App-before-all-fixes-${stamp}.bak`);
  const backupCss = path.join(os.tmpdir(), `YediHub-index-css-before-all-fixes-${stamp}.bak`);
  fs.writeFileSync(backupApp, oldApp, 'utf8');
  fs.writeFileSync(backupCss, oldCss, 'utf8');
  fs.writeFileSync(appPath, newApp, 'utf8');
  fs.writeFileSync(cssPath, newCss, 'utf8');
  console.log('\nYedi Hub combined player/queue/audio/video-only fixes applied.');
  console.log('Changed only src/App.tsx and src/index.css. Twitch login/API files were not touched.');
  console.log(`App.tsx backup: ${backupApp}`);
  console.log(`index.css backup: ${backupCss}`);
  console.log('Review changes, run npm run build, and only then commit and push.');
  console.log('Note: browsers can still block audible autoplay; the first manual play/unmute may be required.');
} catch (error) {
  console.error(`\nERROR: ${error?.message || error}`);
  console.error('No source files were written by this run. Stop here and send this error if it does not match expectations.');
  process.exitCode = 1;
}
