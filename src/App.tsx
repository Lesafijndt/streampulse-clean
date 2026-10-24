import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Play,
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
  FolderSync,
  Download,
  Upload,
  History,
  Activity,
  BarChart3,
  Timer,
  TrendingUp,
  ChevronDown,
  Keyboard
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
  getDocs,
  onSnapshot
} from 'firebase/firestore';
import {
  buildCategoryCounts,
  buildNextTrackTransition,
  buildPreviousTrackTransition,
  buildQueueSyncWrites,
  filterVideosForView,
  formatMediaDuration,
  getQueueMediaCounts,
  getDurationEstimate,
  getThumbnailDurationLabel,
  getDurationCacheKey,
  applyCachedVideoDurations,
  buildQueueStatistics,
  formatRuntimeHoursMinutes,
  mergeVideoDurationData,
  createQueueBackup,
  validateQueueBackup
} from './queueLogic.js';
import { CATEGORY_META, detectVideoCategory, detectMusicType, getVideoMediaType, getVideoCategory, getMediaIdentityKey, isVerticalMedia, getStableMediaDocumentId, dedupeMediaVideos, parseMediaUrl } from './mediaUtils.js';
import StatsBoard from './components/StatsBoard';
import TransportNavigation from './components/TransportNavigation';
import KeyboardShortcutHint from './components/KeyboardShortcutHint';
import QueueToolbar from './components/QueueToolbar';
import QueueVideoCard from './components/QueueVideoCard';
import { createActivityEvent, mergeActivityEvents, normalizeActivityEvent } from './activityLog.js';
import { buildTikTokPlayerUrl, getVisibilityRestoreActions, postTikTokPlayerCommand, postYouTubePlayerCommand, shouldAutoUnmuteTikTok, shouldIgnoreTikTokStartupMute } from './playerBridge.js';
import { parseChatNotification, requestLikeChatMessage } from './twitchChatEvents.js';
import { MAX_MEDIA_DURATION_SECONDS, createDurationLookupOutcome, isValidMediaDuration, shouldRetryDurationLookup, videoNeedsDurationLookup } from './durationLookup.js';
import { formatAbsoluteTimestamp, formatRelativeTimestamp } from './timeUtils.js';



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
  const rawCategory = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'General';
  const categoryManuallySet = raw.categoryManuallySet === true;
  const normalizedBase = {
    ...raw,
    url: typeof raw.url === 'string' ? raw.url : '',
    title,
    note: typeof raw.note === 'string' ? raw.note : '',
    category: rawCategory,
    categoryManuallySet,
  };
  const normalizedCategory = getVideoCategory(normalizedBase);
  const mediaType = getVideoMediaType({ ...normalizedBase, category: normalizedCategory });
  const normalizedPlatform = validPlatforms.has(raw.platform) ? raw.platform : 'external';
  const hasTrustedDuration = ['metadata', 'player'].includes(String(raw.durationSource || ''));
  const legacyEstimatedDuration = !hasTrustedDuration && (
    (Number(raw.durationSec) === 45 && String(raw.duration || '') === '00:45' &&
      ['tiktok', 'twitch', 'kick'].includes(normalizedPlatform)) ||
    (Number(raw.durationSec) === 225 && ['03:45', '3:45'].includes(String(raw.duration || '')))
  );

  return {
    ...raw,
    id: safeId,
    title,
    url: typeof raw.url === 'string' ? raw.url : '',
    platform: validPlatforms.has(raw.platform) ? raw.platform : 'external',
    videoId: raw.videoId === undefined || raw.videoId === null ? '' : String(raw.videoId),
    category: normalizedCategory,
    categoryManuallySet,
    // One resolved media type drives counters, filters, and the labels shown in the queue.
    mediaType,
    requestedBy: typeof raw.requestedBy === 'string' || typeof raw.requestedBy === 'number' ? String(raw.requestedBy) : 'Viewer',
    status: validStatuses.has(raw.status) ? raw.status : 'queue',
    duration: legacyEstimatedDuration ? '' : (typeof raw.duration === 'string' ? raw.duration : ''),
    durationSec: !legacyEstimatedDuration && Number.isFinite(Number(raw.durationSec)) && Number(raw.durationSec) > 0 ? Number(raw.durationSec) : undefined,
    durationSource: legacyEstimatedDuration ? 'unknown' : (raw.durationSource || 'unknown'),
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
  const [networkOnline, setNetworkOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
  const networkOnlineRef = useRef(networkOnline);
  const [cloudReconnectTick, setCloudReconnectTick] = useState(0);
  const [activityReconnectTick, setActivityReconnectTick] = useState(0);
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
      const realSavedVideos = saved
        .filter((video) => video && typeof video === 'object' && !String(video.id || '').startsWith('demo-'))
        .map(normalizeLegacyVideoVotes);
      const durationCache = readStoredValue(roomStorageKey(channelRoom, 'duration-cache'), {});
      return dedupeMediaVideos(applyCachedVideoDurations(realSavedVideos, durationCache)).videos;
    }
    // Start empty so demo requests never appear to be real viewer submissions.
    return [];
  });
  const videosRef = useRef(videos);
  // Keep event and iframe callbacks on the latest committed queue, even during rapid navigation.
  videosRef.current = videos;
  const pendingMediaRequestKeysRef = useRef(new Set());
  const durationEnrichmentInFlightRef = useRef(new Set());
  const [durationRefreshCount, setDurationRefreshCount] = useState(0);
  const durationRefreshProcessedRef = useRef(0);
  const [durationLookupOutcomes, setDurationLookupOutcomes] = useState(() => {
    const saved = readStoredValue(roomStorageKey(channelRoom, 'duration-lookup-status'), {});
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  });
  const [activityEvents, setActivityEvents] = useState(() => {
    const stored = readStoredValue(roomStorageKey(channelRoom, 'activity-events'), []);
    return Array.isArray(stored) ? mergeActivityEvents(stored) : [];
  });
  const activityEventsRef = useRef(activityEvents);
  activityEventsRef.current = activityEvents;
  const activityCloudIdsRef = useRef(new Set());
  const activityCloudReadyRef = useRef(false);
  const activitySyncInFlightRef = useRef(new Set());
  const [activityCloudReady, setActivityCloudReady] = useState(false);
  const [activitySyncError, setActivitySyncError] = useState(false);
  const activitySessionIdRef = useRef('');
  if (!activitySessionIdRef.current) {
    const sessionKey = roomStorageKey(channelRoom, 'activity-session');
    let sessionId = '';
    try { sessionId = window.sessionStorage.getItem(sessionKey) || ''; } catch { /* Storage can be blocked. */ }
    if (!sessionId) {
      sessionId = 'session-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      try { window.sessionStorage.setItem(sessionKey, sessionId); } catch { /* Session tracking remains in memory. */ }
    }
    activitySessionIdRef.current = sessionId;
  }
  const [statsNow, setStatsNow] = useState(() => Date.now());
  const [statsExpanded, setStatsExpanded] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
  );
  const [connectionDetailsExpanded, setConnectionDetailsExpanded] = useState(false);
  const [topMenuOpen, setTopMenuOpen] = useState(false);
  const topMenuRef = useRef(null);
  useEffect(() => {
    if (!topMenuOpen) return undefined;
    const closeOnPointerDown = (event) => {
      if (!topMenuRef.current?.contains(event.target)) setTopMenuOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setTopMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [topMenuOpen]);
  const restoringBackupRef = useRef(false);
  const backupFileInputRef = useRef(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState('');
  const [safetySnapshot, setSafetySnapshot] = useState(() => {
    const saved = readStoredValue(roomStorageKey(channelRoom, 'safety-snapshot'), null);
    const validated = validateQueueBackup(saved);
    return validated.valid ? validated.backup : null;
  });

  // Filter & Nav State
  const [activeTab, setActiveTab] = useState('queue'); // 'queue' | 'watch_later' | 'watched'
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [mediaTypeFilter, setMediaTypeFilter] = useState('All');
  const [draggedQueueId, setDraggedQueueId] = useState('');
  const [dragOverQueueId, setDragOverQueueId] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('priority'); // 'priority' | 'upvotes' | 'newest'

  // Player State
  const [simProgress, setSimProgress] = useState(0);
  const playbackDurationRef = useRef({ videoId: '', seconds: 0 });
  const keyboardPausedRef = useRef({ videoId: '', paused: false });
  const [isTheatreMode, setIsTheatreMode] = useState(false);
  const [tiktokPlayerState, setTikTokPlayerState] = useState({ requestId: '', status: 'idle' });
  // Remember an explicit mute/unmute choice so startup recovery never overrides the app's mute button.
  const tiktokMutePreferenceRef = useRef({ requestId: '', preference: 'auto' });
  // Track observed player state separately from the viewer's deliberate preference.
  const tiktokAudioStateRef = useRef({ requestId: '', muted: null });
  const [tiktokFrameReload, setTikTokFrameReload] = useState(0);
  const [chatBotSession, setChatBotSession] = useState({ loading: true, connected: false, canReadChat: false, username: '' });
  const youtubeIframeRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const youtubePlaybackInfoRef = useRef({ currentTime: 0, duration: 0, volume: 100, muted: false, playerState: -1 });
  // Keep playback intent in this browser tab, not the shared cloud queue. This lets us
  // distinguish a deliberate pause/mute from autoplay behavior after tab visibility changes.
  const playbackIntentRef = useRef({ videoId: '', storageKey: '', paused: false, muted: null });
  const playbackPositionRef = useRef({ videoId: '', seconds: 0 });
  const playbackVisibilitySnapshotRef = useRef(null);
  const pendingPlaybackRestoreRef = useRef(null);
  const playbackRestoreGuardRef = useRef({ videoId: '', until: 0, paused: false, muted: null, currentTime: 0 });
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

  // Moderator-owned, authenticated EventSub chat intake. No chat transcript is stored.
  const [ircConnected, setIrcConnected] = useState(false);
  const [chatBridgeStatus, setChatBridgeStatus] = useState('Not connected');
  const [chatBridgeLastMessageAt, setChatBridgeLastMessageAt] = useState(0);
  const [chatBridgeLastRequestAt, setChatBridgeLastRequestAt] = useState(0);
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

  // Keep a local last-known-good snapshot while the queue has waiting items.
  // If the queue is accidentally emptied, retain the prior snapshot for recovery.
  useEffect(() => {
    const room = normalizeRoomName(channelRoom);
    if (!room) return;
    const snapshotKey = roomStorageKey(room, 'safety-snapshot');
    const previous = validateQueueBackup(readStoredValue(snapshotKey, null));
    const waitingCount = videos.filter((video) => video.status === 'queue').length;
    const snapshotVideos = waitingCount > 0
      ? videos
      : previous.valid
      ? previous.backup.videos
      : videos;
    if (!snapshotVideos.length) return;
    const snapshot = createQueueBackup({
      channelRoom: room,
      videos: snapshotVideos,
      streamSettings,
      votedIds,
      savedAt: Date.now()
    });
    if (writeStoredValue(snapshotKey, snapshot)) setSafetySnapshot(snapshot);
  }, [videos, streamSettings, votedIds, channelRoom]);

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
    let requestInFlight = false;
    const refreshBotSession = () => {
      if (requestInFlight) return;
      requestInFlight = true;
      fetch('/api/twitch/bot-session', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(8000)
      })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error('Chat bot session unavailable')))
        .then((session) => {
          if (cancelled) return;
          setChatBotSession({
            loading: false,
            connected: Boolean(session.connected && String(session.user?.login || '').toLowerCase() === 'gachibot69'),
            canReadChat: Boolean(session.canReadChat),
            username: session.connected ? String(session.user?.login || 'gachibot69') : ''
          });
        })
        .catch(() => {
          if (!cancelled) setChatBotSession({ loading: false, connected: false, username: '' });
        })
        .finally(() => { requestInFlight = false; });
    };
    refreshBotSession();
    const botStatusTimer = window.setInterval(refreshBotSession, 30000);
    window.addEventListener('focus', refreshBotSession);

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
    return () => {
      cancelled = true;
      window.clearInterval(botStatusTimer);
      window.removeEventListener('focus', refreshBotSession);
    };
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
        { includeMetadataChanges: true },
        (snapshot) => {
          if (!active || restoringBackupRef.current) return;
          const cloudConfirmed = !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
          setCloudSynced(cloudConfirmed);
          setSyncStatusText(snapshot.metadata.fromCache
            ? (networkOnlineRef.current ? 'Checking cloud connection…' : 'Offline cache — local save active')
            : snapshot.metadata.hasPendingWrites
            ? 'Syncing queue changes…'
            : 'Cloud Synced');

          // Normalize legacy seed votes and migrate each Firestore document once. This keeps old
          // requests' displayed vote counts honest and makes voter identity persistence consistent.
          const list = snapshot.docs.map((d) => {
            const rawData = d.data();
            const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData) ? rawData : {};
            const normalized = {
              ...normalizeLegacyVideoVotes(data),
              id: d.id,
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
          const rawRoomList = list.filter(
            (v) => v && typeof v === 'object' && normalizeRoomName(v.channelRoom) === normalizeRoomName(channelRoom) && !String(v.id || '').startsWith('demo-')
          );
          const dedupedRoomList = dedupeMediaVideos(rawRoomList);
          // Hydrate confirmed lengths from the browser cache first; older Firestore snapshots
          // must not erase them when a metadata write is briefly behind.
          const durationCache = readStoredValue(roomStorageKey(channelRoom, 'duration-cache'), {});
          const cachedRoomList = applyCachedVideoDurations(dedupedRoomList.videos, durationCache);
          const roomList = mergeVideoDurationData(cachedRoomList, videosRef.current);

          // Remove legacy duplicate Firestore documents as well as hiding them in the UI,
          // so a future refresh or deletion cannot make a duplicate reappear.
          if (dedupedRoomList.duplicateIds.length > 0) {
            void Promise.all(dedupedRoomList.duplicateIds.map((duplicateId) =>
              deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', duplicateId))
                .catch((error) => console.warn('Could not delete a duplicate queue document.', error))
            ));
          }

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
  }, [db, firebaseUser, channelRoom, appId, cloudReconnectTick]);

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

  const cacheVideoDuration = (video, rawDurationSeconds, source = 'metadata') => {
    const seconds = Math.round(Number(rawDurationSeconds));
    const key = getDurationCacheKey(video);
    if (!key || !isValidMediaDuration(seconds) || !['metadata', 'player'].includes(source)) return;
    const cacheKey = roomStorageKey(channelRoom, 'duration-cache');
    const stored = readStoredValue(cacheKey, {});
    const cache = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
    const existing = cache[key];
    if (existing?.source === 'player' && source !== 'player' && Number(existing.seconds) > 0) return;
    cache[key] = { seconds, source, updatedAt: Date.now() };
    const limited = Object.fromEntries(Object.entries(cache)
      .sort((left, right) => (Number(right[1]?.updatedAt) || 0) - (Number(left[1]?.updatedAt) || 0))
      .slice(0, 500));
    writeStoredValue(cacheKey, limited);
  };

  useEffect(() => {
    writeStoredValue(roomStorageKey(channelRoom, 'duration-lookup-status'), durationLookupOutcomes);
  }, [durationLookupOutcomes, channelRoom]);

  const reportPlayerDuration = (videoId, rawDurationSeconds) => {
    const seconds = Math.round(Number(rawDurationSeconds));
    if (!isValidMediaDuration(seconds)) return;
    const target = videosRef.current.find((video) => String(video.id) === String(videoId));
    if (!target) return;
    const id = String(target.id);
    const platform = String(target.platform || 'external').toLowerCase();
    const label = formatMediaDuration(seconds);
    const storedSeconds = Number(target.durationSec) || 0;
    const durationAlreadyAccurate = Math.abs(storedSeconds - seconds) <= 1 &&
      String(target.duration || '') === label &&
      ['metadata', 'player'].includes(String(target.durationSource || ''));

    // A real provider player report is stronger than an earlier failed server lookup.
    // Clear the stale error even when the value was already saved from metadata.
    const markPlayerDurationFound = () => setDurationLookupOutcomes((prev) => ({
      ...prev,
      [id]: createDurationLookupOutcome({
        status: 'found',
        platform,
        previous: prev[id] || null,
        provider: platform + '-player',
        at: Date.now(),
      })
    }));
    if (durationAlreadyAccurate) {
      markPlayerDurationFound();
      return;
    }
    const source = target.durationSource === 'metadata' && Math.abs(storedSeconds - seconds) <= 1
      ? 'metadata'
      : 'player';
    cacheVideoDuration(target, seconds, source);
    void syncUpdateVideo(id, {
      duration: label,
      durationSec: seconds,
      durationSource: source,
      durationProvider: platform + '-player'
    });
    markPlayerDurationFound();
  };

  // Backfill queue/history items. Failed lookups get bounded automatic retries instead of
  // becoming permanently stuck; in-flight IDs are locked before state updates to prevent races.
  const durationScanKey = videos.map((video) =>
    String(video.id) + ':' + String(video.platform || '') + ':' + String(video.url || '') + ':' +
    String(video.durationSource || '') + ':' + String(video.durationSec || '') + ':' + String(video.duration || '')
  ).join('|');
  useEffect(() => {
    const forceRetry = durationRefreshProcessedRef.current !== durationRefreshCount;
    durationRefreshProcessedRef.current = durationRefreshCount;
    const candidates = videosRef.current.filter((video) => {
      const id = String(video?.id || '');
      if (!id || durationEnrichmentInFlightRef.current.has(id) || !videoNeedsDurationLookup(video)) return false;
      return shouldRetryDurationLookup(durationLookupOutcomes[id], Date.now(), forceRetry);
    }).slice(0, 160);
    if (!candidates.length) return undefined;

    const previousOutcomes = new Map(candidates.map((video) => [String(video.id), durationLookupOutcomes[String(video.id)] || null]));
    const startedAt = Date.now();
    candidates.forEach((video) => durationEnrichmentInFlightRef.current.add(String(video.id)));
    setDurationLookupOutcomes((prev) => ({
      ...prev,
      ...Object.fromEntries(candidates.map((video) => {
        const id = String(video.id);
        return [id, createDurationLookupOutcome({
          status: 'pending', platform: video.platform, previous: previousOutcomes.get(id), at: startedAt,
        })];
      }))
    }));

    const enrich = async () => {
      for (let offset = 0; offset < candidates.length; offset += 3) {
        const batch = candidates.slice(offset, offset + 3);
        await Promise.all(batch.map(async (video) => {
          const id = String(video.id);
          const platform = String(video.platform || 'external').toLowerCase();
          try {
            const response = await fetch('/api/media-metadata?url=' + encodeURIComponent(video.url), {
              credentials: 'same-origin',
              cache: 'no-store',
              signal: AbortSignal.timeout(9000)
            });
            const metadata = await response.json().catch(() => null);
            if (!response.ok) {
              setDurationLookupOutcomes((prev) => ({
                ...prev,
                [id]: createDurationLookupOutcome({
                  status: 'error', platform, previous: previousOutcomes.get(id),
                  reason: metadata?.error || ('Metadata endpoint returned HTTP ' + response.status + '.'),
                  at: Date.now(),
                })
              }));
              return;
            }
            const seconds = Number(metadata?.durationSec);
            if (!isValidMediaDuration(seconds)) {
              setDurationLookupOutcomes((prev) => ({
                ...prev,
                [id]: createDurationLookupOutcome({
                  status: 'unavailable', platform, previous: previousOutcomes.get(id),
                  reason: metadata?.durationReason || 'The provider did not return a valid duration.',
                  provider: metadata?.durationProvider || '',
                  at: Date.now(),
                })
              }));
              return;
            }

            const current = videosRef.current.find((item) => String(item.id) === id);
            if (!current) return;
            cacheVideoDuration(current, seconds, 'metadata');
            if (!['metadata', 'player'].includes(String(current.durationSource || ''))) {
              void syncUpdateVideo(id, {
                duration: formatMediaDuration(seconds),
                durationSec: seconds,
                durationSource: 'metadata',
                durationProvider: String(metadata?.durationProvider || ''),
              });
            }
            setDurationLookupOutcomes((prev) => ({
              ...prev,
              [id]: createDurationLookupOutcome({
                status: 'found', platform, previous: previousOutcomes.get(id),
                provider: metadata?.durationProvider || '', at: Date.now(),
              })
            }));
          } catch (error) {
            const reason = error?.name === 'TimeoutError'
              ? 'Duration lookup timed out while contacting the metadata endpoint.'
              : String(error?.message || 'Network error during duration lookup.');
            setDurationLookupOutcomes((prev) => ({
              ...prev,
              [id]: createDurationLookupOutcome({
                status: 'error', platform, previous: previousOutcomes.get(id), reason, at: Date.now(),
              })
            }));
          } finally {
            durationEnrichmentInFlightRef.current.delete(id);
          }
        }));
      }
    };
    void enrich();
    return undefined;
  }, [durationScanKey, channelRoom, durationRefreshCount, durationLookupOutcomes]);

  // Retry failed duration lookups even when the dashboard stays open. Persisted retry times
  // let a reload resume a bounded backoff schedule rather than leaving failed entries stuck.
  useEffect(() => {
    const currentIds = new Set(videos.map((video) => String(video.id)));
    const retryTimes = Object.entries(durationLookupOutcomes)
      .filter(([id, outcome]) => currentIds.has(String(id)) &&
        ['unavailable', 'error'].includes(typeof outcome === 'string' ? outcome : outcome?.status))
      .filter(([id]) => {
        const video = videosRef.current.find((item) => String(item.id) === String(id));
        return videoNeedsDurationLookup(video) && !durationEnrichmentInFlightRef.current.has(String(id));
      })
      .map(([, outcome]) => Number(typeof outcome === 'object' ? outcome?.nextRetryAt : 0) || 0)
      .filter((time) => time > Date.now())
      .sort((a, b) => a - b);
    if (!retryTimes.length) return undefined;
    const delay = Math.max(1000, Math.min(2_147_000_000, retryTimes[0] - Date.now()));
    const timer = window.setTimeout(() => setDurationRefreshCount((count) => count + 1), delay);
    return () => window.clearTimeout(timer);
  }, [durationLookupOutcomes, durationScanKey]);

  useEffect(() => {
    const timer = window.setInterval(() => setStatsNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

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

  const syncActivityEventToCloud = async (event) => {
    if (!twitchAuth.authenticated || !activityCloudReadyRef.current || !event?.id ||
        activityCloudIdsRef.current.has(String(event.id)) ||
        activitySyncInFlightRef.current.has(String(event.id)) || !networkOnline) return false;
    const eventId = String(event.id);
    activitySyncInFlightRef.current.add(eventId);
    try {
      const response = await fetch('/api/activity-log', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, event })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Activity event could not be saved');
      activityCloudIdsRef.current.add(eventId);
      setActivitySyncError(false);
      return true;
    } catch (error) {
      console.warn('Activity event remains saved locally; cloud retry is pending.', error);
      setActivitySyncError(true);
      return false;
    } finally {
      activitySyncInFlightRef.current.delete(eventId);
    }
  };

  const recordActivity = (type, video = {}, options = {}) => {
    const source = options.source || (String(video?.note || '').toLowerCase().includes('twitch chat') ? 'twitch-chat' : 'dashboard');
    const event = createActivityEvent({
      id: options.id,
      type,
      room: normalizeRoomName(channelRoom) || PRIVATE_CHANNEL,
      at: options.at || Date.now(),
      sessionId: activitySessionIdRef.current,
      video,
      actor: options.actor || video?.requestedBy || twitchAuth.username || '',
      source
    });
    if (!event) return null;
    const merged = mergeActivityEvents(activityEventsRef.current, [event]);
    activityEventsRef.current = merged;
    setActivityEvents(merged);
    writeStoredValue(roomStorageKey(channelRoom, 'activity-events'), merged);
    if (activityCloudReadyRef.current) void syncActivityEventToCloud(event);
    return event;
  };

  const flushPendingActivityEvents = () => {
    if (!twitchAuth.authenticated || !activityCloudReadyRef.current || !networkOnline) return;
    activityEventsRef.current.forEach((event) => {
      if (!activityCloudIdsRef.current.has(String(event.id))) void syncActivityEventToCloud(event);
    });
  };

  const handleRetryActivitySync = () => {
    setActivityReconnectTick((tick) => tick + 1);
    setCloudReconnectTick((tick) => tick + 1);
    flushPendingActivityEvents();
  };

  const handleRefreshStats = () => {
    const storedEvents = readStoredValue(roomStorageKey(channelRoom, 'activity-events'), []);
    const merged = mergeActivityEvents(
      activityEventsRef.current,
      Array.isArray(storedEvents) ? storedEvents : []
    );
    activityEventsRef.current = merged;
    setActivityEvents(merged);
    writeStoredValue(roomStorageKey(channelRoom, 'activity-events'), merged);
    setStatsNow(Date.now());

    // Authenticated viewers can pull the latest lifetime activity from the server log too.
    if (twitchAuth.authenticated && networkOnline) {
      setActivityReconnectTick((tick) => tick + 1);
    }
  };

  const syncAddVideo = async (videoObj) => {
    const localItem = { ...videoObj, channelRoom: normalizeRoomName(channelRoom) };
    // Cloud confirmation is required: a local-only item must not be shown as a
    // successful chat request when the streamer's queue cannot see it.
    if (!db || !firebaseUser) {
      setCloudSynced(false);
      setSyncStatusText('Cloud queue unavailable — chat intake paused');
      return false;
    }
    // Keep the pending item visible until Firestore acknowledges the write,
    // while the synchronous ref blocks overlapping duplicate chat requests.
    videosRef.current = [localItem, ...videosRef.current];
    setVideos((prev) => [localItem, ...prev]);
    try {
      // Firestore rejects undefined values; missing duration metadata is normal.
      // JSON serialization drops undefined without changing the media identity.
      const documentData = JSON.parse(JSON.stringify({ ...localItem, createdAt: Date.now() }));
      const itemRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', String(localItem.id));
      await setDoc(itemRef, documentData, { merge: true });
      recordActivity('request_added', localItem, {
        source: String(localItem.note || '').toLowerCase().includes('twitch chat') ? 'twitch-chat' : 'dashboard'
      });
      return true;
    } catch (error) {
      videosRef.current = videosRef.current.filter((video) => String(video.id) !== String(localItem.id));
      setVideos((prev) => prev.filter((video) => String(video.id) !== String(localItem.id)));
      console.warn('Queue request was not confirmed by Firestore:', error?.code || error?.message || error);
      setCloudSynced(false);
      setSyncStatusText('Cloud queue write failed — request was not saved');
      return false;
    }
  };

  const syncDeleteVideo = async (videoId, options = {}) => {
    const removedItem = videosRef.current.find((video) => String(video.id) === String(videoId));
    if (removedItem) recordActivity('request_removed', removedItem, {
      actor: options.actor || twitchAuth.username || removedItem.requestedBy,
      source: options.source || 'dashboard'
    });
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

  useEffect(() => {
    if (!twitchAuth.authenticated) {
      activityCloudReadyRef.current = false;
      activityCloudIdsRef.current = new Set();
      setActivityCloudReady(false);
      return undefined;
    }

    let active = true;
    let loading = false;
    activityCloudReadyRef.current = false;
    setActivityCloudReady(false);
    const loadActivityEvents = async () => {
      if (!active || loading || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
      loading = true;
      try {
        const response = await fetch('/api/activity-log?appId=' + encodeURIComponent(appId), {
          credentials: 'same-origin',
          cache: 'no-store'
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(result.events)) {
          throw new Error(result.error || 'Activity log sync is unavailable');
        }
        const cloudEvents = result.events.map((event) => normalizeActivityEvent(event)).filter(Boolean);
        activityCloudIdsRef.current = new Set(cloudEvents.map((event) => String(event.id)));
        activityCloudReadyRef.current = true;
        setActivityCloudReady(true);
        setActivitySyncError(false);
        const merged = mergeActivityEvents(activityEventsRef.current, cloudEvents);
        activityEventsRef.current = merged;
        setActivityEvents(merged);
        writeStoredValue(roomStorageKey(channelRoom, 'activity-events'), merged);
        merged.forEach((event) => {
          if (!activityCloudIdsRef.current.has(String(event.id))) void syncActivityEventToCloud(event);
        });
      } catch (error) {
        if (active) {
          console.warn('Activity log sync will retry automatically:', error);
          setActivityCloudReady(false);
          activityCloudReadyRef.current = false;
          setActivitySyncError(true);
        }
      } finally {
        loading = false;
      }
    };
    void loadActivityEvents();
    const interval = window.setInterval(loadActivityEvents, 30000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [twitchAuth.authenticated, appId, channelRoom, activityReconnectTick]);

  // Import records for existing saved items which pre-date the event stream.
  // Stable IDs ensure that several signed-in dashboards can backfill the same queue safely.
  useEffect(() => {
    const normalizedRoom = normalizeRoomName(channelRoom);
    const localOnlyReady = !db || !firebaseUser;
    const cloudReady = Boolean(db && firebaseUser && cloudSynced && initializedCloudRoomsRef.current.has(normalizedRoom));
    if (!localOnlyReady && !cloudReady) return;
    const existingIds = new Set(activityEventsRef.current
      .filter((event) => event.type === 'request_added' && event.mediaId)
      .map((event) => String(event.mediaId)));
    const missing = videosRef.current.filter((video) =>
      video && typeof video === 'object' && !String(video.id || '').startsWith('demo-') &&
      !existingIds.has(String(video.id)));
    if (!missing.length) return;
    const legacyEvents = missing.map((video) => {
      const safeId = String(video.id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 90);
      return createActivityEvent({
        id: 'legacy-request-' + safeId,
        type: 'request_added',
        at: Number(video.timestamp) > 0 ? Number(video.timestamp) : Date.now(),
        room: normalizedRoom || PRIVATE_CHANNEL,
        sessionId: 'legacy-import',
        video,
        actor: video.requestedBy || 'unknown',
        source: 'legacy_import'
      });
    }).filter(Boolean);
    if (!legacyEvents.length) return;
    const merged = mergeActivityEvents(activityEventsRef.current, legacyEvents);
    activityEventsRef.current = merged;
    setActivityEvents(merged);
    writeStoredValue(roomStorageKey(channelRoom, 'activity-events'), merged);
    if (activityCloudReadyRef.current) legacyEvents.forEach((event) => void syncActivityEventToCloud(event));
  }, [db, firebaseUser, cloudSynced, activityCloudReady, videos, activityEvents, channelRoom]);

  const getSafeBackupSettings = (rawSettings = {}) => {
    const safe = { ...DEFAULT_STREAM_SETTINGS };
    Object.entries(DEFAULT_STREAM_SETTINGS).forEach(([key, defaultValue]) => {
      const value = rawSettings?.[key];
      if (typeof defaultValue === 'boolean' && typeof value === 'boolean') {
        safe[key] = value;
      } else if (typeof defaultValue === 'number' && Number.isFinite(Number(value))) {
        safe[key] = Math.max(1, Math.min(180, Number(value)));
      } else if (typeof defaultValue === 'string' && typeof value === 'string') {
        safe[key] = value.slice(0, 40);
      }
    });
    return safe;
  };

  const handleDownloadBackup = () => {
    const backup = createQueueBackup({
      channelRoom: normalizeRoomName(channelRoom),
      videos,
      streamSettings,
      votedIds,
      savedAt: Date.now()
    });
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = 'whale-cum-' + normalizeRoomName(channelRoom) + '-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    setBackupMessage('Backup downloaded: ' + videos.length + ' queue/history items. Twitch login credentials are not included.');
  };

  const performQueueBackupRestore = async (candidate, sourceLabel = 'backup file') => {
    const validation = validateQueueBackup(candidate);
    if (!validation.valid) {
      setBackupMessage(validation.error);
      return false;
    }
    const backup = validation.backup;
    const targetRoom = normalizeRoomName(channelRoom);
    if (normalizeRoomName(backup.channelRoom) !== targetRoom) {
      setBackupMessage('This backup belongs to #' + backup.channelRoom + ', not #' + targetRoom + '.');
      return false;
    }
    const snapshotDate = backup.savedAt ? new Date(backup.savedAt).toLocaleString() : 'an unknown date';
    const confirmed = window.confirm(
      'Restore ' + backup.videos.length + ' queue/history items and settings from ' + sourceLabel +
      ' (' + snapshotDate + ')? This replaces the current queue and history for #' + targetRoom + '.'
    );
    if (!confirmed) return false;

    setBackupBusy(true);
    setBackupMessage('Restoring queue and settings…');
    restoringBackupRef.current = true;
    const restoredSettings = getSafeBackupSettings(backup.streamSettings);
    const restoredVideos = dedupeMediaVideos(backup.videos.map((video) =>
      normalizeLegacyVideoVotes({ ...video, channelRoom: targetRoom })
    )).videos;
    const restoredVoteIds = Object.fromEntries(
      Object.entries(backup.votedIds || {})
        .filter(([key, value]) => typeof key === 'string' && key.length <= 300 && value === true)
        .slice(0, 20000)
    );
    queueOpenRef.current = Boolean(restoredSettings.queueOpen);
    queueOpenCloudOverrideRef.current = { value: queueOpenRef.current, changedAt: Date.now() };
    setStreamSettings(restoredSettings);
    setVotedIds(restoredVoteIds);
    videosRef.current = restoredVideos;
    setVideos(restoredVideos);

    try {
      if (db && firebaseUser) {
        setSyncStatusText('Restoring backup to cloud…');
        const cloudSnapshot = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'queue_videos'));
        const cloudRoomRows = cloudSnapshot.docs
          .map((entry) => ({ id: entry.id, ...entry.data() }))
          .filter((video) => normalizeRoomName(video.channelRoom) === targetRoom);
        const restoredIds = new Set(restoredVideos.map((video) => String(video.id)));
        const operations = [
          ...cloudRoomRows.filter((video) => !restoredIds.has(String(video.id)))
            .map((video) => ({ type: 'delete', id: String(video.id) })),
          ...restoredVideos.map((video) => ({ type: 'set', id: String(video.id), video }))
        ];
        // Firestore caps a batch at 500 writes; keep each restore batch comfortably below that.
        for (let offset = 0; offset < operations.length; offset += 400) {
          const batch = writeBatch(db);
          operations.slice(offset, offset + 400).forEach((operation) => {
            const itemRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', operation.id);
            if (operation.type === 'delete') batch.delete(itemRef);
            else batch.set(itemRef, { ...operation.video, channelRoom: targetRoom });
          });
          await batch.commit();
        }
        await setDoc(
          doc(db, 'artifacts', appId, 'public', 'data', 'room_settings', targetRoom),
          { channelRoom: targetRoom, streamSettings: restoredSettings, bridgeAutoConnect: true, updatedAt: Date.now() },
          { merge: true }
        );
        setCloudSynced(true);
        setSyncStatusText('Backup restored to cloud');
        setBackupMessage('Restored ' + restoredVideos.length + ' items and settings to cloud sync.');
      } else {
        setCloudSynced(false);
        setSyncStatusText('Backup restored locally — cloud sync unavailable');
        setBackupMessage('Restored ' + restoredVideos.length + ' items and settings locally. Cloud sync is unavailable.');
      }
    } catch (error) {
      console.error('Queue backup restore could not fully sync to Firestore.', error);
      setCloudSynced(false);
      setSyncStatusText('Backup restored locally — cloud restore failed');
      setBackupMessage('Restored locally, but the cloud update failed. Check the sync status before using another device.');
      addToast('Backup restored locally; cloud sync failed.', 'warning');
    } finally {
      restoringBackupRef.current = false;
      videosRef.current = restoredVideos;
      setVideos(restoredVideos);
      writeStoredValue(roomStorageKey(targetRoom, 'videos'), restoredVideos);
      writeStoredValue(roomStorageKey(targetRoom, 'settings'), restoredSettings);
      writeStoredValue(roomStorageKey(targetRoom, 'votes'), restoredVoteIds);
      setBackupBusy(false);
    }
    return true;
  };

  const handleImportBackupFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setBackupMessage('Backup is too large (10 MB maximum).');
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      const validation = validateQueueBackup(parsed);
      if (!validation.valid) {
        setBackupMessage(validation.error);
        return;
      }
      await performQueueBackupRestore(validation.backup, 'backup file');
    } catch (error) {
      console.warn('Could not read queue backup.', error);
      setBackupMessage('Could not read that JSON backup file.');
    }
  };

  const handleRecoverSafetySnapshot = () => {
    const stored = readStoredValue(roomStorageKey(channelRoom, 'safety-snapshot'), null);
    const validation = validateQueueBackup(stored);
    if (!validation.valid || !validation.backup.videos.length) {
      setBackupMessage('No recoverable queue snapshot is saved in this browser yet.');
      return;
    }
    void performQueueBackupRestore(validation.backup, 'the last local safety snapshot');
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

  const getPlaybackIntentForVideo = (videoId, platformOverride = '') => {
    const id = String(videoId || '');
    const matchingVideo = videosRef.current.find((video) => String(video.id) === id);
    const platform = platformOverride ||
      matchingVideo?.platform ||
      (String(currentVideoRef.current?.id || '') === id ? currentVideoRef.current?.platform : '');
    const isTikTok = platform === 'tiktok';
    const storageKey = roomStorageKey(channelRoom, 'player-playback-intent-v2-' + id);
    // Older builds accidentally saved autoplay mute as a deliberate preference.
    // Keep the old pause intent, but read TikTok audio preference from a clean separate key.
    const tiktokMuteStorageKey = isTikTok
      ? roomStorageKey(channelRoom, 'player-tiktok-mute-intent-v1-' + id)
      : '';
    const current = playbackIntentRef.current;
    if (current.videoId === id && current.storageKey === storageKey &&
        (!isTikTok || current.tiktokMuteStorageKey === tiktokMuteStorageKey) &&
        (isTikTok || !current.tiktokMuteStorageKey)) return current;

    let saved = null;
    let savedTikTokAudio = null;
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      saved = raw ? JSON.parse(raw) : null;
      if (isTikTok) {
        const audioRaw = window.sessionStorage.getItem(tiktokMuteStorageKey);
        savedTikTokAudio = audioRaw ? JSON.parse(audioRaw) : null;
      }
    } catch { /* A blocked session store should not break player controls. */ }
    return {
      videoId: id,
      storageKey,
      tiktokMuteStorageKey,
      paused: saved?.paused === true,
      muted: isTikTok
        ? (typeof savedTikTokAudio?.muted === 'boolean' ? savedTikTokAudio.muted : null)
        : (typeof saved?.muted === 'boolean' ? saved.muted : null),
    };
  };

  const updatePlaybackIntent = (videoId, updates, platformOverride = '') => {
    const previous = getPlaybackIntentForVideo(videoId, platformOverride);
    const isTikTok = Boolean(previous.tiktokMuteStorageKey);
    const next = { ...previous, ...updates, videoId: String(videoId || '') };
    playbackIntentRef.current = next;
    try {
      // Keep TikTok preference separate so legacy autoplay mute cannot override startup audio.
      window.sessionStorage.setItem(next.storageKey, JSON.stringify({
        paused: next.paused,
        muted: isTikTok ? null : next.muted,
      }));
      if (isTikTok && typeof updates?.muted === 'boolean') {
        window.sessionStorage.setItem(next.tiktokMuteStorageKey, JSON.stringify({ muted: updates.muted }));
      }
    } catch { /* Playback state remains available in memory if storage is unavailable. */ }
    return next;
  };

  const isPlaybackPaused = (videoId) => getPlaybackIntentForVideo(videoId).paused;

  // Keep the TikTok iframe URL stable for the lifetime of the current queue item.
  // Its autoplay query is only an initial-load setting; deriving it on every render
  // changes src when pause intent changes and makes React reload the embed mid-video.
  const tiktokPlayerSrc = useMemo(() => (
    currentVideo?.platform === 'tiktok'
      ? buildTikTokPlayerUrl(currentVideo.videoId, {
          paused: getPlaybackIntentForVideo(currentVideo.id, 'tiktok').paused,
        })
      : ''
  ), [currentVideo?.id, currentVideo?.videoId, currentVideo?.platform, channelRoom]);

  const recordPlaybackPosition = (videoId, seconds) => {
    const id = String(videoId || '');
    const value = Number(seconds);
    if (!id || !Number.isFinite(value) || value < 0) return;
    const pending = pendingPlaybackRestoreRef.current;
    if (pending?.videoId === id && Date.now() < pending.expiresAt && pending.currentTime > 0.5) {
      // A recreated iframe may report 0 before its seek completes; do not overwrite
      // the timestamp we are actively trying to restore.
      if (value < pending.currentTime - 2) return;
      if (Math.abs(value - pending.currentTime) <= 2) pendingPlaybackRestoreRef.current = null;
    }
    playbackPositionRef.current = { videoId: id, seconds: value };
  };

  // On a new queue item, restore only this tab's previous intent for that exact video.
  useEffect(() => {
    if (!currentVideo) {
      playbackIntentRef.current = { videoId: '', storageKey: '', paused: false, muted: null };
      playbackVisibilitySnapshotRef.current = null;
      pendingPlaybackRestoreRef.current = null;
      playbackRestoreGuardRef.current = { videoId: '', until: 0, paused: false, muted: null, currentTime: 0 };
      return;
    }
    const videoId = String(currentVideo.id);
    if (playbackPositionRef.current.videoId !== videoId) {
      playbackPositionRef.current = { videoId, seconds: 0 };
      pendingPlaybackRestoreRef.current = null;
    }
    const intent = getPlaybackIntentForVideo(videoId, currentVideo.platform);
    playbackIntentRef.current = intent;
    playbackVisibilitySnapshotRef.current = null;
    playbackRestoreGuardRef.current = intent.paused
      ? { videoId, until: Date.now() + 2500, paused: true, muted: intent.muted }
      : { videoId: '', until: 0, paused: false, muted: null };
    keyboardPausedRef.current = { videoId, paused: intent.paused };
  }, [currentVideo?.id, currentVideo?.platform, channelRoom]);

  // A hidden tab may suspend/recreate provider iframes. Preserve deliberate pauses,
  // but resume media that was playing before the tab was hidden.
  useEffect(() => {
    if (!currentVideo) return undefined;
    const videoId = String(currentVideo.id);
    const platform = currentVideo.platform;
    const restoreOnReturn = () => {
      if (document.visibilityState === 'hidden') {
        const intent = getPlaybackIntentForVideo(videoId, platform);
        const tiktokPreference = tiktokMutePreferenceRef.current.requestId === videoId
          ? tiktokMutePreferenceRef.current.preference
          : 'auto';
        const muted = platform === 'youtube'
          ? (typeof youtubePlaybackInfoRef.current.muted === 'boolean' ? youtubePlaybackInfoRef.current.muted : intent.muted)
          : platform === 'tiktok'
            ? (tiktokPreference === 'muted' ? true : intent.muted === true ? true : false)
            : intent.muted;
        const knownPosition = playbackPositionRef.current.videoId === videoId
          ? Number(playbackPositionRef.current.seconds) || 0
          : 0;
        const reportedPosition = platform === 'youtube'
          ? Number(youtubePlaybackInfoRef.current.currentTime)
          : knownPosition;
        // Keep the last useful timestamp if the browser/provider has already reset an
        // iframe while backgrounding the tab.
        const currentTime = Number.isFinite(reportedPosition) && reportedPosition > 0.5
          ? reportedPosition
          : knownPosition;
        recordPlaybackPosition(videoId, currentTime);
        const paused = intent.paused ||
          (platform === 'tiktok' && keyboardPausedRef.current.videoId === videoId && keyboardPausedRef.current.paused);
        playbackVisibilitySnapshotRef.current = { videoId, platform, paused, muted, currentTime };
        if (paused) updatePlaybackIntent(videoId, { paused: true });
        return;
      }

      const snapshot = playbackVisibilitySnapshotRef.current;
      if (!snapshot || snapshot.videoId !== videoId || snapshot.platform !== platform) return;
      const intent = getPlaybackIntentForVideo(videoId, platform);
      const paused = snapshot.paused || intent.paused;
      const muted = typeof snapshot.muted === 'boolean' ? snapshot.muted : intent.muted;
      const currentTime = Math.max(0, Number(snapshot.currentTime) || 0);
      // Only guard the iframe's immediate restoration blip; a multi-second guard blocks real user clicks.
      const expiresAt = Date.now() + 350;
      playbackRestoreGuardRef.current = {
        videoId,
        until: expiresAt,
        paused,
        muted: typeof muted === 'boolean' ? muted : null,
        currentTime,
      };
      if (currentTime > 0.5) {
        pendingPlaybackRestoreRef.current = { videoId, platform, currentTime, paused, muted, expiresAt };
        // Do not mark restoration complete before the player has actually sought there.
        playbackPositionRef.current = { videoId, seconds: currentTime };
      }
      if (paused) updatePlaybackIntent(videoId, { paused: true });
      if (typeof muted === 'boolean') updatePlaybackIntent(videoId, { muted });

      const actions = getVisibilityRestoreActions(platform, { paused, muted, currentTime });
      for (const action of actions) {
        if (platform === 'youtube') youtubePlayerRef.current?.[action.command]?.(...(action.args || []));
        else if (platform === 'tiktok') postTikTokPlayerCommand(tiktokIframeRef.current?.contentWindow, action.command, action.value ?? null);
      }
      playbackVisibilitySnapshotRef.current = null;
    };

    document.addEventListener('visibilitychange', restoreOnReturn);
    window.addEventListener('pageshow', restoreOnReturn);
    window.addEventListener('focus', restoreOnReturn);
    return () => {
      document.removeEventListener('visibilitychange', restoreOnReturn);
      window.removeEventListener('pageshow', restoreOnReturn);
      window.removeEventListener('focus', restoreOnReturn);
    };
  }, [currentVideo?.id, currentVideo?.platform, channelRoom]);

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
    if (firstQueued) syncUpdateVideo(firstQueued.id, { status: 'playing', pinned: false, playedAt: Date.now() });
  }, [videos]);

  const counts = useMemo(() => ({
    ...getQueueMediaCounts(videos, getVideoMediaType),
    watch_later: videos.filter((video) => video.status === 'watch_later').length,
    watched: videos.filter((video) => video.status === 'watched').length,
  }), [videos]);

  const queueStats = useMemo(
    () => buildQueueStatistics(videos, statsNow),
    [videos, statsNow]
  );
  const activitySyncStatus = !networkOnline
    ? 'Offline · local save'
    : activitySyncError
    ? 'Retry needed'
    : twitchAuth.authenticated
    ? activityCloudReady ? 'Cloud synced' : 'Connecting'
    : 'Local-only';
  const activitySyncTone = !networkOnline || activitySyncError
    ? 'warning'
    : twitchAuth.authenticated && activityCloudReady
    ? 'success'
    : 'neutral';
  const nextQueuedVideo = useMemo(
    () => videos.filter((video) => video.status === 'queue').sort(compareQueueOrder)[0] || null,
    [videos]
  );

  const categoryCounts = useMemo(
    () => buildCategoryCounts(videos, activeTab, mediaTypeFilter, getVideoCategory, getVideoMediaType),
    [videos, activeTab, mediaTypeFilter]
  );
  const syncIndicatorLabel = cloudSynced
    ? 'Cloud synced'
    : !networkOnline
    ? 'Local save'
    : /failed|unavailable|error/i.test(syncStatusText)
    ? 'Cloud issue'
    : /not configured|saved in this browser|local save/i.test(syncStatusText)
    ? 'Local save'
    : 'Syncing';
  const syncIndicatorClass = cloudSynced
    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
    : syncIndicatorLabel === 'Cloud issue'
    ? 'bg-rose-500/10 border-rose-500/30 text-rose-200'
    : 'bg-amber-500/10 border-amber-500/30 text-amber-200';

  // Rank queued items from the same persisted order used by playback.
  // Keep this map derived from the current queue so cards never reference an undefined variable.
  const queueRankById = useMemo(() => {
    const orderedQueue = videos
      .filter((video) => video.status === 'queue')
      .sort(compareQueueOrder);
    return new Map(orderedQueue.map((video, index): [string, number] => [String(video.id), index + 1]));
  }, [videos]);

  const filteredVideos = useMemo(
    () => filterVideosForView(videos, {
      activeTab, selectedCategory, mediaTypeFilter, searchQuery, sortBy
    }, { getVideoCategory, getVideoMediaType, compareQueueOrder }),
    [videos, activeTab, selectedCategory, mediaTypeFilter, searchQuery, sortBy]
  );


  const isStaff = twitchAuth.authenticated && (twitchAuth.role === 'streamer' || twitchAuth.role === 'moderator');


  // Authenticated Twitch chat via EventSub WebSocket, opened only by the
  // moderator's dashboard. The bot token is never sent to client JavaScript.
  const connectTwitchIrc = (targetChan, options = {}) => {
    const cleanChan = normalizeRoomName(targetChan || PRIVATE_CHANNEL);
    if (cleanChan !== PRIVATE_CHANNEL) return;
    const moderator = twitchAuth.authenticated &&
      normalizeTwitchLogin(twitchAuth.username) === 'paim_beach_pete';
    if (!moderator) {
      setChatBridgeStatus('Moderator dashboard only');
      setIrcConnected(false);
      return;
    }
    if (!chatBotSession.connected || !chatBotSession.canReadChat) {
      setChatBridgeStatus('Reconnect @gachibot69 with user:read:chat permission');
      setIrcConnected(false);
      return;
    }
    if (!db || !firebaseUser) {
      setChatBridgeStatus('Waiting for authenticated Firestore queue');
      setIrcConnected(false);
      return;
    }
    shouldReconnectIrcRef.current = true;
    ircTargetRef.current = cleanChan;
    if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    const oldSocket = ircSocketRef.current;
    ircSocketRef.current = null;
    try { oldSocket?.close(); } catch { /* Already closed. */ }
    let ws;
    try {
      const next = String(options.reconnectUrl || '');
      const uri = next.startsWith('wss://eventsub.wss.twitch.tv/')
        ? next : 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=40';
      ws = new WebSocket(uri);
    } catch (error) {
      setChatBridgeStatus('Twitch WebSocket initialization failed');
      setIrcConnected(false);
      return;
    }
    ircSocketRef.current = ws;
    setChatBridgeStatus('Connecting to Twitch EventSub…');
    setIrcConnected(false);
    let subscribed = Boolean(options.reconnectUrl);
    const seen = new Set();
    ws.onmessage = async (message) => {
      if (ircSocketRef.current !== ws) return;
      let frame;
      try { frame = JSON.parse(String(message.data || '')); } catch { return; }
      const kind = String(frame?.metadata?.message_type || '');
      if (kind === 'session_welcome') {
        if (subscribed) {
          setIrcConnected(true);
          setChatBridgeStatus('Subscribed — waiting for chat messages');
          reconnectAttemptsRef.current = 0;
          return;
        }
        const sessionId = String(frame?.payload?.session?.id || '');
        if (!sessionId) { ws.close(); return; }
        setChatBridgeStatus('Subscribing to channel.chat.message…');
        try {
          const response = await fetch('/api/twitch/bot-session?action=subscribe', {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
            signal: AbortSignal.timeout(12000),
          });
          const result = await response.json().catch(() => ({}));
          if (ircSocketRef.current !== ws) return;
          if (!response.ok || result.ok !== true) {
            const code = String(result.code || response.status);
            setChatBridgeStatus('Subscription failed: ' + code);
            if (['twitch_chat_permission_denied', 'bot_read_scope_missing', 'moderator_login_required', 'bot_login_required'].includes(code)) {
              // A permission error cannot be fixed by hammering Twitch every 30s.
              shouldReconnectIrcRef.current = false;
            }
            ws.close();
            return;
          }
          subscribed = true;
          reconnectAttemptsRef.current = 0;
          setIrcConnected(true);
          setChatBridgeStatus('Subscribed — waiting for chat messages');
        } catch (error) {
          setChatBridgeStatus('Subscription network error');
          if (ircSocketRef.current === ws) ws.close();
        }
        return;
      }
      if (kind === 'session_reconnect') {
        const url = String(frame?.payload?.session?.reconnect_url || '');
        if (url.startsWith('wss://eventsub.wss.twitch.tv/')) {
          connectTwitchIrc(cleanChan, { reconnectUrl: url, silent: true });
        }
        return;
      }
      if (kind === 'revocation') {
        setChatBridgeStatus('Twitch revoked the chat subscription');
        ws.close();
        return;
      }
      if (!subscribed || kind !== 'notification') return;
      const incoming = parseChatNotification(frame);
      if (!incoming) return;
      if (seen.has(incoming.id)) return;
      if (incoming.id) seen.add(incoming.id);
      if (seen.size > 1000) seen.clear();
      setChatBridgeLastMessageAt(Date.now());
      setChatBridgeStatus('Receiving chat');
      const username = incoming.login;
      const voterLogin = incoming.login;
      const usernameKey = incoming.login;
      const role = incoming.role;
      const text = incoming.text;
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
          sendTwitchChatReply('!assr <URL/title> request · !remove remove your latest waiting request · !when your spot/ETA · !queue queue status.');
          sendTwitchChatReply('!bigcock [#] upvote (not your own; one vote/video). Mods: !skip, !volume up/down/0-100, !mute, !unmute.');
        } else if (['!position', '!when', '!myqueue', '!queueposition'].includes(lowerText)) {
          handleQueuePositionRef.current?.(voterLogin || usernameKey);
        } else if (lowerText === '!skip' && isStaffRole(role)) {
          handleSkipNextRef.current?.();
        } else if (volumeCommand && isStaffRole(role)) {
          handleVolumeCommandRef.current?.(volumeCommand, role);
        }
    };
    ws.onerror = () => {
      if (ircSocketRef.current === ws) {
        setIrcConnected(false);
        setChatBridgeStatus('Twitch WebSocket connection error');
      }
    };
    ws.onclose = () => {
      if (ircSocketRef.current !== ws) return;
      ircSocketRef.current = null;
      setIrcConnected(false);
      if (shouldReconnectIrcRef.current) {
        reconnectAttemptsRef.current += 1;
        const delay = Math.min(30000, 1000 * (2 ** Math.min(reconnectAttemptsRef.current, 5)));
        reconnectTimerRef.current = window.setTimeout(() =>
          connectTwitchIrc(cleanChan, { silent: true }), delay);
      }
    };
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
    const canReceiveChat = twitchAuth.authenticated &&
      normalizeTwitchLogin(twitchAuth.username) === 'paim_beach_pete' &&
      chatBotSession.connected && chatBotSession.canReadChat && db && firebaseUser;
    shouldReconnectIrcRef.current = Boolean(canReceiveChat);
    if (!canReceiveChat) {
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
  }, [twitchAuth.authenticated, twitchAuth.username, chatBotSession.connected, chatBotSession.canReadChat, db, firebaseUser]);

  useEffect(() => {
    // Only rebuild Firestore/activity listeners when connectivity actually returns.
    // Reconnecting on every tab focus causes a cache-only snapshot, a false "Cloud issue"
    // flash, extra activity fetches, and needless work when switching back to the dashboard.
    const reconnectWhenAvailable = (force = false) => {
      const online = typeof navigator === 'undefined' ? true : navigator.onLine;
      const wasOffline = !networkOnlineRef.current;
      networkOnlineRef.current = online;
      setNetworkOnline(online);
      if (!online || (!wasOffline && !force)) return;
      setCloudReconnectTick((tick) => tick + 1);
      setActivityReconnectTick((tick) => tick + 1);
      if (twitchAuth.authenticated && shouldReconnectIrcRef.current) {
        const socket = ircSocketRef.current;
        if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
          connectTwitchIrc(ircTargetRef.current || PRIVATE_CHANNEL, { silent: true });
        }
      }
    };
    const onOnline = () => reconnectWhenAvailable(true);
    const onOffline = () => {
      networkOnlineRef.current = false;
      setNetworkOnline(false);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible' &&
          (!networkOnlineRef.current || (typeof navigator !== 'undefined' && !navigator.onLine))) {
        reconnectWhenAvailable();
      }
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [twitchAuth.authenticated]);

    // ==========================================
  // REQUEST CREATION & DISPATCH
  // ==========================================
  const handleIncomingChatCommand = async (username, role, rawText) => {
    const requester = normalizeTwitchLogin(username);
    const requestText = String(rawText || '').trim().replace(/^!assr\s*/i, '').trim();
    if (!requestText) {
      sendTwitchChatReply(`@${requester} Use !assr <URL or title>.`);
      return;
    }
    if (!queueOpenRef.current) {
      sendTwitchChatReply(`@${requester} Requests are closed.`);
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
          sendTwitchChatReply(`@${requester} No YouTube match. Try a shorter title or URL.`);
          return;
        }
        url = result.results[0].url;
        title = result.results[0].title || '';
      } catch (error) {
        console.warn('Chat title search failed:', error);
        sendTwitchChatReply(`@${requester} Search unavailable; try a direct URL.`);
        return;
      }
    }
    if (!queueOpenRef.current) {
      sendTwitchChatReply(`@${requester} Requests are closed.`);
      return;
    }
    // Keep successful requests quiet in Twitch chat. Failure responses (closed queue,
    // invalid TikTok links, failed title search, duplicates) are still sent by the request flow.
    await processAndQueueRequest({
      url, title, requestedBy: username, userRole: role,
      note: 'Requested via Twitch chat', manualCategory: null, fromChat: true
    });
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
      if (fromChat) sendTwitchChatReply('@' + normalizeTwitchLogin(requestedBy) + ' Room is not set.');
      return false;
    }
    // A closed queue blocks every new request, including requests sent by staff. Staff can
    // still manage/play items already in the queue. Use a ref so Twitch IRC callbacks see the
    // latest setting, not the value captured by an older render.
    if (!queueOpenRef.current) {
      addToast('The media request queue is currently closed by the streamer.', 'warning');
      if (fromChat) sendTwitchChatReply('@' + normalizeTwitchLogin(requestedBy) + ' Requests are closed.');
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
          if (fromChat) sendTwitchChatReply('@' + normalizeTwitchLogin(requestedBy) + ' TikTok link failed; try the full /video/ URL.');
          return false;
        }
        normalizedUrl = result.url;
        parsed = parseMediaUrl(normalizedUrl);
        if (!parsed.videoId) parsed.videoId = result.videoId;
      } catch (error) {
        console.warn('TikTok short-link resolution failed.', error);
        addToast('Could not resolve this TikTok share link here. Try copying the full TikTok URL with /video/ followed by its ID.', 'warning');
        if (fromChat) sendTwitchChatReply('@' + normalizeTwitchLogin(requestedBy) + ' TikTok link failed; try the full /video/ URL.');
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
        sendTwitchChatReply(`@${requester || 'viewer'} Already requested (queue/history).`);
      }
      return false;
    }
    // The lock closes the race where the same URL arrives in two chat messages at once,
    // while metadata/TikTok resolution is still running.
    pendingMediaRequestKeysRef.current.add(identityKey);

    // Fetch title/thumbnail and duration metadata. If title and thumbnail are already known,
    // duration enrichment continues in the background so chat requests don't wait for scraping.
    let resolvedTitle = String(title || '').trim();
    let resolvedThumbnail = parsed.thumbnail || '';
    let resolvedDurationSec = null;
    const needsBasicMetadata = !resolvedTitle || !resolvedThumbnail || String(resolvedThumbnail).includes('placehold.co');
    const mediaMetadataPromise = fetch(`/api/media-metadata?url=${encodeURIComponent(normalizedUrl)}`, {
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(async (response) => {
      if (!response.ok) return null;
      return response.json().catch(() => null);
    }).catch((error) => {
      console.warn('Media metadata lookup failed; using URL-based category detection.', error);
      return null;
    });
    let deferredMetadataPromise = mediaMetadataPromise;
    if (needsBasicMetadata) {
      const metadata = await mediaMetadataPromise;
      if (metadata) {
        if (!resolvedTitle && typeof metadata.title === 'string' && metadata.title.trim()) resolvedTitle = metadata.title.trim();
        if (typeof metadata.thumbnailUrl === 'string' && metadata.thumbnailUrl.startsWith('https://')) {
          resolvedThumbnail = metadata.thumbnailUrl;
        }
        const candidateDuration = Number(metadata.durationSec);
        if (Number.isFinite(candidateDuration) && candidateDuration > 0) resolvedDurationSec = candidateDuration;
      }
    }

    // Re-check after async URL/title resolution in case the streamer closed the queue mid-request.
    if (!queueOpenRef.current) {
      pendingMediaRequestKeysRef.current.delete(identityKey);
      addToast('The media request queue is currently closed by the streamer.', 'warning');
      if (fromChat) sendTwitchChatReply('@' + normalizeTwitchLogin(requestedBy) + ' Requests are closed.');
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
    const categoryManuallySet = Boolean(manualCategory && manualCategory !== 'Auto');
    const detectedCategory = categoryManuallySet
      ? manualCategory
      : detectVideoCategory(normalizedUrl, cleanTitle, note, 'all');
    const mediaType = categoryManuallySet
      ? (detectedCategory === 'Music' ? 'Music' : 'Non-Music')
      : detectMusicType(normalizedUrl, cleanTitle, note, detectedCategory);
    const finalCategory = !categoryManuallySet && mediaType === 'Music' ? 'Music' : detectedCategory;
    const requestedAt = Date.now();

    const newVideo = {
      id: getStableMediaDocumentId(normalizeRoomName(channelRoom) + '|' + identityKey),
      channelRoom,
      title: cleanTitle,
      url: normalizedUrl,
      platform: parsed.platform,
      videoId: parsed.videoId,
      category: finalCategory,
      categoryManuallySet,
      mediaType,
      duration: resolvedDurationSec ? formatMediaDuration(resolvedDurationSec) : '',
      durationSec: resolvedDurationSec || undefined,
      durationSource: resolvedDurationSec ? 'metadata' : 'unknown',
      requestedBy: normalizeTwitchLogin(requestedBy || twitchAuth.username || 'Viewer') || 'Viewer',
      userRole: 'viewer',
      status: 'queue',
      upvotes: 0,
      voters: [],
      pinned: false,
      addedAt: new Date(requestedAt).toISOString(),
      queueOrder: getNextQueueOrder(),
      timestamp: requestedAt,
      note: note || `Added to ${channelRoom} deck`,
      thumbnail: resolvedThumbnail || parsed.thumbnail,
      isVertical: parsed.platform === 'tiktok' || normalizedUrl.toLowerCase().includes('youtube.com/shorts/')
    };

    if (resolvedDurationSec) {
      cacheVideoDuration(newVideo, resolvedDurationSec, 'metadata');
      setDurationLookupOutcomes((prev) => ({
        ...prev,
        [String(newVideo.id)]: createDurationLookupOutcome({
          status: 'found', platform: parsed.platform, previous: prev[String(newVideo.id)] || null,
          provider: 'metadata', at: Date.now(),
        })
      }));
    } else if (deferredMetadataPromise) {
      const pendingId = String(newVideo.id);
      const previousLookup = durationLookupOutcomes[pendingId] || null;
      durationEnrichmentInFlightRef.current.add(pendingId);
      setDurationLookupOutcomes((prev) => ({
        ...prev,
        [pendingId]: createDurationLookupOutcome({
          status: 'pending', platform: parsed.platform, previous: prev[pendingId] || previousLookup, at: Date.now(),
        })
      }));
    }
    const confirmed = await syncAddVideo(newVideo);
    pendingMediaRequestKeysRef.current.delete(identityKey);
    if (!confirmed) {
      if (fromChat) setChatBridgeStatus('Chat request received; Firestore queue write failed');
      addToast('Request could not be saved to the shared queue.', 'warning');
      return false;
    }
    if (fromChat) setChatBridgeLastRequestAt(Date.now());

    if (deferredMetadataPromise && !resolvedDurationSec) {
      const newVideoId = String(newVideo.id);
      const previousLookup = durationLookupOutcomes[newVideoId] || null;
      void deferredMetadataPromise.then((metadata) => {
        const candidateDuration = Number(metadata?.durationSec);
        if (!isValidMediaDuration(candidateDuration)) {
          setDurationLookupOutcomes((prev) => ({
            ...prev,
            [newVideoId]: createDurationLookupOutcome({
              status: metadata ? 'unavailable' : 'error',
              platform: parsed.platform,
              previous: previousLookup,
              reason: metadata?.durationReason || 'The provider did not return a valid duration.',
              provider: metadata?.durationProvider || '',
              at: Date.now(),
            })
          }));
          return;
        }
        const current = videosRef.current.find((video) => String(video.id) === newVideoId);
        if (!current) return;
        cacheVideoDuration(current, candidateDuration, 'metadata');
        void syncUpdateVideo(newVideoId, {
          duration: formatMediaDuration(candidateDuration),
          durationSec: candidateDuration,
          durationSource: 'metadata',
          durationProvider: String(metadata?.durationProvider || ''),
        });
        setDurationLookupOutcomes((prev) => ({
          ...prev,
          [newVideoId]: createDurationLookupOutcome({
            status: 'found', platform: parsed.platform,
            previous: previousLookup, provider: metadata?.durationProvider || '', at: Date.now(),
          })
        }));
      }).catch((error) => {
        setDurationLookupOutcomes((prev) => ({
          ...prev,
          [newVideoId]: createDurationLookupOutcome({
            status: 'error', platform: parsed.platform, previous: previousLookup,
            reason: String(error?.message || 'Network error during duration lookup.'), at: Date.now(),
          })
        }));
      }).finally(() => {
        durationEnrichmentInFlightRef.current.delete(newVideoId);
      });
    }

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
    const previousPlaying = (videosRef.current || videos).find((item) => item.status === 'playing' && String(item.id) !== String(video.id));
    if (previousPlaying) recordActivity('track_skipped', previousPlaying, { actor: twitchAuth.username, source: 'play-now' });
    const alreadyPlaying = (videosRef.current || videos).some((item) => item.status === 'playing' && String(item.id) === String(video.id));
    if (!alreadyPlaying) recordActivity('play_started', video, { actor: twitchAuth.username, source: 'dashboard' });
    exitTikTokFullscreenBeforeTrackChange();
    const latestVideos = videosRef.current || videos;
    const now = Date.now();
    const updatesById = new Map();

    latestVideos.forEach((item) => {
      if (item.status === 'playing' && String(item.id) !== String(video.id)) {
        updatesById.set(String(item.id), {
          status: 'watched',
          watchedAt: new Date(now).toISOString(),
          playedAt: now,
          nextTrackOverrideId: null,
        });
      }
    });
    updatesById.set(String(video.id), {
      status: 'playing',
      pinned: false,
      playedAt: now + 1,
      nextTrackOverrideId: null,
    });

    const nextVideos = latestVideos.map((item) => {
      const updates = updatesById.get(String(item.id));
      return updates ? { ...item, ...updates } : item;
    });
    videosRef.current = nextVideos;
    setVideos(nextVideos);
    currentVideoRef.current = nextVideos.find((item) => String(item.id) === String(video.id)) || null;
    setSimProgress(0);

    if (db && firebaseUser) {
      const batch = writeBatch(db);
      updatesById.forEach((updates, id) => {
        const item = latestVideos.find((entry) => String(entry.id) === id) || { id };
        batch.set(
          doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', id),
          { ...item, ...updates, channelRoom: normalizeRoomName(channelRoom) },
          { merge: true }
        );
      });
      batch.commit().catch((error) => {
        console.warn('Play-now transition could not sync to Firestore.', error);
        setCloudSynced(false);
        setSyncStatusText('Playback changed locally — cloud sync failed');
      });
    }
    addToast(`Now Playing: ${String(video.title || 'video').slice(0, 32)}...`, 'info');
  };

  const handleSkipNext = (reason = 'skipped') => {
    exitTikTokFullscreenBeforeTrackChange();
    const latestVideos = videosRef.current || videos;
    const outgoing = currentVideoRef.current ||
      latestVideos.find((video) => video.status === 'playing') ||
      latestVideos.filter((video) => video.status === 'queue').sort(compareQueueOrder)[0] ||
      null;
    if (!outgoing) return;

    if (reason === 'completed') recordActivity('playback_completed', outgoing, { source: 'player-ended' });
    else recordActivity('track_skipped', outgoing, { actor: twitchAuth.username, source: 'dashboard' });

    const transition = buildNextTrackTransition(latestVideos, outgoing, compareQueueOrder);
    const { updatesById, nextVideos, nextOne } = transition;
    if (nextOne) recordActivity('play_started', nextOne, { actor: twitchAuth.username, source: reason === 'completed' ? 'auto-next' : 'next-track' });
    videosRef.current = nextVideos;
    setVideos(nextVideos);
    currentVideoRef.current = nextOne
      ? nextVideos.find((video) => String(video.id) === String(nextOne.id)) || null
      : null;
    setSimProgress(0);

    if (db && firebaseUser) {
      const batch = writeBatch(db);
      buildQueueSyncWrites(updatesById, latestVideos, normalizeRoomName(channelRoom)).forEach(({ id, payload }) => {
        batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', id), payload, { merge: true });
      });
      batch.commit().catch((error) => {
        console.warn('Next-track transition could not sync to Firestore.', error);
        setCloudSynced(false);
        setSyncStatusText('Next video changed locally — cloud sync failed');
      });
    }

    if (nextOne) addToast(`Now playing: ${String(nextOne.title || 'video').slice(0, 32)}...`, 'info');
    else addToast('Reached end of queue.', 'info');
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
        youtubePlaybackInfoRef.current = { ...youtubePlaybackInfoRef.current, muted: true };
        addToast('YouTube player muted by staff command.', 'info');
        return;
      }
      else if (volumeCommand.action === 'unmute') {
        player.unMute();
        youtubePlaybackInfoRef.current = { ...youtubePlaybackInfoRef.current, muted: false };
        addToast('YouTube player unmuted by staff command.', 'info');
        return;
      }
      player.setVolume(next);
      if (next > 0 && typeof player.unMute === 'function') player.unMute();
      if (next === 0 && typeof player.mute === 'function') player.mute();
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
      tiktokAudioStateRef.current = { requestId: currentVideo.id, muted: shouldMute };
      updatePlaybackIntent(currentVideo.id, { muted: shouldMute }, 'tiktok');
      const messageType = shouldMute ? 'mute' : 'unMute';
      postTikTokPlayerCommand(iframeWindow, messageType, null);
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
    const latestVideos = videosRef.current || videos;
    const outgoing = currentVideoRef.current ||
      latestVideos.find((video) => video.status === 'playing') ||
      latestVideos.filter((video) => video.status === 'queue').sort(compareQueueOrder)[0] ||
      null;
    if (!outgoing) return;

    const transition = buildPreviousTrackTransition(latestVideos, outgoing);
    const { previouslyPlayed, updates, nextVideos } = transition;
    if (previouslyPlayed) recordActivity('track_replayed', previouslyPlayed, { actor: twitchAuth.username, source: 'dashboard' });
    if (!previouslyPlayed) {
      addToast('There is no previous video in history yet.', 'warning');
      return;
    }
    videosRef.current = nextVideos;
    setVideos(nextVideos);
    currentVideoRef.current = nextVideos.find((video) => String(video.id) === String(previouslyPlayed.id)) || null;
    setSimProgress(0);

    if (db && firebaseUser) {
      const batch = writeBatch(db);
      buildQueueSyncWrites(updates, latestVideos, normalizeRoomName(channelRoom)).forEach(({ id, payload }) => {
        batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', id), payload, { merge: true });
      });
      batch.commit().catch((error) => {
        console.warn('Previous-track transition could not sync to Firestore.', error);
        setCloudSynced(false);
        setSyncStatusText('Previous track changed locally — cloud sync failed');
      });
    }
    addToast(`Previous: ${String(previouslyPlayed.title || 'video').slice(0, 32)}...`, 'info');
  };

  // Player and bridge callbacks always use current handlers and queue state.
  handleSkipNextRef.current = handleSkipNext;
  handleVolumeCommandRef.current = handleVolumeCommand;
  handleMediaEndedRef.current = (videoId) => {
    const playing = currentVideoRef.current || currentVideo;
    if (!playing || String(playing.id) !== String(videoId)) return;
    if (streamSettings.autoPlayNext) handleSkipNextRef.current?.('completed');
    else recordActivity('playback_completed', playing, { source: 'player-ended' });
  };

  const togglePlaybackFromKeyboard = () => {
    const video = currentVideoRef.current || currentVideo;
    if (!video) return;
    if (video.platform === 'youtube') {
      const player = youtubePlayerRef.current;
      if (!player || typeof player.getPlayerState !== 'function') {
        addToast('YouTube player is not ready for keyboard controls yet.', 'warning');
        return;
      }
      const state = Number(player.getPlayerState());
      if (state === 1 || state === 3) {
        updatePlaybackIntent(video.id, { paused: true });
        keyboardPausedRef.current = { videoId: String(video.id), paused: true };
        player.pauseVideo?.();
      } else {
        playbackRestoreGuardRef.current = { videoId: String(video.id), until: 0, paused: false, muted: null };
        updatePlaybackIntent(video.id, { paused: false });
        keyboardPausedRef.current = { videoId: String(video.id), paused: false };
        player.playVideo?.();
      }
      return;
    }
    if (video.platform === 'tiktok') {
      const iframeWindow = tiktokIframeRef.current?.contentWindow;
      if (!iframeWindow) {
        addToast('TikTok player is not ready for keyboard controls yet.', 'warning');
        return;
      }
      const sameVideo = keyboardPausedRef.current.videoId === String(video.id);
      const shouldPause = sameVideo ? !keyboardPausedRef.current.paused : true;
      keyboardPausedRef.current = { videoId: String(video.id), paused: shouldPause };
      if (shouldPause) {
        updatePlaybackIntent(video.id, { paused: true });
      } else {
        playbackRestoreGuardRef.current = { videoId: String(video.id), until: 0, paused: false, muted: null };
        updatePlaybackIntent(video.id, { paused: false });
      }
      postTikTokPlayerCommand(iframeWindow, shouldPause ? 'pause' : 'play', null);
      return;
    }
    addToast('This player does not expose remote play/pause controls. Use its in-player controls.', 'info');
  };

  const toggleMuteFromKeyboard = () => {
    const video = currentVideoRef.current || currentVideo;
    if (!video) return;
    if (video.platform === 'youtube') {
      const player = youtubePlayerRef.current;
      const isMuted = typeof player?.isMuted === 'function'
        ? player.isMuted()
        : Boolean(youtubePlaybackInfoRef.current.muted);
      handleVolumeCommandRef.current?.({ action: isMuted ? 'unmute' : 'mute' }, 'streamer');
      return;
    }
    if (video.platform === 'tiktok') {
      const actualAudioState = tiktokAudioStateRef.current.requestId === String(video.id)
        ? tiktokAudioStateRef.current.muted
        : null;
      const muted = typeof actualAudioState === 'boolean'
        ? actualAudioState
        : tiktokMutePreferenceRef.current.requestId === String(video.id) &&
          tiktokMutePreferenceRef.current.preference === 'muted';
      handleVolumeCommandRef.current?.({ action: muted ? 'unmute' : 'mute' }, 'streamer');
      return;
    }
    addToast('This player does not expose a remote mute control. Use its in-player controls.', 'info');
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      const isTyping = target instanceof HTMLElement && (
        target.isContentEditable ||
        target.closest('input, textarea, select, [contenteditable="true"]')
      );
      if (isTyping || showAuthModal || showSettingsModal || showRequestModal || topMenuOpen) return;
      const key = String(event.key || '').toLowerCase();
      if (event.code === 'Space' || key === ' ') {
        event.preventDefault();
        if (!event.repeat) togglePlaybackFromKeyboard();
      } else if (key === 'm') {
        if (!event.repeat) toggleMuteFromKeyboard();
      } else if (isStaff && (key === 'arrowright' || key === 'n')) {
        event.preventDefault();
        if (!event.repeat) handleSkipNextRef.current?.();
      } else if (isStaff && (key === 'arrowleft' || key === 'p')) {
        event.preventDefault();
        if (!event.repeat) handlePreviousTrack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentVideo?.id, isStaff, showAuthModal, showSettingsModal, showRequestModal, tiktokPlayerState.status, topMenuOpen]);

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
        postYouTubePlayerCommand(playerWindow, func, args);
      } catch (error) {
        console.debug('YouTube command could not be sent.', error);
      }
    };
    const proxy = {
      getCurrentTime: () => Number(youtubePlaybackInfoRef.current.currentTime) || 0,
      getDuration: () => Number(youtubePlaybackInfoRef.current.duration) || 0,
      getVolume: () => Number.isFinite(Number(youtubePlaybackInfoRef.current.volume)) ? Number(youtubePlaybackInfoRef.current.volume) : 100,
      seekTo: (seconds, allowSeekAhead = true) => postCommand('seekTo', [Math.max(0, Number(seconds) || 0), Boolean(allowSeekAhead)]),
      getPlayerState: () => Number.isFinite(Number(youtubePlaybackInfoRef.current.playerState)) ? Number(youtubePlaybackInfoRef.current.playerState) : -1,
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
      const intent = getPlaybackIntentForVideo(video.id);
      const pending = pendingPlaybackRestoreRef.current;
      const known = playbackPositionRef.current.videoId === String(video.id) ? playbackPositionRef.current.seconds : 0;
      const restoreSeconds = pending?.videoId === String(video.id) && Date.now() < pending.expiresAt
        ? pending.currentTime
        : known;
      if (intent.paused) postCommand('pauseVideo');
      if (restoreSeconds > 0.5 && Math.abs((Number(youtubePlaybackInfoRef.current.currentTime) || 0) - restoreSeconds) > 2) {
        postCommand('seekTo', [restoreSeconds, true]);
      }
      postCommand(intent.paused || document.visibilityState === 'hidden' ? 'pauseVideo' : 'playVideo');
      if (intent.muted === true) postCommand('mute');
      else if (intent.muted === false) postCommand('unMute');
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
        if (typeof info.muted === 'boolean') {
          const guard = playbackRestoreGuardRef.current;
          const restoringMute = guard.videoId === String(video.id) && Date.now() < guard.until && typeof guard.muted === 'boolean';
          const intent = getPlaybackIntentForVideo(video.id);
          if (!restoringMute && intent.muted !== info.muted) updatePlaybackIntent(video.id, { muted: info.muted });
        }
        const now = Number(info.currentTime);
        const duration = Number(info.duration);
        if (Number.isFinite(now) && now >= 0 && currentVideoRef.current?.id === video.id) {
          recordPlaybackPosition(video.id, now);
        }
        if (Number.isFinite(duration) && duration > 0 && currentVideoRef.current?.id === video.id) {
          playbackDurationRef.current = { videoId: String(video.id), seconds: duration };
          reportPlayerDuration(video.id, duration);
          if (Number.isFinite(now)) setSimProgress(Math.min(100, Math.max(0, (now / duration) * 100)));
        }
      }
      if (Number.isFinite(stateFromEvent)) {
        youtubePlaybackInfoRef.current.playerState = stateFromEvent;
        const videoId = String(video.id);
        const intent = getPlaybackIntentForVideo(videoId);
        const restoreGuard = playbackRestoreGuardRef.current;
        const suppressUnexpectedResume = stateFromEvent === 1 && intent.paused &&
          restoreGuard.videoId === videoId && Date.now() < restoreGuard.until && restoreGuard.paused;
        if (stateFromEvent === 2) {
          // Providers can report a synthetic pause when the browser backgrounds an iframe.
          // Do not persist that as the viewer's deliberate pause preference.
          if (document.visibilityState !== 'hidden') {
            updatePlaybackIntent(videoId, { paused: true });
            keyboardPausedRef.current = { videoId, paused: true };
          }
        } else if (stateFromEvent === 1 && suppressUnexpectedResume) {
          // Consume this one transient resume event only. Do not keep rejecting
          // explicit Play clicks for the remainder of a long visibility guard.
          playbackRestoreGuardRef.current = { videoId: '', until: 0, paused: false, muted: null };
          postCommand('pauseVideo');
        } else if (stateFromEvent === 1) {
          updatePlaybackIntent(videoId, { paused: false });
          keyboardPausedRef.current = { videoId, paused: false };
        }
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
  // window reference and listener. Its first muted report can be an autoplay/browser state,
  // not a user's preference, so do not persist it until startup unmute is acknowledged.
  useEffect(() => {
    const video = currentVideo;
    if (!video || video.platform !== 'tiktok' || !video.videoId) return undefined;
    let cancelled = false;
    let startupUnmuteAttempts = 0;
    let startupAudioConfirmed = false;
    let startupMuteGuardUntil = 0;
    const retryTimers = [];
    const getWindow = () => tiktokIframeRef.current?.contentWindow;
    const initialIntent = getPlaybackIntentForVideo(video.id, 'tiktok');
    startupAudioConfirmed = initialIntent.muted === true;
    tiktokMutePreferenceRef.current = {
      requestId: video.id,
      preference: initialIntent.muted === true ? 'muted' : initialIntent.muted === false ? 'unmuted' : 'auto',
    };
    tiktokAudioStateRef.current = {
      requestId: video.id,
      muted: typeof initialIntent.muted === 'boolean' ? initialIntent.muted : null,
    };
    const sendCommand = (type, targetWindow = getWindow(), value = null) => {
      if (!cancelled && targetWindow && targetWindow === getWindow()) {
        postTikTokPlayerCommand(targetWindow, type, value);
      }
    };
    const requestStartupUnmute = () => {
      const intent = getPlaybackIntentForVideo(video.id, 'tiktok');
      const preference = tiktokMutePreferenceRef.current.requestId === video.id
        ? tiktokMutePreferenceRef.current.preference
        : 'auto';
      if (!shouldAutoUnmuteTikTok({ mutedIntent: intent.muted, mutePreference: preference })) return false;
      if (intent.paused || document.visibilityState === 'hidden' || startupUnmuteAttempts >= 3) return false;
      startupUnmuteAttempts += 1;
      if (!startupAudioConfirmed) startupMuteGuardUntil = Date.now() + 3500;
      sendCommand('unMute');
      // Record intended audio separately from transient onMute autoplay reports.
      updatePlaybackIntent(video.id, { muted: false }, 'tiktok');
      return true;
    };
    const handleTikTokMessage = (event) => {
      if (event.origin !== 'https://www.tiktok.com' || event.source !== getWindow()) return;
      let data = event.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
      if (!data || data['x-tiktok-player'] !== true) return;
      if (data.type === 'onPlayerReady') {
        // A recreated iframe must restore playback position and audio preference.
        const intent = getPlaybackIntentForVideo(video.id, 'tiktok');
        const pending = pendingPlaybackRestoreRef.current;
        const known = playbackPositionRef.current.videoId === String(video.id) ? playbackPositionRef.current.seconds : 0;
        const restoreSeconds = pending?.videoId === String(video.id) && Date.now() < pending.expiresAt
          ? pending.currentTime
          : known;
        const deferPlaybackUntilVisible = document.visibilityState === 'hidden';
        if (intent.paused || deferPlaybackUntilVisible) sendCommand('pause');
        if (restoreSeconds > 0.5) sendCommand('seekTo', tiktokIframeRef.current?.contentWindow, restoreSeconds);
        if (!intent.paused && !deferPlaybackUntilVisible) sendCommand('play');
        if (intent.muted === true) {
          startupAudioConfirmed = true;
          startupMuteGuardUntil = 0;
          tiktokAudioStateRef.current = { requestId: video.id, muted: true };
          sendCommand('mute');
        } else {
          requestStartupUnmute();
          // TikTok can finish constructing its media element after onPlayerReady.
          // Retry unMute briefly after startup without changing the iframe URL.
          [350, 1100].forEach((delay) => {
            retryTimers.push(window.setTimeout(() => {
              if (!cancelled && !startupAudioConfirmed) requestStartupUnmute();
            }, delay));
          });
        }
      } else if (data.type === 'onMute' && typeof data.value === 'boolean') {
        const explicitPreference = tiktokMutePreferenceRef.current.requestId === video.id
          ? tiktokMutePreferenceRef.current.preference
          : 'auto';
        const ignoreStartupMute = shouldIgnoreTikTokStartupMute({
          muted: data.value,
          startupMuteGuardActive: !startupAudioConfirmed &&
            (startupMuteGuardUntil === 0 || Date.now() < startupMuteGuardUntil),
          startupAudioConfirmed,
          explicitMutePreference: explicitPreference,
        });
        tiktokAudioStateRef.current = { requestId: video.id, muted: data.value };
        if (data.value === false) {
          startupAudioConfirmed = true;
          startupMuteGuardUntil = 0;
        }
        if (ignoreStartupMute) return;
        updatePlaybackIntent(video.id, { muted: data.value }, 'tiktok');
        tiktokMutePreferenceRef.current = {
          requestId: video.id,
          preference: data.value ? 'muted' : 'unmuted',
        };
      } else if (data.type === 'onCurrentTime' && data.value) {
        const duration = Number(data.value.duration) || 0;
        const currentTime = Number(data.value.currentTime) || 0;
        if (currentVideoRef.current?.id === video.id) recordPlaybackPosition(video.id, currentTime);
        if (duration > 0) {
          if (currentVideoRef.current?.id === video.id) {
            playbackDurationRef.current = { videoId: String(video.id), seconds: duration };
            reportPlayerDuration(video.id, duration);
          }
          setSimProgress(Math.min(100, Math.max(0, (currentTime / duration) * 100)));
        }
      } else if (data.type === 'onStateChange') {
        const state = Number(data.value);
        const videoId = String(video.id);
        const intent = getPlaybackIntentForVideo(videoId, 'tiktok');
        const restoreGuard = playbackRestoreGuardRef.current;
        const suppressUnexpectedResume = state === 1 && intent.paused &&
          restoreGuard.videoId === videoId && Date.now() < restoreGuard.until && restoreGuard.paused;
        if (state === 2) {
          if (document.visibilityState !== 'hidden') {
            updatePlaybackIntent(videoId, { paused: true }, 'tiktok');
            keyboardPausedRef.current = { videoId, paused: true };
          }
        } else if (state === 1 && suppressUnexpectedResume) {
          playbackRestoreGuardRef.current = { videoId: '', until: 0, paused: false, muted: null };
          sendCommand('pause');
        } else if (state === 1) {
          updatePlaybackIntent(videoId, { paused: false }, 'tiktok');
          keyboardPausedRef.current = { videoId, paused: false };
        }
        // Retry host unmute once playback actually starts; only an explicit mute choice wins.
        if (state === 1 && !suppressUnexpectedResume && !startupAudioConfirmed) {
          requestStartupUnmute();
        }
        if (state === 0) handleMediaEndedRef.current?.(video.id);
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
    const requestedAt = Date.now();
    syncUpdateVideo(video.id, {
      status: 'queue',
      queueOrder: getNextQueueOrder(),
      timestamp: requestedAt,
      addedAt: new Date(requestedAt).toISOString()
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
    syncUpdateVideo(videoId, { category: newCategory, categoryManuallySet: true, mediaType: newCategory === 'Music' ? 'Music' : 'Non-Music' });
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
    recordActivity('vote_cast', target, { actor: voterLogin, source: 'twitch-chat-or-dashboard' });
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
      sendTwitchChatReply(`@${normalizeTwitchLogin(voterLogin) || 'viewer'} there is no queued video at #${position}. Use !when to see your requests.`);
      return;
    }
    handleUpvote(target.id, voterLogin).then((result) => {
      if (!result?.ok && result?.reason === 'own-request') {
        sendTwitchChatReply(`@${normalizeTwitchLogin(voterLogin)} Can't upvote your own request.`);
      } else if (!result?.ok && result?.reason === 'already-voted') {
        sendTwitchChatReply(`@${normalizeTwitchLogin(voterLogin)} Already voted for that video.`);
      } else if (result?.ok) {
        sendTwitchChatReply('@' + normalizeTwitchLogin(voterLogin) + ' +1 vote: ' + String(result.video?.title || 'video').slice(0, 38) + '.');
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
    let hasFallbackBeforeQueue = false;
    if (playing) {
      const knownPlaybackDuration = playbackDurationRef.current.videoId === String(playing.id)
        ? Number(playbackDurationRef.current.seconds) : 0;
      const durationEstimate = getDurationEstimate(playing);
      const duration = knownPlaybackDuration > 0 ? knownPlaybackDuration : durationEstimate.seconds;
      if (!(knownPlaybackDuration > 0) && durationEstimate.estimated) hasFallbackBeforeQueue = true;
      const progress = currentVideo?.id === playing.id && (playing.platform === 'youtube' || playing.platform === 'tiktok')
        ? Math.max(0, Math.min(100, Number(simProgress) || 0))
        : 0;
      secondsAhead = Math.max(0, duration * (1 - progress / 100));
    }
    let queuedDurationBefore = 0;
    const etaById = new Map();
    const etaFallbackById = new Map();
    queued.forEach((video) => {
      etaById.set(video.id, secondsAhead + queuedDurationBefore);
      etaFallbackById.set(video.id, hasFallbackBeforeQueue);
      const estimate = getDurationEstimate(video);
      queuedDurationBefore += estimate.seconds;
      if (estimate.estimated) hasFallbackBeforeQueue = true;
    });

    myQueued.forEach(({ video, position }) => {
      messages.push(`#${position} "${String(video.title || video.platform || 'video').slice(0, 38)}" (ETA ${formatQueueWait(etaById.get(video.id))})`);
    });

    if (!messages.length) {
      sendTwitchChatReply(`@${requester} No upcoming requests. Use !assr <URL/title>.`);
      return;
    }
    const visibleItems = messages.slice(0, 3);
    sendTwitchChatReply(`@${requester} ${visibleItems.join('; ')}.`);
  };
  handleQueuePositionRef.current = handleQueuePositionCommand;

  const handleRemoveOwnRequest = (requesterLogin) => {
    const requester = normalizeTwitchLogin(requesterLogin);
    if (!requester) return;
    const ownedWaiting = videos
      .filter((video) => video.status === 'queue' && normalizeTwitchLogin(video.requestedBy) === requester)
      .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
    if (!ownedWaiting.length) {
      sendTwitchChatReply(`@${requester} No waiting request to remove.`);
      return;
    }
    const target = ownedWaiting[0];
    void syncDeleteVideo(target.id);
    sendTwitchChatReply(`@${requester} Removed your latest waiting request.`);
  };
  handleRemoveOwnRequestRef.current = handleRemoveOwnRequest;

  const handleQueueSummary = (requesterLogin) => {
    const requester = normalizeTwitchLogin(requesterLogin);
    const playing = videos.find((video) => video.status === 'playing') || null;
    const queued = videos.filter((video) => video.status === 'queue').sort(compareQueueOrder);
    const top = queued.slice(0, 3).map((video, index) =>
      '#' + (index + 1) + ' ' + String(video.title || 'Untitled').slice(0, 26)
    );
    const myCount = queued.filter((video) => normalizeTwitchLogin(video.requestedBy) === requester).length;
    const playingText = playing ? 'Now: "' + String(playing.title || 'Untitled').slice(0, 32) + '"' : 'Nothing playing';
    sendTwitchChatReply('@' + requester + ' ' + playingText + ' | ' + queued.length + ' waiting (' + myCount + ' yours). Next: ' + (top.length ? top.join(', ') : 'empty') + '.');
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

  const handleDropReorder = (movingId, targetId) => {
    if (!isStaff || activeTab !== 'queue' || !movingId || !targetId || String(movingId) === String(targetId)) return;
    const fullQueue = videos.filter((video) => video.status === 'queue').sort(compareQueueOrder);
    const fromIndex = fullQueue.findIndex((video) => String(video.id) === String(movingId));
    const targetIndexBeforeRemoval = fullQueue.findIndex((video) => String(video.id) === String(targetId));
    if (fromIndex < 0 || targetIndexBeforeRemoval < 0 || fromIndex === targetIndexBeforeRemoval) return;

    const [movingVideo] = fullQueue.splice(fromIndex, 1);
    const targetIndex = fullQueue.findIndex((video) => String(video.id) === String(targetId));
    if (targetIndex < 0) return;
    fullQueue.splice(targetIndex, 0, movingVideo);

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
          batch.set(
            doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', String(video.id)),
            { id: String(video.id), queueOrder: video.queueOrder, channelRoom: normalizeRoomName(channelRoom) },
            { merge: true }
          );
        });
        try {
          await batch.commit();
        } catch (error) {
          console.warn('Drag-and-drop reorder batch failed; attempting merge writes.', error);
          try {
            await Promise.all(updates.map((video) => setDoc(
              doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', String(video.id)),
              { id: String(video.id), queueOrder: video.queueOrder, channelRoom: normalizeRoomName(channelRoom) },
              { merge: true }
            )));
          } catch (fallbackError) {
            console.warn('Drag-and-drop queue order could not sync to Firebase.', fallbackError);
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
          <div className="text-4xl mb-4">🧼</div><h1 className="text-2xl font-black tracking-tight text-white">WHALE CUM</h1>
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
          <h1 className="mt-2 text-3xl font-black tracking-tight text-white">WHALE CUM</h1>
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
  // MAIN APP INTERFACE
  // ==========================================
  return (
    <div className="gachi-theme min-h-screen bg-[#090a0f] text-slate-100 flex flex-col font-sans selection:bg-purple-600 selection:text-white">
      {/* ==========================================
          HEADER: BROADCASTER IDENTITY & SYNC STATUS
          ========================================== */}
      <header className="sticky top-0 z-40 bg-[#0e121a]/95 backdrop-blur-md border-b border-slate-800/80 px-4 lg:px-6 py-2.5">
        <div className="gachi-topbar-inner w-full max-w-none mx-auto flex flex-wrap items-center justify-between gap-3">
          {/* Logo & Channel Room Selector */}
          <div className="gachi-topbar-brand flex min-w-0 items-center gap-3">
            <div className="yedi-soap-logo w-9 h-9 rounded-xl flex items-center justify-center shadow-lg" title="Swedish bathhouse soap">
              <span className="yedi-soap-mark" role="img" aria-label="Bath soap">🧼</span>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="yedi-hub-wordmark font-extrabold text-base tracking-tight bg-clip-text text-transparent">
                  WHALE CUM
                </span>
                <span className="gachi-mode-badge px-2 py-0.5 rounded-md text-[10px] font-black bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  ♂ GACHI MODE ♂
                </span>
                <span className="gachi-deadpan-badge px-2 py-0.5 rounded-md text-[9px] font-black tracking-wide">
                  ♂ fitta javla fih
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
          <button
            type="button"
            onClick={() => setConnectionDetailsExpanded((expanded) => !expanded)}
            title="Show connection details"
            aria-label={`Connection details: ${syncStatusText}`}
            aria-expanded={connectionDetailsExpanded}
            className={`gachi-topbar-sync flex min-w-0 items-center gap-2 bg-[#141926] border rounded-xl px-2.5 py-1.5 text-[10px] sm:text-xs ${syncIndicatorClass}`}
          >
            <span className="flex shrink-0 items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${cloudSynced ? 'bg-emerald-400 animate-pulse' : syncIndicatorLabel === 'Cloud issue' ? 'bg-rose-400' : 'bg-amber-400'}`} />
              <span className="font-semibold whitespace-nowrap">{syncIndicatorLabel}</span>
            </span>
            <span className="text-slate-600">|</span>
            <span className="whitespace-nowrap text-slate-300">
              Queue: {streamSettings.queueOpen ? <span className="text-emerald-400 font-semibold">Open</span> : <span className="text-rose-400 font-semibold">Closed</span>}
            </span>
            <ChevronDown className={`h-3 w-3 transition-transform ${connectionDetailsExpanded ? 'rotate-180' : ''}`} />
          </button>


          {/* All top-bar actions live inside a single compact dropdown. */}
          <div className="gachi-topbar-menu relative z-50" ref={topMenuRef}>
            <button
              type="button"
              onClick={() => setTopMenuOpen((open) => !open)}
              aria-expanded={topMenuOpen}
              aria-haspopup="true"
              aria-controls="whale-cum-top-menu"
              className="flex items-center gap-2 rounded-xl border border-purple-500/30 bg-gradient-to-r from-[#24112f] to-[#11101a] px-3.5 py-2 text-xs font-black text-white shadow-lg shadow-purple-950/20 transition hover:border-purple-400/60 hover:from-[#351447] hover:to-[#171020]"
            >
              <Settings className="h-4 w-4 text-purple-300" />
              <span>Options</span>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${topMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {topMenuOpen && (
              <div id="whale-cum-top-menu" className="absolute right-0 top-full z-[60] mt-2 w-[min(21rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-purple-500/25 bg-[#0b0a12] p-2 shadow-2xl shadow-black/70 ring-1 ring-white/5">
                <div className="border-b border-white/10 px-3 pb-2.5 pt-1">
                  <div className="text-[9px] font-black uppercase tracking-[0.2em] text-purple-300">Arena options</div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-bold text-white">{twitchAuthLoading ? 'Checking Twitch…' : twitchAuth.displayName}</span>
                    <span className="shrink-0 rounded-md border border-purple-400/20 bg-purple-500/10 px-2 py-0.5 text-[9px] font-black uppercase text-purple-200">{twitchAuth.role}{twitchAuth.authenticated ? ' · verified' : ''}</span>
                  </div>
                </div>
                {isStaff && (
                  <button type="button" onClick={() => { setTopMenuOpen(false); setShowSettingsModal(true); }} className="mt-2 flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left text-xs font-bold text-slate-100 transition hover:border-purple-500/20 hover:bg-purple-500/10">
                    <Settings className="h-4 w-4 text-cyan-300" />
                    <span className="flex-1">Settings <span className="mt-0.5 block text-[10px] font-medium text-slate-500">Queue access and playback preferences</span></span>
                  </button>
                )}
                <button type="button" onClick={() => { setTopMenuOpen(false); setShowAuthModal(true); }} className="flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left text-xs font-bold text-slate-100 transition hover:border-purple-500/20 hover:bg-purple-500/10">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-tr from-purple-500 to-indigo-600 text-xs font-black text-white">{twitchAuth.avatarLetter}</span>
                  <span className="flex-1">Account and access <span className="mt-0.5 block text-[10px] font-medium text-slate-500">Twitch sign-in and permissions</span></span>
                </button>
                <div className="my-2 border-t border-white/10" />
                <div className="rounded-xl px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-[10px] font-black uppercase tracking-wide text-slate-300"><span className={`h-2 w-2 rounded-full ${ircConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />Twitch command bridge</span>
                    <span className={ircConnected ? 'text-[9px] font-bold text-emerald-300' : 'text-[9px] font-bold text-amber-200'}>{ircConnected ? 'SUBSCRIBED' : 'OFFLINE'}</span>
                  </div>
                  <button type="button" onClick={() => { setTopMenuOpen(false); connectTwitchIrc(channelRoom); }} className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-[#171420] px-3 py-2 text-[10px] font-bold text-slate-200 transition hover:border-purple-400/40 hover:bg-purple-500/10">
                    <RefreshCw className="h-3 w-3" /> Restart command bridge
                  </button>
                  <div className="mt-2 break-words text-[10px] text-slate-300">{chatBridgeStatus}</div>
                  <div className="mt-1 text-[9px] text-slate-400">
                    Last chat received: {chatBridgeLastMessageAt ? new Date(chatBridgeLastMessageAt).toLocaleTimeString() : 'Never'}
                    {' · '}
                    Last request: {chatBridgeLastRequestAt ? new Date(chatBridgeLastRequestAt).toLocaleTimeString() : 'Never'}
                  </div>
                </div>
                <div className="mt-1 rounded-xl px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-[10px] font-black uppercase tracking-wide text-slate-300"><span className={`h-2 w-2 rounded-full ${chatBotSession.connected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />Chat reply bot</span>
                    <span className={chatBotSession.connected ? 'text-[9px] font-bold text-emerald-300' : 'text-[9px] font-bold text-rose-200'}>{chatBotSession.loading ? 'CHECKING' : chatBotSession.connected ? 'ONLINE' : 'OFFLINE'}</span>
                  </div>
                  <button type="button" onClick={async () => {
                    setTopMenuOpen(false);
                    if (!chatBotSession.connected) { window.location.href = '/api/twitch/bot-login'; return; }
                    try {
                      await fetch('/api/twitch/bot-logout', { method: 'POST', credentials: 'same-origin' });
                      setChatBotSession({ loading: false, connected: false, username: '' });
                      addToast('Disconnected Twitch chat bot @gachibot69.', 'info');
                    } catch (error) { addToast('Could not disconnect the chat bot. Please try again.', 'warning'); }
                  }} className={`mt-2 flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-[10px] font-bold transition ${chatBotSession.connected ? 'border-slate-700 bg-[#171420] text-slate-200 hover:border-rose-400/40 hover:text-rose-200' : 'border-cyan-500/40 bg-cyan-800/60 text-white hover:bg-cyan-700'}`} title={chatBotSession.connected ? 'Disconnect chat reply account @gachibot69' : 'Connect chat reply account @gachibot69'}>
                    {chatBotSession.connected ? <LogOut className="h-3 w-3" /> : <LogIn className="h-3 w-3" />}
                    {chatBotSession.loading ? 'Checking bot…' : chatBotSession.connected ? 'Disconnect @gachibot69' : 'Connect @gachibot69'}
                  </button>
                  {chatBotSession.connected && !chatBotSession.canReadChat && (
                    <a href="/api/twitch/bot-login" className="mt-2 block rounded-lg border border-amber-400/40 bg-amber-900/30 px-3 py-2 text-center text-[10px] font-bold text-amber-100">
                      Reauthorize @gachibot69 to read Twitch chat
                    </a>
                  )}
                </div>
                <div className="my-2 border-t border-white/10" />
                <button type="button" onClick={() => {
                  setTopMenuOpen(false);
                  if (!normalizeRoomName(channelRoom)) { addToast('Set a Twitch channel before copying a room link.', 'warning'); return; }
                  const shareUrl = new URL(window.location.href);
                  shareUrl.searchParams.set('channel', normalizeRoomName(channelRoom));
                  navigator.clipboard.writeText(shareUrl.toString())
                    .then(() => addToast('Channel link copied. It opens this room and restores its cloud settings.', 'success'))
                    .catch(() => addToast(`Share this room URL: ${shareUrl.toString()}`, 'info'));
                }} className="flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left text-xs font-bold text-slate-100 transition hover:border-purple-500/20 hover:bg-purple-500/10">
                  <Copy className="h-4 w-4 text-purple-300" />
                  <span className="flex-1">Copy room link <span className="mt-0.5 block text-[10px] font-medium text-slate-500">Share this broadcaster room</span></span>
                </button>
              </div>
            )}
          </div>
        </div>

        {connectionDetailsExpanded && (
          <div className="mt-2 grid w-full grid-cols-1 gap-2 rounded-xl border border-slate-800 bg-[#0b0e15] p-3 text-[10px] sm:grid-cols-2 xl:grid-cols-4">
            <div className="min-w-0">
              <div className="mb-1 font-black uppercase tracking-wider text-slate-500">Cloud sync</div>
              <div className={cloudSynced ? 'text-emerald-300' : syncIndicatorLabel === 'Cloud issue' ? 'text-rose-200' : 'text-amber-200'}>{syncStatusText}</div>
            </div>
            <div>
              <div className="mb-1 font-black uppercase tracking-wider text-slate-500">Twitch command bridge</div>
              <div className={ircConnected ? 'text-emerald-300' : 'text-amber-200'}>{chatBridgeStatus}</div>
            </div>
            <div>
              <div className="mb-1 font-black uppercase tracking-wider text-slate-500">Chat reply bot</div>
              <div className={chatBotSession.connected ? 'text-emerald-300' : 'text-rose-200'}>{chatBotSession.loading ? 'Checking connection…' : chatBotSession.connected && !chatBotSession.canReadChat ? 'Replies only · reauthorize bot for chat reading' : chatBotSession.connected ? 'Online · @gachibot69 (read/write)' : 'Offline · chat intake unavailable'}</div>
            </div>
            <div>
              <div className="mb-1 font-black uppercase tracking-wider text-slate-500">Room and request queue</div>
              <div className="text-slate-200">#{normalizeRoomName(channelRoom)} · {streamSettings.queueOpen ? 'Requests open' : 'Requests closed'}</div>
            </div>
          </div>
        )}
      </header>

      {/* ==========================================
          MAIN WORKSPACE: PLAYER + QUEUE
          ========================================== */}
      <section className="gachi-masthead relative w-full overflow-hidden" aria-label="WHALE CUM Gachi Arena">
        <div className="gachi-masthead-art absolute inset-0" aria-hidden="true" />
        <div className="relative z-10 mx-auto flex min-h-[150px] w-full max-w-none flex-col justify-center px-5 py-5 sm:px-8 lg:px-10">
          <div className="flex items-center gap-2 text-[10px] sm:text-xs font-black uppercase tracking-[0.32em] text-rose-200"><span className="gachi-live-dot" /> PRIVATE GACHI ARENA <span className="text-fuchsia-400">♂</span> LIVE DECK</div>
          <h1 className="gachi-masthead-title mt-2 text-5xl sm:text-6xl lg:text-7xl xl:text-8xl font-black uppercase">WHALE CUM <span>♂</span></h1>
          <p className="mt-1 text-xs sm:text-sm font-black uppercase italic tracking-[0.22em] text-slate-100">REAL MEN WATCH REAL CONTENT</p>
        </div>
      </section>

      <div className="gachi-workspace flex-1 w-full max-w-[1740px] mx-auto grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_390px] xl:grid-cols-[245px_minmax(0,1fr)_430px] gap-4 lg:gap-5 p-3 sm:p-4 lg:p-5">
        <aside className="gachi-side-rail rounded-2xl border border-rose-500/30 p-3 sm:p-4 space-y-4">
          <StatsBoard
            queueStats={queueStats}
            activityEvents={activityEvents}
            currentSessionId={activitySessionIdRef.current}
            statsNow={statsNow}
            statsExpanded={statsExpanded}
            onToggle={() => setStatsExpanded((expanded) => !expanded)}
            onRefreshStats={handleRefreshStats}
            isStaff={isStaff}
            activitySyncStatus={activitySyncStatus}
            activitySyncTone={activitySyncTone}
            activitySyncError={activitySyncError}
            canRetryActivitySync={Boolean(twitchAuth.authenticated)}
            onRetryActivitySync={handleRetryActivitySync}
            networkOnline={networkOnline}
          />
        </aside>
        <div className="gachi-player-column flex flex-col gap-4 min-w-0">
          {/* ==========================================
              ACTIVE MEDIA DECK / BROADCASTER PLAYER
              ========================================== */}
          <section className="gachi-panel bg-[#10141f] border border-slate-800/90 rounded-2xl overflow-hidden shadow-2xl">
            {/* Header info strip */}
            <div className="px-4 py-2.5 bg-[#141926] border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                {currentVideo && (
                  <>
                    <span className={`px-2 py-0.5 rounded-lg text-[9px] font-black tracking-wide border ${currentVideo.status === 'playing' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' : 'bg-purple-500/15 border-purple-500/30 text-purple-200'}`}>
                      {currentVideo.status === 'playing' ? 'NOW PLAYING' : 'READY TO PLAY'}
                    </span>
                    <span className={`px-2 py-0.5 rounded-lg font-bold border ${CATEGORY_META[getVideoCategory(currentVideo)]?.badgeBg || 'bg-slate-800 text-slate-300'}`}>
                      {getVideoCategory(currentVideo)}
                    </span>
                    <span className={`px-2 py-0.5 rounded-lg border text-[10px] font-black uppercase ${getVideoMediaType(currentVideo) === 'Music' ? 'bg-rose-500/15 text-rose-300 border-rose-500/40' : 'bg-amber-500/15 text-amber-200 border-amber-500/40'}`}>
                      {getVideoMediaType(currentVideo)}
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
                  className={`gachi-player-stage relative w-full bg-[#05020a] flex items-center justify-center overflow-hidden transition-all ${
                    isTheatreMode
                      ? 'h-[75vh] min-h-[580px] max-h-[960px]'
                      : 'h-[62vh] min-h-[460px] max-h-[780px]'
                  }`}
                >
                  {isVerticalMedia(currentVideo) && (
                    <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none" aria-hidden="true">
                      <div className="absolute inset-0 bg-gradient-to-br from-[#05020a] via-[#1a0b2e] to-[#06040b]" />
                      {/* Keep portrait-video letterboxing black/purple instead of blurring bright thumbnail colors behind it. */}
                      <div className="absolute inset-0 bg-[#05020a]/80 backdrop-blur-sm" />
                      <div className="gachi-vertical-letterbox absolute inset-0" />
                    </div>
                  )}
                  {currentVideo.platform === 'youtube' && currentVideo.videoId ? (
                    <div className={isVerticalMedia(currentVideo)
                      ? "relative z-10 h-full aspect-[9/16] max-w-full overflow-hidden rounded-xl shadow-2xl"
                      : "absolute inset-1 h-[calc(100%-0.5rem)] w-[calc(100%-0.5rem)] overflow-hidden rounded-sm border border-[#5d277d]"}>
                    <iframe
                      key={`youtube-${currentVideo.id}-${currentVideo.videoId}`}
                      ref={youtubeIframeRef}
                      className="absolute inset-0 h-full w-full border-0"
                      src={`https://www.youtube.com/embed/${encodeURIComponent(currentVideo.videoId)}?autoplay=0&controls=1&playsinline=1&rel=0&modestbranding=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
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
                        const pending = pendingPlaybackRestoreRef.current;
                        const known = playbackPositionRef.current.videoId === String(currentVideo.id) ? playbackPositionRef.current.seconds : 0;
                        const restoreSeconds = pending?.videoId === String(currentVideo.id) && Date.now() < pending.expiresAt
                          ? pending.currentTime
                          : known;
                        const intent = getPlaybackIntentForVideo(currentVideo.id);
                        if (intent.paused) send('pauseVideo');
                        if (restoreSeconds > 0.5 && Math.abs((Number(youtubePlaybackInfoRef.current.currentTime) || 0) - restoreSeconds) > 2) {
                          send('seekTo', [restoreSeconds, true]);
                        }
                        send(intent.paused || document.visibilityState === 'hidden' ? 'pauseVideo' : 'playVideo');
                        if (intent.muted === true) send('mute');
                        else if (intent.muted === false) send('unMute');
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
                        src={tiktokPlayerSrc}
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
                          <p className="max-w-sm text-sm text-slate-300">Check that the post is public, then retry the embedded player.</p>
                          <div className="flex flex-wrap items-center justify-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setTikTokPlayerState({ requestId: currentVideo.id, status: 'loading' });
                                setTikTokFrameReload((attempt) => attempt + 1);
                              }}
                              className="rounded-xl bg-purple-600 px-4 py-2 text-xs font-bold text-white hover:bg-purple-500"
                            >Retry TikTok player</button>
                            
                          </div>
                        </div>
                      )}
                    </>
                  ) : currentVideo.platform === 'tiktok' ? (
                    <div className="max-w-lg p-8 text-center space-y-3">
                      <div className="text-cyan-300 font-bold">TikTok link needs a full video URL</div>
                      <p className="text-sm text-slate-300">This looks like a shortened TikTok link. Open it, then copy the full address containing <code>/video/</code> and submit that link so whale cum can extract the post ID.</p>
                      
                    </div>
                  ) : currentVideo.platform === 'twitch' && currentVideo.videoId ? (
                    <iframe
                      key={`twitch-${currentVideo.videoId}`}
                      className="w-[calc(100%-0.5rem)] h-[calc(100%-0.5rem)] border border-[#5d277d] rounded-sm shadow-[0_0_24px_rgba(98,25,143,0.22)]"
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
                <div className="gachi-player-footer p-4 sm:p-5 bg-[#141926] flex flex-col gap-4">
                  <div className="gachi-player-meta w-full min-w-0 space-y-1">
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
                      <span title={formatAbsoluteTimestamp(currentVideo.timestamp)}>Requested {formatRelativeTimestamp(currentVideo.timestamp, statsNow)}</span>
                      {currentVideo.note && (
                        <>
                          <span>•</span>
                          <span className="italic text-slate-300">"{currentVideo.note}"</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Player Quick Action Bar */}
                  <div className="gachi-player-controlbar w-full min-w-0 flex flex-wrap items-center justify-end gap-2">
                    {/* Voting changes the order of waiting requests; an already-playing video cannot be voted up. */}
                    {currentVideo.status !== 'playing' && (
                      <button
                        onClick={() => handleUpvote(currentVideo.id)}
                        disabled={normalizeTwitchLogin(currentVideo.requestedBy) === normalizeTwitchLogin(twitchAuth.username) || Boolean(votedIds[`${normalizeTwitchLogin(twitchAuth.username)}:${currentVideo.id}`])}
                        title={normalizeTwitchLogin(currentVideo.requestedBy) === normalizeTwitchLogin(twitchAuth.username) ? 'You cannot upvote your own request' : 'Upvote to increase this queued video’s priority'}
                        className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                          votedIds[`${normalizeTwitchLogin(twitchAuth.username)}:${currentVideo.id}`]
                            ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                            : 'bg-[#181e2e] hover:bg-slate-800 border-slate-700 text-slate-200'
                        }`}
                      >
                        <ThumbsUp className="w-4 h-4" />
                        <span>Upvote ({currentVideo.upvotes || 0})</span>
                      </button>
                    )}

                    {/* Watch Later Quick Stash */}
                    <button
                      onClick={() => handleMoveToWatchLater(currentVideo)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#181e2e] hover:bg-slate-800 text-cyan-300 border border-slate-700 text-xs font-semibold transition-colors"
                      title="Stash to Watch Later list without interrupting stream"
                    >
                      <Bookmark className="w-3.5 h-3.5" />
                      <span>Watch Later</span>
                    </button>

                    <TransportNavigation isStaff={isStaff} onPrevious={handlePreviousTrack} onNext={handleSkipNext} />
                  </div>
                  <div className="flex w-full justify-end"><KeyboardShortcutHint isStaff={isStaff} /></div>

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

        </div>

        <div className="gachi-queue-column min-w-0">
          {/* ==========================================
              QUEUE MANAGEMENT: TABS, FILTERS & CARDS
              ========================================== */}
          <section className="gachi-panel gachi-queue-panel bg-[#10141f] border border-slate-800/90 rounded-2xl p-3 sm:p-4 space-y-3 shadow-xl">
            <QueueToolbar
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              counts={counts}
              setMediaTypeFilter={setMediaTypeFilter}
              sortBy={sortBy}
              setSortBy={setSortBy}
              selectedCategory={selectedCategory}
              setSelectedCategory={setSelectedCategory}
              categoryMeta={CATEGORY_META}
              categoryCounts={categoryCounts}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
            />

            {/* Video Cards Feed */}
            <div className="gachi-queue-feed space-y-3 pt-1">
              {filteredVideos.length === 0 ? (
                <div className="p-10 border border-dashed border-slate-800 rounded-2xl text-center space-y-2 bg-[#121622]/40">
                  <Sparkles className="w-8 h-8 text-slate-600 mx-auto" />
                  <p className="text-sm font-bold text-slate-300">No media found in this view</p>
                  <p className="text-xs text-slate-500">
                    The arena awaits its next main event. Submit a YouTube, Twitch Clip, or TikTok link.
                  </p>
                </div>
              ) : (
                filteredVideos.map((video, idx) => (
                  <QueueVideoCard
                    key={video.id}
                    video={video}
                    index={idx}
                    activeTab={activeTab}
                    currentVideo={currentVideo}
                    queueRankById={queueRankById}
                    isStaff={isStaff}
                    draggedQueueId={draggedQueueId}
                    setDraggedQueueId={setDraggedQueueId}
                    dragOverQueueId={dragOverQueueId}
                    setDragOverQueueId={setDragOverQueueId}
                    handleDropReorder={handleDropReorder}
                    handlePlayNow={handlePlayNow}
                    handleCategoryChange={handleCategoryChange}
                    handleUpvote={handleUpvote}
                    twitchUsername={twitchAuth.username}
                    votedIds={votedIds}
                    normalizeTwitchLogin={normalizeTwitchLogin}
                    syncDeleteVideo={syncDeleteVideo}
                    handleMoveOrder={handleMoveOrder}
                    handleTogglePin={handleTogglePin}
                    handleMoveToWatchLater={handleMoveToWatchLater}
                    handleRequeue={handleRequeue}
                    now={statsNow}
                  />
                ))
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
                    <option value="Gaming">🎮 Blind Playthroughs</option>
                    <option value="Memes">😂 Shitposts</option>
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
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center overflow-y-auto p-3 sm:p-4">
          <div className="bg-[#121622] border border-slate-800 rounded-2xl max-h-[92vh] overflow-y-auto max-w-2xl w-full p-5 sm:p-6 space-y-5 shadow-2xl">
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
                { key: 'autoPlayNext', label: 'Auto-Advance to Next Video', desc: 'Automatically move to the next video when playback ends where supported' }
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

              <section className="p-3 rounded-xl bg-[#0b0e15] border border-purple-500/25 space-y-3">
                <div className="flex items-center gap-2">
                  <FolderSync className="w-4 h-4 text-purple-300" />
                  <h4 className="font-black text-white">Queue backup & recovery</h4>
                </div>
                <p className="text-[11px] leading-5 text-slate-400">
                  Backups include queue, history, votes, and stream settings—not Twitch login credentials. A safety snapshot is kept in this browser while there are waiting requests.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={handleDownloadBackup} disabled={backupBusy} className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-50 px-3 py-2 text-[11px] font-bold text-white">
                    <Download className="w-3.5 h-3.5" /> Download backup
                  </button>
                  <button type="button" onClick={() => backupFileInputRef.current?.click()} disabled={backupBusy} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 px-3 py-2 text-[11px] font-bold text-slate-100">
                    <Upload className="w-3.5 h-3.5" /> Restore file
                  </button>
                  <button type="button" onClick={handleRecoverSafetySnapshot} disabled={backupBusy || !safetySnapshot?.videos?.length} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 px-3 py-2 text-[11px] font-bold text-slate-100">
                    <History className="w-3.5 h-3.5" /> Recover last snapshot
                  </button>
                </div>
                <input
                  ref={backupFileInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleImportBackupFile}
                  aria-label="Choose a Whale Cum queue backup JSON file"
                />
                <p className="text-[10px] text-slate-500">
                  {safetySnapshot?.videos?.length
                    ? `Last local snapshot: ${safetySnapshot.videos.length} items · ${safetySnapshot.savedAt ? new Date(safetySnapshot.savedAt).toLocaleString() : 'saved earlier'}`
                    : 'No local recovery snapshot yet. Download a backup before making major queue changes.'}
                </p>
                {backupBusy && <p className="text-[11px] text-amber-200" role="status">Restoring backup…</p>}
                {backupMessage && <p className="text-[11px] leading-5 text-slate-200 break-words" role="status">{backupMessage}</p>}
              </section>
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