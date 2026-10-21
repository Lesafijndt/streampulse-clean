import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  SkipForward,
  RotateCcw,
  Clock,
  CheckCircle2,
  ListVideo,
  Music,
  Gamepad2,
  Laugh,
  Scissors,
  Sparkles,
  Search,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Pin,
  ExternalLink,
  Settings,
  LogIn,
  LogOut,
  UserCheck,
  Shield,
  Users,
  ThumbsUp,
  Flame,
  Maximize2,
  Minimize2,
  RefreshCw,
  X,
  AlertTriangle,
  Radio,
  Tv,
  Filter,
  SlidersHorizontal,
  Bookmark,
  Lock,
  Unlock,
  Layers,
  HelpCircle,
  Copy,
  FolderSync
} from 'lucide-react';

// Firebase imports
import { getApps, initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithCustomToken,
  onAuthStateChanged,
  getIdTokenResult,
  signOut
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  updateDoc,
  increment,
  arrayUnion,
  writeBatch,
  deleteDoc,
  onSnapshot
} from 'firebase/firestore';



// Persistent local fallback and optional Firebase configuration.
// Local storage is always enabled; Firebase adds cross-browser real-time sync when configured.
const STORAGE_PREFIX = 'streampulse-gachi-arena:v2';
const PRIVATE_CHANNEL = '2o3a';
const ALLOWED_TWITCH_USERS = new Set(['2o3a', 'paim_beach_pete']);
const DEFAULT_STREAM_SETTINGS = {
  streamMode: 'all',
  queueOpen: true,
  subsOnly: false,
  autoPlayNext: true,
  allowYouTube: true,
  allowTwitch: true,
  allowTikTok: true,
  maxDurationMinutes: 12,
};

function readStoredValue(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (error) {
    console.warn(`Could not read saved setting "${key}".`, error);
    return fallback;
  }
}

function writeStoredValue(key, value) {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn(`Could not save setting "${key}".`, error);
    return false;
  }
}

function normalizeRoomName(value) {
  return String(value || '').trim().toLowerCase().replace(/^#/, '').replace(/[^a-z0-9_]/g, '').slice(0, 25);
}

function roomStorageKey(room, suffix) {
  return `${STORAGE_PREFIX}:room:${encodeURIComponent(normalizeRoomName(room))}:${suffix}`;
}

function normalizeTwitchLogin(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '');
}

function compareQueuePriority(a, b) {
  if (Boolean(a?.pinned) !== Boolean(b?.pinned)) return a?.pinned ? -1 : 1;
  const voteDifference = (Number(b?.upvotes) || 0) - (Number(a?.upvotes) || 0);
  if (voteDifference !== 0) return voteDifference;
  return (Number(a?.timestamp) || 0) - (Number(b?.timestamp) || 0);
}

function normalizeLegacyVideoVotes(video) {
  // Old browser storage / Firestore documents can outlive a deployed client version.
  // Normalize them once at the boundary so malformed fields cannot crash History rendering.
  const raw = video && typeof video === 'object' && !Array.isArray(video) ? video : {};
  const validStatuses = new Set(['queue', 'playing', 'watched', 'watch_later']);
  const validPlatforms = new Set(['youtube', 'tiktok', 'twitch', 'kick', 'external']);
  const title = typeof raw.title === 'string' && raw.title.trim()
    ? raw.title.trim()
    : (typeof raw.title?.title === 'string' && raw.title.title.trim()
      ? raw.title.title.trim()
      : (typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : 'Untitled video'));
  const timestamp = Number(raw.timestamp);
  const safeId = raw.id !== undefined && raw.id !== null && String(raw.id).trim()
    ? String(raw.id)
    : `legacy-${Number.isFinite(timestamp) ? timestamp : 0}-${String(raw.videoId || raw.url || title).replace(/[^a-z0-9_-]/gi, '').slice(0, 32)}`;
  const hasVoters = Array.isArray(raw.voters);
  const voters = hasVoters
    ? raw.voters.map((item) => typeof item === 'string' || typeof item === 'number' ? String(item) : '').filter(Boolean)
    : [];

  return {
    ...raw,
    id: safeId,
    title,
    url: typeof raw.url === 'string' ? raw.url : '',
    platform: validPlatforms.has(raw.platform) ? raw.platform : 'external',
    videoId: raw.videoId === undefined || raw.videoId === null ? '' : String(raw.videoId),
    category: typeof raw.category === 'string' && raw.category.trim() ? raw.category : 'General',
    mediaType: typeof raw.mediaType === 'string' ? raw.mediaType : '',
    requestedBy: typeof raw.requestedBy === 'string' || typeof raw.requestedBy === 'number' ? String(raw.requestedBy) : 'Viewer',
    status: validStatuses.has(raw.status) ? raw.status : 'queue',
    duration: typeof raw.duration === 'string' ? raw.duration : '03:45',
    durationSec: Number.isFinite(Number(raw.durationSec)) && Number(raw.durationSec) > 0 ? Number(raw.durationSec) : undefined,
    addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : 'Previously added',
    watchedAt: typeof raw.watchedAt === 'string' ? raw.watchedAt : '',
    note: typeof raw.note === 'string' ? raw.note : '',
    thumbnail: typeof raw.thumbnail === 'string' ? raw.thumbnail : '',
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    queueOrder: raw.queueOrder === undefined || raw.queueOrder === null || !Number.isFinite(Number(raw.queueOrder)) ? undefined : Number(raw.queueOrder),
    pinned: Boolean(raw.pinned),
    upvotes: Math.max(0, hasVoters ? (Number(raw.upvotes) || 0) : ((Number(raw.upvotes) || 0) - 1)),
    voters,
  };
}

function estimateVideoDurationSeconds(video) {
  const storedDuration = Number(video?.durationSec);
  if (video?.platform === 'tiktok' || video?.platform === 'twitch') {
    return storedDuration > 0 && storedDuration <= 90 ? storedDuration : 45;
  }
  if (Number.isFinite(storedDuration) && storedDuration > 0) return storedDuration;
  const match = String(video?.duration || '').match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (match) return (Number(match[1] || 0) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
  return 225;
}

function formatQueueWait(seconds) {
  const rounded = Math.max(0, Math.round(Number(seconds) || 0));
  if (rounded < 60) return `~${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder ? `~${minutes}m ${remainder}s` : `~${minutes}m`;
}

function getSavedRoom() {
  // This private dashboard is dedicated to 2o3a; URL parameters cannot switch rooms.
  return PRIVATE_CHANNEL;
}

function getFirebaseConfig() {
  // Some embedded previews provide configuration as a global string.
  try {
    if (typeof __firebase_config !== 'undefined' && __firebase_config) {
      const raw = __firebase_config;
      const candidate = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (candidate?.apiKey && candidate?.projectId && candidate?.appId) return candidate;
    }
  } catch (error) {
    console.warn('Embedded Firebase configuration could not be parsed.', error);
  }

  // On Vercel, configure these as VITE_ environment variables.
  const env = import.meta.env || {};
  const config = {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  };
  return config.apiKey && config.projectId && config.appId ? config : null;
}

// Common automated accounts are ignored by the hidden Twitch IRC command bridge.
const KNOWN_CHAT_BOTS = new Set([
  'nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot',
  'botrix', 'deepbot', 'sery_bot', 'serybot', 'mixitup', 'soundalerts',
  'commanderroot', 'tangia', 'firebot', 'own3d', 'botisimo', 'blerp',
  'pretzelrocks', 'monstercat', 'vivbot', 'ankhbot', 'ohbot', 'phantombot',
  'streamcaptain', 'streamstickers', 'sery_bot', 'gachibot69'
]);

// Treat a message consisting of a supported video URL as a request even without !assr.
function isSupportedMediaUrlMessage(rawText = '') {
  const candidate = String(rawText || '').trim();
  if (!candidate || /\s/.test(candidate)) return false;
  return /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|m\.youtube\.com|youtu\.be|music\.youtube\.com|tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|twitch\.tv|clips\.twitch\.tv|kick\.com|clip\.kick\.com)\/\S+$/i.test(candidate);
}

// Mod volume commands: !volume up/down, !volup/!voldown, !volume 0-100, !mute/!unmute.
function parseModVolumeCommand(rawText) {
  const command = String(rawText || '').trim().toLowerCase();
  if (command === '!volup' || command === '!volumeup' || command === '!vol+') return { action: 'up' };
  if (command === '!voldown' || command === '!volumedown' || command === '!vol-') return { action: 'down' };
  if (command === '!mute') return { action: 'mute' };
  if (command === '!unmute') return { action: 'unmute' };
  const match = command.match(/^!(?:vol|volume)\s+(up|down|mute|unmute|\d{1,3})$/);
  if (!match) return null;
  const value = match[1];
  if (value === 'up' || value === 'down' || value === 'mute' || value === 'unmute') return { action: value };
  return { action: 'set', value: Math.max(0, Math.min(100, Number(value))) };
}

function isStaffRole(role) {
  return role === 'streamer' || role === 'moderator';
}


const CATEGORY_META = {
  Music: {
    label: 'Music',
    icon: Music,
    badgeBg: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    colorHex: '#f43f5e',
    keywords: [
      'official music video', 'official video', 'official audio', 'lyrics',
      'lyric video', 'feat.', 'ft.', 'prod.', 'prod by', 'remix', 'soundtrack',
      'ost', 'bgm', 'instrumental', 'bass boosted', 'live performance', 'album',
      'lofi', 'synthwave', 'beat', 'trap', 'rap', 'hip hop', 'guitar', 'piano cover',
      'vocaloid', 'nightcore', 'orchestra', 'acoustic', 'visualizer', 'ep', 'single'
    ]
  },
  Gaming: {
    label: 'Gaming',
    icon: Gamepad2,
    badgeBg: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    colorHex: '#10b981',
    keywords: [
      'gameplay', 'walkthrough', 'speedrun', 'playthrough', 'fragmovie', 'montage',
      'clutch', 'valorant', 'cs2', 'counter-strike', 'fortnite', 'league of legends',
      'overwatch', 'apex legends', 'gta', 'minecraft', 'elden ring', 'boss fight',
      'esports', 'smash bros', 'roblox', 'highlight', 'ranked', 'ace', 'headshot'
    ]
  },
  Memes: {
    label: 'Memes / Comedy',
    icon: Laugh,
    badgeBg: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    colorHex: '#f59e0b',
    keywords: [
      'meme', 'funny', 'try not to laugh', 'ylyl', 'shitpost', 'hilarious',
      'joke', 'parody', 'fails', 'vines', 'trolling', 'comedy', 'prank',
      'skit', 'lol', 'kekw', 'cursed', 'brainrot'
    ]
  },
  Clips: {
    label: 'Twitch Clips',
    icon: Scissors,
    badgeBg: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
    colorHex: '#8b5cf6',
    keywords: ['twitch clip', 'stream highlight', 'twitch.tv', 'clip', 'streamer react']
  },
  IRL: {
    label: 'IRL / Talk',
    icon: Radio,
    badgeBg: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
    colorHex: '#06b6d4',
    keywords: [
      'podcast', 'interview', 'reaction', 'reacts', 'reacting', 'documentary',
      'debate', 'discussion', 'drama', 'vlog', 'commentary', 'unboxing', 'review',
      'asmr', 'cooking', 'travel', 'live stream'
    ]
  },
  General: {
    label: 'General Video',
    icon: Sparkles,
    badgeBg: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    colorHex: '#94a3b8',
    keywords: []
  }
};

/**
 * Multi-layered detection engine:
 * 1. Checks URL domains (music.youtube.com, clips.twitch.tv, tiktok.com, spotify, etc.)
 * 2. Checks hashtags in request command (e.g. #music, #gaming)
 * 3. Checks keyword heuristic weights across title & note
 * 4. Respects broadcaster mode (e.g. Music-Only streams)
 */
function detectVideoCategory(url = '', title = '', note = '', streamMode = 'all') {
  const cleanUrl = (url || '').toLowerCase();
  const textBlob = `${cleanUrl} ${(title || '')} ${(note || '')}`.toLowerCase();

  // 1. Explicit hashtags
  if (textBlob.includes('#music') || textBlob.includes('#song')) return 'Music';
  if (textBlob.includes('#game') || textBlob.includes('#gaming')) return 'Gaming';
  if (textBlob.includes('#meme') || textBlob.includes('#funny')) return 'Memes';
  if (textBlob.includes('#clip')) return 'Clips';
  if (textBlob.includes('#irl') || textBlob.includes('#podcast')) return 'IRL';

  // 2. Strong URL Domain signals
  if (cleanUrl.includes('music.youtube.com') || cleanUrl.includes('spotify.com') || cleanUrl.includes('soundcloud.com')) {
    return 'Music';
  }
  if (cleanUrl.includes('clips.twitch.tv') || cleanUrl.includes('/clip/')) {
    return 'Clips';
  }
  if (cleanUrl.includes('tiktok.com')) {
    // If stream is Music mode, default to music unless strictly funny
    return textBlob.includes('music') || textBlob.includes('song') || textBlob.includes('sound') ? 'Music' : 'Memes';
  }

  // 3. Keyword Scoring Heuristics
  let bestCategory = streamMode === 'music_only' ? 'Music' : 'General';
  let highestScore = 0;

  for (const [catKey, catData] of Object.entries(CATEGORY_META)) {
    if (catKey === 'General') continue;
    let score = 0;
    for (const kw of catData.keywords) {
      if (textBlob.includes(kw)) {
        // High-confidence keywords grant higher weight
        if (kw === 'official music video' || kw === 'official audio' || kw === 'ost' || kw === 'lyric video') {
          score += 4;
        } else if (kw === 'valorant' || kw === 'cs2' || kw === 'speedrun' || kw === 'gameplay') {
          score += 3;
        } else if (kw === 'try not to laugh' || kw === 'shitpost') {
          score += 3;
        } else {
          score += 1;
        }
      }
    }
    if (score > highestScore) {
      highestScore = score;
      bestCategory = catKey;
    }
  }

  return bestCategory;
}

// Binary media classifier. Strong music signals win; everything else is labelled Non-Music.
// The request pipeline enriches URL-only submissions with public oEmbed titles when available.
function detectMusicType(url = '', title = '', note = '') {
  const parsed = (() => { try { return new URL(String(url || '')); } catch { return null; } })();
  const host = (parsed?.hostname || '').toLowerCase();
  const blob = `${String(url || '')} ${String(title || '')} ${String(note || '')}`.toLowerCase();
  if (host === 'music.youtube.com' || host === 'open.spotify.com' || host.endsWith('.spotify.com') || host.endsWith('.soundcloud.com')) return 'Music';
  if (/(?:^|[\s#])(?:#music|#song|#songrequest)(?:\b|$)/i.test(blob)) return 'Music';
  const musicSignals = [
    'official music video', 'official audio', 'music video', 'lyric video', 'lyrics',
    'soundtrack', 'original soundtrack', 'ost', 'instrumental', 'music', 'song', 'songs',
    'remix', 'album', 'single', 'lofi', 'synthwave', 'hip hop', 'hip-hop', 'rap', 'beat',
    'bass boosted', 'vocaloid', 'nightcore', 'orchestra', 'acoustic', 'piano cover',
    'guitar cover', 'visualizer', 'edm', 'techno', 'house music', 'metal song', 'jazz',
    'classical music', 'bgm', 'karaoke', 'live performance', 'music mix', 'dj set'
  ];
  const nonMusicSignals = [
    'gameplay', 'walkthrough', 'speedrun', 'playthrough', 'fragmovie', 'montage',
    'tutorial', 'how to', 'review', 'podcast', 'interview', 'documentary', 'vlog',
    'reaction', 'reacts', 'try not to laugh', 'meme', 'shitpost', 'comedy', 'prank',
    'fails', 'highlights', 'twitch clip', 'stream highlight', 'news', 'explained'
  ];
  const musicScore = musicSignals.reduce((n, word) => n + (blob.includes(word) ? (['official audio', 'official music video', 'music video', 'soundtrack', 'lyric video'].includes(word) ? 3 : 1) : 0), 0);
  const nonMusicScore = nonMusicSignals.reduce((n, word) => n + (blob.includes(word) ? 1 : 0), 0);
  return musicScore > 0 && musicScore >= nonMusicScore ? 'Music' : 'Non-Music';
}

/**
 * Standardize media platform parsing
 */
function getMediaIdentityKey(platform = '', videoId = '', rawUrl = '') {
  const normalizedPlatform = String(platform || 'web').trim().toLowerCase();
  const normalizedId = String(videoId || '').trim().toLowerCase();

  // Platform IDs deduplicate equivalent URL forms (for example youtu.be and youtube.com).
  if (normalizedPlatform !== 'web' && normalizedId && !normalizedId.startsWith('ext-')) {
    return `${normalizedPlatform}:${normalizedId}`;
  }

  // For generic media URLs, ignore common tracking parameters and trailing slashes.
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    const ignoredParams = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'feature', 'si', 'share', 'ab_channel']);
    const query = [...parsed.searchParams.entries()]
      .filter(([key]) => !ignoredParams.has(key.toLowerCase()))
      .sort(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB))
      .map(([key, value]) => `${key.toLowerCase()}=${value}`)
      .join('&');
    return `url:${host}${pathname}${query ? `?${query}` : ''}`;
  } catch {
    return `url:${String(rawUrl || '').trim().replace(/\/+$/, '').toLowerCase()}`;
  }
}

function isVerticalMedia(video) {
  if (!video) return false;
  if (video.platform === 'tiktok' || video.isVertical === true) return true;
  return String(video.url || '').toLowerCase().includes('youtube.com/shorts/');
}

function parseMediaUrl(rawUrl = '') {
  const url = (rawUrl || '').trim();
  if (!url) return { platform: 'web', videoId: null, thumbnail: null };

  // YouTube / YouTube Music
  const ytMatch = url.match(/(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/i);
  if (ytMatch && ytMatch[1]) {
    return {
      platform: 'youtube',
      videoId: ytMatch[1],
      thumbnail: `https://img.youtube.com/vi/${ytMatch[1]}/hqdefault.jpg`,
      isYouTubeMusic: url.includes('music.youtube.com')
    };
  }

  let parsedUrl = null;
  try { parsedUrl = new URL(url); } catch { /* Invalid URLs are treated as external links below. */ }
  const hostname = parsedUrl?.hostname?.toLowerCase() || '';

  // Twitch Clips
  if ((hostname === 'twitch.tv' || hostname.endsWith('.twitch.tv')) && (url.includes('/clip/') || hostname === 'clips.twitch.tv')) {
    const parts = parsedUrl.pathname.split('/').filter(Boolean);
    const clipIndex = parts.indexOf('clip');
    const clipSlug = (clipIndex >= 0 ? parts[clipIndex + 1] : parts[0]) || 'TwitchClip';
    return {
      platform: 'twitch',
      videoId: clipSlug,
      thumbnail: `https://placehold.co/640x360/581c87/f3e8ff?text=Twitch+Clip+%E2%80%A2+${encodeURIComponent(clipSlug.slice(0, 10))}`
    };
  }

  // Kick Clips are queued as external media and open through the official Kick clip page.
  if (hostname === 'kick.com' || hostname.endsWith('.kick.com')) {
    const parts = (parsedUrl?.pathname || '').split('/').filter(Boolean);
    const clipIndex = parts.findIndex((part) => part.toLowerCase() === 'clips' || part.toLowerCase() === 'clip');
    const clipSlug = clipIndex >= 0 ? parts[clipIndex + 1] : (hostname === 'clip.kick.com' ? parts[0] : null);
    if (clipSlug) {
      return { platform: 'kick', videoId: clipSlug, thumbnail: 'https://placehold.co/640x360/18181b/53fc18?text=Kick+Clip' };
    }
  }

  // TikTok's official embedded player needs the numeric post ID. Short share URLs
  // are resolved by /api/resolve-tiktok on Vercel before the request is saved.
  const isTikTokHost = hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com');
  if (isTikTokHost) {
    const idMatch = url.match(/(?:\/video\/|\/player\/v1\/)(\d{10,25})/i)
      || url.match(/[?&](?:item_id|video_id)=(\d{10,25})/i);
    const vid = idMatch?.[1] || null;
    return {
      platform: 'tiktok',
      videoId: vid,
      thumbnail: 'https://placehold.co/640x360/09090b/ff315f?text=TikTok+Video'
    };
  }

  return {
    platform: 'web',
    videoId: 'ext-' + Math.random().toString(36).substring(2, 8),
    thumbnail: 'https://placehold.co/640x360/18181b/a1a1aa?text=Web+Media+Link'
  };
}

