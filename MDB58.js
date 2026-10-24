/* MDB58 — Turbo Music Discovery Engine | beta protocol 1.0
 * Wrapped 365 calls beginImport(file), receiveListeningHistory(rows, session, isExtended), completeImport(session) / cancelImport(session).
 * Source JSON is parsed once by app.js, and the original Spotify ZIP never leaves the browser.
 * Only explicitly consented, locally calculated C+ aggregates upload.
 */
(() => {
  'use strict';
  const API = './mdb58/api/v1';
  const SOUNDCHECK_KEY = 'wrapped365_soundcheck_unlocked';
  const AGG_VERSION = 'cplus-1';
  const CHUNK_BYTES = 128 * 1024;
  const encoder = new TextEncoder();
  let csrf = null, activated = false, contributed = false, activationCheck = null;
  let activeImport = null, activeTask = false, lastDialogTrigger = null;
  const $ = id => document.getElementById(id);
  const soundcheckUnlocked = () => { try { return localStorage.getItem(SOUNDCHECK_KEY) === 'true'; } catch { return false; } };
  const optInInput = () => $('mdb58-contribute');
  const isOptedIn = () => activated && optInInput()?.checked === true;

  function status(message, error=false) {
    const target = $('mdb58-status');
    if (target) {
      target.textContent=message;
      target.classList.toggle('mdb58-error',error);
      target.classList.remove('hidden');
    }
  }
  async function api(path, method='GET', data=null) {
    const headers = {'Accept':'application/json'};
    if (method !== 'GET') {
      headers['Content-Type']='application/json';
      if (csrf) headers['X-MDB58-CSRF']=csrf;
    }
    const response=await fetch(`${API}${path}`, {method, credentials:'same-origin', cache:'no-store', headers,
      body: data === null ? undefined : JSON.stringify(data)});
    const parsed=await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(parsed.detail || `MDB58 API error ${response.status}`);
    return parsed;
  }
  async function refreshActivation() {
    if (!soundcheckUnlocked()) return;
    if (activationCheck) return activationCheck;
    activationCheck=(async()=>{ try { try {
      const state=await api('/me');
      activated=state.activated === true; contributed=state.contributed === true;
      csrf=state.csrf || null;
    } catch { activated=false; contributed=false; csrf=null; }
    updateUI();
    } finally {activationCheck=null;} })();
    return activationCheck;
  }
  function updateUI() {
    const opt=$('mdb58-optin'), removal=$('mdb58-removal'), activation=$('mdb58-activation');
    if (opt) opt.classList.toggle('hidden', !activated);
    if (removal) removal.classList.toggle('hidden', !(activated && contributed));
    if (activation) {
      activation.classList.toggle('hidden', !soundcheckUnlocked());
      const label=$('mdb58-activate-button');
      if (label) { label.textContent=activated?'MDB58 Beta Activated':'MDB58 Beta Activation'; label.disabled=activated; }
    }
  }
  function hideDialog(id) { if ($(id)?.open) $(id).close(); }
  function openDialog(id, trigger) { lastDialogTrigger=trigger; $(id)?.showModal(); }

  function mountUI() {
    const dropzone=$('dropzone');
    if (!dropzone || $('mdb58-optin')) return;
    const ui=document.createElement('section');
    ui.id='mdb58-optin';ui.className='mdb58-optin hidden';ui.setAttribute('aria-label','MDB58 private beta contribution');
    ui.innerHTML=`<div class="mdb58-optin-main"><div class="mdb58-check-row">
       <label class="mdb58-label" for="mdb58-contribute"><input id="mdb58-contribute" type="checkbox" autocomplete="off"><span>Contribute weekly listening insights to <strong>MDB58</strong></span></label>
       <button class="mdb58-help" id="mdb58-help" type="button" aria-label="About MDB58 contributions" aria-haspopup="dialog" aria-controls="mdb58-dialog">?</button></div>
       <p>Optional, pseudonymous music discovery research. Your normal Wrapped 365 report stays local.</p></div>
       <span class="mdb58-preview">Private beta</span>`;
    dropzone.insertAdjacentElement('afterend',ui);
    const notice=document.createElement('p'); notice.id='mdb58-status'; notice.className='mdb58-status hidden';
    ui.insertAdjacentElement('afterend',notice);

    // Soundcheck is unlocked exclusively by Wrapped 365's existing Konami-code flow.
    const panel=document.createElement('article');panel.id='mdb58-activation';panel.className='panel mdb58-beta-panel hidden';
    panel.innerHTML=`<div class="kicker">PRIVATE BETA</div><h2>MDB58 Beta</h2><p>Activate an invitation to take part in Turbo Music Discovery Engine testing.</p><button type="button" id="mdb58-activate-button" class="btn btn-outline">MDB58 Beta Activation</button><p id="mdb58-activation-status" class="mdb58-feedback" role="status"></p>`;
    $('view-soundcheck')?.append(panel);

    const removal=document.createElement('section');removal.id='mdb58-removal';removal.className='panel mdb58-removal hidden';
    removal.innerHTML=`<div class="kicker">YOUR MDB58 CONTRIBUTION</div><h2>Manage shared listening insights</h2><p>Your contributed weekly statistics are held privately by MDB58, separately from your local reports.</p><button id="mdb58-remove-button" type="button" class="btn btn-danger">Request removal of MDB58 contributions</button><p id="mdb58-removal-feedback" class="mdb58-feedback" role="status"></p>`;
    $('view-history')?.append(removal);

    function dialog(id,contents) {
      const el=document.createElement('dialog');el.id=id;el.innerHTML=`<div class="dialog-body">${contents}</div>`;
      document.body.append(el);
      el.addEventListener('click',ev=>{if(ev.target===el)hideDialog(id);});
      el.addEventListener('close',()=>lastDialogTrigger?.focus());
      return el;
    }
    dialog('mdb58-dialog',`<button class="dialog-close" type="button" data-close="mdb58-dialog" aria-label="Close">×</button><div class="kicker">PRIVATE MUSIC DISCOVERY</div><h2>What does MDB58 collect?</h2><p>MDB58 is a free, open-source music discovery project. With your permission, it receives track and artist metadata plus <strong>weekly listening totals</strong>, including play counts, duration, skips, repeats, shuffle, broad UTC time-of-day patterns, and inferred session summaries.</p><p>We never upload your Spotify ZIP, individual playback events, usernames, email, IP addresses from exports, or device identifiers. Your contribution is <strong>pseudonymised</strong> using a random contributor ID, not guaranteed anonymous.</p><p>Contributions and derived models are kept privately on our own server, not published or sold. Only the source code is open source.</p><p><strong>Entirely optional:</strong> all other Wrapped 365 functionality remains local. MDB58 recommendations during the beta are available only to contributors. You can request removal from Saved Reports.</p><button type="button" class="btn btn-primary" data-close="mdb58-dialog">Understood</button>`);
    dialog('mdb58-invite-dialog',`<button class="dialog-close" type="button" data-close="mdb58-invite-dialog" aria-label="Close">×</button><div class="kicker">MDB58 PRIVATE BETA</div><h2>Activate MDB58</h2><p>Enter your one-time beta invitation code. Activation unlocks MDB58 controls but <strong>does not</strong> consent to sharing your library.</p><form id="mdb58-invite-form"><label class="mdb58-field-label" for="mdb58-invite-code">Invitation code</label><input id="mdb58-invite-code" class="mdb58-field" required autocomplete="off" spellcheck="false" maxlength="150" placeholder="MDB58-…"><p id="mdb58-invite-error" class="mdb58-feedback" role="alert"></p><button class="btn btn-primary" id="mdb58-invite-submit" type="submit">Activate beta</button></form>`);
    dialog('mdb58-remove-dialog',`<button class="dialog-close" type="button" data-close="mdb58-remove-dialog" aria-label="Close">×</button><div class="kicker">CONFIRM REMOVAL</div><h2>Remove your MDB58 contributions?</h2><p>Your shared weekly listening statistics will be removed and your beta activation revoked. Your private Wrapped 365 reports are unaffected. Future trained models must also be rebuilt or retired to exclude previous contributions.</p><p><strong>This cannot be undone.</strong> A new invitation will be needed to rejoin.</p><div class="mdb58-dialog-actions"><button id="mdb58-remove-confirm" class="btn btn-danger" type="button">Yes, request removal</button><button class="btn btn-outline" type="button" data-close="mdb58-remove-dialog">Cancel</button></div>`);
    document.querySelectorAll('[data-close]').forEach(x=>x.addEventListener('click',()=>hideDialog(x.dataset.close)));
    $('mdb58-help').addEventListener('click',()=>openDialog('mdb58-dialog',$('mdb58-help')));
    $('mdb58-activate-button').addEventListener('click',()=>openDialog('mdb58-invite-dialog',$('mdb58-activate-button')));
    $('mdb58-remove-button').addEventListener('click',()=>openDialog('mdb58-remove-dialog',$('mdb58-remove-button')));
    $('mdb58-invite-form').addEventListener('submit',async ev=>{
      ev.preventDefault(); const btn=$('mdb58-invite-submit');btn.disabled=true;$('mdb58-invite-error').textContent='';
      try {
        const state=await api('/beta/activate','POST',{invite:$('mdb58-invite-code').value.trim()});
        activated=state.activated; contributed=false;csrf=state.csrf;
        $('mdb58-invite-code').value='';hideDialog('mdb58-invite-dialog');updateUI();
        $('mdb58-activation-status').textContent='Beta activated. Contribution is still optional.';
      } catch(error) { $('mdb58-invite-error').textContent=error.message; }
      finally {btn.disabled=false;}
    });
    $('mdb58-remove-confirm').addEventListener('click',async()=>{
      const btn=$('mdb58-remove-confirm');btn.disabled=true;
      try {
        const result=await api('/me/contributions','DELETE');
        if(!result.removed) throw new Error('Removal not confirmed');
        activated=false;contributed=false;csrf=null;hideDialog('mdb58-remove-dialog');updateUI();
        $('mdb58-activation-status').textContent='Your contribution was removed. The beta invitation has been revoked.';
      } catch(error){$('mdb58-removal-feedback').textContent=error.message;hideDialog('mdb58-remove-dialog');}
      finally {btn.disabled=false;}
    });
    updateUI();
    // A local Soundcheck unlock can happen after this module initialises.
    const nav=$('soundcheck-nav');
    if(nav) new MutationObserver(()=>{const unlocked=soundcheckUnlocked();updateUI();if(unlocked && !activated) void refreshActivation();}).observe(nav,{attributes:true,attributeFilter:['class']});
    if(soundcheckUnlocked()) void refreshActivation();
  }

  // This session contains only *temporary* locally sanitised music events.
  // They are used to derive weekly aggregates, then discarded after upload.
  // No raw Spotify JSON is copied or stored here.
  function beginImport(file) {
    const optedIn = isOptedIn();
    const session = {
      optedIn,
      file: optedIn ? file : null,
      hasExtended: false,
      events: [],
      seen: new Set()
    };
    activeImport = session;
    return session;
  }

  // app.js has already parsed each history JSON array. Its local report logic
  // remains unchanged; MDB58 merely collects the minimum fields it needs.
  async function receiveListeningHistory(rows, session, isExtended = false) {
    if (session !== activeImport || !session.optedIn || !isExtended || !Array.isArray(rows)) return;
    session.hasExtended = true;
    for (let i = 0; i < rows.length; i++) {
      if (session !== activeImport) return; // Import was cancelled while yielding.
      const row = rows[i];
      if (!row || typeof row !== 'object' || Array.isArray(row) || isPrivate(row)) continue;
      const match = /^spotify:track:([A-Za-z0-9]{22})$/.exec(String(row.spotify_track_uri || ''));
      const ts = Date.parse(row.ts);
      const ms = row.ms_played;
      if (!match || !Number.isFinite(ts) || !Number.isInteger(ms) || ms < 0 || ms > 86400000) continue;
      const title = typeof row.master_metadata_track_name === 'string' ? row.master_metadata_track_name.trim() : '';
      const artist = typeof row.master_metadata_album_artist_name === 'string' ? row.master_metadata_album_artist_name.trim() : '';
      const album = typeof row.master_metadata_album_album_name === 'string' ? row.master_metadata_album_album_name.trim() : '';
      if (!title || !artist) continue;
      // Match Wrapped 365's per-event deduplication semantics across JSON files.
      const key = [new Date(ts).toISOString(), ms, `spotify:track:${match[1]}`,
        row.platform || '', row.reason_start || '', row.reason_end || ''].join('|');
      if (session.seen.has(key)) continue;
      session.seen.add(key);
      session.events.push({ts, ms, id: match[1], title, artist, album,
        skip: typeof row.skipped === 'boolean' ? row.skipped : null,
        shuffle: typeof row.shuffle === 'boolean' ? row.shuffle : null});
      if (i > 0 && i % 8192 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  function clearImport(session) {
    session.events.length = 0;
    session.seen.clear();
    session.file = null;
  }
  function cancelImport(session) {
    if (session !== activeImport) return;
    activeImport = null;
    clearImport(session);
    if (optInInput()) optInInput().checked = false;
  }
  function completeImport(session) {
    if (session !== activeImport) return;
    activeImport = null;
    if (optInInput()) optInInput().checked = false;
    window.dispatchEvent(new CustomEvent('mdb58:import-complete', {detail: {optedIn: session.optedIn}}));
    if (session.optedIn && session.hasExtended && session.events.length &&
        session.file && /\.zip$/i.test(session.file.name)) {
      void contributeImport(session).finally(() => clearImport(session));
    } else {
      clearImport(session);
    }
  }
  const mayRequestRecommendations=()=>activated && contributed;

  function hex(bytes) {return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
  async function sha256(bytes) {return hex(await crypto.subtle.digest('SHA-256',bytes));}
  function weekOf(ts) {const d=new Date(ts);d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate() - (d.getUTCDay()+6)%7);return d.toISOString().slice(0,10);}
  function isPrivate(row) {return row.incognito_mode===true;}

  function aggregate(events, archiveHash) {
    if (!events.length) throw new Error('No eligible identified music plays were collected during import');
    // Work on a sorted copy; the input remains local and is released after use.
    events = events.slice();
    events.sort((a,b)=>a.ts-b.ts || a.id.localeCompare(b.id) || a.ms-b.ms);
    const tracks=new Map(),stats=new Map(),sessions=new Map();
    let previous=null,sessionEnd=null,sessionWeek=null;
    for(const e of events){
      if(!tracks.has(e.id)) tracks.set(e.id,{identifiers:[{namespace:'spotify.track',value:e.id}],title:e.title,artists:[e.artist],album:e.album||null});
      const week=weekOf(e.ts);const k=`${e.id}|${week}`;
      if(!stats.has(k))stats.set(k,{id:e.id,week,events:0,duration_known:0,qualifying_plays:0,played_ms:0,
        skip_known:0,skips:0,shuffle_known:0,shuffled:0,immediate_repeats:0,time_known:0,
        utc_hour_buckets:[0,0,0,0],weekday_events:0,weekend_events:0});
      const s=stats.get(k);s.events++;s.duration_known++;s.played_ms+=e.ms;
      if(e.ms>=30000)s.qualifying_plays++;
      if(e.skip!==null){s.skip_known++;if(e.skip)s.skips++;}
      if(e.shuffle!==null){s.shuffle_known++;if(e.shuffle)s.shuffled++;}
      const gap=previous ? e.ts-e.ms-previous.ts : Infinity;
      if(previous && previous.id===e.id && gap>=-120000 && gap<=30*60000)s.immediate_repeats++;
      const d=new Date(e.ts),hour=d.getUTCHours(),dow=d.getUTCDay();
      s.time_known++;s.utc_hour_buckets[Math.floor(hour/6)]++;
      if(dow===0||dow===6)s.weekend_events++;else s.weekday_events++;
      if(!sessions.has(week)) sessions.set(week,{week_start:week,session_count:0,session_duration_ms:0,days:new Set()});
      const sess=sessions.get(week);sess.session_duration_ms+=e.ms;sess.days.add(d.toISOString().slice(0,10));
      if(!sessionEnd || gap>30*60000 || gap< -120000 || sessionWeek!==week) sess.session_count++;
      sessionEnd=e.ts;sessionWeek=week;previous=e;
    }
    const order=[...tracks.keys()].sort(); const refs=new Map(order.map((id,i)=>[id,`t${i+1}`]));
    const weekly=[...stats.values()].map(({id,week,...s})=>({
      ...s,
      skips:s.skip_known?s.skips:null,
      shuffled:s.shuffle_known?s.shuffled:null,
      track_ref:refs.get(id),week_start:week
    }));
    weekly.sort((a,b)=>a.track_ref.localeCompare(b.track_ref,undefined,{numeric:true})||a.week_start.localeCompare(b.week_start));
    const weeks=weekly.map(x=>x.week_start).sort();
    return {
      schema_version:'1.0',aggregation_version:AGG_VERSION,source:'spotify_extended_history',
      submission:{id:crypto.randomUUID(),mode:'replace_complete',archive_sha256:archiveHash,first_week:weeks[0],last_week:weeks[weeks.length-1]},
      tracks:order.map(id=>({ref:refs.get(id),...tracks.get(id)})),
      weekly_tracks:weekly,
      weekly_sessions:[...sessions.values()].sort((a,b)=>a.week_start.localeCompare(b.week_start)).map(s=>({week_start:s.week_start,session_count:s.session_count,session_duration_ms:s.session_duration_ms,active_days:s.days.size}))
    };
  }
  function base64Bytes(bytes) {
    let result=''; const size=8192;
    for(let i=0;i<bytes.length;i+=size) result+=String.fromCharCode(...bytes.subarray(i,i+size));
    return btoa(result);
  }
  async function contributeImport(session) {
    const file = session.file;
    if(activeTask || !activated || !csrf)return;
    activeTask=true;
    try {
      status('MDB58: checking your archive locally…');
      const archiveHash=await sha256(await file.arrayBuffer());
      const check=await api('/contributions/check','POST',{archive_sha256:archiveHash});
      if(check.identical_active_archive){status('MDB58: this archive is already contributed. No upload required.');return;}
      status('MDB58: calculating weekly insights locally…');
      const payload=aggregate(session.events,archiveHash);
      const bytes=encoder.encode(JSON.stringify(payload));
      if(bytes.byteLength>24*1024*1024) throw new Error('MDB58 contribution exceeds the beta size limit');
      const total=Math.ceil(bytes.length/CHUNK_BYTES);
      const started=await api('/contributions','POST',{id:payload.submission.id,source:payload.source,archive_sha256:archiveHash,total_chunks:total});
      if(started.state!=='staging') throw new Error('Submission already completed');
      for(let n=0;n<total;n++) {
        const part=bytes.subarray(n*CHUNK_BYTES,(n+1)*CHUNK_BYTES);
        await api(`/contributions/${payload.submission.id}/chunks/${n}`,'PUT',{index:n,base64_data:base64Bytes(part),sha256:await sha256(part)});
        status(`MDB58: uploading private weekly summaries (${n+1}/${total})…`);
      }
      const result=await api(`/contributions/${payload.submission.id}/commit`,'POST',{});
      if(!['committed','duplicate'].includes(result.status)) throw new Error('Contribution was not confirmed');
      contributed=true;updateUI();
      status(result.status==='duplicate'?'MDB58: your listening contribution was unchanged.':'MDB58: contribution securely received. Thank you!');
    }catch(error){console.warn('MDB58 contribution unsuccessful:',error);status(`MDB58: ${error.message} Your Wrapped 365 report remains local and usable.`,true);}
    finally{activeTask=false;}
  }

  window.MDB58=Object.freeze({name:'MDB58',fullName:'Turbo Music Discovery Engine',phase:'beta-ingestion-v1',
    isOptedIn,beginImport,receiveListeningHistory,completeImport,cancelImport,mayRequestRecommendations,refreshActivation});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountUI,{once:true});else mountUI();
})();
