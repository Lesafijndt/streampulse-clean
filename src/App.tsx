import PointsDiagnostics from './components/PointsDiagnostics';
import { promotionLabel, isActivePromotion } from './promotion.js';
import PlaybackIssueReporter from './components/PlaybackIssueReporter';
import { playbackFailureMessage, prepareNextConnections, queueHealthWarnings } from './playbackReliability.js';
import { consumeChatCommandFeed } from './chatCommandFeed.js';
import React, { useState, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
import {
  Play,
  SkipForward,
  Shuffle,
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
  Expand,
  Shrink,
  MoveVertical,
  Pause,
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
  createPrivateCloudDb,
  resetPrivateCloud,
  collection,
  doc,
  setDoc,
  updateDoc,
  increment,
  arrayUnion,
  writeBatch,
  deleteDoc,
  getDocs,
  runTransaction,
  onSnapshot
} from './cloudStore.js';
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
import { CATEGORY_META, getDisplayMediaNote, detectVideoCategory, detectMusicType, getVideoMediaType, getVideoCategory, getMediaIdentityKey, isVerticalMedia, getStableMediaDocumentId, dedupeMediaVideos, parseMediaUrl } from './mediaUtils.js';
const StatsBoard = lazy(() => import('./components/StatsBoard'));
const PublicQueue = lazy(() => import('./components/PublicQueue'));
import { WorkspaceGrid, WorkspacePanel } from './components/WorkspaceGrid';
import TwitchClipPlayer from './components/TwitchClipPlayer';
import TransportNavigation from './components/TransportNavigation';
import KeyboardShortcutHint from './components/KeyboardShortcutHint';
import QueueToolbar from './components/QueueToolbar';
import RecoveryHistory from './components/RecoveryHistory';
import PlaybackFailure from './components/PlaybackFailure';
import { queueDragScrollDirection } from './queueDragScroll.js';
import { probeYouTubeDuration } from './providerDurationProbe.js';
import QueueVideoCard from './components/QueueVideoCard';
import { createActivityEvent, mergeActivityEvents, normalizeActivityEvent } from './activityLog.js';
import { createPlaybackCompletionTracker, getPlaybackGeneration, buildTikTokPlayerUrl, getVisibilityRestoreActions, postTikTokPlayerCommand, postYouTubePlayerCommand, shouldAutoUnmuteTikTok, shouldIgnoreTikTokStartupMute } from './playerBridge.js';
import { parseChatNotification, requestLikeChatMessage, maySkipCurrentRequest } from './twitchChatEvents.js';
import { sanitizePersonalPreferences } from './personalPreferences.js';
import { MAX_MEDIA_DURATION_SECONDS, createDurationLookupOutcome, isValidMediaDuration, shouldRetryDurationLookup, videoNeedsDurationLookup } from './durationLookup.js';
import { buildMediaMetadataPatch, getMetadataLookupKey, videoNeedsMetadataLookup, videoNeedsClassificationLookup, videoNeedsTitleLookup } from './mediaMetadata.js';
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
  if (isActivePromotion(a) && isActivePromotion(b)) return Number(a.queueOrder ?? a.timestamp ?? 0) - Number(b.queueOrder ?? b.timestamp ?? 0);
  if (isActivePromotion(a) !== isActivePromotion(b)) return isActivePromotion(a) ? -1 : 1;
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
    note: getDisplayMediaNote(raw.note),
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
    note: getDisplayMediaNote(raw.note),
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
function extractChatMediaUrls(rawText = '') {
  const input = String(rawText || '').trim().replace(/[\u200b-\u200d\ufeff]/g, '');
  const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|m\.youtube\.com|music\.youtube\.com|youtu\.be|tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|clips\.twitch\.tv|twitch\.tv|kick\.com|clip\.kick\.com)\/[^\s<>]+/gi;
  const distinct = new Set();
  for (const match of input.matchAll(regex)) {
    const url = String(match[0] || '').replace(/[.,!?;:)\]}>]+$/g, '');
    if (url) distinct.add(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    if (distinct.size >= 8) break;
  }
  return Array.from(distinct);
}
function isSupportedMediaUrlMessage(rawText = '') {
  return extractChatMediaUrls(rawText).length > 0;
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

const resolveVideoCategory = getVideoCategory, resolveVideoMediaType = getVideoMediaType;
function YediHubAppContent({ onDiagnosticAccess }) {
  const [categoryCorrections, setCategoryCorrections] = useState([]);
  const getVideoCategory = video => resolveVideoCategory(video, categoryCorrections);
  const getVideoMediaType = video => resolveVideoMediaType(video, categoryCorrections);
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
  const [profileLoadedFor, setProfileLoadedFor] = useState('');

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
  const moderatorLogin = twitchAuth.authenticated && String(twitchAuth.username || '').toLowerCase() === 'paim_beach_pete';
  useEffect(() => { onDiagnosticAccess(moderatorLogin); }, [moderatorLogin, onDiagnosticAccess]);
  const statisticsAccess = twitchAuth.authenticated && ALLOWED_TWITCH_USERS.has(String(twitchAuth.username || '').toLowerCase());
  const [twitchAuthLoading, setTwitchAuthLoading] = useState(true);
  const [firebaseLoginToken, setFirebaseLoginToken] = useState('');
  const authorizedLoginRef = useRef('');

  // UI Modals
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [resetScope, setResetScope] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [statisticsResetAt, setStatisticsResetAt] = useState(0);
  const statisticsResetAtRef = useRef(0);
  const [showRequestModal, setShowRequestModal] = useState(false);

  // Queue Moderation Settings
  const [streamSettings, setStreamSettings] = useState(() => {
    const saved = {};
    // Cloud-only personal settings are loaded after Twitch/Firebase login.
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
  const [metadataRetryTick, setMetadataRetryTick] = useState(0);
  const [shuffleBusy, setShuffleBusy] = useState(false);
  const shuffleInFlightRef = useRef(false);
  const durationRefreshProcessedRef = useRef(0);
  const [durationLookupOutcomes, setDurationLookupOutcomes] = useState(() => {
    const saved = readStoredValue(roomStorageKey(channelRoom, 'duration-lookup-status'), {});
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  });
  // Analytics are private to the two approved staff accounts. Never load a room-wide analytics
  // cache from shared localStorage, including when users switch Twitch accounts.
  const [activityEvents, setActivityEvents] = useState([]);
  const [cloudBackend, setCloudBackend] = useState('pending');
  const activityEventsRef = useRef(activityEvents);
  activityEventsRef.current = activityEvents;
  const activityCloudIdsRef = useRef(new Set());
  const activityCursorRef = useRef({ at: 0, id: '' });
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
  useEffect(() => {
    if (!draggedQueueId) return;
    let y = null;
    const track = event => { y = event.clientY; };
    const scroll = () => {
      if (y !== null && !document.hidden) {
        const feed = document.querySelector('.gachi-queue-feed');
        const bounds = feed?.getBoundingClientRect();
        const nested = feed && feed.scrollHeight > feed.clientHeight + 2;
        const visibleTop = bounds ? Math.max(0, bounds.top) : 0;
        const visibleBottom = bounds ? Math.min(window.innerHeight, bounds.bottom) : 0;
        const inside = nested && y >= visibleTop && y <= visibleBottom;
        const direction = inside ? queueDragScrollDirection(y - visibleTop, visibleBottom - visibleTop, 80) : queueDragScrollDirection(y, window.innerHeight);
        if (direction) (inside ? feed : window).scrollBy(0, direction * 15);
      }
    };
    window.addEventListener('dragover', track); const scrollTimer = window.setInterval(scroll, 32);
    return () => { window.removeEventListener('dragover', track); window.clearInterval(scrollTimer); };
  }, [draggedQueueId]);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('priority'); // 'priority' | 'upvotes' | 'newest'

  // Personal browser-specific playback audio only; never sync this to Firestore.
  const [localVolume, setLocalVolume] = useState(50);
  const [localMuted, setLocalMuted] = useState(false);
  const [audioLoadedFor, setAudioLoadedFor] = useState('');
  useEffect(() => {
    const name = String(twitchAuth.username || '').toLowerCase();
    if (!name || !twitchAuth.authenticated) return;
    try {
      const old = JSON.parse(localStorage.getItem('whale-cum:audio:v1:' + name) || '{}');
      setLocalVolume(Number.isFinite(old.volume) ? Math.max(0, Math.min(100, old.volume)) : 50);
      setLocalMuted(old.muted === true);
    } catch { setLocalVolume(50); setLocalMuted(false); }
    setAudioLoadedFor(name);
  }, [twitchAuth.authenticated, twitchAuth.username]);
  useEffect(() => {
    const name = String(twitchAuth.username || '').toLowerCase();
    if (!name || !twitchAuth.authenticated || audioLoadedFor !== name) return;
    try { localStorage.setItem('whale-cum:audio:v1:' + name, JSON.stringify({ volume: localVolume, muted: localMuted })); }
    catch { /* storage disabled */ }
  }, [twitchAuth.authenticated, twitchAuth.username, audioLoadedFor, localVolume, localMuted]);

  // Player State
  const [simProgress, setSimProgress] = useState(0);
  const [playbackPaused, setPlaybackPaused] = useState(false);
  const playbackDurationRef = useRef({ videoId: '', seconds: 0 });
  const keyboardPausedRef = useRef({ videoId: '', paused: false });
  const [isTheatreMode, setIsTheatreMode] = useState(false);
  const [tiktokPlayerState, setTikTokPlayerState] = useState({ requestId: '', status: 'idle' });
  // Remember an explicit mute/unmute choice so startup recovery never overrides the app's mute button.
  const tiktokMutePreferenceRef = useRef({ requestId: '', preference: 'auto' });
  // Track observed player state separately from the viewer's deliberate preference.
  const tiktokAudioStateRef = useRef({ requestId: '', muted: null });
  const [tiktokFrameReload, setTikTokFrameReload] = useState(0);
  const [playerReload, setPlayerReload] = useState(0);
  const [youtubeAutoplayBlocked, setYouTubeAutoplayBlocked] = useState(false);
  const [playerIssue, setPlayerIssue] = useState(null);
  const failedPlaybackRef = useRef('');
  const reportPlayerIssue = issue => { failedPlaybackRef.current = issue.generation; setPlayerIssue(issue); };
  const youtubeRecoveryRef = useRef({ generation: '', attempts: 0 });
  const tiktokRecoveryRef = useRef({ generation: '', attempts: 0 });
  const [chatBotSession, setChatBotSession] = useState({ loading: true, connected: false, canReadChat: false, username: '' });
  const [chatReplyIssue, setChatReplyIssue] = useState('');
  const [webhookHealth, setWebhookHealth] = useState({
    loading: true, active: false, code: 'checking', status: '', lastWebhookAt: 0,
    lastWebhookResult: 'none', lastWebhookQueued: 0, receiptCode: 'unknown', lastQueueWriteAt: 0, lastReplySentAt: 0,
  });
  const [webhookSetupBusy, setWebhookSetupBusy] = useState(false);
  const webhookAutoSetupAttemptedRef = useRef(false);
  const youtubeIframeRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const youtubePlaybackInfoRef = useRef({ currentTime: 0, duration: 0, volume: 50, muted: false, playerState: -1 });
  const localVolumeRef = useRef(localVolume);
  const localMutedRef = useRef(localMuted);
  localVolumeRef.current = localVolume;
  localMutedRef.current = localMuted;
  const fullscreenContainerRef = useRef(null);
  const [playerFullscreen, setPlayerFullscreen] = useState(false);
  const [fullscreenFallback, setFullscreenFallback] = useState(false);
  useEffect(() => {
    const sync = () => setPlayerFullscreen(document.fullscreenElement === fullscreenContainerRef.current);
    const escape = (event) => { if (event.key === 'Escape') setFullscreenFallback(false); };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('fullscreenchange', sync); document.removeEventListener('keydown', escape); };
  }, []);
  const togglePlayerFullscreen = async () => {
    if (fullscreenFallback) { setFullscreenFallback(false); return; }
    if (document.fullscreenElement === fullscreenContainerRef.current) { await document.exitFullscreen(); return; }
    try {
      if (!fullscreenContainerRef.current?.requestFullscreen) throw new Error('Fullscreen unavailable');
      await fullscreenContainerRef.current.requestFullscreen();
    } catch { setFullscreenFallback(true); }
  };
  // Keep playback intent in this browser tab, not the shared cloud queue. This lets us
  // distinguish a deliberate pause/mute from autoplay behavior after tab visibility changes.
  const playbackIntentRef = useRef({ videoId: '', storageKey: '', paused: false, muted: null });
  const playbackPositionRef = useRef({ videoId: '', seconds: 0 });
  const playbackWriteRef = useRef({ key: '', at: 0 });
  const progressUpdateRef = useRef({ generation: '', at: 0 });
  const playbackVisibilitySnapshotRef = useRef(null);
  const pendingPlaybackRestoreRef = useRef(null);
  const playbackRestoreGuardRef = useRef({ videoId: '', until: 0, paused: false, muted: null, currentTime: 0 });
  const tiktokIframeRef = useRef(null);
  const handleSkipNextRef = useRef(null);
  const handleVolumeCommandRef = useRef(null);
  const handleIncomingChatCommandRef = useRef(null);
  const consumeChatCommandFeedRef = useRef(null);
  const chatCommandSeenRef = useRef(new Set());
  const latestChatCommandFeedRef = useRef([]);
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
    if (!moderatorLogin && /cloud|firebase|firestore|sync|oauth|webhook|quota|token|postgres|database|backend|server_error|playback_error/i.test(String(message))) message = 'That action could not finish. Please try again.';
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

  // Personal queue/player preferences are saved under user_profiles in Firestore,
  // not duplicated into browser localStorage or the shared room document.

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
        setCloudBackend(session.storageBackend === 'postgres' ? 'postgres' : 'firebase');
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
          if (session.storageBackend === 'postgres') {
            setSyncStatusText('Connecting private Postgres queue…');
          } else if (!hasWebFirebaseConfig) {
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
    if (cloudBackend === 'pending') return;
    if (cloudBackend === 'postgres') {
      setAuth(null);
      if (twitchAuth.authenticated && ALLOWED_TWITCH_USERS.has(String(twitchAuth.username || '').toLowerCase())) {
        setDb(createPrivateCloudDb({ legacyVideos: videosRef.current.filter(video => video.channelRoom === '2o3a' && !String(video.id).startsWith('demo-')) }));
        // This is an API-session marker, not a Firebase credential. Every read
        // and write is independently authorized by the server's Twitch session.
        setFirebaseUser({ uid: 'twitch_' + twitchAuth.username });
        setSyncStatusText('Connecting private Postgres queue…');
      } else { setDb(null); setFirebaseUser(null); }
      return;
    }
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
  }, [cloudBackend, twitchAuth.authenticated, twitchAuth.username]);

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

          // Snapshot reconciliation is read-only. Never delete requests merely
          // because a legacy row shares a media URL with another generation.

          if (roomList.length > 0) {
            initializedCloudRoomsRef.current.add(normalizeRoomName(channelRoom));
            setVideos(roomList);
            return;
          }

          const normalizedRoom = normalizeRoomName(channelRoom);
          if (cloudBackend === 'postgres') {
            // The private transport performs the single guarded cache import
            // before publishing. An empty result after that is authoritative.
            initializedCloudRoomsRef.current.add(normalizedRoom);
            setVideos([]);
            return;
          }
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
        const corrections = Array.isArray(cloudConfig.categoryCorrections) ? cloudConfig.categoryCorrections : [];
        setCategoryCorrections(previous => JSON.stringify(previous) === JSON.stringify(corrections) ? previous : corrections);
        latestChatCommandFeedRef.current = cloudConfig.chatCommandFeed || [];
        setChatReplyIssue(cloudConfig.chatReplyDiagnostic?.code && cloudConfig.chatReplyDiagnostic.code !== 'ok' ? cloudConfig.chatReplyDiagnostic.code : '');
        consumeChatCommandFeedRef.current?.(latestChatCommandFeedRef.current);
        const cutoff = Number(cloudConfig.statisticsResetAt || 0);
        if (cutoff > statisticsResetAtRef.current) {
          statisticsResetAtRef.current = cutoff;
          setStatisticsResetAt(cutoff);
          activityEventsRef.current = activityEventsRef.current.filter(event => event.at > cutoff);
          setActivityEvents(activityEventsRef.current);
        }
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
          setStreamSettings((current) => current.queueOpen === Boolean(merged.queueOpen)
            ? current : { ...current, queueOpen: Boolean(merged.queueOpen) });
        }
        setRoomConfigLoadedFor(normalizedRoom);
        return;
      }

      // Shared room queue controls belong to the moderator, not the streamer.
      if (!moderatorLogin) { setRoomConfigLoadedFor(normalizedRoom); return; }
      // First setup of a room: seed its cloud configuration from defaults.
      const seed = { queueOpen: true };
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
  }, [db, firebaseUser, channelRoom, appId, moderatorLogin]);

  useEffect(() => {
    const normalizedRoom = normalizeRoomName(channelRoom);
    if (!moderatorLogin || !normalizedRoom || !db || !firebaseUser || roomConfigLoadedFor !== normalizedRoom) return;
    const configRef = doc(db, 'artifacts', appId, 'public', 'data', 'room_settings', normalizedRoom);
    setDoc(configRef, { channelRoom: normalizedRoom, streamSettings: { queueOpen: streamSettings.queueOpen }, bridgeAutoConnect: true, updatedAt: Date.now() }, { merge: true })
      .catch((error) => {
        console.warn('Could not save cloud room settings.', error);
        setSyncStatusText('Room settings save failed — local settings remain saved');
      });
  }, [db, firebaseUser, appId, channelRoom, streamSettings, roomConfigLoadedFor, moderatorLogin]);

  // Each account's cloud profile is stored through a verified Twitch session
  // action (on an existing Vercel function). No new Hobby function is needed,
  // and old Firestore client-side rules cannot block profile persistence.
  useEffect(() => {
    const login = String(twitchAuth.username || '').toLowerCase();
    if (!twitchAuth.authenticated || !ALLOWED_TWITCH_USERS.has(login)) {
      setProfileLoadedFor('');
      return;
    }
    let valid = true;
    setProfileLoadedFor('');
    void fetch('/api/twitch/session?action=preferences', {
      credentials: 'same-origin', cache: 'no-store'
    }).then(async response => {
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) throw new Error(result.code || 'profile_read_failed');
      if (!valid) return;
      const prefs = sanitizePersonalPreferences(result.preferences || {});
      if (prefs.activeTab !== undefined) setActiveTab(prefs.activeTab);
      if (prefs.selectedCategory !== undefined) setSelectedCategory(prefs.selectedCategory);
      if (prefs.mediaTypeFilter !== undefined) setMediaTypeFilter(prefs.mediaTypeFilter);
      if (prefs.sortBy !== undefined) setSortBy(prefs.sortBy);
      if (prefs.searchQuery !== undefined) setSearchQuery(prefs.searchQuery);
      if (prefs.isTheatreMode !== undefined) setIsTheatreMode(prefs.isTheatreMode);
      if (prefs.statsExpanded !== undefined) setStatsExpanded(prefs.statsExpanded);
      if (prefs.streamSettings) {
        setStreamSettings(current => ({ ...current, ...prefs.streamSettings, queueOpen: current.queueOpen }));
      }
      setProfileLoadedFor(login);
    }).catch(error => console.warn('Personal cloud preferences could not load:', error?.message || error));
    return () => { valid = false; };
  }, [twitchAuth.authenticated, twitchAuth.username]);

  useEffect(() => {
    const login = String(twitchAuth.username || '').toLowerCase();
    if (profileLoadedFor !== login || !ALLOWED_TWITCH_USERS.has(login)) return;
    const prefs = sanitizePersonalPreferences({
      activeTab, selectedCategory, mediaTypeFilter, sortBy, searchQuery,
      isTheatreMode, statsExpanded, streamSettings,
    });
    const pending = window.setTimeout(() => {
      void fetch('/api/twitch/session?action=preferences', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: prefs }),
      }).then(async response => {
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.code || 'profile_write_failed');
        }
      }).catch(error => console.warn('Personal cloud preferences could not save:', error?.message || error));
    }, 650);
    return () => window.clearTimeout(pending);
  }, [twitchAuth.username, profileLoadedFor,
      activeTab, selectedCategory, mediaTypeFilter, sortBy, searchQuery, isTheatreMode, statsExpanded, streamSettings]);

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
        if (cloudBackend === 'postgres' && e?.status !== 404) {
          console.warn('Queue update was not confirmed; retaining the authoritative cloud row.', e?.code || e);
          return;
        }
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

  const syncEnrichedMetadata = async (original, metadata) => {
    const id = String(original.id);
    const current = videosRef.current.find((item) => String(item.id) === id);
    const patch = buildMediaMetadataPatch(original, current, metadata);
    if (!Object.keys(patch).length) return patch;
    if (db && firebaseUser) {
      if (db.privateCloud) {
        const response = await fetch('/api/twitch/session?action=store', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation: 'enrich-metadata', id, url: original.url,
            generation: getPlaybackGeneration(original), patch }), signal: AbortSignal.timeout(12000),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok !== true) throw new Error(body.code || 'Metadata could not be saved');
        if (body.applied !== true) return {};
      } else {
        const ref = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', id);
        await runTransaction(db, async (transaction) => {
          const snapshot = await transaction.get(ref);
          const freshPatch = buildMediaMetadataPatch(original, snapshot.exists() ? snapshot.data() : null, metadata);
          if (Object.keys(freshPatch).length) transaction.update(ref, freshPatch);
        });
      }
    }
    // Recheck after the network write: playback or a custom title may have changed meanwhile.
    const latest = videosRef.current.find((item) => String(item.id) === id);
    const localPatch = buildMediaMetadataPatch(original, latest, metadata);
    videosRef.current = videosRef.current.map((item) => String(item.id) === id ? { ...item, ...localPatch } : item);
    setVideos(videosRef.current);
    return localPatch;
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
    const markPlayerDurationFound = () => setDurationLookupOutcomes((prev) => prev[id]?.status === 'found' && prev[id]?.provider === platform + '-player' ? prev : ({
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
    String(video.title || '') + ':' + getPlaybackGeneration(video) + ':' + String(video.durationSource || '') + ':' + String(video.durationSec || '') + ':' + String(video.duration || '') + ':' + String(video.classificationMetadata?.version || '')
  ).join('|');
  useEffect(() => {
    // Do not mark a cached row enriched before authentication and the first
    // authoritative snapshot: otherwise a local-only success can suppress the
    // guarded metadata write when the original cloud row arrives.
    if (!db || !firebaseUser || !cloudSynced) return undefined;
    const forceRetry = durationRefreshProcessedRef.current !== durationRefreshCount;
    durationRefreshProcessedRef.current = durationRefreshCount;
    const candidates = videosRef.current.filter((video) => {
      const id = String(video?.id || '');
      if (!id || durationEnrichmentInFlightRef.current.has(id) || !(videoNeedsMetadataLookup(video) || videoNeedsClassificationLookup(video))) return false;
      return shouldRetryDurationLookup(durationLookupOutcomes[getMetadataLookupKey(video)], Date.now(), forceRetry);
    }).sort((a, b) => (['playing', 'queue'].indexOf(a.status) < 0 ? 2 : ['playing', 'queue'].indexOf(a.status)) - (['playing', 'queue'].indexOf(b.status) < 0 ? 2 : ['playing', 'queue'].indexOf(b.status)) || Number(a.queueOrder ?? a.timestamp ?? 0) - Number(b.queueOrder ?? b.timestamp ?? 0)).slice(0, 160);
    if (!candidates.length) return undefined;

    const previousOutcomes = new Map(candidates.map((video) => [String(video.id), durationLookupOutcomes[getMetadataLookupKey(video)] || null]));
    const startedAt = Date.now();
    candidates.forEach((video) => durationEnrichmentInFlightRef.current.add(String(video.id)));
    setDurationLookupOutcomes((prev) => ({
      ...prev,
      ...Object.fromEntries(candidates.map((video) => {
        const id = String(video.id);
        return [getMetadataLookupKey(video), createDurationLookupOutcome({
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
          const lookupKey = getMetadataLookupKey(video);
          try {
            const response = await fetch('/api/media-metadata?url=' + encodeURIComponent(video.url), {
              credentials: 'same-origin',
              cache: 'no-store',
              signal: AbortSignal.timeout(9000)
            });
            const metadata = await response.json().catch(() => ({}));
            if (!response.ok) {
              setDurationLookupOutcomes((prev) => ({
                ...prev,
                [lookupKey]: createDurationLookupOutcome({
                  status: 'error', platform, previous: previousOutcomes.get(id),
                  reason: metadata?.error || ('Metadata endpoint returned HTTP ' + response.status + '.'),
                  at: Date.now(),
                })
              }));
              return;
            }
            if (video.platform === 'youtube' && video.status === 'queue' && videoNeedsDurationLookup(video) && !isValidMediaDuration(metadata?.durationSec)) {
              const seconds = await probeYouTubeDuration(video.videoId);
              if (seconds) Object.assign(metadata || {}, { durationSec: seconds, durationProvider: 'youtube-cued-player' });
            }
            const patch = await syncEnrichedMetadata(video, metadata);
            const current = videosRef.current.find((item) => String(item.id) === id);
            if (!current || getPlaybackGeneration(video) !== getPlaybackGeneration(current) || video.url !== current.url) return;
            if (Object.keys(patch).length) {
              if (patch.durationSec) cacheVideoDuration(current, patch.durationSec, 'metadata');
            }
            const complete = !videoNeedsMetadataLookup({ ...current, ...patch }) && !videoNeedsClassificationLookup({ ...current, ...patch });
            setDurationLookupOutcomes((prev) => ({
              ...prev,
              [lookupKey]: createDurationLookupOutcome({
                status: complete ? 'found' : 'unavailable', platform, previous: previousOutcomes.get(id),
                reason: videoNeedsTitleLookup({ ...current, ...patch }) ? 'The provider did not return a usable title.' : (metadata?.durationReason || 'The provider did not return a valid duration.'),
                provider: metadata?.durationProvider || '', at: Date.now(),
              })
            }));
          } catch (error) {
            const reason = error?.name === 'TimeoutError'
              ? 'Duration lookup timed out while contacting the metadata endpoint.'
              : String(error?.message || 'Network error during duration lookup.');
            setDurationLookupOutcomes((prev) => ({
              ...prev,
              [lookupKey]: createDurationLookupOutcome({
                status: 'error', platform, previous: previousOutcomes.get(id), reason, at: Date.now(),
              })
            }));
          } finally {
            durationEnrichmentInFlightRef.current.delete(id);
            const latest = videosRef.current.find((item) => String(item.id) === id);
            if (!latest || getPlaybackGeneration(latest) !== getPlaybackGeneration(video) || latest.url !== video.url) {
              // Queue -> playing changes the generation while duration-only
              // outcomes still share the document-id key. Retire this attempt
              // after unlocking so its pending/found state cannot strand the
              // new generation or suppress a fresh metadata request.
              setDurationLookupOutcomes((prev) => {
                const next = { ...prev };
                delete next[lookupKey];
                return next;
              });
              setMetadataRetryTick((tick) => tick + 1);
            }
          }
        }));
      }
    };
    void enrich();
    return undefined;
  }, [durationScanKey, channelRoom, durationRefreshCount, metadataRetryTick, durationLookupOutcomes, db, firebaseUser, cloudSynced]);

  // Retry failed duration lookups even when the dashboard stays open. Persisted retry times
  // let a reload resume a bounded backoff schedule rather than leaving failed entries stuck.
  useEffect(() => {
    const retryTimes = videos.filter((video) => (videoNeedsMetadataLookup(video) || videoNeedsClassificationLookup(video)) &&
        !durationEnrichmentInFlightRef.current.has(String(video.id)))
      .map((video) => durationLookupOutcomes[getMetadataLookupKey(video)])
      .filter((outcome) => ['unavailable', 'error'].includes(outcome?.status))
      .map((outcome) => Number(outcome.nextRetryAt) || 0)
      .filter((time) => time > Date.now())
      .sort((a, b) => a - b);
    if (!retryTimes.length) return undefined;
    const delay = Math.max(1000, Math.min(2_147_000_000, retryTimes[0] - Date.now()));
    const timer = window.setTimeout(() => setMetadataRetryTick((count) => count + 1), delay);
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
    if (!statisticsAccess || !activityCloudReadyRef.current || !event?.id ||
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
    if (moderatorLogin) {
      if (activityCloudReadyRef.current) void syncActivityEventToCloud(event);
    } else if (twitchAuth.authenticated && db && firebaseUser) {
      // The streamer may append validated playback events through Firebase
      // create-only rules independently of statistics loading or retries.
      void setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'queue_events', String(event.id)), event)
        .catch(error => console.warn('Playback event cloud append failed:', error?.code || error));
    }
    return event;
  };

  const flushPendingActivityEvents = () => {
    if (!statisticsAccess || !activityCloudReadyRef.current || !networkOnline) return;
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
    if (!statisticsAccess) return;
    const merged = mergeActivityEvents(activityEventsRef.current);
    activityEventsRef.current = merged;
    setActivityEvents(merged);
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
    const previousItem = videosRef.current.find(video => String(video.id) === String(localItem.id));
    videosRef.current = [localItem, ...videosRef.current.filter(video => String(video.id) !== String(localItem.id))];
    setVideos(videosRef.current);
    try {
      // Firestore rejects undefined values; missing duration metadata is normal.
      // JSON serialization drops undefined without changing the media identity.
      const documentData = JSON.parse(JSON.stringify({ ...localItem, createdAt: Date.now() }));
      const itemRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', String(localItem.id));
      await runTransaction(db, async transaction => {
        const snapshot = await transaction.get(itemRef);
        const existing = snapshot.exists() ? snapshot.data() : null;
        if (existing && existing.status !== 'watched') {
          throw Object.assign(new Error('already_queued'), { existingItem: existing });
        }
        if (existing) {
          const historyId = 'history-' + getStableMediaDocumentId(String(localItem.id) + '|' + String(existing.timestamp || existing.createdAt || 0));
          transaction.set(doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', historyId), { ...existing, id: historyId });
        }
        transaction.set(itemRef, documentData);
      });
      recordActivity('request_added', localItem, {
        source: String(localItem.note || '').toLowerCase().includes('twitch chat') ? 'twitch-chat' : 'dashboard'
      });
      return true;
    } catch (error) {
      const restore = error?.existingItem || previousItem;
      videosRef.current = videosRef.current.filter((video) => String(video.id) !== String(localItem.id));
      if (restore) videosRef.current = [...videosRef.current, restore];
      setVideos(videosRef.current);
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
    if (!statisticsAccess) {
      activityCloudReadyRef.current = false;
      activityCloudIdsRef.current = new Set();
      activityCursorRef.current = { at: 0, id: '' };
      setActivityCloudReady(false);
      return undefined;
    }

    let active = true;
    let loading = false;
    let nextAllowedFetchAt = 0;
    activityCloudReadyRef.current = false;
    setActivityCloudReady(false);
    const loadActivityEvents = async () => {
      if (!statisticsAccess || !active || loading || Date.now() < nextAllowedFetchAt ||
          (typeof navigator !== 'undefined' && !navigator.onLine)) return;
      loading = true;
      try {
        // Read at most 800 records per refresh. Subsequent refreshes only
        // fetch documents after the last seen at/id cursor, not lifetime data.
        for (let page = 0; page < 4 && active; page++) {
          const cursor = activityCursorRef.current;
          const params = new URLSearchParams({ appId });
          if (cursor.at > 0 && cursor.id) {
            params.set('afterAt', String(cursor.at));
            params.set('afterId', cursor.id);
          }
          const response = await fetch('/api/activity-log?' + params, {
            credentials: 'same-origin', cache: 'no-store',
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || !Array.isArray(result.events)) {
            if (result.code === 'firestore_quota_exceeded') {
              const retrySeconds = Number(response.headers.get('Retry-After'));
              nextAllowedFetchAt = Date.now() +
                (Number.isFinite(retrySeconds) && retrySeconds > 0
                  ? Math.max(3600, retrySeconds) : 3600) * 1000;
            } else {
              nextAllowedFetchAt = Date.now() + 5 * 60_000;
            }
            throw new Error(result.code || result.error || 'Activity log sync is unavailable');
          }
          if (!active) return;
          const cloudEvents = result.events.map(event => normalizeActivityEvent(event)).filter(Boolean);
          cloudEvents.forEach(event => activityCloudIdsRef.current.add(String(event.id)));
          const cutoff = Math.max(statisticsResetAtRef.current, Number(result.statisticsResetAt || 0));
          const merged = mergeActivityEvents(activityEventsRef.current, cloudEvents).filter(event => event.at > cutoff);
          activityEventsRef.current = merged;
          setActivityEvents(merged);
          const next = result.nextCursor;
          if (next && Number.isSafeInteger(next.at) && next.at > 0 &&
              /^[A-Za-z0-9_-]{1,140}$/.test(String(next.id || ''))) {
            activityCursorRef.current = { at: next.at, id: String(next.id) };
          } else if (result.hasMore) {
            throw new Error('Activity history pagination could not advance');
          }
          if (!result.hasMore) {
            activityCloudReadyRef.current = true;
            setActivityCloudReady(true);
            break;
          }
        }
        setActivitySyncError(false);
      } catch (error) {
        if (active) {
          if (!nextAllowedFetchAt) nextAllowedFetchAt = Date.now() + 5 * 60_000;
          console.warn('Incremental activity sync paused until retry window:', error);
          setActivitySyncError(true);
          // Do not lose successfully loaded cursor/history on a quota error.
        }
      } finally { loading = false; }
    };
    void loadActivityEvents();
    const interval = window.setInterval(loadActivityEvents, 120000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [twitchAuth.authenticated, statisticsAccess, appId, channelRoom, activityReconnectTick]);

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
      !existingIds.has(String(video.id)) && Number(video.timestamp || 0) > statisticsResetAtRef.current);
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
    if (moderatorLogin) {
      backup.activityEvents = activityEventsRef.current;
      backup.statisticsResetAt = statisticsResetAtRef.current;
    }
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

  const handleReset = async () => {
    if (!resetScope || resetBusy) return;
    setResetBusy(true);
    try {
      handleDownloadBackup();
      const result = await resetPrivateCloud(db, resetScope);
      if (result.statisticsResetAt) {
        statisticsResetAtRef.current = result.statisticsResetAt;
        setStatisticsResetAt(result.statisticsResetAt);
        activityEventsRef.current = activityEventsRef.current.filter(event => event.at > result.statisticsResetAt);
        setActivityEvents(activityEventsRef.current);
        activityCursorRef.current = { at: 0, id: '' };
        setActivityReconnectTick(tick => tick + 1);
      }
      setResetScope('');
      addToast('Reset saved to the shared cloud queue.', 'success');
    } catch (error) { addToast(error?.message || 'Reset failed; please retry.', 'warning'); }
    finally { setResetBusy(false); }
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

  const currentPlaybackGeneration = getPlaybackGeneration(currentVideo);
  useEffect(() => { failedPlaybackRef.current = ''; setPlayerIssue(null); }, [currentPlaybackGeneration]);

  const getPlaybackIntentForVideo = (videoId, platformOverride = '') => {
    const id = String(videoId || '');
    const matchingVideo = videosRef.current.find((video) => String(video.id) === id);
    const platform = platformOverride ||
      matchingVideo?.platform ||
      (String(currentVideoRef.current?.id || '') === id ? currentVideoRef.current?.platform : '');
    const isTikTok = platform === 'tiktok';
    const generation = getPlaybackGeneration(matchingVideo || currentVideoRef.current);
    const storageKey = roomStorageKey(channelRoom, 'player-playback-intent-v3-' + id);
    // Older builds accidentally saved autoplay mute as a deliberate preference.
    // Keep the old pause intent, but read TikTok audio preference from a clean separate key.
    const tiktokMuteStorageKey = isTikTok
      ? roomStorageKey(channelRoom, 'player-tiktok-mute-intent-v1-' + id)
      : '';
    const current = playbackIntentRef.current;
    if (current.videoId === id && current.generation === generation && current.storageKey === storageKey &&
        (!isTikTok || current.tiktokMuteStorageKey === tiktokMuteStorageKey) &&
        (isTikTok || !current.tiktokMuteStorageKey)) return current;

    let saved = null;
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      saved = raw ? JSON.parse(raw) : null;
    } catch { /* A blocked session store should not break player controls. */ }
    return {
      videoId: id,
      storageKey,
      tiktokMuteStorageKey,
      generation,
      paused: saved?.generation === generation && saved?.paused === true,
      seconds: saved?.generation === generation ? Math.max(0, Number(saved.seconds) || 0) : 0,
      muted: localMutedRef.current,
    };
  };

  const updatePlaybackIntent = (videoId, updates, platformOverride = '') => {
    const previous = getPlaybackIntentForVideo(videoId, platformOverride);
    if (Object.keys(updates).every(key => previous[key] === updates[key])) return previous;
    const next = { ...previous, ...updates, videoId: String(videoId || '') };
    playbackIntentRef.current = next;
    if (typeof updates.paused === 'boolean') setPlaybackPaused(next.paused);
    const positionOnly = Object.keys(updates).length === 1 && Object.hasOwn(updates, 'seconds');
    const lastWrite = playbackWriteRef.current;
    if (positionOnly && lastWrite.key === next.storageKey && Date.now() - lastWrite.at < 1000) return next;
    playbackWriteRef.current = { key: next.storageKey, at: Date.now() };
    try {
      // Keep TikTok preference separate so legacy autoplay mute cannot override startup audio.
      window.sessionStorage.setItem(next.storageKey, JSON.stringify({
        paused: next.paused,
        generation: next.generation,
        seconds: next.seconds || 0,
      }));
      if (typeof updates?.muted === 'boolean') setLocalMuted(updates.muted);
    } catch { /* Playback state remains available in memory if storage is unavailable. */ }
    return next;
  };

  // Keep precise position in refs, but avoid rerendering the whole queue for each provider tick.
  const updatePlaybackProgress = value => {
    const generation = getPlaybackGeneration(currentVideoRef.current);
    const previous = progressUpdateRef.current;
    if (previous.generation === generation && Date.now() - previous.at < 1000) return;
    progressUpdateRef.current = { generation, at: Date.now() };
    setSimProgress(value);
  };
  useEffect(() => {
    const flush = () => {
      const intent = playbackIntentRef.current;
      if (!intent.storageKey) return;
      try { sessionStorage.setItem(intent.storageKey, JSON.stringify({ paused: intent.paused, generation: intent.generation, seconds: intent.seconds || 0 })); } catch { /* Storage unavailable. */ }
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  const isPlaybackPaused = (videoId) => getPlaybackIntentForVideo(videoId).paused;

  // Keep the TikTok iframe URL stable for the lifetime of the current queue item.
  // Its autoplay query is only an initial-load setting; deriving it on every render
  // changes src when pause intent changes and makes React reload the embed mid-video.
  const youtubePlayerSrc = useMemo(() => currentVideo?.platform === 'youtube'
    ? 'https://www.youtube.com/embed/' + encodeURIComponent(currentVideo.videoId) + '?autoplay=' + (getPlaybackIntentForVideo(currentVideo.id).paused ? 0 : 1) + '&start=' + Math.floor(getPlaybackIntentForVideo(currentVideo.id).seconds || 0) + '&controls=1&playsinline=1&rel=0&enablejsapi=1&origin=' + encodeURIComponent(window.location.origin)
    : '', [currentPlaybackGeneration, currentVideo?.videoId, channelRoom, playerReload]);
  const tiktokPlayerSrc = useMemo(() => (
    currentVideo?.platform === 'tiktok'
      ? buildTikTokPlayerUrl(currentVideo.videoId, {
          paused: getPlaybackIntentForVideo(currentVideo.id, 'tiktok').paused,
        })
      : ''
  ), [currentPlaybackGeneration, currentVideo?.videoId, currentVideo?.platform, channelRoom, tiktokFrameReload]);

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
    const intent = getPlaybackIntentForVideo(id);
    if (intent.paused && intent.seconds > 0.5 && value < intent.seconds - 2) return;
    playbackPositionRef.current = { videoId: id, seconds: value };
    updatePlaybackIntent(id, { seconds: value });
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
    playbackPositionRef.current = { videoId, seconds: intent.seconds || 0 };
    setPlaybackPaused(intent.paused);
    if (intent.seconds > 0.5) pendingPlaybackRestoreRef.current = { videoId, currentTime: intent.seconds, expiresAt: Date.now() + 15000 };
    playbackVisibilitySnapshotRef.current = null;
    playbackRestoreGuardRef.current = intent.paused
      ? { videoId, until: Date.now() + 2500, paused: true, muted: intent.muted }
      : { videoId: '', until: 0, paused: false, muted: null };
    keyboardPausedRef.current = { videoId, paused: intent.paused };
  }, [currentPlaybackGeneration, currentVideo?.platform, channelRoom]);

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
      const expiresAt = Date.now() + 15000;
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
  }, [currentPlaybackGeneration, currentVideo?.platform, channelRoom]);

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
  }), [videos, categoryCorrections]);

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

  useEffect(() => {
    if (navigator.connection?.saveData) return;
    return prepareNextConnections(nextQueuedVideo, document);
  }, [nextQueuedVideo?.id, nextQueuedVideo?.platform]);

  const categoryCounts = useMemo(
    () => buildCategoryCounts(videos, activeTab, mediaTypeFilter, getVideoCategory, getVideoMediaType),
    [videos, activeTab, mediaTypeFilter, categoryCorrections]
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
    [videos, activeTab, selectedCategory, mediaTypeFilter, searchQuery, sortBy, categoryCorrections]
  );


  const isStaff = twitchAuth.authenticated && (twitchAuth.role === 'streamer' || twitchAuth.role === 'moderator');
  const isModerator = moderatorLogin;
  const healthWarnings = isModerator ? queueHealthWarnings(webhookHealth, { online: networkOnline, cloudSynced }) : [];


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
          const links = extractChatMediaUrls(text);
          const requests = links.length > 0 ? links : [text];
          // Process each distinct URL from ordinary viewers independently, with no
          // per-viewer cooldown. Moderators do not get special request privileges.
          for (const requestText of requests) {
            void Promise.resolve(handleIncomingChatCommandRef.current?.(voterLogin || username, role, requestText))
              .catch(error => {
                console.warn('Twitch viewer request handling failed:', error?.message || error);
                setChatBridgeStatus('Chat request handler failed; see console');
              });
          }
        } else if (lowerText === '!remove' || lowerText === '!unrequest') {
          handleRemoveOwnRequestRef.current?.(voterLogin || username);
        } else if (lowerText === '!queue') {
          handleQueueSummaryRef.current?.(voterLogin || username);
        } else if (/^!bigcock(?:\s+\d+)?$/.test(lowerText)) {
          handleVoteCommandRef.current?.(voterLogin || usernameKey, lowerText);
        } else if (lowerText === '!help') {
          sendTwitchChatReply('!assr <URL/title> request · !remove remove your latest waiting request · !when your spot/ETA · !queue queue status.');
          sendTwitchChatReply('!promote [#] next up (50 points per position crossed). !unpromote [#] refunds the payer before playback. !bigcock [#] upvote (not your own; one vote/video). !skip your own playing request. Mods: !skip any video, !volume up/down/0-100, !mute, !unmute.');
        } else if (['!position', '!when', '!myqueue', '!queueposition'].includes(lowerText)) {
          handleQueuePositionRef.current?.(voterLogin || usernameKey);
        } else if (lowerText === '!skip' && maySkipCurrentRequest(incoming, currentVideoRef.current)) {
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

  // Twitch intake is now persisted by an EventSub HTTPS webhook. Deliberately
  // DO NOT start an authenticated browser WebSocket: moderator dashboards may
  // close, and two concurrent listeners would race to add duplicate requests.
  useEffect(() => {
    shouldReconnectIrcRef.current = false;
    disconnectTwitchIrc(false);
  }, []);

  // Refresh only the moderator's server-verified webhook/Firestore status.
  useEffect(() => {
    if (!moderatorLogin) {
      setWebhookHealth(previous => ({
        ...previous, loading: false, active: false, code: 'moderator_only',
      }));
      return undefined;
    }
    let alive = true;
    const refresh = async () => {
      try {
        const response = await fetch('/api/twitch/bot-session?action=webhook-status', {
          credentials: 'same-origin', cache: 'no-store',
          signal: AbortSignal.timeout(15000),
        });
        const data = await response.json().catch(() => ({}));
        if (alive) setWebhookHealth({
          loading: false, active: response.ok && data.active === true,
          code: String(data.code || response.status), status: String(data.status || ''),
          lastWebhookAt: Number(data.lastWebhookAt) || 0,
          lastWebhookResult: String(data.lastWebhookResult || 'none'),
          lastWebhookQueued: Number(data.lastWebhookQueued) || 0,
          lastQueueWriteAt: Number(data.lastQueueWriteAt) || 0,
          lastReplySentAt: Number(data.lastReplySentAt) || 0,
          receiptCode: String(data.receiptCode || 'unknown'),
        });
      } catch {
        if (alive) setWebhookHealth(previous => ({
          ...previous, loading: false, active: false, code: 'status_unavailable',
        }));
      }
    };
    void refresh();
    const id = window.setInterval(refresh, 60000);
    return () => { alive = false; window.clearInterval(id); };
  }, [moderatorLogin]);

  const activateTwitchWebhook = async ({ automatic = false, repair = false } = {}) => {
    if (!moderatorLogin || webhookSetupBusy) return;
    setWebhookSetupBusy(true);
    try {
      const response = await fetch('/api/twitch/bot-session?action=webhook-setup' + (repair ? '&repair=1' : ''), {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(20000),
      });
      const data = await response.json().catch(() => ({}));
      setWebhookHealth(previous => ({
        ...previous, loading: false, active: response.ok && data.active === true,
        code: String(data.code || response.status), status: String(data.status || ''),
        lastWebhookAt: Number(data.lastWebhookAt) || previous.lastWebhookAt,
        lastWebhookResult: String(data.lastWebhookResult || previous.lastWebhookResult),
        lastWebhookQueued: Number(data.lastWebhookQueued) || 0,
        lastQueueWriteAt: Number(data.lastQueueWriteAt) || 0,
        lastReplySentAt: Number(data.lastReplySentAt) || 0,
        receiptCode: String(data.receiptCode || previous.receiptCode || 'unknown'),
      }));
      if (!automatic || !response.ok) {
        addToast(response.ok
          ? (data.active ? 'Twitch chat intake is active.' : repair ? 'Twitch is verifying the repaired webhook.' : 'Twitch is verifying the chat webhook.')
          : 'Webhook setup failed: ' + String(data.code || response.status) +
            (data.code === 'moderator_chat_scopes_missing' ? ' — authorize moderator chat intake first.' : ''),
          response.ok ? 'success' : 'warning');
      }
    } catch {
      setWebhookHealth(previous => ({ ...previous, code: 'setup_network_error', active: false }));
      addToast('Could not reach the server-side Twitch webhook setup.', 'warning');
    } finally { setWebhookSetupBusy(false); }
  };

  // A moderator who already granted chat scopes should not need a manual
  // activation step after every deploy. Twitch EventSub still enforces its
  // own grant/moderator checks; never auto-authorize OAuth scopes.
  useEffect(() => {
    if (!moderatorLogin) {
      webhookAutoSetupAttemptedRef.current = false;
      return;
    }
    if (webhookHealth.loading || webhookHealth.code !== 'webhook_not_subscribed' ||
        webhookAutoSetupAttemptedRef.current || webhookSetupBusy) return;
    webhookAutoSetupAttemptedRef.current = true;
    void activateTwitchWebhook({ automatic: true });
  }, [moderatorLogin, webhookHealth.loading, webhookHealth.code, webhookSetupBusy]);

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
      return;
    }
    if (!queueOpenRef.current) {
      return;
    }

    const looksLikeUrl = extractChatMediaUrls(requestText).length > 0;
    let url = looksLikeUrl ? extractChatMediaUrls(requestText)[0] : requestText;
    let title = '';
    if (!looksLikeUrl) {
      try {
        const response = await fetch(`/api/search-youtube?q=${encodeURIComponent(requestText.slice(0, 180))}`, { credentials: 'same-origin' });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(result.results) || !result.results.length) {
          return;
        }
        url = result.results[0].url;
        title = result.results[0].title || '';
      } catch (error) {
        console.warn('Chat title search failed:', error);
        return;
      }
    }
    if (!queueOpenRef.current) {
      return;
    }
    // Media requests remain quiet; failures belong in the moderator dashboard.
    await processAndQueueRequest({
      url, title, requestedBy: username, userRole: role,
      note: '', manualCategory: null, fromChat: true
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

    // Completed history never prevents a new request for that media.
    const identityKey = getMediaIdentityKey(parsed.platform, parsed.videoId, normalizedUrl);
    const alreadyExists = videosRef.current.some((video) =>
      video.status !== 'watched' &&
      getMediaIdentityKey(video?.platform, video?.videoId, video?.url) === identityKey
    );
    const requestAlreadyPending = pendingMediaRequestKeysRef.current.has(identityKey);
    if (alreadyExists || requestAlreadyPending) {
      addToast('That video is already queued or playing.', 'warning');
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
    const finalCategory = getVideoCategory({ url: normalizedUrl, title: cleanTitle, note, category: detectedCategory, categoryManuallySet });
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
      note: note || (fromChat ? '' : `Added to ${channelRoom} deck`),
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
      if (fromChat) {
        setChatBridgeStatus('Chat request received; Firestore queue write failed');
      }
      addToast('Request could not be saved to the shared queue.', 'warning');
      return false;
    }
    if (fromChat) setChatBridgeLastRequestAt(Date.now());

    if (deferredMetadataPromise && !resolvedDurationSec) {
      const newVideoId = String(newVideo.id);
      const previousLookup = durationLookupOutcomes[newVideoId] || null;
      void deferredMetadataPromise.then(async (metadata) => {
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
        if (!current || getPlaybackGeneration(newVideo) !== getPlaybackGeneration(current) || newVideo.url !== current.url) return;
        const patch = await syncEnrichedMetadata(newVideo, metadata);
        if (patch.durationSec) cacheVideoDuration(current, patch.durationSec, 'metadata');
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
        const latest = videosRef.current.find((video) => String(video.id) === newVideoId);
        if (!latest || getPlaybackGeneration(latest) !== getPlaybackGeneration(newVideo) || latest.url !== newVideo.url) {
          setDurationLookupOutcomes((prev) => {
            const next = { ...prev };
            delete next[newVideoId];
            return next;
          });
        }
        // Release the lock before waking the normal enrichment scanner, including
        // when a submitted request started playing during this deferred lookup.
        setMetadataRetryTick((tick) => tick + 1);
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
      if (doc.fullscreenElement === fullscreenContainerRef.current) return;
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

  const handleShuffleQueue = async (operation = 'shuffle') => {
    if (!isStaff || !db?.privateCloud || shuffleInFlightRef.current) return;
    if (!Number.isSafeInteger(db.version) || db.version < 0) {
      addToast('Wait for the queue to finish syncing before shuffling.', 'warning');
      return;
    }
    shuffleInFlightRef.current = true;
    setShuffleBusy(true);
    try {
      const response = await fetch('/api/twitch/session?action=store', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, expectedVersion: db.version }),
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 409) {
        await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'queue_videos'));
        addToast('The queue changed. It is refreshed; try Shuffle again.', 'warning');
        return;
      }
      if (!response.ok || result.ok !== true) throw new Error('Queue could not be shuffled.');
      await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'queue_videos'));
      addToast(operation === 'unshuffle' ? 'Original queue order restored. Pinned positions are preserved.' : 'Waiting queue shuffled. Pinned positions are preserved.', 'success');
    } catch (error) {
      addToast(error?.message || 'Queue could not be shuffled.', 'warning');
    } finally {
      shuffleInFlightRef.current = false;
      setShuffleBusy(false);
    }
  };

  // Keep audio commands in the saved browser preference shared by YouTube and native Twitch.
  const handleVolumeCommand = (volumeCommand, role) => {
    if (!isStaffRole(role) || !volumeCommand) return;
    const { action } = volumeCommand;
    if (!['set', 'up', 'down', 'mute', 'unmute'].includes(action)) return;
    if (action === 'set' && !Number.isFinite(volumeCommand.value)) return;
    const next = action === 'set' ? Math.max(0, Math.min(100, volumeCommand.value))
      : action === 'up' ? Math.min(100, localVolumeRef.current + 10)
      : action === 'down' ? Math.max(0, localVolumeRef.current - 10) : localVolumeRef.current;
    const muted = action === 'mute' ? true : action === 'unmute' ? false : next === 0;
    localVolumeRef.current = next;
    localMutedRef.current = muted;
    setLocalVolume(next);
    setLocalMuted(muted);
    if (currentVideo) updatePlaybackIntent(currentVideo.id, { muted }, currentVideo.platform);
    if (currentVideo?.platform === 'youtube') {
      const player = youtubePlayerRef.current;
      player?.setVolume?.(next);
      if (muted) player?.mute?.(); else player?.unMute?.();
      const frame = youtubeIframeRef.current?.contentWindow;
      const send = (func, args = []) => frame?.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube.com');
      send('setVolume', [next]);
      send(muted ? 'mute' : 'unMute');
      youtubePlaybackInfoRef.current = { ...youtubePlaybackInfoRef.current, volume: next, muted };
    }
    if (currentVideo?.platform === 'tiktok') {
      tiktokMutePreferenceRef.current = { requestId: currentVideo.id, preference: muted ? 'muted' : 'unmuted' };
      tiktokAudioStateRef.current = { requestId: currentVideo.id, muted };
      const frame = tiktokIframeRef.current?.contentWindow;
      if (frame) postTikTokPlayerCommand(frame, muted ? 'mute' : 'unMute', null);
      if (action === 'up' || action === 'down' || (action === 'set' && next !== 0 && next !== 100)) {
        addToast('Volume saved for YouTube and Twitch. Use the TikTok player slider for exact TikTok volume.', 'info');
      }
    }
  };

  const handlePreviousTrack = () => {
    exitTikTokFullscreenBeforeTrackChange();
    const latestVideos = videosRef.current || videos;
    const outgoing = currentVideoRef.current ||
      latestVideos.find((video) => video.status === 'playing') ||
      latestVideos.filter((video) => video.status === 'queue').sort(compareQueueOrder)[0] ||
      null;
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
    if (!playing || String(playing.id) !== String(videoId) || failedPlaybackRef.current === getPlaybackGeneration(playing)) return;
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
      if (!getPlaybackIntentForVideo(video.id).paused && (state === 1 || state === 3)) {
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
      const key = String(event.key || '').toLowerCase();
      const isTyping = target instanceof HTMLElement && (
        target.isContentEditable ||
        target.closest('input, textarea, select, video, audio, iframe, [contenteditable="true"]') ||
        ([' ', 'enter'].includes(key) && target.closest('button, a, [role="button"]'))
      );
      if (isTyping || showAuthModal || showSettingsModal || showRequestModal || topMenuOpen || resetScope) return;
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
  }, [currentVideo?.id, isStaff, showAuthModal, showSettingsModal, showRequestModal, tiktokPlayerState.status, topMenuOpen, resetScope]);

  // Use a normal React-owned YouTube iframe. The iframe document is cross-origin, so
  // playback control stays isolated from React's DOM reconciliation (no YT.Player node replacement).
  useEffect(() => {
    const video = currentVideo;
    const iframe = youtubeIframeRef.current;
    if (!video || video.platform !== 'youtube' || !video.videoId || !iframe) {
      youtubePlayerRef.current = null;
      youtubePlaybackInfoRef.current = { currentTime: 0, duration: 0, volume: 50, muted: false, playerState: -1 };
      return undefined;
    }

    const playerWindow = iframe.contentWindow;
    if (!playerWindow) return undefined;
    let cancelled = false;
    const errorRetryTimers = [];
    if (youtubeRecoveryRef.current.generation !== getPlaybackGeneration(video)) youtubeRecoveryRef.current = { generation: getPlaybackGeneration(video), attempts: 0 };
    let hasStarted = false;
    let apiReady = false;
    setYouTubeAutoplayBlocked(false);
    const savedPosition = getPlaybackIntentForVideo(video.id).seconds || 0;
    let volumeAcknowledged = false;
    const completion = createPlaybackCompletionTracker();
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
      if (cancelled || youtubeIframeRef.current !== iframe || failedPlaybackRef.current === getPlaybackGeneration(video)) return;
      // The raw iframe API emits playerState/time info after the parent announces a listener.
      try {
        playerWindow.postMessage(JSON.stringify({ event: 'listening', id: `yedi-hub-${video.id}`, channel: 'widget' }), 'https://www.youtube.com');
      } catch { /* Player may still be initializing; the next retry will announce again. */ }
      postCommand('addEventListener', ['onStateChange']);
      postCommand('addEventListener', ['onError']);
      postCommand('addEventListener', ['onAutoplayBlocked']);
      postCommand('getCurrentTime');
      postCommand('getDuration');
      postCommand('getVolume');
      // Retrying a startup Play after a short clip ends replays it. Once started,
      // leave transport and position entirely to the provider and viewer.
      if (hasStarted || completion.completed) return;
      const intent = getPlaybackIntentForVideo(video.id);
      const pending = pendingPlaybackRestoreRef.current;
      const known = playbackPositionRef.current.videoId === String(video.id) ? playbackPositionRef.current.seconds : 0;
      const restoreSeconds = pending?.videoId === String(video.id) && Date.now() < pending.expiresAt
        ? pending.currentTime
        : Math.max(known, !hasStarted ? savedPosition : 0);
      // Leave a saved paused request cued. pauseVideo/seekTo before first playback
      // can discard YouTube's poster without decoding a replacement video frame.
      // The initial start parameter restores its position without starting media.
      if (!intent.paused && restoreSeconds > 0.5 && Math.abs((Number(youtubePlaybackInfoRef.current.currentTime) || 0) - restoreSeconds) > 2) {
        postCommand('seekTo', [restoreSeconds, true]);
      }
      postCommand('setVolume', [localVolumeRef.current]);
      if (localMutedRef.current) postCommand('mute');
      else postCommand('unMute');
      if (!intent.paused && document.visibilityState !== 'hidden') postCommand('playVideo');
    };
    const handleMessage = (event) => {
      if (cancelled || event.source !== playerWindow || getPlaybackGeneration(currentVideoRef.current) !== getPlaybackGeneration(video)) return;
      if (event.origin !== 'https://www.youtube.com' && event.origin !== 'https://www.youtube-nocookie.com') return;
      let payload = event.data;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { return; }
      }
      if (!payload || typeof payload !== 'object') return;

      const info = ['infoDelivery', 'initialDelivery'].includes(payload.event) && payload.info && typeof payload.info === 'object'
        ? payload.info
        : null;
      const stateFromEvent = payload.event === 'onStateChange' ? Number(payload.info) : Number(info?.playerState);
      if (payload.event === 'onReady' || info && Number(info.duration) > 0) apiReady = true;
      if (payload.event === 'onReady') initializePlayerMessaging();
      if (payload.event === 'onAutoplayBlocked' && !getPlaybackIntentForVideo(video.id).paused) setYouTubeAutoplayBlocked(true);
      if (info) {
        if (Number(info.volume) === localVolumeRef.current) volumeAcknowledged = true;
        youtubePlaybackInfoRef.current = { ...youtubePlaybackInfoRef.current, ...info };
        if (volumeAcknowledged && hasStarted && Number.isFinite(Number(info.volume)) && Number(info.volume) >= 0 &&
            Number(info.volume) <= 100 && Math.abs(Number(info.volume) - localVolumeRef.current) > 1) {
          setLocalVolume(Number(info.volume));
        }
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
          if (Number.isFinite(now)) updatePlaybackProgress(Math.min(100, Math.max(0, (now / duration) * 100)));
        }
      }
      if (Number.isFinite(stateFromEvent)) {
        youtubePlaybackInfoRef.current.playerState = stateFromEvent;
        const videoId = String(video.id);
        const intent = getPlaybackIntentForVideo(videoId);
        const restoreGuard = playbackRestoreGuardRef.current;
        const suppressUnexpectedResume = stateFromEvent === 1 && intent.paused &&
          document.activeElement !== iframe && restoreGuard.videoId === videoId &&
          restoreGuard.paused && Date.now() < restoreGuard.until;
        if (stateFromEvent === 2 && (hasStarted || intent.paused)) {
          // Providers can report a synthetic pause when the browser backgrounds an iframe.
          // Do not persist that as the viewer's deliberate pause preference.
          if (document.visibilityState !== 'hidden') {
            updatePlaybackIntent(videoId, { paused: true });
            keyboardPausedRef.current = { videoId, paused: true };
          }
        } else if (stateFromEvent === 1 && suppressUnexpectedResume) {
          // Guard restoration only. A focused player's own Play control is an
          // explicit resume and must never be locked out by the saved pause.
          postCommand('pauseVideo');
        } else if (stateFromEvent === 1) {
          playbackRestoreGuardRef.current = { videoId: '', until: 0, paused: false, muted: null };
          updatePlaybackIntent(videoId, { paused: false });
          keyboardPausedRef.current = { videoId, paused: false };
        }
        if (stateFromEvent === 1 && !suppressUnexpectedResume) { hasStarted = true; setYouTubeAutoplayBlocked(false); }
      }
      if (completion.observe({ state: stateFromEvent, currentTime: info?.currentTime,
        duration: info?.duration, paused: getPlaybackIntentForVideo(video.id).paused })) {
        handleMediaEndedRef.current?.(video.id);
      }
      if (payload.event === 'onError') {
        console.warn('YouTube embed reported playback error:', payload.info);
        if (currentVideoRef.current?.id === video.id) {
          if (Number(payload.info) === 5 && !hasStarted && youtubeRecoveryRef.current.attempts < 1) {
            youtubeRecoveryRef.current.attempts++;
            errorRetryTimers.push(window.setTimeout(() => { if (!cancelled && getPlaybackGeneration(currentVideoRef.current) === getPlaybackGeneration(video)) setPlayerReload(value => value + 1); }, 500));
            return;
          }
          reportPlayerIssue({ generation: getPlaybackGeneration(video), message: playbackFailureMessage('youtube', payload.info), code: String(payload.info) });
        }
      }
    };

    window.addEventListener('message', handleMessage);
    // The iframe can ignore commands sent before its API is ready, so retry briefly after mount.
    const retryTimers = [0, 250, 750, 1500].map((delay) => window.setTimeout(initializePlayerMessaging, delay));
    iframe.addEventListener('load', initializePlayerMessaging);
    // A cold provider frame can become ready well after the initial quick retries.
    // Continue only until it answers; never replay a started or deliberately paused track.
    const handshake = window.setInterval(() => { if (!apiReady && !hasStarted) initializePlayerMessaging(); }, 1000);
    const startupTimeout = window.setTimeout(() => {
      window.clearInterval(handshake);
      if (!cancelled && !apiReady && !hasStarted && getPlaybackGeneration(currentVideoRef.current) === getPlaybackGeneration(video)) reportPlayerIssue({ generation: getPlaybackGeneration(video) });
    }, 20000);
    return () => {
      cancelled = true;
      iframe.removeEventListener('load', initializePlayerMessaging);
      window.clearInterval(handshake); window.clearTimeout(startupTimeout);
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      errorRetryTimers.forEach(timer => window.clearTimeout(timer));
      window.removeEventListener('message', handleMessage);
      if (youtubePlayerRef.current === proxy) youtubePlayerRef.current = null;
    };
  }, [currentPlaybackGeneration, currentVideo?.videoId, currentVideo?.platform, twitchAuth.authenticated, twitchAuthLoading, playerReload]);

  // TikTok uses one keyed official player iframe per queue item. A new request gets a fresh
  // window reference and listener. Its first muted report can be an autoplay/browser state,
  // not a user's preference, so do not persist it until startup unmute is acknowledged.
  useEffect(() => {
    const video = currentVideo;
    if (!video || video.platform !== 'tiktok' || !video.videoId || !twitchAuth.authenticated || twitchAuthLoading) return undefined;
    let cancelled = false;
    let startupUnmuteAttempts = 0;
    let startupAudioConfirmed = false;
    let playbackConfirmed = false;
    let recoveryScheduled = false;
    const generation = getPlaybackGeneration(video);
    if (tiktokRecoveryRef.current.generation !== generation) tiktokRecoveryRef.current = { generation, attempts: 0 };
    const completion = createPlaybackCompletionTracker();
    let providerReady = false;
    let startupMuteGuardUntil = 0;
    const retryTimers = [];
    const recoverStartup = () => {
      if (cancelled || failedPlaybackRef.current === generation || (playbackConfirmed && getPlaybackIntentForVideo(video.id, 'tiktok').seconds > 0.5) || getPlaybackGeneration(currentVideoRef.current) !== generation) return false;
      if (recoveryScheduled) return true;
      if (tiktokRecoveryRef.current.attempts >= 2) return false;
      recoveryScheduled = true;
      tiktokRecoveryRef.current.attempts += 1;
      setTikTokPlayerState({ requestId: video.id, status: 'loading' });
      retryTimers.push(window.setTimeout(() => {
        if (!cancelled && (!playbackConfirmed || getPlaybackIntentForVideo(video.id, 'tiktok').seconds <= 0.5) && getPlaybackGeneration(currentVideoRef.current) === generation) setTikTokFrameReload(attempt => attempt + 1);
      }, 750 * tiktokRecoveryRef.current.attempts));
      return true;
    };
    const playerWindow = tiktokIframeRef.current?.contentWindow;
    const getWindow = () => playerWindow;
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
      if (!cancelled && failedPlaybackRef.current !== generation && targetWindow && targetWindow === getWindow()) {
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
      if (cancelled || event.origin !== 'https://www.tiktok.com' || event.source !== getWindow() || getPlaybackGeneration(currentVideoRef.current) !== getPlaybackGeneration(video)) return;
      let data = event.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
      if (!data || data['x-tiktok-player'] !== true) return;
      if (data.type === 'onPlayerReady') {
        providerReady = true;
        retryTimers.forEach(timer => window.clearTimeout(timer));
        if (playbackConfirmed || completion.completed) return;
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
        if (!intent.paused && !deferPlaybackUntilVisible) {
          sendCommand('play');
          // TikTok may be buffering when its ready signal arrives. Retries are
          // strictly bounded and stop as soon as playback is confirmed.
          [450, 1200, 2300].forEach(delay => retryTimers.push(window.setTimeout(() => {
            if (cancelled || playbackConfirmed || completion.completed || getPlaybackGeneration(currentVideoRef.current) !== getPlaybackGeneration(video) ||
                getPlaybackIntentForVideo(video.id, 'tiktok').paused || document.visibilityState === 'hidden') return;
            sendCommand('play');
            if (delay === 2300 && !playbackConfirmed) {
              setTikTokPlayerState({ requestId: video.id, status: 'blocked' });
            }
          }, delay)));
        }
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
      } else if (data.type === 'onVolumeChange' && playbackConfirmed && Number.isFinite(Number(data.value))) {
        setLocalVolume(Math.max(0, Math.min(100, Number(data.value))));
      } else if (data.type === 'onCurrentTime' && data.value) {
        const duration = Number(data.value.duration) || 0;
        const currentTime = Number(data.value.currentTime) || 0;
        if (currentVideoRef.current?.id === video.id) recordPlaybackPosition(video.id, currentTime);
        if (duration > 0) {
          if (currentVideoRef.current?.id === video.id) {
            playbackDurationRef.current = { videoId: String(video.id), seconds: duration };
            reportPlayerDuration(video.id, duration);
          }
          updatePlaybackProgress(Math.min(100, Math.max(0, (currentTime / duration) * 100)));
        }
        if (completion.observe({ currentTime, duration, paused: getPlaybackIntentForVideo(video.id, 'tiktok').paused })) {
          handleMediaEndedRef.current?.(video.id);
        }
      } else if (data.type === 'onStateChange') {
        const state = Number(data.value);
        const videoId = String(video.id);
        const intent = getPlaybackIntentForVideo(videoId, 'tiktok');
        const restoreGuard = playbackRestoreGuardRef.current;
        const suppressUnexpectedResume = state === 1 && intent.paused &&
          document.activeElement !== tiktokIframeRef.current && restoreGuard.videoId === videoId &&
          restoreGuard.paused && Date.now() < restoreGuard.until;
        if (state === 2 && (playbackConfirmed || intent.paused || document.activeElement === tiktokIframeRef.current)) {
          if (document.visibilityState !== 'hidden') {
            updatePlaybackIntent(videoId, { paused: true }, 'tiktok');
            keyboardPausedRef.current = { videoId, paused: true };
          }
        } else if (state === 1 && suppressUnexpectedResume) {
          sendCommand('pause');
        } else if (state === 1) {
          playbackRestoreGuardRef.current = { videoId: '', until: 0, paused: false, muted: null };
          playbackConfirmed = true;
          if (currentVideoRef.current?.id === video.id) {
            setTikTokPlayerState({ requestId: video.id, status: 'playing' });
          }
          updatePlaybackIntent(videoId, { paused: false }, 'tiktok');
          keyboardPausedRef.current = { videoId, paused: false };
        }
        // Retry host unmute once playback actually starts; only an explicit mute choice wins.
        if (state === 1 && !suppressUnexpectedResume && !startupAudioConfirmed) {
          requestStartupUnmute();
        }
        if (completion.observe({ state, paused: getPlaybackIntentForVideo(video.id, 'tiktok').paused })) {
          handleMediaEndedRef.current?.(video.id);
        }
      } else if (data.type === 'onPlayerError' || data.type === 'onError') {
        const errorType = data.value?.errorType || (data.type === 'onError' ? ({ 2: 'SERVER_ERROR', 3: 'PLAYBACK_ERROR', 4: 'INVALID_VIDEO' }[Number(data.value)]) : ({ 1001: 'INVALID_VIDEO', 2001: 'SERVER_ERROR', 3001: 'PLAYBACK_ERROR', 3002: 'AUTOPLAY_ERROR' }[Number(data.value?.errorCode)])) || 'playback error';
        if (String(errorType) === 'AUTOPLAY_ERROR') {
          setTikTokPlayerState({ requestId: video.id, status: 'blocked' });
        } else {
          if (['SERVER_ERROR', 'PLAYBACK_ERROR'].includes(String(errorType)) && recoverStartup()) return;
          setTikTokPlayerState({ requestId: video.id, status: 'error' });
          reportPlayerIssue({ generation, code: String(errorType) });
          addToast('TikTok could not play this post (' + errorType + '). Try a public full video URL.', 'warning');
        }
      }
    };
    window.addEventListener('message', handleTikTokMessage);
    retryTimers.push(window.setTimeout(() => {
      if (!cancelled && !providerReady && !recoverStartup()) { setTikTokPlayerState({ requestId: video.id, status: 'error' }); reportPlayerIssue({ generation }); }
    }, 12000));
    return () => {
      cancelled = true;
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener('message', handleTikTokMessage);
    };
  }, [currentPlaybackGeneration, currentVideo?.videoId, currentVideo?.platform, tiktokFrameReload, twitchAuth.authenticated, twitchAuthLoading]);




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

  const handleCategoryChange = async (videoId, newCategory) => {
    const video = videosRef.current.find(item => item.id === videoId);
    if (!video || !db?.privateCloud) return;
    try {
      const response = await fetch('/api/twitch/session?action=store', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({operation:'learn-category',id:videoId,generation:getPlaybackGeneration(video),category:newCategory}),signal:AbortSignal.timeout(12000)});
      const body = await response.json().catch(()=>({}));
      if (!response.ok || !body.ok) throw Error('Category could not be saved. Refresh the queue and try again.');
      setCategoryCorrections(body.categoryCorrections || []);
      await getDocs(collection(db,'artifacts',appId,'public','data','queue_videos'));
      addToast('Category saved and remembered for matching videos and numbered episodes.', 'success');
    } catch(error) { addToast(error.message || 'Category could not be saved.', 'warning'); }
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
    const safeMessage = String(message || '').trim();
    if (!safeMessage) return;
    if ([...safeMessage].length > 450) throw new RangeError('Twitch chat replies must be at most 450 characters.');

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

  consumeChatCommandFeedRef.current = (feed) => consumeChatCommandFeed(feed, {
    login: normalizeTwitchLogin(twitchAuth.username), authenticated: twitchAuth.authenticated,
    connected: chatBotSession.connected, loaded: audioLoadedFor === normalizeTwitchLogin(twitchAuth.username),
    seen: chatCommandSeenRef.current, storage: sessionStorage,
    claim: async (id, kind) => {
      const response = await fetch('/api/twitch/session?action=store', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'claim-chat-command', id, kind }),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true || typeof result.claimed !== 'boolean') throw new Error(result.error || 'Command claim failed');
      return result.claimed;
    },
    audio: (command) => handleVolumeCommandRef.current?.(command, 'streamer'), reply: sendTwitchChatReply,
    error: (failure) => { console.warn('Webhook command could not be applied.', failure); addToast('Chat command could not be applied. Dashboard will retry on the next update.', 'warning'); },
  });
  useEffect(() => { consumeChatCommandFeedRef.current?.(latestChatCommandFeedRef.current); },
    [twitchAuth.authenticated, twitchAuth.username, chatBotSession.connected, audioLoadedFor]);

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

    if (playing && owned(playing)) messages.push('one request is playing now' + (promotionLabel(playing) ? ' ['+promotionLabel(playing)+']' : ''));

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
      messages.push(`#${position} "${String(video.title || video.platform || 'video').slice(0, 38)}" (ETA ${formatQueueWait(etaById.get(video.id))})${promotionLabel(video) ? ' ['+promotionLabel(video)+']' : ''}`);
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
      '#' + (index + 1) + ' ' + String(video.title || 'Untitled').slice(0, 26) + (promotionLabel(video) ? ' ['+promotionLabel(video)+']' : '')
    );
    const myCount = queued.filter((video) => normalizeTwitchLogin(video.requestedBy) === requester).length;
    const playingText = playing ? 'Now: "' + String(playing.title || 'Untitled').slice(0, 32) + '"' + (promotionLabel(playing) ? ' ['+promotionLabel(playing)+']' : '') : 'Nothing playing';
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
          <p className="mt-5 text-[10px] leading-5 text-slate-500">Other accounts cannot sign in. Access is limited to the channel team.</p>
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
              </div>

              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[11px] text-slate-400 font-medium">twitch.tv/</span>
                <span className="text-[11px] font-black text-purple-300">2o3a</span>
                <span className="px-1.5 py-0.5 rounded bg-amber-400/10 border border-amber-300/20 text-[8px] font-black tracking-wider text-amber-200">PRIVATE</span>
              </div>
            </div>
          </div>

          {/* Sync & Mode Badges */}
          {isModerator ? <button
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
          </button> : <span className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-bold text-slate-200">Requests {streamSettings.queueOpen ? 'open' : 'closed'}</span>}


          <div className="flex items-center gap-2">
            <a href="/queue" target="_blank" rel="noopener noreferrer" title="Open the public read-only queue"
              className="flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-xs font-bold text-slate-200 hover:bg-slate-800">
              <ExternalLink className="h-4 w-4" />Public queue
            </a>
          </div>

          {/* Additional top-bar actions. */}
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
                {isModerator && (
                  <button type="button" onClick={() => { setTopMenuOpen(false); setShowSettingsModal(true); }} className="mt-2 flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left text-xs font-bold text-slate-100 transition hover:border-purple-500/20 hover:bg-purple-500/10">
                    <Settings className="h-4 w-4 text-cyan-300" />
                    <span className="flex-1">Settings <span className="mt-0.5 block text-[10px] font-medium text-slate-500">Queue access and playback preferences</span></span>
                  </button>
                )}
                {isStaff && db?.privateCloud && <div className="my-2 border-y border-rose-500/20 p-2">
                  <div className="mb-2 text-[10px] font-bold uppercase text-rose-300">Reset data</div>
                  <div className="grid grid-cols-2 gap-2">{['queue', 'history', ...(isModerator ? ['statistics'] : []), 'all'].map(scope => <button key={scope} type="button" onClick={() => { setTopMenuOpen(false); setResetScope(scope); }} className="rounded-lg border border-rose-500/25 px-2 py-2 text-xs text-rose-100 hover:bg-rose-500/15">{scope === 'all' ? 'Reset everything' : 'Reset ' + scope}</button>)}</div>
                </div>}
                <button type="button" onClick={() => { setTopMenuOpen(false); setShowAuthModal(true); }} className="flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left text-xs font-bold text-slate-100 transition hover:border-purple-500/20 hover:bg-purple-500/10">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-tr from-purple-500 to-indigo-600 text-xs font-black text-white">{twitchAuth.avatarLetter}</span>
                  <span className="flex-1">{isModerator ? 'Account and access' : 'Account'}<span className="mt-0.5 block text-[10px] font-medium text-slate-500">{isModerator ? 'Twitch sign-in and permissions' : 'Your signed-in profile'}</span></span>
                </button>
                <div className="my-2 border-t border-white/10" />
                {isModerator && <div className="rounded-xl px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-[10px] font-black uppercase tracking-wide text-slate-300">
                      <span className={`h-2 w-2 rounded-full ${webhookHealth.active ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
                      Twitch server webhook
                    </span>
                    <span className={webhookHealth.active ? 'text-[9px] font-bold text-emerald-300' : 'text-[9px] font-bold text-amber-200'}>
                      {webhookHealth.loading ? 'CHECKING' : webhookHealth.active ? 'LISTENING' : 'NOT ACTIVE'}
                    </span>
                  </div>
                  {['moderator_chat_scopes_missing', 'webhook_not_subscribed'].includes(webhookHealth.code) && (
                    <div className="mt-1 text-[10px] text-slate-400">
                      The moderator authorizes channel intake; a separate bot login is optional for chat replies.
                    </div>
                  )}
                  {(webhookHealth.code === 'moderator_chat_scopes_missing') && (
                    <a href="/api/twitch/login?chat_setup=1" className="mt-2 block rounded-lg border border-cyan-500/40 bg-cyan-900/30 px-3 py-2 text-center text-xs font-bold text-cyan-100">
                      Authorize moderator chat intake with Twitch
                    </a>
                  )}
                  <button type="button" disabled={webhookSetupBusy}
                    onClick={() => { setTopMenuOpen(false); void activateTwitchWebhook({ automatic: false }); }}
                    className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-[#171420] px-3 py-2 text-[10px] font-bold text-slate-200 transition hover:border-purple-400/40 hover:bg-purple-500/10 disabled:opacity-50">
                    <RefreshCw className="h-3 w-3" />
                    {webhookSetupBusy ? 'Configuring Twitch…' : 'Activate persistent chat requests'}
                  </button>
                  {(webhookHealth.active || webhookHealth.status === 'webhook_callback_verification_pending') && (
                    <button type="button" disabled={webhookSetupBusy}
                      onClick={() => { setTopMenuOpen(false); void activateTwitchWebhook({ repair: true }); }}
                      className="mt-2 w-full rounded-lg border border-amber-600/30 px-3 py-2 text-xs text-amber-200 hover:bg-amber-950/30 disabled:opacity-50">
                      Repair webhook subscription
                    </button>
                  )}
                  <div className="mt-2 break-words text-[10px] text-slate-300">
                    {webhookHealth.status || webhookHealth.code}
                  </div>
                  {webhookHealth.receiptCode === 'firestore_quota_exceeded' && (
                    <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-900/20 px-2 py-2 text-[10px] font-bold text-amber-100">
                      Firestore quota is exhausted. Twitch may receive messages, but video requests cannot be saved to the shared queue until storage is available.
                    </div>
                  )}
                  {webhookHealth.active && webhookHealth.receiptCode !== 'firestore_quota_exceeded' && !webhookHealth.lastWebhookAt && (
                    <div className="mt-2 text-[10px] text-amber-200">
                      Listening is enabled, but no successful request receipt has been verified. Test with a fresh URL from a normal viewer.
                    </div>
                  )}
                  <div className="mt-1 text-[9px] text-slate-400">
                    Last saved request receipt: {webhookHealth.lastWebhookAt
                      ? new Date(webhookHealth.lastWebhookAt).toLocaleString() : 'Not recorded'}
                    {' · '}Result: {webhookHealth.lastWebhookResult}
                    {' · '}Queued: {webhookHealth.lastWebhookQueued}
                  </div>
                  <div className="mt-1 text-[9px] text-slate-500">
                    Chat intake continues server-side even if this dashboard is closed.
                  </div>
                </div>}
                {isModerator && <div className="mt-1 rounded-xl px-3 py-2">
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
                  <div className="mt-2 text-[10px] text-slate-400">
                    This bot sends replies. The moderator's Twitch authorization handles incoming requests.
                  </div>
                </div>}
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

        {isModerator && connectionDetailsExpanded && (
          <div className="mt-2 grid w-full grid-cols-1 gap-2 rounded-xl border border-slate-800 bg-[#0b0e15] p-3 text-[10px] sm:grid-cols-2 xl:grid-cols-4">
            <div className="min-w-0">
              <div className="mb-1 font-black uppercase tracking-wider text-slate-500">Queue storage</div>
              <div className={cloudSynced ? 'text-emerald-300' : syncIndicatorLabel === 'Cloud issue' ? 'text-rose-200' : 'text-amber-200'}>{syncStatusText}</div>
              <div className="mt-1 text-slate-400">Last saved chat request: {webhookHealth.lastQueueWriteAt ? new Date(webhookHealth.lastQueueWriteAt).toLocaleString() : 'Not confirmed yet'}</div>
            </div>
            <div>
              <div className="mb-1 font-black uppercase tracking-wider text-slate-500">Twitch request intake</div>
              <div className={webhookHealth.receiptCode === 'firestore_quota_exceeded' ? 'text-rose-200' : webhookHealth.active ? 'text-emerald-300' : 'text-amber-200'}>
                {webhookHealth.receiptCode === 'firestore_quota_exceeded' ? 'Firestore quota exceeded; requests cannot be saved' : webhookHealth.active ? 'Twitch listening (delivery not guaranteed)' : webhookHealth.code}
                {' · '}Last delivery: {webhookHealth.lastWebhookAt
                  ? new Date(webhookHealth.lastWebhookAt).toLocaleTimeString() : 'Never'}
              </div>
            </div>
            <div>
              <div className="mb-1 font-black uppercase tracking-wider text-slate-500">Chat replies (independent of intake)</div>
              <div className="text-slate-300">Last server reply confirmed: {webhookHealth.lastReplySentAt ? new Date(webhookHealth.lastReplySentAt).toLocaleString() : 'Not recorded yet'}</div>
              <div className={chatBotSession.connected ? 'text-emerald-300' : 'text-slate-300'}>{chatBotSession.loading ? 'Checking connection…' : chatBotSession.connected ? 'Online · @gachibot69 (optional replies)' : 'Optional replies off · video requests are independent'}</div>
            </div>
            <div>
              <div className="mb-1 font-black uppercase tracking-wider text-slate-500">Room and request queue</div>
              <div className="text-slate-200">#{normalizeRoomName(channelRoom)} · {streamSettings.queueOpen ? 'Requests open' : 'Requests closed'}</div>
            </div>
          </div>
        )}
        {isModerator && healthWarnings.length > 0 && (
          <aside aria-label="Private queue health" className="mx-3 mb-3 rounded-xl border border-amber-500/40 bg-amber-950/30 p-3 text-xs text-amber-100">
            <strong>Queue health</strong>
            <ul className="mt-2 space-y-1">{healthWarnings.map(message => <li key={message}>{message}</li>)}</ul>
          </aside>
        )}
        {isModerator && webhookHealth.receiptCode === 'firestore_quota_exceeded' && (
          <div className="mx-3 mb-3 rounded-xl border border-rose-400/40 bg-rose-950/40 px-4 py-3 text-xs text-rose-100 sm:mx-5" role="alert">
            Firestore quota is exhausted. New chat requests are buffered and retried; they appear in the dashboard after cloud storage recovers. Buffer retention is seven days.
          </div>
        )}
        {isModerator && webhookHealth.code === 'moderator_chat_scopes_missing' && (
          <div className="mx-3 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/40 bg-amber-950/40 px-4 py-3 text-xs text-amber-100 sm:mx-5" role="alert">
            <div className="min-w-0">
              <div className="font-bold">Twitch chat requests are not connected</div>
              <div className="mt-1 text-amber-200/90">
                Your moderator Twitch login needs chat-reading permission. Approve it once; the server will then connect automatically.
              </div>
            </div>
            <a href="/api/twitch/login?chat_setup=1"
              className="shrink-0 rounded-lg border border-cyan-300/60 bg-cyan-700 px-4 py-2 font-black text-white hover:bg-cyan-600">
              Authorize Twitch chat requests
            </a>
          </div>
        )}
        {isModerator && webhookHealth.code === 'webhook_not_subscribed' && webhookSetupBusy && (
          <div className="mx-3 mb-3 rounded-xl border border-slate-600/30 px-3 py-2 text-xs text-slate-300 sm:mx-5">
            Configuring the Twitch chat listener…
          </div>
        )}
      </header>

      {/* ==========================================
          MAIN WORKSPACE: PLAYER + QUEUE
          ========================================== */}
      <section className="gachi-masthead gachi-supper-masthead relative w-full overflow-hidden" aria-label="WHALE CUM - The Leather Club">
        <div className="gachi-supper-caption">
          <p className="text-[10px] font-black uppercase tracking-[0.25em] text-rose-100">THE LEATHER CLUB</p>
          <h1 className="gachi-masthead-title mt-2 text-5xl sm:text-6xl lg:text-7xl xl:text-8xl font-black uppercase">WHALE CUM <span>♂</span></h1>
        </div>
        <img src="/images/ranch-party-v2.jpg" width="2172" height="724" alt="Adult cowboys dancing and socializing at a sunset ranch party" decoding="async" fetchPriority="low" className="gachi-supper-panorama" />
      </section>

      <WorkspaceGrid key={twitchAuth.username} username={twitchAuth.username}>
        {isModerator && chatReplyIssue && <div role="status" className="col-span-full rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          Chat command replies need attention: {chatReplyIssue === 'bot_chat_grant_required' ? 'Reconnect GachiBot69 under Options and verify the bot is a moderator in 2o3a’s channel.' : chatReplyIssue}. Video requests remain silent and independent.
        </div>}
        {statisticsAccess && <WorkspacePanel id="stats" title="Statistics">
        <aside className="gachi-side-rail rounded-2xl border border-rose-500/30 p-3 sm:p-4 space-y-4">
          <img src="/images/cowboys-pasture.png" alt="Adult cowboys in a pasture at sunset" loading="lazy" className="w-full rounded-xl object-contain opacity-85" />
          {isModerator && <PointsDiagnostics />}
          <Suspense fallback={<div className="text-slate-400 text-xs">Loading statistics…</div>}><StatsBoard
            queueStats={queueStats}
            activityEvents={activityEvents.filter(event => event.at > statisticsResetAt)}
            currentSessionId={activitySessionIdRef.current}
            statsNow={statsNow}
            statsExpanded={statsExpanded}
            onToggle={() => setStatsExpanded((expanded) => !expanded)}
            onRefreshStats={handleRefreshStats}
            isStaff={isStaff}
            activitySyncStatus={activitySyncStatus}
            showTechnicalStatus={isModerator}
            activitySyncTone={activitySyncTone}
            activitySyncError={activitySyncError}
            canRetryActivitySync={Boolean(twitchAuth.authenticated)}
            onRetryActivitySync={handleRetryActivitySync}
            networkOnline={networkOnline}
          /></Suspense>
        </aside>
        </WorkspacePanel>}
        <WorkspacePanel id="player" title="Player">
        <div className="gachi-player-column flex flex-col gap-4 min-w-0">
          {/* ==========================================
              ACTIVE MEDIA DECK / BROADCASTER PLAYER
              ========================================== */}
          <section ref={fullscreenContainerRef} data-player-fullscreen={playerFullscreen || fullscreenFallback} className={`gachi-panel bg-[#10141f] border border-slate-800/90 rounded-2xl overflow-hidden shadow-2xl ${fullscreenFallback ? 'fixed inset-0 z-[100] rounded-none' : ''}`}>
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
                    {getVideoMediaType(currentVideo) !== getVideoCategory(currentVideo) && (
                    <span className={`px-2 py-0.5 rounded-lg border text-[10px] font-black uppercase ${getVideoMediaType(currentVideo) === 'Music' ? 'bg-rose-500/15 text-rose-300 border-rose-500/40' : 'bg-amber-500/15 text-amber-200 border-amber-500/40'}`}>
                      {getVideoMediaType(currentVideo)}
                    </span>
                    )}
                    <span className={`px-2 py-0.5 rounded-lg bg-slate-800/80 text-slate-300 border border-slate-700 capitalize`}>
                      {currentVideo.platform}
                    </span>
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {isModerator && currentVideo && <PlaybackIssueReporter video={currentVideo} intent={getPlaybackIntentForVideo(currentVideo.id)} volume={localVolume} muted={localMuted} providerCode={playerIssue?.generation === currentPlaybackGeneration ? playerIssue.code : ''} />}
                <button type="button" onClick={togglePlayerFullscreen} aria-label={playerFullscreen || fullscreenFallback ? 'Exit player fullscreen' : 'Enter player fullscreen'} aria-pressed={playerFullscreen || fullscreenFallback} className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300" title="Fullscreen player (persists across tracks)">
                  {playerFullscreen || fullscreenFallback ? <Shrink className="inline w-3.5 h-3.5 mr-1" /> : <Expand className="inline w-3.5 h-3.5 mr-1" />}<span className="text-xs">{playerFullscreen || fullscreenFallback ? 'Exit fullscreen' : 'Fullscreen'}</span>
                </button>
                <button
                  aria-label="Toggle player height"
                  onClick={() => setIsTheatreMode(!isTheatreMode)}
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                  title="Toggle Player Height"
                >
                  <MoveVertical className="inline w-3.5 h-3.5 mr-1" /><span className="text-xs">{isTheatreMode ? 'Reduce height' : 'Enlarge'}</span>
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
                  {currentVideo.platform === 'youtube' && youtubeAutoplayBlocked && playerIssue?.generation !== currentPlaybackGeneration && <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60">
                    <button type="button" className="rounded-xl bg-purple-600 px-6 py-3 font-bold text-white" onClick={() => { updatePlaybackIntent(currentVideo.id, { paused: false }); youtubePlayerRef.current?.playVideo(); setYouTubeAutoplayBlocked(false); }}>Play video</button>
                  </div>}
                  {playerIssue?.generation === currentPlaybackGeneration && <PlaybackFailure message={playerIssue.message || playbackFailureMessage(currentVideo.platform)} url={currentVideo.url} onSkip={() => handleSkipNext()}
                    onRetry={() => { failedPlaybackRef.current = ''; setPlayerIssue(null); if (currentVideo.platform === 'tiktok') { tiktokRecoveryRef.current = { generation: currentPlaybackGeneration, attempts: 0 }; setTikTokPlayerState({ requestId: currentVideo.id, status: 'loading' }); setTikTokFrameReload(value => value + 1); } else { youtubeRecoveryRef.current = { generation: currentPlaybackGeneration, attempts: 0 }; setPlayerReload(value => value + 1); } }} />}
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
                      ? "gachi-portrait-shell relative z-10"
                      : "gachi-landscape-shell"}>
                    <iframe
                      key={`youtube-${currentPlaybackGeneration}-${currentVideo.videoId}-${playerReload}`}
                      ref={youtubeIframeRef}
                      className="absolute inset-0 h-full w-full border-0"
                      src={youtubePlayerSrc}
                      title={currentVideo.title || 'YouTube video'}
                      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                      allowFullScreen
                      referrerPolicy="strict-origin-when-cross-origin"
                    />
                    </div>
                  ) : currentVideo.platform === 'tiktok' && /^\d{10,25}$/.test(String(currentVideo.videoId || '')) ? (
                    <>
                      <div className="gachi-portrait-shell relative z-10">
                      <iframe
                        key={`tiktok-player-${currentPlaybackGeneration}-${currentVideo.videoId}-${tiktokFrameReload}`}
                        ref={tiktokIframeRef}
                        className="gachi-tiktok-player border-0"
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
                      </div>
                      <p className="absolute bottom-1 right-2 z-20 rounded bg-black/80 px-2 py-1 text-[10px] text-slate-300">TikTok volume: use its player slider; saved app volume {localVolume}% applies to YouTube and controllable Twitch playback.</p>
                      {tiktokPlayerState.requestId === currentVideo.id && tiktokPlayerState.status === 'blocked' && (
                        <div className="pointer-events-none absolute bottom-3 left-3 z-30">
                          <button type="button" className="pointer-events-auto rounded-xl bg-purple-700 px-4 py-2 text-xs font-bold text-white shadow-lg"
                            onClick={() => {
                              const iframe = tiktokIframeRef.current?.contentWindow;
                              updatePlaybackIntent(currentVideo.id, { paused: false });
                              if (iframe) {
                                postTikTokPlayerCommand(iframe, 'play', null);
                                if (!localMutedRef.current) postTikTokPlayerCommand(iframe, 'unMute', null);
                              }
                              setTikTokPlayerState({ requestId: currentVideo.id, status: 'ready' });
                            }}>
                            Click to start TikTok (browser blocked autoplay)
                          </button>
                        </div>
                      )}
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
                    <TwitchClipPlayer
                      key={`twitch-${currentPlaybackGeneration}-${currentVideo.videoId}-${playerReload}`}
                      video={currentVideo}
                      storageKey={roomStorageKey(channelRoom, 'twitch-playback-v1-' + currentPlaybackGeneration)}
                      volume={localVolume}
                      muted={localMuted}
                      onAudioChange={(volume, muted) => { setLocalVolume(volume); setLocalMuted(muted); }}
                      onEnded={(id) => handleMediaEndedRef.current?.(id)}
                      onFailure={() => reportPlayerIssue({ generation: currentPlaybackGeneration })}
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
                        <p className="text-xs text-slate-300">This media type cannot be played inline. Open the source to watch it; age-restricted or private videos may require signing in there.</p>
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

                    {promotionLabel(currentVideo) && <p className="text-xs font-bold text-amber-200">{promotionLabel(currentVideo)}</p>}
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
        </WorkspacePanel>
        <WorkspacePanel id="queue" title="Request Queue">
        <div className="gachi-queue-column min-w-0">
          {/* ==========================================
              QUEUE MANAGEMENT: TABS, FILTERS & CARDS
              ========================================== */}
          <section className="gachi-panel gachi-queue-panel bg-[#10141f] border border-slate-800/90 rounded-2xl p-3 sm:p-4 space-y-3 shadow-xl">
            <p className="text-[11px] text-amber-100/80">!promote [queue position] moves any waiting video to next up: 50 points per position crossed. !unpromote [queue position] refunds the payer before playback.</p>
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
              canShuffle={isStaff && Boolean(db?.privateCloud) && videos.filter(video => video.status === 'queue' && !video.pinned).length > 1}
              shuffleBusy={shuffleBusy}
              onShuffle={() => void handleShuffleQueue('shuffle')}
              onFairShuffle={() => void handleShuffleQueue('fair-shuffle')}
              onUnshuffle={() => void handleShuffleQueue('unshuffle')}
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
                    categoryCorrections={categoryCorrections}
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
                  handleMoveNext={videoId => { const first = videosRef.current.filter(video => video.status === 'queue').sort(compareQueueOrder)[0]; if (first) handleDropReorder(videoId, first.id); }}
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

        </WorkspacePanel>
        {/* Twitch EventSub runs invisibly; no raw chat transcript is rendered. */}
      </WorkspaceGrid>

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
                  <h3 className="text-base font-bold text-white">Enter the Leather Club</h3>
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
                    <option value="Forsen">Forsen</option>
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
                <div><h3 className="text-base font-bold text-white">{isModerator ? 'Twitch authentication' : 'Your account'}</h3><p className="text-xs text-slate-400">Streaming room: 2o3a</p></div>
              </div>
              <button onClick={() => setShowAuthModal(false)} className="p-1.5 rounded-lg text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="rounded-xl bg-[#0d1017] border border-slate-800 p-4 space-y-2 text-sm">
              <div className="text-slate-400 text-xs uppercase font-bold">Current session</div>
              <div className="text-white font-bold">{twitchAuth.displayName}</div>
              <div className="text-purple-300 capitalize">{twitchAuth.role}{twitchAuth.authenticated ? ' · Twitch verified' : ' · public viewer'}</div>
              {isModerator && <p className="text-xs text-slate-400">Private room: twitch.tv/2o3a. Roles are assigned to the two allowlisted accounts on the server.</p>}
            </div>
            {!twitchAuth.authenticated ? (
              <button disabled={twitchAuthLoading} onClick={() => { window.location.href = '/api/twitch/login'; }} className="w-full px-5 py-3 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-sm font-bold"><LogIn className="inline w-4 h-4 mr-2" />Continue with Twitch</button>
            ) : (
              <button onClick={async () => { authorizedLoginRef.current = ''; setFirebaseLoginToken(''); if (auth) { try { await signOut(auth); } catch { /* already signed out */ } } await fetch('/api/twitch/logout', { method: 'POST', credentials: 'same-origin' }); setTwitchAuth({ username: '', displayName: 'Signed out', role: 'viewer', color: '#a970ff', avatarLetter: 'Y', authenticated: false }); setShowAuthModal(false); }} className="w-full px-5 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-sm font-bold"><LogOut className="inline w-4 h-4 mr-2" />Log out of Twitch</button>
            )}
            {isModerator && <p className="text-[11px] text-amber-200/80">Allowlist: <strong>2o3a</strong> (streamer) and <strong>paim_beach_pete</strong> (moderator). All other Twitch accounts are denied on the server.</p>}
          </div>
        </div>
      )}

      {/* ==========================================
          MODAL 3: STREAMER QUEUE RULES & SAFETY
          ========================================== */}
      {resetScope && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4" role="dialog" aria-modal="true" aria-labelledby="reset-title">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-rose-500/40 bg-[#12101a] p-6">
          <h3 id="reset-title" className="text-lg font-black text-white">Reset {resetScope === 'all' ? 'everything' : resetScope}?</h3>
          <p className="text-sm text-slate-300">{resetScope === 'queue' ? 'Remove waiting and Watch Later items. The current video and history stay.' : resetScope === 'history' ? 'Remove watched videos. Waiting requests and the current video stay.' : resetScope === 'statistics' ? 'Start statistics from zero. Videos and history stay.' : 'Remove every video, including the playing video, and start statistics from zero.'} This affects the shared room. A backup will download first.</p>
          <div className="flex justify-end gap-3"><button autoFocus disabled={resetBusy} onClick={() => setResetScope('')} className="rounded-lg bg-slate-800 px-4 py-2 text-white">Cancel</button><button disabled={resetBusy} onClick={handleReset} className="rounded-lg bg-rose-700 px-4 py-2 font-bold text-white disabled:opacity-50">{resetBusy ? 'Resetting…' : 'Confirm reset'}</button></div>
        </div>
      </div>}
      {isModerator && showSettingsModal && (
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

            <RecoveryHistory onRestored={() => getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'queue_videos'))} />
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
export class YediHubAppErrorBoundary extends React.Component<React.PropsWithChildren<{ showDiagnostics?: boolean }>, { hasError: boolean; errorMessage: string; componentStack: string }> {
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
            <h1 className="text-lg font-black">The dashboard could not open</h1>
            <p className="text-sm text-slate-300">Try again or reload the dashboard. Your saved queue will stay intact.</p>
            {this.props.showDiagnostics && <div className="rounded-xl border border-slate-700 bg-black/30 p-3">
              <div className="text-xs font-bold uppercase tracking-wide text-rose-300">Error</div>
              <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-200">{this.state.errorMessage}</pre>
              {this.state.componentStack && <details className="mt-3"><summary className="cursor-pointer text-xs font-bold text-slate-300">Component stack</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px] text-slate-400">{this.state.componentStack}</pre></details>}
            </div>}
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
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  if (window.location.pathname.replace(/\/+$/, '') === '/queue') {
    return <Suspense fallback={<main className="min-h-screen bg-[#090a0f] p-8 text-slate-200">Loading queue…</main>}><PublicQueue /></Suspense>;
  }
  return <YediHubAppErrorBoundary showDiagnostics={showDiagnostics}><YediHubAppContent onDiagnosticAccess={setShowDiagnostics} /></YediHubAppErrorBoundary>;
}
