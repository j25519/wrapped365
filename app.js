/* Wrapped 365 — local-only Spotify listening history analytics. No HTTP requests. */
(() => {
  'use strict';

  const MIN_PLAY_MS = 30_000;
  const MAX_ENTRY_UNCOMPRESSED = 180 * 1024 * 1024;
  const MAX_TOTAL_UNCOMPRESSED = 2 * 1024 * 1024 * 1024;
  const DB_NAME = 'wrapped365-listening-reports';
  const DB_VERSION = 1;
  const COOKIE_NAME = 'wrapped365_browser_id';
  const formatter = new Intl.NumberFormat('en-GB');
  const dateFormatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const views = ['home', 'overview', 'artists', 'tracks', 'albums', 'patterns', 'history'];
  const $ = id => document.getElementById(id);
  const state = { owner: null, db: null, report: null, view: 'home', year: 'all', count: 25, sorts: { artists: 'plays', tracks: 'plays', albums: 'plays' }, loading: false };

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
    if (/macos|os x|mac os/.test(value)) return 'macOS';
    if (/windows/.test(value)) return 'Windows';
    if (/linux/.test(value)) return 'Linux';
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
    return { periods: new Map([['all', emptyPeriod()]]), seen: new Set(), imported: 0, duplicates: 0, ignored: 0, short: 0, sourceFiles: 0 };
  }
  function rankUpdate(map, key, item, ms) {
    let previous = map.get(key);
    if (!previous) { previous = { ...item, plays: 0, ms: 0 }; map.set(key, previous); }
    previous.plays++;
    previous.ms += ms;
    // Keep a valid Spotify link if an earlier row for this song lacked a URI.
    if (item.uri && !previous.uri) previous.uri = item.uri;
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
    rankUpdate(period.artists, keyOf(play.artist), { name: play.artist }, play.ms);
    rankUpdate(period.tracks, keyOf(play.artist, play.title), { name: play.title, artist: play.artist, album: play.album, uri: play.uri }, play.ms);
    if (play.album) rankUpdate(period.albums, keyOf(play.artist, play.album), { name: play.album, artist: play.artist }, play.ms);
  }
  function parseSpotifyDate(input) {
    if (typeof input !== 'string') return null;
    let value = input.trim();
    // Account-data endTime can be "2024-12-10 21:31", implicitly UTC.
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
    const artist = row.master_metadata_album_artist_name ?? row.artistName;
    const title = row.master_metadata_track_name ?? row.trackName;
    const album = row.master_metadata_album_album_name ?? row.albumName ?? '';
    const ms = Number(row.ms_played ?? row.msPlayed);
    const ts = parseSpotifyDate(row.ts ?? row.endTime);
    if (!artist || !title || !ts || !Number.isFinite(ms) || ms < 0) return null;
    const uri = /^spotify:track:[A-Za-z0-9]+$/.test(row.spotify_track_uri || '') ? row.spotify_track_uri : '';
    return {
      ts, ms, artist: String(artist).trim(), title: String(title).trim(),
      album: String(album).trim(), platform: typeof row.platform === 'string' ? row.platform.trim() : '', uri,
      skipped: typeof row.skipped === 'boolean' ? row.skipped : null,
      shuffle: typeof row.shuffle === 'boolean' ? row.shuffle : null,
      offline: typeof row.offline === 'boolean' ? row.offline : null,
      reasonStart: row.reason_start || '', reasonEnd: row.reason_end || ''
    };
  }
  function ingest(builder, rows) {
    if (!Array.isArray(rows)) throw new Error('A history file does not contain a JSON array of playback events.');
    for (const row of rows) {
      const play = readPlay(row);
      if (!play) { builder.ignored++; continue; }
      const duplicateKey = [play.ts, play.ms, play.uri || keyOf(play.artist, play.title), play.platform, play.reasonStart, play.reasonEnd].join('|');
      if (builder.seen.has(duplicateKey)) { builder.duplicates++; continue; }
      builder.seen.add(duplicateKey);
      builder.imported++;
      if (play.ms < MIN_PLAY_MS) builder.short++;
      updatePeriod(builder.periods.get('all'), play);
      const year = play.ts.slice(0, 4);
      if (!builder.periods.has(year)) builder.periods.set(year, emptyPeriod());
      updatePeriod(builder.periods.get(year), play);
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
  function finishBuilder(builder, filename, type, demo = false) {
    const periods = {};
    for (const [year, period] of builder.periods) periods[year] = periodToJSON(period);
    return {
      id: uuid(), createdAt: new Date().toISOString(), filename, type, isDemo: demo,
      imported: builder.imported, ignored: builder.ignored, duplicates: builder.duplicates,
      short: builder.short, files: builder.sourceFiles,
      firstTs: periods.all.firstTs, lastTs: periods.all.lastTs,
      years: Object.keys(periods).filter(x => x !== 'all').sort((a, b) => b.localeCompare(a)), periods
    };
  }

  const baseName = name => name.split(/[\\/]/).pop() || '';
  const extendedName = name => /^(Streaming_History_Audio.*|endsong[_-].*)\.json$/i.test(baseName(name));
  const basicName = name => /^StreamingHistory(?:_music)?[_\d-]*\.json$/i.test(baseName(name));
  function setProgress(label, detail, fraction) {
    $('import-status').classList.remove('hidden');
    $('import-status-title').textContent = label;
    $('import-status-detail').textContent = detail;
    $('progress-fill').style.width = `${Math.max(2, Math.min(100, fraction * 100))}%`;
  }
  function showError(message) {
    const el = $('error-box');
    el.classList.remove('hidden');
    el.textContent = message;
  }
  async function importHistory(file) {
    if (state.loading) return;
    const isZip = /\.zip$/i.test(file.name), isJson = /\.json$/i.test(file.name);
    if (!isZip && !isJson) { showError('Choose a Spotify .zip archive or a .json history file.'); return; }
    state.loading = true;
    $('error-box').classList.add('hidden');
    $('browse-button').disabled = true;
    $('demo-button').disabled = true;
    try {
      const builder = makeBuilder();
      let type;
      if (isZip) {
        if (typeof JSZip === 'undefined') throw new Error('Local ZIP reader is unavailable. Reload the page and try again.');
        setProgress('Opening Spotify export…', 'Reading the ZIP directory locally.', .02);
        await sleep();
        const zip = await JSZip.loadAsync(file);
        const files = Object.values(zip.files).filter(entry => !entry.dir && /\.json$/i.test(entry.name) && !baseName(entry.name).startsWith('._'));
        let candidates = files.filter(x => extendedName(x.name));
        type = 'Extended Streaming History';
        if (!candidates.length) { candidates = files.filter(x => basicName(x.name)); type = 'Account streaming history'; }
        if (!candidates.length) throw new Error('No Spotify listening-history JSON files were found in this ZIP. Look for Streaming_History_Audio_*.json or endsong_*.json in your Extended Streaming History export.');
        let totalSize = 0;
        for (const entry of candidates) {
          const bytes = entry._data?.uncompressedSize || 0;
          if (bytes > MAX_ENTRY_UNCOMPRESSED) throw new Error(`The file ${baseName(entry.name)} is unusually large. Import JSON files smaller than 180 MB individually.`);
          totalSize += bytes;
        }
        if (totalSize > MAX_TOTAL_UNCOMPRESSED) throw new Error('This archive is too large to analyse safely in one browser session.');
        candidates.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
        builder.sourceFiles = candidates.length;
        for (let i = 0; i < candidates.length; i++) {
          const entry = candidates[i];
          setProgress('Analysing listening history…', `File ${i + 1} of ${candidates.length}: ${baseName(entry.name)}`, i / candidates.length);
          await sleep();
          const content = await entry.async('string', metadata => {
            $('progress-fill').style.width = `${Math.min(98, (i + metadata.percent / 100) / candidates.length * 100)}%`;
          });
          let rows;
          try { rows = JSON.parse(content.replace(/^\uFEFF/, '')); }
          catch { throw new Error(`Could not parse ${baseName(entry.name)}. Make sure this is an unmodified Spotify export.`); }
          ingest(builder, rows);
          rows = null;
        }
      } else {
        type = extendedName(file.name) ? 'Extended Streaming History' : 'Spotify listening history';
        setProgress('Reading JSON history…', file.name, .1);
        await sleep();
        const content = await file.text();
        const rows = JSON.parse(content.replace(/^\uFEFF/, ''));
        ingest(builder, rows);
        builder.sourceFiles = 1;
      }
      if (!builder.imported) throw new Error('The files contained no valid music listening events. Check you selected the audio history, rather than podcast or video files.');
      setProgress('Building your report…', `${number(builder.imported)} listening events processed.`, .97);
      await sleep();
      const report = finishBuilder(builder, file.name, type);
      state.report = report;
      state.year = 'all';
      let saved = true;
      try { await saveReport(report); }
      catch (error) { saved = false; console.warn('Local report could not be saved:', error); }
      setProgress('Your report is ready.', saved ? 'Saved in your browser. Nothing was uploaded.' : 'Opened, but browser storage is unavailable; this report will not survive a reload.', 1);
      report.unsaved = !saved;
      await refreshHistoryCount();
      activateReport(report);
    } catch (error) {
      console.error('Local import error:', error);
      showError(error instanceof Error ? error.message : 'Could not read this archive.');
    } finally {
      $('import-status').classList.add('hidden');
      $('browse-button').disabled = false;
      $('demo-button').disabled = false;
      $('file-input').value = '';
      state.loading = false;
    }
  }

  function openView(view) {
    if (!views.includes(view)) return;
    if (!state.report && ['overview', 'artists', 'tracks', 'albums', 'patterns'].includes(view)) view = 'home';
    state.view = view;
    for (const section of document.querySelectorAll('.view')) section.classList.toggle('active', section.id === `view-${view}`);
    for (const nav of document.querySelectorAll('[data-nav]')) nav.classList.toggle('active', nav.dataset.nav === view);
    $('page-name').textContent = { home: 'Home', overview: 'Overview', artists: 'Artists', tracks: 'Tracks', albums: 'Albums', patterns: 'Listening patterns', history: 'Saved reports' }[view];
    $('report-controls').classList.toggle('hidden', !state.report || view === 'history');
    $('randomise-demo').classList.toggle('hidden', !state.report?.isDemo || view === 'home' || view === 'history');
    if (view === 'history') renderHistory();
    else if (view !== 'home') renderCurrent();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function activateReport(report) {
    state.report = report;
    state.year = 'all';
    $('year-filter').innerHTML = '<option value="all">All time</option>' + report.years.map(y => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join('');
    $('year-filter').value = 'all';
    $('storage-warning').classList.toggle('hidden', !report.unsaved);
    document.querySelectorAll('.nav-link.report-only').forEach(nav => nav.classList.add('ready'));
    openView('overview');
  }
  function period() { return state.report?.periods?.[state.year] || state.report?.periods?.all; }
  function sortedRecords(category) {
    const list = period()?.[category] || [];
    if (state.sorts[category] === 'plays') return list;
    return [...list].sort((a, b) => b.ms - a.ms || b.plays - a.plays);
  }
  function renderCurrent() {
    if (!state.report) return;
    if (state.view === 'overview') renderOverview();
    if (['artists', 'tracks', 'albums'].includes(state.view)) renderListing(state.view);
    if (state.view === 'patterns') renderPatterns();
  }
  const insightCard = (label, value, description) => `<div class="insight-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p>${escapeHtml(description)}</p></div>`;
  function statCard(label, value, subtitle, icon) {
    return `<article class="stat-card"><div class="stat-icon">${icon}</div><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div><div class="stat-subtitle">${escapeHtml(subtitle)}</div></article>`;
  }
  function rankRow(item, index, category, sorting) {
    const isArtist = category === 'artists';
    const subtitle = isArtist ? `${number(item.plays)} qualifying plays` : `${item.artist}${item.album && category === 'tracks' ? ' · ' + item.album : ''}`;
    const art = { artists: '◉', tracks: '♫', albums: '▤' }[category];
    const metric = sorting === 'ms' ? duration(item.ms) : number(item.plays);
    const unit = sorting === 'ms' ? 'listening time' : 'plays';
    const spotifyLink = category === 'tracks' && /^spotify:track:[A-Za-z0-9]+$/.test(item.uri || '')
      ? `<a class="rank-link" href="https://open.spotify.com/track/${encodeURIComponent(item.uri.split(':').pop())}" target="_blank" rel="noopener noreferrer" title="Open in Spotify" aria-label="Open ${escapeHtml(item.name)} in Spotify">↗</a>` : '';
    return `<div class="rank-row"><span class="rank-position">${number(index + 1).padStart(2, '0')}</span><div class="rank-art">${art}</div><div class="rank-main"><span class="rank-title" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><span class="rank-sub" title="${escapeHtml(subtitle)}">${escapeHtml(subtitle)}</span></div><div class="rank-data"><span class="rank-number">${escapeHtml(metric)}</span><span class="rank-unit">${unit}</span></div>${spotifyLink}</div>`;
  }
  function renderOverview() {
    const p = period();
    const year = state.year;
    $('overview-title').innerHTML = year === 'all' ? 'The big picture<span class="accent">.</span>' : `Your ${escapeHtml(year)}<span class="accent">.</span>`;
    $('overview-subtitle').textContent = `${dateLabel(p.firstTs)} – ${dateLabel(p.lastTs)} · ${number(p.activeDays)} active listening days`;
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
      insightCard('YOUR MOST-PLAYED ARTIST', fav, p.artists[0] ? `${number(p.artists[0].plays)} qualifying plays` : 'No artist plays'),
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
    const filtered = sortedRecords(category).filter(item => `${item.name} ${item.artist || ''} ${item.album || ''}`.toLowerCase().includes(search));
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
        heatmap += `<span class="heat-cell" style="background:${v ? `rgba(30,215,96,${opacity.toFixed(3)})` : '#17231a'}" title="${weekdayLabels[day]} ${String(h).padStart(2, '0')}:00 UTC · ${hours(v)} hours"></span>`;
      }
    }
    $('heatmap').innerHTML = heatmap + '</div>';
    const platforms = p.platforms.slice(0, 8);
    const platformTotal = p.platforms.reduce((sum, row) => sum + row[1], 0);
    $('platform-list').innerHTML = platforms.map(([name, ms], i) => `<div class="rank-row"><span class="rank-position">${i + 1}</span><div class="rank-art">▣</div><div class="rank-main"><span class="rank-title" title="${escapeHtml(name)}">${escapeHtml(name)}</span><span class="rank-sub">${percent(ms, platformTotal)} of listening time</span></div><div class="rank-data"><span class="rank-number">${hours(ms)} h</span></div></div>`).join('') || emptyMessage();
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
    root.innerHTML = reports.map(report => `<article class="history-card"><div class="history-card-head"><span class="history-icon">♫</span><span class="history-date">Saved ${dateLabel(report.createdAt)}</span></div><h3>${escapeHtml(report.filename)}</h3><p>${number(report.periods?.all?.qualified || report.imported - report.short)} streams · ${escapeHtml(report.type)}<br>${dateLabel(report.firstTs)} – ${dateLabel(report.lastTs)}</p><div class="history-actions"><button class="btn btn-primary" data-open-report="${report.id}">Open report ↗</button><button class="btn btn-outline" data-export-report="${report.id}">Export JSON ↓</button><button class="btn btn-danger" data-delete-report="${report.id}">Delete</button></div></article>`).join('');
  }

  async function makeDemo() {
    if (state.loading) return;
    state.loading = true;
    $('randomise-demo').disabled = true;
    $('demo-button').disabled = true;
    try {
      const tracks = [
      ["Misery in Waking Hours", "$uicideboy$", "New World Depression", "2024-06-14", 219],
      ["LIKE YXU WXULD KNXW (AUTUMN TREES)", "Kordhell", "PSYCHX", "2022-10-28", 0],
      ["MORRISON", "Night Lovell", "I HOPE YOU'RE HAPPY", "2023-12-08", 0],
      ["CODE MISTAKE", "CORPSE", "CODE MISTAKE", "2023-06-30", 0],
      ["Leviticus", "$uicideboy$", "THY WILL BE DONE", "2025-12-25", 124],
      ["MISA MISA!", "CORPSE", "MISA MISA!", "2022-08-26", 0],
      ["Sorry 4 What? // LV BELT", "Tory Lanez", "Sorry 4 What", "2022-09-30", 0],
      ["Ran To Atlanta (feat. Future & Molly Santana)", "Drake", "ICEMAN", "2026-05-15", 0],
      ["The Light at the End of the Tunnel for $9.99 a Month", "$uicideboy$", "New World Depression", "2024-06-14", 139],
      ["Napoleon", "$uicideboy$", "THY KINGDOM COME", "2025-07-31", 156],
      ["Now and at the Hour of Our Death (feat. BONES)", "$uicideboy$", "THY KINGDOM COME", "2025-07-31", 254],
      ["Mood Swing Misery", "Pouya", "The South Got Something to Say", "2019-07-01", 0],
      ["fuK u lol", "CORPSE", "fuK u lol", "2020-07-01", 0],
      ["LIFE SUCKS SO WE FUCK (feat. ZillaKami)", "Night Lovell", "I HOPE YOU'RE HAPPY", "2023-12-08", 0],
      ["Cinderella", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["HOT DEMON B!TCHES NEAR U ! ! !", "CORPSE", "HOT DEMON B!TCHES NEAR U ! ! !", "2021-09-01", 0],
      ["Cat Girls Are Ruining My Life!", "CORPSE", "Cat Girls Are Ruining My Life!", "2020-07-01", 0],
      ["move on, be strong", "Lil Peep", "HELLBOY", "2016-09-25", 0],
      ["E-GIRLS ARE RUINING MY LIFE!", "CORPSE", "E-GIRLS ARE RUINING MY LIFE!", "2020-09-01", 0],
      ["Behold a Pale Rider", "Savage Ga$p", "American Gothic", "2025-01-01", 0],
      ["DRAINO (feat. Denzel Curry)", "City Morgue", "CITY MORGUE VOL 2: AS GOOD AS DEAD", "2019-12-13", 0],
      ["O Pana!", "$uicideboy$", "Eternal Grey", "2016-09-09", 128],
      ["Sky", "Playboi Carti", "Whole Lotta Red", "2020-12-25", 0],
      ["i like the way you kiss me", "Artemas", "dirty little secret", "2024-03-19", 0],
      ["Miss YOU!", "CORPSE", "Miss YOU!", "2020-11-01", 0],
      ["White Tee", "CORPSE", "White Tee", "2020-08-01", 0],
      ["Mask Off", "Future", "FUTURE", "2017-02-17", 0],
      ["THE SUN", "Night Lovell", "Goodnight Lovell", "2019-02-22", 0],
      ["That's It (feat. Future & Metro Boomin)", "Yung Lean", "That's It (feat. Future & Metro Boomin) [from GTAVI: The Album]", "2026-09-17", 0],
      ["MARY JANE", "Night Lovell", "Goodnight Lovell", "2019-02-22", 0],
      ["Who Needs Love", "Trippie Redd", "A Love Letter to You 4", "2019-11-22", 0],
      ["Jamie's Sin", "Night Lovell", "Jamie's Sin", "2025-01-01", 0],
      ["Type Shit", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["We Don't Trust You", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["Benz Truck (гелик)", "Lil Peep", "Come Over When You're Sober, Pt. 1", "2017-08-15", 0],
      ["HOT ONE (with TiaCorine & A$AP Ferg)", "Denzel Curry", "KING OF THE MISCHIEVOUS SOUTH", "2024-07-19", 0],
      ["do re mi", "blackbear", "digital druglord", "2017-04-21", 0],
      ["Ric Flair Drip (with Metro Boomin)", "Offset", "Without Warning", "2017-10-31", 0],
      ["goosebumps (feat. Kendrick Lamar)", "Travis Scott", "Birds in the Trap Sing McKnight", "2016-09-02", 0],
      ["Stronger", "Kanye West", "Graduation", "2007-09-11", 0],
      ["Without Me", "Eminem", "The Eminem Show", "2002-05-26", 0],
      ["HUMBLE.", "Kendrick Lamar", "DAMN.", "2017-04-14", 0],
      ["a lot (feat. J. Cole)", "21 Savage", "i am > i was", "2018-12-21", 0],
      ["Lucid Dreams", "Juice WRLD", "Goodbye & Good Riddance", "2018-05-23", 0],
      ["Jocelyn Flores", "XXXTentacion", "17", "2017-08-25", 0],
      ["Blinding Lights", "The Weeknd", "After Hours", "2020-03-20", 0],
      ["Praise The Lord (Da Shine) (feat. Skepta)", "A$AP Rocky", "TESTING", "2018-05-25", 0],
      ["A Milli", "Lil Wayne", "Tha Carter III", "2008-06-10", 0],
      ["BAND4BAND (feat. Lil Baby)", "Central Cee", "CAN'T RUSH GREATNESS", "2025-01-24", 0],
      ["Monëy so big", "Yeat", "Up 2 Më", "2021-09-10", 0],
      ["INDUSTRY BABY (feat. Jack Harlow)", "Lil Nas X", "MONTERO", "2021-09-17", 0],
      ["XO TOUR Llif3", "Lil Uzi Vert", "Luv Is Rage 2", "2017-08-25", 0],
      ["I Don't Like (feat. Lil Reese)", "Chief Keef", "Finally Rich", "2012-12-18", 0],
      ["Day 'N' Nite (nightmare)", "Kid Cudi", "Man on the Moon: The End of Day", "2009-09-15", 0],
      ["CLOUT COBAIN", "Denzel Curry", "TA13OO", "2018-07-27", 0],
      ["Thought It Was a Drought", "Future", "DS2", "2015-07-17", 0],
      ["Lone Wolf Hysteria", "$uicideboy$", "New World Depression", "2024-06-14", 107],
      ["The Thin Grey Line", "$uicideboy$", "New World Depression", "2024-06-14", 105],
      ["Thorns", "$uicideboy$", "New World Depression", "2024-06-14", 130],
      ["Burgundy", "$uicideboy$", "New World Depression", "2024-06-14", 268],
      ["Transgressions", "$uicideboy$", "New World Depression", "2024-06-14", 137],
      ["All of My Problems Always Involve Me", "$uicideboy$", "New World Depression", "2024-06-14", 121],
      ["Us Vs. Them", "$uicideboy$", "New World Depression", "2024-06-14", 184],
      ["Are You Going to See the Rose in the Vase, or the Dust on the Table", "$uicideboy$", "New World Depression", "2024-06-14", 150],
      ["WHO IS THIS WEIRDO ?", "Night Lovell", "I HOPE YOU'RE HAPPY", "2023-12-08", 0],
      ["MY DAY IS RUINED !", "Night Lovell", "I HOPE YOU'RE HAPPY", "2023-12-08", 0],
      ["GOLDEN TICKET", "Night Lovell", "I HOPE YOU'RE HAPPY", "2023-12-08", 0],
      ["SUNDAY", "Night Lovell", "I HOPE YOU'RE HAPPY", "2023-12-08", 0],
      ["PEEK-A-BOO", "Night Lovell", "I HOPE YOU'RE HAPPY", "2023-12-08", 0],
      ["SUCKS TO BE YOU :/", "Night Lovell", "I HOPE YOU'RE HAPPY", "2023-12-08", 0],
      ["FREAK (feat. Freddie Dredd)", "Night Lovell", "I HOPE YOU'RE HAPPY", "2023-12-08", 0],
      ["EYE SPY", "Night Lovell", "I HOPE YOU'RE HAPPY", "2023-12-08", 0],
      ["ALIVE EVEN WHEN I DIE", "Night Lovell", "I HOPE YOU'RE HAPPY", "2023-12-08", 0],
      ["COLD SHOULDER", "Night Lovell", "I HOPE YOU'RE HAPPY", "2023-12-08", 0],
      ["BAD KID", "Night Lovell", "Goodnight Lovell", "2019-02-22", 0],
      ["LET ME DIE", "Night Lovell", "Goodnight Lovell", "2019-02-22", 0],
      ["MENTAL SLAVERY", "Night Lovell", "Goodnight Lovell", "2019-02-22", 0],
      ["WHERE'S MY MONEY", "Night Lovell", "Goodnight Lovell", "2019-02-22", 0],
      ["PAIN", "Night Lovell", "Goodnight Lovell", "2019-02-22", 0],
      ["BUMBLE BEE", "Night Lovell", "Goodnight Lovell", "2019-02-22", 0],
      ["WATCH ME", "Night Lovell", "Goodnight Lovell", "2019-02-22", 0],
      ["JOAN OF ARC", "Night Lovell", "Goodnight Lovell", "2019-02-22", 0],
      ["Young Metro", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["Ice Attack", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["Claustrophobic", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["Like That", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["Slimed In", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["Magic Don Juan (Princess Diana)", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["Runnin Outta Time", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["Fried (She a Vibe)", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["Ain't No Love", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["Everyday Hustle", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["GTA", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["Seen it All", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["WTFYM", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["Where My Twin @", "Future", "WE DON'T TRUST YOU", "2024-03-22", 0],
      ["Rent Money", "Future", "FUTURE", "2017-02-17", 0],
      ["Good Dope", "Future", "FUTURE", "2017-02-17", 0],
      ["Zoom", "Future", "FUTURE", "2017-02-17", 0],
      ["Draco", "Future", "FUTURE", "2017-02-17", 0],
      ["Super Trapper", "Future", "FUTURE", "2017-02-17", 0],
      ["POA", "Future", "FUTURE", "2017-02-17", 0],
      ["High Demand", "Future", "FUTURE", "2017-02-17", 0],
      ["Outta Time", "Future", "FUTURE", "2017-02-17", 0],
      ["Scrape", "Future", "FUTURE", "2017-02-17", 0],
      ["hellboy", "Lil Peep", "HELLBOY", "2016-09-25", 0],
      ["drive by", "Lil Peep", "HELLBOY", "2016-09-25", 0],
      ["the song they played (when i crashed into the wall)", "Lil Peep", "HELLBOY", "2016-09-25", 0],
      ["girls", "Lil Peep", "HELLBOY", "2016-09-25", 0],
      ["OMFG", "Lil Peep", "HELLBOY", "2016-09-25", 0],
      ["cobain", "Lil Peep", "HELLBOY", "2016-09-25", 0],
      ["gucci mane", "Lil Peep", "HELLBOY", "2016-09-25", 0],
      ["worlds away", "Lil Peep", "HELLBOY", "2016-09-25", 0],
      ["we think too much", "Lil Peep", "HELLBOY", "2016-09-25", 0],
      ["interlude", "Lil Peep", "HELLBOY", "2016-09-25", 0],
      ["the ends", "Travis Scott", "Birds in the Trap Sing McKnight", "2016-09-02", 0],
      ["way back", "Travis Scott", "Birds in the Trap Sing McKnight", "2016-09-02", 0],
      ["coordinate", "Travis Scott", "Birds in the Trap Sing McKnight", "2016-09-02", 0],
      ["through the late night", "Travis Scott", "Birds in the Trap Sing McKnight", "2016-09-02", 0],
      ["beibs in the trap", "Travis Scott", "Birds in the Trap Sing McKnight", "2016-09-02", 0],
      ["pick up the phone", "Travis Scott", "Birds in the Trap Sing McKnight", "2016-09-02", 0],
      ["sweet sweet", "Travis Scott", "Birds in the Trap Sing McKnight", "2016-09-02", 0],
      ["Superhero (Heroes & Villains)", "Metro Boomin", "HEROES & VILLAINS", "2022-12-02", 0],
      ["Bandz a Make Her Dance", "Juicy J", "Stay Trippy", "2013-08-27", 0],
      ["Traction Control", "CASISDEAD", "Famous Last Words", "2023-10-27", 213],
      ["Empire State of Mind", "Jay-Z", "The Blueprint 3", "2009-09-08", 0],
      ["Tip Toe Wing in My Jawwdinz", "Riff Raff", "Neon Icon", "2014-06-24", 0],
      ["Yes Indeed", "Lil Baby", "Harder Than Ever", "2018-05-18", 0],
      ["See You Again (feat. Charlie Puth)", "Wiz Khalifa", "Furious 7 (Original Motion Picture Soundtrack)", "2015-03-17", 0],
      ["Drop It Like It's Hot", "Snoop Dogg", "R&G (Rhythm & Gangsta): The Masterpiece", "2004-11-16", 0],
      ["Collard Greens", "ScHoolboy Q", "Oxymoron", "2014-02-25", 0],
      ["Hot (feat. Gunna)", "Young Thug", "So Much Fun", "2019-08-16", 0],
      ["I'm Different", "2 Chainz", "Based on a T.R.U. Story", "2012-08-14", 0],
      ["Ain't It Funny", "Danny Brown", "Atrocity Exhibition", "2016-09-27", 0],
      ["No Idea", "Don Toliver", "Heaven or Hell", "2020-03-13", 0],
      ["Mercury: Retrograde", "Ghostemane", "HEXADA", "2017-09-05", 0],
      ["HDMI", "BONES", "Rotten", "2014-12-01", 0],
      ["The Fo Five", "Ramirez", "THE PLAYA$ MANUAL", "2020-05-08", 0],
      ["Han Solo", "Germ", "BAD SHIT", "2016-11-01", 0],
      ["Self Care", "Mac Miller", "Swimming", "2018-08-03", 0],
      ["EARFQUAKE", "Tyler, the Creator", "IGOR", "2019-05-17", 0],
      ["Agony", "Yung Lean", "Stranger", "2017-11-10", 0],
      ["Mental Clarity Is a Luxury I Can't Afford", "$uicideboy$", "New World Depression", "2024-06-14", 145],
      ["Drag 'Em to the River (Totalitarian Remix)", "$uicideboy$", "New World Depression", "2024-06-14", 227],
      ["Kill Yourself V", "$uicideboy$", "New World Depression", "2024-06-14", 116],
      ["2009 Reggie Bush", "$uicideboy$", "THY WILL BE DONE", "2025-12-25", 205],
      ["BLOODSWEAT", "$uicideboy$", "THY WILL BE DONE", "2025-12-25", 221],
      ["Angel Grove", "$uicideboy$", "THY WILL BE DONE", "2025-12-25", 154],
      ["Whatever Floats Your Boat Will Definitely Sink My Ship", "$uicideboy$", "THY WILL BE DONE", "2025-12-25", 162],
      ["MSY", "$uicideboy$", "THY WILL BE DONE", "2025-12-25", 127],
      ["Old Addicts, New Habits", "$uicideboy$", "THY WILL BE DONE", "2025-12-25", 172],
      ["Frenzy", "$uicideboy$", "THY WILL BE DONE", "2025-12-25", 190],
      ["Hypernormalisation", "$uicideboy$", "THY WILL BE DONE", "2025-12-25", 152],
      ["Fuck Ups", "$uicideboy$", "THY WILL BE DONE", "2025-12-25", 280],
      ["COUNT YOUR BLESSINGS", "$uicideboy$", "THY KINGDOM COME", "2025-07-31", 248],
      ["Oh, What a Wretched Man I Am!", "$uicideboy$", "THY KINGDOM COME", "2025-07-31", 159],
      ["Full of Grace (I Refuse to Tend My Own Grave)", "$uicideboy$", "THY KINGDOM COME", "2025-07-31", 180],
      ["Chain Breaker", "$uicideboy$", "THY KINGDOM COME", "2025-07-31", 133],
      ["Self-Inflicted", "$uicideboy$", "THY KINGDOM COME", "2025-07-31", 87],
      ["GREY+GREY+GREY", "$uicideboy$", "THY KINGDOM COME", "2025-07-31", 160],
      ["Carried Away (feat. Night Lovell)", "$uicideboy$", "THY KINGDOM COME", "2025-07-31", 223],
      ["Monochromatic", "$uicideboy$", "THY KINGDOM COME", "2025-07-31", 137],
      ["BREAKDALAW2k16 (feat. Pouya)", "$uicideboy$", "Eternal Grey", "2016-09-09", 110],
      ["Say Cheese and Die", "$uicideboy$", "Eternal Grey", "2016-09-09", 162],
      ["Eclipse", "$uicideboy$", "Eternal Grey", "2016-09-09", 128],
      ["Chariot of Fire", "$uicideboy$", "Eternal Grey", "2016-09-09", 131],
      ["I Want to Believe", "$uicideboy$", "Eternal Grey", "2016-09-09", 82],
      ["Uglier", "$uicideboy$", "Eternal Grey", "2016-09-09", 158],
      ["Water $uicide (feat. Chris Travis)", "$uicideboy$", "Eternal Grey", "2016-09-09", 154],
      ["Elysian Fields", "$uicideboy$", "Eternal Grey", "2016-09-09", 154],
      ["275 $uicide", "$uicideboy$", "Eternal Grey", "2016-09-09", 129],
      ["Lucky Me", "$uicideboy$", "Eternal Grey", "2016-09-09", 106],
      ["It's Hard to Win When You Always Lose", "$uicideboy$", "Eternal Grey", "2016-09-09", 86],
      ["Ultimate $uicide (feat. Denzel Curry)", "$uicideboy$", "Eternal Grey", "2016-09-09", 171],
      ["Leave Your Things Behind II", "$uicideboy$", "Eternal Grey", "2016-09-09", 167],
      ["Do You Trust Me?", "CASISDEAD", "Famous Last Words", "2023-10-27", 53],
      ["A Spark", "CASISDEAD", "Famous Last Words", "2023-10-27", 172],
      ["Loosin'", "CASISDEAD", "Famous Last Words", "2023-10-27", 97],
      ["Steptronic", "CASISDEAD", "Famous Last Words", "2023-10-27", 111],
      ["DEADCORP", "CASISDEAD", "Famous Last Words", "2023-10-27", 12],
      ["Pineapple Juice", "CASISDEAD", "Famous Last Words", "2023-10-27", 198],
      ["I Wanna Go Home", "CASISDEAD", "Famous Last Words", "2023-10-27", 40],
      ["Actin' Up", "CASISDEAD", "Famous Last Words", "2023-10-27", 206],
      ["Sarah Connor", "CASISDEAD", "Famous Last Words", "2023-10-27", 149],
      ["Do You Remember What It Was Like?", "CASISDEAD", "Famous Last Words", "2023-10-27", 93],
      ["Marilyn", "CASISDEAD", "Famous Last Words", "2023-10-27", 244],
      ["Aghast 6", "CASISDEAD", "Famous Last Words", "2023-10-27", 29],
      ["Boys Will Be Boys", "CASISDEAD", "Famous Last Words", "2023-10-27", 248],
      ["Venom", "CASISDEAD", "Famous Last Words", "2023-10-27", 232],
      ["The Ants", "CASISDEAD", "Famous Last Words", "2023-10-27", 56],
      ["Matte Grey Wrap", "CASISDEAD", "Famous Last Words", "2023-10-27", 228],
      ["Pat Earrings", "CASISDEAD", "Famous Last Words", "2023-10-27", 235],
      ["Before This", "CASISDEAD", "Famous Last Words", "2023-10-27", 263],
      ["Jane", "CASISDEAD", "Famous Last Words", "2023-10-27", 18],
      ["Sugar Free", "CASISDEAD", "Famous Last Words", "2023-10-27", 199],
      ["Access Denied", "CASISDEAD", "Famous Last Words", "2023-10-27", 73],
      ["Skydive", "CASISDEAD", "Famous Last Words", "2023-10-27", 268],
      ["XanaX Damage", "Future", "SAVE ME", "2019-06-07", 104],
      ["St. Lucia", "Future", "SAVE ME", "2019-06-07", 198],
      ["Please Tell Me", "Future", "SAVE ME", "2019-06-07", 204],
      ["Shotgun", "Future", "SAVE ME", "2019-06-07", 258],
      ["Government Official", "Future", "SAVE ME", "2019-06-07", 150],
      ["Extra", "Future", "SAVE ME", "2019-06-07", 173],
      ["Love Thy Enemies", "Future", "SAVE ME", "2019-06-07", 127],
      ["My Collection", "Future", "HNDRXX", "2017-02-24", 255],
      ["Comin Out Strong (feat. The Weeknd)", "Future", "HNDRXX", "2017-02-24", 254],
      ["Lookin Exotic", "Future", "HNDRXX", "2017-02-24", 227],
      ["Damage", "Future", "HNDRXX", "2017-02-24", 237],
      ["Use Me", "Future", "HNDRXX", "2017-02-24", 256],
      ["Incredible", "Future", "HNDRXX", "2017-02-24", 248],
      ["Testify", "Future", "HNDRXX", "2017-02-24", 178],
      ["Fresh Air", "Future", "HNDRXX", "2017-02-24", 270],
      ["Neva Missa Lost", "Future", "HNDRXX", "2017-02-24", 238],
      ["Keep Quiet", "Future", "HNDRXX", "2017-02-24", 202],
      ["Hallucinating", "Future", "HNDRXX", "2017-02-24", 221],
      ["I Thank U", "Future", "HNDRXX", "2017-02-24", 141],
      ["New Illuminati", "Future", "HNDRXX", "2017-02-24", 181],
      ["Turn On Me", "Future", "HNDRXX", "2017-02-24", 264],
      ["Selfish (feat. Rihanna)", "Future", "HNDRXX", "2017-02-24", 251],
      ["Solo", "Future", "HNDRXX", "2017-02-24", 265],
      ["Sorry", "Future", "HNDRXX", "2017-02-24", 451],
      ["PIE (feat. Chris Brown)", "Future", "HNDRXX", "2017-06-25", 210],
      ["You Da Baddest (feat. Nicki Minaj)", "Future", "HNDRXX", "2017-07-28", 241],
      ["So Slow", "Slevpy808", "So Slow", "2024-11-22", 147]
      ];
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
      const artists = [...new Set(tracks.map(track => track[1]))];
      const specialCredits = {
        'LIKE YXU WXULD KNXW (AUTUMN TREES)': ['Scarlxrd', 'CORPSE'],
        'CODE MISTAKE': ['Bring Me The Horizon'],
        'MISA MISA!': ['Scarlxrd', 'Kordhell'],
        'Cinderella': ['Metro Boomin', 'Travis Scott'],
        'HOT DEMON B!TCHES NEAR U ! ! !': ['Night Lovell'],
        'E-GIRLS ARE RUINING MY LIFE!': ['Savage Ga$p'],
        'Type Shit': ['Metro Boomin', 'Travis Scott', 'Playboi Carti'],
        "We Don't Trust You": ['Metro Boomin'],
        'Pineapple Juice': ['Kamio'],
        "Actin' Up": ['Desire'],
        'Marilyn': ['Connie Constance'],
        'Matte Grey Wrap': ['Desire'],
        'Before This': ['LATER'],
        'Skydive': ['Neil Tennant']
      };
      const catalogue = tracks.map(([title, artist, album, released, seconds], id) => {
        const feature = title.match(/\((?:feat\.?|with)\s+([^)]+)\)/i);
        const candidates = [...(specialCredits[title] || []), ...(feature ? feature[1].split(/\s*(?:&|,|\band\b)\s*/i) : [])];
        const credits = [...new Set(candidates.map(name => name.trim()).filter(name => name && keyOf(name) !== keyOf(artist)))];
        return {
          id, title, artist, album, released, credits, releasedAt: Date.parse(released + 'T00:00:00Z'),
          length: seconds ? seconds * 1000 : randomInt(115, 270) * 1000
        };
      });
      for (const artist of artists) artistWeights.set(artist, 0.3 + 4 * rand() ** 2);
      for (const track of catalogue) {
        const albumKey = keyOf(track.artist, track.album);
        if (!albumWeights.has(albumKey)) albumWeights.set(albumKey, 0.45 + 2 * rand());
        trackWeights.set(track.id, (0.1 + 5 * rand() ** 5) * artistWeights.get(track.artist) * albumWeights.get(albumKey));
      }
      for (let year = startYear; year <= endYear; year++) {
        const begin = Math.max(minDate, Date.UTC(year, 0, 1));
        const end = Math.min(cutoff, Date.UTC(year + 1, 0, 1) - 1);
        if (end <= begin) continue;
        const available = catalogue.filter(track => track.releasedAt <= end);
        if (!available.length) continue;
        const eligibleArtists = [...new Set(available.map(track => track.artist))];
        const eraArtists = shuffled(eligibleArtists).slice(0, Math.min(4, eligibleArtists.length));
        const goal = randomInt(450, 1250);
        const sessions = [];
        const yearRows = [];
        let planned = 0;
        let attempts = 0;
        while (planned < goal && attempts++ < goal) {
          const sessionSize = Math.min(goal - planned, randomInt(3, 18));
          const latestStart = Math.max(begin, end - 4 * 3600_000);
          const sessionStart = begin + Math.floor(rand() * (latestStart - begin + 1));
          const mode = choose(platforms);
          const shuffle = rand() < 0.55;
          const chosenEra = choose(eraArtists);
          const sessionTracks = catalogue.filter(track => track.releasedAt <= sessionStart);
          if (!sessionTracks.length) continue;
          let cursor = sessionStart;
          const sessionEvents = [];
          for (let i = 0; i < sessionSize; i++) {
            const weights = sessionTracks.map(track => trackWeights.get(track.id) *
              (track.artist === chosenEra ? 3.6 : 1) *
              (i && track.artist === sessionEvents[sessionEvents.length - 1]?.artist && !shuffle ? 4 : 1) *
              (track.releasedAt > sessionStart - 300 * 86400_000 ? 1.35 : 1));
            let roll = rand() * weights.reduce((a, b) => a + b, 0);
            let chosen = sessionTracks[sessionTracks.length - 1];
            for (let j = 0; j < sessionTracks.length; j++) {
              roll -= weights[j];
              if (roll <= 0) { chosen = sessionTracks[j]; break; }
            }
            const skipped = rand() < 0.05 + (shuffle ? 0.13 : 0.04);
            const played = skipped ? randomInt(3, Math.max(3, Math.min(90, Math.ceil(chosen.length / 1000) - 1))) * 1000 :
              Math.max(1000, chosen.length - randomInt(0, Math.min(5000, chosen.length - 1000)));
            cursor += played + randomInt(0, 5000);
            if (cursor > end || cursor > cutoff) break;
            const entry = {
              ts: new Date(cursor).toISOString(),
              master_metadata_album_artist_name: chosen.artist,
              master_metadata_track_name: chosen.title,
              master_metadata_album_album_name: chosen.album,
              ms_played: played,
              platform: mode,
              skipped,
              shuffle,
              offline: rand() < 0.08,
              reason_start: i ? 'trackdone' : 'clickrow',
              reason_end: skipped ? 'fwdbtn' : 'trackdone',
              demo_track_id: chosen.id
            };
            sessionEvents.push({ id: chosen.id, artist: chosen.artist, ts: entry.ts });
            yearRows.push(entry);
          }
          if (sessionEvents.length) {
            const session = { started: new Date(sessionStart).toISOString(), ended: sessionEvents[sessionEvents.length - 1].ts, platform: mode, trackIds: sessionEvents.map(e => e.id) };
            sessions.push(session);
            allSessions.push(session);
            planned += sessionEvents.length;
          }
        }
        years.push({ year, artists: eraArtists, sessions: sessions.length });
        byYear.set(String(year), yearRows.length);
        rows.push(...yearRows);
      }
      const friends = ['Alex', 'Sam', 'Charlie', 'Jordan', 'Taylor', 'Morgan'].map((name, id) => ({ id: `friend-${id + 1}`, name }));
      const playlists = ['Night Drives', 'On Repeat', 'Underground', 'Late Night', 'Gym Rotation', 'Old Favourites', 'Discoveries', 'Weekend'].map((name, id) => ({
        id: `playlist-${id + 1}`, name, trackIds: shuffled(catalogue).slice(0, randomInt(18, 55)).map(track => track.id)
      }));
      const messages = [];
      const shared = shuffled(catalogue).slice(0, Math.min(85, catalogue.length));
      for (const friend of friends) {
        const recommendations = shuffled(shared).slice(0, randomInt(8, 22));
        for (const track of recommendations) {
          if (track.releasedAt >= cutoff) continue;
          const timestamp = track.releasedAt + Math.floor(rand() * (cutoff - track.releasedAt));
          messages.push({ friendId: friend.id, trackId: track.id, ts: new Date(timestamp).toISOString(), direction: 'received' });
        }
      }
      const builder = makeBuilder();
      ingest(builder, rows);
      builder.sourceFiles = 1;
      const report = finishBuilder(builder, 'Randomised demo · not your data', 'Demo data', true);
      const credited = new Map();
      for (const event of rows) {
        if (event.ms_played < MIN_PLAY_MS) continue;
        const track = catalogue[event.demo_track_id];
        for (const name of track.credits) {
          for (const periodKey of ['all', event.ts.slice(0, 4)]) {
            if (!credited.has(periodKey)) credited.set(periodKey, new Map());
            const map = credited.get(periodKey);
            const key = keyOf(name);
            if (!map.has(key)) map.set(key, { name, plays: 0, ms: 0 });
            const artist = map.get(key);
            artist.plays++;
            artist.ms += event.ms_played;
          }
        }
      }
      for (const [periodKey, extras] of credited) {
        const records = report.periods[periodKey].artists;
        const byArtist = new Map(records.map(record => [keyOf(record.name), record]));
        for (const [key, extra] of extras) {
          if (byArtist.has(key)) {
            byArtist.get(key).plays += extra.plays;
            byArtist.get(key).ms += extra.ms;
          } else {
            records.push(extra);
            byArtist.set(key, extra);
          }
        }
        records.sort((a, b) => b.plays - a.plays || b.ms - a.ms);
      }
      report.demoData = {
        catalogue: catalogue.map(({ id, title, artist, album, released, length, credits }) => ({ id, title, artist, album, released, durationMs: length, creditedArtists: [artist, ...credits] })),
        events: rows,
        sessions: allSessions,
        eras: years,
        playlists,
        friends,
        messages,
        savedTrackIds: catalogue.filter(() => rand() < 0.48).map(track => track.id),
        yearTotals: [...byYear.entries()]
      };
      activateReport(report);
    } catch (error) {
      console.error('Could not generate demo:', error);
      showError(error instanceof Error ? error.message : 'Could not generate a new demo.');
    } finally {
      state.loading = false;
      $('randomise-demo').disabled = false;
      $('demo-button').disabled = false;
    }
  }

  function attachEvents() {
    document.querySelectorAll('[data-nav]').forEach(link => link.addEventListener('click', () => openView(link.dataset.nav)));
    document.querySelectorAll('[data-go]').forEach(link => link.addEventListener('click', () => openView(link.dataset.go)));
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
    $('year-filter').addEventListener('change', event => { state.year = event.target.value; state.count = 25; renderCurrent(); });
    for (const type of ['artist', 'track', 'album']) $(type + '-search').addEventListener('input', () => { state.count = 25; renderListing({ artist: 'artists', track: 'tracks', album: 'albums' }[type]); });
    document.querySelectorAll('[data-sort-for]').forEach(group => group.addEventListener('click', event => {
      const button = event.target.closest('[data-sort]');
      if (!button) return;
      state.sorts[group.dataset.sortFor] = button.dataset.sort;
      state.count = 25;
      renderListing(group.dataset.sortFor);
    }));
    for (const type of ['artist', 'track', 'album']) $(type + '-more').addEventListener('click', () => { state.count += 25; renderListing({ artist: 'artists', track: 'tracks', album: 'albums' }[type]); });
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
        await refreshHistoryCount();
        await renderHistory();
      }
    });
    $('clear-history').addEventListener('click', async () => {
      if (!confirm('Permanently delete ALL saved Wrapped 365 reports from this browser?')) return;
      const reports = await listReports();
      for (const report of reports) await removeReport(report.id);
      await refreshHistoryCount();
      await renderHistory();
    });
    $('about-method').addEventListener('click', () => $('method-dialog').showModal());
    $('close-dialog').addEventListener('click', () => $('method-dialog').close());
    $('method-ok').addEventListener('click', () => $('method-dialog').close());
    $('method-dialog').addEventListener('click', event => { if (event.target === $('method-dialog')) $('method-dialog').close(); });
  }

  async function loadAppVersion() {
    const target = $('app-version');
    if (!target) return;

    try {
      const response = await fetch('./VERSION', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const version = (await response.text()).trim();
      if (!version) throw new Error('Empty VERSION file');

      target.textContent = ` · v${version}`;
    } catch (error) {
      console.warn('Unable to load Wrapped 365 version:', error);
    }
  }

  async function initialise() {
    attachEvents();
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
