/* MDB58 admin dashboard. The bearer session is ONLY kept in this tab's memory.
 * Reloading, reopening or opening a new tab always requires the password. */
(() => {
  'use strict';
  const API = '/mdb58/admin/api';
  let accessToken = null;
  const $ = (id) => document.getElementById(id);
  const number = (n) => new Intl.NumberFormat('en-GB').format(Number(n || 0));
  const dateTime = (x) => x ? new Intl.DateTimeFormat('en-GB', {dateStyle:'medium',timeStyle:'short'}).format(new Date(x)) : '—';
  const compact = (n) => new Intl.NumberFormat('en-GB', {notation:'compact',maximumFractionDigits:1}).format(Number(n || 0));
  const setText = (id, value) => { $(id).textContent = value; };
  const reveal = (id, show) => $(id).classList.toggle('hidden', !show);
  const adminError = (message) => {setText('auth-error',message);reveal('auth-error',Boolean(message));};

  async function request(path, method='GET', body) {
    const headers = {'Accept':'application/json'};
    if (body !== undefined) headers['Content-Type']='application/json';
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const response = await fetch(`${API}${path}`, {
      method, headers, credentials:'omit', cache:'no-store',
      ...(body !== undefined ? {body:JSON.stringify(body)} : {})
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(typeof value.detail === 'string' ? value.detail : `Request failed (${response.status})`);
      err.status=response.status;
      throw err;
    }
    return value;
  }

  function showAuth(mode) {
    accessToken=null;
    reveal('dashboard',false);
    reveal('auth-screen',true);
    reveal('setup-form',mode==='setup');
    reveal('login-form',mode==='login');
    adminError('');
    if (mode==='setup') {
      setText('auth-eyebrow','FIRST-RUN SETUP');
      setText('auth-heading','Make it yours.');
      setText('auth-description','Create your private admin password. Use the one-time setup key you configured on your Asus to prove ownership of this instance.');
      $('setup-key').focus();
    } else if (mode==='login') {
      setText('auth-eyebrow','SECURE ACCESS');
      setText('auth-heading','Welcome backstage.');
      setText('auth-description','Enter your password to view MDB58 ingestion and database statistics. The dashboard locks whenever it is reopened or refreshed.');
      $('login-password').focus();
    } else {
      setText('auth-heading','Checking configuration…');
    }
  }

  function addText(parent, tag, content, cls) {
    const e=document.createElement(tag);
    if (cls) e.className=cls;
    e.textContent=String(content);
    parent.appendChild(e);
    return e;
  }

  function drawChart(weeks) {
    const root=$('activity-chart');
    root.replaceChildren();
    if (!Array.isArray(weeks) || !weeks.length) {
      addText(root,'div','No listening activity to graph yet.','empty-state');
      return;
    }
    const highest=Math.max(1,...weeks.map(w=>Number(w.listening_events)||0));
    for (const week of weeks) {
      const wrap=addText(root,'div','','activity-bar-wrap');
      const rail=addText(wrap,'div','','activity-rail');
      const bar=addText(rail,'span','','activity-bar');
      const amount=Math.max(3,Math.min(100,(Number(week.listening_events)||0)/highest*100));
      bar.style.height=`${amount}%`;
      const when=String(week.week||'');
      bar.title=`Week of ${when}: ${number(week.listening_events)} music events, ${number(week.qualifying_plays)} qualifying plays`;
      addText(wrap,'span',when.slice(5).replace('-','/'),'activity-week');
    }
  }

  function fillSummary(id, rows, field, countKey) {
    const root=$(id);
    root.replaceChildren();
    if (!rows?.length) {addText(root,'div','No data yet.','empty-state');return;}
    for (const row of rows) {
      const line=addText(root,'div','','state-row');
      addText(line,'strong',String(row[field]||'unknown').replaceAll('_',' '));
      addText(line,'span',number(row[countKey]),'count');
    }
  }

  function drawRecent(rows) {
    const root=$('recent-body');
    root.replaceChildren();
    if (!rows?.length) {
      const tr=document.createElement('tr');
      const td=addText(tr,'td','No submissions have been received yet.','empty-state');
      td.colSpan=5;
      root.appendChild(tr);
      return;
    }
    for (const sub of rows) {
      const tr=document.createElement('tr');
      const cell=document.createElement('td');
      const state=String(sub.state||'unknown');
      addText(cell,'span',state.replaceAll('_',' '),`pill ${['committed','duplicate','staging','rejected'].includes(state)?state:''}`);
      tr.appendChild(cell);
      addText(tr,'td',String(sub.source||'—').replaceAll('_',' '));
      addText(tr,'td',sub.active?'Yes':'No');
      addText(tr,'td',dateTime(sub.created_at));
      addText(tr,'td',dateTime(sub.updated_at));
      root.appendChild(tr);
    }
  }

  function render(data) {
    const t=data.totals || {};
    const l=data.listening || {};
    setText('stat-contributors',number(t.active_contributors));
    setText('stat-activated',`${number(t.activated)} beta invitations activated`);
    setText('stat-tracks',number(l.distinct_tracks));
    setText('stat-plays',number(l.listening_events));
    setText('stat-qualifying',`${number(l.qualifying_plays)} qualifying plays`);
    setText('stat-rows',number(l.weekly_rows));
    setText('stat-recordings',number(t.recordings));
    setText('stat-catalog',number(t.catalog_tracks));
    setText('stat-snapshots',number(t.active_snapshots));
    setText('stat-hours',`${number((Number(l.listened_ms)||0)/3600000 < 100 ? ((Number(l.listened_ms)||0)/3600000).toFixed(1) : Math.round((Number(l.listened_ms)||0)/3600000))} h`);
    setText('stat-skips',Number(l.skip_known)>0?`${(Number(l.skips)/Number(l.skip_known)*100).toFixed(1)}%`:'Unknown');
    setText('stat-schema',data.schema_version || '—');
    const b=Number(t.database_bytes)||0;
    setText('stat-size',b<1024*1024?`${(b/1024).toFixed(0)} KB`:b<1024**3?`${(b/1024**2).toFixed(1)} MB`:`${(b/1024**3).toFixed(2)} GB`);
    setText('stat-query',dateTime(data.generated_at));
    setText('last-refreshed',`Updated ${dateTime(data.generated_at)}`);
    drawChart(data.weeks);
    fillSummary('state-list',data.submission_states,'state','count');
    fillSummary('source-list',data.sources,'source','count');
    drawRecent(data.recent);
  }

  async function refresh() {
    const button=$('refresh');
    button.disabled=true;
    try {
      render(await request('/overview'));
    } catch(e) {
      if(e.status===401) {
        showAuth('login');
        adminError('Session expired. Please enter your password again.');
      } else {
        setText('last-refreshed',`Unable to refresh: ${e.message}`);
      }
    } finally {button.disabled=false;}
  }

  $('setup-form').addEventListener('submit',async (event)=>{
    event.preventDefault();adminError('');
    const pw=$('setup-password').value;
    if (pw !== $('setup-confirm').value) {adminError('The passwords do not match.');return;}
    const button=$('setup-submit');button.disabled=true;
    try {
      await request('/setup','POST',{setup_key:$('setup-key').value,password:pw});
      $('setup-form').reset();
      showAuth('login');
      setText('auth-description','Password created successfully. Sign in now to view your MDB58 dashboard.');
    } catch(e) {adminError(e.message);} finally {button.disabled=false;}
  });

  $('login-form').addEventListener('submit',async (event)=>{
    event.preventDefault();adminError('');
    const button=$('login-submit');button.disabled=true;
    try {
      const response=await request('/login','POST',{password:$('login-password').value});
      accessToken=response.token;
      $('login-form').reset();
      reveal('auth-screen',false);
      reveal('dashboard',true);
      await refresh();
    } catch(e) {adminError(e.message);} finally {button.disabled=false;}
  });

  $('logout').addEventListener('click',async ()=>{
    try {await request('/logout','POST',{});} catch (_err) {/* Local lock is unconditional. */}
    showAuth('login');
  });
  $('refresh').addEventListener('click',refresh);
  document.querySelectorAll('[data-nav]').forEach(a=>a.addEventListener('click',()=>{
    document.querySelectorAll('[data-nav]').forEach(b=>b.classList.toggle('selected',b===a));
  }));

  // Navigating away and returning via back/forward cache must also relock.
  window.addEventListener('pagehide', () => {accessToken=null;});
  window.addEventListener('pageshow', e => {if (e.persisted) showAuth('login');});

  // Refresh always starts here: never restore a token from storage or cookies.
  showAuth('loading');
  request('/status').then(result=>showAuth(result.configured?'login':'setup'))
    .catch(e=>{
      showAuth('loading');
      setText('auth-heading','Cannot reach MDB58.');
      setText('auth-description','Check that the API is running and database migration 0002 has been applied.');
      adminError(e.message);
    });
})();
