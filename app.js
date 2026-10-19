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
    try {
      const topTracks = [
        ['Misery in Waking Hours', '$uicideboy$', 'New World Depression', 130],
        ['LIKE YXU WXULD KNXW (AUTUMN TREES)', 'Kordhell', 'PSYCHX', 128],
        ['MORRISON', 'Night Lovell', "I HOPE YOU'RE HAPPY", 106],
        ['CODE MISTAKE', 'CORPSE', 'CODE MISTAKE', 102],
        ['Leviticus', '$uicideboy$', 'THY WILL BE DONE', 94],
        ['MISA MISA!', 'CORPSE', 'MISA MISA!', 92],
        ['Sorry 4 What? // LV BELT', 'Tory Lanez', 'Sorry 4 What', 80],
        ['Ran To Atlanta (feat. Future & Molly Santana)', 'Drake', 'ICEMAN', 79],
        ['The Light at the End of the Tunnel for $9.99 a Month', '$uicideboy$', 'New World Depression', 76],
        ['Napoleon', '$uicideboy$', 'THY KINGDOM COME', 75],
        ['Now and at the Hour of Our Death (feat. BONES)', '$uicideboy$', 'THY KINGDOM COME', 66],
        ['Mood Swing Misery', 'Pouya', 'The South Got Something to Say', 65],
        ['fuK u lol', 'CORPSE', 'fuK u lol', 61],
        ['LIFE SUCKS SO WE FUCK (feat. ZillaKami)', 'Night Lovell', "I HOPE YOU'RE HAPPY", 59],
        ['Cinderella', 'Future', "WE DON'T TRUST YOU", 57],
        ['HOT DEMON B!TCHES NEAR U ! ! !', 'CORPSE', 'HOT DEMON B!TCHES NEAR U ! ! !', 57],
        ['Cat Girls Are Ruining My Life!', 'CORPSE', 'Cat Girls Are Ruining My Life!', 56],
        ['move on, be strong', 'Lil Peep', 'HELLBOY', 56],
        ['E-GIRLS ARE RUINING MY LIFE!', 'CORPSE', 'E-GIRLS ARE RUINING MY LIFE!', 47],
        ['Behold a Pale Rider', 'Savage Ga$p', 'American Gothic', 47],
        ['DRAINO (feat. Denzel Curry)', 'City Morgue', 'CITY MORGUE VOL 2: AS GOOD AS DEAD', 46],
        ['O Pana!', '$uicideboy$', 'Eternal Grey', 45],
        ['Sky', 'Playboi Carti', 'Whole Lotta Red', 45],
        ['i like the way you kiss me', 'Artemas', 'dirty little secret', 45],
        ['Miss YOU!', 'CORPSE', 'Miss YOU!', 43],
        ['White Tee', 'CORPSE', 'White Tee', 43],
        ['Mask Off', 'Future', 'FUTURE', 42],
        ['THE SUN', 'Night Lovell', 'Goodnight Lovell', 41],
        ["That's It (feat. Future & Metro Boomin)", 'Yung Lean', "That's It (feat. Future & Metro Boomin) [from GTAVI: The Album]", 38],
        ['MARY JANE', 'Night Lovell', 'Goodnight Lovell', 37],
        ['Who Needs Love', 'Trippie Redd', 'A Love Letter to You 4', 36],
        ["Jamie's Sin", 'Night Lovell', "Jamie's Sin", 35],
        ['Type Shit', 'Future', "WE DON'T TRUST YOU", 35],
        ["We Don't Trust You", 'Future', "WE DON'T TRUST YOU", 33],
        ['Benz Truck (гелик)', 'Lil Peep', "Come Over When You're Sober, Pt. 1", 33],
        ['HOT ONE (with TiaCorine & A$AP Ferg)', 'Denzel Curry', 'KING OF THE MISCHIEVOUS SOUTH', 32],
        ['do re mi', 'blackbear', 'digital druglord', 31],
        ['Ric Flair Drip (with Metro Boomin)', 'Offset', 'Without Warning', 31],
        ['goosebumps (feat. Kendrick Lamar)', 'Travis Scott', 'Birds in the Trap Sing McKnight', 30],
        ['Stronger', 'Kanye West', 'Graduation', 29],
        ['Without Me', 'Eminem', 'The Eminem Show', 28],
        ['HUMBLE.', 'Kendrick Lamar', 'DAMN.', 27],
        ['a lot (feat. J. Cole)', '21 Savage', 'i am > i was', 26],
        ['Lucid Dreams', 'Juice WRLD', 'Goodbye & Good Riddance', 25],
        ['Jocelyn Flores', 'XXXTentacion', '17', 24],
        ['Blinding Lights', 'The Weeknd', 'After Hours', 23],
        ['Praise The Lord (Da Shine) (feat. Skepta)', 'A$AP Rocky', 'TESTING', 22],
        ['A Milli', 'Lil Wayne', 'Tha Carter III', 21],
        ['BAND4BAND (feat. Lil Baby)', 'Central Cee', "CAN'T RUSH GREATNESS", 20],
        ['Monëy so big', 'Yeat', 'Up 2 Më', 19]
              ];
              const additionalAlbums = [
        ['INDUSTRY BABY (feat. Jack Harlow)', 'Lil Nas X', 'MONTERO', 17],
        ['XO TOUR Llif3', 'Lil Uzi Vert', 'Luv Is Rage 2', 17],
        ["I Don't Like (feat. Lil Reese)", 'Chief Keef', 'Finally Rich', 16],
        ["Day 'N' Nite (nightmare)", 'Kid Cudi', 'Man on the Moon: The End of Day', 16],
        ['CLOUT COBAIN', 'Denzel Curry', 'TA13OO', 15],
        ['Thought It Was a Drought', 'Future', 'DS2', 15]
              ];

        // Real songs from listed releases give the most prominent artists
        // deeper catalogues without displacing the Top 50 track ranking.
            const catalogue = [
          ...[
            'Lone Wolf Hysteria', 'The Thin Grey Line', 'Thorns', 'Burgundy',
            'Transgressions', 'All of My Problems Always Involve Me', 'Us Vs. Them',
            'Are You Going to See the Rose in the Vase, or the Dust on the Table'
          ].map(title => [title, '$uicideboy$', 'New World Depression', 16]),

        ...[
          'WHO IS THIS WEIRDO ?', 'MY DAY IS RUINED !', 'GOLDEN TICKET', 'SUNDAY',
          'PEEK-A-BOO', 'SUCKS TO BE YOU :/', 'FREAK (feat. Freddie Dredd)',
        'EYE SPY', 'ALIVE EVEN WHEN I DIE', 'COLD SHOULDER'
        ].map(title => [title, 'Night Lovell', "I HOPE YOU'RE HAPPY", 18]),

        ...[
          'BAD KID', 'LET ME DIE', 'MENTAL SLAVERY', "WHERE'S MY MONEY", 'PAIN',
          'BUMBLE BEE', 'WATCH ME', 'JOAN OF ARC'
        ].map(title => [title, 'Night Lovell', 'Goodnight Lovell', 18]),

        ...[
          'Young Metro', 'Ice Attack', 'Claustrophobic', 'Like That', 'Slimed In',
          'Magic Don Juan (Princess Diana)', 'Runnin Outta Time', 'Fried (She a Vibe)',
        "Ain't No Love", 'Everyday Hustle', 'GTA', 'Seen it All', 'WTFYM', 'Where My Twin @'
        ].map(title => [title, 'Future', "WE DON'T TRUST YOU", 17]),

        ...[
          'Rent Money', 'Good Dope', 'Zoom', 'Draco', 'Super Trapper', 'POA',
          'High Demand', 'Outta Time', 'Scrape'
        ].map(title => [title, 'Future', 'FUTURE', 17]),

        ...[
          'hellboy', 'drive by', 'the song they played (when i crashed into the wall)',
        'girls', 'OMFG', 'cobain', 'gucci mane', 'worlds away', 'we think too much', 'interlude'
        ].map(title => [title, 'Lil Peep', 'HELLBOY', 16]),

        ...[
          'the ends', 'way back', 'coordinate', 'through the late night',
          'beibs in the trap', 'pick up the phone', 'sweet sweet'
        ].map(title => [title, 'Travis Scott', 'Birds in the Trap Sing McKnight', 17])
              ];

          // A smaller sample from the rest of the 50 artist roster. Tracks
          // outside the 50 selected releases remain too low-ranked to displace them.
          const otherArtists = [
        ['Superhero (Heroes & Villains)', 'Metro Boomin', 'HEROES & VILLAINS', 7],
        ['Bandz a Make Her Dance', 'Juicy J', 'Stay Trippy', 7],
        ['Traction Control', 'CASisDEAD', 'Famous Last Words', 7],
        ['Empire State of Mind', 'Jay-Z', 'The Blueprint 3', 7],
        ['Tip Toe Wing in My Jawwdinz', 'Riff Raff', 'Neon Icon', 7],
        ['Yes Indeed', 'Lil Baby', 'Harder Than Ever', 7],
        ['See You Again (feat. Charlie Puth)', 'Wiz Khalifa', 'Furious 7 (Original Motion Picture Soundtrack)', 7],
        ["Drop It Like It's Hot", 'Snoop Dogg', 'R&G (Rhythm & Gangsta): The Masterpiece', 7],
        ['Collard Greens', 'ScHoolboy Q', 'Oxymoron', 7],
        ['Hot (feat. Gunna)', 'Young Thug', 'So Much Fun', 7],
        ["I'm Different", '2 Chainz', 'Based on a T.R.U. Story', 7],
        ["Ain't It Funny", 'Danny Brown', 'Atrocity Exhibition', 7],
        ['No Idea', 'Don Toliver', 'Heaven or Hell', 7],
        ['Mercury: Retrograde', 'Ghostemane', 'HEXADA', 7],
        ['HDMI', 'BONES', 'Rotten', 7],
        ['The Fo Five', 'Ramirez', 'THE PLAYA$ MANUAL', 7],
        ['Han Solo', 'Germ', 'BAD SHIT', 7],
        ['Self Care', 'Mac Miller', 'Swimming', 7],
        ['EARFQUAKE', 'Tyler, the Creator', 'IGOR', 7],
        ['Agony', 'Yung Lean', 'Stranger', 7]
              ];

              const builder = makeBuilder();
              let seed = 27891;
              const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
              const platforms = ['linux', 'windows', 'macos', 'android', 'ios', 'chromecast', 'Apple TV', 'Android TV', 'Sonos'];
              const rows = [];
              let sequence = 0;

              for (const [title, artist, album, plays] of [...topTracks, ...additionalAlbums, ...catalogue, ...otherArtists]) {
                for (let i = 0; i < plays; i++) {
                  // Use distinct millisecond timestamps so no invented demo plays are
                  // lost to Spotify's normal event deduplication.
                  const year = 2017 + Math.floor(Math.pow(rand(), 0.62) * 10);
                  const month = Math.floor(rand() * 12);
                  const day = 1 + Math.floor(rand() * 28);
                  const hour = Math.floor(rand() * 24);
                  const minute = Math.floor(rand() * 60);
                  const timestamp = new Date(Date.UTC(year, month, day, hour, minute, sequence % 60, sequence % 1000)).toISOString();
                  sequence++;
                  const skipped = rand() < 0.12;
                  const platform = platforms[Math.floor(rand() * platforms.length)];

                  rows.push({
                    ts: timestamp,
                    master_metadata_album_artist_name: artist,
                    master_metadata_track_name: title,
                    master_metadata_album_album_name: album,
                    ms_played: 35_000 + Math.floor(rand() * (skipped ? 75_000 : 255_000)),
                            platform,
                            skipped,
                            shuffle: rand() < 0.57,
                            offline: rand() < 0.09
                  });
                }
              }

              ingest(builder, rows);
              builder.sourceFiles = 1;
              activateReport(finishBuilder(builder, 'Sample listening history · not your data', 'Demo data', true));
            } finally {
              state.loading = false;
            }
          }


  function attachEvents() {
    document.querySelectorAll('[data-nav]').forEach(link => link.addEventListener('click', () => openView(link.dataset.nav)));
    document.querySelectorAll('[data-go]').forEach(link => link.addEventListener('click', () => openView(link.dataset.go)));
    $('browse-button').addEventListener('click', event => { event.stopPropagation(); $('file-input').click(); });
    $('file-input').addEventListener('change', event => { if (event.target.files[0]) importHistory(event.target.files[0]); });
    $('demo-button').addEventListener('click', event => { event.stopPropagation(); makeDemo(); });
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