// Production starts with an empty queue; no fabricated sample requests are inserted.
const INITIAL_DEMO_VIDEOS = [];

function YediHubAppContent() {
  // ==========================================
  // FIREBASE CLOUD REAL-TIME INFRASTRUCTURE
  // ==========================================
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [firebaseUser, setFirebaseUser] = useState(null);
  const [cloudSynced, setCloudSynced] = useState(false);
  const [syncStatusText, setSyncStatusText] = useState('Initializing cloud sync...');
  const [roomConfigLoadedFor, setRoomConfigLoadedFor] = useState('');

  // Safe global environment references
  const appId = typeof __app_id !== 'undefined' ? __app_id : (import.meta.env.VITE_FIREBASE_NAMESPACE || 'streampulse-live-deck');

  // ==========================================
  // CHANNEL ROOM & AUTHENTICATION STATE
  // ==========================================
  // Streamers and mods share the room based on the Broadcaster's Twitch username
  const [channelRoom, setChannelRoom] = useState(() => getSavedRoom());
  const [roomInput, setRoomInput] = useState(() => getSavedRoom());

  // Local simulated Twitch user session
  const [twitchAuth, setTwitchAuth] = useState({ username: '', displayName: 'Signed out', role: 'viewer', color: '#a970ff', avatarLetter: 'Y', authenticated: false });
  const [twitchAuthLoading, setTwitchAuthLoading] = useState(true);
  const [firebaseLoginToken, setFirebaseLoginToken] = useState('');
  const authorizedLoginRef = useRef('');

  // UI Modals
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [showObsOverlay, setShowObsOverlay] = useState(false);

  // Queue Moderation Settings
  const [streamSettings, setStreamSettings] = useState(() => {
    const saved = readStoredValue(roomStorageKey(channelRoom, 'settings'), {});
    // Ignore the retired approval toggle from settings saved by an earlier version.
    const compatibleSaved = saved && typeof saved === 'object'
      ? Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'requireApproval'))
      : {};
    return { ...DEFAULT_STREAM_SETTINGS, ...compatibleSaved };
  });

  // Keep queue closure synchronous so incoming Twitch messages cannot read a stale render state.
  const queueOpenRef = useRef(Boolean(streamSettings.queueOpen));
  const queueOpenCloudOverrideRef = useRef(null);
  useEffect(() => {
    queueOpenRef.current = Boolean(streamSettings.queueOpen);
  }, [streamSettings.queueOpen]);

  // Videos master state. Persist locally even when Firebase is not configured or is offline.
  const [videos, setVideos] = useState(() => {
    const saved = readStoredValue(roomStorageKey(channelRoom, 'videos'), null);
    if (Array.isArray(saved)) {
      return saved
        .filter((video) => video && typeof video === 'object' && !String(video.id || '').startsWith('demo-'))
        .map(normalizeLegacyVideoVotes);
    }
    // Start empty so demo requests never appear to be real viewer submissions.
    return [];
  });
  const videosRef = useRef(videos);
  const pendingMediaRequestKeysRef = useRef(new Set());
  useEffect(() => {
    videosRef.current = videos;
  }, [videos]);

  // Filter & Nav State
  const [activeTab, setActiveTab] = useState('queue'); // 'queue' | 'watch_later' | 'watched'
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('priority'); // 'priority' | 'upvotes' | 'newest'

  // Player State
  const [simProgress, setSimProgress] = useState(0);
  const [isTheatreMode, setIsTheatreMode] = useState(false);
  const [youtubeVolume, setYoutubeVolume] = useState(100);
  const [youtubeMuted, setYoutubeMuted] = useState(false);
  const [tiktokPlayerState, setTikTokPlayerState] = useState({ requestId: '', status: 'idle' });
  const [tiktokPlaybackState, setTikTokPlaybackState] = useState({ requestId: '', isPlaying: true, isMuted: false });
  // Remember an explicit mute/unmute choice so startup recovery never overrides the app's mute button.
  const tiktokMutePreferenceRef = useRef({ requestId: '', preference: 'auto' });
  const [tiktokFrameReload, setTikTokFrameReload] = useState(0);
  const [chatBotSession, setChatBotSession] = useState({ loading: true, connected: false, username: '' });
  const youtubeIframeRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const youtubePlaybackInfoRef = useRef({ currentTime: 0, duration: 0, volume: 100, muted: false, playerState: -1 });
  const tiktokIframeRef = useRef(null);
  const handleSkipNextRef = useRef(null);
  const handleVolumeCommandRef = useRef(null);
  const handleIncomingChatCommandRef = useRef(null);
  const handleUpvoteRef = useRef(null);
  const handleVoteCommandRef = useRef(null);
  const handleQueuePositionRef = useRef(null);
  const currentVideoRef = useRef(null);
  const handleMediaEndedRef = useRef(null);
  const voteAttemptsRef = useRef(new Set());
  const positionCommandCooldownRef = useRef(new Map());
  const chatReplyQueueRef = useRef(Promise.resolve());
  const lastChatReplyAtRef = useRef(0);
  const reauthNoticeShownRef = useRef(false);
  const [votedIds, setVotedIds] = useState(() => {
    const saved = readStoredValue(roomStorageKey(channelRoom, 'votes'), {});
    return saved && typeof saved === 'object' ? saved : {};
  });

  // Manual Request Form State
  const [reqUrl, setReqUrl] = useState('');
  const [reqTitle, setReqTitle] = useState('');
  const [reqCategory, setReqCategory] = useState('Auto');
  const [reqNote, setReqNote] = useState('');
  const [reqUsername, setReqUsername] = useState('');

  // Twitch IRC bridge only: no chat transcript or message UI is rendered.
  const [ircConnected, setIrcConnected] = useState(false);
  const ircSocketRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const shouldReconnectIrcRef = useRef(true);
  const ircTargetRef = useRef(channelRoom);


  // Notifications
  const [toasts, setToasts] = useState([]);
  const addToast = (message, type = 'info') => {
    // Seamless mode: suppress routine informational/success popups.
    if (type === 'info' || type === 'success') return;
    const id = 'toast-' + Date.now() + Math.random().toString(36).slice(2, 6);
    setToasts((prev) => [...prev.slice(-3), { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3800);
  };



  // Browser persistence is the reliable fallback when Firebase is not configured.
  useEffect(() => {
    if (!normalizeRoomName(channelRoom)) return;
    writeStoredValue(roomStorageKey(channelRoom, 'videos'), videos);
  }, [videos, channelRoom]);

  useEffect(() => {
    if (!normalizeRoomName(channelRoom)) return;
    writeStoredValue(roomStorageKey(channelRoom, 'settings'), streamSettings);
  }, [streamSettings, channelRoom]);

  useEffect(() => {
    if (!normalizeRoomName(channelRoom)) return;
    writeStoredValue(roomStorageKey(channelRoom, 'votes'), votedIds);
  }, [votedIds, channelRoom]);

  useEffect(() => {
    if (normalizeRoomName(channelRoom)) writeStoredValue(`${STORAGE_PREFIX}:active-room`, normalizeRoomName(channelRoom));
    else if (typeof window !== 'undefined') window.localStorage.removeItem(`${STORAGE_PREFIX}:active-room`);
  }, [channelRoom]);

  // The server allows only the two named Twitch accounts and returns their fixed role.
  // URL query parameters and browser storage cannot grant access or change rooms.
  useEffect(() => {
    let cancelled = false;
    setTwitchAuthLoading(true);
    fetch('/api/twitch/session', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Twitch session unavailable')))
      .then((session) => {
        if (cancelled) return;
        const login = String(session.user?.login || '').toLowerCase();
        const allowed = Boolean(session.authenticated && ALLOWED_TWITCH_USERS.has(login));
        authorizedLoginRef.current = allowed ? login : '';
        const customToken = allowed ? String(session.firebaseCustomToken || '') : '';
        setFirebaseLoginToken(customToken);
        if (allowed) {
          const hasWebFirebaseConfig = Boolean(getFirebaseConfig());
          const firebaseDiagnostic = String(session.firebaseDiagnostic || '');
          const firebaseDiagnosticMessages = {
            missing_service_account: 'Firebase service account missing in Vercel',
            invalid_service_account_json: 'Firebase service-account JSON is invalid',
            service_account_missing_project_id: 'Firebase service-account JSON is missing project_id',
            service_account_missing_client_email: 'Firebase service-account JSON is missing client_email',
            service_account_missing_private_key: 'Firebase service-account JSON is missing private_key',
            invalid_service_account_credentials: 'Firebase service-account key is invalid',
            firebase_admin_sdk_unavailable: 'Firebase Admin SDK failed to load',
            firebase_custom_token_failed: 'Firebase custom-token creation failed',
          };
          if (!hasWebFirebaseConfig) {
            setSyncStatusText('Twitch verified — Firebase web config missing');
          } else if (!customToken || session.firebaseTokenReady !== true) {
            const diagnosticCode = String(session.firebaseDiagnosticCode || '').trim();
            const reason = firebaseDiagnostic === 'firebase_custom_token_failed' && diagnosticCode
              ? `Firebase custom-token creation failed (${diagnosticCode})`
              : (firebaseDiagnosticMessages[firebaseDiagnostic] || 'Firebase server token unavailable');
            setSyncStatusText(`Twitch verified — ${reason}`);
          } else {
            setSyncStatusText('Connecting private cloud sync…');
          }
        }
        setTwitchAuth({
          username: allowed ? login : '',
          displayName: allowed ? (session.user?.display_name || login) : 'Access restricted',
          role: allowed ? (session.role || (login === '2o3a' ? 'streamer' : 'moderator')) : 'viewer',
          color: '#a970ff',
          avatarLetter: allowed ? (session.user?.display_name || login).charAt(0).toUpperCase() : 'Y',
          authenticated: allowed,
          userId: allowed ? (session.user?.id || '') : ''
        });
      })
      .catch(() => {
        if (cancelled) return;
        authorizedLoginRef.current = '';
        setFirebaseLoginToken('');
        setTwitchAuth({ username: '', displayName: 'Signed out', role: 'viewer', color: '#a970ff', avatarLetter: 'Y', authenticated: false });
      })
      .finally(() => { if (!cancelled) setTwitchAuthLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // The chat bot has a separate server-side Twitch session. It does not grant dashboard access.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/twitch/bot-session', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Chat bot session unavailable')))
      .then((session) => {
        if (cancelled) return;
        setChatBotSession({
          loading: false,
          connected: Boolean(session.connected && String(session.user?.login || '').toLowerCase() === 'gachibot69'),
          username: session.connected ? String(session.user?.login || 'gachibot69') : ''
        });
      })
      .catch(() => {
        if (!cancelled) setChatBotSession({ loading: false, connected: false, username: '' });
      });

    const params = new URLSearchParams(window.location.search);
    if (params.get('bot_connected') === '1') {
      addToast('Chat bot @gachibot69 connected. Queue replies will use that account.', 'success');
      params.delete('bot_connected');
    }
    const botError = params.get('bot_error');
    if (botError) {
      const explanation = botError === 'wrong_account'
        ? 'Please authorize Twitch account @gachibot69 for chat messages.'
        : botError === 'missing_scope'
        ? 'Twitch did not grant chat-write permission. Reconnect the bot and approve the requested permission.'
        : 'The chat-bot Twitch login did not complete. Please try again.';
      addToast(explanation, 'warning');
      params.delete('bot_error');
    }
    if (params.has('bot_connected') || botError) {
      const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', nextUrl);
    }
    return () => { cancelled = true; };
  }, []);

  // Firebase is initialized without anonymous sign-in. Only the server-issued custom token
  // for the currently authenticated allowlisted Twitch account can open the cloud queue.
  useEffect(() => {
    let active = true;
    let unsubscribeAuth = null;
    const config = getFirebaseConfig();

    if (!config) {
      setDb(null);
      setAuth(null);
      setFirebaseUser(null);
      setCloudSynced(false);
      setSyncStatusText('Saved in this browser (cloud sync not configured)');
      return () => { active = false; };
    }

    try {
      const appName = 'yedi-hub-private';
      const existingApp = getApps().find((item) => item.name === appName);
      const app = existingApp || initializeApp(config, appName);
      const authInstance = getAuth(app);
      const dbInstance = getFirestore(app);
      setDb(dbInstance);
      setAuth(authInstance);
      setSyncStatusText('Waiting for approved Twitch login…');

      unsubscribeAuth = onAuthStateChanged(authInstance, async (user) => {
        if (!active) return;
        if (!user) {
          setFirebaseUser(null);
          setCloudSynced(false);
          setSyncStatusText(ALLOWED_TWITCH_USERS.has(String(authorizedLoginRef.current || '').toLowerCase()) ? 'Connecting private cloud sync…' : 'Waiting for approved Twitch login…');
          return;
        }
        try {
          const tokenResult = await getIdTokenResult(user);
          const claims = tokenResult.claims || {};
          const claimLogin = String(claims.twitchLogin || '').toLowerCase();
          const claimsValid = claims.yediAuthorized === true &&
            ['streamer', 'moderator'].includes(String(claims.role || '')) &&
            ALLOWED_TWITCH_USERS.has(claimLogin) &&
            claimLogin === authorizedLoginRef.current;
          if (!claimsValid) {
            await signOut(authInstance);
            if (active) {
              setFirebaseUser(null);
              setCloudSynced(false);
              setSyncStatusText('Waiting for approved Twitch login…');
            }
            return;
          }
          if (active) {
            setFirebaseUser(user);
            setSyncStatusText('Verified private cloud session');
          }
        } catch (error) {
          console.warn('Could not verify Firebase custom claims.', error);
          try { await signOut(authInstance); } catch { /* no active session */ }
          if (active) {
            setFirebaseUser(null);
            setCloudSynced(false);
            setSyncStatusText('Cloud verification failed — local save is active');
          }
        }
      });
    } catch (error) {
      console.warn('Firebase initialization failed; using browser storage.', error);
      setDb(null);
      setAuth(null);
      setFirebaseUser(null);
      setCloudSynced(false);
      setSyncStatusText('Firebase unavailable — local save is active');
    }

    return () => {
      active = false;
      if (unsubscribeAuth) unsubscribeAuth();
    };
  }, []);

  // Exchange the server-minted custom token only after the API verifies an allowlisted Twitch login.
  useEffect(() => {
    if (!auth || !firebaseLoginToken || !twitchAuth.authenticated) return;
    let active = true;
    signInWithCustomToken(auth, firebaseLoginToken).catch((error) => {
      console.warn('Secure Firebase sign-in failed; browser-local queue remains available.', error);
      if (active) {
        setCloudSynced(false);
        setSyncStatusText('Secure cloud sign-in unavailable — local save is active');
      }
    });
    return () => { active = false; };
  }, [auth, firebaseLoginToken, twitchAuth.authenticated]);

  // ==========================================
  // REAL-TIME FIRESTORE LISTENER FOR ROOM
  // ==========================================
  const initializedCloudRoomsRef = useRef(new Set());
  const legacyVoteMigrationRef = useRef(new Set());

  useEffect(() => {
    if (!db || !firebaseUser || !normalizeRoomName(channelRoom)) return;

    let active = true;
    try {
      const colRef = collection(db, 'artifacts', appId, 'public', 'data', 'queue_videos');
      const unsubscribe = onSnapshot(
        colRef,
        (snapshot) => {
          if (!active) return;
          setCloudSynced(true);
          setSyncStatusText('Cloud Synced');

          // Normalize legacy seed votes and migrate each Firestore document once. This keeps old
          // requests' displayed vote counts honest and makes voter identity persistence consistent.
          const list = snapshot.docs.map((d) => {
            const rawData = d.data();
            const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData) ? rawData : {};
            const normalized = {
              ...normalizeLegacyVideoVotes(data),
              id: d.id,
              mediaType: data.mediaType || detectMusicType(data.url, data.title, data.note),
            };
            if (!Array.isArray(data.voters) && !legacyVoteMigrationRef.current.has(d.id)) {
              legacyVoteMigrationRef.current.add(d.id);
              updateDoc(d.ref, { upvotes: normalized.upvotes, voters: [] }).catch((error) => {
                legacyVoteMigrationRef.current.delete(d.id);
                console.warn('Could not migrate legacy vote counts for one queue item.', error);
              });
            }
            return normalized;
          });
          const roomList = list.filter(
            (v) => v && typeof v === 'object' && normalizeRoomName(v.channelRoom) === normalizeRoomName(channelRoom) && !String(v.id || '').startsWith('demo-')
          );

          if (roomList.length > 0) {
            initializedCloudRoomsRef.current.add(normalizeRoomName(channelRoom));
            setVideos(roomList);
            return;
          }

          const normalizedRoom = normalizeRoomName(channelRoom);
          const firstSnapshotForRoom = !initializedCloudRoomsRef.current.has(normalizedRoom);
          if (!firstSnapshotForRoom) {
            // A later empty snapshot means the shared queue was cleared remotely.
            setVideos([]);
            return;
          }

          initializedCloudRoomsRef.current.add(normalizedRoom);
          const localVideos = readStoredValue(roomStorageKey(normalizedRoom, 'videos'), []);
          const hasRealSavedQueue = Array.isArray(localVideos) && localVideos.length > 0 &&
            localVideos.some((video) => !String(video.id || '').startsWith('demo-'));
          if (hasRealSavedQueue) {
            // Preserve real locally saved requests when this room has not yet been uploaded to Firebase.
            // Built-in demo rows are intentionally not copied into a new live cloud queue.
            setSyncStatusText('Uploading saved queue to cloud…');
            Promise.all(localVideos.filter((video) => !String(video.id || '').startsWith('demo-')).map((video) => {
              const videoId = String(video.id || `vid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
              const itemRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', videoId);
              return setDoc(itemRef, { ...video, id: videoId, channelRoom: normalizedRoom, createdAt: video.timestamp || Date.now() }, { merge: true });
            })).then(() => {
              if (active) setSyncStatusText('Cloud Synced');
            }).catch((error) => {
              console.error('Could not upload local queue to Firestore.', error);
              if (active) {
                setCloudSynced(false);
                setSyncStatusText('Cloud upload failed — local save is active');
              }
            });
          } else {
            setVideos([]);
          }
        },
        (error) => {
          console.error('Firestore listener error:', error);
          if (active) {
            setCloudSynced(false);
            setSyncStatusText('Cloud sync failed — local save is active');
            addToast('Cloud sync failed. Your browser-local queue is still available.', 'warning');
          }
        }
      );

      return () => {
        active = false;
        unsubscribe();
      };
    } catch (error) {
      console.error('Firestore subscription failed:', error);
      setCloudSynced(false);
      setSyncStatusText('Cloud unavailable — local save is active');
    }
  }, [db, firebaseUser, channelRoom, appId]);

  // Persist the channel's moderation settings in Firestore so they follow the broadcaster
  // across browsers/devices. The room name itself is also carried in the ?channel= URL.
  useEffect(() => {
    const normalizedRoom = normalizeRoomName(channelRoom);
    if (!normalizedRoom || !db || !firebaseUser) {
      // Do not mark cloud settings as loaded until a Firestore snapshot arrives.
      // This prevents local defaults from overwriting an existing room configuration.
      setRoomConfigLoadedFor('');
      return undefined;
    }

    let active = true;
    const configRef = doc(db, 'artifacts', appId, 'public', 'data', 'room_settings', normalizedRoom);
    const unsubscribe = onSnapshot(configRef, (snapshot) => {
      if (!active) return;
      if (snapshot.exists()) {
        const cloudConfig = snapshot.data() || {};
        if (cloudConfig.streamSettings && typeof cloudConfig.streamSettings === 'object') {
          const merged = { ...DEFAULT_STREAM_SETTINGS, ...cloudConfig.streamSettings };
          // If the user just changed queueOpen locally, don't let a stale cloud snapshot reopen it.
          const localQueueOverride = queueOpenCloudOverrideRef.current;
          if (localQueueOverride && Boolean(merged.queueOpen) !== localQueueOverride.value) {
            merged.queueOpen = localQueueOverride.value;
          } else if (localQueueOverride) {
            // The cloud has acknowledged the local queue setting.
            queueOpenCloudOverrideRef.current = null;
          }
          queueOpenRef.current = Boolean(merged.queueOpen);
          setStreamSettings((current) => JSON.stringify(current) === JSON.stringify(merged) ? current : merged);
        }
        setRoomConfigLoadedFor(normalizedRoom);
        return;
      }

      // First setup of a room: seed its cloud configuration from local settings/defaults.
      const local = readStoredValue(roomStorageKey(normalizedRoom, 'settings'), {});
      const seed = { ...DEFAULT_STREAM_SETTINGS, ...(local && typeof local === 'object' ? local : {}) };
      setDoc(configRef, { channelRoom: normalizedRoom, streamSettings: seed, bridgeAutoConnect: true, updatedAt: Date.now() }, { merge: true })
        .then(() => { if (active) setRoomConfigLoadedFor(normalizedRoom); })
        .catch((error) => {
          console.warn('Could not initialize cloud room settings.', error);
          if (active) {
            setRoomConfigLoadedFor(normalizedRoom);
            setSyncStatusText('Queue cloud connected; room settings could not be saved');
          }
        });
    }, (error) => {
      console.error('Room settings listener error.', error);
      if (active) {
        setRoomConfigLoadedFor(normalizedRoom);
        setSyncStatusText('Room settings unavailable — local settings active');
      }
    });

    return () => { active = false; unsubscribe(); };
  }, [db, firebaseUser, channelRoom, appId]);

  useEffect(() => {
    const normalizedRoom = normalizeRoomName(channelRoom);
    if (!normalizedRoom || !db || !firebaseUser || roomConfigLoadedFor !== normalizedRoom) return;
    const configRef = doc(db, 'artifacts', appId, 'public', 'data', 'room_settings', normalizedRoom);
    setDoc(configRef, { channelRoom: normalizedRoom, streamSettings, bridgeAutoConnect: true, updatedAt: Date.now() }, { merge: true })
      .catch((error) => {
        console.warn('Could not save cloud room settings.', error);
        setSyncStatusText('Room settings save failed — local settings remain saved');
      });
  }, [db, firebaseUser, appId, channelRoom, streamSettings, roomConfigLoadedFor]);

  // Sync Video Changes Helper (updates Firestore if online, updates state locally)
  const syncUpdateVideo = async (videoId, updates) => {
    videosRef.current = videosRef.current.map((v) => (v.id === videoId ? { ...v, ...updates } : v));
    setVideos((prev) =>
      prev.map((v) => (v.id === videoId ? { ...v, ...updates } : v))
    );

    if (db && firebaseUser) {
      try {
        const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', videoId);
        await updateDoc(docRef, updates);
      } catch (e) {
        // Doc might not exist yet if demo item
        try {
          const fullItem = videos.find((v) => v.id === videoId);
          if (fullItem) {
            const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', videoId);
            await setDoc(docRef, { ...fullItem, ...updates, channelRoom: normalizeRoomName(channelRoom) }, { merge: true });
          }
        } catch (innerErr) {
          console.warn('Firestore update failed; the change remains in local storage.', innerErr);
          setCloudSynced(false);
          setSyncStatusText('Cloud update failed — local save is active');
        }
      }
    }
  };

  const syncIncrementUpvote = async (videoId, voterLogin) => {
    setVideos((prev) => prev.map((video) => {
      if (video.id !== videoId) return video;
      const voters = Array.isArray(video.voters) ? video.voters : [];
      if (voters.some((item) => normalizeTwitchLogin(item) === voterLogin)) return video;
      return { ...video, upvotes: (Number(video.upvotes) || 0) + 1, voters: [...voters, voterLogin] };
    }));

    if (db && firebaseUser) {
      try {
        const itemRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', videoId);
        await updateDoc(itemRef, { upvotes: increment(1), voters: arrayUnion(voterLogin) });
      } catch (error) {
        // A legacy/local-only item may not exist in Firestore yet; preserve the vote and voter list.
        try {
          const fullItem = videos.find((video) => video.id === videoId);
          if (fullItem) {
            const itemRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', videoId);
            const voters = Array.isArray(fullItem.voters) ? fullItem.voters : [];
            await setDoc(itemRef, {
              ...fullItem,
              upvotes: (Number(fullItem.upvotes) || 0) + 1,
              voters: [...voters.filter((item) => normalizeTwitchLogin(item) !== voterLogin), voterLogin],
              channelRoom: normalizeRoomName(channelRoom),
            }, { merge: true });
          }
        } catch (fallbackError) {
          console.warn('Could not sync vote; the local vote is saved.', fallbackError);
          setCloudSynced(false);
          setSyncStatusText('Vote saved locally — cloud update failed');
        }
      }
    }
  };

  const syncAddVideo = async (videoObj) => {
    const localItem = { ...videoObj, channelRoom: normalizeRoomName(channelRoom) };
    // Update the ref synchronously so back-to-back chat messages see the new item immediately.
    videosRef.current = [localItem, ...videosRef.current];
    setVideos((prev) => [localItem, ...prev]);

    if (db && firebaseUser) {
      try {
        const itemRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', String(localItem.id));
        await setDoc(itemRef, { ...localItem, createdAt: Date.now() }, { merge: true });
      } catch (error) {
        console.warn('Firestore add failed; the request is still saved locally.', error);
        setCloudSynced(false);
        setSyncStatusText('Cloud write failed — local save is active');
      }
    }
  };

  const syncDeleteVideo = async (videoId) => {
    videosRef.current = videosRef.current.filter((v) => v.id !== videoId);
    setVideos((prev) => prev.filter((v) => v.id !== videoId));

    if (db && firebaseUser) {
      try {
        const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', videoId);
        await deleteDoc(docRef);
      } catch (error) {
        console.warn('Firestore delete failed; the item was removed locally.', error);
        setCloudSynced(false);
        setSyncStatusText('Cloud delete failed — local save is active');
      }
    }
  };

  // ==========================================
  // DERIVED DATA & ACTIVE PLAYING ITEM
  // ==========================================
  // YEDI_RELIABLE_PLAYER_QUEUE_FIX: one platform-independent, persisted queue order.
  const queueOrderValue = (video) => {
    const saved = Number(video?.queueOrder);
    if (video?.queueOrder !== undefined && video?.queueOrder !== null && Number.isFinite(saved)) return saved;
    const legacyTimestamp = Number(video?.timestamp);
    return Number.isFinite(legacyTimestamp) ? legacyTimestamp : 0;
  };
  const compareQueueOrder = (a, b) => queueOrderValue(a) - queueOrderValue(b) ||
    (Number(a?.timestamp) || 0) - (Number(b?.timestamp) || 0) || String(a?.id).localeCompare(String(b?.id));
  const queueOrderSequenceRef = useRef(0);
  const reorderQueueAfterVoteRef = useRef(false);
  const getNextQueueOrder = () => {
    const maxOrder = videos.filter((video) => video.status === 'queue')
      .reduce((max, video) => Math.max(max, queueOrderValue(video)), 0);
    const next = Math.max(maxOrder + 1000, Date.now(), queueOrderSequenceRef.current + 1000);
    queueOrderSequenceRef.current = next;
    return next;
  };

  useEffect(() => {
    if (!reorderQueueAfterVoteRef.current) return;
    reorderQueueAfterVoteRef.current = false;
    const orderedQueue = videos.filter((video) => video.status === 'queue').sort(compareQueuePriority);
    if (!orderedQueue.length) return;
    const orderById = new Map(orderedQueue.map((video, index) => [String(video.id), (index + 1) * 1000]));
    setVideos((previous) => previous.map((video) => {
      const queueOrder = orderById.get(String(video.id));
      return queueOrder === undefined ? video : { ...video, queueOrder };
    }));
    if (db && firebaseUser) {
      void (async () => {
        const batch = writeBatch(db);
        orderedQueue.forEach((video, index) => {
          batch.set(
            doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', String(video.id)),
            { id: String(video.id), queueOrder: (index + 1) * 1000, channelRoom: normalizeRoomName(channelRoom) },
            { merge: true }
          );
        });
        try {
          await batch.commit();
        } catch (error) {
          console.warn('Vote-based queue priority could not be saved atomically; retrying merge writes.', error);
          try {
            await Promise.all(orderedQueue.map((video, index) => setDoc(
              doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', String(video.id)),
              { id: String(video.id), queueOrder: (index + 1) * 1000, channelRoom: normalizeRoomName(channelRoom) },
              { merge: true }
            )));
          } catch (fallbackError) {
            console.warn('Vote-based queue priority could not sync to Firebase.', fallbackError);
            setCloudSynced(false);
            setSyncStatusText('Queue priority saved locally — cloud update failed');
          }
        }
      })();
    }
  }, [videos, db, firebaseUser, appId, channelRoom]);

  const currentVideo = useMemo(() => {
    // Current playing item or top of queue
    const playing = videos.find((v) => v.status === 'playing');
    if (playing) return playing;
    const queued = videos.filter((v) => v.status === 'queue').sort(compareQueueOrder);
    return queued[0] || null;
  }, [videos]);
  // WebSocket callbacks can live longer than a React render; refs keep command handlers current.
  currentVideoRef.current = currentVideo;
  // Older saved queues may have no explicit "playing" status even though their top item is visible.
  // Promote that first item once so vote changes reorder waiting requests, not the video already on screen.
  useEffect(() => {
    const activeItems = videos.filter((video) => video.status === 'playing');
    if (activeItems.length > 1) {
      activeItems.slice(1).forEach((video) => syncUpdateVideo(video.id, { status: 'queue' }));
      return;
    }
    if (activeItems.length === 1) return;
    const firstQueued = videos.filter((video) => video.status === 'queue').sort(compareQueueOrder)[0];
    if (firstQueued) syncUpdateVideo(firstQueued.id, { status: 'playing', pinned: false });
  }, [videos]);

  const counts = useMemo(() => {
    return {
      queue: videos.filter((v) => v.status === 'queue').length,
      watch_later: videos.filter((v) => v.status === 'watch_later').length,
      watched: videos.filter((v) => v.status === 'watched').length,

    };
  }, [videos]);

  // Rank queued items from the same persisted order used by playback.
  // Keep this map derived from the current queue so cards never reference an undefined variable.
  const queueRankById = useMemo(() => {
    const orderedQueue = videos
      .filter((video) => video.status === 'queue')
      .sort(compareQueueOrder);
    return new Map(orderedQueue.map((video, index): [string, number] => [String(video.id), index + 1]));
  }, [videos]);

  const filteredVideos = useMemo(() => {
    return videos
      .filter((v) => v.status === activeTab)
      .filter((v) => (selectedCategory === 'All' ? true : v.category === selectedCategory))
      .filter((v) => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return String(v.title || '').toLowerCase().includes(q) ||
          String(v.requestedBy || '').toLowerCase().includes(q) ||
          String(v.category || '').toLowerCase().includes(q) ||
          String(v.note || '').toLowerCase().includes(q);
      })
      .sort((a, b) => {
        // Active Queue always shows actual playback order. Other tabs may use their selected sort.
        if (activeTab === 'queue') return compareQueueOrder(a, b);
        if (sortBy === 'upvotes') return (Number(b.upvotes) || 0) - (Number(a.upvotes) || 0) || compareQueueOrder(a, b);
        if (sortBy === 'newest') return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0) || compareQueueOrder(a, b);
        return compareQueueOrder(a, b);
      });
  }, [videos, activeTab, selectedCategory, searchQuery, sortBy]);


  const isStaff = twitchAuth.authenticated && (twitchAuth.role === 'streamer' || twitchAuth.role === 'moderator');


  // Connects anonymously to the selected channel's Twitch IRC for commands only
  // ==========================================
  const connectTwitchIrc = (targetChan, options = {}) => {
    const cleanChan = normalizeRoomName(targetChan || ircTargetRef.current || channelRoom);
    if (!cleanChan) {
      addToast('Please enter a valid Twitch channel name.', 'warning');
      return;
    }

    shouldReconnectIrcRef.current = true;
    ircTargetRef.current = cleanChan;
    writeStoredValue(`${STORAGE_PREFIX}:active-room`, cleanChan);
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const previousSocket = ircSocketRef.current;
    if (previousSocket) {
      ircSocketRef.current = null;
      try { previousSocket.close(); } catch { /* Socket may already be closed. */ }
    }

    try {
      const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
      ircSocketRef.current = ws;

      ws.onopen = () => {
        if (ircSocketRef.current !== ws) return;
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 89999)}`);
        ws.send(`JOIN #${cleanChan}`);
        reconnectAttemptsRef.current = 0;
        setIrcConnected(true);
        if (!options.silent) addToast(`Twitch command bridge connected to #${cleanChan}.`, 'success');
      };

      ws.onmessage = (event) => {
        if (ircSocketRef.current !== ws) return;
        const raw = String(event.data || '');
        if (raw.startsWith('PING')) {
          ws.send('PONG :tmi.twitch.tv');
          return;
        }

        if (!raw.includes('PRIVMSG')) return;
        const msgMatch = raw.match(/PRIVMSG #[^ ]+ :(.+)/);
        const badgesMatch = raw.match(/badges=([^;]*)/);
        const moderatorMatch = raw.match(/(?:^|;)mod=([01])/);
        const tagsMatch = raw.match(/^@([^ ]+) /);
        const tagMap = Object.fromEntries((tagsMatch?.[1] || '').split(';').filter(Boolean).map((tag) => {
          const separator = tag.indexOf('=');
          return separator >= 0 ? [tag.slice(0, separator), tag.slice(separator + 1)] : [tag, ''];
        }));
        const prefixLogin = raw.match(/^@[^ ]+ :([^!]+)/)?.[1] || raw.match(/^:([^!]+)/)?.[1] || '';
        const username = String(tagMap['display-name'] || prefixLogin || 'Viewer');
        const voterLogin = normalizeTwitchLogin(prefixLogin || username);
        const text = msgMatch ? msgMatch[1].trim() : '';
        const usernameKey = voterLogin || normalizeTwitchLogin(username);
        const taggedAsBot = String(tagMap['user-type'] || '').toLowerCase() === 'bot' || String(tagMap.bot || '') === '1';
        if (!text || taggedAsBot || KNOWN_CHAT_BOTS.has(usernameKey)) return;

        const badges = (badgesMatch?.[1] || '').split(',').map((badge) => badge.split('/')[0]);
        const role = badges.includes('broadcaster')
          ? 'streamer'
          : (moderatorMatch?.[1] === '1' || badges.includes('moderator'))
          ? 'moderator'
          : badges.includes('vip')
          ? 'vip'
          : badges.includes('subscriber')
          ? 'subscriber'
          : 'viewer';
        const lowerText = text.toLowerCase();
        const isRequestCommand = /^!assr(?:\s|$)/i.test(text);
        const isDirectVideoUrl = isSupportedMediaUrlMessage(text);
        const volumeCommand = parseModVolumeCommand(lowerText);
        if (isRequestCommand || isDirectVideoUrl) {
          handleIncomingChatCommandRef.current?.(voterLogin || username, role, text);
        } else if (lowerText === '!remove' || lowerText === '!unrequest') {
          handleRemoveOwnRequestRef.current?.(voterLogin || username);
        } else if (lowerText === '!queue') {
          handleQueueSummaryRef.current?.(voterLogin || username);
        } else if (/^!bigcock(?:\s+\d+)?$/.test(lowerText)) {
          handleVoteCommandRef.current?.(voterLogin || usernameKey, lowerText);
        } else if (lowerText === '!help') {
          sendTwitchChatReply('whale cum: paste a supported video URL directly in chat, or use !assr <URL or search words> (example: !assr daft punk harder better faster stronger). !remove deletes your most recent waiting request. !position / !when shows your request spots and estimated waits; !queue shows the full queue summary. !bigcock [number] upvotes a waiting video; you cannot vote for your own request.');
          sendTwitchChatReply('Mods/broadcaster: !skip skips to the next track. Volume controls: !volume up, !volume down, !volume 50, !mute, !unmute (aliases !volup / !voldown / !vol 50). Some embedded players restrict remote volume control.');
          sendTwitchChatReply('Queue spots and play times are estimates and can change when new requests or votes arrive. Use !help any time to see these commands.');
        } else if (['!position', '!when', '!myqueue', '!queueposition'].includes(lowerText)) {
          handleQueuePositionRef.current?.(voterLogin || usernameKey);
        } else if (lowerText === '!skip' && isStaffRole(role)) {
          handleSkipNextRef.current?.();
        } else if (volumeCommand && isStaffRole(role)) {
          handleVolumeCommandRef.current?.(volumeCommand, role);
        }
      };

      ws.onerror = () => {
        if (ircSocketRef.current === ws) setIrcConnected(false);
      };

      ws.onclose = () => {
        if (ircSocketRef.current !== ws) return;
        ircSocketRef.current = null;
        setIrcConnected(false);
        if (shouldReconnectIrcRef.current) {
          reconnectAttemptsRef.current += 1;
          const delay = Math.min(30000, 1000 * (2 ** Math.min(reconnectAttemptsRef.current, 5)));
          if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = window.setTimeout(() => {
            connectTwitchIrc(ircTargetRef.current, { silent: true });
          }, delay);
        }
      };
    } catch (error) {
      setIrcConnected(false);
      if (!options.silent) addToast('Could not start the Twitch bridge. It will retry automatically.', 'warning');
    }
  };

  const disconnectTwitchIrc = (manual = true) => {
    if (manual) shouldReconnectIrcRef.current = false;
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const ws = ircSocketRef.current;
    ircSocketRef.current = null;
    if (ws) { try { ws.close(); } catch { /* Already closed. */ } }
    setIrcConnected(false);
  };

  // Persisted channel room => the browser/OBS source automatically reconnects the bridge.
  // This still requires the app page to be open; Vercel does not keep a browser WebSocket alive.
  useEffect(() => {
    const target = PRIVATE_CHANNEL;
    ircTargetRef.current = target;
    shouldReconnectIrcRef.current = Boolean(twitchAuth.authenticated);
    if (!twitchAuth.authenticated) {
      disconnectTwitchIrc(false);
      return undefined;
    }
    const startTimer = window.setTimeout(() => connectTwitchIrc(target, { silent: true }), 150);
    return () => {
      window.clearTimeout(startTimer);
      disconnectTwitchIrc(false);
    };
    // The private bridge always joins 2o3a, and is never started for public/unauthenticated visitors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [twitchAuth.authenticated]);

    // ==========================================
  // REQUEST CREATION & DISPATCH
  // ==========================================
  const handleIncomingChatCommand = async (username, role, rawText) => {
    const requester = normalizeTwitchLogin(username);
    const requestText = String(rawText || '').trim().replace(/^!assr\s*/i, '').trim();
    if (!requestText) {
      sendTwitchChatReply(`@${requester} paste a video URL directly, or use !assr <video URL or search words>, e.g. !assr daft punk one more time.`);
      return;
    }
    if (!queueOpenRef.current) {
      sendTwitchChatReply(`@${requester} requests are currently closed. Try again when the streamer reopens the queue.`);
      return;
    }

    const looksLikeUrl = /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be|music\.youtube\.com|tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|twitch\.tv|clips\.twitch\.tv|kick\.com|clip\.kick\.com)\//i.test(requestText);
    let url = requestText;
    let title = '';
    if (!looksLikeUrl) {
      try {
        const response = await fetch(`/api/search-youtube?q=${encodeURIComponent(requestText.slice(0, 180))}`, { credentials: 'same-origin' });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(result.results) || !result.results.length) {
          sendTwitchChatReply(`@${requester} couldn't find "${requestText.slice(0, 45)}". Try a more specific title or paste a URL.`);
          return;
        }
        url = result.results[0].url;
        title = result.results[0].title || '';
      } catch (error) {
        console.warn('Chat title search failed:', error);
        sendTwitchChatReply(`@${requester} title search is temporarily unavailable. Please try a direct video URL.`);
        return;
      }
    }
    if (!queueOpenRef.current) {
      sendTwitchChatReply(`@${requester} requests are currently closed. Your video was not added; try again when the streamer reopens the queue.`);
      return;
    }
    const ok = await processAndQueueRequest({
      url, title, requestedBy: username, userRole: role,
      note: 'Requested via Twitch chat', manualCategory: null, fromChat: true
    });
    // Successful requests stay silent in chat to avoid spam; errors and closed-queue replies remain enabled.
  };

  handleIncomingChatCommandRef.current = handleIncomingChatCommand;

  const handleRemoveOwnRequestRef = useRef(null);
  const handleQueueSummaryRef = useRef(null);

  const processAndQueueRequest = async ({
    url,
    title = '',
    note = '',
    requestedBy,
    userRole = 'viewer',
    manualCategory = null,
    fromChat = false
  }) => {
    if (!normalizeRoomName(channelRoom)) {
      addToast('Set a Twitch channel in the header before adding requests.', 'warning');
      return false;
    }
    // A closed queue blocks every new request, including requests sent by staff. Staff can
    // still manage/play items already in the queue. Use a ref so Twitch IRC callbacks see the
    // latest setting, not the value captured by an older render.
    if (!queueOpenRef.current) {
      addToast('The media request queue is currently closed by the streamer.', 'warning');
      return false;
    }

    // All platforms and categories are accepted without filtering. Category detection is metadata only.
    let normalizedUrl = String(url || '').trim();
    let parsed = parseMediaUrl(normalizedUrl);

    // TikTok short share links (vm.tiktok.com / vt.tiktok.com / tiktok.com/t/...) do not
    // contain the numeric post ID needed by the embed. Resolve them through a small,
    // domain-restricted Vercel function. Full TikTok video URLs skip this request.
    if (parsed.platform === 'tiktok' && !parsed.videoId) {
      try {
        const response = await fetch(`/api/resolve-tiktok?url=${encodeURIComponent(normalizedUrl)}`);
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.videoId || !result.url) {
          addToast(result.error || 'Could not resolve this TikTok link. Open it and copy the full URL containing /video/ followed by the video ID.', 'warning');
          return false;
        }
        normalizedUrl = result.url;
        parsed = parseMediaUrl(normalizedUrl);
        if (!parsed.videoId) parsed.videoId = result.videoId;
      } catch (error) {
        console.warn('TikTok short-link resolution failed.', error);
        addToast('Could not resolve this TikTok share link here. Try copying the full TikTok URL with /video/ followed by its ID.', 'warning');
        return false;
      }
    }

    // Only allow each media identity once in the room's queue/history, so it can't be
    // re-requested after playing either. Remove the old entry if it should become requestable again.
    const identityKey = getMediaIdentityKey(parsed.platform, parsed.videoId, normalizedUrl);
    const alreadyExists = videosRef.current.some((video) =>
      getMediaIdentityKey(video?.platform, video?.videoId, video?.url) === identityKey
    );
    const requestAlreadyPending = pendingMediaRequestKeysRef.current.has(identityKey);
    if (alreadyExists || requestAlreadyPending) {
      addToast('That video already has an entry in the queue or history. Duplicate request ignored.', 'warning');
      if (fromChat) {
        const requester = normalizeTwitchLogin(requestedBy);
        sendTwitchChatReply(`@${requester || 'viewer'} that video already exists in the queue or history, so I did not add it again.`);
      }
      return false;
    }
    // The lock closes the race where the same URL arrives in two chat messages at once,
    // while metadata/TikTok resolution is still running.
    pendingMediaRequestKeysRef.current.add(identityKey);

    // Fetch public oEmbed metadata for titles and backdrop thumbnails when available.
    let resolvedTitle = String(title || '').trim();
    let resolvedThumbnail = parsed.thumbnail || '';
    if (!resolvedTitle || !resolvedThumbnail || String(resolvedThumbnail).includes('placehold.co')) {
      try {
        const metadataResponse = await fetch(`/api/media-metadata?url=${encodeURIComponent(normalizedUrl)}`);
        if (metadataResponse.ok) {
          const metadata = await metadataResponse.json().catch(() => ({}));
          if (!resolvedTitle && typeof metadata.title === 'string' && metadata.title.trim()) resolvedTitle = metadata.title.trim();
          if (typeof metadata.thumbnailUrl === 'string' && metadata.thumbnailUrl.startsWith('https://')) {
            resolvedThumbnail = metadata.thumbnailUrl;
          }
        }
      } catch (error) {
        console.warn('Media metadata lookup failed; using URL-based category detection.', error);
      }
    }

    // Re-check after async URL/title resolution in case the streamer closed the queue mid-request.
    if (!queueOpenRef.current) {
      pendingMediaRequestKeysRef.current.delete(identityKey);
      addToast('The media request queue is currently closed by the streamer.', 'warning');
      return false;
    }

    const cleanTitle = resolvedTitle ||
      (parsed.platform === 'youtube'
        ? `YouTube Media (${parsed.videoId})`
        : parsed.platform === 'twitch'
        ? `Twitch Clip (${parsed.videoId})`
        : parsed.platform === 'tiktok'
        ? `TikTok Short Clip`
        : parsed.platform === 'kick'
          ? `Kick Clip (${parsed.videoId})`
        : 'Community Requested Media');
    const finalCategory =
      manualCategory && manualCategory !== 'Auto'
        ? manualCategory
        : detectVideoCategory(normalizedUrl, cleanTitle, note, 'all');
    const mediaType = detectMusicType(normalizedUrl, cleanTitle, note);

    const newVideo = {
      id: 'vid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      channelRoom,
      title: cleanTitle,
      url: normalizedUrl,
      platform: parsed.platform,
      videoId: parsed.videoId,
      category: finalCategory,
      mediaType,
      duration: parsed.platform === 'tiktok' || parsed.platform === 'twitch' || parsed.platform === 'kick' ? '00:45' : '03:45',
      durationSec: parsed.platform === 'tiktok' || parsed.platform === 'twitch' || parsed.platform === 'kick' ? 45 : 225,
      requestedBy: normalizeTwitchLogin(requestedBy || twitchAuth.username || 'Viewer') || 'Viewer',
      userRole: 'viewer',
      status: 'queue',
      upvotes: 0,
      voters: [],
      pinned: false,
      addedAt: 'Just now',
      queueOrder: getNextQueueOrder(),
      timestamp: Date.now(),
      note: note || `Added to ${channelRoom} deck`,
      thumbnail: resolvedThumbnail || parsed.thumbnail,
      isVertical: parsed.platform === 'tiktok' || normalizedUrl.toLowerCase().includes('youtube.com/shorts/')
    };

    syncAddVideo(newVideo);
    pendingMediaRequestKeysRef.current.delete(identityKey);

    addToast(`Added "${cleanTitle.slice(0, 24)}..." [${finalCategory}] straight to the queue!`, 'success');
    return true;
  };

  // ==========================================
  // PLAYBACK & QUEUE ACTIONS
  // ==========================================
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
  const handlePlayNow = (video) => {
    exitTikTokFullscreenBeforeTrackChange();
    // Set current active playing to watched, set selected to playing
    videos.forEach((v) => {
      if (v.status === 'playing') {
        syncUpdateVideo(v.id, { status: 'watched', watchedAt: 'Just now' });
      }
    });

    syncUpdateVideo(video.id, { status: 'playing', pinned: false });
    setSimProgress(0);
    addToast(`Now Playing: ${video.title.slice(0, 32)}...`, 'info');
  };

  const handleSkipNext = () => {
    exitTikTokFullscreenBeforeTrackChange();
    const outgoing = currentVideo;
    if (!outgoing) return;

    // Pick the next item first, then change every local status in a single state update.
    // Updating the current and next Firestore documents separately caused transient snapshots
    // with zero/two active players; TikTok iframes could then be torn down mid-navigation.
    const nextOne = videos
      .filter((video) => video.status === 'queue' && video.id !== outgoing.id)
      .sort(compareQueueOrder)[0] || null;
    const updatesById = new Map();
    videos.filter((video) => video.status === 'playing').forEach((video) => {
      updatesById.set(video.id, { status: 'watched', watchedAt: 'Just now' });
    });
    updatesById.set(outgoing.id, { status: 'watched', watchedAt: 'Just now' });
    if (nextOne) updatesById.set(nextOne.id, { status: 'playing', pinned: false });

    setVideos((previous) => previous.map((video) => {
      const updates = updatesById.get(video.id);
      return updates ? { ...video, ...updates } : video;
    }));
    setSimProgress(0);

    if (db && firebaseUser) {
      const batch = writeBatch(db);
      updatesById.forEach((updates, videoId) => {
        batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', videoId), updates);
      });
      batch.commit().catch(async (error) => {
        // In case a locally-created document is missing in Firestore, fall back to merge writes.
        console.warn('Atomic queue advance failed; retrying as merge writes.', error);
        try {
          await Promise.all(Array.from(updatesById.entries()).map(([videoId, updates]) => {
            const item = videos.find((video) => video.id === videoId) || { id: videoId };
            return setDoc(
              doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', videoId),
              { ...item, ...updates, channelRoom: normalizeRoomName(channelRoom) },
              { merge: true }
            );
          }));
        } catch (fallbackError) {
          console.warn('Queue advance could not sync to Firestore; the local transition remains active.', fallbackError);
          setCloudSynced(false);
          setSyncStatusText('Queue advance saved locally — cloud sync failed');
        }
      });
    }

    if (nextOne) {
      addToast(`Skipped! Now playing: ${nextOne.title.slice(0, 28)}...`, 'success');
    } else {
      addToast('Reached end of queue.', 'info');
    }
  };

  // Moderator/broadcaster volume controls use each platform's supported embed API.
  const handleVolumeCommand = (volumeCommand, role) => {
    if (!isStaffRole(role) || !volumeCommand) return;

    if (currentVideo?.platform === 'youtube') {
      const player = youtubePlayerRef.current;
      if (!player || typeof player.getVolume !== 'function' || typeof player.setVolume !== 'function') {
        addToast('YouTube player is not ready for volume commands yet.', 'warning');
        return;
      }
      const current = Math.max(0, Math.min(100, Number(player.getVolume()) || 0));
      let next = current;
      if (volumeCommand.action === 'up') next = Math.min(100, current + 10);
      else if (volumeCommand.action === 'down') next = Math.max(0, current - 10);
      else if (volumeCommand.action === 'set') next = volumeCommand.value;
      else if (volumeCommand.action === 'mute') {
        player.mute();
        setYoutubeMuted(true);
        youtubePlaybackInfoRef.current = { ...youtubePlaybackInfoRef.current, muted: true };
        addToast('YouTube player muted by staff command.', 'info');
        return;
      }
      else if (volumeCommand.action === 'unmute') {
        player.unMute();
        setYoutubeMuted(false);
        youtubePlaybackInfoRef.current = { ...youtubePlaybackInfoRef.current, muted: false };
        addToast('YouTube player unmuted by staff command.', 'info');
        return;
      }
      player.setVolume(next);
      if (next > 0 && typeof player.unMute === 'function') player.unMute();
      if (next === 0 && typeof player.mute === 'function') player.mute();
      setYoutubeVolume(next);
      setYoutubeMuted(next === 0);
      youtubePlaybackInfoRef.current = { ...youtubePlaybackInfoRef.current, volume: next, muted: next === 0 };
      addToast(`YouTube volume set to ${next}%.`, 'success');
      return;
    }

    if (currentVideo?.platform === 'tiktok') {
      const iframeWindow = tiktokIframeRef.current?.contentWindow;
      if (!iframeWindow) { addToast('TikTok player is not ready for volume commands yet.', 'warning'); return; }
      if (volumeCommand.action === 'up' || volumeCommand.action === 'down' || (volumeCommand.action === 'set' && volumeCommand.value !== 0 && volumeCommand.value !== 100)) {
        addToast('TikTok does not allow exact volume changes from chat commands. Use the volume control inside the TikTok player; !mute, !unmute, !volume 0 and !volume 100 still work.', 'info');
        return;
      }
      const shouldMute = volumeCommand.action === 'mute' || (volumeCommand.action === 'set' && volumeCommand.value === 0);
      tiktokMutePreferenceRef.current = { requestId: currentVideo.id, preference: shouldMute ? 'muted' : 'unmuted' };
      const messageType = shouldMute ? 'mute' : 'unMute';
      iframeWindow.postMessage({ type: messageType, value: null, 'x-tiktok-player': true }, 'https://www.tiktok.com');
      addToast(shouldMute ? 'TikTok audio muted by staff command.' : 'TikTok audio unmuted by staff command. Use the in-player slider for incremental volume changes.', 'info');
      return;
    }

    if (currentVideo?.platform === 'twitch') {
      addToast('Twitch Clip embeds do not expose remote volume controls. Adjust volume inside the Clip player.', 'info');
      return;
    }

    addToast('Remote volume control is not supported for this media type.', 'info');
  };

  const handlePreviousTrack = () => {
    exitTikTokFullscreenBeforeTrackChange();
    const outgoing = currentVideoRef.current;
    if (!outgoing) return;
    const previouslyPlayed = videos
      .filter((video) => video.status === 'watched' && video.id !== outgoing.id)
      .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))[0];
    if (!previouslyPlayed) {
      addToast('There is no previous video in history yet.', 'warning');
      return;
    }
    const updates = new Map();
    updates.set(outgoing.id, { status: 'queue', queueOrder: getNextQueueOrder() });
    updates.set(previouslyPlayed.id, { status: 'playing', pinned: false });
    setVideos((previous) => previous.map((video) => {
      const change = updates.get(video.id);
      return change ? { ...video, ...change } : video;
    }));
    setSimProgress(0);
    if (db && firebaseUser) {
      const batch = writeBatch(db);
      updates.forEach((change, id) => batch.set(
        doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', String(id)),
        change, { merge: true }
      ));
      batch.commit().catch((error) => {
        console.warn('Previous-track transition could not sync to Firestore.', error);
        setCloudSynced(false);
        setSyncStatusText('Previous track changed locally — cloud sync failed');
      });
    }
  };

  // Player and bridge callbacks always use current handlers and queue state.
  handleSkipNextRef.current = handleSkipNext;  handleSkipNextRef.current = handleSkipNext;
  handleVolumeCommandRef.current = handleVolumeCommand;
  handleMediaEndedRef.current = (videoId) => {
    if (!currentVideo || currentVideo.id !== videoId) return;
    if (streamSettings.autoPlayNext) {
      handleSkipNextRef.current?.();
    }
  };

  // Use a normal React-owned YouTube iframe. The iframe document is cross-origin, so
  // playback control stays isolated from React's DOM reconciliation (no YT.Player node replacement).
  useEffect(() => {
    const video = currentVideo;
    const iframe = youtubeIframeRef.current;
    if (!video || video.platform !== 'youtube' || !video.videoId || !iframe) {
      youtubePlayerRef.current = null;
      youtubePlaybackInfoRef.current = { currentTime: 0, duration: 0, volume: 100, muted: false, playerState: -1 };
      return undefined;
    }

    const playerWindow = iframe.contentWindow;
    if (!playerWindow) return undefined;
    let cancelled = false;
    let hasStarted = false;
    let endedHandled = false;
    let previousState = -1;
    const postCommand = (func, args = []) => {
      if (cancelled) return;
      try {
        playerWindow.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube.com');
      } catch (error) {
        console.debug('YouTube command could not be sent.', error);
      }
    };
    const proxy = {
      getCurrentTime: () => Number(youtubePlaybackInfoRef.current.currentTime) || 0,
      getDuration: () => Number(youtubePlaybackInfoRef.current.duration) || 0,
      getVolume: () => Number.isFinite(Number(youtubePlaybackInfoRef.current.volume)) ? Number(youtubePlaybackInfoRef.current.volume) : 100,
      setVolume: (value) => postCommand('setVolume', [Math.max(0, Math.min(100, Number(value) || 0))]),
      mute: () => postCommand('mute'),
      unMute: () => postCommand('unMute'),
      playVideo: () => postCommand('playVideo'),
      pauseVideo: () => postCommand('pauseVideo'),
    };
    youtubePlayerRef.current = proxy;

    const initializePlayerMessaging = () => {
      if (cancelled || youtubeIframeRef.current !== iframe) return;
      // The raw iframe API emits playerState/time info after the parent announces a listener.
      try {
        playerWindow.postMessage(JSON.stringify({ event: 'listening', id: `yedi-hub-${video.id}`, channel: 'widget' }), 'https://www.youtube.com');
      } catch { /* Player may still be initializing; the next retry will announce again. */ }
      postCommand('addEventListener', ['onStateChange']);
      postCommand('addEventListener', ['onError']);
      postCommand('getCurrentTime');
      postCommand('getDuration');
      postCommand('getVolume');
      postCommand('playVideo');
    };
    const handleMessage = (event) => {
      if (cancelled || event.source !== playerWindow) return;
      if (event.origin !== 'https://www.youtube.com' && event.origin !== 'https://www.youtube-nocookie.com') return;
      let payload = event.data;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { return; }
      }
      if (!payload || typeof payload !== 'object') return;

      const info = payload.event === 'infoDelivery' && payload.info && typeof payload.info === 'object'
        ? payload.info
        : null;
      const stateFromEvent = payload.event === 'onStateChange' ? Number(payload.info) : Number(info?.playerState);
      if (info) {
        youtubePlaybackInfoRef.current = { ...youtubePlaybackInfoRef.current, ...info };
        if (info.volume !== undefined && Number.isFinite(Number(info.volume))) setYoutubeVolume(Math.max(0, Math.min(100, Number(info.volume))));
        if (info.muted !== undefined) setYoutubeMuted(Boolean(info.muted));
        const now = Number(info.currentTime);
        const duration = Number(info.duration);
        if (Number.isFinite(now) && Number.isFinite(duration) && duration > 0 && currentVideoRef.current?.id === video.id) {
          setSimProgress(Math.min(100, Math.max(0, (now / duration) * 100)));
        }
      }
      if (Number.isFinite(stateFromEvent)) {
        youtubePlaybackInfoRef.current.playerState = stateFromEvent;
        if (stateFromEvent === 1 || stateFromEvent === 2 || stateFromEvent === 3) hasStarted = true;
        if (stateFromEvent === 0 && hasStarted && previousState !== 0 && !endedHandled) {
          endedHandled = true;
          if (currentVideoRef.current?.id === video.id) handleMediaEndedRef.current?.(video.id);
        }
        if (stateFromEvent !== 0) endedHandled = false;
        previousState = stateFromEvent;
      }
      if (payload.event === 'onError') {
        console.warn('YouTube embed reported playback error:', payload.info);
        if (currentVideoRef.current?.id === video.id) {
          addToast('YouTube could not play this video. It may be private, removed, or embedding-disabled.', 'warning');
        }
      }
    };

    window.addEventListener('message', handleMessage);
    // The iframe can ignore commands sent before its API is ready, so retry briefly after mount.
    const retryTimers = [0, 250, 750, 1500].map((delay) => window.setTimeout(initializePlayerMessaging, delay));
    return () => {
      cancelled = true;
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener('message', handleMessage);
      if (youtubePlayerRef.current === proxy) youtubePlayerRef.current = null;
    };
  }, [currentVideo?.id, currentVideo?.videoId, currentVideo?.platform]);

  // TikTok uses one keyed official player iframe per queue item. A new request gets a fresh
  // window reference, listener, and startup timeout; stale messages from the previous iframe
  useEffect(() => {
    const video = currentVideo;
    if (!video || video.platform !== 'tiktok' || !video.videoId) return undefined;
    let cancelled = false;
    let startupUnmuteSent = false;
    const retryTimers = [];
    tiktokMutePreferenceRef.current = { requestId: video.id, preference: 'auto' };
    setTikTokPlaybackState({ requestId: video.id, isPlaying: true, isMuted: false });
    const getWindow = () => tiktokIframeRef.current?.contentWindow;
    const sendCommand = (type, targetWindow = getWindow()) => {
      if (!cancelled && targetWindow && targetWindow === getWindow()) {
        targetWindow.postMessage({ type, value: null, 'x-tiktok-player': true }, 'https://www.tiktok.com');
      }
    };
    const handleTikTokMessage = (event) => {
      if (event.origin !== 'https://www.tiktok.com' || event.source !== getWindow()) return;
      let data = event.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
      if (!data || data['x-tiktok-player'] !== true) return;
      if (data.type === 'onPlayerReady') {
        // Start playback when ready, but wait until it reports PLAYING before unmuting.
        // TikTok can apply its autoplay mute after the ready event, racing an immediate unMute.
        sendCommand('play');
      } else if (data.type === 'onCurrentTime' && data.value) {
        const duration = Number(data.value.duration) || 0;
        const currentTime = Number(data.value.currentTime) || 0;
        if (duration > 0) setSimProgress(Math.min(100, Math.max(0, (currentTime / duration) * 100)));
      } else if (data.type === 'onStateChange') {
        const state = Number(data.value);
        if (state === 1 || state === 2 || state === 0) {
          setTikTokPlaybackState((previous) => previous.requestId === video.id
            ? { ...previous, isPlaying: state === 1 }
            : previous);
        }
        // Recover from TikTok's occasional autoplay mute once playback is genuinely running.
        // This is a one-shot startup correction, not a repeating timer; explicit mute wins.
        if (state === 1 && !startupUnmuteSent) {
          startupUnmuteSent = true;
          const preference = tiktokMutePreferenceRef.current;
          if (preference.requestId !== video.id || preference.preference !== 'muted') {
            sendCommand('unMute');
          }
        }
        // Never auto-unmute again on later pause/resume events.
        if (state === 0) handleMediaEndedRef.current?.(video.id);
      } else if (data.type === 'onMute') {
        setTikTokPlaybackState((previous) => previous.requestId === video.id
          ? { ...previous, isMuted: Boolean(data.value) }
          : previous);
      } else if (data.type === 'onVolumeChange') {
        const volume = Number(data.value);
        if (Number.isFinite(volume)) {
          setTikTokPlaybackState((previous) => previous.requestId === video.id
            ? { ...previous, isMuted: volume <= 0 }
            : previous);
        }
      } else if (data.type === 'onPlayerError') {
        const errorType = data.value?.errorType || 'playback error';
        addToast('TikTok could not play this post (' + errorType + '). Try a public full video URL.', 'warning');
      }
    };
    window.addEventListener('message', handleTikTokMessage);
    return () => {
      cancelled = true;
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener('message', handleTikTokMessage);
    };
  }, [currentVideo?.id, currentVideo?.videoId, currentVideo?.platform]);




  const handleMoveToWatchLater = (video) => {
    const isNowPlaying = video.status === 'playing';
    syncUpdateVideo(video.id, { status: 'watch_later', pinned: false });

    if (isNowPlaying) {
      const nextOne = videos
        .filter((item) => item.status === 'queue' && item.id !== video.id)
        .sort(compareQueueOrder)[0];
      if (nextOne) {
        syncUpdateVideo(nextOne.id, { status: 'playing', pinned: false });
        addToast(`Saved to Watch Later. Now playing: ${nextOne.title.slice(0, 28)}...`, 'success');
      } else {
        addToast('Saved to Watch Later. The queue is now empty.', 'info');
      }
      setSimProgress(0);
        return;
    }

    addToast(`Saved "${video.title.slice(0, 24)}..." to Watch Later list.`, 'info');
  };

  const handleRequeue = (video) => {
    syncUpdateVideo(video.id, {
      status: 'queue',
      queueOrder: getNextQueueOrder(),
      timestamp: Date.now(),
      addedAt: 'Re-queued'
    });
    addToast(`Re-added "${video.title.slice(0, 24)}..." to active queue.`, 'info');
  };

  const handleTogglePin = (video) => {
    if (!isStaff) return;
    const nextPinned = !video.pinned;
    const otherQueued = videos.filter((item) => item.status === 'queue' && String(item.id) !== String(video.id));
    const minOtherOrder = otherQueued.reduce((min, item) => Math.min(min, queueOrderValue(item)), Number.POSITIVE_INFINITY);
    const queueOrder = nextPinned
      ? (Number.isFinite(minOtherOrder) ? minOtherOrder - 1000 : queueOrderValue(video))
      : getNextQueueOrder();
    syncUpdateVideo(video.id, { pinned: nextPinned, queueOrder });
    addToast(nextPinned ? 'Pinned priority to the top of the queue.' : 'Unpinned video and moved it to the end.', 'info');
  };

  const handleCategoryChange = (videoId, newCategory) => {
    syncUpdateVideo(videoId, { category: newCategory });
    addToast(`Category updated to "${newCategory}"`, 'success');
  };

  const handleUpvote = async (videoId, voterUsername = twitchAuth.username) => {
    const voterLogin = normalizeTwitchLogin(voterUsername);
    const target = videos.find((video) => video.id === videoId);
    if (!target) return { ok: false, reason: 'missing' };
    if (target.status !== 'queue') {
      addToast('Only waiting queue videos can be upvoted.', 'info');
      return { ok: false, reason: 'not-queued', video: target };
    }
    if (!voterLogin) {
      addToast('Could not identify the voter. Please try again.', 'warning');
      return { ok: false, reason: 'unknown-voter', video: target };
    }
    if (normalizeTwitchLogin(target.requestedBy) === voterLogin) {
      addToast('You cannot upvote your own request.', 'warning');
      return { ok: false, reason: 'own-request', video: target };
    }

    const voterList = Array.isArray(target.voters) ? target.voters : [];
    const voteKey = `${voterLogin}:${target.id}`;
    if (voterList.some((name) => normalizeTwitchLogin(name) === voterLogin) || votedIds[voteKey] || voteAttemptsRef.current.has(voteKey)) {
      addToast('You already upvoted this video. You can vote on other videos.', 'info');
      return { ok: false, reason: 'already-voted', video: target };
    }

    // Keep the in-memory guard synchronous so repeated chat lines cannot race React state updates.
    voteAttemptsRef.current.add(voteKey);
    reorderQueueAfterVoteRef.current = true;
    setVotedIds((prev) => ({ ...prev, [voteKey]: true }));
    await syncIncrementUpvote(videoId, voterLogin);
    addToast(`+1 vote for "${target.title.slice(0, 28)}" — queue priority updated.`, 'success');
    return { ok: true, video: target };
  };

  handleUpvoteRef.current = handleUpvote;

  const sendTwitchChatReply = (message) => {
    const safeMessage = String(message || '').trim().slice(0, 450);
    if (!safeMessage) return;

    // Serialize replies; the server sends through the dedicated @gachibot69 account and enforces Twitch limits.
    chatReplyQueueRef.current = chatReplyQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const wait = Math.max(0, 1100 - (Date.now() - lastChatReplyAtRef.current));
        if (wait) await new Promise((resolve) => window.setTimeout(resolve, wait));
        const response = await fetch('/api/twitch/chat-message', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: safeMessage })
        });
        lastChatReplyAtRef.current = Date.now();
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          console.warn('whale cum could not reply in Twitch chat:', result.error || response.statusText);
          if (!reauthNoticeShownRef.current && (response.status === 401 || response.status === 403)) {
            reauthNoticeShownRef.current = true;
            addToast(result.error || 'Chat replies need the separate @gachibot69 bot session. Use Connect Bot in the header and authorize that account.', 'warning');
          }
        }
      })
      .catch((error) => console.warn('Twitch chat reply failed.', error));
  };

  const handleVoteCommand = (voterLogin, rawText) => {
    const match = String(rawText || '').trim().toLowerCase().match(/^!bigcock(?:\s+(\d+))?$/);
    if (!match) return;
    const position = Math.max(1, Number(match[1] || 1));
    const queue = videos.filter((video) => video.status === 'queue').sort(compareQueueOrder);
    const target = queue[position - 1];
    if (!target) {
      sendTwitchChatReply(`@${normalizeTwitchLogin(voterLogin) || 'viewer'} there is no queued video at #${position}. Use !position to see your requests.`);
      return;
    }
    handleUpvote(target.id, voterLogin).then((result) => {
      if (!result?.ok && result?.reason === 'own-request') {
        sendTwitchChatReply(`@${normalizeTwitchLogin(voterLogin)} you cannot upvote your own request.`);
      } else if (!result?.ok && result?.reason === 'already-voted') {
        sendTwitchChatReply(`@${normalizeTwitchLogin(voterLogin)} you already voted for that video. You can upvote different videos.`);
      }
    });
  };
  handleVoteCommandRef.current = handleVoteCommand;

  const handleQueuePositionCommand = (requesterLogin) => {
    const requester = normalizeTwitchLogin(requesterLogin);
    if (!requester) return;
    const now = Date.now();
    const lastAskedAt = positionCommandCooldownRef.current.get(requester) || 0;
    if (now - lastAskedAt < 10000) return;
    positionCommandCooldownRef.current.set(requester, now);

    const owned = (video) => normalizeTwitchLogin(video.requestedBy) === requester;
    const playing = videos.find((video) => video.status === 'playing');
    const queued = videos.filter((video) => video.status === 'queue').sort(compareQueueOrder);
    const myQueued = queued.map((video, index) => ({ video, position: index + 1 })).filter((item) => owned(item.video));
    const messages = [];

    if (playing && owned(playing)) messages.push('one request is playing now');

    let secondsAhead = 0;
    if (playing) {
      const duration = estimateVideoDurationSeconds(playing);
      const progress = currentVideo?.id === playing.id && (playing.platform === 'youtube' || playing.platform === 'tiktok')
        ? Math.max(0, Math.min(100, Number(simProgress) || 0))
        : 0;
      secondsAhead = Math.max(0, duration * (1 - progress / 100));
    }
    let queuedDurationBefore = 0;
    const etaById = new Map();
    queued.forEach((video, index) => {
      etaById.set(video.id, secondsAhead + queuedDurationBefore);
      queuedDurationBefore += estimateVideoDurationSeconds(video);
    });

    myQueued.forEach(({ video, position }) => {
      messages.push(`#${position} "${String(video.title || video.platform || 'video').slice(0, 38)}" (est. ${formatQueueWait(etaById.get(video.id))})`);
    });

    if (!messages.length) {
      sendTwitchChatReply(`@${requester} I couldn't find an upcoming request from you. Submit with !assr <URL>, then use !position again.`);
      return;
    }
    const visibleItems = messages.slice(0, 3);
    const extraCount = Math.max(0, messages.length - visibleItems.length);
    const extraNote = extraCount > 0 ? `; plus ${extraCount} more status item${extraCount === 1 ? '' : 's'}` : '';
    sendTwitchChatReply(`@${requester} ${visibleItems.join('; ')}${extraNote}. Waits are estimates and votes can change positions.`);
  };
  handleQueuePositionRef.current = handleQueuePositionCommand;

  const handleRemoveOwnRequest = (requesterLogin) => {
    const requester = normalizeTwitchLogin(requesterLogin);
    if (!requester) return;
    const ownedWaiting = videos
      .filter((video) => video.status === 'queue' && normalizeTwitchLogin(video.requestedBy) === requester)
      .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
    if (!ownedWaiting.length) {
      sendTwitchChatReply(`@${requester} you have no waiting requests to remove. Playing/already-played videos cannot be removed with !remove.`);
      return;
    }
    const target = ownedWaiting[0];
    void syncDeleteVideo(target.id);
    sendTwitchChatReply(`@${requester} removed "${String(target.title || 'your request').slice(0, 70)}" from the queue.`);
  };
  handleRemoveOwnRequestRef.current = handleRemoveOwnRequest;

  const handleQueueSummary = (requesterLogin) => {
    const requester = normalizeTwitchLogin(requesterLogin);
    const playing = videos.find((video) => video.status === 'playing') || null;
    const queued = videos.filter((video) => video.status === 'queue').sort(compareQueueOrder);
    const top = queued.slice(0, 5).map((video, index) =>
      `#${index + 1} ${String(video.title || 'Untitled').slice(0, 35)} (@${normalizeTwitchLogin(video.requestedBy) || 'viewer'}, +${Number(video.upvotes) || 0})`
    );
    const myCount = queued.filter((video) => normalizeTwitchLogin(video.requestedBy) === requester).length;
    const playingText = playing ? `Now playing: "${String(playing.title || 'Untitled').slice(0, 45)}".` : 'Nothing is playing right now.';
    sendTwitchChatReply(`${playingText} Queue: ${queued.length} waiting; ${myCount} of yours waiting. ${top.length ? 'Next up: ' + top.join(' | ') + (queued.length > top.length ? ` | +${queued.length - top.length} more` : '') : 'The waiting queue is empty.'}`);
  };
  handleQueueSummaryRef.current = handleQueueSummary;

  const handleMoveOrder = (videoId, direction) => {
    if (!isStaff || activeTab !== 'queue') return;
    const visibleQueue = filteredVideos.filter((video) => video.status === 'queue');
    const visibleIndex = visibleQueue.findIndex((video) => String(video.id) === String(videoId));
    if (visibleIndex < 0) return;
    const targetVisibleIndex = direction === 'up' ? visibleIndex - 1 : visibleIndex + 1;
    if (targetVisibleIndex < 0 || targetVisibleIndex >= visibleQueue.length) return;

    // Recreate the current visual sort over the full queue, then swap the two adjacent visible rows.
    // This also works if search/category filters hide entries between those visible rows.
    const fullQueue = videos.filter((video) => video.status === 'queue').sort(compareQueueOrder);
    const movingId = String(visibleQueue[visibleIndex].id);
    const targetId = String(visibleQueue[targetVisibleIndex].id);
    const movingIndex = fullQueue.findIndex((video) => String(video.id) === movingId);
    const targetIndex = fullQueue.findIndex((video) => String(video.id) === targetId);
    if (movingIndex < 0 || targetIndex < 0 || movingIndex === targetIndex) return;

    [fullQueue[movingIndex], fullQueue[targetIndex]] = [fullQueue[targetIndex], fullQueue[movingIndex]];
    const updates = fullQueue.map((video, position) => ({ ...video, queueOrder: (position + 1) * 1000 }));
    const orderById = new Map(updates.map((video) => [String(video.id), video.queueOrder]));
    const nextVideos = videos.map((video) => {
      const nextOrder = orderById.get(String(video.id));
      return nextOrder === undefined ? video : { ...video, queueOrder: nextOrder };
    });
    queueOrderSequenceRef.current = Math.max(queueOrderSequenceRef.current, Date.now());
    setSortBy('priority');
    setVideos(nextVideos);

    if (db && firebaseUser) {
      void (async () => {
        const batch = writeBatch(db);
        updates.forEach((video) => {
          const itemRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', String(video.id));
          batch.set(itemRef, { id: String(video.id), queueOrder: video.queueOrder, channelRoom: normalizeRoomName(channelRoom) }, { merge: true });
        });
        try {
          await batch.commit();
        } catch (error) {
          console.warn('Atomic queue reorder failed; attempting a merge-write fallback.', error);
          try {
            await Promise.all(updates.map((video) => setDoc(
              doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', String(video.id)),
              { id: String(video.id), queueOrder: video.queueOrder, channelRoom: normalizeRoomName(channelRoom) },
              { merge: true }
            )));
          } catch (fallbackError) {
            console.warn('Queue order could not sync to Firebase; the order remains stored locally.', fallbackError);
            setCloudSynced(false);
            setSyncStatusText('Queue order saved locally — cloud update failed');
          }
        }
      })();
    }
  };

  // Room switching is disabled: this site is dedicated to Twitch channel 2o3a.
  const handleSwitchRoom = (e) => { e?.preventDefault?.(); setChannelRoom(PRIVATE_CHANNEL); setRoomInput(PRIVATE_CHANNEL); };

  // ==========================================
  // PRIVATE SIGN-IN GATE
  // ==========================================
  const loginError = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('twitch_error') : '';
  if (twitchAuthLoading) {
    return (
      <div className="gachi-theme min-h-screen bg-[#090a0f] text-slate-100 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-3xl border border-purple-500/30 bg-[#111522]/95 p-8 text-center shadow-2xl">
          <div className="text-4xl mb-4">🧼</div><h1 className="text-2xl font-black tracking-tight text-white">whale cum</h1>
          <p className="mt-3 text-sm text-slate-300">Verifying your private Twitch session…</p>
          <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-slate-800"><div className="h-full w-1/2 animate-pulse rounded-full bg-gradient-to-r from-purple-500 to-cyan-400" /></div>
        </div>
      </div>
    );
  }
  if (!twitchAuth.authenticated || !ALLOWED_TWITCH_USERS.has(String(twitchAuth.username || '').toLowerCase())) {
    return (
      <div className="gachi-theme min-h-screen bg-[#090a0f] text-slate-100 flex items-center justify-center p-6">
        <div className="w-full max-w-lg rounded-3xl border border-purple-500/30 bg-[#111522]/95 p-8 sm:p-10 text-center shadow-2xl">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-purple-400/30 bg-purple-500/10 text-4xl">🧼</div>
          <div className="text-[10px] font-black uppercase tracking-[0.35em] text-amber-200">Private streamer deck</div>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-white">whale cum</h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">A private request player for <strong className="text-purple-200">twitch.tv/2o3a</strong>. Sign in using one of the two approved Twitch accounts.</p>
          {loginError === 'unauthorized' ? <div className="mt-5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">This Twitch account is not on the access list. No site access was granted.</div> : null}
          {loginError && loginError !== 'unauthorized' ? <div className="mt-5 rounded-xl border border-amber-300/20 bg-amber-300/5 px-4 py-3 text-xs text-amber-100">Twitch login returned an error. Please try again.</div> : null}
          <a href="/api/twitch/login" className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-purple-600 px-5 py-3.5 text-sm font-black text-white transition hover:bg-purple-500"><LogIn className="h-4 w-4" /> Sign in with Twitch</a>
          <div className="mt-6 rounded-2xl border border-slate-800 bg-[#0b0e15] p-4 text-left">
            <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">Approved accounts</div>
            <div className="mt-3 flex items-center justify-between text-sm"><span className="font-bold text-white">2o3a</span><span className="rounded-lg border border-purple-400/20 bg-purple-500/10 px-2 py-1 text-[10px] font-bold text-purple-200">STREAMER</span></div>
            <div className="mt-3 flex items-center justify-between text-sm"><span className="font-bold text-white">paim_beach_pete</span><span className="rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-2 py-1 text-[10px] font-bold text-cyan-200">MODERATOR</span></div>
          </div>
          <p className="mt-5 text-[10px] leading-5 text-slate-500">Other accounts are denied server-side. Twitch OAuth and the Firebase server credential must be configured before deployment.</p>
        </div>
      </div>
    );
  }


  // ==========================================
  // RENDER OBS OVERLAY HUD (POP-OUT MODE)
  // ==========================================
  if (showObsOverlay) {
    return (
      <div className="gachi-theme gachi-overlay fixed inset-0 bg-[#090a0f] text-white p-6 flex flex-col justify-between font-sans select-none overflow-hidden border-4 border-purple-500/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 bg-[#18181b]/90 backdrop-blur-md px-3.5 py-1.5 rounded-xl border border-white/10 shadow-lg">
            <Radio className="w-4 h-4 text-purple-400 animate-pulse" />
            <span className="text-xs font-bold uppercase tracking-wider text-purple-300">
              ♂ GACHI ARENA • OBS DECK • {channelRoom ? `twitch.tv/${channelRoom}` : 'CHANNEL NOT SET'} ♂
            </span>
          </div>
          <button
            onClick={() => setShowObsOverlay(false)}
            className="px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-xs font-bold text-white transition-all"
          >
            Exit Overlay View
          </button>
        </div>

        {/* Big Now Playing Banner for OBS */}
        {currentVideo ? (
          <div className="max-w-2xl bg-[#121622]/95 border border-purple-500/40 rounded-2xl p-5 shadow-2xl backdrop-blur-md flex items-center gap-5">
            <img
              src={currentVideo.thumbnail}
              alt=""
              className="w-24 h-24 rounded-xl object-cover border border-white/10 shrink-0"
            />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-purple-600 text-white">
                  Now Playing
                </span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${CATEGORY_META[currentVideo.category]?.badgeBg || 'bg-slate-800 text-slate-300'}`}>
                  {currentVideo.category}
                </span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase border ${(currentVideo.mediaType || detectMusicType(currentVideo.url, currentVideo.title, currentVideo.note)) === 'Music' ? 'bg-rose-500/15 text-rose-300 border-rose-500/40' : 'bg-amber-500/15 text-amber-200 border-amber-500/40'}`}>
                  {currentVideo.mediaType || detectMusicType(currentVideo.url, currentVideo.title, currentVideo.note)}
                </span>
              </div>
              <h2 className="text-lg font-black text-white truncate">{currentVideo.title}</h2>
              <p className="text-xs text-purple-200">
                Requested by <strong className="text-white">@{currentVideo.requestedBy}</strong> • 🔥 {currentVideo.upvotes || 0} Hypes
              </p>
              {/* Progress bar */}
              <div className="w-full bg-white/10 h-1.5 rounded-full overflow-hidden mt-2">
                <div
                  className="bg-gradient-to-r from-purple-500 to-cyan-400 h-full transition-all duration-300"
                  style={{ width: `${simProgress}%` }}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="text-slate-400 text-sm">No active video in stream deck.</div>
        )}

        {/* Next Up Ticker */}
        <div className="bg-[#121622]/80 backdrop-blur-md px-4 py-2.5 rounded-xl border border-white/5 flex items-center gap-3 max-w-xl">
          <span className="text-[11px] font-bold uppercase tracking-wider text-purple-400">Next Up:</span>
          {counts.queue > 0 ? (
            <span className="text-xs text-slate-200 truncate">
              {videos.filter((v) => v.status === 'queue').sort(compareQueueOrder)[0]?.title || 'Loading next item...'}
            </span>
          ) : (
            <span className="text-xs text-slate-400">Queue is empty. Paste a video URL in Twitch chat or use !assr &lt;url&gt;!</span>
          )}
        </div>
      </div>
    );
  }

  // ==========================================
  // MAIN APP INTERFACE
  // ==========================================
  return (
    <div className="gachi-theme min-h-screen bg-[#090a0f] text-slate-100 flex flex-col font-sans selection:bg-purple-600 selection:text-white">
      {/* ==========================================
          HEADER: BROADCASTER IDENTITY & SYNC STATUS
          ========================================== */}
      <header className="sticky top-0 z-40 bg-[#0e121a]/95 backdrop-blur-md border-b border-slate-800/80 px-4 lg:px-6 py-2.5">
        <div className="max-w-[1680px] mx-auto flex flex-wrap items-center justify-between gap-3">
          {/* Logo & Channel Room Selector */}
          <div className="flex items-center gap-3">
            <div className="yedi-soap-logo w-9 h-9 rounded-xl flex items-center justify-center shadow-lg" title="Swedish bathhouse soap">
              <span className="yedi-soap-mark" role="img" aria-label="Bath soap">🧼</span>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="yedi-hub-wordmark font-extrabold text-base tracking-tight bg-clip-text text-transparent">
                  whale cum
                </span>
                <span className="gachi-mode-badge px-2 py-0.5 rounded-md text-[10px] font-black bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  ♂ GACHI MODE ♂
                </span>
                <span className="gachi-deadpan-badge px-2 py-0.5 rounded-md text-[9px] font-black tracking-wide">
                  🇸🇪 fitta javla fih
                </span>
              </div>

              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[11px] text-slate-400 font-medium">twitch.tv/</span>
                <span className="text-[11px] font-black text-purple-300">2o3a</span>
                <span className="px-1.5 py-0.5 rounded bg-amber-400/10 border border-amber-300/20 text-[8px] font-black tracking-wider text-amber-200">PRIVATE</span>
              </div>
            </div>
          </div>

          {/* Sync & Mode Badges */}
          <div className="hidden xl:flex items-center gap-2.5 bg-[#141926] border border-slate-800 rounded-xl px-3.5 py-1.5 text-xs">
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${cloudSynced ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
              <span className="text-slate-300 font-medium">{syncStatusText}</span>
            </span>

            <span className="text-slate-600">|</span>

            <span className="text-slate-400">
              Queue: {streamSettings.queueOpen ? <span className="text-emerald-400 font-semibold">Open</span> : <span className="text-rose-400 font-semibold">Closed</span>}
            </span>
          </div>

          {/* Right Action Tools */}
          <div className="flex items-center gap-2">
            {/* Pop-Out OBS Overlay View */}
            <button
              onClick={() => setShowObsOverlay(true)}
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#141926] hover:bg-slate-800 text-slate-300 border border-slate-800 text-xs font-semibold transition-colors"
              title="OBS Overlay Browser Capture Deck"
            >
              <Maximize2 className="w-3.5 h-3.5 text-cyan-400" />
              <span>OBS Deck</span>
            </button>

            {/* Queue settings: keep the close/open switch one click away for staff. */}
            {isStaff && (
              <button
                onClick={() => setShowSettingsModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#141926] hover:bg-slate-800 text-slate-200 border border-slate-800 text-xs font-semibold transition-colors"
                title="Queue settings — close or reopen requests and configure playback"
              >
                <Settings className="w-3.5 h-3.5 text-cyan-400" />
                <span>Settings</span>
              </button>
            )}

            {/* User Profile / Login Modal Trigger */}
            <button
              onClick={() => setShowAuthModal(true)}
              className="flex items-center gap-2 pl-2 pr-3 py-1 rounded-xl bg-[#141926] hover:bg-slate-800 border border-slate-800 transition-colors"
            >
              <div className="w-6 h-6 rounded-lg bg-gradient-to-tr from-purple-500 to-indigo-600 flex items-center justify-center text-xs font-bold text-white">
                {twitchAuth.avatarLetter}
              </div>
              <div className="text-left hidden sm:block">
                <div className="text-xs font-bold text-slate-200 leading-none">{twitchAuthLoading ? 'Checking Twitch…' : twitchAuth.displayName}</div>
                <div className="text-[10px] text-purple-400 capitalize">{twitchAuth.role}{twitchAuth.authenticated ? ' · verified' : ''}</div>
              </div>
            </button>

            {/* Twitch IRC bridge controls only — no chat transcript is shown on the site. */}
            <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-xl border text-[10px] font-black uppercase tracking-wide ${ircConnected ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-amber-500/10 border-amber-500/30 text-amber-200'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${ircConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
              {ircConnected ? 'Bridge Live' : 'Bridge Reconnecting'}
            </div>
            <button
              onClick={() => connectTwitchIrc(channelRoom)}
              className="px-2.5 py-1.5 rounded-xl bg-[#141926] hover:bg-slate-800 text-slate-200 border border-slate-800 text-[10px] font-bold"
              title="Restart Twitch command bridge"
            >
              Restart Bridge
            </button>
            <div className={`flex items-center gap-1.5 px-2 py-1.5 rounded-xl border text-[10px] font-black uppercase tracking-wide ${chatBotSession.connected ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-rose-500/10 border-rose-500/30 text-rose-200'}`} title="Chat replies such as !position are sent by the separate Twitch account gachibot69">
              <span className={`h-1.5 w-1.5 rounded-full ${chatBotSession.connected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
              {chatBotSession.loading ? 'Bot checking' : chatBotSession.connected ? 'Bot Online' : 'Bot Offline'}
            </div>
            <button
              onClick={async () => {
                if (!chatBotSession.connected) {
                  window.location.href = '/api/twitch/bot-login';
                  return;
                }
                try {
                  await fetch('/api/twitch/bot-logout', { method: 'POST', credentials: 'same-origin' });
                  setChatBotSession({ loading: false, connected: false, username: '' });
                  addToast('Disconnected Twitch chat bot @gachibot69.', 'info');
                } catch (error) {
                  addToast('Could not disconnect the chat bot. Please try again.', 'warning');
                }
              }}
              className={`px-2.5 py-1.5 rounded-xl border text-[10px] font-bold ${chatBotSession.connected ? 'bg-[#141926] hover:bg-slate-800 text-slate-200 border-slate-800' : 'bg-cyan-700 hover:bg-cyan-600 text-white border-cyan-500/40'}`}
              title={chatBotSession.connected ? 'Disconnect the separate chat reply account' : 'Log in with Twitch account gachibot69 to send chat replies'}
            >
              {chatBotSession.loading ? 'Checking Bot…' : chatBotSession.connected ? 'Disconnect Bot' : 'Connect @gachibot69'}
            </button>
            <button
              onClick={() => {
                if (!normalizeRoomName(channelRoom)) {
                  addToast('Set a Twitch channel before copying a room link.', 'warning');
                  return;
                }
                const shareUrl = new URL(window.location.href);
                shareUrl.searchParams.set('channel', normalizeRoomName(channelRoom));
                navigator.clipboard.writeText(shareUrl.toString())
                  .then(() => addToast('Channel link copied. It opens this room and restores its cloud settings.', 'success'))
                  .catch(() => addToast(`Share this room URL: ${shareUrl.toString()}`, 'info'));
              }}
              className="hidden lg:flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-[#141926] hover:bg-slate-800 text-slate-200 border border-slate-800 text-[10px] font-bold"
              title="Copy link for this broadcaster room"
            >
              <Copy className="w-3 h-3" />
              Room Link
            </button>
          </div>
        </div>
      </header>

      {/* ==========================================
          MAIN WORKSPACE: PLAYER + QUEUE
          ========================================== */}
      <div className="flex-1 max-w-[1680px] w-full mx-auto flex flex-col lg:flex-row gap-5 p-4 lg:p-6">
        {/* LEFT COLUMN: ACTIVE MEDIA PLAYER & QUEUE LISTS */}
        <div className="flex-1 flex flex-col gap-5 min-w-0">
          {/* ==========================================
              ACTIVE MEDIA DECK / BROADCASTER PLAYER
              ========================================== */}
          <section className="bg-[#10141f] border border-slate-800/90 rounded-2xl overflow-hidden shadow-2xl">
            {/* Header info strip */}
            <div className="px-4 py-2.5 bg-[#141926] border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-purple-500/20 border border-purple-500/30 text-purple-300 font-bold uppercase tracking-wider text-[11px]">
                  <Play className="w-3.5 h-3.5 fill-current" />
                  MAIN EVENT
                </span>

                {currentVideo && (
                  <>
                    <span className={`px-2 py-0.5 rounded-lg font-bold border ${CATEGORY_META[currentVideo.category]?.badgeBg || 'bg-slate-800 text-slate-300'}`}>
                      {currentVideo.category}
                    </span>
                    <span className={`px-2 py-0.5 rounded-lg border text-[10px] font-black uppercase ${currentVideo.mediaType === 'Music' || detectMusicType(currentVideo.url, currentVideo.title, currentVideo.note) === 'Music' ? 'bg-rose-500/15 text-rose-300 border-rose-500/40' : 'bg-amber-500/15 text-amber-200 border-amber-500/40'}`}>
                      {currentVideo.mediaType || detectMusicType(currentVideo.url, currentVideo.title, currentVideo.note)}
                    </span>
                    <span className={`px-2 py-0.5 rounded-lg bg-slate-800/80 text-slate-300 border border-slate-700 capitalize`}>
                      {currentVideo.platform}
                    </span>
                  </>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsTheatreMode(!isTheatreMode)}
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                  title="Toggle Player Height"
                >
                  {isTheatreMode ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* Video viewport: official player embeds where each platform supports them. */}
            {currentVideo ? (
              <div>
                <div
                  className={`relative w-full bg-black flex items-center justify-center overflow-hidden transition-all ${
                    isTheatreMode
                      ? 'h-[72vh] min-h-[560px] max-h-[920px]'
                      : 'h-[58vh] min-h-[430px] max-h-[720px]'
                  }`}
                >
                  {isVerticalMedia(currentVideo) && (
                    <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none" aria-hidden="true">
                      <div className="absolute inset-0 bg-gradient-to-br from-[#111827] via-[#312e81] to-[#164e63]" />
                      {currentVideo.thumbnail && !String(currentVideo.thumbnail).toLowerCase().includes('placehold.co') && (
                        <img src={currentVideo.thumbnail} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-55 blur-3xl" />
                      )}
                      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
                      <div className="absolute inset-0 bg-gradient-to-r from-black/25 via-transparent to-black/25" />
                    </div>
                  )}
                  {currentVideo.platform === 'youtube' && currentVideo.videoId ? (
                    <div className={isVerticalMedia(currentVideo)
                      ? "relative z-10 h-full aspect-[9/16] max-w-full overflow-hidden rounded-xl shadow-2xl"
                      : "absolute inset-0 h-full w-full"}>
                    <iframe
                      key={`youtube-${currentVideo.id}-${currentVideo.videoId}`}
                      ref={youtubeIframeRef}
                      className="absolute inset-0 h-full w-full border-0"
                      src={`https://www.youtube.com/embed/${encodeURIComponent(currentVideo.videoId)}?autoplay=1&controls=1&playsinline=1&rel=0&modestbranding=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
                      title={currentVideo.title || 'YouTube video'}
                      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                      allowFullScreen
                      referrerPolicy="strict-origin-when-cross-origin"
                      onLoad={() => {
                        if (currentVideoRef.current?.id !== currentVideo.id) return;
                        const frame = youtubeIframeRef.current?.contentWindow;
                        if (!frame) return;
                        frame.postMessage(JSON.stringify({ event: 'listening', id: `yedi-hub-${currentVideo.id}`, channel: 'widget' }), 'https://www.youtube.com');
                        const send = (func, args = []) => frame.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube.com');
                        send('addEventListener', ['onStateChange']);
                        send('addEventListener', ['onError']);
                        send('getCurrentTime');
                        send('getDuration');
                        send('getVolume');
                        send('playVideo');
                      }}
                    />
                    </div>
                  ) : currentVideo.platform === 'tiktok' && /^\d{10,25}$/.test(String(currentVideo.videoId || '')) ? (
                    <>
                      <iframe
                        key={`tiktok-player-${currentVideo.id}-${currentVideo.videoId}-${tiktokFrameReload}`}
                        ref={tiktokIframeRef}
                        className="gachi-tiktok-player border-0"
                        style={{ width: 'auto', height: '100%', maxWidth: '100%', aspectRatio: '9 / 16' }}
                        src={`https://www.tiktok.com/player/v1/${currentVideo.videoId}?autoplay=1&muted=0&controls=1&progress_bar=1&play_button=1&volume_control=1&fullscreen_button=1&timestamp=1&description=0&music_info=0&closed_caption=0&native_context_menu=0&rel=0`}
                        title={currentVideo.title}
                        allow="autoplay; encrypted-media; picture-in-picture; web-share"
                        loading="eager"
                        referrerPolicy="strict-origin-when-cross-origin"
                        onLoad={() => {
                          if (currentVideoRef.current?.id !== currentVideo.id) return;
                          setTikTokPlayerState({ requestId: currentVideo.id, status: 'ready' });
                        }}
                        onError={() => {
                          if (currentVideoRef.current?.id !== currentVideo.id) return;
                          setTikTokPlayerState({ requestId: currentVideo.id, status: 'error' });
                        }}
                      />
                      {tiktokPlayerState.requestId === currentVideo.id && tiktokPlayerState.status === 'error' && (
                        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/90 p-6 text-center">
                          <div className="text-base font-black text-white">TikTok player could not start</div>
                          <p className="max-w-sm text-sm text-slate-300">Retry the player or open the post directly on TikTok.</p>
                          <div className="flex flex-wrap items-center justify-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setTikTokPlayerState({ requestId: currentVideo.id, status: 'loading' });
                                setTikTokFrameReload((attempt) => attempt + 1);
                              }}
                              className="rounded-xl bg-purple-600 px-4 py-2 text-xs font-bold text-white hover:bg-purple-500"
                            >Retry TikTok player</button>
                            <a
                              href={/^https?:\/\//i.test(String(currentVideo.url || '')) && !/\/player\/v1\//i.test(String(currentVideo.url || '')) ? currentVideo.url : `https://www.tiktok.com/video/${currentVideo.videoId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="rounded-xl border border-slate-600 bg-slate-800 px-4 py-2 text-xs font-bold text-white hover:bg-slate-700"
                            >Open on TikTok</a>
                          </div>
                        </div>
                      )}
                    </>
                  ) : currentVideo.platform === 'tiktok' ? (
                    <div className="max-w-lg p-8 text-center space-y-3">
                      <div className="text-cyan-300 font-bold">TikTok link needs a full video URL</div>
                      <p className="text-sm text-slate-300">This looks like a shortened TikTok link. Open it, then copy the full address containing <code>/video/</code> and submit that link so whale cum can extract the post ID.</p>
                      <a href={currentVideo.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-xl bg-cyan-600 px-4 py-2 text-sm font-bold text-white hover:bg-cyan-500">
                        Open TikTok <ExternalLink className="h-4 w-4" />
                      </a>
                    </div>
                  ) : currentVideo.platform === 'twitch' && currentVideo.videoId ? (
                    <iframe
                      key={`twitch-${currentVideo.videoId}`}
                      className="w-full h-full border-0"
                      src={`https://clips.twitch.tv/embed?clip=${encodeURIComponent(currentVideo.videoId)}&parent=${encodeURIComponent(window.location.hostname)}&autoplay=true&muted=false`}
                      title={currentVideo.title}
                      allow="autoplay; fullscreen; picture-in-picture"
                      allowFullScreen
                    />
                  ) : (
                    <div className="relative w-full h-full flex flex-col justify-between p-6 bg-gradient-to-br from-slate-950 via-[#10141f] to-purple-950/40 overflow-hidden">
                      <img
                        src={currentVideo.thumbnail}
                        alt=""
                        className="absolute inset-0 w-full h-full object-cover opacity-20 blur-sm scale-105 pointer-events-none"
                      />
                      <div className="relative z-10 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-xl border border-white/10">
                          <Radio className="w-4 h-4 text-purple-400 animate-pulse" />
                          <span className="text-xs font-bold text-white">External media link</span>
                        </div>
                        <a href={currentVideo.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 bg-white/10 hover:bg-white/20 backdrop-blur-md px-3 py-1.5 rounded-xl text-xs font-semibold text-white transition-colors">
                          <span>Open source</span><ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                      <div className="relative z-10 my-auto text-center max-w-lg mx-auto space-y-2">
                        <h3 className="text-base sm:text-lg font-bold text-white line-clamp-2">{currentVideo.title}</h3>
                        <p className="text-xs text-slate-300">This media type cannot be played inline. Use the source link to watch it.</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Sub-Player Controls & Fast Stash Deck */}
                <div className="p-4 sm:p-5 bg-[#141926] flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="min-w-0 space-y-1 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="text-base sm:text-lg font-extrabold text-white truncate">
                        {currentVideo.title}
                      </h2>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                      <span>
                        Requester: <strong className="text-purple-300 font-semibold">@{currentVideo.requestedBy}</strong>
                      </span>
                      <span>•</span>
                      <span>Added {currentVideo.addedAt}</span>
                      {currentVideo.note && (
                        <>
                          <span>•</span>
                          <span className="italic text-slate-300">"{currentVideo.note}"</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Player Quick Action Bar */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {currentVideo.platform === 'youtube' && (
                      <div className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-[#0e121a] px-2.5 py-2">
                        <button
                          type="button"
                          onClick={() => {
                            const player = youtubePlayerRef.current;
                            if (!player) {
                              addToast('YouTube player is not ready for volume control yet.', 'warning');
                              return;
                            }
                            if (youtubeMuted) {
                              const nextVolume = youtubeVolume > 0 ? youtubeVolume : 50;
                              player.setVolume(nextVolume);
                              player.unMute();
                              youtubePlaybackInfoRef.current = { ...youtubePlaybackInfoRef.current, volume: nextVolume, muted: false };
                              setYoutubeVolume(nextVolume);
                              setYoutubeMuted(false);
                            } else {
                              player.mute();
                              youtubePlaybackInfoRef.current = { ...youtubePlaybackInfoRef.current, muted: true };
                              setYoutubeMuted(true);
                            }
                          }}
                          className="inline-flex items-center justify-center rounded-lg p-1 text-cyan-300 hover:bg-slate-800"
                          title={youtubeMuted ? 'Unmute YouTube video' : 'Mute YouTube video'}
                          aria-label={youtubeMuted ? 'Unmute YouTube video' : 'Mute YouTube video'}
                        >
                          {youtubeMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                        </button>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="1"
                          value={youtubeVolume}
                          onChange={(e) => {
                            const player = youtubePlayerRef.current;
                            if (!player) {
                              addToast('YouTube player is not ready for volume control yet.', 'warning');
                              return;
                            }
                            const nextVolume = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                            player.setVolume(nextVolume);
                            if (nextVolume === 0) player.mute();
                            else player.unMute();
                            youtubePlaybackInfoRef.current = { ...youtubePlaybackInfoRef.current, volume: nextVolume, muted: nextVolume === 0 };
                            setYoutubeVolume(nextVolume);
                            setYoutubeMuted(nextVolume === 0);
                          }}
                          className="w-24 cursor-pointer accent-cyan-400"
                          title="Set YouTube volume"
                          aria-label="YouTube volume"
                        />
                        <span className="min-w-10 text-right text-[10px] font-bold tabular-nums text-slate-300">{youtubeMuted ? 'Muted' : `${youtubeVolume}%`}</span>
                      </div>
                    )}
                    {currentVideo.platform === 'tiktok' && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            const frame = tiktokIframeRef.current?.contentWindow;
                            if (!frame) {
                              addToast('TikTok player is not ready yet. Try again in a moment.', 'warning');
                              return;
                            }
                            const isPlaying = tiktokPlaybackState.requestId === currentVideo.id ? tiktokPlaybackState.isPlaying : true;
                            const isMuted = tiktokPlaybackState.requestId === currentVideo.id ? tiktokPlaybackState.isMuted : false;
                            const nextIsPlaying = !isPlaying;
                            frame.postMessage({ type: nextIsPlaying ? 'play' : 'pause', value: null, 'x-tiktok-player': true }, 'https://www.tiktok.com');
                            setTikTokPlaybackState({ requestId: currentVideo.id, isPlaying: nextIsPlaying, isMuted });
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#181e2e] hover:bg-slate-800 text-cyan-300 border border-slate-700 text-xs font-bold"
                          title={tiktokPlaybackState.requestId === currentVideo.id && !tiktokPlaybackState.isPlaying ? 'Resume TikTok video' : 'Pause TikTok video'}
                        >
                          {tiktokPlaybackState.requestId === currentVideo.id && !tiktokPlaybackState.isPlaying ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                          {tiktokPlaybackState.requestId === currentVideo.id && !tiktokPlaybackState.isPlaying ? 'Play' : 'Pause'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const frame = tiktokIframeRef.current?.contentWindow;
                            if (!frame) {
                              addToast('TikTok player is not ready yet. Try again in a moment.', 'warning');
                              return;
                            }
                            const isMuted = tiktokPlaybackState.requestId === currentVideo.id ? tiktokPlaybackState.isMuted : false;
                            const nextIsMuted = !isMuted;
                            tiktokMutePreferenceRef.current = { requestId: currentVideo.id, preference: nextIsMuted ? 'muted' : 'unmuted' };
                            frame.postMessage({ type: nextIsMuted ? 'mute' : 'unMute', value: null, 'x-tiktok-player': true }, 'https://www.tiktok.com');
                            setTikTokPlaybackState({
                              requestId: currentVideo.id,
                              isPlaying: tiktokPlaybackState.requestId === currentVideo.id ? tiktokPlaybackState.isPlaying : true,
                              isMuted: nextIsMuted
                            });
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#181e2e] hover:bg-slate-800 text-cyan-300 border border-slate-700 text-xs font-bold"
                          title={tiktokPlaybackState.requestId === currentVideo.id && tiktokPlaybackState.isMuted ? 'Unmute TikTok video' : 'Mute TikTok video'}
                        >
                          {tiktokPlaybackState.requestId === currentVideo.id && tiktokPlaybackState.isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                          {tiktokPlaybackState.requestId === currentVideo.id && tiktokPlaybackState.isMuted ? 'Unmute' : 'Mute'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const frame = tiktokIframeRef.current?.contentWindow;
                            if (!frame) {
                              addToast('TikTok player is not ready yet. Try again in a moment.', 'warning');
                              return;
                            }
                            tiktokMutePreferenceRef.current = { requestId: currentVideo.id, preference: 'unmuted' };
                            frame.postMessage({ type: 'unMute', value: null, 'x-tiktok-player': true }, 'https://www.tiktok.com');
                            frame.postMessage({ type: 'play', value: null, 'x-tiktok-player': true }, 'https://www.tiktok.com');
                            setTikTokPlaybackState({ requestId: currentVideo.id, isPlaying: true, isMuted: false });
                          }}
                          className="px-3 py-2 rounded-xl bg-[#181e2e] hover:bg-slate-800 text-cyan-300 border border-slate-700 text-xs font-bold"
                        >Enable TikTok sound</button>
                        <a
                          href={/^https?:\/\//i.test(String(currentVideo.url || '')) && !/\/player\/v1\//i.test(String(currentVideo.url || '')) ? currentVideo.url : `https://www.tiktok.com/video/${currentVideo.videoId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-2 rounded-xl bg-[#181e2e] hover:bg-slate-800 text-slate-300 border border-slate-700 text-xs font-bold"
                        >Open TikTok</a>
                      </>
                    )}
                    {currentVideo.platform === 'tiktok' && (
                      <span className="max-w-56 text-[10px] leading-4 text-slate-500" title="TikTok's embedded player does not allow external exact-volume control.">
                        Exact volume: use the speaker control inside the video. App/chat controls can mute or unmute only.
                      </span>
                    )}
                    {/* Instant Category Tag Override */}
                    {isStaff && (
                      <div className="flex items-center gap-1.5 bg-[#0e121a] px-2.5 py-1.5 rounded-xl border border-slate-700">
                        <span className="text-[10px] uppercase font-bold text-slate-400">Category:</span>
                        <select
                          value={currentVideo.category}
                          onChange={(e) => handleCategoryChange(currentVideo.id, e.target.value)}
                          className="bg-transparent text-xs font-bold text-purple-300 focus:outline-none cursor-pointer"
                        >
                          {Object.keys(CATEGORY_META).map((cat) => (
                            <option key={cat} value={cat} className="bg-[#141926] text-white">
                              {cat}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Voting changes the order of waiting requests; an already-playing video cannot be voted up. */}
                    <button
                      onClick={() => handleUpvote(currentVideo.id)}
                      disabled={currentVideo.status !== 'queue' || normalizeTwitchLogin(currentVideo.requestedBy) === normalizeTwitchLogin(twitchAuth.username) || Boolean(votedIds[`${normalizeTwitchLogin(twitchAuth.username)}:${currentVideo.id}`])}
                      title={currentVideo.status === 'playing' ? 'This video is already playing' : normalizeTwitchLogin(currentVideo.requestedBy) === normalizeTwitchLogin(twitchAuth.username) ? 'You cannot upvote your own request' : 'Upvote to increase this queued video’s priority'}
                      className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                        votedIds[`${normalizeTwitchLogin(twitchAuth.username)}:${currentVideo.id}`]
                          ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                          : 'bg-[#181e2e] hover:bg-slate-800 border-slate-700 text-slate-200'
                      }`}
                    >
                      <Flame className="w-4 h-4 text-amber-400" />
                      <span>{currentVideo.status === 'playing' ? 'Playing' : `Upvote (${currentVideo.upvotes || 0})`}</span>
                    </button>

                    {/* Watch Later Quick Stash */}
                    <button
                      onClick={() => handleMoveToWatchLater(currentVideo)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#181e2e] hover:bg-slate-800 text-cyan-300 border border-slate-700 text-xs font-semibold transition-colors"
                      title="Stash to Watch Later list without interrupting stream"
                    >
                      <Bookmark className="w-3.5 h-3.5" />
                      <span>Watch Later</span>
                    </button>

                    {/* Previous / Skip / Next Track */}
                    {isStaff && (
                      <>
                      <button
                        onClick={handlePreviousTrack}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#181e2e] hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold transition-all active:scale-95"
                        title="Return to the most recently played video"
                      >
                        <RotateCcw className="w-4 h-4" />
                        <span>Previous</span>
                      </button>
                      <button
                        onClick={handleSkipNext}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-bold shadow-lg shadow-emerald-600/20 transition-all active:scale-95"
                      >
                        <SkipForward className="w-4 h-4" />
                        <span>Next Track</span>
                      </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-12 text-center space-y-3">
                <ListVideo className="w-12 h-12 text-slate-600 mx-auto" />
                <h3 className="text-base font-bold text-slate-300">Queue is currently empty</h3>
                <p className="text-xs text-slate-500 max-w-md mx-auto">
                  Paste a video URL in Twitch chat, use <code className="text-purple-400 font-mono">!assr &lt;url&gt;</code>, or click Request Video above to add media!
                </p>
              </div>
            )}
          </section>

          {/* ==========================================
              QUEUE MANAGEMENT: TABS, FILTERS & CARDS
              ========================================== */}
          <section className="bg-[#10141f] border border-slate-800/90 rounded-2xl p-4 sm:p-5 space-y-4 shadow-xl">
            {/* Nav Tabs */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { id: 'queue', label: 'Active Queue', icon: ListVideo, count: counts.queue, badge: 'bg-purple-500/20 text-purple-300' },
                  { id: 'watch_later', label: 'Watch Later', icon: Bookmark, count: counts.watch_later, badge: 'bg-cyan-500/20 text-cyan-300' },
                  { id: 'watched', label: 'History', icon: CheckCircle2, count: counts.watched, badge: 'bg-emerald-500/20 text-emerald-300' }
                ].map((tab) => {
                  const Icon = tab.icon;
                  const active = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all ${
                        active
                          ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/30'
                          : 'bg-[#151a27] hover:bg-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      <span>{tab.label}</span>
                      <span className={`px-1.5 py-0.2 rounded-md text-[11px] font-extrabold ${active ? 'bg-black/30 text-white' : tab.badge}`}>
                        {tab.count}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Sorter */}
              <select
                value={activeTab === 'queue' ? 'priority' : sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                disabled={activeTab === 'queue'}
                title={activeTab === 'queue' ? 'Queue order follows pinned priority, then votes, then request time' : 'Sort this non-queue list'}
                className="bg-[#151a27] border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-purple-500 disabled:opacity-70"
              >
                <option value="priority">Sort: Playback priority</option>
                <option value="upvotes">Sort: Most Hype (Votes)</option>
                <option value="newest">Sort: Recently Added</option>
              </select>
            </div>

            {/* Category Filter Pills & Search */}
            <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
              {/* Category Pills */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0">
                <button
                  onClick={() => setSelectedCategory('All')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                    selectedCategory === 'All'
                      ? 'bg-white/10 border border-purple-500 text-white'
                      : 'bg-[#141926] text-slate-400 hover:text-white border border-slate-800'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                  <span>All Categories</span>
                </button>

                {Object.entries(CATEGORY_META).map(([catKey, catData]) => {
                  const Icon = catData.icon;
                  const active = selectedCategory === catKey;
                  return (
                    <button
                      key={catKey}
                      onClick={() => setSelectedCategory(catKey)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all border ${
                        active
                          ? 'bg-white/10 border-purple-500 text-white'
                          : 'bg-[#141926] border-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" style={{ color: catData.colorHex }} />
                      <span>{catData.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Search */}
              <div className="relative min-w-[220px]">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search title or @requester..."
                  className="w-full bg-[#141926] border border-slate-800 rounded-xl pl-9 pr-7 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-purple-500"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            {/* Video Cards Feed */}
            <div className="space-y-3 pt-1">
              {filteredVideos.length === 0 ? (
                <div className="p-10 border border-dashed border-slate-800 rounded-2xl text-center space-y-2 bg-[#121622]/40">
                  <Sparkles className="w-8 h-8 text-slate-600 mx-auto" />
                  <p className="text-sm font-bold text-slate-300">No media found in this view</p>
                  <p className="text-xs text-slate-500">
                    The arena awaits its next main event. Submit a YouTube, Twitch Clip, or TikTok link.
                  </p>
                </div>
              ) : (
                filteredVideos.map((video, idx) => {
                  const isCurrent = currentVideo && currentVideo.id === video.id;
                  const catObj = CATEGORY_META[video.category] || CATEGORY_META.General;

                  return (
                    <div
                      key={video.id}
                      className={`group relative flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-3.5 rounded-2xl border transition-all ${
                        isCurrent
                          ? 'bg-purple-950/20 border-purple-500/50 shadow-lg shadow-purple-950/40'
                          : video.pinned
                          ? 'bg-amber-950/15 border-amber-500/30'
                          : 'bg-[#131722] hover:bg-[#181d2a] border-slate-800/90'
                      }`}
                    >
                      {/* Left: Thumbnail + Metadata */}
                      <div className="flex items-start sm:items-center gap-3.5 min-w-0 flex-1 w-full">
                        {/* Order indicator */}
                        <div className="hidden sm:flex flex-col items-center justify-center w-7 text-center shrink-0">
                          {video.pinned ? (
                            <Pin className="w-4 h-4 text-amber-400 fill-current" />
                          ) : (
                            <span className="text-xs font-mono font-bold text-slate-500">#{queueRankById.get(String(video.id)) ?? (idx + 1)}</span>
                          )}
                        </div>

                        {/* Thumbnail */}
                        <div
                          onClick={() => handlePlayNow(video)}
                          className="relative w-28 sm:w-36 h-20 rounded-xl overflow-hidden bg-slate-900 shrink-0 cursor-pointer border border-white/5"
                        >
                          <img
                            src={video.thumbnail}
                            alt=""
                            onError={(e) => {
                              e.target.src = 'https://placehold.co/640x360/18181b/a1a1aa?text=Yedi+Hub';
                            }}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                            <div className="w-8 h-8 rounded-full bg-purple-600 text-white flex items-center justify-center shadow-lg">
                              <Play className="w-4 h-4 fill-current ml-0.5" />
                            </div>
                          </div>
                          <span className="absolute bottom-1 right-1 px-1.5 py-0.2 rounded bg-black/80 text-[10px] font-mono font-bold text-slate-200">
                            {video.duration}
                          </span>
                        </div>

                        {/* Details */}
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {/* Editable Category Dropdown for 1-Click Fixes */}
                            {isStaff ? (
                              <select
                                value={video.category}
                                onChange={(e) => handleCategoryChange(video.id, e.target.value)}
                                className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold border cursor-pointer focus:outline-none ${catObj.badgeBg}`}
                                title="Click to fix or change category"
                              >
                                {Object.keys(CATEGORY_META).map((cat) => (
                                  <option key={cat} value={cat} className="bg-[#141926] text-white">
                                    {cat}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold border ${catObj.badgeBg}`}>
                                {video.category}
                              </span>
                            )}

                            <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase border ${ (video.mediaType || detectMusicType(video.url, video.title, video.note)) === 'Music' ? 'bg-rose-500/15 text-rose-300 border-rose-500/40' : 'bg-amber-500/15 text-amber-200 border-amber-500/40'}`}>
                              {video.mediaType || detectMusicType(video.url, video.title, video.note)}
                            </span>
                            <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-slate-800 text-slate-300 uppercase">
                              {video.platform}
                            </span>

                            {video.pinned && (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                Pinned Priority
                              </span>
                            )}
                          </div>

                          <h4
                            onClick={() => handlePlayNow(video)}
                            className="text-sm font-bold text-slate-100 hover:text-purple-300 cursor-pointer truncate"
                            title={video.title}
                          >
                            {video.title}
                          </h4>

                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-400">
                            <span>
                              by <strong className="text-slate-200 font-semibold">@{video.requestedBy}</strong>
                            </span>
                            <span>•</span>
                            <span>{video.addedAt}</span>
                            {video.watchedAt && (
                              <>
                                <span>•</span>
                                <span className="text-emerald-400 font-medium">Played {video.watchedAt}</span>
                              </>
                            )}
                            {video.note && (
                              <>
                                <span>•</span>
                                <span className="text-slate-300 italic truncate max-w-xs">"{video.note}"</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Right: Arena Control Buttons */}
                      <div className="flex flex-wrap items-center gap-1.5 self-end sm:self-center shrink-0">
                        {/* Hype Vote */}
                        <button
                          onClick={() => handleUpvote(video.id)}
                          disabled={normalizeTwitchLogin(video.requestedBy) === normalizeTwitchLogin(twitchAuth.username) || (Array.isArray(video.voters) && video.voters.some((name) => normalizeTwitchLogin(name) === normalizeTwitchLogin(twitchAuth.username))) || Boolean(votedIds[`${normalizeTwitchLogin(twitchAuth.username)}:${video.id}`])}
                          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-bold border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                            (Array.isArray(video.voters) && video.voters.some((name) => normalizeTwitchLogin(name) === normalizeTwitchLogin(twitchAuth.username))) || votedIds[`${normalizeTwitchLogin(twitchAuth.username)}:${video.id}`]
                              ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                              : 'bg-[#181e2e] hover:bg-slate-800 border-slate-700/80 text-slate-300'
                          }`}
                          title={normalizeTwitchLogin(video.requestedBy) === normalizeTwitchLogin(twitchAuth.username) ? 'You cannot upvote your own request' : 'Upvote this video to move it higher in the queue'}
                        >
                          <ThumbsUp className="w-3.5 h-3.5" />
                          <span>{video.upvotes || 0}</span>
                        </button>

                        {/* Every request is immediately playable; no approval state. */}
                        <>
                            {video.status === 'queue' && normalizeTwitchLogin(video.requestedBy) === normalizeTwitchLogin(twitchAuth.username) && (
                              <button
                                onClick={() => {
                                  if (window.confirm(`Remove your request "${String(video.title || 'this video').slice(0, 80)}" from the queue?`)) {
                                    void syncDeleteVideo(video.id);
                                  }
                                }}
                                className="p-1.5 rounded-lg bg-[#181e2e] hover:bg-rose-950/60 text-rose-300 border border-rose-500/20"
                                title="Remove your own waiting request"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              onClick={() => handlePlayNow(video)}
                              className="px-2.5 py-1.5 rounded-xl bg-purple-600/20 hover:bg-purple-600 text-purple-300 hover:text-white border border-purple-500/30 text-xs font-bold transition-colors"
                            >
                              Play Now
                            </button>

                            {isStaff && (
                              <>
                                {video.status === 'queue' && (
                                  <>
                                    <button
                                      onClick={() => handleMoveOrder(video.id, 'up')}
                                      className="p-1.5 rounded-lg bg-[#181e2e] hover:bg-slate-700 text-slate-300"
                                      title="Move Up"
                                    >
                                      <ArrowUp className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      onClick={() => handleMoveOrder(video.id, 'down')}
                                      className="p-1.5 rounded-lg bg-[#181e2e] hover:bg-slate-700 text-slate-300"
                                      title="Move Down"
                                    >
                                      <ArrowDown className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      onClick={() => handleTogglePin(video)}
                                      className={`p-1.5 rounded-lg border transition-colors ${
                                        video.pinned
                                          ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                                          : 'bg-[#181e2e] border-transparent hover:bg-slate-700 text-slate-400'
                                      }`}
                                      title="Pin Priority"
                                    >
                                      <Pin className="w-3.5 h-3.5" />
                                    </button>
                                  </>
                                )}

                                {video.status !== 'watch_later' && (
                                  <button
                                    onClick={() => handleMoveToWatchLater(video)}
                                    className="p-1.5 rounded-lg bg-[#181e2e] hover:bg-slate-700 text-cyan-400"
                                    title="Stash to Watch Later"
                                  >
                                    <Bookmark className="w-3.5 h-3.5" />
                                  </button>
                                )}

                                {video.status === 'watched' && (
                                  <button
                                    onClick={() => handleRequeue(video)}
                                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold"
                                  >
                                    <RotateCcw className="w-3 h-3" />
                                    <span>Re-Queue</span>
                                  </button>
                                )}

                                <button
                                  onClick={() => syncDeleteVideo(video.id)}
                                  className="p-1.5 rounded-lg bg-[#181e2e] hover:bg-rose-950/60 text-slate-400 hover:text-rose-400 transition-colors"
                                  title="Delete video request"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                        </>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>

        {/* Twitch IRC runs invisibly as a command bridge; incoming chat is not rendered. */}
      </div>

      {/* ==========================================
          MODAL 1: SUBMIT VIDEO REQUEST (WEB)
          ========================================== */}
      {showRequestModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#121622] border border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-purple-600/20 border border-purple-500/40 flex items-center justify-center text-purple-300">
                  <Plus className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Enter the Gachi Arena</h3>
                  <p className="text-xs text-slate-400">Broadcaster Room: {channelRoom ? `twitch.tv/${channelRoom}` : 'Enter your Twitch channel in the header first'}</p>
                </div>
              </div>
              <button
                onClick={() => setShowRequestModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!reqUrl.trim()) return;
                const ok = await processAndQueueRequest({
                  url: reqUrl,
                  title: reqTitle,
                  note: reqNote,
                  requestedBy: reqUsername || twitchAuth.username,
                  userRole: twitchAuth.authenticated ? twitchAuth.role : 'viewer',
                  manualCategory: reqCategory
                });
                if (ok) {
                  setReqUrl('');
                  setReqTitle('');
                  setReqNote('');
                  setShowRequestModal(false);
                }
              }}
              className="space-y-4"
            >
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  Video or Clip URL *
                </label>
                <input
                  type="url"
                  required
                  value={reqUrl}
                  onChange={(e) => setReqUrl(e.target.value)}
                  placeholder="YouTube, Twitch Clip, or TikTok share/video URL…"
                  className="w-full bg-[#0d1017] border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-purple-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">
                    Custom Title (Optional)
                  </label>
                  <input
                    type="text"
                    value={reqTitle}
                    onChange={(e) => setReqTitle(e.target.value)}
                    placeholder="Auto-detected if left blank"
                    className="w-full bg-[#0d1017] border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">
                    Category Tag
                  </label>
                  <select
                    value={reqCategory}
                    onChange={(e) => setReqCategory(e.target.value)}
                    className="w-full bg-[#0d1017] border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-purple-500"
                  >
                    <option value="Auto">✨ Auto-Detect via Engine</option>
                    <option value="Music">🎵 Music / Beats</option>
                    <option value="Gaming">🎮 Gaming / Highlights</option>
                    <option value="Memes">😂 Memes / Comedy</option>
                    <option value="Clips">🎬 Twitch Clips</option>
                    <option value="IRL">🎙️ IRL / Podcast</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  Requester Twitch Name
                </label>
                <input
                  type="text"
                  value={reqUsername}
                  onChange={(e) => setReqUsername(e.target.value)}
                  placeholder={twitchAuth.username}
                  className="w-full bg-[#0d1017] border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-purple-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  Timestamp / Note for Streamer
                </label>
                <input
                  type="text"
                  value={reqNote}
                  onChange={(e) => setReqNote(e.target.value)}
                  placeholder="e.g. Watch the drop at 01:20!"
                  className="w-full bg-[#0d1017] border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-purple-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowRequestModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 text-white text-xs font-bold shadow-lg shadow-purple-600/30"
                >
                  LET HIM COOK
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==========================================
          MODAL 2: TWITCH AUTH & BROADCASTER LOGIN
          ========================================== */}
      {showAuthModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#121622] border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-purple-600/20 border border-purple-500/40 flex items-center justify-center text-purple-300"><Shield className="w-5 h-5" /></div>
                <div><h3 className="text-base font-bold text-white">Twitch authentication</h3><p className="text-xs text-slate-400">Only 2o3a and paim_beach_pete may log in.</p></div>
              </div>
              <button onClick={() => setShowAuthModal(false)} className="p-1.5 rounded-lg text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="rounded-xl bg-[#0d1017] border border-slate-800 p-4 space-y-2 text-sm">
              <div className="text-slate-400 text-xs uppercase font-bold">Current session</div>
              <div className="text-white font-bold">{twitchAuth.displayName}</div>
              <div className="text-purple-300 capitalize">{twitchAuth.role}{twitchAuth.authenticated ? ' · Twitch verified' : ' · public viewer'}</div>
              <p className="text-xs text-slate-400">Private room: twitch.tv/2o3a. Roles are assigned to the two allowlisted accounts on the server.</p>
            </div>
            {!twitchAuth.authenticated ? (
              <button disabled={twitchAuthLoading} onClick={() => { window.location.href = '/api/twitch/login'; }} className="w-full px-5 py-3 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-sm font-bold"><LogIn className="inline w-4 h-4 mr-2" />Continue with Twitch</button>
            ) : (
              <button onClick={async () => { authorizedLoginRef.current = ''; setFirebaseLoginToken(''); if (auth) { try { await signOut(auth); } catch { /* already signed out */ } } await fetch('/api/twitch/logout', { method: 'POST', credentials: 'same-origin' }); setTwitchAuth({ username: '', displayName: 'Signed out', role: 'viewer', color: '#a970ff', avatarLetter: 'Y', authenticated: false }); setShowAuthModal(false); }} className="w-full px-5 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-sm font-bold"><LogOut className="inline w-4 h-4 mr-2" />Log out of Twitch</button>
            )}
            <p className="text-[11px] text-amber-200/80">Allowlist: <strong>2o3a</strong> (streamer) and <strong>paim_beach_pete</strong> (moderator). All other Twitch accounts are denied on the server. Twitch OAuth and server secrets must be configured.</p>
          </div>
        </div>
      )}

      {/* ==========================================
          MODAL 3: STREAMER QUEUE RULES & SAFETY
          ========================================== */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#121622] border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-5 h-5 text-purple-400" />
                <h3 className="text-base font-bold text-white">Streamer Safety & Queue Rules</h3>
              </div>
              <button
                onClick={() => setShowSettingsModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3.5 text-xs">
              <div className="p-3 rounded-xl bg-[#0d1017] border border-emerald-500/20 space-y-1">
                <div className="font-bold text-amber-300">Unfiltered media requests</div>
                <p className="text-[11px] text-slate-400">All platforms and categories are accepted while the queue is open. Categories are labels only; subscriber-only, platform, and stream-mode filters are disabled.</p>
              </div>

              {[
                { key: 'queueOpen', label: 'Accepting New Requests', desc: 'Allow direct video links, !assr Twitch requests, and web submissions' },
                { key: 'autoPlayNext', label: 'Auto-Advance to Next Video', desc: 'Automatically move to the next track when playback ends where supported' }
              ].map((item) => (
                <label
                  key={item.key}
                  className="flex items-center justify-between p-3 rounded-xl bg-[#0d1017] border border-slate-800 cursor-pointer"
                >
                  <div>
                    <div className="font-bold text-slate-200">{item.label}</div>
                    <div className="text-[11px] text-slate-500">{item.desc}</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={streamSettings[item.key]}
                    onChange={(e) => {
                      const value = e.target.checked;
                      if (item.key === 'queueOpen') {
                        // Flip the gate immediately before React or Firestore has a chance to rerender.
                        queueOpenRef.current = value;
                        queueOpenCloudOverrideRef.current = { value, changedAt: Date.now() };
                      }
                      setStreamSettings((current) => ({ ...current, [item.key]: value }));
                    }}
                    className="w-4 h-4 accent-purple-600 rounded"
                  />
                </label>
              ))}

            </div>

            <div className="flex justify-end">
              <button
                onClick={() => {
                  setShowSettingsModal(false);
                  addToast('Streamer Queue Rules updated!', 'success');
                }}
                className="px-5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==========================================
          FLOATING TOAST NOTIFICATIONS
          ========================================== */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center gap-2.5 px-4 py-3 rounded-xl border shadow-xl backdrop-blur-md text-xs font-bold animate-fade-in ${
              t.type === 'error'
                ? 'bg-rose-950/90 border-rose-500/40 text-rose-200'
                : t.type === 'warning'
                ? 'bg-amber-950/90 border-amber-500/40 text-amber-200'
                : t.type === 'success'
                ? 'bg-emerald-950/90 border-emerald-500/40 text-emerald-200'
                : 'bg-[#151a28]/95 border-purple-500/40 text-purple-100'
            }`}
          >
            <Sparkles className="w-4 h-4 shrink-0 text-purple-400" />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
class YediHubAppErrorBoundary extends React.Component<React.PropsWithChildren<{}>, { hasError: boolean; errorMessage: string; componentStack: string }> {
  state = { hasError: false, errorMessage: '', componentStack: '' };

  static getDerivedStateFromError(error: Error): { hasError: true; errorMessage: string; componentStack: string } {
    return { hasError: true, errorMessage: String(error?.name ? error.name + ': ' : '') + String(error?.message || 'Unknown render error'), componentStack: '' };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('whale cum render failure', error, info);
    this.setState({ errorMessage: String(error?.name ? error.name + ': ' : '') + String(error?.message || 'Unknown render error'), componentStack: String(info?.componentStack || '') });
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <main className="min-h-screen bg-[#090a0f] text-white grid place-items-center p-6">
          <section className="max-w-2xl w-full rounded-2xl border border-rose-500/30 bg-[#121622] p-6 space-y-4">
            <h1 className="text-lg font-black">whale cum hit a rendering error</h1>
            <p className="text-sm text-slate-300">The dashboard stopped rendering. The exact error is shown below to make any remaining cause diagnosable.</p>
            <div className="rounded-xl border border-slate-700 bg-black/30 p-3">
              <div className="text-xs font-bold uppercase tracking-wide text-rose-300">Error</div>
              <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-200">{this.state.errorMessage}</pre>
              {this.state.componentStack && <details className="mt-3"><summary className="cursor-pointer text-xs font-bold text-slate-300">Component stack</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px] text-slate-400">{this.state.componentStack}</pre></details>}
            </div>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => this.setState({ hasError: false, errorMessage: '', componentStack: '' })} className="rounded-xl bg-purple-600 px-4 py-2 text-sm font-bold">Try again</button>
              <button type="button" onClick={() => window.location.reload()} className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-bold">Reload dashboard</button>
            </div>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

export default function YediHubApp() {
  return <YediHubAppErrorBoundary><YediHubAppContent /></YediHubAppErrorBoundary>;
}