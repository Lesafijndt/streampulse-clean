import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Play,
  SkipForward,
  RotateCcw,
  Clock,
  CheckCircle2,
  ListVideo,
  ShieldAlert,
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
  MessageSquare,
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
  Check,
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
  signInAnonymously,
  onAuthStateChanged
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  updateDoc,
  increment,
  deleteDoc,
  onSnapshot
} from 'firebase/firestore';



// Persistent local fallback and optional Firebase configuration.
// Local storage is always enabled; Firebase adds cross-browser real-time sync when configured.
const STORAGE_PREFIX = 'streampulse-live-hub:v1';
const DEFAULT_STREAM_SETTINGS = {
  streamMode: 'all',
  queueOpen: true,
  requireApproval: false,
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
  return String(value || 'aetherlive').trim().toLowerCase().replace(/^#/, '') || 'aetherlive';
}

function roomStorageKey(room, suffix) {
  return `${STORAGE_PREFIX}:room:${encodeURIComponent(normalizeRoomName(room))}:${suffix}`;
}

function getSavedRoom() {
  return normalizeRoomName(readStoredValue(`${STORAGE_PREFIX}:active-room`, 'aetherlive'));
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

// Hide well-known automated chat accounts. Twitch IRC is still the source of all displayed messages.
const KNOWN_CHAT_BOTS = new Set([
  'nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot',
  'botrix', 'deepbot', 'sery_bot', 'serybot', 'mixitup', 'soundalerts',
  'commanderroot', 'tangia', 'firebot', 'own3d', 'botisimo', 'blerp',
  'pretzelrocks', 'monstercat', 'vivbot', 'ankhbot', 'ohbot', 'phantombot',
  'streamcaptain', 'streamstickers', 'sery_bot'
]);

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

function loadYouTubeIframeApi() {
  const globalWindow = window as any;
  if (globalWindow.YT && globalWindow.YT.Player) return Promise.resolve(globalWindow.YT);
  if (globalWindow.__streamPulseYouTubeApiPromise) return globalWindow.__streamPulseYouTubeApiPromise;

  globalWindow.__streamPulseYouTubeApiPromise = new Promise((resolve, reject) => {
    const scriptUrl = 'https://www.youtube.com/iframe_api';
    const existingScript = document.querySelector(`script[src="${scriptUrl}"]`);
    const previousReady = globalWindow.onYouTubeIframeAPIReady;
    const timeoutId = window.setTimeout(() => {
      reject(new Error('YouTube player API timed out loading.'));
    }, 20000);

    globalWindow.onYouTubeIframeAPIReady = () => {
      if (typeof previousReady === 'function') previousReady();
      window.clearTimeout(timeoutId);
      if (globalWindow.YT && globalWindow.YT.Player) resolve(globalWindow.YT);
      else reject(new Error('YouTube player API loaded without a Player constructor.'));
    };

    if (!existingScript) {
      const script = document.createElement('script');
      script.src = scriptUrl;
      script.async = true;
      script.onerror = () => {
        window.clearTimeout(timeoutId);
        reject(new Error('Could not load the YouTube player API.'));
      };
      document.head.appendChild(script);
    }
  });
  return globalWindow.__streamPulseYouTubeApiPromise;
}

// ==========================================
// CATEGORY DEFINITIONS & HEURISTIC ENGINE
// ==========================================
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

/**
 * Standardize media platform parsing
 */
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

  // Twitch Clips
  if (url.includes('twitch.tv') && (url.includes('/clip/') || url.includes('clips.twitch.tv'))) {
    const parts = url.split('/').filter(Boolean);
    const clipSlug = parts[parts.length - 1]?.split('?')[0] || 'TwitchClip';
    return {
      platform: 'twitch',
      videoId: clipSlug,
      thumbnail: `https://placehold.co/640x360/581c87/f3e8ff?text=Twitch+Clip+%E2%80%A2+${encodeURIComponent(clipSlug.slice(0, 10))}`
    };
  }

  // TikTok official player needs the numeric post ID, not the short-link slug.
  if (url.includes('tiktok.com')) {
    const idMatch = url.match(/(?:\/video\/|\/player\/v1\/)(\d{10,25})/i) || url.match(/[?&](?:item_id|video_id)=(\d{10,25})/i);
    const vid = idMatch?.[1] || null;
    return {
      platform: 'tiktok',
      videoId: vid,
      thumbnail: 'https://placehold.co/640x360/09090b/22d3ee?text=TikTok+Video'
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

export default function StreamPulseApp() {
  // ==========================================
  // FIREBASE CLOUD REAL-TIME INFRASTRUCTURE
  // ==========================================
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [firebaseUser, setFirebaseUser] = useState(null);
  const [cloudSynced, setCloudSynced] = useState(false);
  const [syncStatusText, setSyncStatusText] = useState('Initializing cloud sync...');

  // Safe global environment references
  const appId = typeof __app_id !== 'undefined' ? __app_id : (import.meta.env.VITE_FIREBASE_NAMESPACE || 'streampulse-live-deck');

  // ==========================================
  // CHANNEL ROOM & AUTHENTICATION STATE
  // ==========================================
  // Streamers and mods share the room based on the Broadcaster's Twitch username
  const [channelRoom, setChannelRoom] = useState(() => getSavedRoom());
  const [roomInput, setRoomInput] = useState(() => getSavedRoom());

  // Local simulated Twitch user session
  const [twitchAuth, setTwitchAuth] = useState(() => ({
    username: 'AetherLive_TV',
    displayName: 'AetherLive',
    role: 'streamer', // UI simulation only; not Twitch authentication
    color: '#a970ff',
    avatarLetter: 'A',
    ...(readStoredValue(`${STORAGE_PREFIX}:profile`, {}) || {})
  }));

  // UI Modals
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [showObsOverlay, setShowObsOverlay] = useState(false);

  // Queue Moderation Settings
  const [streamSettings, setStreamSettings] = useState(() => {
    const saved = readStoredValue(roomStorageKey(channelRoom, 'settings'), {});
    return { ...DEFAULT_STREAM_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) };
  });

  // Videos master state. Persist locally even when Firebase is not configured or is offline.
  const [videos, setVideos] = useState(() => {
    const saved = readStoredValue(roomStorageKey(channelRoom, 'videos'), null);
    if (Array.isArray(saved)) return saved.filter((video) => !String(video?.id || '').startsWith('demo-'));
    // Start empty so demo requests never appear to be real viewer submissions.
    return [];
  });

  // Filter & Nav State
  const [activeTab, setActiveTab] = useState('queue'); // 'queue' | 'watch_later' | 'watched' | 'pending'
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('priority'); // 'priority' | 'upvotes' | 'newest'

  // Player State
  const [simProgress, setSimProgress] = useState(0);
  const [isTheatreMode, setIsTheatreMode] = useState(false);
  const youtubePlayerContainerRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const tiktokIframeRef = useRef(null);
  const handleSkipNextRef = useRef(null);
  const handleVolumeCommandRef = useRef(null);
  const handleIncomingChatCommandRef = useRef(null);
  const handleUpvoteRef = useRef(null);
  const currentVideoRef = useRef(null);
  const handleMediaEndedRef = useRef(null);
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

  // Twitch Chat & IRC State
  const [chatOpen, setChatOpen] = useState(true);
  const [ircConnected, setIrcConnected] = useState(false);
  const [ircChannel, setIrcChannel] = useState('');
  const ircSocketRef = useRef(null);
  const chatBottomRef = useRef(null);

  // The chat panel only renders actual messages received from Twitch IRC.
  const [chatMessages, setChatMessages] = useState([]);


  // Notifications
  const [toasts, setToasts] = useState([]);
  const addToast = (message, type = 'info') => {
    const id = 'toast-' + Date.now() + Math.random().toString(36).slice(2, 6);
    setToasts((prev) => [...prev.slice(-3), { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3800);
  };



  // Browser persistence is the reliable fallback when Firebase is not configured.
  useEffect(() => {
    writeStoredValue(roomStorageKey(channelRoom, 'videos'), videos);
  }, [videos, channelRoom]);

  useEffect(() => {
    writeStoredValue(roomStorageKey(channelRoom, 'settings'), streamSettings);
  }, [streamSettings, channelRoom]);

  useEffect(() => {
    writeStoredValue(roomStorageKey(channelRoom, 'votes'), votedIds);
  }, [votedIds, channelRoom]);

  useEffect(() => {
    writeStoredValue(`${STORAGE_PREFIX}:active-room`, channelRoom);
  }, [channelRoom]);

  useEffect(() => {
    writeStoredValue(`${STORAGE_PREFIX}:profile`, twitchAuth);
  }, [twitchAuth]);

  // ==========================================
  // FIREBASE INITIALIZATION & AUTH
  // ==========================================
  useEffect(() => {
    let active = true;
    let unsubscribeAuth = null;
    const config = getFirebaseConfig();

    if (!config) {
      setDb(null);
      setAuth(null);
      setFirebaseUser(null);
      setCloudSynced(false);
      setSyncStatusText('Saved in this browser (local storage)');
      return () => { active = false; };
    }

    try {
      // Reuse the named app. This avoids duplicate-app errors in React StrictMode.
      const appName = 'streampulse-live-hub';
      const existingApp = getApps().find((item) => item.name === appName);
      const app = existingApp || initializeApp(config, appName);
      const authInstance = getAuth(app);
      const dbInstance = getFirestore(app);

      setDb(dbInstance);
      setAuth(authInstance);
      setSyncStatusText('Connecting to Firebase…');

      const initAuth = async () => {
        try {
          if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
            await signInWithCustomToken(authInstance, __initial_auth_token);
          } else if (!authInstance.currentUser) {
            await signInAnonymously(authInstance);
          }
        } catch (error) {
          console.warn('Firebase sign-in failed; browser storage remains available.', error);
          if (active) {
            setCloudSynced(false);
            setSyncStatusText('Cloud sign-in failed — local save is active');
          }
        }
      };
      initAuth();

      unsubscribeAuth = onAuthStateChanged(authInstance, (user) => {
        if (!active) return;
        setFirebaseUser(user);
        if (user) {
          setSyncStatusText('Signed in — connecting to cloud queue…');
        } else {
          setCloudSynced(false);
          setSyncStatusText('Not signed in — local save is active');
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

  // ==========================================
  // REAL-TIME FIRESTORE LISTENER FOR ROOM
  // ==========================================
  const initializedCloudRoomsRef = useRef(new Set());

  useEffect(() => {
    if (!db || !firebaseUser) return;

    let active = true;
    try {
      const colRef = collection(db, 'artifacts', appId, 'public', 'data', 'queue_videos');
      const unsubscribe = onSnapshot(
        colRef,
        (snapshot) => {
          if (!active) return;
          setCloudSynced(true);
          setSyncStatusText('Cloud Synced');

          // Place the Firestore document ID last so it is always the ID used for updates/deletes.
          const list = snapshot.docs.map((d) => ({ ...d.data(), id: d.id }));
          const roomList = list.filter(
            (v) => normalizeRoomName(v.channelRoom) === normalizeRoomName(channelRoom) && !String(v.id || '').startsWith('demo-')
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

  // Sync Video Changes Helper (updates Firestore if online, updates state locally)
  const syncUpdateVideo = async (videoId, updates) => {
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

  const syncIncrementUpvote = async (videoId) => {
    setVideos((prev) => prev.map((video) => (
      video.id === videoId ? { ...video, upvotes: (video.upvotes || 0) + 1 } : video
    )));

    if (db && firebaseUser) {
      try {
        const itemRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', videoId);
        await updateDoc(itemRef, { upvotes: increment(1) });
      } catch (error) {
        // A legacy/demo document may not exist in Firestore yet; create it with the current count.
        try {
          const fullItem = videos.find((video) => video.id === videoId);
          if (fullItem) {
            const itemRef = doc(db, 'artifacts', appId, 'public', 'data', 'queue_videos', videoId);
            await setDoc(itemRef, {
              ...fullItem,
              upvotes: (fullItem.upvotes || 0) + 1,
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
  const currentVideo = useMemo(() => {
    // Current playing item or top of queue
    const playing = videos.find((v) => v.status === 'playing');
    if (playing) return playing;
    const queued = videos
      .filter((v) => v.status === 'queue')
      .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : (a.timestamp || 0) - (b.timestamp || 0)));
    return queued[0] || null;
  }, [videos]);
  // WebSocket callbacks can live longer than a React render; refs keep command handlers current.
  currentVideoRef.current = currentVideo;

  const counts = useMemo(() => {
    return {
      queue: videos.filter((v) => v.status === 'queue').length,
      watch_later: videos.filter((v) => v.status === 'watch_later').length,
      watched: videos.filter((v) => v.status === 'watched').length,
      pending: videos.filter((v) => v.status === 'pending').length
    };
  }, [videos]);

  const filteredVideos = useMemo(() => {
    return videos
      .filter((v) => v.status === activeTab)
      .filter((v) => (selectedCategory === 'All' ? true : v.category === selectedCategory))
      .filter((v) => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return (
          v.title.toLowerCase().includes(q) ||
          v.requestedBy.toLowerCase().includes(q) ||
          v.category.toLowerCase().includes(q) ||
          (v.note && v.note.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (sortBy === 'upvotes') return (b.upvotes || 0) - (a.upvotes || 0);
        if (sortBy === 'newest') return (b.timestamp || 0) - (a.timestamp || 0);
        return (a.timestamp || 0) - (b.timestamp || 0); // Priority / FIFO
      });
  }, [videos, activeTab, selectedCategory, searchQuery, sortBy]);

  const isStaff = twitchAuth.role === 'streamer' || twitchAuth.role === 'moderator';

  // The visual progress bar mirrors real YouTube playback. TikTok sends its own time events below.
  useEffect(() => {
    if (!currentVideo || currentVideo.platform !== 'youtube') return;
    const timer = window.setInterval(() => {
      const player = youtubePlayerRef.current;
      if (!player || typeof player.getCurrentTime !== 'function' || typeof player.getDuration !== 'function') return;
      const duration = Number(player.getDuration()) || 0;
      const currentTime = Number(player.getCurrentTime()) || 0;
      if (duration > 0) setSimProgress(Math.min(100, Math.max(0, (currentTime / duration) * 100)));
    }, 500);
    return () => window.clearInterval(timer);
  }, [currentVideo?.id, currentVideo?.platform]);

  // ==========================================
  // REAL TWITCH IRC WEBSOCKET BRIDGE
  // Connects anonymously to Twitch chat IRC
  // ==========================================
  const connectTwitchIrc = (targetChan) => {
    const cleanChan = (targetChan || channelRoom).trim().toLowerCase().replace(/^#/, '');
    if (!cleanChan) {
      addToast('Please enter a valid Twitch channel name.', 'warning');
      return;
    }

    if (ircSocketRef.current) {
      ircSocketRef.current.close();
    }

    try {
      const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
      ircSocketRef.current = ws;

      ws.onopen = () => {
        // Standard Anonymous Twitch IRC handshake
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 89999)}`);
        ws.send(`JOIN #${cleanChan}`);
        setIrcConnected(true);
        addToast(`Connected live to Twitch Chat: #${cleanChan}`, 'success');
      };

      ws.onmessage = (event) => {
        const raw = event.data;
        if (raw.startsWith('PING')) {
          ws.send('PONG :tmi.twitch.tv');
          return;
        }

        if (raw.includes('PRIVMSG')) {
          const userMatch = raw.match(/display-name=([^;]+)/);
          const msgMatch = raw.match(/PRIVMSG #[^ ]+ :(.+)/);
          const badgesMatch = raw.match(/badges=([^;]*)/);
          const moderatorMatch = raw.match(/(?:^|;)mod=([01])/);
          const colorMatch = raw.match(/color=([^;]*)/);
          const tagsMatch = raw.match(/^@([^ ]+) /);
          const tagMap = Object.fromEntries((tagsMatch?.[1] || '').split(';').filter(Boolean).map((tag) => {
            const separator = tag.indexOf('=');
            return separator >= 0 ? [tag.slice(0, separator), tag.slice(separator + 1)] : [tag, ''];
          }));
          const username = userMatch ? userMatch[1].replace(/\s/g, ' ') : 'Chatter';
          const text = msgMatch ? msgMatch[1].trim() : '';
          const usernameKey = username.trim().toLowerCase().replace(/^@/, '');
          const taggedAsBot = String(tagMap['user-type'] || '').toLowerCase() === 'bot' || String(tagMap.bot || '') === '1';
          if (taggedAsBot || KNOWN_CHAT_BOTS.has(usernameKey)) return;
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
          const messageColor = colorMatch?.[1] || '#38bdf8';

          if (text) {
            const lowerText = text.toLowerCase();
            const isRequestCommand = lowerText.startsWith('!assr ');
            const volumeCommand = parseModVolumeCommand(lowerText);
            const isCmd = isRequestCommand || lowerText === '!hype' || lowerText === '!skip' || Boolean(volumeCommand);

            const newMsg = {
              id: 'irc-' + Date.now() + Math.random(),
              username,
              role,
              color: messageColor,
              text,
              isCommand: isCmd,
              time: 'Live IRC'
            };

            setChatMessages((prev) => [...prev.slice(-35), newMsg]);

            if (isRequestCommand) {
              handleIncomingChatCommandRef.current?.(username, role, text);
            } else if (lowerText === '!hype' && currentVideoRef.current) {
              handleUpvoteRef.current?.(currentVideoRef.current.id);
            } else if (lowerText === '!skip' && isStaffRole(role)) {
              handleSkipNextRef.current?.();
            } else if (volumeCommand && isStaffRole(role)) {
              handleVolumeCommandRef.current?.(volumeCommand, role);
            }
          }
        }
      };

      ws.onerror = () => {
        setIrcConnected(false);
        addToast('Could not connect to Twitch IRC. Check the channel name and connection, then retry.', 'warning');
      };

      ws.onclose = () => {
        setIrcConnected(false);
      };
    } catch (e) {
      console.warn('IRC WebSocket failed:', e);
    }
  };

  const disconnectTwitchIrc = () => {
    if (ircSocketRef.current) {
      ircSocketRef.current.close();
      ircSocketRef.current = null;
    }
    setIrcConnected(false);
    addToast('Disconnected from Twitch IRC.', 'info');
  };

  // Auto-scroll chat
  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

  // ==========================================
  // REQUEST CREATION & DISPATCH
  // ==========================================
  const handleIncomingChatCommand = (username, role, rawText) => {
    // Syntax: !assr <url> [optional title/note]
    const tokens = rawText.trim().split(/\s+/);
    if (tokens.length < 2) return;

    const url = tokens[1];
    let candidateNote = tokens.slice(2).join(' ');

    processAndQueueRequest({
      url,
      requestedBy: username,
      userRole: role,
      note: candidateNote || 'Requested via Twitch Chat command',
      manualCategory: null
    });
  };

  handleIncomingChatCommandRef.current = handleIncomingChatCommand;

  const processAndQueueRequest = ({
    url,
    title = '',
    note = '',
    requestedBy,
    userRole = 'viewer',
    manualCategory = null
  }) => {
    const requesterIsStaff = userRole === 'streamer' || userRole === 'moderator';
    if (!streamSettings.queueOpen && !requesterIsStaff) {
      addToast('The media request queue is currently closed by the streamer.', 'warning');
      return false;
    }

    // All platforms and categories are accepted without filtering. Category detection is metadata only.
    const parsed = parseMediaUrl(url);
    const finalCategory =
      manualCategory && manualCategory !== 'Auto'
        ? manualCategory
        : detectVideoCategory(url, title, note, 'all');

    const targetStatus = streamSettings.requireApproval && !requesterIsStaff ? 'pending' : 'queue';
    const cleanTitle =
      title.trim() ||
      (parsed.platform === 'youtube'
        ? `YouTube Media (${parsed.videoId})`
        : parsed.platform === 'twitch'
        ? `Twitch Clip (${parsed.videoId})`
        : parsed.platform === 'tiktok'
        ? `TikTok Short Clip`
        : 'Community Requested Media');

    const newVideo = {
      id: 'vid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      channelRoom,
      title: cleanTitle,
      url: url.trim(),
      platform: parsed.platform,
      videoId: parsed.videoId,
      category: finalCategory,
      duration: parsed.platform === 'tiktok' || parsed.platform === 'twitch' ? '00:45' : '03:45',
      durationSec: 225,
      requestedBy: requestedBy || twitchAuth.username,
      userRole,
      status: targetStatus,
      upvotes: 1,
      pinned: false,
      addedAt: 'Just now',
      timestamp: Date.now(),
      note: note || `Added to ${channelRoom} deck`,
      thumbnail: parsed.thumbnail
    };

    syncAddVideo(newVideo);

    addToast(
      targetStatus === 'pending'
        ? `Sent "${cleanTitle.slice(0, 24)}..." to Moderator Approval`
        : `Added "${cleanTitle.slice(0, 24)}..." [${finalCategory}] to Queue!`,
      'success'
    );
    return true;
  };

  // ==========================================
  // PLAYBACK & QUEUE ACTIONS
  // ==========================================
  const handlePlayNow = (video) => {
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
    if (!currentVideo) return;

    // Mark current as watched
    syncUpdateVideo(currentVideo.id, {
      status: 'watched',
      watchedAt: 'Just now'
    });

    // Find next in queue
    const queuedList = videos
      .filter((v) => v.status === 'queue' && v.id !== currentVideo.id)
      .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : (a.timestamp || 0) - (b.timestamp || 0)));

    const nextOne = queuedList[0];
    if (nextOne) {
      syncUpdateVideo(nextOne.id, { status: 'playing', pinned: false });
      setSimProgress(0);
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
      else if (volumeCommand.action === 'mute') { player.mute(); addToast('YouTube player muted by staff command.', 'info'); return; }
      else if (volumeCommand.action === 'unmute') { player.unMute(); addToast('YouTube player unmuted by staff command.', 'info'); return; }
      player.setVolume(next);
      if (next > 0 && typeof player.unMute === 'function') player.unMute();
      if (next === 0 && typeof player.mute === 'function') player.mute();
      addToast(`YouTube volume set to ${next}%.`, 'success');
      return;
    }

    if (currentVideo?.platform === 'tiktok') {
      const iframeWindow = tiktokIframeRef.current?.contentWindow;
      if (!iframeWindow) { addToast('TikTok player is not ready for volume commands yet.', 'warning'); return; }
      if (volumeCommand.action === 'set' && volumeCommand.value !== 0 && volumeCommand.value !== 100) {
        addToast('TikTok only exposes mute/unmute to remote commands. Use its in-player volume slider for exact levels.', 'info');
        return;
      }
      const shouldMute = volumeCommand.action === 'mute' || volumeCommand.action === 'down' || (volumeCommand.action === 'set' && volumeCommand.value === 0);
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

  // Player/chat callbacks always use current handlers and queue state.
  handleSkipNextRef.current = handleSkipNext;
  handleVolumeCommandRef.current = handleVolumeCommand;
  handleMediaEndedRef.current = (videoId) => {
    if (!currentVideo || currentVideo.id !== videoId) return;
    if (streamSettings.autoPlayNext && isStaff) {
      handleSkipNextRef.current?.();
    }
  };

  // Mount the official YouTube IFrame API player, allowing reliable autoplay and end-of-video detection.
  useEffect(() => {
    const video = currentVideo;
    if (!video || video.platform !== 'youtube' || !video.videoId || !youtubePlayerContainerRef.current) return undefined;

    let cancelled = false;
    let player = null;
    loadYouTubeIframeApi().then((YT) => {
      if (cancelled || !youtubePlayerContainerRef.current) return;
      player = new YT.Player(youtubePlayerContainerRef.current, {
        width: '100%',
        height: '100%',
        videoId: video.videoId,
        playerVars: {
          autoplay: 1,
          controls: 1,
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
          origin: window.location.origin
        },
        events: {
          onReady: (event) => {
            if (cancelled) return;
            youtubePlayerRef.current = event.target;
            // Request autoplay with audio enabled. Browsers may still require a user gesture
            // before they allow audible autoplay; the player remains unmuted when playback starts.
            event.target.playVideo();
                  },
          onStateChange: (event) => {
            if (cancelled) return;
            // YouTube PlayerState: 0 = ended, 1 = playing, 2 = paused.
            if (event.data === 0) handleMediaEndedRef.current?.(video.id);
          },
          onAutoplayBlocked: () => {
            if (!cancelled) addToast('Your browser blocked autoplay with sound. Press Play in the player once to allow playback.', 'info');
          },
          onError: () => {
            if (!cancelled) addToast('YouTube could not play this video. It may be private, removed, or embedding-disabled.', 'warning');
          }
        }
      });
    }).catch((error) => {
      console.warn('YouTube player could not initialize.', error);
      if (!cancelled) addToast('The YouTube player could not load. Check browser extensions or network access.', 'warning');
    });

    return () => {
      cancelled = true;
      if (youtubePlayerRef.current === player) youtubePlayerRef.current = null;
      if (player && typeof player.destroy === 'function') {
        try { player.destroy(); } catch { /* Player may already have been removed by React. */ }
      }
    };
  }, [currentVideo?.id, currentVideo?.videoId, currentVideo?.platform]);

  // TikTok's official embedded player sends state and time updates with postMessage.
  useEffect(() => {
    if (!currentVideo || currentVideo.platform !== 'tiktok' || !currentVideo.videoId) return undefined;

    const handleTikTokMessage = (event) => {
      if (event.origin !== 'https://www.tiktok.com') return;
      if (event.source !== tiktokIframeRef.current?.contentWindow) return;

      let data = event.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { return; }
      }
      if (!data || data['x-tiktok-player'] !== true) return;

      if (data.type === 'onPlayerReady') {
        // Ask TikTok to start as soon as its player reports ready; autoplay=1 is also in the iframe URL.
        tiktokIframeRef.current?.contentWindow?.postMessage(
          { type: 'play', value: null, 'x-tiktok-player': true },
          'https://www.tiktok.com'
        );
      } else if (data.type === 'onCurrentTime' && data.value) {
        const duration = Number(data.value.duration) || 0;
        const currentTime = Number(data.value.currentTime) || 0;
        if (duration > 0) setSimProgress(Math.min(100, Math.max(0, (currentTime / duration) * 100)));
      } else if (data.type === 'onStateChange') {
        const state = Number(data.value);
        if (state === 0) handleMediaEndedRef.current?.(currentVideo.id);
      } else if (data.type === 'onPlayerError') {
        const errorType = data.value?.errorType || 'playback error';
        addToast(`TikTok could not play this post (${errorType}). Try a public full video URL.`, 'warning');
      }
    };

    window.addEventListener('message', handleTikTokMessage);
    return () => window.removeEventListener('message', handleTikTokMessage);
  }, [currentVideo?.id, currentVideo?.videoId, currentVideo?.platform]);

  const handleMoveToWatchLater = (video) => {
    const isNowPlaying = video.status === 'playing';
    syncUpdateVideo(video.id, { status: 'watch_later', pinned: false });

    if (isNowPlaying) {
      const nextOne = videos
        .filter((item) => item.status === 'queue' && item.id !== video.id)
        .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : (a.timestamp || 0) - (b.timestamp || 0)))[0];
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

  const handleApprovePending = (video) => {
    syncUpdateVideo(video.id, { status: 'queue' });
    addToast(`Approved request from @${video.requestedBy}!`, 'success');
  };

  const handleRequeue = (video) => {
    syncUpdateVideo(video.id, {
      status: 'queue',
      timestamp: Date.now(),
      addedAt: 'Re-queued'
    });
    addToast(`Re-added "${video.title.slice(0, 24)}..." to active queue.`, 'info');
  };

  const handleTogglePin = (video) => {
    if (!isStaff) return;
    syncUpdateVideo(video.id, { pinned: !video.pinned });
    addToast(video.pinned ? 'Unpinned video' : 'Pinned priority to top of queue!', 'info');
  };

  const handleCategoryChange = (videoId, newCategory) => {
    syncUpdateVideo(videoId, { category: newCategory });
    addToast(`Category updated to "${newCategory}"`, 'success');
  };

  const handleUpvote = (videoId) => {
    if (votedIds[videoId]) {
      addToast('You have already hyped this request!', 'info');
      return;
    }
    setVotedIds((prev) => ({ ...prev, [videoId]: true }));
    const target = videos.find((v) => v.id === videoId);
    if (target) {
      syncIncrementUpvote(videoId);
      addToast('+1 Hype added to request!', 'success');
    }
  };

  handleUpvoteRef.current = handleUpvote;

  const handleMoveOrder = (videoId, direction) => {
    const list = filteredVideos;
    const index = list.findIndex((v) => v.id === videoId);
    if (index === -1) return;
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= list.length) return;

    const itemA = list[index];
    const itemB = list[targetIdx];

    syncUpdateVideo(itemA.id, { timestamp: itemB.timestamp });
    syncUpdateVideo(itemB.id, { timestamp: itemA.timestamp });
  };

  // Switch Broadcaster Room
  const handleSwitchRoom = (e) => {
    e.preventDefault();
    const clean = normalizeRoomName(roomInput);
    if (!clean) return;

    const savedVideos = readStoredValue(roomStorageKey(clean, 'videos'), null);
    const savedSettings = readStoredValue(roomStorageKey(clean, 'settings'), {});
    const savedVotes = readStoredValue(roomStorageKey(clean, 'votes'), {});

    setChannelRoom(clean);
    setRoomInput(clean);
    setVideos(Array.isArray(savedVideos) ? savedVideos.filter((video) => !String(video?.id || '').startsWith('demo-')) : INITIAL_DEMO_VIDEOS);
    setStreamSettings({ ...DEFAULT_STREAM_SETTINGS, ...(savedSettings && typeof savedSettings === 'object' ? savedSettings : {}) });
    setVotedIds(savedVotes && typeof savedVotes === 'object' ? savedVotes : {});
    writeStoredValue(`${STORAGE_PREFIX}:active-room`, clean);
    addToast(`Switched Live Hub to broadcaster room: twitch.tv/${clean}`, 'info');
    if (ircConnected) connectTwitchIrc(clean);
  };

  // ==========================================
  // RENDER OBS OVERLAY HUD (POP-OUT MODE)
  // ==========================================
  if (showObsOverlay) {
    return (
      <div className="fixed inset-0 bg-[#090a0f] text-white p-6 flex flex-col justify-between font-sans select-none overflow-hidden border-4 border-purple-500/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 bg-[#18181b]/90 backdrop-blur-md px-3.5 py-1.5 rounded-xl border border-white/10 shadow-lg">
            <Radio className="w-4 h-4 text-purple-400 animate-pulse" />
            <span className="text-xs font-bold uppercase tracking-wider text-purple-300">
              OBS Stream Deck Capture • twitch.tv/{channelRoom}
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
              {videos.filter((v) => v.status === 'queue')[0]?.title || 'Loading next item...'}
            </span>
          ) : (
            <span className="text-xs text-slate-400">Queue is empty. Type !assr &lt;url&gt; in Twitch chat!</span>
          )}
        </div>
      </div>
    );
  }

  // ==========================================
  // MAIN APP INTERFACE
  // ==========================================
  return (
    <div className="min-h-screen bg-[#090a0f] text-slate-100 flex flex-col font-sans selection:bg-purple-600 selection:text-white">
      {/* ==========================================
          HEADER: BROADCASTER IDENTITY & SYNC STATUS
          ========================================== */}
      <header className="sticky top-0 z-40 bg-[#0e121a]/95 backdrop-blur-md border-b border-slate-800/80 px-4 lg:px-6 py-2.5">
        <div className="max-w-[1680px] mx-auto flex flex-wrap items-center justify-between gap-3">
          {/* Logo & Channel Room Selector */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-purple-600 via-indigo-600 to-cyan-400 flex items-center justify-center shadow-lg shadow-purple-600/30">
              <Tv className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-base tracking-tight bg-gradient-to-r from-white via-purple-100 to-cyan-200 bg-clip-text text-transparent">
                  StreamPulse
                </span>
                <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  LIVE HUB
                </span>
              </div>

              {/* Channel Room Form */}
              <form onSubmit={handleSwitchRoom} className="flex items-center gap-1 mt-0.5">
                <span className="text-[11px] text-slate-400 font-medium">twitch.tv/</span>
                <input
                  type="text"
                  value={roomInput}
                  onChange={(e) => setRoomInput(e.target.value)}
                  className="bg-transparent text-[11px] font-bold text-purple-300 hover:text-purple-200 border-b border-dashed border-purple-500/50 focus:border-purple-400 focus:outline-none w-24 sm:w-28 transition-colors"
                  title="Press enter to switch Broadcaster Room"
                />
              </form>
            </div>
          </div>

          {/* Sync & Mode Badges */}
          <div className="hidden xl:flex items-center gap-2.5 bg-[#141926] border border-slate-800 rounded-xl px-3.5 py-1.5 text-xs">
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${cloudSynced ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
              <span className="text-slate-300 font-medium">{syncStatusText}</span>
            </span>

            <span className="text-slate-600">|</span>

            {/* Stream Mode Indicator */}
            <span className="flex items-center gap-1 text-slate-400">
              <span>Mode:</span>
              <strong className="text-purple-300 capitalize">
                '🌐 All Media (Unfiltered)'
              </strong>
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

            {/* Request Video Modal Trigger */}
            <button
              onClick={() => setShowRequestModal(true)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold text-xs shadow-lg shadow-purple-600/30 active:scale-95 transition-all"
            >
              <Plus className="w-4 h-4" />
              <span>Request</span>
            </button>

            {/* Quick Role Switcher (For live testing Broadcaster vs Mod vs Viewer) */}
            <div className="hidden md:flex items-center bg-[#141926] p-1 rounded-xl border border-slate-800">
              {[
                { id: 'streamer', label: 'Broadcaster', icon: Shield },
                { id: 'moderator', label: 'Mod', icon: UserCheck },
                { id: 'viewer', label: 'Chatter', icon: Users }
              ].map((r) => {
                const Icon = r.icon;
                const active = twitchAuth.role === r.id;
                return (
                  <button
                    key={r.id}
                    onClick={() => {
                      setTwitchAuth((prev) => ({ ...prev, role: r.id }));
                      addToast(`Switched active view role to: ${r.label}`, 'info');
                    }}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                      active
                        ? 'bg-purple-600/30 text-purple-200 border border-purple-500/40 shadow-sm'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{r.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Streamer Settings Gear */}
            {isStaff && (
              <button
                onClick={() => setShowSettingsModal(true)}
                className="p-2 rounded-xl bg-[#141926] hover:bg-slate-800 text-slate-300 border border-slate-800 transition-colors"
                title="Queue Rules & Streamer Safety"
              >
                <Settings className="w-4 h-4" />
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
                <div className="text-xs font-bold text-slate-200 leading-none">{twitchAuth.displayName}</div>
                <div className="text-[10px] text-purple-400 capitalize">{twitchAuth.role}</div>
              </div>
            </button>

            {/* Toggle Twitch Chat Sidebar */}
            <button
              onClick={() => setChatOpen(!chatOpen)}
              className={`p-2 rounded-xl border transition-colors ${
                chatOpen
                  ? 'bg-purple-600/20 border-purple-500/40 text-purple-300'
                  : 'bg-[#141926] border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
              title="Toggle Twitch Chat Panel"
            >
              <MessageSquare className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* ==========================================
          MAIN WORKSPACE: PLAYER + QUEUE + CHAT
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
                  LIVE NOW PLAYING
                </span>

                {currentVideo && (
                  <>
                    <span className={`px-2 py-0.5 rounded-lg font-bold border ${CATEGORY_META[currentVideo.category]?.badgeBg || 'bg-slate-800 text-slate-300'}`}>
                      {currentVideo.category}
                    </span>
                    <span className="px-2 py-0.5 rounded-lg bg-slate-800/80 text-slate-300 border border-slate-700 capitalize">
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
                  className={`relative w-full bg-black flex items-center justify-center transition-all ${
                    isTheatreMode ? 'h-[440px] sm:h-[560px]' : 'h-[320px] sm:h-[390px]'
                  }`}
                >
                  {currentVideo.platform === 'youtube' && currentVideo.videoId ? (
                    <div ref={youtubePlayerContainerRef} className="w-full h-full" />
                  ) : currentVideo.platform === 'tiktok' && /^\d{10,25}$/.test(String(currentVideo.videoId || '')) ? (
                    <iframe
                      key={`tiktok-${currentVideo.videoId}`}
                      ref={tiktokIframeRef}
                      className="w-full h-full border-0"
                      src={`https://www.tiktok.com/player/v1/${currentVideo.videoId}?autoplay=1&controls=1&progress_bar=1&play_button=1&volume_control=1&timestamp=1&description=1&music_info=1&rel=0`}
                      title={currentVideo.title}
                      allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                      allowFullScreen
                    />
                  ) : currentVideo.platform === 'tiktok' ? (
                    <div className="max-w-lg p-8 text-center space-y-3">
                      <div className="text-cyan-300 font-bold">TikTok link needs a full video URL</div>
                      <p className="text-sm text-slate-300">This looks like a shortened TikTok link. Open it, then copy the full address containing <code>/video/</code> and submit that link so StreamPulse can extract the post ID.</p>
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

                    {/* Hype / Upvote */}
                    <button
                      onClick={() => handleUpvote(currentVideo.id)}
                      className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border transition-all ${
                        votedIds[currentVideo.id]
                          ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                          : 'bg-[#181e2e] hover:bg-slate-800 border-slate-700 text-slate-200'
                      }`}
                    >
                      <Flame className="w-4 h-4 text-amber-400" />
                      <span>Hype ({currentVideo.upvotes || 0})</span>
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

                    {/* Skip / Next Track */}
                    {isStaff && (
                      <button
                        onClick={handleSkipNext}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-bold shadow-lg shadow-emerald-600/20 transition-all active:scale-95"
                      >
                        <SkipForward className="w-4 h-4" />
                        <span>Next Track</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-12 text-center space-y-3">
                <ListVideo className="w-12 h-12 text-slate-600 mx-auto" />
                <h3 className="text-base font-bold text-slate-300">Queue is currently empty</h3>
                <p className="text-xs text-slate-500 max-w-md mx-auto">
                  Type <code className="text-purple-400 font-mono">!assr &lt;url&gt;</code> in Twitch chat or click Request Video above to add media!
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
                  { id: 'watched', label: 'History', icon: CheckCircle2, count: counts.watched, badge: 'bg-emerald-500/20 text-emerald-300' },
                  { id: 'pending', label: 'Mod Approval', icon: ShieldAlert, count: counts.pending, badge: 'bg-amber-500/20 text-amber-300' }
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
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="bg-[#151a27] border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-purple-500"
              >
                <option value="priority">Sort: FIFO / Priority</option>
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
                    Switch tabs or submit a new YouTube, Twitch Clip, or TikTok link!
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
                            <span className="text-xs font-mono font-bold text-slate-500">#{idx + 1}</span>
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
                              e.target.src = 'https://placehold.co/640x360/18181b/a1a1aa?text=StreamPulse';
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

                      {/* Right: Moderation & Control Buttons */}
                      <div className="flex flex-wrap items-center gap-1.5 self-end sm:self-center shrink-0">
                        {/* Hype Vote */}
                        <button
                          onClick={() => handleUpvote(video.id)}
                          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-bold border transition-all ${
                            votedIds[video.id]
                              ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                              : 'bg-[#181e2e] hover:bg-slate-800 border-slate-700/80 text-slate-300'
                          }`}
                          title="Hype Up Request"
                        >
                          <ThumbsUp className="w-3.5 h-3.5" />
                          <span>{video.upvotes || 0}</span>
                        </button>

                        {/* Mod Approval Mode specific buttons */}
                        {video.status === 'pending' && isStaff && (
                          <>
                            <button
                              onClick={() => handleApprovePending(video)}
                              className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-colors"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>Approve</span>
                            </button>
                            <button
                              onClick={() => syncDeleteVideo(video.id)}
                              className="p-1.5 rounded-xl bg-rose-600/20 text-rose-300 border border-rose-500/30 hover:bg-rose-600/30"
                              title="Reject Request"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </>
                        )}

                        {/* Standard Queue Buttons */}
                        {video.status !== 'pending' && (
                          <>
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
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>

        {/* ==========================================
            RIGHT COLUMN: REAL TWITCH IRC CHAT & !SR FEED
            ========================================== */}
        {chatOpen && (
          <aside className="w-full lg:w-[380px] xl:w-[410px] shrink-0 flex flex-col bg-[#10141f] border border-slate-800/90 rounded-2xl overflow-hidden shadow-2xl h-[620px] lg:h-[calc(100vh-100px)] lg:sticky lg:top-20">
            {/* Chat top header */}
            <div className="p-3 bg-[#141926] border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-purple-400" />
                <span className="text-xs font-extrabold uppercase tracking-wider text-slate-200">
                  Twitch Chat & !assr Bridge
                </span>
              </div>

              <span className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-300">Twitch messages only</span>
            </div>

            {/* Twitch IRC WebSocket Connection Pill */}
            <div className="px-3 py-2 bg-[#0d1017] border-b border-slate-800/80 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Direct Twitch WebSocket IRC:</span>
                {ircConnected ? (
                  <span className="text-emerald-400 font-bold flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                    Connected
                  </span>
                ) : (
                  <span className="text-slate-500">Idle</span>
                )}
              </div>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={ircChannel || channelRoom}
                  onChange={(e) => setIrcChannel(e.target.value)}
                  placeholder="channel (e.g. pokimane)"
                  className="flex-1 bg-[#141926] border border-slate-800 rounded-lg px-2.5 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-purple-500"
                />
                {ircConnected ? (
                  <button
                    onClick={disconnectTwitchIrc}
                    className="px-2.5 py-1 rounded-lg bg-rose-600/20 text-rose-300 border border-rose-500/30 text-xs font-bold"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    onClick={() => connectTwitchIrc(ircChannel || channelRoom)}
                    className="px-2.5 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold transition-colors"
                  >
                    Connect IRC
                  </button>
                )}
              </div>
            </div>

            {/* Chat Message Scroll Box */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
              {chatMessages.length === 0 ? (
                <div className="h-full min-h-32 flex flex-col items-center justify-center gap-2 text-center text-slate-500 px-5">
                  <MessageSquare className="h-7 w-7 opacity-50" />
                  <p className="font-semibold text-slate-300">No live chat messages yet</p>
                  <p>{ircConnected ? 'Waiting for messages from real Twitch accounts…' : 'Connect to Twitch IRC to display actual channel messages. Simulated messages are disabled.'}</p>
                </div>
              ) : chatMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`p-2 rounded-xl leading-relaxed break-words ${
                    msg.isSystem
                      ? 'bg-purple-950/30 border border-purple-500/30 text-purple-200'
                      : msg.isCommand
                      ? 'bg-emerald-950/20 border border-emerald-500/30 text-slate-100'
                      : 'hover:bg-white/[0.02]'
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {msg.role === 'streamer' && (
                      <span className="px-1.5 py-0.2 rounded bg-red-500/20 text-red-400 text-[9px] font-extrabold uppercase">
                        BROADCASTER
                      </span>
                    )}
                    {msg.role === 'moderator' && (
                      <span className="px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 text-[9px] font-extrabold uppercase">
                        MOD
                      </span>
                    )}
                    {msg.role === 'vip' && (
                      <span className="px-1.5 py-0.2 rounded bg-pink-500/20 text-pink-400 text-[9px] font-extrabold uppercase">
                        VIP
                      </span>
                    )}
                    {msg.role === 'subscriber' && (
                      <span className="px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300 text-[9px] font-extrabold uppercase">
                        SUB
                      </span>
                    )}
                    <span className="font-extrabold" style={{ color: msg.color || '#c084fc' }}>
                      {msg.username}:
                    </span>
                    <span className="text-[10px] text-slate-500 ml-auto">{msg.time}</span>
                  </div>
                  <p className="text-slate-200">{msg.text}</p>
                </div>
              ))}
              <div ref={chatBottomRef} />
            </div>

            <div className="p-3 bg-[#141926] border-t border-slate-800 text-[11px] leading-relaxed text-slate-400">
              <p>Read-only live chat. To send a message or a request command, use Twitch chat itself. Messages shown here come from the connected Twitch channel; common bot accounts are filtered.</p>
              <p className="mt-1 text-slate-500">Commands: !assr &lt;url&gt;, !hype, !skip (staff), !volup/!voldown, !volume up/down or !volume 0-100, !mute/!unmute (staff; platform support varies)</p>
            </div>
          </aside>
        )}
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
                  <h3 className="text-base font-bold text-white">Submit Media Request</h3>
                  <p className="text-xs text-slate-400">Broadcaster Room: twitch.tv/{channelRoom}</p>
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
              onSubmit={(e) => {
                e.preventDefault();
                if (!reqUrl.trim()) return;
                const ok = processAndQueueRequest({
                  url: reqUrl,
                  title: reqTitle,
                  note: reqNote,
                  requestedBy: reqUsername || twitchAuth.username,
                  userRole: twitchAuth.role,
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
                  placeholder="https://www.youtube.com/watch?v=... or clips.twitch.tv/..."
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
                  Add Request to Hub
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
                <div className="w-9 h-9 rounded-xl bg-purple-600/20 border border-purple-500/40 flex items-center justify-center text-purple-300">
                  <Shield className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Twitch Account & Roles</h3>
                  <p className="text-xs text-slate-400">Broadcaster & Moderator Credentials</p>
                </div>
              </div>
              <button
                onClick={() => setShowAuthModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div>
                <label className="block font-bold text-slate-300 mb-1">Twitch Channel Username</label>
                <input
                  type="text"
                  value={twitchAuth.username}
                  onChange={(e) =>
                    setTwitchAuth({
                      ...twitchAuth,
                      username: e.target.value,
                      displayName: e.target.value,
                      avatarLetter: (e.target.value[0] || 'T').toUpperCase()
                    })
                  }
                  className="w-full bg-[#0d1017] border border-slate-800 rounded-xl px-3.5 py-2 text-white"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-300 mb-1">Access Role Permission</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'streamer', label: 'Broadcaster', desc: 'Full Deck Control' },
                    { id: 'moderator', label: 'Moderator', desc: 'Approve & Reorder' },
                    { id: 'viewer', label: 'Chat Viewer', desc: 'Request & Vote' }
                  ].map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setTwitchAuth({ ...twitchAuth, role: r.id })}
                      className={`p-2.5 rounded-xl border text-left transition-all ${
                        twitchAuth.role === r.id
                          ? 'bg-purple-600/30 border-purple-500 text-white'
                          : 'bg-[#0d1017] border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <div className="font-bold text-xs">{r.label}</div>
                      <div className="text-[10px] text-slate-500">{r.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Complete User ID Display (MANDATORY REQUIREMENT) */}
              <div className="p-3 bg-[#0d1017] border border-slate-800 rounded-xl space-y-1">
                <span className="text-[10px] uppercase font-bold text-slate-500">Firebase User Session ID:</span>
                <div className="font-mono text-[11px] text-purple-300 break-all select-all">
                  {firebaseUser?.uid || 'offline-simulated-session-user'}
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                onClick={() => {
                  setShowAuthModal(false);
                  addToast(`Logged in as @${twitchAuth.displayName} (${twitchAuth.role})`, 'success');
                }}
                className="px-5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold"
              >
                Save & Continue
              </button>
            </div>
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
                <div className="font-bold text-emerald-300">Unfiltered media requests</div>
                <p className="text-[11px] text-slate-400">All platforms and categories are accepted while the queue is open. Categories are labels only; subscriber-only, platform, and stream-mode filters are disabled.</p>
              </div>

              {[
                { key: 'queueOpen', label: 'Accepting New Requests', desc: 'Allow !assr chat requests and web submissions' },
                { key: 'requireApproval', label: 'Require Moderator Approval', desc: 'Accepted requests go to Pending Approval until approved' },
                { key: 'autoPlayNext', label: 'Auto-Advance to Next Video', desc: 'Automatically skip to next item when finished where the player exposes an ended event' }
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
                    onChange={(e) =>
                      setStreamSettings({ ...streamSettings, [item.key]: e.target.checked })
                    }
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