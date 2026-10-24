const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const src = fs.readFileSync(__dirname + '/../MDB58.js', 'utf8')
  .replace('  window.MDB58=Object.freeze(', '  window.__mdb58AggregateForTest=aggregate;\n  window.MDB58=Object.freeze(');
const idA='A'.repeat(22), idB='B'.repeat(22);
const row=(id,ts,ms,skip,shuffle,extra={})=>({
  ts,ms_played:ms,spotify_track_uri:`spotify:track:${id}`,
  master_metadata_album_artist_name:'Test Artist',
  master_metadata_track_name:id===idA?'Test A':'Test B',
  master_metadata_album_album_name:'Test Album',
  skipped:skip,shuffle,platform:'Linux',reason_start:'trackdone',reason_end:'trackdone',...extra
});
const rows=[
  row(idA,'2026-10-20T12:00:00Z',50000,true,false),
  row(idA,'2026-10-20T12:01:00Z',45000,false,true),
  row(idB,'2026-10-20T12:03:00Z',5000,undefined,undefined),
  row(idA,'2026-10-20T12:04:00Z',30000,true,false,{incognito_mode:true}),
];
let checked=false, network=[], contributedPayload=null, activated=false;
const checkbox={get checked(){return checked;},set checked(v){checked=v;}};
const mockElement=id=> id==='mdb58-contribute'?checkbox:null;
const response=payload=>({ok:true,status:200,json:async()=>payload});
const fetch=async (url,opts)=>{
  network.push([url,opts.method]);
  if(url.endsWith('/me'))return response({activated:true,contributed:false,csrf:'testcsrf'});
  if(url.endsWith('/contributions/check'))return response({identical_active_archive:false});
  if(url.endsWith('/contributions'))return response({state:'staging'});
  if(url.includes('/chunks/')){
    const msg=JSON.parse(opts.body);
    const part=Buffer.from(msg.base64_data,'base64');
    contributedPayload=part.toString('utf8');
    return response({received:true});
  }
  if(url.endsWith('/commit'))return response({status:'committed'});
  throw Error('Unexpected fetch '+url);
};
const context={window:{dispatchEvent:()=>{}},document:{readyState:'loading',addEventListener:()=>{},getElementById:mockElement},
  localStorage:{getItem:()=> 'true'},crypto:webcrypto,TextEncoder,Date,Set,Map,console,
  setTimeout,CustomEvent:class {constructor(type,details){this.type=type;this.detail=details.detail;}},fetch,btoa};
vm.runInNewContext(src,context,{filename:'MDB58.js'});
const mdb=context.window.MDB58;
const file={name:'spotify.zip',arrayBuffer:async()=>new TextEncoder().encode('Fake zip bytes, never parsed by MDB58').buffer};
(async()=>{
  await mdb.refreshActivation();
  const callsAfterAuth=network.length;
  // Unchecked imports must never create or submit listening histories.
  checked=false;
  let s=mdb.beginImport(file);
  await mdb.receiveListeningHistory(rows,s,true);
  assert.equal(s.events.length,0);
  mdb.completeImport(s);
  assert.equal(network.length,callsAfterAuth);
  // A checked but non-extended history is not an eligible full contribution.
  checked=true;
  s=mdb.beginImport(file);
  await mdb.receiveListeningHistory(rows,s,false);
  assert.equal(s.events.length,0);
  mdb.cancelImport(s);
  // Actual extended history: passing the same parsed row across files deduplicates.
  checked=true;
  s=mdb.beginImport(file);
  await mdb.receiveListeningHistory(rows.slice(0,2),s,true);
  await mdb.receiveListeningHistory([rows[0],...rows.slice(2)],s,true);
  assert.equal(s.events.length,3); // duplicate and private-mode event excluded
  const payload=context.window.__mdb58AggregateForTest(s.events,'f'.repeat(64));
  assert.equal(payload.weekly_tracks.length,2);
  const a=payload.weekly_tracks.find(v=>v.events===2);
  const b=payload.weekly_tracks.find(v=>v.events===1);
  assert.equal(a.qualifying_plays,2);
  assert.equal(a.immediate_repeats,1);
  assert.equal(a.skips,1);
  assert.equal(a.shuffled,1);
  assert.equal(b.skips,null);
  assert.equal(b.shuffled,null);
  assert.equal(payload.weekly_sessions[0].session_count,1);
  if(process.env.MDB58_FIXTURE)fs.writeFileSync(process.env.MDB58_FIXTURE,JSON.stringify(payload));
  mdb.completeImport(s);
  for(let i=0;i<50&&!contributedPayload;i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(contributedPayload,'One structured contribution should be uploaded');
  assert.deepEqual(JSON.parse(contributedPayload).weekly_tracks.length,2);
  assert.equal(checked,false,'Opt-in must reset');
  assert.equal(!network.some(([url])=>url.includes('zip-upload')),true);
  console.log('Passed: opt-in, unsupported source, single-parsed-data hook, dedup, private exclusion, null vs zero, C+ payload, upload path');
})().catch(error=>{console.error(error);process.exitCode=1;});
