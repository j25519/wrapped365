/* Wrapped 365 — STAY WRAPPED ALL YEAR. */
(() => {
  'use strict';

  const MIN_PLAY_MS = 30_000;
  const MAX_ENTRY_UNCOMPRESSED = 180 * 1024 * 1024;
  const MAX_TOTAL_UNCOMPRESSED = 2 * 1024 * 1024 * 1024;
  const DB_NAME = 'wrapped365-listening-reports';
  const DB_VERSION = 2;
  const SOUNDCHECK_KEY = 'wrapped365_soundcheck_unlocked';
  const COOKIE_NAME = 'wrapped365_browser_id';
  const THEME_KEY = 'wrapped365_accent_theme';
  const THEMES = new Set(['green', 'blue', 'red', 'purple', 'pink', 'gold']);
  let themeTimer;
  const formatter = new Intl.NumberFormat('en-GB');
  const dateFormatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ERA_SPARK_ICON = '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="display:inline-block;vertical-align:middle"><path d="M12 2v5m0 10v5M2 12h5m10 0h5M4.93 4.93l3.54 3.54m7.06 7.06 3.54 3.54m0-14.14-3.54 3.54m-7.06 7.06-3.54 3.54"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>';
  const views = ['home', 'overview', 'artists', 'tracks', 'albums', 'playlists', 'eras', 'patterns', 'search', 'history', 'soundcheck'];
  const $ = id => document.getElementById(id);
  const state = { owner: null, db: null, report: null, soundcheckUnlocked: false, soundcheckSelected: null, soundcheckDisplayed: null, view: 'home', year: 'all', count: 25, sorts: { artists: 'plays', tracks: 'plays', albums: 'plays' }, playlistSelection: null, loading: false, eras: { month: null, sort: 'plays', limits: { artists: 8, tracks: 10, albums: 8 } }, eraHistory: null, eraChaptersCache: null, search: { query: '', filter: 'all', selected: null, matches: [], limit: 30 } };
  const navigationStack = [];
  const pageNames = { home: 'Home', overview: 'Overview', artists: 'Artists', tracks: 'Tracks', albums: 'Albums', playlists: 'Playlists', eras: 'Eras', patterns: 'Listening patterns', search: 'Search', history: 'Saved reports', soundcheck: 'Soundcheck' };

  function saveNavigation() {
    navigationStack.push({
      view: state.view, year: state.year, count: state.count, sorts: { ...state.sorts }, playlistSelection: state.playlistSelection,
      eras: { month: state.eras.month, sort: state.eras.sort, limits: { ...state.eras.limits } },
      search: { query: state.search.query, filter: state.search.filter, selected: state.search.selected && { ...state.search.selected }, limit: state.search.limit },
      listings: Object.fromEntries(['artists', 'tracks', 'albums'].map(type => [type, $(type.slice(0, -1) + '-search').value])),
      scrollY: window.scrollY
    });
    if (navigationStack.length > 80) navigationStack.shift();
    updateBackButton();
  }

  function updateBackButton() { $('nav-back').classList.toggle('hidden', navigationStack.length === 0); }

  function goBack() {
    const previous = navigationStack.pop();
    if (!previous) return;
    state.year = previous.year;
    state.count = previous.count;
    state.sorts = previous.sorts;
    state.playlistSelection = previous.playlistSelection;
    state.eras = previous.eras;
    state.search = { ...previous.search, matches: [] };
    $('year-filter').value = state.year;
    $('unified-search').value = state.search.query;
    $('search-filter').value = state.search.filter;
    for (const [type, query] of Object.entries(previous.listings)) $(type.slice(0, -1) + '-search').value = query;
    closeMobileActions();
    openView(previous.view, false);
    updateBackButton();
    requestAnimationFrame(() => window.scrollTo({ top: previous.scrollY, behavior: 'instant' }));
  }


  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const number = value => formatter.format(Math.round(value || 0));
  const hours = ms => (ms / 3_600_000).toLocaleString('en-GB', { maximumFractionDigits: 1 });
  const duration = ms => {
    const n = Math.round((ms || 0) / 60000);
    if (n < 60) return `${number(n)} min`;
    return `${number(Math.floor(n / 60))} hr ${number(n % 60)} min`;
  };
  const dateLabel = timestamp => timestamp ? dateFormatter.format(new Date(timestamp)) : 'Unknown';
  const keyOf = (...parts) => parts.map(x => String(x || '').trim().normalize('NFC').toLocaleLowerCase('en-GB')).join('\u001f');
  const percent = (a, b) => b ? `${Math.round(a * 100 / b)}%` : '—';
  const sleep = () => new Promise(resolve => setTimeout(resolve, 0));
  const platformGroup = raw => {
    if (!raw) return 'Unknown device';
    const value = raw.toLowerCase();
    if (/web.?player|browser|web browser/.test(value)) return 'Web player';
    if (/chromecast|google cast/.test(value)) return 'Chromecast';
    if (/android.?tv|google.?tv/.test(value)) return 'Android TV';
    if (/android/.test(value)) return 'Android';
    if (/iphone|ipad|ios/.test(value)) return 'iOS / iPadOS';
    if (/macos|os x|mac os|osx/.test(value)) return 'macOS';
    if (/windows/.test(value)) return 'Windows';
    if (/linux/.test(value)) return 'Linux';
    if (/xbox/.test(value)) return 'Xbox';
    if (/apple.?tv|tvos/.test(value)) return 'Apple TV';
    if (/sonos/.test(value)) return 'Sonos';
    if (/alexa|echo/.test(value)) return 'Alexa / Echo';
    return raw;
  };
  const uuid = () => crypto.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });

  function getOwner() {
    const found = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE_NAME}=`));
    let id = found?.split('=')[1];
    if (!/^[a-f0-9-]{36}$/.test(id || '')) {
      // file:// pages don't consistently support cookies. Only on file:// is
      // localStorage a fallback; on HTTP(S) the cookie is authoritative.
      if (location.protocol === 'file:') {
        try { id = localStorage.getItem(COOKIE_NAME); } catch { /* blocked */ }
      }
      if (!/^[a-f0-9-]{36}$/.test(id || '')) id = uuid();
    }
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${COOKIE_NAME}=${id}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
    if (location.protocol === 'file:') {
      try { localStorage.setItem(COOKIE_NAME, id); } catch { /* optional fallback */ }
    }
    return id;
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB is unavailable in this browser.'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('reports')) {
          const store = db.createObjectStore('reports', { keyPath: 'id' });
          store.createIndex('owner', 'owner', { unique: false });
        }
        if (!db.objectStoreNames.contains('soundchecks')) {
          const checks = db.createObjectStore('soundchecks', { keyPath: 'id' });
          checks.createIndex('owner', 'owner', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Browser report storage is blocked by another open tab.'));
    });
  }
  function dbRequest(tx, req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error || new Error('Browser storage transaction failed.'));
    });
  }
  async function saveReport(report) {
    if (!state.db) throw new Error('Browser storage is unavailable.');
    const tx = state.db.transaction('reports', 'readwrite');
    await dbRequest(tx, tx.objectStore('reports').put({ id: report.id, owner: state.owner, report }));
  }
  async function saveSoundcheck(diagnostic) {
    if (!state.db) throw new Error('Browser storage is unavailable.');
    const tx = state.db.transaction('soundchecks', 'readwrite');
    await dbRequest(tx, tx.objectStore('soundchecks').put({ id: diagnostic.id, owner: state.owner, diagnostic }));
  }
  async function deleteSoundchecks(reportId = null) {
    if (!state.db) return;
    const tx = state.db.transaction('soundchecks', 'readonly');
    const records = await dbRequest(tx, tx.objectStore('soundchecks').index('owner').getAll(state.owner));
    for (const record of records) {
      if (reportId !== null && record.diagnostic?.reportId !== reportId) continue;
      const deletion = state.db.transaction('soundchecks', 'readwrite');
      await dbRequest(deletion, deletion.objectStore('soundchecks').delete(record.id));
    }
  }
  async function clearAllSoundcheckData() {
    if (!state.db) return;
    await new Promise((resolve, reject) => {
      const tx = state.db.transaction(['soundchecks', 'reports'], 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Could not clear Soundcheck diagnostics.'));
      tx.onabort = () => reject(tx.error || new Error('Could not clear Soundcheck diagnostics.'));
      const clearHistory = tx.objectStore('soundchecks').index('owner').openCursor(IDBKeyRange.only(state.owner));
      clearHistory.onsuccess = () => {
        const cursor = clearHistory.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      const clearAttachments = tx.objectStore('reports').index('owner').openCursor(IDBKeyRange.only(state.owner));
      clearAttachments.onsuccess = () => {
        const cursor = clearAttachments.result;
        if (!cursor) return;
        if (cursor.value.report?.soundcheck) {
          const saved = cursor.value;
          delete saved.report.soundcheck;
          cursor.update(saved);
        }
        cursor.continue();
      };
    });
  }
  async function listSoundchecks() {
    if (!state.db) return [];
    const tx = state.db.transaction('soundchecks', 'readonly');
    const saved = await dbRequest(tx, tx.objectStore('soundchecks').index('owner').getAll(state.owner));
    return saved.map(row => row.diagnostic).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 150);
  }
  async function loadReport(id) {
    if (!state.db) return null;
    const tx = state.db.transaction('reports', 'readonly');
    const item = await dbRequest(tx, tx.objectStore('reports').get(id));
    return item?.owner === state.owner ? item.report : null;
  }
  async function listReports() {
    if (!state.db) return [];
    const tx = state.db.transaction('reports', 'readonly');
    const records = await dbRequest(tx, tx.objectStore('reports').index('owner').getAll(state.owner));
    return records.map(row => ({ ...row.report, periods: undefined }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function removeReport(id) {
    if (!state.db) return;
    const tx = state.db.transaction('reports', 'readwrite');
    const existing = await dbRequest(tx, tx.objectStore('reports').get(id));
    if (existing?.owner !== state.owner) return;
    const tx2 = state.db.transaction('reports', 'readwrite');
    await dbRequest(tx2, tx2.objectStore('reports').delete(id));
  }

  function emptyPeriod() {
    return {
      qualified: 0, allEvents: 0, ms: 0, firstTs: null, lastTs: null,
      activeDays: new Set(), months: new Map(), hourly: Array(24).fill(0),
      byWeekday: Array(7).fill(0), heat: Array.from({ length: 7 }, () => Array(24).fill(0)),
      shuffleYes: 0, shuffleKnown: 0, skipYes: 0, skipKnown: 0, offlineYes: 0, offlineKnown: 0,
      platforms: new Map(), artists: new Map(), tracks: new Map(), albums: new Map()
    };
  }
  function makeBuilder() {
    return { periods: new Map([['all', emptyPeriod()]]), monthPeriods: new Map(), seen: new Set(), imported: 0, duplicates: 0, ignored: 0, short: 0, sourceFiles: 0, checks: { episodes: 0, missingMetadata: 0, invalidDate: 0, invalidDuration: 0, malformed: 0, inferredArtists: new Set(), inferredTrackKeys: new Set(), rawTrackVariants: new Set(), scannedTrackKeys: new Set() } };
  }
  // Extended Streaming History normally provides one album artist string.
  // Preserve additional credits when a source actually provides an artist list;
  // never split arbitrary comma separated names (e.g. Tyler, the Creator).
  function creditedNames(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.map(entry => typeof entry === 'string' ? entry :
      entry && typeof entry === 'object' ? (entry.name ?? entry.artistName ?? entry.artist_name) : '')
      .filter(name => typeof name === 'string').map(name => name.trim())
      .filter(name => { const key = keyOf(name); if (!name || seen.has(key)) return false; seen.add(key); return true; });
  }
  // Infer additional artist credits from explicit textual attribution, not arbitrary
  // punctuation in a name. Spotify's standard history only supplies an album artist.
  // This is intentionally conservative and requires a feature/with marker.
  const featureMarker = String.raw`(?:feat(?:uring)?[.:]?|ft[.:]?|f\/|with|w\/)`;
  const featureOnlyMarker = String.raw`(?:feat(?:uring)?[.:]?|ft[.:]?|f\/)`;
  const bracketFeature = new RegExp(String.raw`[\(\[]\s*${featureMarker}\s*([^)\]]+)\s*[\)\]]`, 'gi');
  const dashFeature = new RegExp(String.raw`\s+[-–—]\s*${featureMarker}\s+(.+)$`, 'i');
  const bareFeature = new RegExp(String.raw`\s+${featureOnlyMarker}\s+(.+)$`, 'i');
  const artistWithFeature = new RegExp(String.raw`^(.+?)\s*[\(\[]\s*${featureMarker}\s+([^)\]]+)\s*[\)\]]$`, 'i');
  const artistWithBareFeature = new RegExp(String.raw`^(.+?)\s+(?:${featureOnlyMarker}|[-–—]\s*${featureMarker})\s+(.+)$`, 'i');

  function namesFromFeature(value) {
    if (typeof value !== 'string') return [];
    // A final remix/edit label isn't a featured artist.
    const cleaned = value.trim().replace(/\s*[\(\[]\s*(?:remix|edit|remaster(?:ed)?|live|radio edit|explicit|clean)(?:\s+[^)\]]*)?[\)\]]\s*$/i, '')
      .replace(/^[\s:–—-]+|[\s:–—-]+$/g, '');
    if (!cleaned || cleaned.length > 160) return [];
    // Commas in names such as "Tyler, the Creator" are not separators.
    return creditedNames(cleaned.split(/\s+(?:&|and|x|×|\+|vs\.?)\s+|;\s*|,\s+(?!the\s|jr\.?\b|sr\.?\b)/i)
      .map(name => name.replace(/^[\s"“”']+|[\s"“”']+$/g, '').trim())
      .filter(name => name && name.length <= 90));
  }

  function featureCreditsFromTitle(title) {
    if (typeof title !== 'string') return [];
    const found = [];
    for (const match of title.matchAll(bracketFeature)) found.push(...namesFromFeature(match[1]));
    // Handle "Song - feat. X" and "Song ft. X" without square brackets.
    // Only inspect the suffix if no bracketed feature credit was identified.
    if (!found.length) {
      const match = title.match(dashFeature) || title.match(bareFeature);
      if (match) found.push(...namesFromFeature(match[1]));
    }
    return creditedNames(found);
  }

  function splitPrimaryArtist(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    const match = text.match(artistWithFeature) || text.match(artistWithBareFeature);
    if (!match) return { primary: text, featured: [] };
    const primary = match[1].replace(/[\s,–—-]+$/g, '').trim();
    const featured = namesFromFeature(match[2]);
    return primary && featured.length ? { primary, featured } : { primary: text, featured: [] };
  }
  const artistCredits = item => Array.isArray(item?.creditedArtists) && item.creditedArtists.length
    ? item.creditedArtists : item?.artist ? [item.artist] : [];
  const artistCreditLabel = item => artistCredits(item).join(', ');
  const recordKey = (category, item) => category === 'playlists' ? item.id : category === 'artists' ? keyOf(item.name) : keyOf(item.artist, item.name);

  function rankUpdate(map, key, item, ms) {
    let previous = map.get(key);
    if (!previous) { previous = { ...item, plays: 0, ms: 0 }; map.set(key, previous); }
    previous.plays++;
    previous.ms += ms;
    // Keep a valid Spotify link if an earlier row for this song lacked a URI.
    if (item.uri && !previous.uri) previous.uri = item.uri;
    if (item.creditedArtists?.length) {
      const credits = artistCredits(previous);
      const seen = new Set(credits.map(name => keyOf(name)));
      for (const name of item.creditedArtists) if (!seen.has(keyOf(name))) { credits.push(name); seen.add(keyOf(name)); }
      previous.creditedArtists = credits;
    }
  }
  function updatePeriod(period, play) {
    period.allEvents++;
    if (play.shuffle != null) { period.shuffleKnown++; if (play.shuffle) period.shuffleYes++; }
    if (play.skipped != null) { period.skipKnown++; if (play.skipped) period.skipYes++; }
    if (play.offline != null) { period.offlineKnown++; if (play.offline) period.offlineYes++; }
    if (play.ms < MIN_PLAY_MS) return;

    period.qualified++;
    period.ms += play.ms;
    if (!period.firstTs || play.ts < period.firstTs) period.firstTs = play.ts;
    if (!period.lastTs || play.ts > period.lastTs) period.lastTs = play.ts;
    period.activeDays.add(play.ts.slice(0, 10));
    const month = play.ts.slice(0, 7);
    period.months.set(month, (period.months.get(month) || 0) + play.ms);
    const date = new Date(play.ts);
    const hour = date.getUTCHours();
    const day = (date.getUTCDay() + 6) % 7;
    period.hourly[hour] += play.ms;
    period.byWeekday[day] += play.ms;
    period.heat[day][hour] += play.ms;
    const platform = platformGroup(play.platform);
    period.platforms.set(platform, (period.platforms.get(platform) || 0) + play.ms);
    for (const name of play.creditedArtists) rankUpdate(period.artists, keyOf(name), { name }, play.ms);
    rankUpdate(period.tracks, keyOf(play.artist, play.title), { name: play.title, artist: play.artist, creditedArtists: play.creditedArtists, album: play.album, uri: play.uri }, play.ms);
    if (play.album) rankUpdate(period.albums, keyOf(play.artist, play.album), { name: play.album, artist: play.artist }, play.ms);
  }
  function parseSpotifyDate(input) {
    if (typeof input !== 'string') return null;
    let value = input.trim();
    // Account data endTime can be "2024-12-10 21:31", implicitly UTC.
    if (/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(value)) value = value.replace(' ', 'T') + ':00Z';
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) value += ':00Z';
    if (!/^\d{4}-\d\d-\d\dT/.test(value)) return null;
    // Spotify records playback end time in UTC, including the basic export.
    if (!/(?:Z|[+-]\d\d:?\d\d)$/i.test(value)) value += 'Z';
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
    return new Date(timestamp).toISOString();
  }
  function readPlay(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    if (row.spotify_episode_uri || row.episode_name || row.episode_show_name || row.episodeName) return null;
    const rawArtist = row.master_metadata_album_artist_name ?? row.artistName;
    const listed = creditedNames(row.credited_artists ?? row.creditedArtists ?? row.artists ?? row.artist_names ?? row.artistNames ?? row.master_metadata_artists ?? (Array.isArray(rawArtist) ? rawArtist : null));
    const primarySource = typeof rawArtist === 'string' ? rawArtist : listed[0];
    const parsedArtist = splitPrimaryArtist(primarySource);
    const artist = parsedArtist.primary;
    const title = row.master_metadata_track_name ?? row.trackName;
    const album = row.master_metadata_album_album_name ?? row.albumName ?? '';
    const ms = Number(row.ms_played ?? row.msPlayed);
    const ts = parseSpotifyDate(row.ts ?? row.endTime);
    if (!artist || !title || !ts || !Number.isFinite(ms) || ms < 0) return null;
    const uri = /^spotify:track:[A-Za-z0-9]+$/.test(row.spotify_track_uri || '') ? row.spotify_track_uri : '';
    return {
      ts, ms, artist: String(artist).trim(),
      creditedArtists: creditedNames([artist, ...listed.filter(name => keyOf(name) !== keyOf(primarySource)),
        ...parsedArtist.featured, ...featureCreditsFromTitle(String(title))]),
      title: String(title).trim(),
      album: String(album).trim(), platform: typeof row.platform === 'string' ? row.platform.trim() : '', uri,
      skipped: typeof row.skipped === 'boolean' ? row.skipped : null,
      shuffle: typeof row.shuffle === 'boolean' ? row.shuffle : null,
      offline: typeof row.offline === 'boolean' ? row.offline : null,
      reasonStart: row.reason_start || '', reasonEnd: row.reason_end || ''
    };
  }
  async function ingest(builder, rows) {
    if (!Array.isArray(rows)) throw new Error('A history file does not contain a JSON array of playback events.');
    for (let i = 0; i < rows.length; i++) {
      if (i && i % 1500 === 0) await sleep();
      const play = readPlay(rows[i]);
      if (!play) {
        builder.ignored++;
        const row = rows[i];
        if (!row || typeof row !== 'object' || Array.isArray(row)) builder.checks.malformed++;
        else if (row.spotify_episode_uri || row.episode_name || row.episode_show_name || row.episodeName) builder.checks.episodes++;
        else if (!parseSpotifyDate(row.ts ?? row.endTime)) builder.checks.invalidDate++;
        else if (!Number.isFinite(Number(row.ms_played ?? row.msPlayed)) || Number(row.ms_played ?? row.msPlayed) < 0) builder.checks.invalidDuration++;
        else builder.checks.missingMetadata++;
        continue;
      }
      const duplicateKey = [play.ts, play.ms, play.uri || keyOf(play.artist, play.title), play.platform, play.reasonStart, play.reasonEnd].join('|');
      if (builder.seen.has(duplicateKey)) { builder.duplicates++; continue; }
      builder.seen.add(duplicateKey);
      builder.imported++;
      if (play.ms >= MIN_PLAY_MS) {
        builder.checks.rawTrackVariants.add(keyOf(play.artist, play.title, play.album));
        const trackKey = keyOf(play.artist, play.title);
        if (!builder.checks.scannedTrackKeys.has(trackKey)) {
          builder.checks.scannedTrackKeys.add(trackKey);
          const listed = creditedNames(rows[i].credited_artists ?? rows[i].creditedArtists ?? rows[i].artists ?? rows[i].artist_names ?? rows[i].artistNames ?? rows[i].master_metadata_artists);
          const known = new Set([play.artist, ...listed, ...splitPrimaryArtist(rows[i].master_metadata_album_artist_name ?? rows[i].artistName).featured].map(name => keyOf(name)));
          const inferred = featureCreditsFromTitle(play.title).filter(name => !known.has(keyOf(name)));
          if (inferred.length) builder.checks.inferredTrackKeys.add(trackKey);
          for (const name of inferred) builder.checks.inferredArtists.add(keyOf(name));
        }
      }
      if (play.ms < MIN_PLAY_MS) builder.short++;
      updatePeriod(builder.periods.get('all'), play);
      const year = play.ts.slice(0, 4);
      if (!builder.periods.has(year)) builder.periods.set(year, emptyPeriod());
      updatePeriod(builder.periods.get(year), play);
      // Preserve true monthly rankings for the Eras explorer (not just listening hours).
      const month = play.ts.slice(0, 7);
      if (!builder.monthPeriods.has(month)) builder.monthPeriods.set(month, emptyPeriod());
      updatePeriod(builder.monthPeriods.get(month), play);
    }
  }
  function periodToJSON(p) {
    return {
      qualified: p.qualified, allEvents: p.allEvents, ms: p.ms, firstTs: p.firstTs, lastTs: p.lastTs,
      activeDays: p.activeDays.size, months: [...p.months.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      hourly: p.hourly, byWeekday: p.byWeekday, heat: p.heat,
      shuffleYes: p.shuffleYes, shuffleKnown: p.shuffleKnown, skipYes: p.skipYes, skipKnown: p.skipKnown,
      offlineYes: p.offlineYes, offlineKnown: p.offlineKnown,
      platforms: [...p.platforms.entries()].sort((a, b) => b[1] - a[1]),
      artists: [...p.artists.values()].sort((a, b) => b.plays - a.plays),
      tracks: [...p.tracks.values()].sort((a, b) => b.plays - a.plays),
      albums: [...p.albums.values()].sort((a, b) => b.plays - a.plays)
    };
  }
  function monthToJSON(p) {
    return {
      qualified: p.qualified, allEvents: p.allEvents, ms: p.ms,
      firstTs: p.firstTs, lastTs: p.lastTs, activeDays: p.activeDays.size,
      skipYes: p.skipYes, skipKnown: p.skipKnown,
      artists: [...p.artists.values()].sort((a, b) => b.plays - a.plays || b.ms - a.ms),
      tracks: [...p.tracks.values()].sort((a, b) => b.plays - a.plays || b.ms - a.ms),
      albums: [...p.albums.values()].sort((a, b) => b.plays - a.plays || b.ms - a.ms)
    };
  }
  function finishBuilder(builder, filename, type, demo = false) {
    const periods = {};
    for (const [year, period] of builder.periods) periods[year] = periodToJSON(period);
    const monthDetails = {};
    for (const [month, data] of builder.monthPeriods) monthDetails[month] = monthToJSON(data);
    return {
      id: uuid(), createdAt: new Date().toISOString(), filename, type, isDemo: demo,
      imported: builder.imported, ignored: builder.ignored, duplicates: builder.duplicates,
      short: builder.short, files: builder.sourceFiles,
      firstTs: periods.all.firstTs, lastTs: periods.all.lastTs,
      years: Object.keys(periods).filter(x => x !== 'all').sort((a, b) => b.localeCompare(a)), periods, monthDetails
    };
  }

  // Spotify Account Data contains playlist *membership*, not evidence of playback.
  // Keep music entries in their exported order and leave duration unknown if absent.
  const validTrackUri = value => typeof value === 'string' && /^spotify:track:[A-Za-z0-9]+$/.test(value) ? value : '';
  const playlistFilename = name => /^Playlists?(?:[_-]?\d+)?\.json$/i.test(baseName(name));
  const isPlaylistDocument = data => !!data && !Array.isArray(data) &&
    Array.isArray(data.playlists);
  const playlistField = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';

  function importSpotifyPlaylists(document, collected) {
    if (!isPlaylistDocument(document)) throw new Error('Spotify playlist JSON must contain a playlists array.');
    const result = collected || { playlists: [], musicTracks: 0, skippedEpisodes: 0, skippedUnknown: 0, localTracks: 0 };
    if (document.playlists.length > 5000 || result.playlists.length + document.playlists.length > 5000)
      throw new Error('This export contains more than 5,000 playlists and cannot be imported in one go.');
    for (const source of document.playlists) {
      if (!source || typeof source !== 'object' || Array.isArray(source) || !Array.isArray(source.items))
        throw new Error('A Spotify playlist record is missing its items array.');
      const name = playlistField(source.name, 300);
      if (!name) throw new Error('A Spotify playlist has no name.');
      const tracks = [];
      for (let index = 0; index < source.items.length; index++) {
        const entry = source.items[index];
        if (!entry || typeof entry !== 'object') { result.skippedUnknown++; continue; }
        if (entry.episode || entry.audiobook) { result.skippedEpisodes++; continue; }
        const local = !entry.track && entry.localTrack;
        const original = local ? entry.localTrack : entry.track;
        if (!original) { result.skippedUnknown++; continue; }
        const raw = typeof original === 'string' ? { trackName: original } : original;
        const title = playlistField(raw.trackName ?? raw.name, 500);
        const artist = playlistField(raw.artistName ?? raw.artist, 400) || (local ? 'Unknown local artist' : '');
        if (!title || !artist) { result.skippedUnknown++; continue; }
        const album = playlistField(raw.albumName ?? raw.album, 400);
        const uri = local ? '' : validTrackUri(raw.trackUri ?? raw.uri);
        const durationMs = Number(raw.duration_ms ?? raw.durationMs);
        const seconds = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 1000) : null;
        const addedDate = /^\d{4}-\d{2}-\d{2}$/.test(entry.addedDate || '') ? entry.addedDate : '';
        tracks.push({ id: uri || `imported-track:${keyOf(artist, title, album)}`, title, name: title, artist,
          album, uri, seconds, position: index + 1, addedDate, local: !!local,
          creditedArtists: creditedNames([artist, ...featureCreditsFromTitle(title)]) });
        result.musicTracks++;
        if (local) result.localTracks++;
        if (result.musicTracks > 200000) throw new Error('Playlist export exceeds the 200,000 track safety limit.');
      }
      const exportedUri = playlistField(source.playlistUri ?? source.uri, 160);
      // The Account Data export normally omits playlist URIs. A per-report ID preserves playlists with identical names without merging their contents.
      const id = /^spotify:playlist:[A-Za-z0-9]+$/.test(exportedUri) ? exportedUri :
        `spotify-export:playlist:${result.playlists.length + 1}`;
      const lastModifiedDate = /^\d{4}-\d{2}-\d{2}$/.test(source.lastModifiedDate || '') ? source.lastModifiedDate : '';
      const followers = Number(source.numberOfFollowers);
      result.playlists.push({ id, source: 'spotify', name, tracks,
        description: playlistField(source.description, 3000), lastModifiedDate,
        followers: Number.isSafeInteger(followers) && followers >= 0 ? followers : null });
    }
    return result;
  }

  const baseName = name => name.split(/[\\/]/).pop() || '';
  const extendedName = name => /^(Streaming_History_Audio.*|endsong[_-].*)\.json$/i.test(baseName(name));
  const basicName = name => /^StreamingHistory(?:_music)?[_\d-]*\.json$/i.test(baseName(name));
  let appVersion = 'Unknown';
  const msElapsed = value => Math.round(Math.max(0, value) * 10) / 10;
  const startTrace = (type, fileBytes = null) => ({ type, started: performance.now(), stages: {}, fileBytes, files: 0, jsonBytes: 0 });
  const timeStage = (trace, name, began) => { trace.stages[name] = msElapsed((trace.stages[name] || 0) + performance.now() - began); };
  // Only derived, bounded version numbers are saved; never retain the raw user agent or the full User-Agent Client Hints response in a diagnostic.
  const cleanVersion = value => {
    const version = typeof value === 'string' ? value.replace(/_/g, '.') : '';
    return /^\d{1,3}(?:\.\d{1,4}){0,3}$/.test(version) ? version : null;
  };
  const userAgentVersion = (ua, pattern) => cleanVersion(ua.match(pattern)?.[1]);
  // A device model can be supplied by Android UA strings or Client Hints.
  // Keep only short, human readable model names, never a raw UA or build ID.
  const cleanDeviceModel = value => {
    if (typeof value !== 'string') return null;
    const model = value.trim().replace(/\s+/g, ' ');
    return model.length >= 2 && model.length <= 80 &&
      /^[\p{L}\p{N}][\p{L}\p{N} ._()+/\-]*$/u.test(model) &&
      !/^(?:unknown|generic|android|mobile|tablet|K)$/i.test(model) ? model : null;
  };
  const androidDeviceModel = ua => {
    // Older, unreduced Android UAs may expose the model after the OS version.
    // Locale, browser mode, and build identifiers aren't device models.
    const details = ua.match(/\bAndroid\s+[\d._]+\s*;\s*([^)]*)\)/i)?.[1];
    if (!details) return null;
    const fields = details.split(';').map(part => part.trim());
    for (let i = fields.length - 1; i >= 0; i--) {
      const field = fields[i].replace(/\s+Build\/.*$/i, '').trim();
      if (/^(?:K|U|wv|Mobile|Tablet|[a-z]{2}[-_][a-z]{2}|rv:[\d.]+)$/i.test(field)) continue;
      const model = cleanDeviceModel(field);
      if (model) return model;
    }
    return null;
  };
  // Specific browser signatures come before their Chromium/Firefox/Safari fallbacks.
  // Some privacy browsers intentionally expose only a generic browser identity (e.g. Vanadium on GrapheneOS).
  const SOUNDCHECK_BROWSER_TOKENS = [
    ['Edge', /(?:EdgiOS|EdgA|Edg)\/([\d.]+)/i],
    ['Opera GX', /(?:Opera[ _]GX|OPGX)\/([\d.]+)/i],
    ['Opera Mini', /Opera Mini\/([\d.]+)/i],
    ['Opera', /(?:OPiOS|OPR|Opera(?: Mobi| Tablet)?)\/([\d.]+)/i],
    ['Samsung Internet', /SamsungBrowser\/([\d.]+)/i],
    ['Vivaldi', /Vivaldi\/([\d.]+)/i],
    ['Brave', /Brave\/([\d.]+)/i],
    ['LibreWolf', /LibreWolf\/([\d.]+)/i],
    ['Waterfox', /Waterfox\/([\d.]+)/i],
    ['Floorp', /Floorp\/([\d.]+)/i],
    ['Zen Browser', /(?:ZenBrowser|Zen)\/([\d.]+)/i],
    ['Iceweasel', /Iceweasel\/([\d.]+)/i],
    ['GNU IceCat', /IceCat\/([\d.]+)/i],
    ['Pale Moon', /PaleMoon\/([\d.]+)/i],
    ['Basilisk', /Basilisk\/([\d.]+)/i],
    ['SeaMonkey', /SeaMonkey\/([\d.]+)/i],
    ['Firefox Focus', /(?:Focus|Klar)\/([\d.]+)/i],
    ['Fennec', /Fennec\/([\d.]+)/i],
    ['Mull', /Mull\/([\d.]+)/i],
    ['Cromite', /Cromite\/([\d.]+)/i],
    ['Thorium', /Thorium\/([\d.]+)/i],
    ['Iridium', /Iridium\/([\d.]+)/i],
    ['SRWare Iron', /(?:Iron|SRWareIron)\/([\d.]+)/i],
    ['Slimjet', /Slimjet\/([\d.]+)/i],
    ['DuckDuckGo', /(?:DuckDuckGo|DuckDuckGoBrowser|Ddg)\/([\d.]+)/i],
    ['Orion', /Orion\/([\d.]+)/i],
    ['Arc', /(?:ArcSearch|ArcBrowser|Arc)\/([\d.]+)/i],
    ['Yandex Browser', /YaBrowser\/([\d.]+)/i],
    ['UC Browser', /(?:UCBrowser|UCWEB)\/([\d.]+)/i],
    ['QQ Browser', /(?:MQQBrowser|QQBrowser)\/([\d.]+)/i],
    ['360 Browser', /(?:360(?:SE|EE|Browser)|QHBrowser|QihooBrowser)\/([\d.]+)/i],
    ['Sogou Explorer', /(?:SogouMobileBrowser|SogouBrowser|SE)\/([\d.]+)|\bMetaSr\b/i],
    ['Baidu Browser', /(?:BIDUBrowser|BaiduBrowser|BaiduHD)\/([\d.]+)/i],
    ['Quark', /Quark\/([\d.]+)/i],
    ['Huawei Browser', /(?:HuaweiBrowser|HuaweiBrowserMobile)\/([\d.]+)/i],
    ['MIUI Browser', /(?:MiuiBrowser|MiBrowser)\/([\d.]+)/i],
    ['Vivo Browser', /VivoBrowser\/([\d.]+)/i],
    ['HeyTap Browser', /(?:HeyTapBrowser|OppoBrowser)\/([\d.]+)/i],
    ['Maxthon', /(?:Maxthon|MxBrowser)\/([\d.]+)/i],
    ['Whale', /Whale\/([\d.]+)/i],
    ['Cốc Cốc', /(?:coc_coc_browser|CocCoc)\/([\d.]+)/i],
    ['Sleipnir', /Sleipnir\/([\d.]+)/i],
    ['Lunascape', /Lunascape\/([\d.]+)/i],
    ['Falkon', /(?:Falkon|QupZilla)\/([\d.]+)/i],
    ['GNOME Web', /Epiphany\/([\d.]+)/i],
    ['qutebrowser', /qutebrowser\/([\d.]+)/i],
    ['Konqueror', /Konqueror\/([\d.]+)/i],
    ['Midori', /Midori\/([\d.]+)/i],
    ['NetSurf', /NetSurf\/([\d.]+)/i],
    ['Otter Browser', /Otter\/([\d.]+)/i],
    ['Ladybird', /Ladybird\/([\d.]+)/i],
    ['Puffin', /Puffin\/([\d.]+)/i],
    ['Amazon Silk', /Silk\/([\d.]+)/i],
    ['Firefox', /(?:FxiOS|Firefox)\/([\d.]+)/i],
    ['Chromium', /Chromium\/([\d.]+)/i],
    ['Chrome', /(?:CriOS|Chrome)\/([\d.]+)/i],
    ['Safari', /Version\/([\d.]+)(?=[^\n]*Safari\/)/i]
  ];
  // Distributions are labelled only if literally named in the UA.
  // A generic "Linux x86_64" token never identifies Ubuntu, Arch, Fedora, etc.
  const SOUNDCHECK_LINUX_DISTROS = [
    ['CachyOS', /\bCachyOS\b(?:[\s/:-]+([\d._]+))?/i],
    ['EndeavourOS', /\bEndeavourOS\b(?:[\s/:-]+([\d._]+))?/i],
    ['Manjaro', /\bManjaro(?:Linux)?\b(?:[\s/:-]+([\d._]+))?/i],
    ['Arch Linux', /\bArch(?:\s+Linux|Linux)\b(?:[\s/:-]+([\d._]+))?/i],
    ['Linux Mint', /\b(?:Linux[\s/-]*Mint|MintLinux)\b(?:[\s/:-]+([\d._]+))?/i],
    ['Pop!_OS', /\bPop[!_\s-]*OS\b(?:[\s/:-]+([\d._]+))?/i],
    ['Ubuntu', /\bUbuntu\b(?:[\s/:-]+([\d._]+))?/i],
    ['Debian', /\bDebian\b(?:[\s/:-]+([\d._]+))?/i],
    ['Fedora', /\bFedora\b(?:[\s/:-]+([\d._]+))?/i],
    ['openSUSE', /\bopenSUSE\b(?:[\s/:-]+(?:Leap[\s/-]+)?([\d._]+))?/i],
    ['SUSE Linux Enterprise', /\b(?:SUSE Linux Enterprise|SLES)\b(?:[\s/:-]+([\d._]+))?/i],
    ['Red Hat Enterprise Linux', /\b(?:Red Hat Enterprise Linux|RHEL)\b(?:[\s/:-]+([\d._]+))?/i],
    ['Rocky Linux', /\bRocky(?:\s+Linux)?\b(?:[\s/:-]+([\d._]+))?/i],
    ['AlmaLinux', /\bAlmaLinux\b(?:[\s/:-]+([\d._]+))?/i],
    ['CentOS', /\bCentOS\b(?:[\s/:-]+([\d._]+))?/i],
    ['NixOS', /\bNixOS\b(?:[\s/:-]+([\d._]+))?/i],
    ['Gentoo', /\bGentoo\b(?:[\s/:-]+([\d._]+))?/i],
    ['Alpine Linux', /\bAlpine(?:\s+Linux)?\b(?:[\s/:-]+([\d._]+))?/i],
    ['Kali Linux', /\bKali(?:\s+Linux)?\b(?:[\s/:-]+([\d._]+))?/i],
    ['Raspberry Pi OS', /\b(?:Raspberry Pi OS|Raspbian)\b(?:[\s/:-]+([\d._]+))?/i],
    ['elementary OS', /\belementary[\s_-]*OS\b(?:[\s/:-]+([\d._]+))?/i],
    ['Zorin OS', /\bZorin(?:\s+OS)?\b(?:[\s/:-]+([\d._]+))?/i],
    ['KDE neon', /\bKDE[\s_-]*neon\b(?:[\s/:-]+([\d._]+))?/i],
    ['MX Linux', /\bMX[\s_-]*Linux\b(?:[\s/:-]+([\d._]+))?/i]
  ];
  function reportedArchitecture(ua) {
    if (/\b(?:x86_64|amd64|x64|Win64|WOW64)\b/i.test(ua)) return 'x86_64';
    if (/\b(?:aarch64|arm64)\b/i.test(ua)) return 'ARM64';
    if (/\b(?:armv7l|armv7|armv8l)\b/i.test(ua)) return 'ARM32';
    if (/\b(?:i[3-6]86|x86)\b/i.test(ua)) return 'x86';
    if (/\bppc64le\b/i.test(ua)) return 'ppc64le';
    if (/\bppc64\b/i.test(ua)) return 'ppc64';
    if (/\briscv64\b/i.test(ua)) return 'riscv64';
    if (/\bs390x\b/i.test(ua)) return 's390x';
    return null;
  }
  let environmentPromise = null;
  function browserEnvironment() {
    if (environmentPromise) return environmentPromise;
    environmentPromise = (async () => {
      const ua = navigator.userAgent || '';
      const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
      const match = SOUNDCHECK_BROWSER_TOKENS.find(([, pattern]) => pattern.test(ua));
      let browser = match?.[0] || 'Other';
      let browserVersion = match ? userAgentVersion(ua, match[1]) : null;
      const isAppleMobile = /iPhone|iPad|iPod/.test(ua) || touchMac;
      let os = /Android/.test(ua) ? 'Android' : touchMac || /iPad/.test(ua) ? 'iPadOS' : /iPhone|iPod/.test(ua) ? 'iOS'
        : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'Chrome OS'
        : /Linux/.test(ua) ? 'Linux' : 'Other';
      let osVersion = null;
      // Chromium's reduced UA reports "Android 10; K" on all Android versions. Neither 10 nor K describes the real device without Client Hints.
      const reducedAndroidUA = os === 'Android' && /\bAndroid\s+10(?:\.0(?:\.0)?)?\s*;\s*K(?=\s*[;)])/i.test(ua);
      if (os === 'Android' && !reducedAndroidUA) osVersion = userAgentVersion(ua, /Android\s+([\d._]+)/i);
      else if (isAppleMobile) osVersion = userAgentVersion(ua, /(?:CPU(?: iPhone)? OS|iPhone OS)\s+([\d._]+)/i);
      else if (os === 'Windows') {
        const nt = userAgentVersion(ua, /Windows NT\s+([\d.]+)/i);
        osVersion = ({ '6.1': '7', '6.2': '8', '6.3': '8.1' })[nt] || (nt === '10.0' ? '10 / 11' : null);
      } else if (os === 'macOS') {
        const detected = userAgentVersion(ua, /Mac OS X\s+([\d._]+)/i);
        // Safari/macOS commonly freeze this UA token at 10.15.7, even on newer macOS versions.
        if (detected && !detected.startsWith('10.15')) osVersion = detected;
      }
      let osVersionSource = osVersion ? 'userAgent' : null;
      // Safari 26+ deliberately freezes the iOS/iPadOS version in the UA at 18.6/18.7.
      // Its own major version usually tracks the OS major release, but is only an inference.
      const safariMajor = browser === 'Safari' ? Number(browserVersion?.split('.')[0]) : 0;
      if (isAppleMobile && safariMajor >= 26 &&
          (!osVersion || /^18\.(?:6|7)(?:\.|$)/.test(osVersion))) {
        osVersion = browserVersion;
        osVersionSource = 'inferredFromSafari';
      }
      let deviceClass = /iPad|Tablet|Android(?!.*Mobile)|touch/i.test(ua) && (os === 'Android' || os === 'iPadOS') ? 'Tablet'
        : /Mobile|iPhone|iPod|Android/.test(ua) ? 'Mobile' : 'Desktop';
      if (touchMac) deviceClass = 'Tablet';
      let deviceModel = os === 'Android' && !reducedAndroidUA ? androidDeviceModel(ua) : null;

      const distro = os === 'Linux' ? SOUNDCHECK_LINUX_DISTROS.find(([, pattern]) => pattern.test(ua)) : null;
      const distroMatch = distro ? ua.match(distro[1]) : null;
      const linuxDistribution = distro?.[0] || null;
      const linuxDistributionVersion = cleanVersion(distroMatch?.[1]);
      // A kernel release is reported only when a UA explicitly says "Linux 3.11.0" or "Linux/6.12.1".
      // The numeric part excludes release/build suffixes.
      const linuxKernelVersion = os === 'Linux'
        ? userAgentVersion(ua, /\bLinux[\s/]([\d]{1,3}(?:\.[\d]{1,4}){1,3})(?=[\s;/)]|-|$)/i) : null;
      let architecture = reportedArchitecture(ua);
      // Prefer engine tokens actually advertised by the browser. "like Gecko" in Chromium UAs isn't a Gecko engine indicator.
      let engine = /\bGoanna\//i.test(ua) ? 'Goanna'
        : /\bGecko\/\d/i.test(ua) ? 'Gecko'
        : /\bPresto\//i.test(ua) ? 'Presto'
        : /\b(?:Chrome|Chromium|CriOS|Edg|OPR)\/[\d.]+/i.test(ua) ? 'Blink'
        : /\bAppleWebKit\//i.test(ua) ? 'WebKit'
        : browser === 'Ladybird' ? 'LibWeb' : null;
      // Chromium on iOS has to be classified by its *actual* advertised engine,
      // not simply by the CriOS branding.
      if (isAppleMobile && /\bAppleWebKit\//i.test(ua)) engine = 'WebKit';

      // Chromium can optionally expose accurate browser/OS version and CPU architecture hints. Unknown information stays null rather than guessed.
      try {
        const uaData = navigator.userAgentData;
        if (uaData?.getHighEntropyValues) {
          const hints = await uaData.getHighEntropyValues(['platformVersion', 'fullVersionList', 'architecture', 'bitness', 'model']);
          // Prefer the browser's actual model hint over an older UA label.
          if (deviceClass === 'Mobile' || deviceClass === 'Tablet')
            deviceModel = cleanDeviceModel(hints?.model) || deviceModel;
          const platformVersion = cleanVersion(hints?.platformVersion);
          if (platformVersion) {
            if (os === 'Windows') { osVersion = Number(platformVersion.split('.')[0]) >= 13 ? '11' : '10'; osVersionSource = 'clientHints'; }
            else if (os === 'Android' || os === 'macOS' || os === 'Chrome OS') { osVersion = platformVersion; osVersionSource = 'clientHints'; }
          }
          const knownBrands = {
            'Microsoft Edge': 'Edge', 'Google Chrome': 'Chrome', 'Opera': 'Opera',
            'Chromium': 'Chromium', 'Brave': 'Brave', 'Vivaldi': 'Vivaldi'
          };
          const brands = Array.isArray(hints?.fullVersionList) ? hints.fullVersionList : [];
          const exact = brands.find(item => knownBrands[item.brand] === browser);
          // Generic Chrome/Chromium branding is common in browser forks. A
          // specific brand reported in hints wins; otherwise keep UA identity.
          const generic = ['Chrome', 'Chromium', 'Other'].includes(browser);
          const specific = generic && brands.find(item => ['Microsoft Edge', 'Opera', 'Brave', 'Vivaldi'].includes(item.brand));
          const preferred = specific || exact || (generic
            ? brands.find(item => item.brand === 'Google Chrome' || item.brand === 'Chromium') : null);
          if (preferred) {
            browser = knownBrands[preferred.brand];
            browserVersion = cleanVersion(preferred.version) || browserVersion;
          }
          const hintArch = String(hints?.architecture || '').toLowerCase();
          const bits = String(hints?.bitness || '');
          if (hintArch === 'x86') architecture = bits === '64' ? 'x86_64' : bits === '32' ? 'x86' : architecture;
          else if (hintArch === 'arm') architecture = bits === '64' ? 'ARM64' : bits === '32' ? 'ARM32' : architecture;
          else if (hintArch === 'arm64') architecture = 'ARM64';
          if (os === 'Other' && uaData.platform === 'Windows') os = 'Windows';
        }
      } catch { /* Keep the UA fields if Client Hints are unavailable. */ }
      // Brave usually sends a Chrome UA. Its own API can identify the browser,
      // but Chrome's version is NOT assumed to be Brave's product version.
      try {
        if (typeof navigator.brave?.isBrave === 'function' && await navigator.brave.isBrave()) {
          if (browser !== 'Brave') {
            browser = 'Brave';
            browserVersion = userAgentVersion(ua, /Brave\/([\d.]+)/i);
          }
        }
      } catch { /* Don't block diagnostics on optional browser APIs. */ }
      return { browser, browserVersion, engine, os, osVersion, osVersionSource, deviceClass, deviceModel, architecture,
        linuxDistribution, linuxDistributionVersion, linuxKernelVersion };
    })();
    return environmentPromise;
  }
  function demoListeningDiversity(report) {
    const topTracks = report.periods.all.tracks.slice(0, 20);
    const albums = new Map();
    for (const track of topTracks) {
      if (!track.album) continue;
      const key = keyOf(track.album); // Group multi-artist soundtracks by release title.
      albums.set(key, (albums.get(key) || 0) + 1);
    }

    const months = Object.entries(report.monthDetails || {})
      .filter(([month]) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      .sort(([a], [b]) => a.localeCompare(b));
    const keys = new Set(topTracks.map(track => keyOf(track.artist, track.name)));
    const playsByTrack = new Map([...keys].map(key => [key, new Map()]));
    let longestTopFiveArtistStreak = 0;
    let previousTopFive = new Map(), previousMonth = null;
    for (const [month, data] of months) {
      const index = monthNumber(month);
      for (const track of data.tracks || []) {
        const history = playsByTrack.get(keyOf(track.artist, track.name));
        if (history) history.set(index, track.plays);
      }
      const currentTopFive = new Map();
      for (const artist of (data.artists || []).slice(0, 5)) {
        const key = keyOf(artist.name);
        const streak = (previousMonth === index - 1 ? previousTopFive.get(key) : 0) || 0;
        currentTopFive.set(key, streak + 1);
        longestTopFiveArtistStreak = Math.max(longestTopFiveArtistStreak, streak + 1);
      }
      previousTopFive = currentTopFive;
      previousMonth = index;
    }

    const concentrations = topTracks.filter(track => track.plays > 0).map(track => {
      const history = playsByTrack.get(keyOf(track.artist, track.name)) || new Map();
      let peak = 0;
      for (const month of history.keys()) {
        peak = Math.max(peak, (history.get(month) || 0) +
          (history.get(month - 1) || 0) + (history.get(month - 2) || 0));
      }
      return 100 * peak / track.plays;
    }).sort((a, b) => a - b);
    const middle = Math.floor(concentrations.length / 2);
    const medianPeakThreeMonthPlayShare = concentrations.length
      ? msElapsed(concentrations.length % 2 ? concentrations[middle] :
        (concentrations[middle - 1] + concentrations[middle]) / 2) : null;

    const years = report.years.slice().sort();
    const overlaps = [];
    for (let i = 1; i < years.length; i++) {
      const before = (report.periods[years[i - 1]]?.artists || []).slice(0, 10);
      const after = new Set((report.periods[years[i]]?.artists || []).slice(0, 10).map(artist => keyOf(artist.name)));
      if (!before.length || !after.size || Number(years[i]) !== Number(years[i - 1]) + 1) continue;
      overlaps.push(100 * before.filter(artist => after.has(keyOf(artist.name))).length / before.length);
    }

    return {
      topTracksCount: topTracks.length,
      distinctPrimaryArtists: new Set(topTracks.map(track => keyOf(track.artist))).size,
      distinctAlbumTitles: albums.size,
      albumTaggedTopTracks: [...albums.values()].reduce((sum, count) => sum + count, 0),
      largestAlbumCluster: Math.max(0, ...albums.values()),
      medianPeakThreeMonthPlayShare,
      longestTopFiveArtistStreak,
      annualTopTenArtistOverlap: overlaps.length ? msElapsed(overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length) : null,
      consecutiveYearPairs: overlaps.length
    };
  }

  async function buildSoundcheck(report, builder, trace) {
    const environment = await browserEnvironment();
    const all = report.periods.all;
    const top = Math.max(1, Math.ceil(all.tracks.length * .1));
    const topPlays = all.tracks.slice(0, top).reduce((sum, row) => sum + row.plays, 0);
    const result = {
      schema: 1, id: uuid(), reportId: report.id, createdAt: new Date().toISOString(), status: 'completed',
      source: report.isDemo ? 'demo' : 'import', sourceType: report.type,
      environment: { ...environment, version: appVersion },
      performance: { totalMs: msElapsed(performance.now() - trace.started), stages: { ...trace.stages }, inputBytes: trace.fileBytes, parsedJsonBytes: trace.jsonBytes, sourceFiles: report.files },
      events: { scanned: builder.imported + builder.duplicates + builder.ignored, accepted: builder.imported,
        qualifying: all.qualified, under30s: builder.short, duplicatesRemoved: builder.duplicates, excluded: builder.ignored,
        exclusions: { episodes: builder.checks.episodes, missingMetadata: builder.checks.missingMetadata,
          invalidTimestamp: builder.checks.invalidDate, invalidDuration: builder.checks.invalidDuration, malformedRow: builder.checks.malformed } },
      playlistImport: report.playlistImport || { playlists: 0, musicTracks: 0, localTracks: 0, skippedEpisodes: 0, skippedUnknown: 0 },
      grouping: { sourceTrackVariants: builder.checks.rawTrackVariants.size,
        groupedTracks: all.tracks.length,
        consolidatedVariants: Math.max(0, builder.checks.rawTrackVariants.size - all.tracks.length),
        uniqueArtists: all.artists.length, uniqueAlbums: all.albums.length },
      enrichment: { tracksWithInferredFeatures: builder.checks.inferredTrackKeys.size,
        distinctInferredArtists: builder.checks.inferredArtists.size },
      listening: { firstTs: all.firstTs, lastTs: all.lastTs, years: Object.keys(report.periods).filter(year => year !== 'all').length,
        activeDays: all.activeDays, hours: msElapsed(all.ms / 3600000),
        topTenPercentPlayShare: all.qualified ? msElapsed(100 * topPlays / all.qualified) : 0,
        annual: report.years.slice().reverse().map(year => ({ year, plays: report.periods[year].qualified, hours: msElapsed(report.periods[year].ms / 3600000) })) }
    };
    if (report.isDemo && report.demoData) {
      const data = report.demoData;
      const allDemoTracks = [...data.catalogue, ...(data.curatedTracks || [])];
      const catalogueKeys = new Set(allDemoTracks.map(track => keyOf(track.artist, track.title)));
      const usedKeys = new Set(all.tracks.map(track => keyOf(track.artist, track.name)));
      const outcomes = {};
      for (const message of data.messages) outcomes[message.outcome || 'unknown'] = (outcomes[message.outcome || 'unknown'] || 0) + 1;
      const longSessions = data.sessions.filter(session => session.trackIds.length >= 3);
      result.demo = { catalogueTracks: data.catalogue.length, distinctCatalogueTracks: catalogueKeys.size,
        curatedPlaylistTracks: (data.curatedTracks || []).length, curatedPlaylists: (report.playlists || []).length,
        playlistSessions: data.sessions.filter(session => session.source === 'playlist').length,
        playlistPlays: Object.values(report.playlistStats?.all || {}).reduce((sum, item) => sum + item.plays, 0),
        catalogueArtists: new Set(allDemoTracks.flatMap(track => (track.creditedArtists || [track.artist]).map(name => keyOf(name)))).size,
        catalogueAlbums: new Set(allDemoTracks.map(track => keyOf(track.artist, track.album))).size,
        eligibleTracks: allDemoTracks.filter(track => Date.parse(track.released + 'T00:00:00Z') <= Date.now()).length,
        playedTracks: [...usedKeys].filter(key => catalogueKeys.has(key)).length,
        sessions: data.sessions.length, multiTrackSessions: longSessions.length,
        chapters: report.monthDetails ? Object.keys(report.monthDetails).length : 0,
        friends: data.friends.length, playlists: data.playlists.length, recommendations: data.messages.length,
        recommendationOutcomes: outcomes,
        diversity: demoListeningDiversity(report) };
    }
    return result;
  }
  async function persistSoundcheck(diagnostic) {
    try { await saveSoundcheck(diagnostic); } catch (error) { console.warn('Soundcheck history could not be saved:', error); diagnostic.unsaved = true; }
  }
  async function failedSoundcheck(trace, category) {
    const diagnostic = { schema: 1, id: uuid(), reportId: null, createdAt: new Date().toISOString(),
      source: trace.type, status: 'failed', sourceType: trace.type === 'demo' ? 'Demo data' : 'Spotify import',
      environment: { ...await browserEnvironment(), version: appVersion },
      performance: { totalMs: msElapsed(performance.now() - trace.started), stages: { ...trace.stages }, inputBytes: trace.fileBytes, parsedJsonBytes: trace.jsonBytes, sourceFiles: trace.files },
      failureStage: category };
    await persistSoundcheck(diagnostic);
  }
  function setProgress(label, detail, fraction) {
    $('import-status').classList.remove('hidden');
    $('import-status-title').textContent = label;
    $('import-status-detail').textContent = detail;
    updateLoading(label, detail);
    $('progress-fill').style.width = `${Math.max(2, Math.min(100, fraction * 100))}%`;
  }
  function showLoading(label, detail) {
    $('loading-label').textContent = label;
    $('loading-detail').textContent = detail;
    $('loading-overlay').classList.remove('hidden');
    $('main-content').setAttribute('aria-busy', 'true');
  }
  function updateLoading(label, detail) {
    if ($('loading-overlay').classList.contains('hidden')) return;
    if (label) $('loading-label').textContent = label;
    if (detail) $('loading-detail').textContent = detail;
  }
  function hideLoading() {
    $('loading-overlay').classList.add('hidden');
    $('main-content').removeAttribute('aria-busy');
  }
  const letLoadingPaint = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

  function showError(message) {
    const el = $('error-box');
    el.classList.remove('hidden');
    el.textContent = message;
  }
  async function importHistory(file) {
    if (state.loading) return;
    const isZip = /\.zip$/i.test(file.name), isJson = /\.json$/i.test(file.name);
    if (!isZip && !isJson) { showError('Choose a Spotify .zip archive or a .json history/playlist file.'); return; }
    const mdb58Import = window.MDB58?.beginImport?.(file);
    const trace = startTrace('import', file.size);
    let phase = 'Opening archive';
    state.loading = true;
    $('error-box').classList.add('hidden');
    $('browse-button').disabled = true;
    $('demo-button').disabled = true;
    showLoading('Opening your Spotify export…', 'Reading listening history and playlist metadata locally.');
    try {
      await letLoadingPaint();
      const builder = makeBuilder();
      const playlistImport = { playlists: [], musicTracks: 0, skippedEpisodes: 0, skippedUnknown: 0, localTracks: 0 };
      let type;
      if (isZip) {
        if (typeof JSZip === 'undefined') throw new Error('Local ZIP reader is unavailable. Reload the page and try again.');
        setProgress('Opening Spotify export…', 'Reading the ZIP directory locally.', .02);
        await sleep();
        const openedAt = performance.now();
        const zip = await JSZip.loadAsync(file);
        timeStage(trace, 'Open ZIP', openedAt);
        const files = Object.values(zip.files).filter(entry => !entry.dir && /\.json$/i.test(entry.name) && !baseName(entry.name).startsWith('._'));
        let historyFiles = files.filter(x => extendedName(x.name));
        type = 'Extended Streaming History';
        if (!historyFiles.length) { historyFiles = files.filter(x => basicName(x.name)); type = 'Account streaming history'; }
        const playlistFiles = files.filter(x => playlistFilename(x.name));
        if (!historyFiles.length && !playlistFiles.length) throw new Error('No Spotify listening history or playlist JSON files were found. Expected Streaming_History_Audio_*.json, StreamingHistory_music_*.json or Playlist1.json.');
        const candidates = [...historyFiles.map(entry => ({entry, kind: 'history'})),
          ...playlistFiles.map(entry => ({entry, kind: 'playlist'}))];
        let totalSize = 0;
        for (const { entry } of candidates) {
          const bytes = entry._data?.uncompressedSize || 0;
          if (bytes > MAX_ENTRY_UNCOMPRESSED) throw new Error(`The file ${baseName(entry.name)} is unusually large. Import JSON files smaller than 180 MB individually.`);
          totalSize += bytes;
        }
        if (totalSize > MAX_TOTAL_UNCOMPRESSED) throw new Error('This archive is too large to analyse safely in one browser session.');
        candidates.sort((a, b) => a.kind.localeCompare(b.kind) || a.entry.name.localeCompare(b.entry.name, 'en', { numeric: true }));
        builder.sourceFiles = candidates.length;
        trace.files = candidates.length;
        trace.jsonBytes = totalSize;
        phase = 'Read and parse JSON';
        for (let i = 0; i < candidates.length; i++) {
          const { entry, kind } = candidates[i];
          setProgress(kind === 'playlist' ? 'Importing saved playlists…' : 'Analysing listening history…',
            `File ${i + 1} of ${candidates.length}: ${baseName(entry.name)}`, i / candidates.length);
          await sleep();
          const readingAt = performance.now();
          const content = await entry.async('string', metadata => {
            $('progress-fill').style.width = `${Math.min(98, (i + metadata.percent / 100) / candidates.length * 100)}%`;
          });
          timeStage(trace, 'Read JSON', readingAt);
          const parsingAt = performance.now();
          let parsed;
          try { parsed = JSON.parse(content.replace(/^\uFEFF/, '')); }
          catch { throw new Error(`Could not parse ${baseName(entry.name)}. Make sure this is an unmodified Spotify export.`); }
          timeStage(trace, 'Parse JSON', parsingAt);
          if (kind === 'playlist') {
            phase = 'Parse playlist metadata';
            const began = performance.now();
            importSpotifyPlaylists(parsed, playlistImport);
            timeStage(trace, 'Parse playlists', began);
          } else {
            phase = 'Aggregate listening data';
            const began = performance.now();
            await ingest(builder, parsed);
            // Pass the already parsed source rows to MDB58. It calculates its own privacy scoped aggregates; the original events never leave this page.
            // Failure in an optional integration must not break local reports.
            try { await window.MDB58?.receiveListeningHistory?.(parsed, mdb58Import, type === 'Extended Streaming History'); }
            catch (mdbError) {
              console.warn('MDB58 could not collect listening data:', mdbError);
              window.MDB58?.cancelImport?.(mdb58Import);
            }
            timeStage(trace, 'Aggregate events', began);
          }
          parsed = null;
        }
      } else {
        setProgress('Reading Spotify JSON…', file.name, .1);
        await sleep();
        const readingAt = performance.now();
        const content = await file.text();
        timeStage(trace, 'Read JSON', readingAt);
        trace.jsonBytes = file.size;
        trace.files = 1;
        builder.sourceFiles = 1;
        phase = 'Parse JSON';
        const parsingAt = performance.now();
        let parsed;
        try { parsed = JSON.parse(content.replace(/^\uFEFF/, '')); }
        catch { throw new Error('The selected file is not valid JSON.'); }
        timeStage(trace, 'Parse JSON', parsingAt);
        if (isPlaylistDocument(parsed)) {
          type = 'Spotify playlists';
          phase = 'Parse playlist metadata';
          const began = performance.now();
          importSpotifyPlaylists(parsed, playlistImport);
          timeStage(trace, 'Parse playlists', began);
        } else {
          if (playlistFilename(file.name)) throw new Error('This playlist file is missing the expected playlists array.');
          type = extendedName(file.name) ? 'Extended Streaming History' : 'Spotify listening history';
          phase = 'Aggregate listening data';
          const began = performance.now();
          await ingest(builder, parsed);
          try { await window.MDB58?.receiveListeningHistory?.(parsed, mdb58Import, extendedName(file.name)); }
          catch (mdbError) {
            console.warn('MDB58 could not collect listening data:', mdbError);
            window.MDB58?.cancelImport?.(mdb58Import);
          }
          timeStage(trace, 'Aggregate events', began);
        }
      }
      if (!builder.imported && !playlistImport.playlists.length)
        throw new Error('The files contained no valid music listening events or Spotify playlists.');
      if (playlistImport.playlists.length) type = builder.imported ? `${type} + Spotify playlists` : 'Spotify playlists';
      setProgress('Building your report…', `${number(builder.imported)} listening events and ${number(playlistImport.playlists.length)} playlists processed.`, .97);
      await sleep();
      phase = 'Build report';
      const reportAt = performance.now();
      const report = finishBuilder(builder, file.name, type);
      report.playlists = playlistImport.playlists;
      report.playlistImport = { playlists: playlistImport.playlists.length, musicTracks: playlistImport.musicTracks,
        localTracks: playlistImport.localTracks, skippedEpisodes: playlistImport.skippedEpisodes,
        skippedUnknown: playlistImport.skippedUnknown };
      timeStage(trace, 'Build report', reportAt);
      report.soundcheck = await buildSoundcheck(report, builder, trace);
      state.report = report;
      state.year = 'all';
      let saved = true;
      phase = 'Save report';
      const savingAt = performance.now();
      try { await saveReport(report); }
      catch (error) { saved = false; console.warn('Local report could not be saved:', error); }
      timeStage(trace, 'Save report', savingAt);
      report.soundcheck.performance.stages = { ...trace.stages };
      report.soundcheck.performance.totalMs = msElapsed(performance.now() - trace.started);
      report.unsaved = !saved;
      if (saved) {
        try { await saveReport(report); } catch (error) { console.warn('Final diagnostic metrics could not be written:', error); }
      }
      await persistSoundcheck(report.soundcheck);
      setProgress('Your report is ready.', saved ? 'Saved in your browser.' : 'Opened, but browser storage is unavailable; this report will not survive a reload.', 1);
      report.unsaved = !saved;
      await refreshHistoryCount();
      activateReport(report);
      window.MDB58?.completeImport?.(mdb58Import);
      // A playlist only Account Data export has no listening statistics to show.
      if (!builder.imported && playlistImport.playlists.length) openView('playlists', false);
    } catch (error) {
      window.MDB58?.cancelImport?.(mdb58Import);
      console.error('Local import error:', error);
      await failedSoundcheck(trace, phase);
      showError(error instanceof Error ? error.message : 'Could not read this archive.');
    } finally {
      $('import-status').classList.add('hidden');
      $('browse-button').disabled = false;
      $('demo-button').disabled = false;
      $('file-input').value = '';
      state.loading = false;
      hideLoading();
    }
  }

  function openView(view, record = true) {
    if (!views.includes(view) || (view === 'soundcheck' && !state.soundcheckUnlocked)) return;
    if (!state.report && ['overview', 'artists', 'tracks', 'albums', 'playlists', 'eras', 'patterns', 'search'].includes(view)) view = 'home';
    if (record && state.view !== view) saveNavigation();
    closeMobileActions();
    closeThemeMenu();
    state.view = view;
    for (const section of document.querySelectorAll('.view')) section.classList.toggle('active', section.id === `view-${view}`);
    for (const nav of document.querySelectorAll('[data-nav]')) nav.classList.toggle('active', nav.dataset.nav === view);
    $('page-name').textContent = pageNames[view];
    $('report-controls').classList.toggle('hidden', !state.report || view === 'history' || view === 'soundcheck');
    const canRandomise = !!state.report?.isDemo && view !== 'home' && view !== 'history';
    $('randomise-demo').classList.toggle('hidden', !canRandomise);
    $('mobile-randomise').classList.toggle('hidden', !canRandomise);
    if (view === 'history') renderHistory();
    else if (view !== 'home') renderCurrent();
    updateBackButton();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function activateReport(report) {
    navigationStack.length = 0;
    state.soundcheckSelected = null;
    state.report = report;
    state.playlistSelection = null;
    state.year = 'all';
    state.eras = { month: null, sort: 'plays', limits: { artists: 8, tracks: 10, albums: 8 } };
    state.eraHistory = null;
    state.eraChaptersCache = null;
    state.search = { query: '', filter: 'all', selected: null, matches: [], limit: 30 };
    $('unified-search').value = '';
    $('search-filter').value = 'all';
    $('year-filter').innerHTML = '<option value="all">All time</option>' + report.years.map(y => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join('');
    $('year-filter').value = 'all';
    $('storage-warning').classList.toggle('hidden', !report.unsaved);
    document.querySelectorAll('.nav-link.report-only').forEach(nav => nav.classList.add('ready'));
    openView('overview', false);
  }
  function period() { return state.report?.periods?.[state.year] || state.report?.periods?.all; }
  function sortedRecords(category) {
    const list = period()?.[category] || [];
    if (state.sorts[category] === 'plays') return list;
    return [...list].sort((a, b) => b.ms - a.ms || b.plays - a.plays);
  }
  // Curated/saved playlists and randomly generated friend collections coexist.
  function playlistCollections() {
    const curated = state.report?.playlists || [];
    const demo = state.report?.demoData;
    const social = (demo?.playlists || []).map(list => ({ ...list, source: 'social',
      tracks: (list.trackIds || []).map((id, index) => {
        const track = demo.catalogue?.find(record => record.id === id);
        return track ? { ...track, name: track.title, position: index + 1,
          seconds: Math.round(track.durationMs / 1000) } : null;
      }).filter(Boolean) }));
    return [...curated, ...social];
  }
  const playlistStatsFor = id => state.report?.playlistStats?.[state.year]?.[id] ||
    { plays: 0, ms: 0, tracks: {} };
  // Spotify exports may already supply creditedArtists; demo tracks instead carry
  // their additional credits in `credits`. Always include explicit feat. credits
  // from the title, without changing the underlying primary artist identity.
  const playlistArtistCredits = track => creditedNames([
    ...artistCredits(track),
    ...(Array.isArray(track?.credits) ? track.credits : []),
    ...featureCreditsFromTitle(track?.title || track?.name || '')
  ]);
  function playlistTrackLength(list) {
    return list.tracks.reduce((sum, track) => sum + (Number(track.seconds) || 0) * 1000, 0);
  }
  const playlistDurationLabel = list => list.tracks.some(track => Number(track.seconds) > 0)
    ? `${duration(playlistTrackLength(list))}${list.tracks.some(track => !track.seconds) ? ' known' : ''}` : 'Duration unavailable';
  function renderPlaylistTrackRows(list) {
    const stats = playlistStatsFor(list.id);
    const real = !state.report?.isDemo;
    // Match actual history without claiming any plays originated from a playlist.
    const played = period()?.tracks || [];
    const byUri = new Map(played.filter(item => item.uri).map(item => [item.uri, item]));
    const byTitle = new Map(played.map(item => [keyOf(item.artist, item.name), item]));
    return list.tracks.map((track, index) => {
      const listen = real ? (byUri.get(track.uri) || byTitle.get(keyOf(track.artist, track.title))) : stats.tracks?.[track.id];
      const pos = track.position || index + 1;
      return `<div class="playlist-track-row"><span class="playlist-position">${number(pos)}</span>
        <div class="playlist-track-meta"><button type="button" data-playlist-track="${escapeHtml(encodeURIComponent(keyOf(track.artist, track.title)))}">${escapeHtml(track.title || track.name)}</button><span>${escapeHtml(playlistArtistCredits(track).join(', '))} · ${escapeHtml(track.album || 'Unknown release')}${track.local ? ' · Local file' : ''}</span></div>
        <span class="playlist-track-length">${track.seconds ? duration(track.seconds * 1000) : '—'}</span>
        <span class="playlist-track-plays">${listen?.plays ? `${number(listen.plays)} ${real ? 'overall' : 'plays'}` : '—'}</span></div>`;
    }).join('');
  }
  function playlistDetailMarkup(list, embedded = false) {
    const stats = playlistStatsFor(list.id);
    const source = list.source === 'social' ? 'Random social collection' : list.source === 'spotify' ? 'Spotify saved playlist' : 'Curated playlist';
    const total = list.tracks.length;
    const artists = new Set(list.tracks.flatMap(track => playlistArtistCredits(track).map(name => keyOf(name)))).size;
    return `<article class="panel playlist-detail">${embedded ? '' : `<div style="margin-bottom:18px"><button type="button" class="btn btn-outline" data-playlist-back>← All playlists</button></div>`}
      <div class="playlist-detail-heading"><div><div class="kicker">${source.toUpperCase()}</div><h2>${escapeHtml(list.name)}</h2><p>${number(total)} music tracks · ${number(artists)} artists · ${playlistDurationLabel(list)}${list.lastModifiedDate ? ` · Modified ${escapeHtml(list.lastModifiedDate)}` : ''}</p></div>
      ${embedded ? `<button type="button" class="btn btn-outline" data-playlist-open="${escapeHtml(list.id)}">View playlist ↗</button>` : ''}</div>
      ${list.description ? `<p class="search-muted">${escapeHtml(list.description)}</p>` : ''}
      <div class="playlist-metrics"><div><strong>${state.report?.isDemo ? number(stats.plays) : '—'}</strong><span>${state.report?.isDemo ? 'Attributed demo plays' : 'Playback source unavailable'}</span></div><div><strong>${state.report?.isDemo ? duration(stats.ms) : '—'}</strong><span>Attributed listening time</span></div><div><strong>${number(total)}</strong><span>Playlist entries</span></div></div>
      ${list.source === 'social' ? `<p class="search-muted">This randomly generated collection remains part of the demo's social library. Its songs also exist in the standard demo music catalogue. Plays are not automatically attributed to this collection.</p>` :
        `<p class="search-muted">${state.report?.isDemo ? 'Saving this playlist does not save its tracks to the music library. The play counts below reflect only sessions explicitly simulated from this playlist; all music plays also feed the normal analytics and Eras.' : 'Saved playlist entries are independent of saved music. Matching play counts below are from your overall listening history, not attributed to this playlist. Spotify does not export the playback source playlist.'}</p>`}
      <div class="playlist-track-head"><span>TRACKS · PLAYLIST ORDER</span><span>${state.year === 'all' ? 'ALL TIME' : escapeHtml(state.year)}</span></div>
      <div class="playlist-track-list">${renderPlaylistTrackRows(list)}</div></article>`;
  }
  function renderPlaylists() {
    const lists = playlistCollections();
    const selected = lists.find(list => list.id === state.playlistSelection);
    $('playlist-listing').classList.toggle('hidden', !!selected);
    $('playlist-detail-container').classList.toggle('hidden', !selected);
    if (selected) { $('playlist-detail-container').innerHTML = playlistDetailMarkup(selected); return; }
    const renderGroup = (items, node, empty) => {
      $(node).innerHTML = items.length ? items.map(list => `<button class="playlist-card" type="button" data-playlist-open="${escapeHtml(list.id)}"><span class="playlist-card-icon">≡</span><strong>${escapeHtml(list.name)}</strong><span>${number(list.tracks.length)} tracks · ${playlistDurationLabel(list)}</span><small>${list.source === 'social' ? 'Social demo collection' : `${state.report?.isDemo ? `${number(playlistStatsFor(list.id).plays)} attributed plays` : 'Saved playlist'}`} ↗</small></button>`).join('') : emptyMessage(empty);
    };
    renderGroup(lists.filter(list => list.source !== 'social'), 'playlist-curated', 'No saved playlists have been imported yet.');
    $('playlist-social-section').classList.toggle('hidden', !lists.some(list => list.source === 'social'));
    renderGroup(lists.filter(list => list.source === 'social'), 'playlist-social', '');
  }

  function playlistSearchEntities(category) {
    const lists = playlistCollections();
    if (category === 'playlists') return lists.map(list => ({ id: list.id, name: list.name,
      plays: playlistStatsFor(list.id).plays, ms: playlistStatsFor(list.id).ms,
      source: list.source, trackCount: list.tracks.length }));
    const originals = period()?.[category] || [];
    const existing = new Set(originals.map(item => recordKey(category, item)));
    const extra = new Map();
    for (const list of lists.filter(item => item.source !== 'social')) {
      for (const track of list.tracks) {
        const entries = category === 'tracks' ? [{ name: track.name || track.title, artist: track.artist,
          album: track.album, uri: track.uri || '', creditedArtists: playlistArtistCredits(track), plays: 0, ms: 0, playlistOnly: true }] :
          category === 'artists' ? playlistArtistCredits(track).map(name => ({ name, plays: 0, ms: 0, playlistOnly: true })) :
          category === 'albums' ? [{ name: track.album, artist: track.artist, plays: 0, ms: 0, playlistOnly: true }] : [];
        for (const item of entries) {
          const key = recordKey(category, item);
          if (item.name && !existing.has(key) && !extra.has(key)) extra.set(key, item);
        }
      }
    }
    return [...originals, ...extra.values()];
  }
  function searchEntity(category, key) {
    return playlistSearchEntities(category).find(item => recordKey(category, item) === key);
  }

  function renderCurrent() {
    if (state.view === 'soundcheck') { void renderSoundcheck(); return; }
    if (!state.report) return;
    if (state.view === 'overview') renderOverview();
    if (['artists', 'tracks', 'albums'].includes(state.view)) renderListing(state.view);
    if (state.view === 'playlists') renderPlaylists();
    if (state.view === 'patterns') renderPatterns();
    if (state.view === 'eras') renderEras();
    if (state.view === 'search') renderSearch();
  }
  const insightCard = (label, value, description) => `<div class="insight-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p>${escapeHtml(description)}</p></div>`;
  function statCard(label, value, subtitle, icon) {
    return `<article class="stat-card"><div class="stat-icon">${icon}</div><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div><div class="stat-subtitle">${escapeHtml(subtitle)}</div></article>`;
  }
  function rankRow(item, index, category, sorting) {
    const isArtist = category === 'artists';
    const subtitle = isArtist ? `${number(item.plays)} credited plays` : `${category === 'tracks' ? artistCreditLabel(item) : item.artist}${item.album && category === 'tracks' ? ' · ' + item.album : ''}`;
    const art = { artists: '◉', tracks: '♫', albums: '▤' }[category];
    const metric = sorting === 'ms' ? duration(item.ms) : number(item.plays);
    const unit = sorting === 'ms' ? 'listening time' : 'plays';
    const spotifyLink = category === 'tracks' && /^spotify:track:[A-Za-z0-9]+$/.test(item.uri || '')
      ? `<a class="rank-link" href="https://open.spotify.com/track/${encodeURIComponent(item.uri.split(':').pop())}" target="_blank" rel="noopener noreferrer" title="Open in Spotify" aria-label="Open ${escapeHtml(item.name)} in Spotify">↗</a>` : '';
    return `<div class="rank-row"><span class="rank-position">${number(index + 1).padStart(2, '0')}</span><div class="rank-art">${art}</div><div class="rank-main"><button type="button" class="rank-title rank-title-button" data-explore-category="${category}" data-explore-key="${escapeHtml(encodeURIComponent(recordKey(category, item)))}" title="Explore ${escapeHtml(item.name)}">${escapeHtml(item.name)}</button><span class="rank-sub" title="${escapeHtml(subtitle)}">${escapeHtml(subtitle)}</span></div><div class="rank-data"><span class="rank-number">${escapeHtml(metric)}</span><span class="rank-unit">${unit}</span></div>${spotifyLink}</div>`;
  }
  function renderOverview() {
    const p = period();
    const year = state.year;
    $('overview-title').innerHTML = year === 'all' ? 'The big picture<span class="accent">.</span>' : `Your ${escapeHtml(year)}<span class="accent">.</span>`;
    $('overview-subtitle').textContent = !p.qualified && state.report?.playlists?.length
      ? `No listening history in this import · ${number(state.report.playlists.length)} saved playlists available`
      : `${dateLabel(p.firstTs)} – ${dateLabel(p.lastTs)} · ${number(p.activeDays)} active listening days`;
    $('range-label').textContent = year === 'all' ? 'ALL TIME' : year;
    $('summary-stats').innerHTML = [
      statCard('Listening time', `${hours(p.ms)} hrs`, 'Qualified music streams', '◷'),
      statCard('Music streams', number(p.qualified), '30 seconds or more', '♫'),
      statCard('Unique artists', number(p.artists.length), 'Distinct artist names', '◉'),
      statCard('Unique tracks', number(p.tracks.length), 'Artist + track name', '▤')
    ].join('');
    $('timeline-title').textContent = year === 'all' ? 'Your years in music' : `Month by month · ${year}`;
    drawTimeline(p);
    $('overview-artists').innerHTML = p.artists.slice(0, 6).map((item, i) => rankRow(item, i, 'artists', 'plays')).join('') || emptyMessage();
    $('overview-tracks').innerHTML = p.tracks.slice(0, 6).map((item, i) => rankRow(item, i, 'tracks', 'plays')).join('') || emptyMessage();
    const peakDayIndex = p.byWeekday.indexOf(Math.max(...p.byWeekday));
    const peakHourIndex = p.hourly.indexOf(Math.max(...p.hourly));
    const fav = p.artists[0]?.name || 'No data';
    $('overview-insights').innerHTML = [
      insightCard('YOUR MOST PLAYED ARTIST', fav, p.artists[0] ? `${number(p.artists[0].plays)} qualifying plays` : 'No artist plays'),
      insightCard('YOUR BIGGEST LISTENING DAY', weekdayLabels[peakDayIndex], `${duration(p.byWeekday[peakDayIndex])} of recorded music`),
      insightCard('YOUR PEAK LISTENING HOUR', `${String(peakHourIndex).padStart(2, '0')}:00 UTC`, 'Based on the time playback ended')
    ].join('');
  }
  function drawTimeline(p) {
    let entries;
    if (state.year === 'all') {
      const grouped = new Map();
      for (const [month, ms] of p.months) grouped.set(month.slice(0, 4), (grouped.get(month.slice(0, 4)) || 0) + ms);
      entries = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    } else {
      const values = new Map(p.months);
      entries = monthLabels.map((m, i) => [m, values.get(`${state.year}-${String(i + 1).padStart(2, '0')}`) || 0]);
    }
    const max = Math.max(...entries.map(x => x[1]), 1);
    $('timeline-chart').innerHTML = `<div class="bar-chart">${entries.map(([label, ms]) => `<div class="bar-unit"><div class="bar-fill-wrap"><div class="bar-fill" title="${escapeHtml(label)}: ${hours(ms)} hours" style="height:${ms ? Math.max(1, ms / max * 100) : 0}%"></div></div><span class="bar-label">${escapeHtml(label)}</span></div>`).join('')}</div><div class="chart-baseline"></div>`;
    if (!entries.length) $('timeline-chart').innerHTML = emptyMessage();
  }
  function emptyMessage(text = 'No listening history matches this selection.') { return `<div class="empty-state">${escapeHtml(text)}</div>`; }
  function renderListing(category) {
    const words = { artists: 'artist', tracks: 'track', albums: 'album' };
    const search = ($(words[category] + '-search')?.value || '').trim().toLowerCase();
    const sorting = state.sorts[category];
    const filtered = sortedRecords(category).filter(item => `${item.name} ${artistCreditLabel(item)} ${item.album || ''}`.toLocaleLowerCase('en-GB').includes(search));
    const visible = filtered.slice(0, state.count);
    $(words[category] + '-list').innerHTML = visible.length ? visible.map((item, i) => rankRow(item, i, category, sorting)).join('') : emptyMessage();
    const more = $(words[category] + '-more');
    more.classList.toggle('hidden', filtered.length <= state.count);
    more.textContent = `Show more ${words[category]}s (${number(filtered.length - state.count)} remaining) ↓`;
    document.querySelectorAll(`[data-sort-for="${category}"] .sort-btn`).forEach(btn => btn.classList.toggle('active', btn.dataset.sort === sorting));
  }
  function renderPatterns() {
    const p = period();
    $('pattern-insights').innerHTML = [
      insightCard('ON SHUFFLE', percent(p.shuffleYes, p.shuffleKnown), `${number(p.shuffleKnown)} events with shuffle information`),
      insightCard('SKIPPED TRACKS', percent(p.skipYes, p.skipKnown), 'Based on Spotify’s explicit skipped flag'),
      insightCard('PLAYED OFFLINE', percent(p.offlineYes, p.offlineKnown), `${number(p.offlineKnown)} events with offline information`)
    ].join('');
    const max = Math.max(...p.heat.flat(), 1);
    let heatmap = '<div class="heatmap"><span></span>';
    for (let h = 0; h < 24; h++) heatmap += `<span class="heat-label">${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>`;
    for (let day = 0; day < 7; day++) {
      heatmap += `<span class="heat-label">${weekdayLabels[day]}</span>`;
      for (let h = 0; h < 24; h++) {
        const v = p.heat[day][h];
        const opacity = v ? 0.12 + (v / max) * .88 : 0;
        heatmap += `<span class="heat-cell" style="background:${v ? `rgba(var(--accent-rgb),${opacity.toFixed(3)})` : 'var(--heat-idle)'}" title="${weekdayLabels[day]} ${String(h).padStart(2, '0')}:00 UTC · ${hours(v)} hours"></span>`;
      }
    }
    $('heatmap').innerHTML = heatmap + '</div>';
    const platforms = p.platforms.slice(0, 8);
    const platformTotal = p.platforms.reduce((sum, row) => sum + row[1], 0);
    $('platform-list').innerHTML = platforms.map(([name, ms], i) => `<div class="rank-row"><span class="rank-position">${i + 1}</span><div class="rank-art">▣</div><div class="rank-main"><span class="rank-title" title="${escapeHtml(platformGroup(name))}">${escapeHtml(platformGroup(name))}</span><span class="rank-sub">${percent(ms, platformTotal)} of listening time</span></div><div class="rank-data"><span class="rank-number">${hours(ms)} h</span></div></div>`).join('') || emptyMessage();
    const values = [
      ['Total listening days', `${number(p.activeDays)} days`],
      ['Average active-day listening', duration(p.activeDays ? p.ms / p.activeDays : 0)],
      ['Events below 30 seconds', number(p.allEvents - p.qualified)],
      ['Qualified music streams', number(p.qualified)],
      ['Different albums', number(p.albums.length)],
      ['Earliest play', dateLabel(p.firstTs)],
      ['Latest play', dateLabel(p.lastTs)]
    ];
    $('detail-stats').innerHTML = values.map(([label, value]) => `<div class="detail-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  }

  // The Eras explorer is built from the same qualified music plays as the main
  // rankings. Its month-level data is saved at import time; no raw history is kept.
  const monthNumber = key => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7));
  const monthTitle = key => new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long', year: 'numeric', timeZone: 'UTC'
  });
  const monthShort = key => `${monthLabels[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
  const monthSpan = (from, to) => from === to ? monthTitle(from) : `${monthShort(from)} – ${monthShort(to)}`;

  function eligibleEraMonths() {
    return Object.entries(state.report?.monthDetails || {})
      .filter(([key, data]) => /^\d{4}-(0[1-9]|1[0-2])$/.test(key) &&
        (state.year === 'all' || key.startsWith(state.year + '-')) && data?.qualified > 0)
      .map(([key, data]) => ({ key, ...data }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
  function eraRecordKey(category, item) {
    return recordKey(category, item);
  }
  function combineEraRanks(months, category) {
    const combined = new Map();
    for (const month of months) {
      for (const item of (month[category] || [])) {
        const key = eraRecordKey(category, item);
        if (!combined.has(key)) combined.set(key, { ...item, plays: 0, ms: 0 });
        const total = combined.get(key);
        total.plays += item.plays;
        total.ms += item.ms;
        if (item.uri && !total.uri) total.uri = item.uri;
        if (item.creditedArtists?.length) total.creditedArtists = creditedNames([...(total.creditedArtists || []), ...item.creditedArtists]);
      }
    }
    return [...combined.values()].sort((a, b) => b.plays - a.plays || b.ms - a.ms || a.name.localeCompare(b.name));
  }
  function artistSimilarity(a, b) {
    const weights = rows => new Map((rows || []).slice(0, 10).map(row => [keyOf(row.name), row.plays]));
    const first = weights(a.artists);
    const second = weights(b.artists);
    const norm = map => Math.sqrt([...map.values()].reduce((sum, x) => sum + x * x, 0));
    const denominator = norm(first) * norm(second);
    if (!denominator) return 0;
    let dot = 0;
    for (const [artist, plays] of first) dot += plays * (second.get(artist) || 0);
    return dot / denominator;
  }
  function detectListeningEras(months) {
    const groups = [];
    let current = [];
    for (const month of months) {
      const previous = current[current.length - 1];
      const similarity = previous ? artistSimilarity(previous, month) : 0;
      const sameLead = previous?.artists?.[0] && month.artists?.[0] &&
        keyOf(previous.artists[0].name) === keyOf(month.artists[0].name);
      const joined = previous && monthNumber(month.key) === monthNumber(previous.key) + 1 &&
        current.length < 6 && (similarity >= .56 || (sameLead && similarity >= .39) ||
          (previous.qualified < 12 && month.qualified < 12));
      if (!joined && current.length) { groups.push(current); current = []; }
      current.push(month);
    }
    if (current.length) groups.push(current);
    return groups.map((group, index) => {
      const artists = combineEraRanks(group, 'artists');
      const tracks = combineEraRanks(group, 'tracks');
      const albums = combineEraRanks(group, 'albums');
      const qualified = group.reduce((total, month) => total + month.qualified, 0);
      const ms = group.reduce((total, month) => total + month.ms, 0);
      const leader = artists[0]?.name || 'Unknown artist';
      const secondary = artists[1];
      const title = secondary && secondary.plays >= artists[0].plays * .76
        ? `${leader} & ${secondary.name}` : leader;
      return { index, months: group, from: group[0].key, to: group[group.length - 1].key,
        artists, tracks, albums, qualified, ms, title };
    });
  }
  function getEraHistory() {
    if (state.eraHistory?.report === state.report) return state.eraHistory;
    const all = Object.entries(state.report?.monthDetails || {})
      .filter(([key, month]) => /^\d{4}-(0[1-9]|1[0-2])$/.test(key) && month?.qualified > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    const tracks = new Map();
    for (const [key, month] of all) {
      for (const item of month.tracks || []) {
        const id = eraRecordKey('tracks', item);
        if (!tracks.has(id)) tracks.set(id, { name: item.name, artist: item.artist, months: [] });
        tracks.get(id).months.push({ key, plays: item.plays });
      }
    }
    state.eraHistory = { report: state.report, tracks, latestMonth: all.at(-1)?.[0] || '' };
    return state.eraHistory;
  }
  function monthMemories(month, history) {
    const newcomers = [], returns = [], forgotten = [];
    for (const item of month.tracks || []) {
      const activity = history.tracks.get(eraRecordKey('tracks', item));
      if (!activity) continue;
      const appearances = activity.months;
      const currentIndex = appearances.findIndex(entry => entry.key === month.key);
      if (currentIndex < 0) continue;
      if (currentIndex === 0 && item.plays >= 3) {
        newcomers.push({ ...item, reason: `${number(item.plays)} plays on its first recorded month` });
      } else if (currentIndex > 0 && item.plays >= 3) {
        const prior = appearances[currentIndex - 1];
        const quiet = monthNumber(month.key) - monthNumber(prior.key) - 1;
        if (quiet >= 6) returns.push({ ...item, reason: `Back after ${number(quiet)} quiet months` });
      }
      const lastSeen = appearances.at(-1).key;
      const away = monthNumber(history.latestMonth) - monthNumber(lastSeen);
      if (item.plays >= 4 && away >= 12) {
        forgotten.push({ ...item, reason: `Last recorded ${monthShort(lastSeen)} · ${number(away)} months ago` });
      }
    }
    const order = list => list.sort((a, b) => b.plays - a.plays || b.ms - a.ms).slice(0, 4);
    return { newcomers: order(newcomers), returns: order(returns), forgotten: order(forgotten) };
  }
  function eraMemoryPanel(kicker, heading, items, empty) {
    return `<article class="panel era-memory-panel"><div class="kicker">${escapeHtml(kicker)}</div><h2>${escapeHtml(heading)}</h2>${items.length
      ? items.map(item => `<div class="era-memory-item"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><span>${escapeHtml(artistCreditLabel(item))}</span><small>${escapeHtml(item.reason)}</small></div>`).join('')
      : `<p class="era-memory-empty">${escapeHtml(empty)}</p>`}</article>`;
  }
  function eraChapterCard(chapter, selected) {
    return `<button type="button" class="era-chapter ${selected ? 'selected' : ''}" data-era-month="${escapeHtml(chapter.to)}" aria-pressed="${selected}">
      <span class="era-chapter-date">${escapeHtml(monthSpan(chapter.from, chapter.to))} · ${number(chapter.months.length)} ${chapter.months.length === 1 ? 'month' : 'months'}</span>
      <strong class="era-chapter-name" title="${escapeHtml(chapter.title)}">${escapeHtml(chapter.title)}<span class="accent">.</span></strong>
      <span class="era-chapter-favourite">♫ ${escapeHtml(chapter.tracks[0]?.name || 'No tracks')}</span>
      <span class="era-chapter-favourite">▤ ${escapeHtml(chapter.albums[0]?.name || 'No album metadata')}</span>
      <span class="era-chapter-count">${number(chapter.qualified)} plays · ${hours(chapter.ms)} hrs <span aria-hidden="true">↗</span></span>
    </button>`;
  }
  function renderEraChapterDetail(chapter) {
    const categoryBlock = (heading, icon, entries, cat) => `<div class="era-chapter-toplist"><span class="era-chapter-toplabel">${icon} ${escapeHtml(heading)}</span>${entries.slice(0, 4).map((item, i) =>
      `<div class="era-chapter-item"><span>${i + 1}.</span><span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}${cat !== 'artists' ? `<small>${escapeHtml(cat === 'tracks' ? artistCreditLabel(item) : item.artist)}</small>` : ''}</span><b>${number(item.plays)}</b></div>`).join('') || emptyMessage('No album information for this chapter.')}</div>`;
    return `<div class="era-feature"><div class="era-feature-heading"><div><div class="kicker">SELECTED CHAPTER · ${escapeHtml(monthSpan(chapter.from, chapter.to))}</div><h3>${escapeHtml(chapter.title)} era</h3><p>${number(chapter.qualified)} qualifying plays across ${number(chapter.months.length)} ${chapter.months.length === 1 ? 'month' : 'months'} · ${hours(chapter.ms)} listening hours</p></div><span class="era-feature-disc" aria-hidden="true">${ERA_SPARK_ICON}</span></div><div class="era-chapter-toplists">${categoryBlock('Defining artists', '◉', chapter.artists, 'artists')}${categoryBlock('On repeat', '♫', chapter.tracks, 'tracks')}${categoryBlock('Defining albums', '▤', chapter.albums, 'albums')}</div></div>`;
  }
  function renderEraRanks(category, month) {
    const items = month[category] || [];
    const sorting = state.eras.sort;
    const ranked = sorting === 'plays' ? items : [...items].sort((a, b) => b.ms - a.ms || b.plays - a.plays);
    const limit = state.eras.limits[category];
    $(`era-${category}`).innerHTML = ranked.slice(0, limit).map((item, i) => rankRow(item, i, category, sorting)).join('') || emptyMessage('No recorded qualifying plays.');
    const more = $(`era-more-${category}`);
    more.classList.toggle('hidden', ranked.length <= limit);
    more.textContent = `Show more (${number(Math.max(0, ranked.length - limit))} remaining) ↓`;
  }
  function renderEras() {
    const dashboard = $('era-dashboard');
    const notice = $('era-legacy-notice');
    if (!state.report?.monthDetails) {
      dashboard.classList.add('hidden');
      notice.classList.remove('hidden');
      notice.textContent = 'This report was created before month-by-month Eras data was available. Re-import your original Spotify ZIP to unlock accurate monthly artists, tracks, albums, and rediscoveries. Your older saved report is unchanged.';
      return;
    }
    const cache = state.eraChaptersCache?.report === state.report && state.eraChaptersCache?.year === state.year
      ? state.eraChaptersCache : null;
    const months = cache ? cache.months : eligibleEraMonths();
    if (!months.length) {
      dashboard.classList.add('hidden');
      notice.classList.remove('hidden');
      notice.textContent = 'No qualifying music plays were found for this date range.';
      return;
    }
    notice.classList.add('hidden');
    dashboard.classList.remove('hidden');
    $('eras-range-label').textContent = state.year === 'all' ? 'ALL TIME' : state.year;
    const firstSelection = !months.some(month => month.key === state.eras.month);
    if (firstSelection) state.eras.month = months.at(-1).key;
    const selected = months.find(month => month.key === state.eras.month);
    const chapters = cache ? cache.chapters : detectListeningEras(months);
    if (!cache) state.eraChaptersCache = { report: state.report, year: state.year, months, chapters };
    const currentChapter = chapters.find(chapter => chapter.months.some(month => month.key === selected.key));
    const history = getEraHistory();
    const mostActive = [...months].sort((a, b) => b.ms - a.ms)[0];
    const firsts = months.reduce((sum, month) => sum + month.qualified, 0);
    $('era-stats').innerHTML = [
      statCard('Months explored', number(months.length), `${monthShort(months[0].key)} – ${monthShort(months.at(-1).key)}`, '◷'),
      statCard('Listening chapters', number(chapters.length), 'Detected from shifting music tastes', ERA_SPARK_ICON),
      statCard('Recorded plays', number(firsts), 'Streams of at least 30 seconds', '♫'),
      statCard('Busiest month', monthShort(mostActive.key), `${hours(mostActive.ms)} hours listened`, '▥')
    ].join('');
    $('era-chapters').innerHTML = [...chapters].reverse().map(chapter => eraChapterCard(chapter, chapter === currentChapter)).join('');
    $('era-chapter-details').innerHTML = renderEraChapterDetail(currentChapter);
    const strip = $('era-month-strip');
    const oldScroll = strip.scrollLeft;
    const peak = Math.max(...months.map(month => month.ms), 1);
    strip.innerHTML = months.map(month => `<button type="button" class="era-month-pill ${month.key === selected.key ? 'selected' : ''}" data-era-month="${escapeHtml(month.key)}" aria-pressed="${month.key === selected.key}" title="${escapeHtml(monthTitle(month.key))} · ${number(month.qualified)} plays">
      <span class="era-pill-year">${escapeHtml(month.key.slice(0, 4))}</span><strong>${escapeHtml(monthLabels[Number(month.key.slice(5, 7)) - 1])}</strong><span class="era-pill-artist" title="${escapeHtml(month.artists[0]?.name || '')}">${escapeHtml(month.artists[0]?.name || 'No artist')}</span>
      <span class="era-pill-meter"><i style="height:${Math.max(3, Math.round(month.ms / peak * 26))}px"></i></span></button>`).join('');
    if (firstSelection) {
      const active = strip.querySelector('.selected');
      if (active) strip.scrollLeft = Math.max(0, active.offsetLeft - strip.offsetLeft - strip.clientWidth / 2);
    } else strip.scrollLeft = oldScroll;
    const selectedIndex = months.findIndex(row => row.key === selected.key);
    const prev = months[selectedIndex - 1];
    const next = months[selectedIndex + 1];
    const artist = selected.artists[0];
    const track = selected.tracks[0];
    const album = selected.albums[0];
    $('era-month-detail').innerHTML = `<article class="panel era-selected-month"><div class="era-month-heading"><div><div class="kicker">MONTHLY DEEP DIVE · UTC</div><h2>${escapeHtml(monthTitle(selected.key))}<span class="accent">.</span></h2><p>A snapshot of what you were listening to, playing on repeat, and discovering.</p></div><div class="era-month-arrows"><button type="button" class="small-icon-btn" data-era-step="-1" ${prev ? '' : 'disabled'} aria-label="Previous listening month" title="Previous listening month">←</button><button type="button" class="small-icon-btn" data-era-step="1" ${next ? '' : 'disabled'} aria-label="Next listening month" title="Next listening month">→</button></div></div>
      <div class="era-month-numbers"><div><b>${number(selected.qualified)}</b><span>Qualifying plays</span></div><div><b>${hours(selected.ms)} h</b><span>Listening time</span></div><div><b>${number(selected.activeDays)}</b><span>Active days</span></div><div><b>${number(selected.tracks.length)}</b><span>Different tracks</span></div><div><b>${percent(selected.skipYes, selected.skipKnown)}</b><span>Recorded skip rate</span></div></div>
      <div class="era-month-favourites"><div><span>◉ YOUR LEADING ARTIST</span><strong>${escapeHtml(artist?.name || 'Unknown')}</strong><small>${artist ? `${number(artist.plays)} plays · ${percent(artist.plays, selected.qualified)} of this month` : 'No artist plays'}</small></div><div><span>♫ THE TRACK ON REPEAT</span><strong>${escapeHtml(track?.name || 'Unknown')}</strong><small>${track ? `${escapeHtml(artistCreditLabel(track))} · ${number(track.plays)} plays` : 'No track plays'}</small></div><div><span>▤ YOUR GO-TO ALBUM</span><strong>${escapeHtml(album?.name || 'Unknown')}</strong><small>${album ? `${escapeHtml(album.artist)} · ${number(album.plays)} plays` : 'No album data'}</small></div></div></article>`;
    const memories = monthMemories(selected, history);
    $('era-memory').innerHTML = [
      eraMemoryPanel('FIRST APPEARANCES', 'New obsessions', memories.newcomers, 'No tracks first appeared with three or more plays in this month.'),
      eraMemoryPanel('A SECOND WIND', 'Rediscovered favourites', memories.returns, 'No tracks returned after six or more quiet months.'),
      eraMemoryPanel('WHERE ARE THEY NOW?', 'Forgotten favourites', memories.forgotten, 'No tracks from this month have been absent for at least a year by the end of this export.')
    ].join('');
    for (const category of ['tracks', 'artists', 'albums']) renderEraRanks(category, selected);
    document.querySelectorAll('[data-era-sort]').forEach(button => button.classList.toggle('active', button.dataset.eraSort === state.eras.sort));
  }

  // Unified Search works against the same aggregated year and month data as
  // the rest of the app. It never sends a query to Spotify or an external API.
  const searchCategories = { artists: 'Artist', tracks: 'Track', albums: 'Album', playlists: 'Playlist' };
  function exploreItem(category, item) {
    saveNavigation();
    state.search.query = item.name;
    state.search.filter = category;
    state.search.selected = { category, key: recordKey(category, item) };
    state.search.limit = 30;
    $('unified-search').value = item.name;
    $('search-filter').value = category;
    openView('search', false);
  }
  function searchScore(item, category, query) {
    if (!query) return 0;
    const name = item.name.toLocaleLowerCase('en-GB');
    const credits = artistCreditLabel(item).toLocaleLowerCase('en-GB');
    const album = (item.album || '').toLocaleLowerCase('en-GB');
    const terms = query.split(/\s+/).filter(Boolean);
    if (!terms.every(term => `${name} ${credits} ${album}`.includes(term))) return -1;
    if (name === query) return 100;
    if (name.startsWith(query)) return 75;
    if (name.includes(query)) return 55;
    if (category === 'tracks' && credits.split(', ').some(credit => credit === query)) return 45;
    if (credits.includes(query)) return 35;
    return 10;
  }
  function renderSearch() {
    $('search-range').textContent = state.year === 'all' ? 'ALL TIME' : state.year;
    document.querySelectorAll('[data-search-filter-chip]').forEach(button => {
      button.classList.toggle('active', button.dataset.searchFilterChip === state.search.filter);
      button.setAttribute('aria-pressed', String(button.dataset.searchFilterChip === state.search.filter));
    });
    const query = state.search.query.trim().toLocaleLowerCase('en-GB');
    const matches = [];
    for (const category of ['tracks', 'artists', 'albums', 'playlists']) {
      if (state.search.filter !== 'all' && state.search.filter !== category) continue;
      for (const item of playlistSearchEntities(category)) {
        const score = searchScore(item, category, query);
        if (score >= 0) matches.push({ category, item, score });
      }
    }
    matches.sort((a, b) => b.score - a.score || (b.item.plays || 0) - (a.item.plays || 0) || (b.item.ms || 0) - (a.item.ms || 0));
    state.search.matches = matches;
    renderSearchResults();
    renderSearchDetail();
  }
  function renderSearchResults() {
    const matches = state.search.matches;
    const results = $('search-results');
    $('search-result-count').textContent = `${number(matches.length)} ${matches.length === 1 ? 'result' : 'results'}`;
    if (!matches.length) {
      results.innerHTML = emptyMessage('No matches in your listening history or playlists. Try another search.');
    } else {
      results.innerHTML = matches.slice(0, state.search.limit).map(({ category, item }, index) => {
        const selected = state.search.selected?.category === category && state.search.selected.key === recordKey(category, item);
        const sub = category === 'tracks' ? `${artistCreditLabel(item)}${item.album ? ' · ' + item.album : ''}` :
          category === 'albums' ? item.artist : category === 'playlists' ? `${number(item.trackCount)} tracks · ${item.source === 'social' ? 'Social collection' : 'Saved playlist'}` : `${number(item.plays)} credited plays`;
        return `<button type="button" class="search-result ${selected ? 'selected' : ''}" data-search-result="${index}" aria-pressed="${selected}">
          <span class="search-result-art" aria-hidden="true">${category === 'tracks' ? '♫' : category === 'albums' ? '▤' : category === 'playlists' ? '≡' : '◉'}</span>
          <span class="search-result-main"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><small title="${escapeHtml(sub)}">${escapeHtml(sub)}</small></span>
          <span class="search-result-meta"><span>${escapeHtml(searchCategories[category])}</span><b>${item.playlistOnly ? 'Playlist only' : `${number(item.plays)} plays`}</b></span>
          <span class="search-result-arrow" aria-hidden="true">↗</span></button>`;
      }).join('');
    }
    $('search-more').classList.toggle('hidden', matches.length <= state.search.limit);
    $('search-more').textContent = `Show more (${number(matches.length - state.search.limit)} remaining) ↓`;
  }
  function searchMonthlyHistory(category, item) {
    if (!state.report?.monthDetails) return [];
    const key = recordKey(category, item);
    return Object.entries(state.report.monthDetails)
      .filter(([month]) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && (state.year === 'all' || month.startsWith(state.year + '-')))
      .map(([month, data]) => ({ month, entry: (data[category] || []).find(record => recordKey(category, record) === key) }))
      .filter(({ entry }) => entry && entry.plays > 0)
      .sort((a, b) => a.month.localeCompare(b.month));
  }
  function searchTimeline(history) {
    if (!history.length) return emptyMessage('Month-by-month details are not stored in this report. Re-import your original history to unlock the full timeline.');
    const first = monthNumber(history[0].month), last = monthNumber(history.at(-1).month);
    const span = last - first + 1;
    const bucketWidth = Math.max(1, Math.ceil(span / 28));
    const buckets = [];
    const values = new Map(history.map(({ month, entry }) => [monthNumber(month), entry.plays]));
    for (let start = first; start <= last; start += bucketWidth) {
      const end = Math.min(last, start + bucketWidth - 1);
      let plays = 0;
      for (let index = start; index <= end; index++) plays += values.get(index) || 0;
      const labelMonth = month => `${Math.floor((month - 1) / 12)}-${String((month - 1) % 12 + 1).padStart(2, '0')}`;
      buckets.push({ label: bucketWidth === 1 ? monthShort(labelMonth(start)) : `${monthShort(labelMonth(start))} – ${monthShort(labelMonth(end))}`, plays });
    }
    const max = Math.max(...buckets.map(bucket => bucket.plays), 1);
    return `<div class="search-timeline" role="img" aria-label="Monthly plays from ${escapeHtml(monthShort(history[0].month))} to ${escapeHtml(monthShort(history.at(-1).month))}">
      ${buckets.map(bucket => `<div class="search-timeline-col" title="${escapeHtml(bucket.label)}: ${number(bucket.plays)} plays"><span class="search-timeline-bar" style="height:${bucket.plays ? Math.max(4, bucket.plays / max * 100) : 0}%"></span></div>`).join('')}</div>
      <div class="search-timeline-axis"><span>${escapeHtml(monthShort(history[0].month))}</span><span>${escapeHtml(monthShort(history.at(-1).month))}</span></div>
      ${bucketWidth > 1 ? `<p class="search-muted">Each bar represents up to ${number(bucketWidth)} months.</p>` : ''}`;
  }
  function searchEraLinks(category, item) {
    if (!state.report?.monthDetails) return [];
    const months = eligibleEraMonths();
    const chapters = detectListeningEras(months);
    const key = recordKey(category, item);
    return chapters.filter(chapter => chapter[category].slice(0, category === 'artists' ? 5 : 10)
      .some(entry => recordKey(category, entry) === key))
      .map(chapter => ({ title: chapter.title, from: chapter.from, to: chapter.to }));
  }
  function searchDemoConnections(category, item) {
    if (category !== 'tracks' || !state.report?.isDemo || !state.report.demoData) return '';
    const data = state.report.demoData;
    const track = [...(data.catalogue || []), ...(data.curatedTracks || [])].find(row => keyOf(row.artist, row.title) === keyOf(item.artist, item.name));
    if (!track) return '';
    const playlists = [
      ...(data.playlists || []).filter(list => list.trackIds.includes(track.id)),
      ...(state.report.playlists || []).filter(list => list.tracks.some(entry => entry.id === track.id))
    ];
    const shares = (data.messages || []).filter(message => message.trackId === track.id && message.direction === 'received');
    const senders = [...new Set(shares.map(message => (data.friends || []).find(friend => friend.id === message.friendId)?.name).filter(Boolean))];
    const saved = (data.savedTrackIds || []).includes(track.id);
    const outcomes = {
      'new-favourite': 'Became a new favourite',
      'new-discovery': 'Discovered after the recommendation',
      rediscovered: 'Rediscovered after a long break',
      'already-loved': 'Already in your rotation',
      'followed-up': 'Listened again after the recommendation',
      'not-followed-up': 'No listening soon after the recommendation'
    };
    const story = [...shares].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 4).map(message => {
      const friend = (data.friends || []).find(person => person.id === message.friendId);
      const detail = outcomes[message.outcome] || 'Recommended';
      const followUp = message.playsIn90Days ? ` · ${number(message.playsIn90Days)} ${message.playsIn90Days === 1 ? 'play' : 'plays'} in 90 days` : '';
      return `<div><strong>${escapeHtml(friend?.name || 'A friend')} · ${escapeHtml(dateLabel(message.ts))}</strong><p>${escapeHtml(detail)}${followUp}</p></div>`;
    }).join('');
    return `<article class="panel search-detail-section"><div class="panel-heading"><div><div class="kicker">EXAMPLE SOCIAL & LIBRARY DATA</div><h2>Connections</h2></div></div>
      <div class="search-connections">
      <div><strong>${saved ? 'Saved in your library' : 'Not saved in your library'}</strong><p>Demo library snapshot</p></div>
      <div><strong>${number(playlists.length)} ${playlists.length === 1 ? 'playlist' : 'playlists'}</strong><p>${escapeHtml(playlists.map(list => list.name).join(', ') || 'Not in any demo playlists')}</p></div>
      <div><strong>${number(senders.length)} recommending ${senders.length === 1 ? 'friend' : 'friends'}</strong><p>${number(shares.length)} simulated recommendations · chronological listening outcomes</p></div>
      ${story}
      ${shares.length > 4 ? `<p class="search-muted">And ${number(shares.length - 4)} earlier recommendations.</p>` : ''}
      </div></article>`;
  }
  function searchRealPlaylistConnections(category, item) {
    if (category !== 'tracks' || !state.report || state.report.isDemo) return '';
    const lists = (state.report.playlists || []).filter(list => list.tracks.some(track =>
      (item.uri && track.uri && item.uri === track.uri) ||
      keyOf(track.artist, track.title) === keyOf(item.artist, item.name)));
    if (!lists.length) return '';
    return `<article class="panel search-detail-section"><div class="panel-heading"><div><div class="kicker">SAVED COLLECTIONS</div><h2>Playlist memberships</h2></div></div>
      <p class="search-muted">This track occurs in ${number(lists.length)} imported ${lists.length === 1 ? 'playlist' : 'playlists'}. However, Spotify does not tell us if playback came from a playlist.</p>
      <div class="search-entity-links">${lists.map(list => `<button type="button" data-playlist-open="${escapeHtml(list.id)}">${escapeHtml(list.name)} ↗</button>`).join('')}</div></article>`;
  }

  function renderSearchDetail() {
    const target = $('search-detail');
    const selected = state.search.selected;
    if (!selected) {
      target.innerHTML = `<div class="panel search-detail-placeholder"><span aria-hidden="true">♫</span><h2>Every song has a story.</h2><p>Choose a track, artist, album, or playlist to discover its listening timeline, milestones, and connections to your musical eras.</p></div>`;
      return;
    }
    const item = searchEntity(selected.category, selected.key);
    if (!item) {
      state.search.selected = null;
      target.innerHTML = emptyMessage('This entry is not present in the selected year. Try All time.');
      return;
    }
    const category = selected.category;
    if (category === 'playlists') {
      const list = playlistCollections().find(list => list.id === item.id);
      target.innerHTML = list ? playlistDetailMarkup(list, true) : emptyMessage('This playlist is unavailable.');
      return;
    }
    const history = searchMonthlyHistory(category, item);
    const first = history[0]?.month || null;
    const last = history.at(-1)?.month || null;
    const peak = [...history].sort((a, b) => b.entry.plays - a.entry.plays)[0];
    const eras = searchEraLinks(category, item);
    const subtitle = category === 'tracks' ? `${artistCreditLabel(item)}${item.album ? ' · ' + item.album : ''}` :
      category === 'albums' ? item.artist : 'Artist';
    const categories = { artists: '◉', tracks: '♫', albums: '▤', playlists: '≡' };
    const stats = [
      ['Qualifying plays', number(item.plays)], ['Listening time', `${hours(item.ms)} hrs`],
      ['First recorded month', first ? monthShort(first) : 'Unavailable'],
      ['Most recent month', last ? monthShort(last) : 'Unavailable']
    ];
    if (peak) stats.push(['Peak month', `${monthShort(peak.month)} · ${number(peak.entry.plays)} plays`]);
    if (category === 'tracks') stats.push(['Credited artists', number(artistCredits(item).length)]);
    const related = category === 'artists'
      ? (period().tracks || []).filter(row => artistCredits(row).some(name => keyOf(name) === keyOf(item.name))).slice(0, 6)
      : category === 'albums'
        ? (period().tracks || []).filter(row => keyOf(row.artist, row.album) === keyOf(item.artist, item.name)).slice(0, 6)
        : [];
    const links = category === 'tracks'
      ? `<div class="search-entity-links">${artistCredits(item).map(name => `<button type="button" data-explore-category="artists" data-explore-key="${escapeHtml(encodeURIComponent(keyOf(name)))}">Explore ${escapeHtml(name)} ↗</button>`).join('')}${item.album ? `<button type="button" data-explore-category="albums" data-explore-key="${escapeHtml(encodeURIComponent(keyOf(item.artist, item.album)))}">Explore ${escapeHtml(item.album)} ↗</button>` : ''}</div>` : '';
    target.innerHTML = `<article class="panel search-detail-main"><div class="search-detail-title"><span class="search-detail-art">${categories[category]}</span><div><div class="kicker">${escapeHtml(searchCategories[category].toUpperCase())} DEEP DIVE</div><h2>${escapeHtml(item.name)}<span class="accent">.</span></h2><p>${escapeHtml(subtitle)}</p></div></div>
      <div class="search-stat-grid">${stats.map(([label, value]) => `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('')}</div>${links}</article>
      <article class="panel search-detail-section"><div class="panel-heading"><div><div class="kicker">THROUGH THE YEARS</div><h2>Listening timeline</h2></div><span class="heading-note">RECORDED PLAYS</span></div>${searchTimeline(history)}</article>
      <article class="panel search-detail-section"><div class="panel-heading"><div><div class="kicker">CONNECTED TO YOUR HISTORY</div><h2>Listening eras</h2></div></div>
      ${eras.length ? `<div class="search-era-links">${eras.map(era => `<button type="button" data-search-era-month="${escapeHtml(era.to)}"><strong>${escapeHtml(era.title)} era</strong><span>${escapeHtml(monthSpan(era.from, era.to))} ↗</span></button>`).join('')}</div>` : `<p class="search-muted">Not among the leading ${category} in any automatically detected era for this time range.</p>`}</article>
      ${related.length ? `<article class="panel search-detail-section"><div class="panel-heading"><div><div class="kicker">GO DEEPER</div><h2>${category === 'albums' ? 'Most played album tracks' : 'Most played tracks featuring this artist'}</h2></div></div><div class="rank-list">${related.map((row, i) => rankRow(row, i, 'tracks', 'plays')).join('')}</div></article>` : ''}
      ${searchDemoConnections(category, item)}
      ${searchRealPlaylistConnections(category, item)}
      ${category === 'tracks' && !state.report?.isDemo ? `<p class="search-muted">Spotify's standard listening history export does not identify which playlist a track was played from. Saved playlist memberships come from Account Data only.</p>` : ''}
      <p class="search-muted">Counts reflect streams of at least 30 seconds, grouped by UTC month. An era connection means this was among that chapter's leading entries. Historical reports without month level data cannot show a precise timeline.</p>`;
  }

  async function refreshHistoryCount() {
    try { $('history-badge').textContent = number((await listReports()).length); }
    catch { $('history-badge').textContent = '0'; }
  }
  async function renderHistory() {
    const root = $('history-list');
    let reports = [];
    try { reports = await listReports(); }
    catch { root.innerHTML = emptyMessage('Your browser is blocking local report storage.'); return; }
    $('clear-history').disabled = reports.length === 0;
    if (!reports.length) {
      root.innerHTML = emptyMessage('No saved reports yet. Import your Spotify ZIP on the Home page to create one.');
      return;
    }
    root.innerHTML = reports.map(report => `<article class="history-card"><div class="history-card-head"><span class="history-icon">♫</span><span class="history-date">Saved ${dateLabel(report.createdAt)}</span></div><h3>${escapeHtml(report.filename)}</h3><p>${number(report.periods?.all?.qualified ?? Math.max(0, report.imported - report.short))} streams · ${escapeHtml(report.type)}${report.playlistImport?.playlists ? ` · ${number(report.playlistImport.playlists)} playlists` : ''}<br>${report.firstTs ? `${dateLabel(report.firstTs)} – ${dateLabel(report.lastTs)}` : 'No listening history in this report'}</p><div class="history-actions"><button class="btn btn-primary" data-open-report="${report.id}">Open report ↗</button><button class="btn btn-outline" data-export-report="${report.id}">Export JSON ↓</button><button class="btn btn-danger" data-delete-report="${report.id}">Delete</button></div></article>`).join('');
  }

  async function loadDemoTracks() {
    const response = await fetch('./demo-tracks.yaml', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load demo-tracks.yaml (HTTP ${response.status}). Check that the file is included in your deployment.`);
    const lines = (await response.text()).split(/\r?\n/);
    const tracks = [];
    let track = null;
    for (const [index, line] of lines.entries()) {
      if (!line.trim() || line.trim().startsWith('#') || line.trim() === '---' || line === 'tracks:') continue;
      const first = line.match(/^  - title: (.+)$/);
      const property = line.match(/^    (artist|album|released|seconds|credits): (.+)$/);
      if (first) {
        try {
          track = { title: JSON.parse(first[1]) };
        } catch {
          throw new Error(`Invalid demo catalogue title on line ${index + 1}. Use a double-quoted YAML string.`);
        }
        tracks.push(track);
      } else if (property && track) {
        try {
          track[property[1]] = JSON.parse(property[2]);
        } catch {
          throw new Error(`Invalid demo catalogue value on line ${index + 1}. Use double-quoted YAML strings.`);
        }
      } else {
        throw new Error(`Invalid demo catalogue format on line ${index + 1}.`);
      }
    }
    if (!tracks.length) throw new Error('The demo catalogue has no tracks.');
    const keys = new Set();
    for (const [index, item] of tracks.entries()) {
      if (!['title', 'artist', 'album', 'released'].every(field => typeof item[field] === 'string' && item[field].trim()) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(item.released) ||
          !Number.isInteger(item.seconds) || item.seconds < 0 ||
          (item.credits !== undefined && (!Array.isArray(item.credits) || !item.credits.every(name => typeof name === 'string' && name.trim())))) {
        throw new Error(`Invalid demo track entry ${index + 1}. Check its fields, date, and duration.`);
      }
      const date = new Date(`${item.released}T00:00:00Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== item.released) {
        throw new Error(`Invalid release date for demo track ${index + 1}.`);
      }
      const key = keyOf(item.title, item.artist, item.album);
      if (keys.has(key)) throw new Error(`Duplicate demo catalogue entry: ${item.artist} — ${item.title}.`);
      keys.add(key);
    }
    return tracks;
  }

  // A separate source of truth for curated demo playlists. Do not pass these
  // tracks into the saved-library pool or the randomly generated friend playlists.
  async function loadDemoPlaylists() {
    const response = await fetch('./demo-playlists.yaml', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load demo-playlists.yaml (HTTP ${response.status}). Keep it alongside demo-tracks.yaml.`);
    const lists = [];
    let current = null, track = null, root = false;
    const lines = (await response.text()).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim() || line.trim().startsWith('#') || line.trim() === '---') continue;
      if (line === 'playlists:') { if (root) throw new Error('Duplicate playlists root.'); root = true; continue; }
      const header = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
      const title = line.match(/^    - title: (.+)$/);
      const property = line.match(/^      (artist|album|released|seconds|credits|playlist|playlist_position): (.+)$/);
      if (header && root) {
        if (lists.some(list => list.id === `curated:${header[1]}`)) throw new Error(`Duplicate playlist key ${header[1]}.`);
        current = { id: `curated:${header[1]}`, slug: header[1], name: '', source: 'curated', tracks: [] };
        lists.push(current); track = null;
      } else if (title && current) {
        try { track = { title: JSON.parse(title[1]) }; }
        catch { throw new Error(`Invalid playlist track title on line ${index + 1}. Use double-quoted strings.`); }
        current.tracks.push(track);
      } else if (property && track) {
        try { track[property[1]] = JSON.parse(property[2]); }
        catch { throw new Error(`Invalid playlist property on line ${index + 1}. Quote text with double quotes.`); }
      } else throw new Error(`Invalid demo-playlists.yaml format at line ${index + 1}.`);
    }
    if (!root || !lists.length) throw new Error('demo-playlists.yaml must contain playlists with named collections.');
    for (const list of lists) {
      if (!list.tracks.length) throw new Error(`Playlist ${list.slug} has no tracks.`);
      const positions = new Set();
      for (const [index, item] of list.tracks.entries()) {
        if (!['title', 'artist', 'album', 'released'].every(field => typeof item[field] === 'string' && item[field].trim()) ||
            !/^\d{4}-\d{2}-\d{2}$/.test(item.released) ||
            !Number.isInteger(item.seconds) || item.seconds <= 0 ||
            !Number.isInteger(item.playlist_position) || item.playlist_position < 1 ||
            (item.credits !== undefined && (!Array.isArray(item.credits) || !item.credits.every(name => typeof name === 'string' && name.trim())))) {
          throw new Error(`Invalid track ${index + 1} in playlist ${list.slug}.`);
        }
        const date = new Date(`${item.released}T00:00:00Z`);
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== item.released)
          throw new Error(`Invalid release date for ${item.title} in playlist ${list.slug}.`);
        if (positions.has(item.playlist_position)) throw new Error(`Duplicate position ${item.playlist_position} in ${list.slug}.`);
        positions.add(item.playlist_position);
        if (typeof item.playlist !== 'string' || !item.playlist.trim()) throw new Error(`Missing playlist name for ${item.title}.`);
        if (!list.name) list.name = item.playlist;
        else if (list.name !== item.playlist) throw new Error(`Conflicting playlist names in ${list.slug}.`);
      }
      list.tracks.sort((a, b) => a.playlist_position - b.playlist_position);
    }
    return lists;
  }

  async function makeDemo() {
    if (state.loading) return;
    const trace = startTrace('demo');
    let phase = 'Load demo catalogue';
    state.loading = true;
    $('randomise-demo').disabled = true;
    $('demo-button').disabled = true;
    const randomising = state.report?.isDemo && state.view !== 'home';
    showLoading(randomising ? 'Randomising your demo…' : 'Preparing your demo…', 'Generating a listening history in your browser.');
    try {
      await letLoadingPaint();
      const loadedAt = performance.now();
      const [tracks, definedPlaylists] = await Promise.all([loadDemoTracks(), loadDemoPlaylists()]);
      timeStage(trace, 'Load catalogue', loadedAt);
      trace.files = 2;
      phase = 'Generate listening history';
      const generatingAt = performance.now();
      updateLoading(randomising ? 'Randomising your demo…' : 'Building your demo…', 'Creating years of listening activity.');
      let seed = crypto.getRandomValues(new Uint32Array(1))[0];
      const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      const randomInt = (min, max) => min + Math.floor(rand() * (max - min + 1));
      const choose = list => list[Math.floor(rand() * list.length)];
      const shuffled = list => {
        const copy = [...list];
        for (let i = copy.length - 1; i > 0; i--) {
          const j = randomInt(0, i);
          [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
      };
      const now = Date.now();
      const startYear = 2016;
      const endYear = new Date(now).getUTCFullYear();
      const minDate = Date.UTC(startYear, 0, 1);
      const cutoff = now;
      const platforms = ['linux', 'windows', 'macos', 'android', 'ios', 'chromecast', 'Apple TV', 'Android TV', 'Sonos'];
      const artistWeights = new Map();
      const albumWeights = new Map();
      const trackWeights = new Map();
      const years = [];
      const allSessions = [];
      const rows = [];
      const byYear = new Map();
      const artists = [...new Set(tracks.map(track => track.artist))];
      const catalogue = tracks.map(({ title, artist, album, released, seconds, credits: listedCredits = [] }, id) => {
        const candidates = [...listedCredits, ...featureCreditsFromTitle(title)];
        const credits = creditedNames(candidates).filter(name => keyOf(name) !== keyOf(artist));
        return {
          id, title, artist, album, released, credits, releasedAt: Date.parse(released + 'T00:00:00Z'),
          length: seconds ? seconds * 1000 : randomInt(115, 270) * 1000
        };
      });
      // Exact artist/title/album matches share a recording ID, but ownership stays
      // separate. Different recordings or releases never collapse on title alone.
      const identity = new Map(catalogue.map(track => [keyOf(track.artist, track.title, track.album), track]));
      const playlistCatalogue = [];
      const curatedPlaylists = definedPlaylists.map(list => {
        const members = list.tracks.map(entry => {
          const key = keyOf(entry.artist, entry.title, entry.album);
          let track = identity.get(key);
          if (!track) {
            const credits = creditedNames([...(entry.credits || []), ...featureCreditsFromTitle(entry.title)])
              .filter(name => keyOf(name) !== keyOf(entry.artist));
            track = { id: catalogue.length + playlistCatalogue.length, title: entry.title,
              artist: entry.artist, album: entry.album, released: entry.released,
              credits, releasedAt: Date.parse(entry.released + 'T00:00:00Z'), length: entry.seconds * 1000 };
            identity.set(key, track);
            playlistCatalogue.push(track);
          }
          return track;
        });
        return { id: list.id, slug: list.slug, name: list.name, source: 'curated',
          tracks: members.map((track, index) => ({ ...track, position: list.tracks[index].playlist_position })),
          availableAt: Math.max(...members.map(track => track.releasedAt)) };
      });
      for (const artist of artists) artistWeights.set(artist, 0.75 + 0.85 * rand());
      for (const track of catalogue) {
        const albumKey = keyOf(track.artist, track.album);
        if (!albumWeights.has(albumKey)) albumWeights.set(albumKey, 0.8 + 0.55 * rand());
        // Keep individual favourites without letting a few lucky weights dominate the catalogue.
        trackWeights.set(track.id, (0.65 + 1.5 * rand() ** 2) * artistWeights.get(track.artist) * albumWeights.get(albumKey));
      }
      // Give demo only tracks believable listening stories instead of relying on
      // incidental random repeats. These records pass through the normal importer;
      // the Eras thresholds and genuine Spotify data are deliberately unchanged.
      const storyBursts = new Map();
      const storyKeys = new Set();
      const storyKey = track => keyOf(track.artist, track.title);
      const finalDemoMonth = new Date(cutoff - 6 * 86400_000);
      const finalDemoMonthNumber = finalDemoMonth.getUTCFullYear() * 12 + finalDemoMonth.getUTCMonth();
      const storyMonthNumber = date => date.getUTCFullYear() * 12 + date.getUTCMonth();
      const storyMonthStart = (year, month) => Date.UTC(year, month - 1, 1);
      const storyMonthIsUsable = timestamp => storyMonthNumber(new Date(timestamp)) <= finalDemoMonthNumber;
      const pickStoryTrack = timestamp => {
        const available = catalogue.filter(track => !storyKeys.has(storyKey(track)) &&
          track.releasedAt <= timestamp + 5 * 86400_000);
        if (!available.length) return null;
        const track = choose(available);
        storyKeys.add(storyKey(track));
        return track;
      };
      const addStoryBurst = (track, timestamp, count) => {
        const year = String(new Date(timestamp).getUTCFullYear());
        const list = storyBursts.get(year) || [];
        list.push({ track, timestamp, count });
        storyBursts.set(year, list);
      };
      for (let year = startYear; year <= endYear; year++) {
        const lastMonth = year === finalDemoMonth.getUTCFullYear()
          ? finalDemoMonth.getUTCMonth() + 1 : 12;
        if (year > finalDemoMonth.getUTCFullYear() || lastMonth < 1) continue;

        // A short first month obsession; make the newest available month useful
        // when the user first opens Eras in the randomised demo.
        const obsessionMonth = year === finalDemoMonth.getUTCFullYear()
          ? lastMonth : randomInt(1, lastMonth);
        const firstDate = storyMonthStart(year, obsessionMonth);
        const obsession = pickStoryTrack(firstDate);
        if (obsession) {
          addStoryBurst(obsession, firstDate, randomInt(7, 14));
          // A genuine 8–24 month absence, followed by several repeat plays.
          // Reserve the track from ordinary random listening in between.
          const quietMonths = randomInt(8, 24);
          const comeback = Date.UTC(year, obsessionMonth - 1 + quietMonths + 1, 1);
          if (storyMonthIsUsable(comeback)) addStoryBurst(obsession, comeback, randomInt(5, 10));
        }

        // A different track becomes a favourite and then vanishes completely.
        // Only schedule this far enough back for the actual 12 month rule.
        const forgottenMonth = randomInt(1, lastMonth);
        const forgottenDate = storyMonthStart(year, forgottenMonth);
        if (finalDemoMonthNumber - storyMonthNumber(new Date(forgottenDate)) >= 12) {
          const forgotten = pickStoryTrack(forgottenDate);
          if (forgotten) addStoryBurst(forgotten, forgottenDate, randomInt(6, 12));
        }
      }
      const dayMs = 86400_000;
      const listened = new Map();
      const artistPhases = new Map();
      const artistCooldowns = new Map();
      const albumPhases = new Map();
      const albumCooldowns = new Map();
      const playlistPhases = new Map();
      const playlistCooldowns = new Map();
      let previousObsession = null;
      let previousYearArtists = [];
      const habit = randomInt(13, 20); // Average tracks per calendar day, before lighter early years.
      const activeChance = 0.79 + 0.08 * rand();
      const trackWeight = track => {
        if (track.length < 30_000) return 0.015;
        if (track.length < 55_000) return 0.07;
        if (track.length < 85_000) return 0.25;
        if (track.length < 120_000) return 0.62;
        return 1;
      };
      // Monthly weighted pools are built once. Individual plays are sampled in O(log n),
      // rather than rescoring the entire catalogue for every play.
      const makePool = (items, weight) => {
        const cumulative = new Float64Array(items.length);
        let total = 0;
        for (let i = 0; i < items.length; i++) {
          total += Math.max(0.00001, weight(items[i]));
          cumulative[i] = total;
        }
        return { items, cumulative, total };
      };
      const pickPool = pool => {
        if (!pool?.items.length) return null;
        const roll = rand() * pool.total;
        let left = 0, right = pool.items.length - 1;
        while (left < right) {
          const mid = (left + right) >>> 1;
          if (roll < pool.cumulative[mid]) right = mid;
          else left = mid + 1;
        }
        return pool.items[left];
      };
      const pickAvailable = (pool, timestamp, fallback) => {
        for (let retry = 0; retry < 14; retry++) {
          const track = pickPool(pool);
          if (track?.releasedAt <= timestamp) return track;
        }
        // Only needed for release month sessions where some tracks aren't out yet.
        return fallback.find(track => track.releasedAt <= timestamp) || null;
      };
      const artistTrackCounts = tracks => {
        const counts = new Map();
        for (const track of tracks) {
          if (track.length < 90_000) continue;
          counts.set(track.artist, (counts.get(track.artist) || 0) + 1);
        }
        return counts;
      };
      const weightedArtist = (names, favourites, counts) => {
        const pool = names.map(artist => ({
          artist, weight: (favourites.includes(artist) ? 1.3 : 1) *
            artistWeights.get(artist) * Math.sqrt(counts.get(artist) || 1)
        }));
        return pickPool(makePool(pool, item => item.weight))?.artist;
      };
      const phaseBoost = (phase, monthIndex, peak) => {
        const elapsed = monthIndex - phase.start;
        if (elapsed < phase.peakMonths) return peak;
        const remaining = phase.peakMonths + phase.fadeMonths - elapsed;
        return 1 + (peak - 1) * remaining / (phase.fadeMonths + 1);
      };
      for (let year = startYear; year <= endYear; year++) {
        const begin = Math.max(minDate, Date.UTC(year, 0, 1));
        const end = Math.min(cutoff, Date.UTC(year + 1, 0, 1) - 1);
        if (end <= begin) continue;
        const available = catalogue.filter(track => track.releasedAt <= end && !storyKeys.has(storyKey(track)));
        if (!available.length) continue;
        const eligibleArtists = [...new Set(available.map(track => track.artist))];
        const yearArtistCounts = artistTrackCounts(available);
        const yearArtists = shuffled(previousYearArtists.filter(name => eligibleArtists.includes(name))).slice(0, randomInt(1, 2));
        while (yearArtists.length < Math.min(9, eligibleArtists.length)) {
          const artist = weightedArtist(eligibleArtists.filter(name => !yearArtists.includes(name)), previousYearArtists, yearArtistCounts);
          if (!artist) break;
          yearArtists.push(artist);
        }
        previousYearArtists = yearArtists;
        const yearRows = [];
        let sessionCount = 0;
        const yearActivity = 0.76 + rand() * 0.52;
        for (let month = 0; month < 12; month++) {
          const monthStart = Date.UTC(year, month, 1);
          if (monthStart >= cutoff) break;
          const monthEnd = Math.min(cutoff, Date.UTC(year, month + 1, 1));
          const monthTracks = available.filter(track => track.releasedAt < monthEnd);
          if (!monthTracks.length) continue;
          const monthArtists = [...new Set(monthTracks.map(track => track.artist))];
          const monthArtistCounts = artistTrackCounts(monthTracks);
          const monthIndex = year * 12 + month;
          const yearSet = new Set(yearArtists);
          for (const [artist, phase] of artistPhases) {
            if (!monthArtistCounts.has(artist) || monthIndex >= phase.start + phase.peakMonths + phase.fadeMonths) artistPhases.delete(artist);
          }
          const eligibleFocusArtists = monthArtists.filter(artist => monthArtistCounts.has(artist));
          const wanted = Math.min(eligibleFocusArtists.length, randomInt(3, 5));
          let focus = [...artistPhases].filter(([, phase]) => monthIndex < phase.start + phase.peakMonths).map(([artist]) => artist);
          while (focus.length < wanted) {
            const candidates = eligibleFocusArtists.filter(artist => !artistPhases.has(artist) && (artistCooldowns.get(artist) || 0) <= monthIndex);
            const artist = weightedArtist(candidates, yearArtists, monthArtistCounts);
            if (!artist) break;
            const peakMonths = randomInt(2, 3);
            const fadeMonths = randomInt(1, 2);
            artistPhases.set(artist, { start: monthIndex, peakMonths, fadeMonths });
            artistCooldowns.set(artist, monthIndex + peakMonths + fadeMonths + randomInt(6, 10));
            focus.push(artist);
          }
          const focusSet = new Set(focus);
          const artistBoosts = new Map([...artistPhases].map(([artist, phase]) => [artist, phaseBoost(phase, monthIndex, 4.5)]));
          const regular = monthTracks.filter(track => track.length >= 90_000 && track.releasedAt <= monthStart);
          const obsessionCandidates = regular;
          const obsessionTracks = shuffled(
            previousObsession && obsessionCandidates.some(track => track.id === previousObsession.id) && rand() < .42
              ? [previousObsession, ...shuffled(obsessionCandidates.filter(track => track.id !== previousObsession.id))]
              : obsessionCandidates
          ).slice(0, Math.min(3, obsessionCandidates.length));
          // Let a notable monthly favourite occasionally persist across months.
          if (previousObsession && rand() < .36 && obsessionCandidates.includes(previousObsession)) obsessionTracks[0] = previousObsession;
          previousObsession = obsessionTracks[0] || null;
          const obsessionIds = new Set(obsessionTracks.map(track => track.id));
          const baseWeight = track => {
            const ageDays = Math.max(0, (monthStart - track.releasedAt) / dayMs);
            const release = ageDays < 120 ? 2.15 : ageDays < 365 ? 1.5 : 1;
            return trackWeights.get(track.id) * trackWeight(track) * release;
          };
          const byArtist = new Map();
          const byAlbum = new Map();
          for (const track of monthTracks) {
            if (!byArtist.has(track.artist)) byArtist.set(track.artist, []);
            byArtist.get(track.artist).push(track);
            const albumKey = keyOf(track.artist, track.album);
            if (!byAlbum.has(albumKey)) byAlbum.set(albumKey, { artist: track.artist, tracks: [] });
            byAlbum.get(albumKey).tracks.push(track);
          }
          const albums = [...byAlbum.values()].filter(album => album.tracks.filter(track => track.length >= 80_000).length >= 3);
          for (const [albumKey, phase] of albumPhases) {
            if (!byAlbum.has(albumKey) || monthIndex >= phase.start + phase.peakMonths + phase.fadeMonths) albumPhases.delete(albumKey);
          }
          const wantedAlbums = Math.min(albums.length, randomInt(1, 2));
          let focusedAlbums = [...albumPhases].filter(([, phase]) => monthIndex < phase.start + phase.peakMonths).length;
          while (focusedAlbums < wantedAlbums) {
            const candidates = albums.filter(album => {
              const albumKey = keyOf(album.artist, album.tracks[0].album);
              return !albumPhases.has(albumKey) && (albumCooldowns.get(albumKey) || 0) <= monthIndex &&
                album.tracks.some(track => track.releasedAt <= monthStart);
            });
            const chosen = pickPool(makePool(candidates, album => Math.sqrt(album.tracks.length) *
              albumWeights.get(keyOf(album.artist, album.tracks[0].album)) *
              (album.tracks[0].releasedAt > monthStart - 365 * dayMs ? 1.4 : 1)));
            if (!chosen) break;
            const albumKey = keyOf(chosen.artist, chosen.tracks[0].album);
            const peakMonths = randomInt(1, 2);
            const fadeMonths = 1;
            albumPhases.set(albumKey, { start: monthIndex, peakMonths, fadeMonths });
            albumCooldowns.set(albumKey, monthIndex + peakMonths + fadeMonths + randomInt(6, 10));
            focusedAlbums++;
          }
          const albumBoosts = new Map([...albumPhases].map(([albumKey, phase]) => [albumKey, phaseBoost(phase, monthIndex, 4.5)]));
          const general = makePool(monthTracks, track => baseWeight(track) *
            Math.max(artistBoosts.get(track.artist) || 1, albumBoosts.get(keyOf(track.artist, track.album)) || 1) *
            (yearSet.has(track.artist) ? 1.15 : 1) * (obsessionIds.has(track.id) ? 5 : 1));
          const discovery = makePool(monthTracks, track => baseWeight(track) *
            (focusSet.has(track.artist) ? 0.65 : 1.25) *
            (1.5 / (1 + (listened.get(track.id) || 0) / 6)));
          const artistPools = new Map([...byArtist].map(([artist, list]) =>
            [artist, makePool(list, track => baseWeight(track) * (obsessionIds.has(track.id) ? 4 : 1))]));
          const albumPool = makePool(albums, album =>
            Math.sqrt(album.tracks.length) * albumWeights.get(keyOf(album.artist, album.tracks[0].album)) *
            (albumBoosts.get(keyOf(album.artist, album.tracks[0].album)) || 1) *
            (yearSet.has(album.artist) ? 1.1 : 1) *
            (album.tracks[0].releasedAt > monthStart - 240 * dayMs ? 1.65 : 1));
          const availablePlaylists = curatedPlaylists.filter(list => list.availableAt < monthEnd);
          for (const [id, phase] of playlistPhases) {
            if (!availablePlaylists.some(list => list.id === id) ||
                monthIndex >= phase.start + phase.peakMonths + phase.fadeMonths) playlistPhases.delete(id);
          }
          // Scale playlist listening to the *breadth* of curated music rather than
          // reserving a fixed 18% of every session for even a single small playlist.
          // The temporary phase multiplier still gives playlists real binge months;
          // track/artist/album play counts and Eras are left completely unchanged.
          const uniquePlaylistTracks = new Set(availablePlaylists.flatMap(list =>
            list.tracks.filter(track => track.releasedAt < monthEnd && !storyKeys.has(storyKey(track)))
              .map(track => track.id)));
          const playlistBreadth = uniquePlaylistTracks.size /
            (monthTracks.length + uniquePlaylistTracks.size || 1);
          if (availablePlaylists.length && rand() < .48) {
            const candidates = availablePlaylists.filter(list => !playlistPhases.has(list.id) &&
              (playlistCooldowns.get(list.id) || 0) <= monthIndex);
            if (candidates.length) {
              const list = choose(candidates);
              const peakMonths = randomInt(1, 3), fadeMonths = randomInt(1, 2);
              playlistPhases.set(list.id, { start: monthIndex, peakMonths, fadeMonths });
              playlistCooldowns.set(list.id, monthIndex + peakMonths + fadeMonths + randomInt(5, 9));
            }
          }
          const strongestPlaylistPhase = availablePlaylists.reduce((boost, list) => {
            const phase = playlistPhases.get(list.id);
            return Math.max(boost, phase ? phaseBoost(phase, monthIndex, 3) : 1);
          }, 1);
          const playlistSessionChance = Math.min(.15,
            (.015 + .30 * playlistBreadth) * strongestPlaylistPhase);
          const activity = yearActivity * (0.78 + rand() * .46);
          const availabilityFactor = Math.min(1, 0.50 + monthTracks.length / 320);
          const days = Math.ceil((monthEnd - monthStart) / dayMs);
          for (let dayIndex = 0; dayIndex < days; dayIndex++) {
            const start = monthStart + dayIndex * dayMs;
            if (start >= cutoff || rand() >= activeChance) continue;
            const weekday = new Date(start).getUTCDay();
            const weekend = weekday === 0 || weekday === 6 ? 1.14 : 1;
            const target = habit * activity * availabilityFactor * weekend / activeChance;
            let remaining = Math.max(3, Math.min(44, Math.round(target * (0.50 + rand()))));
            const slots = Math.min(4, Math.max(1, Math.ceil(remaining / randomInt(12, 19))));
            const hours = slots === 1 ? [choose([8, 12, 17, 19, 21])] :
              slots === 2 ? [randomInt(7, 11), randomInt(17, 21)] :
              slots === 3 ? [randomInt(7, 9), randomInt(12, 15), randomInt(18, 21)] :
              [randomInt(7, 9), randomInt(11, 13), randomInt(15, 17), randomInt(20, 21)];
            for (let sessionIndex = 0; sessionIndex < slots && remaining > 0; sessionIndex++) {
              const left = slots - sessionIndex;
              const size = left === 1 ? remaining : Math.min(22, Math.max(3,
                Math.round(remaining / left * (0.84 + rand() * .32))));
              remaining -= size;
              const sessionStart = start + hours[sessionIndex] * 3600_000 + randomInt(0, 42) * 60_000;
              if (sessionStart >= monthEnd || sessionStart >= cutoff) continue;
              const mode = choose(platforms);
              const flavour = rand();
              const eligiblePlaylists = availablePlaylists.filter(list =>
                list.availableAt <= sessionStart && list.tracks.some(track => !storyKeys.has(storyKey(track))));
              const playlistSession = eligiblePlaylists.length > 0 && rand() < playlistSessionChance;
              const albumSession = !playlistSession && flavour < .32 && albums.length > 0;
              const artistSession = !playlistSession && flavour >= .32 && flavour < .55;
              const exploring = !playlistSession && flavour >= .83;
              const shuffle = playlistSession ? rand() < .70 : !albumSession && rand() < (exploring ? .82 : .55);
              const selectedPlaylist = playlistSession ? pickPool(makePool(eligiblePlaylists, list =>
                Math.sqrt(list.tracks.length) * (playlistPhases.has(list.id) ? phaseBoost(playlistPhases.get(list.id), monthIndex, 5) : 1))) : null;
              const playlistMembers = selectedPlaylist ? selectedPlaylist.tracks.filter(track => track.releasedAt <= sessionStart && !storyKeys.has(storyKey(track))) : [];
              // Spotify-style shuffle visits the available tracks before repeating,
              // rather than independently drawing the same song multiple times.
              const playlistQueue = selectedPlaylist && shuffle ? shuffled(playlistMembers) : null;
              let playlistIndex = playlistMembers.length && !shuffle && rand() < .76 ? 0 : randomInt(0, Math.max(0, playlistMembers.length - 1));
              let album = albumSession ? pickPool(albumPool) : null;
              let albumIndex = album ? (rand() < .75 ? 0 : randomInt(0, album.tracks.length - 1)) : 0;
              let artist = artistSession ? (focus.length && rand() < .75
                ? weightedArtist(focus, [], monthArtistCounts)
                : weightedArtist(monthArtists, yearArtists, monthArtistCounts)) : null;
              const events = [];
              let cursor = sessionStart;
              for (let i = 0; i < size; i++) {
                let chosen = null;
                if (selectedPlaylist && playlistMembers.length) {
                  if (shuffle) {
                    if (!playlistQueue.length) playlistQueue.push(...shuffled(playlistMembers));
                    chosen = playlistQueue.pop();
                  } else chosen = playlistMembers[playlistIndex++ % playlistMembers.length];
                }
                if (!chosen && album) {
                  if (albumIndex >= album.tracks.length) {
                    album = pickPool(albumPool);
                    albumIndex = album && rand() < .75 ? 0 : album ? randomInt(0, album.tracks.length - 1) : 0;
                  }
                  chosen = album?.tracks[albumIndex++] || null;
                  if (chosen?.releasedAt > cursor) chosen = null;
                }
                if (!chosen && artist && rand() < .80) chosen = pickAvailable(artistPools.get(artist), cursor, byArtist.get(artist));
                if (!chosen) chosen = pickAvailable(exploring ? discovery : general, cursor, monthTracks);
                if (!chosen) break;
                if (!album && !selectedPlaylist && i && chosen.id === events[events.length - 1]?.id) {
                  chosen = pickAvailable(exploring ? discovery : general, cursor, monthTracks) || chosen;
                }
                const skipped = rand() < (albumSession ? .055 : shuffle ? .15 : .085);
                const played = skipped ? randomInt(3, Math.max(3, Math.min(90, Math.ceil(chosen.length / 1000) - 1))) * 1000 :
                  Math.max(1000, chosen.length - randomInt(0, Math.min(5000, chosen.length - 1000)));
                cursor += played + randomInt(0, 4500);
                if (cursor >= monthEnd || cursor >= cutoff || cursor >= start + dayMs) break;
                const entry = {
                  ts: new Date(cursor).toISOString(),
                  master_metadata_album_artist_name: chosen.artist,
                  credited_artists: [chosen.artist, ...chosen.credits],
                  master_metadata_track_name: chosen.title,
                  master_metadata_album_album_name: chosen.album,
                  ms_played: played, platform: mode, skipped, shuffle,
                  offline: rand() < .08,
                  reason_start: i ? 'trackdone' : 'clickrow',
                  reason_end: skipped ? 'fwdbtn' : 'trackdone',
                  demo_track_id: chosen.id, ...(selectedPlaylist ? { demo_playlist_id: selectedPlaylist.id } : {})
                };
                yearRows.push(entry);
                events.push({ id: chosen.id, ts: entry.ts });
                if (played >= MIN_PLAY_MS) listened.set(chosen.id, (listened.get(chosen.id) || 0) + 1);
              }
              if (events.length) {
                allSessions.push({ started: new Date(sessionStart).toISOString(),
                  ended: events[events.length - 1].ts, platform: mode, trackIds: events.map(event => event.id),
                  ...(selectedPlaylist ? { playlistId: selectedPlaylist.id, source: 'playlist' } : { source: albumSession ? 'album' : artistSession ? 'artist' : 'mixed' }) });
                sessionCount++;
              }
            }
          }
          await sleep();
        }
        for (const burst of storyBursts.get(String(year)) || []) {
          const monthEnd = Date.UTC(new Date(burst.timestamp).getUTCFullYear(),
            new Date(burst.timestamp).getUTCMonth() + 1, 1);
          const latest = Math.min(monthEnd - 60_000, cutoff - 60_000);
          const earliest = Math.max(burst.timestamp + 6 * dayMs, burst.track.releasedAt + 60_000);
          if (latest < earliest + burst.track.length) continue;
          const spread = Math.min(latest - earliest - burst.track.length, 9 * dayMs);
          for (let i = 0; i < burst.count; i++) {
            const finishedAt = earliest + burst.track.length + Math.floor(spread * i / Math.max(1, burst.count - 1));
            const platform = choose(platforms);
            const entry = {
              ts: new Date(finishedAt).toISOString(),
              master_metadata_album_artist_name: burst.track.artist,
              credited_artists: [burst.track.artist, ...burst.track.credits],
              master_metadata_track_name: burst.track.title,
              master_metadata_album_album_name: burst.track.album,
              ms_played: burst.track.length,
              platform, skipped: false, shuffle: rand() < .3, offline: rand() < .08,
              reason_start: 'clickrow', reason_end: 'trackdone', demo_track_id: burst.track.id
            };
            yearRows.push(entry);
            allSessions.push({ started: new Date(finishedAt - burst.track.length).toISOString(),
              ended: entry.ts, platform, trackIds: [burst.track.id] });
            sessionCount++;
          }
        }
        years.push({ year, artists: yearArtists, sessions: sessionCount });
        byYear.set(String(year), yearRows.length);
        rows.push(...yearRows);
        updateLoading('Building your demo…', `Simulated listening through ${year}.`);
        await sleep();
      }
      timeStage(trace, 'Generate listening history', generatingAt);
      phase = 'Generate social activity';
      const socialAt = performance.now();
      const day = 86400_000;
      const listenTimes = new Map();
      const indexPlays = () => {
        listenTimes.clear();
        for (const row of rows) {
          if (row.ms_played < MIN_PLAY_MS) continue;
          const list = listenTimes.get(row.demo_track_id) || [];
          list.push(Date.parse(row.ts));
          listenTimes.set(row.demo_track_id, list);
        }
        for (const list of listenTimes.values()) list.sort((a, b) => a - b);
      };
      indexPlays();
      const popularArtists = [...artistWeights.entries()].sort((a, b) => b[1] - a[1]).map(([artist]) => artist);
      const friends = ['Alex', 'Sam', 'Charlie', 'Jordan', 'Taylor', 'Morgan'].map((name, id) => ({
        id: `friend-${id + 1}`, name,
        favouriteArtists: shuffled(popularArtists.slice(0, Math.max(8, Math.ceil(popularArtists.length * .55)))).slice(0, 4)
      }));
      const playlists = ['Night Drives', 'On Repeat', 'Underground', 'Late Night', 'Gym Rotation', 'Old Favourites', 'Discoveries', 'Weekend'].map((name, id) => ({
        id: `playlist-${id + 1}`, name, trackIds: shuffled(catalogue).slice(0, randomInt(18, 55)).map(track => track.id)
      }));
      const messages = [];
      const sharedPairs = new Set();
      const seededTracks = new Set();
      const availableTo = (track, timestamp) => track.length >= 70_000 && track.releasedAt <= timestamp && timestamp < cutoff;
      const pickForFriend = (friend, predicate) => {
        const possible = catalogue.filter(track => !sharedPairs.has(`${friend.id}:${track.id}`) && predicate(track));
        if (!possible.length) return null;
        const favourites = possible.filter(track => friend.favouriteArtists.includes(track.artist));
        return choose(favourites.length && rand() < .72 ? favourites : possible);
      };
      const recommend = (friend, track, timestamp) => {
        if (!track || !availableTo(track, timestamp) || timestamp < minDate) return false;
        const pair = `${friend.id}:${track.id}`;
        if (sharedPairs.has(pair)) return false;
        sharedPairs.add(pair);
        messages.push({ friendId: friend.id, trackId: track.id, ts: new Date(timestamp).toISOString(), direction: 'received' });
        return true;
      };
      const simulateFollowUp = (track, timestamp, obsession) => {
        const count = obsession ? randomInt(8, 15) : randomInt(2, 4);
        const start = timestamp + randomInt(2, 8) * day;
        const span = (obsession ? randomInt(17, 32) : randomInt(6, 14)) * day;
        for (let i = 0; i < count; i++) {
          const finishedAt = Math.min(cutoff - 60_000,
            start + Math.round(span * i / Math.max(1, count - 1)) + randomInt(0, 180) * 1000);
          if (finishedAt <= timestamp || finishedAt <= track.releasedAt) continue;
          const platform = choose(platforms);
          rows.push({
            ts: new Date(finishedAt).toISOString(),
            master_metadata_album_artist_name: track.artist,
            credited_artists: [track.artist, ...track.credits],
            master_metadata_track_name: track.title,
            master_metadata_album_album_name: track.album,
            ms_played: track.length, platform, skipped: false,
            shuffle: rand() < .16, offline: false,
            reason_start: 'clickrow', reason_end: 'trackdone', demo_track_id: track.id
          });
          allSessions.push({ started: new Date(finishedAt - track.length).toISOString(),
            ended: new Date(finishedAt).toISOString(), platform, trackIds: [track.id] });
          const year = String(new Date(finishedAt).getUTCFullYear());
          byYear.set(year, (byYear.get(year) || 0) + 1);
          const summary = years.find(item => String(item.year) === year);
          if (summary) summary.sessions++;
        }
      };
      // Seed real post-recommendation listens; all other outcomes are inferred from the playback timeline.
      for (const friend of friends) {
        for (let i = 0; i < 2; i++) {
          const unheard = track => !seededTracks.has(track.id) && !storyKeys.has(storyKey(track)) &&
            track.length >= 70_000 && track.releasedAt < cutoff - 120 * day &&
            !(listenTimes.get(track.id)?.length);
          let track = pickForFriend(friend, unheard);
          if (track) {
            const earliest = Math.max(minDate, track.releasedAt) + 3 * day;
            const latest = cutoff - 90 * day;
            if (earliest > latest) continue;
            const timestamp = earliest + Math.floor(rand() * (latest - earliest));
            if (recommend(friend, track, timestamp)) {
              seededTracks.add(track.id);
              simulateFollowUp(track, timestamp, i === 0);
            }
          } else {
            track = pickForFriend(friend, item => !seededTracks.has(item.id) &&
              !storyKeys.has(storyKey(item)) && item.length >= 70_000 &&
              (listenTimes.get(item.id)?.[0] || 0) > Math.max(minDate, item.releasedAt) + 12 * day);
            if (!track) continue;
            const first = listenTimes.get(track.id)[0];
            const timestamp = first - randomInt(3, 10) * day;
            if (recommend(friend, track, timestamp)) {
              seededTracks.add(track.id);
              simulateFollowUp(track, timestamp, i === 0);
            }
          }
        }
      }
      indexPlays();
      for (const friend of friends) {
        const target = randomInt(12, 18);
        // Genuine quiet gaps make a friend's recommendation precede a rediscovery.
        for (let i = 0; i < 2; i++) {
          const gaps = [];
          for (const track of catalogue) {
            if (!availableTo(track, cutoff - day) || sharedPairs.has(`${friend.id}:${track.id}`)) continue;
            const times = listenTimes.get(track.id) || [];
            for (let j = 1; j < times.length; j++) {
              if (times[j] - times[j - 1] < 180 * day) continue;
              const timestamp = times[j] - randomInt(3, 12) * day;
              if (timestamp > times[j - 1] + 30 * day && availableTo(track, timestamp)) {
                gaps.push({ track, timestamp });
                break;
              }
            }
          }
          if (!gaps.length) break;
          const preferred = gaps.filter(({track}) => friend.favouriteArtists.includes(track.artist));
          const option = choose(preferred.length && rand() < .72 ? preferred : gaps);
          recommend(friend, option.track, option.timestamp);
        }
        // Some friends share songs you already love; some tips never get played.
        for (let i = 0; i < 3; i++) {
          const track = pickForFriend(friend, item => (listenTimes.get(item.id)?.length || 0) >= 5 &&
            availableTo(item, cutoff - day));
          if (!track) break;
          const times = listenTimes.get(track.id);
          const timestamp = times[randomInt(3, times.length - 1)] + 60_000;
          recommend(friend, track, Math.min(timestamp, cutoff - 1));
        }
        for (let i = 0; i < 3; i++) {
          const track = pickForFriend(friend, item => item.length >= 70_000 && item.releasedAt < cutoff - 22 * day &&
            (listenTimes.get(item.id)?.at(-1) || minDate) < cutoff - 18 * day);
          if (!track) break;
          const earliest = Math.max(minDate, track.releasedAt, (listenTimes.get(track.id)?.at(-1) || minDate)) + 2 * day;
          const latest = cutoff - 1 * day;
          if (earliest <= latest) recommend(friend, track, earliest + Math.floor(rand() * (latest - earliest)));
        }
        let attempts = 0;
        while (messages.filter(message => message.friendId === friend.id).length < target && attempts++ < 120) {
          const track = pickForFriend(friend, item => item.length >= 70_000 && item.releasedAt < cutoff - 15 * day);
          if (!track) break;
          const times = listenTimes.get(track.id) || [];
          const anchor = times.length && rand() < .72 ? choose(times) : cutoff - randomInt(20, 1800) * day;
          const earliest = Math.max(minDate, track.releasedAt);
          const timestamp = Math.min(cutoff - 1, Math.max(earliest, anchor - randomInt(1, 20) * day));
          recommend(friend, track, timestamp);
        }
      }
      messages.sort((a, b) => a.ts.localeCompare(b.ts));
      for (const message of messages) {
        const plays = listenTimes.get(message.trackId) || [];
        const sent = Date.parse(message.ts);
        const prior = plays.filter(time => time < sent);
        const after = plays.filter(time => time >= sent);
        message.playsBefore = prior.length;
        message.playsAfter = after.length;
        message.playsIn30Days = after.filter(time => time <= sent + 30 * day).length;
        message.playsIn90Days = after.filter(time => time <= sent + 90 * day).length;
        message.firstPlayedAfter = after.length ? new Date(after[0]).toISOString() : null;
        message.daysToFirstPlay = after.length ? Math.max(0, Math.ceil((after[0] - sent) / day)) : null;
        if (!message.playsIn90Days) message.outcome = 'not-followed-up';
        else if (!prior.length) message.outcome = message.playsIn90Days >= 6 ? 'new-favourite' : 'new-discovery';
        else if (sent - prior.at(-1) >= 180 * day) message.outcome = 'rediscovered';
        else message.outcome = prior.length >= 5 ? 'already-loved' : 'followed-up';
      }
      timeStage(trace, 'Generate social activity', socialAt);
      phase = 'Aggregate listening data';
      updateLoading('Finishing your demo…', 'Building your listening statistics.');
      const aggregationAt = performance.now();
      const builder = makeBuilder();
      await ingest(builder, rows);
      builder.sourceFiles = 2;
      timeStage(trace, 'Aggregate events', aggregationAt);
      const report = finishBuilder(builder, 'Randomised demo · not your data', 'Demo data', true);
      report.playlists = curatedPlaylists.map(list => ({ id: list.id, slug: list.slug, name: list.name,
        source: 'curated', tracks: list.tracks.map(track => ({ id: track.id, name: track.title, title: track.title,
          artist: track.artist, album: track.album, released: track.released, seconds: Math.round(track.length / 1000),
          position: track.position, creditedArtists: [track.artist, ...track.credits] })) }));
      report.playlistStats = { all: {} };
      for (const row of rows) {
        if (!row.demo_playlist_id || row.ms_played < MIN_PLAY_MS) continue;
        const year = row.ts.slice(0, 4);
        for (const periodKey of ['all', year]) {
          const grouped = report.playlistStats[periodKey] ||= {};
          const summary = grouped[row.demo_playlist_id] ||= { plays: 0, ms: 0, tracks: {} };
          summary.plays++; summary.ms += row.ms_played;
          const track = summary.tracks[row.demo_track_id] ||= { plays: 0, ms: 0 };
          track.plays++; track.ms += row.ms_played;
        }
      }
      report.demoData = {
        catalogue: catalogue.map(({ id, title, artist, album, released, length, credits }) => ({ id, title, artist, album, released, durationMs: length, creditedArtists: [artist, ...credits] })),
        events: rows,
        sessions: allSessions,
        eras: years,
        playlists, // Existing randomly generated social/friend playlists
        curatedTracks: playlistCatalogue.map(({ id, title, artist, album, released, length, credits }) =>
          ({ id, title, artist, album, released, durationMs: length, creditedArtists: [artist, ...credits] })),
        friends,
        messages,
        savedTrackIds: catalogue.filter(track => rand() < (messages.some(message =>
          message.trackId === track.id && message.outcome === 'new-favourite') ? .85 : .48)).map(track => track.id),
        yearTotals: [...byYear.entries()]
      };
      report.soundcheck = await buildSoundcheck(report, builder, trace);
      await persistSoundcheck(report.soundcheck);
      activateReport(report);
    } catch (error) {
      await failedSoundcheck(trace, phase);
      console.error('Could not generate demo:', error);
      if (state.view !== 'home') openView('home');
      showError(error instanceof Error ? error.message : 'Could not generate a new demo.');
    } finally {
      state.loading = false;
      $('randomise-demo').disabled = false;
      $('demo-button').disabled = false;
      hideLoading();
    }
  }

  function setTheme(theme, persist = true, origin = null) {
    const chosen = THEMES.has(theme) ? theme : 'green';
    const root = document.documentElement;
    const apply = () => {
      root.dataset.theme = chosen;
      document.querySelectorAll('[data-theme-choice]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.themeChoice === chosen));
      });
      $('theme-toggle').title = `Accent colour: ${chosen}`;
      if (persist) {
        try { localStorage.setItem(THEME_KEY, chosen); } catch { /* optional preference */ }
      }
    };
    if (!persist || root.dataset.theme === chosen || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      apply();
      return;
    }
    const x = origin?.x ?? innerWidth / 2;
    const y = origin?.y ?? innerHeight / 2;
    root.style.setProperty('--theme-reveal-x', `${x}px`);
    root.style.setProperty('--theme-reveal-y', `${y}px`);
    root.style.setProperty('--theme-reveal-radius', `${Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)))}px`);
    if (typeof document.startViewTransition === 'function') {
      document.startViewTransition(apply);
    } else {
      clearTimeout(themeTimer);
      root.classList.remove('theme-animating');
      void root.offsetWidth;
      root.classList.add('theme-animating');
      apply();
      themeTimer = setTimeout(() => root.classList.remove('theme-animating'), 720);
    }
  }

  function closeThemeMenu() {
    $('theme-menu').classList.add('hidden');
    $('theme-toggle').setAttribute('aria-expanded', 'false');
  }

  function closeMobileActions() {
    $('mobile-actions-menu').classList.add('hidden');
    $('mobile-actions-toggle').setAttribute('aria-expanded', 'false');
  }

  function chooseTheme(event) {
    const button = event.target.closest('[data-theme-choice]');
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const fromMobile = !!button.closest('#mobile-actions-menu');
    closeThemeMenu();
    closeMobileActions();
    (fromMobile ? $('mobile-actions-toggle') : $('theme-toggle')).focus();
    setTheme(button.dataset.themeChoice, true, origin);
  }

  function initialiseTheme() {
    let saved = 'green';
    try { saved = localStorage.getItem(THEME_KEY) || 'green'; } catch { /* optional preference */ }
    setTheme(saved, false);
  }

  function attachEvents() {
    $('theme-toggle').addEventListener('click', () => {
      const menu = $('theme-menu');
      const open = menu.classList.toggle('hidden') === false;
      $('theme-toggle').setAttribute('aria-expanded', String(open));
    });
    $('theme-menu').addEventListener('click', chooseTheme);
    $('mobile-actions-menu').addEventListener('click', chooseTheme);
    $('mobile-actions-toggle').addEventListener('click', () => {
      const open = $('mobile-actions-menu').classList.toggle('hidden') === false;
      $('mobile-actions-toggle').setAttribute('aria-expanded', String(open));
      if (open) closeThemeMenu();
    });
    $('mobile-import').addEventListener('click', () => {
      closeMobileActions();
      openView('home');
      $('file-input').click();
    });
    $('mobile-randomise').addEventListener('click', () => { closeMobileActions(); makeDemo(); });
    $('nav-back').addEventListener('click', goBack);
    document.addEventListener('click', event => {
      if (!event.target.closest('#theme-picker')) closeThemeMenu();
      if (!event.target.closest('#mobile-actions')) closeMobileActions();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (!$('mobile-actions-menu').classList.contains('hidden')) {
        closeMobileActions();
        $('mobile-actions-toggle').focus();
      } else if (!$('theme-menu').classList.contains('hidden')) {
        closeThemeMenu();
        $('theme-toggle').focus();
      }
    });
    document.querySelectorAll('[data-nav]').forEach(link => link.addEventListener('click', () => openView(link.dataset.nav)));
    document.querySelectorAll('[data-go]').forEach(link => link.addEventListener('click', () => openView(link.dataset.go)));
    document.addEventListener('click', event => {
      const element = event.target.closest('[data-explore-category][data-explore-key]');
      if (!element || !state.report) return;
      const category = element.dataset.exploreCategory;
      const key = decodeURIComponent(element.dataset.exploreKey);
      const item = searchEntity(category, key);
      if (item) exploreItem(category, item);
    });
    const playlistClick = event => {
      const back = event.target.closest('[data-playlist-back]');
      if (back) { saveNavigation(); state.playlistSelection = null; renderPlaylists(); return; }
      const open = event.target.closest('[data-playlist-open]');
      if (open) {
        const list = playlistCollections().find(list => list.id === open.dataset.playlistOpen);
        if (!list) return;
        saveNavigation(); state.playlistSelection = list.id; openView('playlists', false); return;
      }
      const track = event.target.closest('[data-playlist-track]');
      if (track) {
        const item = playlistSearchEntities('tracks').find(item => keyOf(item.artist, item.name) === decodeURIComponent(track.dataset.playlistTrack));
        if (item) exploreItem('tracks', item);
      }
    };
    $('view-playlists').addEventListener('click', playlistClick);
    $('search-detail').addEventListener('click', playlistClick);
    $('unified-search').addEventListener('input', event => {
      state.search.query = event.target.value;
      state.search.selected = null;
      state.search.limit = 30;
      renderSearch();
    });
    $('view-search').addEventListener('click', event => {
      const chip = event.target.closest('[data-search-filter-chip]');
      if (!chip) return;
      state.search.filter = chip.dataset.searchFilterChip;
      $('search-filter').value = state.search.filter;
      state.search.selected = null;
      state.search.limit = 30;
      renderSearch();
    });
    $('search-filter').addEventListener('change', event => {
      state.search.filter = event.target.value;
      state.search.selected = null;
      state.search.limit = 30;
      renderSearch();
    });
    $('search-results').addEventListener('click', event => {
      const item = event.target.closest('[data-search-result]');
      if (!item) return;
      const result = state.search.matches[Number(item.dataset.searchResult)];
      if (result) {
        const key = recordKey(result.category, result.item);
        if (state.search.selected?.category !== result.category || state.search.selected.key !== key) saveNavigation();
        state.search.selected = { category: result.category, key };
        renderSearchResults(); renderSearchDetail();
      }
    });
    $('search-more').addEventListener('click', () => { state.search.limit += 30; renderSearchResults(); });
    $('search-detail').addEventListener('click', event => {
      const month = event.target.closest('[data-search-era-month]');
      if (month) {
        saveNavigation();
        state.eras.month = month.dataset.searchEraMonth;
        openView('eras', false);
      }
    });
    $('browse-button').addEventListener('click', event => { event.stopPropagation(); $('file-input').click(); });
    $('file-input').addEventListener('change', event => { if (event.target.files[0]) importHistory(event.target.files[0]); });
    $('demo-button').addEventListener('click', event => { event.stopPropagation(); makeDemo(); });
    $('randomise-demo').addEventListener('click', () => makeDemo());
    $('dropzone').addEventListener('click', event => {
      if (event.target.closest('button')) return;
      $('file-input').click();
    });
    $('dropzone').addEventListener('keydown', event => { if (event.target === $('dropzone') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); $('file-input').click(); } });
    ['dragenter', 'dragover'].forEach(name => $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach(name => $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.remove('dragging'); }));
    $('dropzone').addEventListener('drop', event => { const file = event.dataTransfer.files[0]; if (file) importHistory(file); });
    $('new-upload').addEventListener('click', () => openView('home'));
    $('year-filter').addEventListener('change', event => { if (state.year !== event.target.value) saveNavigation(); state.year = event.target.value; state.count = 25; state.search.selected = null; state.search.limit = 30; state.eras.month = null; state.eras.limits = { artists: 8, tracks: 10, albums: 8 }; renderCurrent(); });
    for (const type of ['artist', 'track', 'album']) $(type + '-search').addEventListener('input', () => { state.count = 25; renderListing({ artist: 'artists', track: 'tracks', album: 'albums' }[type]); });
    document.querySelectorAll('[data-sort-for]').forEach(group => group.addEventListener('click', event => {
      const button = event.target.closest('[data-sort]');
      if (!button) return;
      state.sorts[group.dataset.sortFor] = button.dataset.sort;
      state.count = 25;
      renderListing(group.dataset.sortFor);
    }));
    for (const type of ['artist', 'track', 'album']) $(type + '-more').addEventListener('click', () => { state.count += 25; renderListing({ artist: 'artists', track: 'tracks', album: 'albums' }[type]); });
    $('view-eras').addEventListener('click', event => {
      const monthButton = event.target.closest('[data-era-month]');
      const stepButton = event.target.closest('[data-era-step]');
      const sortButton = event.target.closest('[data-era-sort]');
      const moreButton = event.target.closest('[data-era-more]');
      if (monthButton) {
        if (state.eras.month === monthButton.dataset.eraMonth) return;
        state.eras.month = monthButton.dataset.eraMonth;
        state.eras.limits = { artists: 8, tracks: 10, albums: 8 };
        renderEras();
      } else if (stepButton) {
        const months = eligibleEraMonths();
        const index = months.findIndex(row => row.key === state.eras.month);
        const next = months[index + Number(stepButton.dataset.eraStep)];
        if (next) {
          state.eras.month = next.key;
          state.eras.limits = { artists: 8, tracks: 10, albums: 8 };
          renderEras();
        }
      } else if (sortButton) {
        state.eras.sort = sortButton.dataset.eraSort;
        renderEras();
      } else if (moreButton) {
        const category = moreButton.dataset.eraMore;
        if (['artists', 'tracks', 'albums'].includes(category)) {
          state.eras.limits[category] += 20;
          renderEras();
        }
      }
    });
    $('history-list').addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.openReport) {
        const report = await loadReport(button.dataset.openReport);
        if (report) activateReport(report); else showError('This report is no longer available.');
      }
      if (button.dataset.exportReport) {
        const report = await loadReport(button.dataset.exportReport);
        if (report) {
          const blob = new Blob([JSON.stringify({ format: 'wrapped365-report-v1', report }, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `wrapped365-summary-${report.createdAt.slice(0, 10)}.json`;
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      }
      if (button.dataset.deleteReport) {
        if (!confirm('Delete this saved report from this browser? Your original ZIP will not be affected.')) return;
        await removeReport(button.dataset.deleteReport);
        try { await deleteSoundchecks(button.dataset.deleteReport); } catch (error) { console.warn('Could not delete attached diagnostics:', error); }
        await refreshHistoryCount();
        await renderHistory();
      }
    });
    $('clear-history').addEventListener('click', async () => {
      if (!confirm('Permanently delete ALL saved Wrapped 365 reports and Soundcheck diagnostic history from this browser?')) return;
      const reports = await listReports();
      for (const report of reports) await removeReport(report.id);
      try { await deleteSoundchecks(); } catch (error) { console.warn('Could not delete Soundcheck history:', error); }
      state.soundcheckSelected = null;
      await refreshHistoryCount();
      await renderHistory();
    });
    $('about-method').addEventListener('click', () => $('method-dialog').showModal());
    $('close-dialog').addEventListener('click', () => $('method-dialog').close());
    $('method-ok').addEventListener('click', () => $('method-dialog').close());
    $('method-dialog').addEventListener('click', event => { if (event.target === $('method-dialog')) $('method-dialog').close(); });
  }

  const soundcheckMetric = (label, value, detail = '') => `<article class="sc-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</article>`;
  const soundcheckRow = (label, value, note = '') => `<div class="sc-row"><span>${escapeHtml(label)}${note ? `<small>${escapeHtml(note)}</small>` : ''}</span><strong>${escapeHtml(value)}</strong></div>`;
  function soundcheckBar(label, value, maximum, suffix = '') {
    const width = maximum > 0 ? Math.max(1, Math.min(100, value / maximum * 100)) : 0;
    return `<div class="sc-bar-row"><div><span>${escapeHtml(label)}</span><strong>${escapeHtml(number(value))}${suffix}</strong></div><div class="sc-bar-track"><div style="width:${width.toFixed(2)}%"></div></div></div>`;
  }
  function soundcheckDiversityTrend(selected, history) {
    const runs = history.filter(item => item.source === 'demo' && item.status === 'completed' &&
      typeof item.demo?.diversity?.distinctPrimaryArtists === 'number').slice(0, 8);
    if (selected?.demo?.diversity && !runs.some(item => item.id === selected.id)) {
      if (runs.length === 8) runs.pop();
      runs.push(selected);
    }
    runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!runs.length) return '';
    return `<article class="panel sc-diversity-trend"><div class="kicker">ACROSS REGENERATIONS</div><h2>All time top 20 artist diversity</h2>
      <p class="search-muted">Distinct primary artists across the latest ${runs.length} demo ${runs.length === 1 ? 'generation' : 'generations'} with these diagnostics. Older runs without this measurement are excluded.</p>
      <div class="sc-trend-bars" role="img" aria-label="Distinct artists in the all time top 20 by regeneration: ${runs.map(item => item.demo.diversity.distinctPrimaryArtists).join(', ')}">
        ${runs.map((item, index) => `<div class="sc-trend-column ${item.id === selected.id ? 'selected' : ''}" title="Run ${index + 1}: ${item.demo.diversity.distinctPrimaryArtists} artists · ${dateLabel(item.createdAt)}">
          <span>${number(item.demo.diversity.distinctPrimaryArtists)}</span><div class="sc-trend-rail"><i style="height:${Math.min(100, 100 * item.demo.diversity.distinctPrimaryArtists / 20)}%"></i></div><small>${index + 1}</small>
        </div>`).join('')}
      </div><p class="sc-footnote">Oldest to newest · bar scale: 0–20 artists · highlighted bar: selected report</p></article>`;
  }

  function soundcheckImportTrends(selected, history) {
    if (selected.source !== 'import') return '';
    const isListeningImport = item => item.source === 'import' && item.status === 'completed' &&
      Number.isFinite(item.events?.scanned) && item.events.scanned > 0;
    const runs = history.filter(isListeningImport).slice(0, 8);
    const selectedIsOlder = isListeningImport(selected) && !runs.some(item => item.id === selected.id);
    if (selectedIsOlder) {
      if (runs.length === 8) runs.pop();
      runs.push(selected);
    }
    runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!runs.length) return '';

    const metrics = [
      { title: 'Distinct tracks', detail: 'Songs in your grouped listening library',
        value: item => item.grouping?.groupedTracks, unit: 'tracks', decimals: 0 },
      { title: 'Active days', detail: 'UTC calendar days with qualifying playback',
        value: item => item.listening?.activeDays, unit: 'days', decimals: 0 },
      { title: 'Listening hours', detail: 'Total listening duration of qualifying plays',
        value: item => item.listening?.hours, unit: 'hours', decimals: 1 },
      { title: 'Aggregate events', detail: 'Time spent aggregating listening records',
        value: item => item.performance?.stages?.['Aggregate events'], unit: 'ms', decimals: 1 }
    ];
    const formatValue = (value, decimals) => value.toLocaleString('en-GB', {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    const chart = metric => {
      const available = runs.map(item => ({ item, value: metric.value(item) }))
        .filter(row => Number.isFinite(row.value) && row.value >= 0);
      if (!available.length) return '';
      const max = Math.max(1, ...available.map(row => row.value));
      const labels = available.map(row => formatValue(row.value, metric.decimals));
      return `<article class="panel sc-diversity-trend sc-import-trend">
        <div class="kicker">${escapeHtml(metric.unit.toUpperCase())} · IMPORT HISTORY</div>
        <h3>${escapeHtml(metric.title)}</h3><p class="search-muted">${escapeHtml(metric.detail)}</p>
        <div class="sc-trend-bars" role="img" aria-label="${escapeHtml(metric.title)} across imports, oldest to newest: ${escapeHtml(labels.join(', '))} ${escapeHtml(metric.unit)}">
          ${available.map(({ item, value }, index) => `<div class="sc-trend-column ${item.id === selected.id ? 'selected' : ''}" title="Import ${index + 1}: ${escapeHtml(formatValue(value, metric.decimals))} ${escapeHtml(metric.unit)} · ${escapeHtml(dateLabel(item.createdAt))}">
            <span>${escapeHtml(formatValue(value, metric.decimals))}</span><div class="sc-trend-rail"><i style="height:${(100 * value / max).toFixed(2)}%"></i></div><small>${index + 1}</small>
          </div>`).join('')}
        </div><p class="sc-footnote">Oldest → newest · scale: 0–${escapeHtml(formatValue(max, metric.decimals))} ${escapeHtml(metric.unit)}</p>
      </article>`;
    };
    return `<section class="sc-import-trends" aria-label="Compare Spotify imports">
      <div class="sc-panel-head"><div><div class="kicker">YOUR LISTENING HISTORY OVER TIME</div><h2>Across your uploads</h2></div></div>
      <p class="search-muted">Compare the latest ${runs.length} successful listening history ${runs.length === 1 ? 'import' : 'imports'}. Each bar represents a complete imported history, not just the activity since the previous upload. The highlighted bar is the selected report.</p>
      <div class="sc-import-trend-grid">${metrics.map(chart).join('')}</div>
      <p class="sc-footnote">${selectedIsOlder ? 'The selected older import replaces the oldest recent import in this comparison. ' : ''}Playlist only uploads and failed imports are excluded. Processing times can also vary with device load and browser performance.</p>
    </section>`;
  }

  function soundcheckView(data, history = []) {
    if (!data) return '<div class="panel sc-empty">No diagnostic reports yet. Import Spotify history or generate demo data to start collecting measurements.</div>';
    if (data.status === 'failed') return `<div class="panel sc-empty"><h2>Processing did not complete</h2><p>The ${escapeHtml(data.sourceType)} operation stopped during <strong>${escapeHtml(data.failureStage || 'processing')}</strong>. The diagnostic only records the phase and timing, not filenames or source data.</p><p>Total time: ${number(data.performance?.totalMs)} ms</p></div>${soundcheckPerformance(data)}`;
    const p = data.performance;
    const ev = data.events;
    const grouping = data.grouping;
    const listen = data.listening;
    const isDemo = data.source === 'demo';
    const demo = data.demo;
    const countValue = value => typeof value === 'number' ? number(value) : '—';
    const coverage = isDemo && demo?.distinctCatalogueTracks ? (100 * demo.playedTracks / demo.distinctCatalogueTracks).toFixed(1) + '%' : '—';
    const cards = isDemo ? [
      ['Catalogue coverage', coverage, `${countValue(demo.playedTracks)} distinct songs heard`],
      ['Qualified plays', countValue(ev.qualifying), '30 seconds or longer'],
      ['Artists heard', countValue(grouping.uniqueArtists), `of ${countValue(demo.catalogueArtists)} catalogue artists`],
      ['Recommendations', countValue(demo.recommendations), 'Friend activity']
    ] : [
      ['Source events', countValue(ev.scanned), 'Playback rows inspected'],
      ['Qualified plays', countValue(ev.qualifying), '30 seconds or longer'],
      ['Distinct tracks', countValue(grouping.groupedTracks), 'After grouping by song identity'],
      ['Artists inferred', countValue(data.enrichment.distinctInferredArtists), 'Distinct artists from title credits']
    ];
    const years = listen.annual || [];
    const maxYear = Math.max(1, ...years.map(row => row.plays));
    const quality = [
      soundcheckRow('Events accepted', countValue(ev.accepted)),
      soundcheckRow('Streams under 30 seconds', countValue(ev.under30s), 'Kept for behavioural metrics, excluded from play rankings to match Spotify'),
      soundcheckRow('Exact duplicate events removed', countValue(ev.duplicatesRemoved), 'Identical playback signatures, not repeat listening'),
      soundcheckRow('Excluded records', countValue(ev.excluded)),
      ...Object.entries({ 'Podcast / episode records': ev.exclusions.episodes, 'Missing music metadata': ev.exclusions.missingMetadata,
        'Invalid timestamps': ev.exclusions.invalidTimestamp, 'Invalid durations': ev.exclusions.invalidDuration,
        'Malformed rows': ev.exclusions.malformedRow }).map(([label, value]) => soundcheckRow(label, countValue(value)))
    ];
    const groupingRows = [
      soundcheckRow('Distinct source track variants', countValue(grouping.sourceTrackVariants), 'Artist + track + album combinations'),
      soundcheckRow('Final grouped tracks', countValue(grouping.groupedTracks), 'Grouped by primary artist + track title'),
      soundcheckRow('Variants consolidated', countValue(grouping.consolidatedVariants), 'Release variants combined, not playback events removed'),
      soundcheckRow('Distinct credited artists', countValue(grouping.uniqueArtists)),
      soundcheckRow('Distinct albums', countValue(grouping.uniqueAlbums)),
      soundcheckRow('Tracks with new title inferred credits', countValue(data.enrichment.tracksWithInferredFeatures)),
      soundcheckRow('Distinct inferred artist names', countValue(data.enrichment.distinctInferredArtists), 'Found from feat./featuring text not already explicitly credited')
    ];
    const diversity = demo?.diversity;
    const diversitySection = !isDemo ? '' : !diversity
      ? '<article class="panel sc-diversity-panel"><div class="kicker">DEMO ANALYTICS</div><h2>Listening diversity &amp; temporal focus</h2><p class="search-muted">These measurements were added after this report was generated. Randomise the demo to collect them.</p></article>'
      : `<section class="sc-diversity-section" aria-label="Demo listening diversity diagnostics">
        <div class="sc-panel-head"><div><div class="kicker">DEMO ANALYTICS</div><h2>Listening diversity &amp; temporal focus</h2></div></div>
        <div class="sc-cards">
          ${soundcheckMetric('Top 20 primary artists', countValue(diversity.distinctPrimaryArtists), `Distinct artists among ${countValue(diversity.topTracksCount)} leading tracks`)}
          ${soundcheckMetric('Top 20 album titles', countValue(diversity.distinctAlbumTitles), `Across ${countValue(diversity.albumTaggedTopTracks)} album-tagged tracks · includes soundtracks`)}
          ${soundcheckMetric('Largest album cluster', `${countValue(diversity.largestAlbumCluster)}/${countValue(diversity.topTracksCount)}`, 'Most tracks sharing one album title')}
          ${soundcheckMetric('Peak three month share', diversity.medianPeakThreeMonthPlayShare == null ? '—' : `${diversity.medianPeakThreeMonthPlayShare}%`, 'Median share of lifetime plays within each top track’s busiest three consecutive months')}
        </div>
        <div class="sc-panels"><article class="panel"><div class="kicker">TEMPORAL FOCUS</div><h2>How tastes change</h2>
          ${soundcheckRow('Longest top five artist streak', `${countValue(diversity.longestTopFiveArtistStreak)} months`, 'Consecutive calendar months in any month’s five leading credited artists')}
          ${soundcheckRow('Year-to-year artist overlap', diversity.annualTopTenArtistOverlap == null ? '—' : `${diversity.annualTopTenArtistOverlap}%`, 'Average share of the prior year’s top ten credited artists returning the next year')}
          ${soundcheckRow('Consecutive year comparisons', countValue(diversity.consecutiveYearPairs))}
        </article><article class="panel"><div class="kicker">INTERPRETING THE NUMBERS</div><h2>Long term vs short term</h2>
          <p class="search-muted">Low artist and album diversity suggests concentrated all time rankings. High peak three month share suggests bursts of listening rather than persistent popularity.</p>
          <p class="search-muted">Album titles are grouped across primary artists to reveal soundtrack clusters. These metrics describe the generated history; they do not change any play counts.</p>
        </article></div>${soundcheckDiversityTrend(data, history)}</section>`;
    const demoSection = !isDemo ? '' : `<div class="sc-panels">
      <article class="panel"><div class="kicker">CATALOGUE</div><h2>Simulation coverage</h2>
        ${soundcheckRow('Library catalogue entries', countValue(demo.catalogueTracks))}
        ${soundcheckRow('Additional playlist only tracks', countValue(demo.curatedPlaylistTracks))}
        ${soundcheckRow('Distinct songs', countValue(demo.distinctCatalogueTracks))}
        ${soundcheckRow('Eligible releases', countValue(demo.eligibleTracks))}
        ${soundcheckRow('Albums / releases', countValue(demo.catalogueAlbums))}
        ${soundcheckRow('Multi track sessions', countValue(demo.multiTrackSessions))}
        ${soundcheckRow('Total sessions', countValue(demo.sessions))}
        ${soundcheckRow('Curated playlists', countValue(demo.curatedPlaylists))}
        ${soundcheckRow('Playlist sessions', countValue(demo.playlistSessions))}
        ${soundcheckRow('Attributed playlist plays', countValue(demo.playlistPlays))}
        ${soundcheckRow('Months represented', countValue(demo.chapters))}
      </article>
      <article class="panel"><div class="kicker">SOCIAL SIMULATION</div><h2>Recommendation outcomes</h2>
        ${soundcheckRow('Friends', countValue(demo.friends))}
        ${soundcheckRow('Random friend playlists', countValue(demo.playlists))}
        ${Object.entries(demo.recommendationOutcomes).sort((a,b)=>b[1]-a[1]).map(([name,value])=>soundcheckRow(name.replace(/-/g,' '), countValue(value))).join('')}
      </article></div>`;
    const coveragePanel = `<article class="panel sc-coverage"><div class="kicker">LISTENING PROFILE</div><h2>Coverage and popularity</h2>
      <div class="sc-coverage-rows">
        ${soundcheckRow('First qualifying play', listen.firstTs ? dateLabel(listen.firstTs) : '—')}
        ${soundcheckRow('Latest qualifying play', listen.lastTs ? dateLabel(listen.lastTs) : '—')}
        ${soundcheckRow('Years with activity', countValue(listen.years))}
        ${soundcheckRow('Active days', countValue(listen.activeDays))}
        ${soundcheckRow('Listening hours', countValue(listen.hours))}
        ${soundcheckRow('Top 10% song play share', listen.topTenPercentPlayShare + '%', 'Concentration of qualified plays among the most played songs')}
      </div></article>`;
    return `<div class="sc-cards">${cards.map(args => soundcheckMetric(...args)).join('')}</div>
      ${coveragePanel}
      ${soundcheckPerformance(data)}
      ${!isDemo ? soundcheckImportTrends(data, history) : ''}
      <div class="sc-panels">
        <article class="panel"><div class="kicker">PROCESSING QUALITY</div><h2>Playback records</h2>${quality.join('')}</article>
        <article class="panel"><div class="kicker">IDENTITIES & ENRICHMENT</div><h2>Music catalogue</h2>${groupingRows.join('')}</article>
      </div>${demoSection}${diversitySection}
      <article class="panel sc-yearly"><div class="kicker">LISTENING DISTRIBUTION</div><h2>Year by year</h2>
        <div class="sc-bars">${years.map(row => soundcheckBar(row.year, row.plays, maxYear)).join('')}</div>
      </article>`;
  }
  function soundcheckPerformance(data) {
    const p = data.performance || { stages: {} };
    const stages = Object.entries(p.stages || {}).sort((a,b)=>b[1]-a[1]);
    const max = Math.max(1, ...stages.map(([,ms])=>ms));
    return `<div class="panel sc-performance"><div class="sc-panel-head"><div><div class="kicker">PROCESSING PERFORMANCE</div><h2>What took the time?</h2></div><div class="sc-total">${number(p.totalMs)}<small>ms total</small></div></div>
       <div class="sc-bars">${stages.length ? stages.map(([label,ms])=>soundcheckBar(label,ms,max,' ms')).join('') : '<p class="search-muted">No completed processing stages were recorded.</p>'}</div>
       <div class="sc-footnote">The total includes pauses for UI rendering and browser storage, so individual stages may not add up to the complete time.</div>
       <div class="sc-details">${soundcheckRow('Input size', p.inputBytes != null ? (p.inputBytes / 1048576).toFixed(2) + ' MiB' : 'Not applicable')}
       ${soundcheckRow('Uncompressed / parsed JSON', p.parsedJsonBytes ? (p.parsedJsonBytes / 1048576).toFixed(2) + ' MiB' : 'Not measured')}
       ${soundcheckRow('Files processed', p.sourceFiles != null ? number(p.sourceFiles) : '—')}
       ${soundcheckRow('Wrapped 365 version', data.environment?.version || 'Unknown')}
       ${soundcheckRow('Browser', `${data.environment?.browser || 'Unknown'}${data.environment?.browserVersion ? ' ' + data.environment.browserVersion : ''}`)}
       ${soundcheckRow('Browser engine', data.environment?.engine || 'Not reported')}
       ${soundcheckRow('Operating system', `${data.environment?.os || 'Unknown'}${data.environment?.osVersion ? ' ' + data.environment.osVersion : ''}${data.environment?.osVersionSource === 'inferredFromSafari' ? ' (inferred from Safari)' : ''}`)}
       ${data.environment?.os === 'Linux' ? soundcheckRow('Linux distribution', data.environment?.linuxDistribution ?
         `${data.environment.linuxDistribution}${data.environment.linuxDistributionVersion ? ' ' + data.environment.linuxDistributionVersion : ''} (reported)` : 'Not reported') : ''}
       ${data.environment?.os === 'Linux' ? soundcheckRow('Linux kernel', data.environment?.linuxKernelVersion || 'Not reported') : ''}
       ${soundcheckRow('Reported architecture', data.environment?.architecture || 'Not reported')}
       ${soundcheckRow('Device class', data.environment?.deviceClass || 'Unknown')}
       ${data.environment?.deviceClass === 'Mobile' || data.environment?.deviceClass === 'Tablet' ?
         soundcheckRow('Device model', data.environment?.deviceModel || 'Not reported') : ''}
       ${soundcheckRow('Recorded', dateLabel(data.createdAt))}</div></div>`;
  }
  function soundcheckDebugExport(diagnostic) {
    const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const pickNumbers = (source, keys) => Object.fromEntries(keys.map(key => [key, numeric(source?.[key])]));
    const isoTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    const recognised = (value, choices) => choices.includes(value) ? value : 'Unknown';
    const environment = diagnostic.environment || {};
    const exportVersion = value => cleanVersion(value) || 'Unknown';
    const stages = ['Open ZIP', 'Read JSON', 'Parse JSON', 'Parse playlists', 'Aggregate events', 'Build report', 'Save report', 'Load catalogue', 'Generate listening history', 'Generate social activity'];
    const performanceData = diagnostic.performance || {};
    const payload = {
      schema: 1,
      status: recognised(diagnostic.status, ['completed', 'failed']),
      source: recognised(diagnostic.source, ['demo', 'import']),
      sourceType: recognised(diagnostic.sourceType, ['Demo data', 'Spotify import', 'Extended Streaming History', 'Account streaming history', 'Spotify listening history', 'Spotify playlists', 'Extended Streaming History + Spotify playlists', 'Account streaming history + Spotify playlists', 'Spotify listening history + Spotify playlists']),
      createdAt: isoTime(diagnostic.createdAt),
      environment: {
        version: typeof environment.version === 'string' && /^[a-zA-Z0-9._+\-]{1,64}$/.test(environment.version) ? environment.version : 'Unknown',
        browser: recognised(environment.browser, [...SOUNDCHECK_BROWSER_TOKENS.map(([name]) => name), 'Other']),
        browserVersion: exportVersion(environment.browserVersion),
        engine: ['Blink', 'Gecko', 'Goanna', 'WebKit', 'Presto', 'LibWeb'].includes(environment.engine) ? environment.engine : null,
        os: recognised(environment.os, ['Android', 'iOS', 'iPadOS', 'iOS / iPadOS', 'Windows', 'macOS', 'Chrome OS', 'Linux', 'Other']),
        osVersion: environment.os === 'Android' ? cleanVersion(environment.osVersion) :
          environment.os === 'Windows' && environment.osVersion === '10 / 11' ? '10 / 11' : exportVersion(environment.osVersion),
        osVersionSource: ['userAgent', 'clientHints', 'inferredFromSafari'].includes(environment.osVersionSource) ? environment.osVersionSource : null,
        architecture: ['x86', 'x86_64', 'ARM32', 'ARM64', 'ppc64le', 'ppc64', 'riscv64', 's390x'].includes(environment.architecture) ? environment.architecture : null,
        linuxDistribution: environment.os === 'Linux' && SOUNDCHECK_LINUX_DISTROS.some(([name]) => name === environment.linuxDistribution) ? environment.linuxDistribution : null,
        linuxDistributionVersion: environment.os === 'Linux' ? cleanVersion(environment.linuxDistributionVersion) : null,
        linuxKernelVersion: environment.os === 'Linux' ? cleanVersion(environment.linuxKernelVersion) : null,
        deviceClass: recognised(environment.deviceClass, ['Mobile', 'Tablet', 'Desktop']),
        deviceModel: cleanDeviceModel(environment.deviceModel)
      },
      performance: {
        ...pickNumbers(performanceData, ['totalMs', 'inputBytes', 'parsedJsonBytes', 'sourceFiles']),
        stages: Object.fromEntries(stages.filter(key => numeric(performanceData.stages?.[key]) !== null).map(key => [key, numeric(performanceData.stages[key])]))
      }
    };
    if (payload.status === 'failed') {
      payload.failureStage = recognised(diagnostic.failureStage, ['Opening archive', 'Read and parse JSON', 'Parse JSON', 'Parse playlist metadata', 'Aggregate listening data', 'Build report', 'Save report', 'Load demo catalogue', 'Generate listening history', 'Generate social activity']);
    }
    if (diagnostic.events) {
      payload.events = {
        ...pickNumbers(diagnostic.events, ['scanned', 'accepted', 'qualifying', 'under30s', 'duplicatesRemoved', 'excluded']),
        exclusions: pickNumbers(diagnostic.events.exclusions, ['episodes', 'missingMetadata', 'invalidTimestamp', 'invalidDuration', 'malformedRow'])
      };
    }
    if (diagnostic.playlistImport) payload.playlistImport = pickNumbers(diagnostic.playlistImport, ['playlists', 'musicTracks', 'localTracks', 'skippedEpisodes', 'skippedUnknown']);
    if (diagnostic.grouping) payload.grouping = pickNumbers(diagnostic.grouping, ['sourceTrackVariants', 'groupedTracks', 'consolidatedVariants', 'uniqueArtists', 'uniqueAlbums']);
    if (diagnostic.enrichment) payload.enrichment = pickNumbers(diagnostic.enrichment, ['tracksWithInferredFeatures', 'distinctInferredArtists']);
    if (diagnostic.listening) {
      payload.listening = {
        ...pickNumbers(diagnostic.listening, ['years', 'activeDays', 'hours', 'topTenPercentPlayShare']),
        firstTs: isoTime(diagnostic.listening.firstTs),
        lastTs: isoTime(diagnostic.listening.lastTs),
        annual: Array.isArray(diagnostic.listening.annual) ? diagnostic.listening.annual.filter(row => /^\d{4}$/.test(String(row.year))).map(row => ({ year: String(row.year), ...pickNumbers(row, ['plays', 'hours']) })) : []
      };
    }
    if (diagnostic.source === 'demo' && diagnostic.demo) {
      payload.demo = {
        ...pickNumbers(diagnostic.demo, ['catalogueTracks', 'distinctCatalogueTracks', 'catalogueArtists', 'catalogueAlbums', 'eligibleTracks', 'playedTracks', 'sessions', 'multiTrackSessions', 'chapters', 'friends', 'playlists', 'curatedPlaylists', 'curatedPlaylistTracks', 'playlistSessions', 'playlistPlays', 'recommendations']),
        recommendationOutcomes: Object.fromEntries(['new-discovery', 'new-favourite', 'rediscovered', 'already-loved', 'followed-up', 'not-followed-up', 'unknown'].filter(key => numeric(diagnostic.demo.recommendationOutcomes?.[key]) !== null).map(key => [key, numeric(diagnostic.demo.recommendationOutcomes[key])]))
      };
      if (diagnostic.demo.diversity) payload.demo.diversity = pickNumbers(diagnostic.demo.diversity,
        ['topTracksCount', 'distinctPrimaryArtists', 'distinctAlbumTitles', 'albumTaggedTopTracks',
          'largestAlbumCluster', 'medianPeakThreeMonthPlayShare', 'longestTopFiveArtistStreak',
          'annualTopTenArtistOverlap', 'consecutiveYearPairs']);
    }
    return {
      format: 'wrapped365-soundcheck-debug',
      exportSchema: 1,
      exportedAt: new Date().toISOString(),
      privacy: {
        contains: ['Wrapped 365 version and build tag', 'Aggregated processing, listening, and demo statistics', 'Diagnostic timestamps and processing durations', 'OS, version, and kernel details (where reported)', 'Browser version and engine details (where reported)', 'CPU architecture (where reported)', 'Device type and model (where reported)'],
        excludes: ['IP addresses', 'Spotify account details, email address, phone numbers, passwords', 'Spotify subscription or billing data', 'Contents of Spotify messages', 'Source filenames', 'Track, artist, or album names', 'Raw playback records', 'Browser user agent string', 'Cookie, browser, or report identifiers']
      },
      diagnostic: payload
    };
  }
  function renderSoundcheckPrivacyChecklist(privacy) {
    for (const [key, id] of [['contains', 'soundcheck-export-includes'], ['excludes', 'soundcheck-export-excludes']]) {
      const list = $(id);
      const entries = Array.isArray(privacy?.[key]) ? privacy[key] : [];
      list.replaceChildren(...entries.map(label => {
        const item = document.createElement('li');
        item.className = `sc-export-item ${key === 'contains' ? 'sc-export-included' : 'sc-export-excluded'}`;
        const indicator = document.createElement('span');
        indicator.className = 'sc-export-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        indicator.textContent = key === 'contains' ? '✓' : '×';
        const content = document.createElement('span');
        content.textContent = label;
        item.append(indicator, content);
        return item;
      }));
    }
  }
  function downloadSoundcheckReport() {
    const diagnostic = state.soundcheckDisplayed;
    if (!diagnostic || !state.soundcheckUnlocked) return;
    const report = soundcheckDebugExport(diagnostic);
    const blob = new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `wrapped365-soundcheck-${report.diagnostic.source}-${(report.diagnostic.createdAt || report.exportedAt).replace(/[:.]/g, '-')}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function renderSoundcheck() {
    if (state.view !== 'soundcheck' || !state.soundcheckUnlocked) return;
    let history = [];
    try { history = await listSoundchecks(); } catch (error) { console.warn('Could not read Soundcheck history:', error); }
    if (state.view !== 'soundcheck') return;
    const selected = state.soundcheckSelected || state.report?.soundcheck || (!state.report ? history[0] : null) || null;
    state.soundcheckDisplayed = selected;
    $('soundcheck-download').disabled = !selected;
    $('soundcheck-type').textContent = selected ? `${selected.source === 'demo' ? 'DEMO SIMULATION' : 'SPOTIFY IMPORT'} · ${selected.status.toUpperCase()}` : 'NO DIAGNOSTICS YET';
    $('soundcheck-dashboard').innerHTML = !selected && state.report && !state.report.soundcheck ? '<div class="panel sc-empty"><h2>No diagnostics for this report</h2><p>This report either predates Soundcheck or its diagnostic data was deleted. You can inspect other runs below or reimport the original archive to generate fresh diagnostics.</p></div>' : soundcheckView(selected, history);
    $('soundcheck-recent').innerHTML = history.length ? history.slice(0, 30).map(item => `<button type="button" class="sc-history-item ${selected?.id === item.id ? 'selected' : ''}" data-soundcheck-id="${escapeHtml(item.id)}"><span><strong>${item.source === 'demo' ? 'Demo simulation' : 'Spotify import'}</strong><small>${dateLabel(item.createdAt)} · ${item.status === 'failed' ? `Stopped: ${escapeHtml(item.failureStage || 'processing')}` : `${number(item.events?.qualifying)} qualifying plays`}</small></span><span>${item.status === 'failed' ? '!' : '↗'}</span></button>`).join('') : '<p class="search-muted">No locally saved diagnostic runs yet. Diagnostics are only ever collected, processed, and stored locally.</p>';
  }
  function setSoundcheckUnlocked(unlocked) {
    state.soundcheckUnlocked = unlocked;
    try { if (unlocked) localStorage.setItem(SOUNDCHECK_KEY, 'true'); else localStorage.removeItem(SOUNDCHECK_KEY); } catch { /* optional preference */ }
    $('soundcheck-nav').classList.toggle('hidden', !unlocked);
    $('soundcheck-nav').classList.toggle('ready', unlocked);
    if (unlocked) {
      $('soundcheck-toast').classList.remove('hidden');
      clearTimeout(setSoundcheckUnlocked.toastTimer);
      setSoundcheckUnlocked.toastTimer = setTimeout(() => $('soundcheck-toast').classList.add('hidden'), 3100);
      state.soundcheckSelected = null;
      openView('soundcheck');
    } else {
      state.soundcheckSelected = null;
      state.soundcheckDisplayed = null;
      navigationStack.length = 0;
      if (state.view === 'soundcheck') openView(state.report ? 'overview' : 'home', false);
      updateBackButton();
    }
  }
  function attachSoundcheckUnlock() {
    // Enable Soundcheck with the Konami code!
    const code = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
    let position = 0;
    document.addEventListener('keydown', event => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === code[position]) { position++; if (key.startsWith('Arrow')) event.preventDefault(); }
      else position = key === code[0] ? 1 : 0;
      if (position === code.length) { position = 0; if (!state.soundcheckUnlocked) setSoundcheckUnlocked(true); else openView('soundcheck'); }
    });
    let taps = 0, lastTap = 0, homeTapTimer;
    document.querySelector('.brand-mark').addEventListener('click', event => {
      if (!matchMedia('(max-width: 900px)').matches) return;
      event.preventDefault();
      clearTimeout(homeTapTimer);
      const now = Date.now();
      taps = now - lastTap > 2200 ? 1 : taps + 1;
      lastTap = now;
      if (taps >= 7) {
        taps = 0;
        if (!state.soundcheckUnlocked) setSoundcheckUnlocked(true);
        else openView('soundcheck');
      } else if (taps === 1) {
        homeTapTimer = setTimeout(() => {
          if (taps === 1) openView('home');
        }, 550);
      }
    });
    $('soundcheck-disable').addEventListener('click', () => setSoundcheckUnlocked(false));
    $('soundcheck-download').addEventListener('click', () => {
      if (!state.soundcheckDisplayed) return;
      renderSoundcheckPrivacyChecklist(soundcheckDebugExport(state.soundcheckDisplayed).privacy);
      $('soundcheck-export-dialog').showModal();
    });
    $('soundcheck-export-cancel').addEventListener('click', () => $('soundcheck-export-dialog').close());
    $('soundcheck-export-back').addEventListener('click', () => $('soundcheck-export-dialog').close());
    $('soundcheck-export-confirm').addEventListener('click', () => {
      $('soundcheck-export-dialog').close();
      downloadSoundcheckReport();
    });
    $('soundcheck-export-dialog').addEventListener('click', event => {
      if (event.target === $('soundcheck-export-dialog')) $('soundcheck-export-dialog').close();
    });
    $('soundcheck-clear').addEventListener('click', async () => {
      if (!confirm('Permanently delete ALL Soundcheck diagnostics from this browser, including copies attached to saved reports? Your listening reports and Soundcheck unlock setting will be preserved. This cannot be undone.')) return;
      const button = $('soundcheck-clear');
      button.disabled = true;
      try {
        await clearAllSoundcheckData();
        if (state.report) delete state.report.soundcheck;
        state.soundcheckSelected = null;
        state.soundcheckDisplayed = null;
        await renderSoundcheck();
      } catch (error) {
        console.error('Could not delete Soundcheck diagnostics:', error);
        alert('Soundcheck diagnostics could not be cleared. Please try again.');
      } finally { button.disabled = false; }
    });
    $('soundcheck-recent').addEventListener('click', async event => {
      const row = event.target.closest('[data-soundcheck-id]');
      if (!row) return;
      const history = await listSoundchecks();
      state.soundcheckSelected = history.find(item => item.id === row.dataset.soundcheckId) || null;
      void renderSoundcheck();
    });
    try { state.soundcheckUnlocked = localStorage.getItem(SOUNDCHECK_KEY) === 'true'; } catch { /* optional preference */ }
    $('soundcheck-nav').classList.toggle('hidden', !state.soundcheckUnlocked);
    $('soundcheck-nav').classList.toggle('ready', state.soundcheckUnlocked);
  }

  async function loadAppVersion() {
    const target = $('app-version');
    if (!target) return;

    try {
      const response = await fetch('./VERSION', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const version = (await response.text()).trim();
      if (!version) throw new Error('Empty VERSION file');

      appVersion = version;
      target.textContent = ` · v${version}`;
    } catch (error) {
      console.warn('Unable to load Wrapped 365 version:', error);
    }
  }

  async function initialise() {
    initialiseTheme();
    attachEvents();
    attachSoundcheckUnlock();
    void loadAppVersion();
    try { state.owner = getOwner(); }
    catch { state.owner = 'local-session-only'; }
    try { state.db = await openDB(); }
    catch (error) { console.warn('Local report storage could not be opened:', error); }
    await refreshHistoryCount();
    // Report history stays accessible after reload; don't silently open a previous report.
  }
  initialise().catch(err => { console.error(err); showError('Wrapped 365 could not initialise. Try reloading the page.'); });
})();
