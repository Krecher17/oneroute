// @ts-nocheck
// ONEROUTE legacy engine: the original single-page app logic, moved out of index.html unchanged
// except for: bundled dependencies, provider-neutral map styles, and no service-worker retirement.
// Screens are being migrated into React one at a time (see MIGRATION.md).
import { io } from 'socket.io-client';
import maplibregl from 'maplibre-gl';
import { createMap, setSatellite, satelliteAvailable } from '../lib/mapStyle';
import { bridge } from '../lib/bridge';
import { prefersReducedMotion } from '../lib/a11y';
import { squareJpeg, uploadAvatarWith } from '../lib/avatar';
import { config } from '../lib/config';
import { geo, getPositionOnce } from '../platform/location';
import i18n from '../i18n';
import { maneuverText, spokenAction, spokenPrompt, spokenMissedTurn, formatDistance } from '../lib/directions';
import { speechLanguage, speechLocale } from '../lib/speech';

let started = false;
export function startLegacy() {
if (started) return;
started = true;
const $=id=>document.getElementById(id);
// ===== NEW: accounts. The socket only connects after login and sends the saved login token. =====
const AUTH_KEY='oneroute-token';
let authToken='';try{authToken=localStorage.getItem(AUTH_KEY)||sessionStorage.getItem(AUTH_KEY)||''}catch{}
let authUser=null;
const socket=io(config.serverUrl||undefined,{autoConnect:false,auth:cb=>cb({token:authToken})});
function authHeaders(){return authToken?{Authorization:'Bearer '+authToken}:{}}
const COLORS={ok:'#42c786',behind:'#f2a23a',off:'#f05b57',offline:'#9ca3af',arrived:'#6aa8ff'};
const LABEL={ok:'On route',behind:'Behind',off:'Off route',offline:'No signal',arrived:'Arrived',waiting:'Waiting for GPS'};
let chosen=null,session=null,map=null,watchId=null,wakeLock=null,follow=true,rejoinMarker=null,bannerTimer=null,pendingTrip=null,plannedWaypoints=[],plannerMap=null,plannerMarkers=[],lastGps=null,fuelVisible=false,fuelMarkers=[],fuelRequestId=0;
let navMap=null,navMarkers={},navRouteSteps=[],navStepIndex=0,navCars=[],navRouteCoords=[],navRouteRequest=0,navOpen=false,navLastRouteAt=0;
const markers={};

// ===== NEW: motion helpers =====
const REDUCED=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const glides=new Map();
// Smoothly glide a MapLibre marker to a new [lon,lat] instead of jumping.
function glideMarker(key,marker,to,ms=700){
  const from=marker.getLngLat();
  cancelAnimationFrame(glides.get(key));
  const dx=to[0]-from.lng,dy=to[1]-from.lat;
  // Snap when reduced motion is on, nothing changed, or the jump is huge (teleport / reconnect).
  if(REDUCED||(Math.abs(dx)<1e-7&&Math.abs(dy)<1e-7)||Math.abs(dx)>0.05||Math.abs(dy)>0.05){marker.setLngLat(to);return}
  const t0=performance.now();
  const step=now=>{
    const p=Math.min(1,(now-t0)/ms),e=1-Math.pow(1-p,3);
    marker.setLngLat([from.lng+dx*e,from.lat+dy*e]);
    if(p<1)glides.set(key,requestAnimationFrame(step));
  };
  glides.set(key,requestAnimationFrame(step));
}
// Count a number up/down to its new value.
function animateNumber(el,to,decimals=0,suffix=''){
  if(!el)return;
  const from=Number(el._v);el._v=to;
  cancelAnimationFrame(el._raf);
  if(REDUCED||!Number.isFinite(from)||from===to){el.textContent=to.toFixed(decimals)+suffix;return}
  const t0=performance.now();
  const step=now=>{
    const p=Math.min(1,(now-t0)/500),e=1-Math.pow(1-p,3);
    el.textContent=(from+(to-from)*e).toFixed(decimals)+suffix;
    if(p<1)el._raf=requestAnimationFrame(step);
  };
  el._raf=requestAnimationFrame(step);
}

// ===== NEW: smart regroup points + "I'm stopping" =====
let lastCars=[],regroupMarker=null,regroupBusy=false,regroupTarget=null,regroupTimer=null,myHalt=null,haltTotalMs=0,cumCache=null,cumFor=null;
const regroupSeen={},halts={};
const routeCoords=()=>Array.isArray(pendingTrip?.route)?pendingTrip.route:[];
function nearestRouteIdx(pt){
  const r=routeCoords();let best=-1,bd=Infinity;const k=Math.cos(pt[1]*Math.PI/180);
  for(let i=0;i<r.length;i++){const dx=(r[i][0]-pt[0])*k,dy=r[i][1]-pt[1],d=dx*dx+dy*dy;if(d<bd){bd=d;best=i}}
  return {idx:best,meters:Math.sqrt(bd)*111320};
}
function routeCum(){
  const r=routeCoords();if(cumFor===r&&cumCache)return cumCache;
  const c=[0];for(let i=1;i<r.length;i++)c.push(c[i-1]+navDistance(r[i-1],r[i])/1000);
  cumCache=c;cumFor=r;return c;
}
const STOP_KIND={fuel:['⛽','Fuel station'],rest_area:['🛏️','Rest area'],services:['🅿️','Service area']};
function clearRegroup(){
  clearTimeout(regroupTimer);regroupTarget=null;
  if(regroupMarker){regroupMarker.remove();regroupMarker=null}
  $('regroupPanel').hidden=true;
}
async function suggestRegroup(a){
  const key=a.id||a.name,now=Date.now();
  if(regroupBusy||now-(regroupSeen[key]||0)<120000)return;
  if(routeCoords().length<2||!map)return;
  const placed=lastCars.filter(c=>Number.isFinite(Number(c.lon))&&Number.isFinite(Number(c.lat)))
    .map(c=>({c,...nearestRouteIdx([Number(c.lon),Number(c.lat)])})).filter(p=>p.meters<2000);
  if(placed.length<2)return;
  const lag=placed.find(p=>p.c.id===a.id)||placed.find(p=>p.c.name===a.name)||placed.reduce((x,y)=>x.idx<y.idx?x:y);
  const lead=placed.reduce((x,y)=>x.idx>y.idx?x:y);
  if(lead.idx<=lag.idx)return;
  regroupSeen[key]=now;regroupBusy=true;
  $('regroupTitle').textContent='Finding a regroup point…';$('regroupDetail').replaceChildren(skeletonBlock(2));$('regroupPanel').hidden=false;
  try{
    await new Promise(r=>setTimeout(r,Math.random()*1500)); // spread load if several phones ask at once
    const lat=Number(lead.c.lat),lon=Number(lead.c.lon),ar=`(around:12000,${lat},${lon})`;
    const q=`[out:json][timeout:20];(nwr${ar}[amenity=fuel];nwr${ar}[highway=rest_area];nwr${ar}[highway=services];);out center tags;`;
    const resp=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:'data='+encodeURIComponent(q)});
    if(!resp.ok)throw new Error('Overpass failed');
    const data=await resp.json();
    const cands=(data.elements||[]).map(el=>{
      const la=Number(el.lat??el.center?.lat),lo=Number(el.lon??el.center?.lon);
      if(!Number.isFinite(la)||!Number.isFinite(lo))return null;
      const t=el.tags||{},kind=t.amenity==='fuel'?'fuel':t.highway==='rest_area'?'rest_area':'services';
      const n=nearestRouteIdx([lo,la]);if(n.meters>1500)return null;
      return {name:t.name||t.brand||STOP_KIND[kind][1],kind,lat:la,lon:lo,idx:n.idx};
    }).filter(Boolean);
    // Prefer a stop just ahead of the leader (nobody has to turn back); otherwise the closest stop between the two.
    const ahead=cands.filter(s=>s.idx>=lead.idx).sort((x,y)=>x.idx-y.idx);
    const between=cands.filter(s=>s.idx>lag.idx&&s.idx<lead.idx).sort((x,y)=>Math.abs(x.idx-lead.idx)-Math.abs(y.idx-lead.idx));
    const stop=ahead[0]||between[0];
    clearRegroup();
    if(!stop){
      $('regroupTitle').textContent='No rest area found nearby';
      $('regroupDetail').textContent=`${a.name||'A driver'} is ${a.gapKm??'several'} km behind. No fuel stop or rest area was found along the next stretch. Pick a safe place to wait.`;
      $('regroupPanel').hidden=false;return;
    }
    const cum=routeCum(),lagKm=Math.max(0,cum[stop.idx]-cum[lag.idx]),leadKm=Math.max(0,cum[stop.idx]-cum[lead.idx]);
    const [icon,label]=STOP_KIND[stop.kind];
    $('regroupTitle').textContent=`${icon} ${stop.name}`;
    $('regroupDetail').textContent=`${label} on your route. ${lead.c.name||'The lead car'} is ${leadKm.toFixed(1)} km away; ${a.name||lag.c.name||'the car behind'} is ${lagKm.toFixed(1)} km away (about ${Math.max(1,Math.round(lagKm))} min at 60 km/h). Everyone can wait here.`;
    $('regroupPanel').hidden=false;
    const el=document.createElement('div');el.className='regroup-pin';el.textContent=icon+' Regroup';
    regroupMarker=new maplibregl.Marker({element:el}).setLngLat([stop.lon,stop.lat]).addTo(map);
    regroupTarget={lat:stop.lat,lon:stop.lon,lagId:lag.c.id};
    regroupTimer=setTimeout(clearRegroup,600000);
    announce(`Regroup suggested at ${stop.name}`,[200,100,200]);
    showBanner(`<b>Suggested regroup: ${esc(stop.name)}</b>${leadKm.toFixed(1)} km ahead of the leader. Details are on the Map tab.`,'ok',9000);
  }catch(e){
    clearRegroup();showBanner('<b>Regroup suggestion failed</b>Could not look up nearby stops. Check your connection.','warn',5000);
  }finally{regroupBusy=false}
}
function checkRegroupArrival(){
  if(!regroupTarget)return;
  const car=lastCars.find(c=>c.id===regroupTarget.lagId);
  if(car&&Number.isFinite(Number(car.lon))&&navDistance([Number(car.lon),Number(car.lat)],[regroupTarget.lon,regroupTarget.lat])<400){
    clearRegroup();showBanner('<b>Convoy regrouped</b>The last car reached the regroup point.','ok',5000);
  }
}
$('regroupShow').onclick=()=>{showScreen('map');if(regroupTarget&&map)map.flyTo({center:[regroupTarget.lon,regroupTarget.lat],zoom:14,duration:700})};
$('regroupDismiss').onclick=clearRegroup;

const fmtMin=ms=>{const m=Math.round(Math.max(0,ms)/60000);return m<1?'<1 min':m+' min'};
function updateHaltButtons(){
  ['haltToggle','navHalt'].forEach(id=>{const b=$(id);if(!b)return;b.classList.toggle('halted',!!myHalt);b.textContent=myHalt?"▶ I'm moving again":(id==='navHalt'?'⏸ Stop':"⏸ I'm stopping")});
}
function renderHalts(){
  const ids=Object.keys(halts),list=$('haltList');list.replaceChildren();
  const longest=ids.reduce((m,id)=>Math.max(m,Date.now()-halts[id].at),0);
  $('haltPanel').hidden=!ids.length&&!haltTotalMs;
  $('haltSummary').textContent=`Convoy ETA delay so far: +${fmtMin(haltTotalMs+longest)}`;
  ids.forEach(id=>{
    const h=halts[id],row=document.createElement('div');row.className='halt-row';
    const left=document.createElement('span'),b=document.createElement('b');b.textContent=id===socket.id?'You':h.name;
    left.append(b,document.createTextNode(' stopped · '+fmtMin(Date.now()-h.at)));
    const tag=document.createElement('span');tag.className='status behind';tag.textContent='ETA +'+fmtMin(Date.now()-h.at);
    row.append(left,tag);list.appendChild(row);
  });
  Object.keys(markers).forEach(id=>markers[id].getElement().classList.toggle('halted',!!halts[id]));
}
function applyHalt(m){
  if(!m||!m.id)return;
  const mine=m.id===socket.id,who=mine?'You':esc(m.name||'A convoy member');
  if(m.state==='stopped'){
    if(halts[m.id])return;
    halts[m.id]={name:m.name||'Driver',at:Date.now()};if(mine)myHalt=halts[m.id];
    showBanner(`<b>${who} ${mine?'are':'is'} stopping</b>Convoy ETA delay is counting from now.`,'warn',8000);
    if(!mine)announce(`${m.name||'A driver'} is stopping`,[200]);
  }else if(m.state==='moving'){
    const h=halts[m.id];if(!h)return;
    const ms=Date.now()-h.at;haltTotalMs+=ms;delete halts[m.id];if(mine)myHalt=null;
    showBanner(`<b>${who} back on the road</b>Stopped ${fmtMin(ms)}. Convoy ETA +${fmtMin(ms)}.`,'ok',7000);
    if(!mine)announce(`${m.name||'A driver'} is moving again`,[120]);
  }
  updateHaltButtons();renderHalts();
}
function toggleHalt(){
  if(!session){showBanner('<b>No active trip</b>Create or join a convoy first.','warn',4500);return}
  const payload={state:myHalt?'moving':'stopped',at:Date.now(),lat:lastGps?.lat,lon:lastGps?.lon};
  let acked=false;
  socket.emit('halt',payload,res=>{acked=true;if(!res||!res.ok)showBanner('<b>Halt not shared</b>'+esc(res?.error||'The server rejected it.'),'warn',6000)});
  setTimeout(()=>{if(!acked)showBanner('<b>Others may not see this</b>The server has no halt handler yet. Add it to index.js.','warn',7000)},2500);
  applyHalt({id:socket.id,name:session.name,...payload});
}
socket.on('halt',applyHalt);
$('haltToggle').onclick=toggleHalt;$('navHalt').onclick=toggleHalt;
setInterval(()=>{if(Object.keys(halts).length)renderHalts()},15000);

// ===== NEW: real trip summary (separations, arrivals, stops) =====
let summaryTimer=null;
function mk(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
const fmtDur=ms=>{const s=Math.max(0,Math.round(ms/1000));if(s<60)return s+' s';const m=Math.floor(s/60);if(m<60)return m+' min';return Math.floor(m/60)+' h '+(m%60)+' min'};
const fmtClock=t=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
function focusOn(lat,lon){showScreen('map');if(map)setTimeout(()=>map.flyTo({center:[lon,lat],zoom:14,duration:700}),120)}
function reportRow(title,detail,tagText,tagClass,action){
  const row=mk('div','row'),left=mk('div'),right=mk('div');
  left.append(mk('b','',title),document.createElement('br'),mk('small','',detail));
  right.append(mk('span','status '+tagClass,tagText));
  if(action){const b=mk('button','secondary',action.label);b.style.cssText='display:block;margin:8px 0 0 auto;padding:7px 9px;font-size:11px';b.onclick=action.run;right.append(b)}
  row.append(left,right);return row;
}
function renderSummary(s){
  if(!s||typeof s!=='object')return;
  lastSummary=s;
  const totals=s.totals||{};
  $('repSepCount').textContent=totals.separations||0;
  $('repLongest').textContent=totals.longestMs?fmtDur(totals.longestMs):'—';
  $('repStopped').textContent=totals.haltMs?fmtDur(totals.haltMs):'—';

  const sepList=$('sepList');sepList.replaceChildren();
  const seps=(Array.isArray(s.separations)?s.separations:[]).slice().reverse();
  if(!seps.length)sepList.append(mk('p','subtitle','No one has gotten separated yet.'));
  seps.forEach(e=>{
    const ongoing=!e.endedAt;
    let detail=`${fmtClock(e.startedAt)} · km ${e.atKm} of ${s.totalKm} · ${ongoing?'separated for ':'lasted '}${fmtDur(e.durationMs)}`;
    if(e.type==='behind'&&e.maxGapKm)detail+=` · up to ${Number(e.maxGapKm).toFixed(1)} km behind`;
    if(!ongoing&&e.endReason==='disconnected')detail+=' · lost signal';
    else if(!ongoing&&e.type==='off-route'&&e.rejoinKm!=null)detail+=` · rejoined at km ${e.rejoinKm}`;
    const action=Number.isFinite(e.lat)&&Number.isFinite(e.lon)?{label:'Show on map',run:()=>focusOn(e.lat,e.lon)}:null;
    sepList.append(reportRow(`${e.name} · ${e.type==='off-route'?'Missed a turn':'Fell behind'}`,detail,ongoing?'Ongoing':'Resolved',ongoing?'off':'ok',action));
  });

  const arrList=$('arrivalList');arrList.replaceChildren();
  const members=Array.isArray(s.members)?s.members:[];
  const arrived=members.filter(m=>m.arrivedAt).sort((a,b)=>a.arrivedAt-b.arrivedAt),waiting=members.filter(m=>!m.arrivedAt);
  if(!members.length)arrList.append(mk('p','subtitle','Waiting for drivers…'));
  arrived.forEach((m,i)=>{
    const after=i===0?'First to arrive':'+'+fmtDur(m.arrivedAt-arrived[0].arrivedAt)+' after the first car';
    arrList.append(reportRow(`${i+1}. ${m.name}`,`Arrived ${fmtClock(m.arrivedAt)} · ${after}`,'Arrived','ok'));
  });
  waiting.forEach(m=>arrList.append(reportRow(m.name,m.online?'Still on the way':'Offline',m.online?'On the way':'Offline',m.online?'behind':'off')));

  const haltList=$('haltHistory');haltList.replaceChildren();
  const hs=(Array.isArray(s.halts)?s.halts:[]).slice().reverse();
  if(!hs.length)haltList.append(mk('p','subtitle','No stops announced yet.'));
  hs.forEach(h=>haltList.append(reportRow(h.name,`${fmtClock(h.startedAt)} · stopped for ${fmtDur(h.durationMs)}`,h.endedAt?'Done':'Stopped',h.endedAt?'ok':'behind')));
}
function requestSummary(){if(!session)return;socket.emit('get-summary',res=>{if(res&&res.ok)renderSummary(res.summary)})}
socket.on('summary',renderSummary);
function onSummaryScreen(active){clearInterval(summaryTimer);summaryTimer=null;if(active){requestSummary();summaryTimer=setInterval(requestSummary,10000)}}

// ===== NEW: spoken + haptic alerts =====
let alertsOn=true;
try{alertsOn=localStorage.getItem('oneroute-alerts')!=='off'}catch{}
function syncAlertsButton(){const b=$('alertsToggle');if(b){b.textContent=alertsOn?'🔊 Alerts: ON':'🔇 Alerts: OFF';b.classList.toggle('active',alertsOn)}}
function announce(text,pattern){
  if(!alertsOn)return;
  try{if(pattern&&navigator.vibrate)navigator.vibrate(pattern)}catch{}
  try{if('speechSynthesis' in window&&text){speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.lang=navigator.language||'en-IN';speechSynthesis.speak(u)}}catch{}
}
$('alertsToggle').onclick=()=>{alertsOn=!alertsOn;try{localStorage.setItem('oneroute-alerts',alertsOn?'on':'off')}catch{}syncAlertsButton();if(alertsOn)announce('Spoken alerts on',[80])};
syncAlertsButton();

// ===== NEW: spoken navigation =====
const speechOK='speechSynthesis' in window&&typeof SpeechSynthesisUtterance!=='undefined';
let navVoiceOn=true,speechUnlocked=false,navSpoken={key:'',done:new Set()};
let cloudVoice=false;const navPlayer=new Audio();navPlayer.preload='auto';
try{navVoiceOn=localStorage.getItem('oneroute-navvoice')!=='off'}catch{}
function syncNavVoiceButtons(){
  [['navVoiceToggle',navVoiceOn?'🧭 Voice guidance: ON':'🔇 Voice guidance: OFF'],['navVoiceToggle2',navVoiceOn?'🔊 Voice':'🔇 Voice']].forEach(([id,label])=>{
    const b=$(id);if(!b)return;b.textContent=label;b.classList.toggle('active',navVoiceOn);b.setAttribute('aria-pressed',String(navVoiceOn));
  });
}
// Browser voice (always available, used as the fallback)
function speakBrowser(text,interrupt=true,locale='en-IN'){
  if(!speechOK||!text)return;
  try{
    if(interrupt)speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(text);u.lang=locale;u.rate=0.95;
    u.onstart=()=>duckVoice(true);u.onend=u.onerror=()=>duckVoice(false);
    speechSynthesis.speak(u);
  }catch{}
}
// ElevenLabs voice: the server makes the audio (the key never reaches this page); every phrase is kept so repeats are instant
const ttsCache=new Map(),ttsPending=new Map();
function ttsFetch(text){
  if(ttsCache.has(text))return Promise.resolve(ttsCache.get(text));
  if(ttsPending.has(text))return ttsPending.get(text);
  const job=fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify({text})})
    .then(async r=>{
      if(!r.ok)throw new Error('voice '+r.status);
      const url=URL.createObjectURL(await r.blob());
      ttsCache.set(text,url);
      if(ttsCache.size>80){const oldest=ttsCache.keys().next().value;URL.revokeObjectURL(ttsCache.get(oldest));ttsCache.delete(oldest)}
      return url;
    })
    .finally(()=>ttsPending.delete(text));
  ttsPending.set(text,job);
  return job;
}
let navSpeakToken=0;
function speakCloud(text,interrupt){
  const token=++navSpeakToken;let done=false;
  if(interrupt){try{navPlayer.pause()}catch{}try{if(speechOK)speechSynthesis.cancel()}catch{}}
  // If the voice server is slow or fails, use the browser voice so the driver is never left in silence
  const fallback=()=>{if(done||token!==navSpeakToken)return;done=true;speakBrowser(text,false)};
  const timer=setTimeout(fallback,2500);
  ttsFetch(text).then(url=>{
    clearTimeout(timer);if(done||token!==navSpeakToken)return;done=true;
    navPlayer.src=url;navPlayer.onended=navPlayer.onerror=()=>duckVoice(false);
    duckVoice(true);
    const p=navPlayer.play();if(p&&p.catch)p.catch(()=>{duckVoice(false);speakBrowser(text,false)});
  }).catch(()=>{clearTimeout(timer);fallback()});
}
function speakNav(text,interrupt=true){
  if(!navVoiceOn||!text)return;
  // The cloud voice is English only; other languages use a voice installed on the device (speechLanguage() checks one exists).
  if(cloudVoice&&speechLanguage()==='en')speakCloud(text,interrupt);else speakBrowser(text,interrupt,speechLocale());
}
// Get the next turn's phrases ready ahead of time so the voice starts without a delay
function prefetchNavPrompts(step){
  if(!cloudVoice||!step||speechLanguage()!=='en')return;
  const m=step.maneuver||{},type=m.type||'continue';
  if(type==='depart'||((type==='continue'||type==='new name')&&(!m.modifier||m.modifier==='straight')))return;
  [spokenPrompt('m500',step,500),spokenPrompt('m200',step,200),spokenPrompt('now',step,0)].forEach(x=>ttsFetch(x).catch(()=>{}));
}
function loadVoiceInfo(){
  fetch('/api/voice-info',{headers:authHeaders(),cache:'no-store'}).then(r=>r.ok?r.json():{}).then(d=>{
    cloudVoice=!!d.cloudVoice;
    if(cloudVoice)['You have missed your turn. Finding a route to rejoin.','Spoken directions on.'].forEach(x=>ttsFetch(x).catch(()=>{}));
  }).catch(()=>{});
}
function setNavVoice(on){
  navVoiceOn=on;try{localStorage.setItem('oneroute-navvoice',on?'on':'off')}catch{}
  syncNavVoiceButtons();
  if(on)speakNav('Spoken directions on.');else{try{navPlayer.pause()}catch{}if(speechOK){try{speechSynthesis.cancel()}catch{}}}
}
['navVoiceToggle','navVoiceToggle2'].forEach(id=>{const b=$(id);if(b)b.onclick=()=>setNavVoice(!navVoiceOn)});
syncNavVoiceButtons();
const ORD=['','first','second','third','fourth','fifth','sixth','seventh','eighth'];
function navSpokenManeuver(step){return spokenAction(step,speechLanguage())}
// Speaks each prompt once per turn: far ("Continue straight for 2 kilometres"), 500 m, 200 m, and the turn itself.
function navVoiceStage(step,meters){
  if(!navVoiceOn||!step||!Number.isFinite(meters))return;
  const m=step.maneuver||{},type=m.type||'continue';
  if(type==='depart')return;
  const key=[(m.location||[])[0],(m.location||[])[1],type,m.modifier].join('|');
  if(navSpoken.key!==key){navSpoken={key,done:new Set()};prefetchNavPrompts(step)}
  const trivial=(type==='continue'||type==='new name')&&(!m.modifier||m.modifier==='straight');
  const stage=meters<=90?'now':meters<=230?'m200':meters<=550?'m500':meters>=900?'far':null;
  if(!stage||navSpoken.done.has(stage))return;
  const order=['far','m500','m200','now'];
  order.slice(0,order.indexOf(stage)+1).forEach(s=>navSpoken.done.add(s));
  if(trivial&&stage!=='far')return;
  speakNav(spokenPrompt(stage,step,meters));
}
function navMissedTurn(){
  speakNav(spokenMissedTurn());
  navLastRouteAt=0;if(navOpen||navDriving||navTrip)navFetchDirections();
}
const agoText=sec=>{const m=Math.floor(sec/60);return m<1?'just now':m<60?m+' min ago':Math.floor(m/60)+' h '+(m%60)+' min ago'};
function skeletonBlock(n=3,cls=''){const f=document.createDocumentFragment();for(let i=0;i<n;i++)f.append(mk('div','skeleton '+cls));return f}

// ===== NEW: SOS / breakdown =====
const sosActive={},sosMarkers={};
const mySos=()=>!!sosActive[socket.id];
function renderSos(){
  setTimeout(()=>{try{publishState()}catch{}},50);
  const ids=Object.keys(sosActive),list=$('sosList');list.replaceChildren();$('sosPanel').hidden=!ids.length;
  ids.forEach(id=>{
    const s=sosActive[id],mine=id===socket.id,hasPos=Number.isFinite(s.lat)&&Number.isFinite(s.lon);
    const row=reportRow(`${mine?'You':s.name} · needs help`,`Sent ${fmtClock(s.at)}${hasPos?'':' · location unavailable'}`,'SOS','off',hasPos?{label:'Show on map',run:()=>focusOn(s.lat,s.lon)}:null);
    if(mine){const b=mk('button','secondary','Cancel my SOS');b.style.cssText='display:block;margin:8px 0 0 auto;padding:7px 9px;font-size:11px';b.onclick=()=>sendSos('cleared');row.lastChild.append(b)}
    list.append(row);
  });
  Object.keys(sosMarkers).forEach(id=>{if(!sosActive[id]){sosMarkers[id].remove();delete sosMarkers[id]}});
  if(map)ids.forEach(id=>{
    const s=sosActive[id];if(!Number.isFinite(s.lat)||!Number.isFinite(s.lon))return;
    if(!sosMarkers[id])sosMarkers[id]=new maplibregl.Marker({element:mk('div','sos-pin','🆘 '+s.name)}).setLngLat([s.lon,s.lat]).addTo(map);
  });
  ['sosButton','navSos'].forEach(id=>{const b=$(id);if(b)b.classList.toggle('sos-on',mySos())});
}
function sendSos(state,skipConfirm){
  if(!session){showBanner('<b>No active trip</b>Create or join a convoy first.','warn',4500);return}
  if(state==='active'&&!skipConfirm&&!confirm('Send an SOS with your location to everyone in the convoy?'))return;
  socket.emit('sos',{state,lat:lastGps?.lat,lon:lastGps?.lon},res=>{if(!res||!res.ok)showBanner('<b>SOS not sent</b>'+esc(res?.error||'Try again.'),'warn',8000)});
}
const toggleSos=()=>sendSos(mySos()?'cleared':'active');
$('sosButton').onclick=toggleSos;$('navSos').onclick=toggleSos;
socket.on('sos',m=>{
  if(!m||!m.id)return;
  const mine=m.id===socket.id,who=mine?'You':esc(m.name||'A driver');
  if(m.state==='active'){
    sosActive[m.id]={name:m.name||'Driver',lat:m.lat==null?NaN:Number(m.lat),lon:m.lon==null?NaN:Number(m.lon),at:m.at||Date.now()};
    showBanner(mine?'<b>SOS sent</b>Your position was shared with the convoy.':`<b>🆘 ${who} needs help</b>Open the Map tab to see where.`,'',15000);
    if(!mine)announce(`S O S. ${m.name||'A driver'} needs help.`,[600,150,600,150,600]);
    openHelp(m.id);
  }else{
    if(!sosActive[m.id])return;
    delete sosActive[m.id];delete helpData[m.id];if(helpShownId===m.id)closeHelp();
    showBanner(`<b>SOS cleared</b>${who} ${mine?'cancelled the':'is no longer asking for help.'}${mine?' SOS.':''}`,'ok',5000);
  }
  renderSos();updateHelpButton();
});
socket.on('sos-help',m=>{if(!m||!m.id)return;helpData[m.id]={help:m.help};if(helpShownId===m.id)renderHelp()});

// ===== NEW: quick replies =====
const QUICK=[['Need a break','☕'],['Fuel low','⛽'],['Slow down','🐢'],['On my way','🚗'],['Need to stop soon','🛑'],['All good','👍']];
const quickLog=[];
function renderQuickLog(){
  const box=$('quickLog');box.replaceChildren();
  if(!quickLog.length){box.append(mk('p','subtitle','No messages yet.'));return}
  quickLog.slice().reverse().slice(0,20).forEach(m=>{
    const emoji=(QUICK.find(q=>q[0]===m.text)||[])[1]||'';
    const row=mk('div','row'),left=mk('div');
    left.append(mk('b','',m.memberId===socket.id?'You':m.name),document.createElement('br'),mk('small','',`${emoji} ${m.text}`.trim()));
    row.append(left,mk('small','',fmtClock(m.at)));box.append(row);
  });
}
function sendQuick(text){
  if(!session){showBanner('<b>No active trip</b>Create or join a convoy first.','warn',4500);return}
  socket.emit('quick-message',{text},res=>{
    if(res&&res.ok)showBanner('<b>Sent</b>'+esc(text),'ok',2000);
    else showBanner('<b>Not sent</b>'+esc(res?.error||'Try again.'),'warn',3500);
  });
}
QUICK.forEach(([text,emoji])=>{const b=mk('button','',`${emoji} ${text}`);b.onclick=()=>sendQuick(text);$('quickGrid').append(b)});
socket.on('quick-message',m=>{
  if(!m)return;
  quickLog.push(m);if(quickLog.length>30)quickLog.shift();renderQuickLog();
  if(m.memberId!==socket.id){showBanner(`<b>${esc(m.name)}</b>${esc(m.text)}`,'warn',6000);announce(`${m.name}: ${m.text}`,[150,80,150])}
});
socket.on('quick-history',list=>{quickLog.length=0;(Array.isArray(list)?list:[]).forEach(m=>quickLog.push(m));renderQuickLog()});

// ===== NEW: read-only live link =====
$('shareLive').onclick=async()=>{
  const token=pendingTrip?.viewToken;
  if(!token){showBanner('<b>Live link unavailable</b>Update the server to the latest index.js first.','warn',5000);return}
  const url=location.origin+'/live/'+token,text='Follow our convoy live (read-only): '+url;
  try{
    if(navigator.share)await navigator.share({title:'ONEROUTE live view',text,url});
    else{await navigator.clipboard.writeText(url);showBanner('<b>Live link copied</b>Anyone with it can watch the convoy.','ok',5000)}
  }catch(e){if(e.name!=='AbortError')window.prompt('Copy live link',url)}
};

// ===== NEW: voice waveform =====
let waveCtx=null,waveRaf=0;
function startWave(stream){
  try{
    const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;
    waveCtx=new AC();const analyser=waveCtx.createAnalyser();analyser.fftSize=64;
    waveCtx.createMediaStreamSource(stream).connect(analyser);
    const data=new Uint8Array(analyser.frequencyBinCount),canvases=['mapWave','chatWave'].map($).filter(Boolean);
    canvases.forEach(c=>c.classList.add('live'));
    const draw=()=>{
      analyser.getByteFrequencyData(data);
      canvases.forEach(c=>{const g=c.getContext('2d'),bars=24,w=c.width/bars;g.clearRect(0,0,c.width,c.height);
        for(let i=0;i<bars;i++){const v=data[Math.floor(i*data.length/bars)]/255,h=Math.max(3,v*c.height);g.fillStyle='#f4c430';g.fillRect(i*w+2,(c.height-h)/2,w-4,h)}});
      waveRaf=requestAnimationFrame(draw);
    };
    draw();
  }catch{}
}
function stopWave(){
  cancelAnimationFrame(waveRaf);
  if(waveCtx){waveCtx.close().catch(()=>{});waveCtx=null}
  ['mapWave','chatWave'].forEach(id=>{const c=$(id);if(c){c.getContext('2d').clearRect(0,0,c.width,c.height);c.classList.remove('live')}});
}

// ===== NEW: arrival confetti =====
const confetti={parts:[],raf:0};
function burstConfetti(n=120){
  if(REDUCED)return;
  const c=$('confetti');if(!c)return;c.width=innerWidth;c.height=innerHeight;const g=c.getContext('2d');
  const colors=['#f4c430','#42c786','#6aa8ff','#f05b57','#f5f3eb'];
  for(let i=0;i<n;i++)confetti.parts.push({x:innerWidth/2+(Math.random()-.5)*innerWidth*.4,y:innerHeight*.35,vx:(Math.random()-.5)*10,vy:-Math.random()*11-3,s:5+Math.random()*6,r:Math.random()*6,vr:(Math.random()-.5)*.4,c:colors[i%colors.length],life:0});
  if(confetti.raf)return;
  const step=()=>{
    g.clearRect(0,0,c.width,c.height);
    confetti.parts=confetti.parts.filter(p=>p.life<220&&p.y<c.height+20);
    confetti.parts.forEach(p=>{p.life++;p.vy+=.28;p.x+=p.vx;p.y+=p.vy;p.vx*=.99;p.r+=p.vr;g.save();g.translate(p.x,p.y);g.rotate(p.r);g.fillStyle=p.c;g.globalAlpha=Math.max(0,1-p.life/220);g.fillRect(-p.s/2,-p.s/3,p.s,p.s*.6);g.restore()});
    if(confetti.parts.length)confetti.raf=requestAnimationFrame(step);else{confetti.raf=0;g.clearRect(0,0,c.width,c.height)}
  };
  confetti.raf=requestAnimationFrame(step);
}
let myArrivedShown=false,allArrivedShown=false;
function checkArrivals(cars){
  const me=cars.find(c=>c.id===socket.id),all=cars.length>1&&cars.every(c=>c.status==='arrived');
  if(me&&me.status==='arrived'&&!myArrivedShown){myArrivedShown=true;burstConfetti(100);announce('You have arrived',[200,100,200]);showBanner('<b>You have arrived 🏁</b>Nice driving.','ok',6000)}
  if(me&&me.status!=='arrived')myArrivedShown=false;
  if(all&&!allArrivedShown){allArrivedShown=true;burstConfetti(220);announce('Everyone has arrived',[300,150,300]);showBanner('<b>Everyone has arrived 🎉</b>The whole convoy made it.','ok',9000)}
  if(!all)allArrivedShown=false;
}

// ===== NEW: export trip report (image or PDF) =====
let lastSummary=null;
function buildReportCanvas(){
  const s=lastSummary;if(!s)return null;
  const W=1000,pad=40,lines=[];
  const add=(t,o={})=>lines.push({t:String(t),size:o.size||20,color:o.color||'#f5f3eb',bold:!!o.bold,gap:o.gap??8});
  const addWrapped=(t,o={},max=88)=>{const words=String(t).split(' ');let line='';words.forEach(w=>{if((line+' '+w).trim().length>max){add(line,{...o,gap:2});line=w}else line=(line+' '+w).trim()});if(line)add(line,o)};
  const t=s.totals||{};
  add('ONEROUTE · Trip report',{size:34,color:'#f4c430',bold:true,gap:12});
  add('Destination: '+(pendingTrip?.destination?.label||'Destination'),{size:22,bold:true});
  add('Generated '+new Date().toLocaleString()+' · '+s.totalKm+' km route',{size:16,color:'#9ca3af',gap:22});
  add(`Separations: ${t.separations||0}    Longest: ${t.longestMs?fmtDur(t.longestMs):'-'}    Time stopped: ${t.haltMs?fmtDur(t.haltMs):'-'}`,{size:20,bold:true,gap:24});
  add('Who got separated',{size:24,color:'#f4c430',bold:true,gap:10});
  const seps=s.separations||[];
  if(!seps.length)add('No one got separated.',{color:'#9ca3af',gap:18});
  seps.forEach(e=>{
    add(`${e.name} · ${e.type==='off-route'?'Missed a turn':'Fell behind'}${e.endedAt?'':' (ongoing)'}`,{bold:true,gap:3});
    let d=`${fmtClock(e.startedAt)} · km ${e.atKm} of ${s.totalKm} · ${fmtDur(e.durationMs)}`;
    if(e.type==='behind'&&e.maxGapKm)d+=` · up to ${Number(e.maxGapKm).toFixed(1)} km behind`;
    if(e.endReason==='disconnected')d+=' · lost signal';else if(e.type==='off-route'&&e.rejoinKm!=null)d+=` · rejoined at km ${e.rejoinKm}`;
    addWrapped(d,{size:16,color:'#b8c0cc',gap:14});
  });
  add('Arrivals',{size:24,color:'#f4c430',bold:true,gap:10});
  const members=s.members||[],arrived=members.filter(m=>m.arrivedAt).sort((a,b)=>a.arrivedAt-b.arrivedAt);
  arrived.forEach((m,i)=>add(`${i+1}. ${m.name} · ${fmtClock(m.arrivedAt)}${i?' · +'+fmtDur(m.arrivedAt-arrived[0].arrivedAt):' · first to arrive'}`,{gap:6}));
  members.filter(m=>!m.arrivedAt).forEach(m=>add(`${m.name} · ${m.online?'still on the way':'offline'}`,{color:'#9ca3af',gap:6}));
  if(!members.length)add('No drivers recorded.',{color:'#9ca3af'});
  add('Stops',{size:24,color:'#f4c430',bold:true,gap:10});
  const hs=s.halts||[];
  if(!hs.length)add('No stops announced.',{color:'#9ca3af'});
  hs.forEach(h=>add(`${h.name} · ${fmtClock(h.startedAt)} · ${fmtDur(h.durationMs)}`,{gap:6}));
  let height=pad*2;lines.forEach(l=>height+=l.size*1.35+l.gap);
  const c=document.createElement('canvas');c.width=W;c.height=Math.ceil(height);
  const g=c.getContext('2d');g.fillStyle='#17191d';g.fillRect(0,0,W,c.height);
  let y=pad;
  lines.forEach(l=>{y+=l.size;g.font=`${l.bold?'700 ':''}${l.size}px system-ui,sans-serif`;g.fillStyle=l.color;g.fillText(l.t,pad,y,W-pad*2);y+=l.size*.35+l.gap});
  return c;
}
function withFreshSummary(done){
  if(!session){done();return}
  let finished=false;const finish=()=>{if(!finished){finished=true;done()}};
  setTimeout(finish,3000);
  socket.emit('get-summary',res=>{if(res&&res.ok)renderSummary(res.summary);finish()});
}
$('reportPng').onclick=()=>withFreshSummary(()=>{
  const c=buildReportCanvas();
  if(!c){showBanner('<b>No report yet</b>Join a trip and wait for the first update.','warn',4000);return}
  c.toBlob(blob=>{
    if(!blob)return;
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='oneroute-trip-report.png';
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),3000);
  });
});
$('reportPdf').onclick=()=>withFreshSummary(()=>{
  const old=document.title;document.title='ONEROUTE trip report';
  window.print();setTimeout(()=>{document.title=old},1500);
});

// Voice messages: short audio recordings are relayed by the server to this trip.
let voiceRecorder=null,voiceStream=null,voiceChunks=[],voiceRecording=false,voiceTimer=null,voiceClockInterval=null,voiceStartedAt=0;
const MAX_VOICE_MS=30000, MAX_AUDIO_BYTES=700000;
function setVoiceStatus(message){
  ['mapTalkStatus','chatTalkStatus'].forEach(id=>{const el=$(id);if(!el)return;el.className='voice-status';const text=String(message||'');if(/recording/i.test(text))el.classList.add('recording');else if(/sending|prepar/i.test(text))el.classList.add('sending');else if(/sent/i.test(text))el.classList.add('success');el.replaceChildren();const dot=document.createElement('span');dot.className='status-dot';const label=document.createElement('span');label.textContent=text||'Ready when you are';el.append(dot,label)});
}
function updateVoiceClock(){const elapsed=Math.min(MAX_VOICE_MS,Math.max(0,Date.now()-voiceStartedAt));const value=Math.floor(elapsed/1000);const formatted='00:'+String(value).padStart(2,'0');['mapTalkTimer','chatTalkTimer'].forEach(id=>{const el=$(id);if(el)el.textContent=formatted})}
function setVoiceButtons(recording){
  voiceRecording=recording;
  ['mapTalkButton','chatTalkButton'].forEach(id=>{const b=$(id);if(!b)return;b.classList.toggle('recording',recording);b.setAttribute('aria-pressed',String(recording));b.innerHTML=recording?'<span class="voice-button-icon">■</span><span>Release to send</span>':'<span class="voice-button-icon">🎙</span><span>Hold to talk</span>'});
  ['mapVoiceConsole','chatVoiceConsole'].forEach(id=>{const el=$(id);if(el)el.classList.toggle('recording',recording)});
  document.querySelectorAll('.voice-live-dot').forEach(el=>el.classList.toggle('recording',recording));
  if(recording){voiceStartedAt=Date.now();updateVoiceClock();clearInterval(voiceClockInterval);voiceClockInterval=setInterval(updateVoiceClock,200)}else{clearInterval(voiceClockInterval);voiceClockInterval=null}
}
function renderVoiceMessage(message){
  if(!message||!message.audio||!message.mimeType)return;
  const list=$('voiceMessages');if(!list)return;
  const card=document.createElement('div');card.className='card';
  const heading=document.createElement('h2');heading.textContent=(message.name||'Convoy member')+' · Voice message';
  const meta=document.createElement('p');meta.className='subtitle';meta.textContent=message.timestamp?new Date(message.timestamp).toLocaleString():'Just now';
  const audio=document.createElement('audio');audio.controls=true;audio.preload='metadata';audio.style.width='100%';audio.src='data:'+message.mimeType+';base64,'+message.audio;
  card.append(heading,meta,audio);list.prepend(card);
  while(list.children.length>50)list.lastElementChild.remove();
}
socket.on('voice-history',messages=>{const list=$('voiceMessages');if(!list)return;list.replaceChildren();if(Array.isArray(messages))messages.forEach(renderVoiceMessage)});
socket.on('voice-message',message=>renderVoiceMessage(message));
socket.on('voice-error',message=>setVoiceStatus(String(message||'Voice message could not be sent.')));
async function startVoiceRecording(){
  if(!session){setVoiceStatus('Create or join a trip before recording.');return}
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){setVoiceStatus('Voice recording is not supported in this browser. Use HTTPS or localhost.');return}
  try{
    voiceStream=await navigator.mediaDevices.getUserMedia({audio:true});voiceChunks=[];
    const mimeCandidates=['audio/mp4;codecs=mp4a.40.2','audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'];
    const mimeType=mimeCandidates.find(type=>MediaRecorder.isTypeSupported(type));
    voiceRecorder=new MediaRecorder(voiceStream,mimeType?{mimeType,audioBitsPerSecond:32000}:{audioBitsPerSecond:32000});
    voiceRecorder.ondataavailable=event=>{if(event.data&&event.data.size)voiceChunks.push(event.data)};
    voiceRecorder.onerror=()=>setVoiceStatus('Recording failed. Please try again.');
    voiceRecorder.onstop=async()=>{
      clearTimeout(voiceTimer);voiceTimer=null;clearInterval(voiceClockInterval);voiceClockInterval=null;
      const recorder=voiceRecorder;voiceRecorder=null;
      if(voiceStream){voiceStream.getTracks().forEach(track=>track.stop());voiceStream=null}
      setVoiceButtons(false);stopWave();setTimeout(playNextVoice,400);
      try{
        const blob=new Blob(voiceChunks,{type:recorder?.mimeType||'audio/webm'});voiceChunks=[];
        if(!blob.size){setVoiceStatus('No audio captured. Try again.');return}
        if(blob.size>MAX_AUDIO_BYTES){setVoiceStatus('Recording is too large. Please record a shorter message.');return}
        setVoiceStatus('Sending voice message…');
        const reader=new FileReader();reader.onload=()=>{
          const dataUrl=String(reader.result||'');const comma=dataUrl.indexOf(',');
          if(comma<0){setVoiceStatus('Could not prepare the recording.');return}
          lastSentAudio=dataUrl.slice(comma+1);
          socket.emit('voice-message',{audio:dataUrl.slice(comma+1),mimeType:blob.type||'audio/webm'},result=>{
            if(result&&result.ok)setVoiceStatus('Voice message sent.');else setVoiceStatus(result?.error||'Could not send voice message.');
          });
        };reader.onerror=()=>setVoiceStatus('Could not read the recording.');reader.readAsDataURL(blob);
      }catch(error){setVoiceStatus('Could not send the recording. Please try again.')}
    };
    if(voiceCurrent){voicePlayer.onended=voicePlayer.onerror=null;try{voicePlayer.pause()}catch{}voiceQueue.unshift(voiceCurrent);voiceCurrent=null;voicePlaying=false}$('voiceToast').hidden=true;
    startWave(voiceStream);voiceRecorder.start();voiceRecording=true;setVoiceButtons(true);setVoiceStatus('Recording… release to send (or tap the mic again).');
    voiceTimer=setTimeout(()=>stopVoiceRecording(),MAX_VOICE_MS);
  }catch(error){if(voiceStream){voiceStream.getTracks().forEach(track=>track.stop());voiceStream=null}setVoiceStatus(error?.name==='NotAllowedError'?'Microphone permission denied. Allow microphone access and try again.':'Could not access the microphone. Check browser permissions and HTTPS.');}
}
function stopVoiceRecording(){if(voiceRecorder&&voiceRecorder.state!=='inactive'){clearTimeout(voiceTimer);voiceTimer=null;voiceRecorder.stop();voiceRecording=false}}
function toggleVoiceRecording(){if(voiceRecorder&&voiceRecorder.state==='recording')stopVoiceRecording();else startVoiceRecording()}
// ===== NEW: press-and-hold to talk. Hold + release sends; a quick tap still starts, and the next tap stops and sends. =====
const HOLD_MS=350;
['mapTalkButton','chatTalkButton'].forEach(id=>{
  const button=$(id);if(!button)return;
  let downAt=0,pressActive=false,ignoreUp=false,starting=false,releasedEarly=false;
  button.addEventListener('contextmenu',e=>e.preventDefault());
  button.addEventListener('pointerdown',async e=>{
    if(e.button!==undefined&&e.button!==0)return;
    e.preventDefault();
    try{button.setPointerCapture(e.pointerId)}catch{}
    unlockMedia();
    pressActive=true;downAt=Date.now();releasedEarly=false;ignoreUp=false;
    if(voiceRecorder&&voiceRecorder.state==='recording'){ignoreUp=true;stopVoiceRecording();return}
    starting=true;
    await startVoiceRecording();
    starting=false;
    // Released while the mic was still starting: stop now, unless a permission prompt delayed it (then stay in tap mode).
    if(releasedEarly&&Date.now()-downAt<1500)stopVoiceRecording();
  });
  const release=()=>{
    if(!pressActive)return;pressActive=false;
    if(ignoreUp){ignoreUp=false;return}
    if(Date.now()-downAt>=HOLD_MS){if(starting)releasedEarly=true;else stopVoiceRecording()}
    else if(voiceRecording||starting)setVoiceStatus('Recording… tap the mic again to stop and send.');
  };
  button.addEventListener('pointerup',release);
  button.addEventListener('pointercancel',release);
  // Keyboard (Enter/Space) still toggles; pointer-generated clicks are ignored because pointer events handle them.
  button.addEventListener('click',e=>{if(e.detail===0)toggleVoiceRecording()});
});

// ===== NEW: auto-play incoming voice messages (one shared player so one tap unlocks it) =====
const voicePlayer=new Audio();voicePlayer.preload='auto';
let navUnlocked=false;
let voiceQueue=[],voiceCurrent=null,voicePlaying=false,voiceWatchdog=null,lastSentAudio='',voiceUnlocked=false,voiceToastTimer=null;
const SAFE_AUDIO=/^audio\/[a-z0-9.+-]+(;\s*codecs=[a-z0-9.,"' -]+)?$/i;
const SILENT_WAV='data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
function unlockMedia(){
  if(!voiceUnlocked){
    voiceUnlocked=true;
    try{
      voicePlayer.muted=true;voicePlayer.src=SILENT_WAV;
      const restore=()=>{if(voicePlayer.src===SILENT_WAV)voicePlayer.pause();voicePlayer.muted=false};
      const p=voicePlayer.play();
      if(p&&p.then)p.then(restore).catch(()=>{voicePlayer.muted=false;voiceUnlocked=false});else restore();
    }catch{voicePlayer.muted=false}
  }
  if(!navUnlocked){
    navUnlocked=true;
    try{navPlayer.muted=true;navPlayer.src=SILENT_WAV;const q=navPlayer.play();const done=()=>{if(navPlayer.src===SILENT_WAV)navPlayer.pause();navPlayer.muted=false};if(q&&q.then)q.then(done).catch(()=>{navPlayer.muted=false;navUnlocked=false});else done()}catch{navPlayer.muted=false}
  }
  if(!speechUnlocked&&speechOK){speechUnlocked=true;try{const u=new SpeechSynthesisUtterance(' ');u.volume=0;speechSynthesis.speak(u)}catch{}}
}
['pointerdown','touchend','keydown'].forEach(ev=>document.addEventListener(ev,unlockMedia,{passive:true}));
function duckVoice(on){try{voicePlayer.volume=on?0.2:1}catch{}}
function voiceToast(html,sticky){
  const t=$('voiceToast');t.innerHTML=html;t.hidden=false;clearTimeout(voiceToastTimer);
  if(!sticky)voiceToastTimer=setTimeout(()=>{t.hidden=true},3500);
}
function playNextVoice(){
  if(voicePlaying||voiceRecording||!voiceQueue.length)return;
  const m=voiceQueue.shift();voiceCurrent=m;voicePlaying=true;
  const finish=(failed)=>{
    clearTimeout(voiceWatchdog);
    voicePlayer.onended=voicePlayer.onerror=null;voiceCurrent=null;voicePlaying=false;
    if(failed===true)voiceToast('<b>🎙 '+esc(m.name||'Convoy member')+'</b><span>Voice message arrived but this phone could not play it. Open the Chat tab to try.</span>');
    else if(voiceQueue.length)playNextVoice();else voiceToast('<b>🎙 '+esc(m.name||'Convoy member')+'</b><span>Voice message finished</span>');
    if(failed===true&&voiceQueue.length)setTimeout(playNextVoice,1500);
  };
  const baseType=String(m.mimeType).split(';')[0].trim().toLowerCase();
  if(typeof voicePlayer.canPlayType==='function'&&!voicePlayer.canPlayType(baseType)){finish(true);return}
  voicePlayer.muted=false;voicePlayer.volume=1;
  voicePlayer.src='data:'+m.mimeType+';base64,'+m.audio;
  voicePlayer.onended=()=>finish();voicePlayer.onerror=()=>finish(true);
  clearTimeout(voiceWatchdog);voiceWatchdog=setTimeout(()=>finish(),45000);
  voiceToast('<b>🎙 '+esc(m.name||'Convoy member')+'</b><span>Voice message playing…</span>',true);
  const p=voicePlayer.play();
  if(p&&p.catch)p.catch(err=>{
    voicePlayer.onended=voicePlayer.onerror=null;voiceCurrent=null;voicePlaying=false;
    if(err&&err.name==='AbortError'&&!m.retried){m.retried=true;voiceQueue.unshift(m);setTimeout(playNextVoice,300);return}
    voiceQueue.unshift(m);
    voiceToast('<button id="voiceTapPlay">▶ Tap to hear '+esc(m.name||'voice message')+'</button>',true);
    $('voiceTapPlay').onclick=()=>{$('voiceToast').hidden=true;playNextVoice()};
  });
}
// Live messages only (history replays on join are never auto-played). Own message echoed back is skipped.
socket.on('voice-message',m=>{
  if(!m||typeof m.audio!=='string'||!m.audio||!SAFE_AUDIO.test(String(m.mimeType||'')))return;
  if(m.audio===lastSentAudio||(m.id&&m.id===socket.id))return;
  voiceQueue.push({name:m.name,audio:m.audio,mimeType:m.mimeType});
  while(voiceQueue.length>5)voiceQueue.shift();
  playNextVoice();
});

const name=()=>$('name').value.trim()||'Driver';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let noticeTimer=null;
function showNotice(text,kind){
  const n=$('notice');n.textContent=text;n.className=kind==='ok'?'ok':'';n.hidden=false;
  clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{n.hidden=true},kind==='ok'?2800:7000);
}
// Messages pop up at the top of the screen, so nobody has to scroll down to find them
function setMsg(s){$('msg').textContent=s||'';if(s)showNotice(s)}
function showBanner(html,kind='',ms=7000){
  $('banner').innerHTML=html;$('banner').className=kind;$('banner').style.display='block';clearTimeout(bannerTimer);
  if(ms)bannerTimer=setTimeout(()=>{$('banner').style.display='none';if(rejoinMarker){rejoinMarker.remove();rejoinMarker=null}},ms);
}
function geoError(e){
  if(!window.isSecureContext&&location.hostname!=='localhost')return 'Location requires HTTPS. Open your secure tunnel link.';
  if(e.code===1)return 'Location permission denied. Allow location in browser settings.';
  if(e.code===2)return 'Could not get GPS. Try outside with GPS enabled.';
  return 'Location timed out. Please try again.';
}
// ===== NEW: thinking orb while the app is working (page keeps working if /orb.js is missing) =====
const orbReduced=()=>!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
function orbMount(el,state,label){try{return window.OneRouteOrb?OneRouteOrb.mount(el,{state,size:64,paused:orbReduced(),label}):null}catch{return null}}
let busyFinish=null;
function busyStart(label,state,hint,onTimeout){
  if(busyFinish)busyFinish(); // a previous loading screen that is still fading out
  const box=$('busy'),orbEl=box.querySelector('.busy-orb'),started=Date.now();
  $('busyLabel').textContent=label;$('busyHint').textContent=hint||'';box.hidden=false;
  const orb=orbMount(orbEl,state,label);
  let done=false;
  const finish=()=>{box.hidden=true;if(orb)orb.unmount();orbEl.replaceChildren();if(busyFinish===finish)busyFinish=null};
  const job={
    label(text,nextState){$('busyLabel').textContent=text;if(orb)orb.update({state:nextState||state,label:text})},
    // Even a very fast step keeps the orb up for about a second, so people can see something happened
    stop(){
      if(done)return;done=true;clearTimeout(timer);
      const rest=Math.max(0,1000-(Date.now()-started));
      if(rest>0){busyFinish=finish;setTimeout(()=>{if(busyFinish===finish)finish()},rest)}else finish();
    },
  };
  const timer=setTimeout(()=>{if(done)return;job.stop();(onTimeout||(()=>setMsg('This is taking longer than expected. Check your connection and try again.')))()},40000);
  return job;
}
// Orb on the map while it waits for the first GPS fix
let mapWaitOrb=null,mapWaitTimers=[],mapWaitSince=0;
function mapWaitShow(){
  const box=$('mapWait');if(!box||mapWaitOrb)return;
  mapWaitSince=Date.now();box.hidden=false;$('mapWaitText').textContent='Finding your location…';
  mapWaitOrb=orbMount($('mapWaitOrb'),'searching','Finding your location');
  mapWaitTimers=[setTimeout(()=>{$('mapWaitText').textContent='Still looking for GPS. Make sure location is allowed for this site.'},20000),setTimeout(mapWaitHide,60000)];
}
function mapWaitHide(){
  mapWaitTimers.forEach(clearTimeout);mapWaitTimers=[];
  const box=$('mapWait');if(box)box.hidden=true;
  if(mapWaitOrb){mapWaitOrb.unmount();mapWaitOrb=null}
  const o=$('mapWaitOrb');if(o)o.replaceChildren();
}
function mapWaitDone(){
  if(!mapWaitOrb)return;
  const rest=Math.max(0,1500-(Date.now()-mapWaitSince));
  if(rest>0)setTimeout(mapWaitHide,rest);else mapWaitHide();
}
function orbRow(host,label,state){
  const row=document.createElement('div');row.className='orb-row';
  const orbEl=document.createElement('div');orbEl.className='busy-orb';
  const text=document.createElement('span');text.textContent=label;
  row.append(orbEl,text);host.replaceChildren(row);
  const orb=orbMount(orbEl,state,label);
  return{stop(){if(orb)orb.unmount();row.remove()}};
}
$('search').onclick=async()=>{
  const q=$('dest').value.trim();if(!q)return setMsg('Enter a destination.');
  setMsg('');const searchOrb=orbRow($('results'),'Searching places…','searching');chosen=null;$('chosenDest').hidden=true;
  try{
    const r=await fetch('/geocode?q='+encodeURIComponent(q),{headers:authHeaders()});if(!r.ok)throw Error();
    const list=await r.json();searchOrb.stop();$('results').replaceChildren();if(!list.length)setMsg('No places found. Try a more specific name.');else setMsg('');
    if(list.some(p=>p.approx)){const h=document.createElement('div');h.className='dym';h.textContent=i18n.t('search.didYouMean');$('results').appendChild(h)}
    list.forEach(place=>{
      const b=document.createElement('button');b.textContent=place.label;
      b.onclick=()=>{chosen=place;[...$('results').children].forEach(x=>x.classList.remove('selected'));b.classList.add('selected');$('chosenDest').hidden=false;$('chosenDest').textContent='✓ Going to: '+place.label;showNotice('Destination selected. Now press Create trip.','ok')};
      $('results').appendChild(b);
    });
  }catch{searchOrb.stop();$('results').replaceChildren();setMsg('Search failed. Check your internet and server.')}
};
$('dest').addEventListener('keydown',e=>{if(e.key==='Enter')$('search').click()});
$('code').addEventListener('input',()=>{$('code').value=$('code').value.toUpperCase().replace(/[^A-Z0-9]/g,'')});

// ===== NEW: consent for sharing location (asked on the form, remembered on this device) =====
try{$('locConsent').checked=localStorage.getItem('oneroute-loc-ok')==='1'}catch{}
$('locConsent').onchange=()=>{try{localStorage.setItem('oneroute-loc-ok',$('locConsent').checked?'1':'0')}catch{}if($('locConsent').checked)setMsg('')};
function locConsentOk(){
  if($('locConsent').checked)return true;
  setMsg('Please tick the box to agree to share your live location with the trip.');
  $('locConsent').scrollIntoView({behavior:'smooth',block:'center'});$('locConsent').focus();
  return false;
}
// Pressing Enter in the trip-code box joins, like the destination box searches
$('code').addEventListener('keydown',e=>{if(e.key==='Enter')$('join').click()});
$('create').onclick=()=>{
  if(!locConsentOk())return;
  if(!chosen){
    // They typed a place but never pressed Search: do it for them and point at the results
    if($('dest').value.trim()){setMsg('Pick your destination from the results, then press Create trip again.');$('search').click();setTimeout(()=>$('results').scrollIntoView({behavior:'smooth',block:'center'}),200);return}
    setMsg('Type where you are going, then press Search.');$('dest').focus();return;
  }
  // A starting point typed but never picked from the results would silently be ignored, so ask for it to be picked or cleared.
  const pending=bridge.commands.startStatus?bridge.commands.startStatus():null;
  if(pending&&pending.typed&&!pending.chosen){setMsg(i18n.t('start.pick'));bridge.run('searchStart');return}
  const createWith=(start,job)=>{
    job.label('Building your route…');
    socket.emit('create-trip',{name:name(),start,destination:chosen},res=>{job.stop();if(res&&res.ok)openPlanner(res);else setMsg(res?.error||'Could not create trip.')});
  };
  setMsg('');
  // A chosen starting point needs no GPS at all; otherwise the trip starts from where the person is now.
  if(chosenStart){createWith({lat:chosenStart.lat,lon:chosenStart.lon},busyStart('Building your route…','working',''));return}
  if(!navigator.geolocation)return setMsg('This browser does not support GPS.');
  const job=busyStart('Getting your location…','working','Allow location if your browser asks.');
  getPositionOnce().then(pos=>createWith({lat:pos.coords.latitude,lon:pos.coords.longitude},job),e=>{job.stop();setMsg(geoError(e))});
};
$('join').onclick=()=>{
  if(!locConsentOk())return;
  const code=$('code').value.trim().toUpperCase();if(code.length!==4){setMsg('Enter the 4-letter trip code.');$('code').focus();return}
  const job=busyStart('Joining the convoy…','connecting');
  socket.emit('join-trip',{code,name:name()},res=>{
    job.stop();
    if(res&&res.ok)startApp(res);else setMsg(res?.error||'Could not join this trip.');
  });
};


function openPlanner(res){
  window.scrollTo(0,0);setTimeout(()=>window.scrollTo(0,0),80);
  pendingTrip=res;plannedWaypoints=Array.isArray(res.waypoints)?res.waypoints.slice():[];$('setup').hidden=true;$('app').hidden=true;$('nav').hidden=true;$('planner').hidden=false;
  $('plannerDestination').textContent=res.destination?.label||'Selected destination';$('plannerMessage').textContent='Search for a place and add it to your route.';$('waypointResults').replaceChildren();
  if(plannerMap){plannerMap.remove();plannerMap=null}
  plannerMap=createMap({container:'plannerMap',center:res.route?.[0]||[77.6,13],zoom:10,style:null});
  addSatFab(plannerMap);plannerMap.addControl(new maplibregl.NavigationControl());plannerMap.on('load',drawPlannerRoute);renderPlannerStops();
}
let routeRevealFrame = 0;
let lastPreviewRoute = null;

function previewRoute(map, coords) {
  cancelAnimationFrame(routeRevealFrame);
  const endpoints = coords.slice(0, 1).concat(coords.slice(-1));
  const points = {
    type: 'FeatureCollection',
    features: endpoints.map((coordinates, index) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates },
      properties: { color: index === 0 ? '#4ade80' : '#f4c430' },
    })),
  };
  const pointSource = map.getSource('planned-endpoints');
  if (pointSource) pointSource.setData(points);
  else {
    map.addSource('planned-endpoints', { type: 'geojson', data: points });
    map.addLayer({
      id: 'planned-endpoints', type: 'circle', source: 'planned-endpoints',
      paint: {
        'circle-color': ['get', 'color'],
        'circle-radius': 6,
        'circle-stroke-color': '#24272e',
        'circle-stroke-width': 2,
      },
    });
  }

  const line = 'planned-route-line';
  const routeKey = JSON.stringify(coords);
  const animate = lastPreviewRoute?.map !== map || lastPreviewRoute.key !== routeKey;
  lastPreviewRoute = { map, key: routeKey };
  map.setPaintProperty(line, 'line-gradient', null);
  map.setPaintProperty('planned-endpoints', 'circle-radius', 6);
  if (!animate || prefersReducedMotion()) return;

  const start = performance.now();
  const reveal = (now) => {
    if (map !== plannerMap || !map.getLayer(line) || !map.getLayer('planned-endpoints')) return;
    const elapsed = now - start;
    const progress = Math.max(.001, Math.min(.999, elapsed / 480));
    if (prefersReducedMotion() || elapsed >= 800) {
      map.setPaintProperty(line, 'line-gradient', null);
      map.setPaintProperty('planned-endpoints', 'circle-radius', 6);
      return;
    }
    map.setPaintProperty(line, 'line-gradient', elapsed < 480
      ? ['step', ['line-progress'], '#f4c430', progress, 'rgba(244,196,48,0)']
      : null);
    const pulse = Math.max(0, (elapsed - 480) / 320);
    map.setPaintProperty('planned-endpoints', 'circle-radius', 6 + 4 * Math.sin(pulse * Math.PI));
    routeRevealFrame = requestAnimationFrame(reveal);
  };
  reveal(start);
}

function drawPlannerRoute(){
  if(!plannerMap||!pendingTrip||!plannerMap.isStyleLoaded())return;const original=Array.isArray(pendingTrip.route)?pendingTrip.route:[];if(original.length<2)return;
  const coords=plannedWaypoints.length?[original[0],...plannedWaypoints.map(w=>[Number(w.lon),Number(w.lat)]),original[original.length-1]]:original,feature={type:'Feature',geometry:{type:'LineString',coordinates:coords},properties:{}};
  if(plannerMap.getSource('planned-route'))plannerMap.getSource('planned-route').setData(feature);else{plannerMap.addSource('planned-route',{type:'geojson',data:feature,lineMetrics:true});plannerMap.addLayer({id:'planned-route-line',type:'line',source:'planned-route',paint:{'line-color':'#f4c430','line-width':5},layout:{'line-cap':'round','line-join':'round'}})}
  plannerMarkers.forEach(m=>m.remove());plannerMarkers=[];plannedWaypoints.forEach((w,i)=>{const el=document.createElement('div');el.className='waypoint-icon';el.textContent='P';plannerMarkers.push(new maplibregl.Marker({element:el}).setLngLat([Number(w.lon),Number(w.lat)]).setPopup(new maplibregl.Popup().setText(w.label||`Waypoint ${i+1}`)).addTo(plannerMap))});
  const bounds=new maplibregl.LngLatBounds(coords[0],coords[0]);coords.forEach(c=>bounds.extend(c));plannerMap.fitBounds(bounds,{padding:45,duration:0});
  previewRoute(plannerMap, coords);
}
function renderPlannerStops(){const list=$('plannerStops');list.replaceChildren();plannedWaypoints.forEach((w,i)=>{const row=document.createElement('div');row.className='row';const label=document.createElement('span');label.textContent=`${i+1}. ${w.label||w.name||'Waypoint'}`;const b=document.createElement('button');b.className='remove-stop';b.textContent='Remove';b.onclick=()=>{plannedWaypoints.splice(i,1);renderPlannerStops();drawPlannerRoute()};row.append(label,b);list.appendChild(row)});if(!plannedWaypoints.length){const p=document.createElement('p');p.className='subtitle';p.textContent='No stops added yet.';list.appendChild(p)}}
$('searchWaypoint').onclick=async()=>{const q=$('waypointSearch').value.trim();if(!q)return $('plannerMessage').textContent='Enter a place to search.';$('plannerMessage').textContent='Searching…';$('waypointResults').replaceChildren(skeletonBlock(3));try{const r=await fetch('/geocode?q='+encodeURIComponent(q),{headers:authHeaders()});if(!r.ok)throw Error();const results=await r.json();$('waypointResults').replaceChildren();if(!Array.isArray(results)||!results.length){$('plannerMessage').textContent='No places found.';return}if(results.some(p=>p.approx)){const h=document.createElement('div');h.className='dym';h.textContent=i18n.t('search.didYouMean');$('waypointResults').appendChild(h)}$('plannerMessage').textContent='Select a result to add it as a stop.';results.forEach(place=>{const b=document.createElement('button');b.textContent=place.label;b.onclick=()=>{const lon=Number(place.lon),lat=Number(place.lat);if(!Number.isFinite(lon)||!Number.isFinite(lat))return;if(plannedWaypoints.some(w=>Number(w.lon)===lon&&Number(w.lat)===lat))return;plannedWaypoints.push({label:place.label,lon,lat});renderPlannerStops();drawPlannerRoute();$('plannerMessage').textContent='Stop added.'};$('waypointResults').appendChild(b)})}catch{$('waypointResults').replaceChildren();$('plannerMessage').textContent='Search failed. Check your connection and server.'}};
$('waypointSearch').addEventListener('keydown',e=>{if(e.key==='Enter')$('searchWaypoint').click()});
$('backToSetup').onclick=()=>{$('planner').hidden=true;$('setup').hidden=false;if(plannerMap){plannerMap.remove();plannerMap=null}};
$('editWaypoints').onclick=()=>{if(!pendingTrip){showBanner('<b>Route editing</b>Create a trip first to edit stops.','warn',5000);return}$('app').hidden=true;$('nav').hidden=true;$('planner').hidden=false;if(!plannerMap)openPlanner(pendingTrip);else setTimeout(()=>plannerMap.resize(),80)};
$('startPlannedTrip').onclick=()=>{if(!pendingTrip)return;if(!plannedWaypoints.length){startApp({...pendingTrip,waypoints:[]});return}$('plannerMessage').textContent='Saving stops to the trip…';const job=busyStart('Rebuilding your route…','working','Adding your stops to the road route.',()=>{$('plannerMessage').textContent='This is taking longer than expected. Try again.';showNotice('This is taking longer than expected. Try again.')});socket.emit('update-waypoints',{code:pendingTrip.code,waypoints:plannedWaypoints},res=>{job.stop();if(!res||!res.ok){const m=res?.error||'Could not save your stops. Try again.';$('plannerMessage').textContent=m;showNotice(m);return}pendingTrip={...pendingTrip,...res,waypoints:res.waypoints||plannedWaypoints};startApp(pendingTrip)})};
function renderUpcomingWaypoints(waypoints=[]){const list=$('waypointsList');list.replaceChildren();$('emptyWaypoints').hidden=waypoints.length>0;waypoints.forEach((w,i)=>{const card=document.createElement('div');card.className='waypoint-card';const icon=document.createElement('div');icon.className='waypoint-icon';icon.textContent='P';const info=document.createElement('div');info.className='waypoint-info';const title=document.createElement('strong');title.textContent=w.label||w.name||`Waypoint ${i+1}`;const detail=document.createElement('p');detail.textContent=w.description||(i===0?'Next planned stop':'Planned rally check');const distance=document.createElement('div');distance.className='waypoint-distance';const d=Number(w.distanceKm);distance.textContent=Number.isFinite(d)?d.toFixed(1):'—';const small=document.createElement('small');small.textContent=Number.isFinite(d)?'KM':'DISTANCE';distance.appendChild(small);info.append(title,detail);card.append(icon,info,distance);list.appendChild(card)})}
socket.on('waypoints',waypoints=>{if(Array.isArray(waypoints)){plannedWaypoints=waypoints;renderUpcomingWaypoints(waypoints)}});
socket.on('route-updated',update=>{
  if(!update)return;
  pendingTrip={...pendingTrip,...update};
  plannedWaypoints=Array.isArray(update.waypoints)?update.waypoints:plannedWaypoints;
  renderUpcomingWaypoints(plannedWaypoints);
  if(map&&Array.isArray(update.route)&&update.route.length){
    const feature={type:'Feature',geometry:{type:'LineString',coordinates:update.route},properties:{}};
    if(map.getSource('route'))map.getSource('route').setData(feature);
    else if(map.isStyleLoaded()){map.addSource('route',{type:'geojson',data:feature});map.addLayer({id:'route-casing',type:'line',source:'route',paint:{'line-color':'#17191d','line-width':9}});map.addLayer({id:'route-line',type:'line',source:'route',paint:{'line-color':'#f4c430','line-width':5}});}
    const bounds=update.route.reduce((b,c)=>b.extend(c),new maplibregl.LngLatBounds(update.route[0],update.route[0]));map.fitBounds(bounds,{padding:45,duration:0});
  }
});

function startApp(res){
  window.scrollTo(0,0);setTimeout(()=>window.scrollTo(0,0),80);
  pendingTrip=res;mapWaitShow();startWeather();
  try{history.replaceState(null,'',location.pathname)}catch{}
  session={code:res.code,name:name()};
  // Bug fix (existing app): the planner was never hidden when the trip started, so it stayed stacked above the map.
  $('setup').hidden=true;$('planner').hidden=true;if(plannerMap){plannerMap.remove();plannerMap=null}$('app').hidden=false;$('nav').hidden=false;
  $('tripcode').textContent=$('summarycode').textContent=res.code||'----';
  const dest=(res.destination?.label)||'Destination';
  $('topdest').textContent=dest.split(',').slice(0,2).join(',');
  $('destlabel').textContent='→ '+dest;$('summarydest').textContent='Destination: '+dest;
  $('destinationinfo').textContent=dest;
  renderUpcomingWaypoints(res.waypoints||plannedWaypoints||[]);
  if(map){map.remove();map=null}
  Object.keys(markers).forEach(k=>delete markers[k]);
  map=createMap({
    container:'map',center:res.route?.[0]||[77.6,13],zoom:11,
    style:null
  });
  map.addControl(new maplibregl.NavigationControl(),'top-right');
  map.on('load',()=>{
    applySat(map);
    if(res.route?.length){
      map.addSource('route',{type:'geojson',data:{type:'Feature',geometry:{type:'LineString',coordinates:res.route}}});
      map.addLayer({id:'route-casing',type:'line',source:'route',paint:{'line-color':'#17191d','line-width':9}});
      map.addLayer({id:'route-line',type:'line',source:'route',paint:{'line-color':'#f4c430','line-width':5}});
      const bounds=res.route.reduce((b,c)=>b.extend(c),new maplibregl.LngLatBounds(res.route[0],res.route[0]));
      map.fitBounds(bounds,{padding:45,duration:0});
    }
    if(res.destination){
      const el=document.createElement('div');el.className='dest';el.textContent='Destination';
      new maplibregl.Marker({element:el}).setLngLat([res.destination.lon,res.destination.lat]).addTo(map);
    }
  });
  startSharing();showScreen('map');
  navRouteRequest++;navRequestPending=false;navRoutingUnavailable=false;navRetryAt=0;navRouteSteps=[];navStepIndex=0;
  navRouteCoords=Array.isArray(res.route)?res.route:[];
  navTotals=null;navBuildCum();navDrawRoute();
  navTrip=true;navLastRouteAt=0;navFetchDirections(); // turn-by-turn runs for the whole trip, and shows a preview until GPS arrives
  Object.keys(sosMarkers).forEach(id=>{sosMarkers[id].remove();delete sosMarkers[id]});renderSos();
}

// Full-screen navigation: uses OSRM turn instructions and mirrors the live Socket.IO convoy.
function navDestination(){return pendingTrip?.destination||chosen||null;}
function navFormatDistance(m){return formatDistance(m)}
function navDistance(a,b){const R=6371000,rad=v=>v*Math.PI/180;const dLat=rad(b[1]-a[1]),dLon=rad(b[0]-a[0]);const x=Math.sin(dLat/2)**2+Math.cos(rad(a[1]))*Math.cos(rad(b[1]))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(x));}
function navManeuverIcon(type,modifier){if(type==='turn'||type==='end of road'||type==='fork'){if(modifier?.includes('left'))return '↰';if(modifier?.includes('right'))return '↱';if(modifier==='uturn')return '↶';return '↑'}if(type==='roundabout'||type==='rotary')return '⟳';if(type==='merge')return '⇢';if(type==='depart')return '↑';if(type==='arrive')return '🏁';if(type==='continue'||type==='new name')return '↑';return '↗';}
function navManeuverText(step){return maneuverText(step)}
// ===== Navigation view: your own icon, a camera that follows it, and the turns drawn on the route line =====
const NAV_ZOOM=kmh=>kmh>85?15.1:kmh>55?15.9:kmh>30?16.6:17.4; // a little further out at highway speed
function navFollowCamera(force){
  if(!navMap||!navOpen||!lastGps||!navMap.isStyleLoaded())return false;
  if(!navFollow&&!force)return false;
  const kmh=lastSpeedKmh??0,moving=kmh>4&&lastHeading!==null;
  navMap.easeTo({
    center:[lastGps.lon,lastGps.lat],zoom:NAV_ZOOM(kmh),pitch:52,
    bearing:moving?lastHeading:navMap.getBearing(),            // heading-up while moving, steady when stopped
    offset:[0,Math.round(navMap.getContainer().clientHeight*0.18)], // keeps your icon in the lower part so the road ahead is visible
    duration:force?600:900,easing:t=>t,essential:true,
  });
  return true;
}
function navSetFollow(on){
  navFollow=on;
  if(navRecenterBtn)navRecenterBtn.hidden=on;
  if(on)navFollowCamera(true);
}
function navAttachCameraControls(m){
  const btn=document.createElement('button');btn.type='button';btn.className='nav-recenter';btn.hidden=true;btn.textContent='⌖ '+i18n.t('nav.recenter');
  btn.onclick=()=>navSetFollow(true);
  m.getContainer().appendChild(btn);navRecenterBtn=btn;
  i18n.on('languageChanged',()=>{btn.textContent='⌖ '+i18n.t('nav.recenter')});
  // moving the map by hand pauses following until "Recenter" is tapped
  const pause=e=>{if(e&&e.originalEvent&&navFollow)navSetFollow(false)};
  m.on('dragstart',pause);m.on('zoomstart',pause);m.on('rotatestart',pause);m.on('pitchstart',pause);
}
function navUpdateMarkers(){
  if(!navMap)return;
  if(lastGps){
    if(!navMeMarker){const el=document.createElement('div');el.className='nav-me';el.innerHTML='<i class="nav-me-arrow"></i>';navMeMarker=new maplibregl.Marker({element:el,rotationAlignment:'map',pitchAlignment:'map'}).setLngLat([lastGps.lon,lastGps.lat]).addTo(navMap)}
    else navMeMarker.setLngLat([lastGps.lon,lastGps.lat]);
    if(lastHeading!==null)navMeMarker.setRotation(lastHeading);
  }
  const seen=new Set();
  navCars.forEach(c=>{
    if(c.id===socket.id||c.lon==null||c.lat==null||!Number.isFinite(Number(c.lon))||!Number.isFinite(Number(c.lat)))return;
    seen.add(c.id);
    let m=navMarkers[c.id];
    if(!m){const el=document.createElement('div');el.className='nav-mate';m=navMarkers[c.id]=new maplibregl.Marker({element:el}).setLngLat([Number(c.lon),Number(c.lat)]).addTo(navMap)}
    const el=m.getElement();el.textContent=String(c.name||'?').trim().charAt(0).toUpperCase();paintPin(el,c);
    m.setLngLat([Number(c.lon),Number(c.lat)]);
  });
  Object.keys(navMarkers).forEach(id=>{if(!seen.has(id)){navMarkers[id].remove();delete navMarkers[id]}});
}
// Time and distance still to go, measured ALONG THE ROUTE LINE from where you are now (not from the next turn), so it keeps
// shrinking correctly even if a turn was skipped or the signal dropped. Time uses the route's own average speed.
let navCum=null;
let navRouteOverlay=null;
let navRequestPending=false, navRoutingUnavailable=false, navRetryAt=0;
function updateOfflineRoute(){
  const offline=!navigator.onLine||navRoutingUnavailable;
  $('navOfflineRoute').hidden=!(offline&&navRouteCoords.length>=2);
  $('navLiveStatus').textContent=navigator.onLine&&socket.connected
    ? i18n.t('legacy:live convoy positions',{defaultValue:'live convoy positions'}) : i18n.t('legacy:last known convoy positions',{defaultValue:'last known convoy positions'});
  if(offline&&navRouteCoords.length>=2){
    $('navNotice').textContent='Following the saved route. New directions need a connection.';
    if(!navRouteSteps.length){
      $('navInstruction').textContent='Follow the saved route';
      $('navRoadName').textContent='Turn-by-turn directions need a connection';
    }
  }
}
window.addEventListener('offline',updateOfflineRoute);
window.addEventListener('online',()=>{
  const refresh=navTrip&&(navRoutingUnavailable||!navRouteSteps.length);
  updateOfflineRoute();
  if(refresh){navRetryAt=0;void navFetchDirections();}
  else if(navTrip)$('navNotice').textContent='Directions from OSRM. Use road signs and drive safely.';
});
socket.on('connect',updateOfflineRoute);
socket.on('disconnect',updateOfflineRoute);
let navMatchedPosition=null;
let navVisualProgress=null;
let navProgressFix=null;
function navBuildCum(){
  navMatchedPosition=null;navVisualProgress=null;navProgressFix=null;navCum=null;
  if(navRouteCoords.length<2)return;
  const c=navRouteCoords,kx=Math.cos((c[0][1]||0)*Math.PI/180)*111320,ky=110574;
  navCum=new Array(c.length);navCum[0]=0;
  for(let i=1;i<c.length;i++)navCum[i]=navCum[i-1]+Math.hypot((c[i][0]-c[i-1][0])*kx,(c[i][1]-c[i-1][1])*ky);
}
function navEta(metersToNext,arrived){
  if(arrived)return{seconds:0,meters:0};
  const total=navCum?navCum[navCum.length-1]:(navTotals?navTotals.distance:0);
  let meters=total;
  const position=navMatchPosition();
  if(position) meters=Math.max(0,total-position.along)+position.offset;
  const secPerMeter=navTotals&&navTotals.distance>0&&navTotals.duration>0?navTotals.duration/navTotals.distance:0.072;
  return{seconds:Math.max(0,Math.round(meters*secPerMeter)),meters:Math.max(0,Math.round(meters))};
}
function navMatchPosition(){
  if(!navCum||navCum.length<2||!lastGps)return null;
  if(navMatchedPosition?.fix===lastGps)return navMatchedPosition;
  const kx=Math.cos(lastGps.lat*Math.PI/180)*111320,ky=110574;
    let best=Infinity,bi=0,bt=0;
    for(let i=0;i<navRouteCoords.length-1;i++){
      const ax=(navRouteCoords[i][0]-lastGps.lon)*kx,ay=(navRouteCoords[i][1]-lastGps.lat)*ky,bx=(navRouteCoords[i+1][0]-lastGps.lon)*kx,by=(navRouteCoords[i+1][1]-lastGps.lat)*ky;
      const dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy,t=l2>0?Math.max(0,Math.min(1,-(ax*dx+ay*dy)/l2)):0,px=ax+t*dx,py=ay+t*dy,d=px*px+py*py;
      if(d<best){best=d;bi=i;bt=t}
    }
    navMatchedPosition={
      fix:lastGps, segment:bi, fraction:bt, offset:Math.sqrt(best),
      along:navCum[bi]+bt*(navCum[bi+1]-navCum[bi]),
    };
    return navMatchedPosition;
}
function navEnsureMap(){if(navMap)return;navMap=createMap({container:'navMap',center:lastGps?[lastGps.lon,lastGps.lat]:(pendingTrip?.route?.[0]||[77.6,13]),zoom:15,style:null});addSatFab(navMap);navAttachCameraControls(navMap);navMap.addControl(new maplibregl.NavigationControl(),'top-right');navRouteOverlay=createNavRouteOverlay(navMap);navMap.on('load',()=>{navDrawRoute();navRenderCars();navUpdateMarkers();if(lastGps&&!navCameraInit)navCameraInit=navFollowCamera(true)});}
function navRouteData(coords, progress) {
  const line = (coordinates, traveled) => ({
    type:'Feature', geometry:{type:'LineString',coordinates}, properties:{traveled},
  });
  if (!progress || progress.along <= 0) {
    return {type:'FeatureCollection',features:[line(coords,false)]};
  }
  const {segment,fraction}=progress;
  const a=coords[segment],b=coords[segment+1];
  const split=a.map((value,index)=>value+(b[index]-value)*fraction);
  const features=[line([...coords.slice(0,segment+1),split],true)];
  if(segment<coords.length-2||fraction<1)features.push(line([split,...coords.slice(segment+1)],false));
  return {type:'FeatureCollection',features};
}
function navRouteArrows(points, width, height){
  const spacing=64;
  let distance=0, next=24;
  const arrows=[];
  const xy=(x,y)=>x.toFixed(1)+' '+y.toFixed(1);
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i];
    const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    if(!length)continue;
    const end=distance+length;
    // Skip offscreen segments without losing the spacing along the route.
    if(Math.max(a.x,b.x)>=0&&Math.min(a.x,b.x)<=width&&
       Math.max(a.y,b.y)>=0&&Math.min(a.y,b.y)<=height){
      const ux=dx/length,uy=dy/length;
      while(next<end){
        const x=a.x+(next-distance)*ux,y=a.y+(next-distance)*uy;
        if(x>=8&&x<=width-8&&y>=8&&y<=height-8){
          const backX=x-3*ux,backY=y-3*uy;
          arrows.push('M'+xy(backX-2.5*uy,backY+2.5*ux)+
            'L'+xy(x+3*ux,y+3*uy)+'L'+xy(backX+2.5*uy,backY-2.5*ux));
        }
        next+=spacing;
      }
    }else if(next<end){
      next+=Math.ceil((end-next)/spacing)*spacing;
    }
    distance=end;
  }
  return arrows.join(' ');
}

function createNavRouteOverlay(map){
  const ns='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(ns,'svg');
  svg.classList.add('nav-route-overlay');
  svg.setAttribute('aria-hidden','true');
  const strokes=['nav-route-outline','nav-route-completed','nav-route-upcoming','nav-route-arrows'].map(className=>{
    const path=document.createElementNS(ns,'path');
    path.classList.add(className);
    svg.appendChild(path);
    return path;
  });
  map.getCanvasContainer().appendChild(svg);

  let data;
  function draw(){
    if(!data||!navOpen)return;
    let traveled='', remaining='', arrows='';
    for(const feature of data.features){
      const points=feature.geometry.coordinates.map(coordinate=>map.project(coordinate));
      const path=points.map((point,index)=>
        (index===0?'M':'L')+point.x.toFixed(1)+' '+point.y.toFixed(1)
      ).join(' ');
      if(feature.properties.traveled)traveled=path;
      else{
        remaining=path;
        arrows=navRouteArrows(points,svg.clientWidth,svg.clientHeight);
      }
    }
    [traveled+' '+remaining,traveled,remaining,arrows].forEach((path,index)=>{
      strokes[index].setAttribute('d',path.trim());
    });
  }
  map.on('render',draw);
  return {setData(next){data=next;draw();}};
}

function navUpdateRouteProgress(){
  if(!navRouteOverlay||!lastGps||navProgressFix===lastGps)return;
  navProgressFix=lastGps;
  const progress=navMatchPosition();
  if(!progress||progress.offset>55||progress.along<=(navVisualProgress?.along??0))return;
  navVisualProgress=progress;
  navRouteOverlay.setData(navRouteData(navRouteCoords,progress));
}
function navDrawRoute(){
  if(!navRouteOverlay)return;
  if(navRouteCoords.length<2){
    navRouteOverlay.setData({features:[]});
    return;
  }
  navRouteOverlay.setData(navRouteData(navRouteCoords,navVisualProgress));
  navUpdateRouteProgress();
  if(navOpen&&!navCameraInit){navCameraInit=true;
    if(lastGps)navFollowCamera(true); // with a location: zoom in on the person's icon, like a navigation app
    else{const bounds=new maplibregl.LngLatBounds(navRouteCoords[0],navRouteCoords[0]);navRouteCoords.forEach(c=>bounds.extend(c));navMap.fitBounds(bounds,{padding:{top:105,bottom:95,left:40,right:40},maxZoom:16,duration:500})} // no location yet: show the route
  }}
async function navFetchDirections(){if(!navigator.onLine||navRequestPending||Date.now()<navRetryAt){updateOfflineRoute();return;}const dest=navDestination();if(!dest||!Number.isFinite(Number(dest.lon))||!Number.isFinite(Number(dest.lat))){$('navInstruction').textContent='Destination coordinates unavailable';$('navRoadName').textContent='Choose a destination and start a trip first.';return;}const origin=lastGps||(pendingTrip&&pendingTrip.route&&pendingTrip.route[0]?{lat:pendingTrip.route[0][1],lon:pendingTrip.route[0][0]}:null);navPreview=!lastGps;if(!origin){$('navInstruction').textContent='Waiting for your GPS location';$('navRoadName').textContent='Allow location access to calculate turn-by-turn directions.';return;}const requestId=++navRouteRequest;
navRequestPending=true;
if(!navRouteSteps.length&&!navRoutingUnavailable){
  $('navInstruction').textContent='Calculating directions…';
  $('navRoadName').textContent='Fetching driving route';
}try{const start=`${origin.lon},${origin.lat}`,end=`${Number(dest.lon)},${Number(dest.lat)}`;const url=`https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=full&geometries=geojson&steps=true`;const response=await fetch(url,{signal:AbortSignal.timeout?.(10000)});if(!response.ok)throw new Error('Routing service unavailable');const data=await response.json();if(requestId!==navRouteRequest)return;if(data.code!=='Ok'||!data.routes?.length)throw new Error('No driving route found');const route=data.routes[0];navRouteCoords=route.geometry.coordinates;navRouteSteps=(route.legs||[]).flatMap(leg=>leg.steps||[]);navTotals={distance:Number(route.distance)||0,duration:Number(route.duration)||0};navBuildCum();navStepIndex=0;navLastRouteAt=Date.now();navRoutingUnavailable=false;navRetryAt=0;updateOfflineRoute();$('navRouteMeta').textContent=`${(route.distance/1000).toFixed(1)} km · ${Math.round(route.duration/60)} min estimated`;$('navNotice').textContent='Directions from OSRM; map and convoy positions are live. Use road signs and drive safely.';navDrawRoute();navUpdateInstruction();}catch(e){
  if(requestId!==navRouteRequest)return;
  navRoutingUnavailable=true;
  navRetryAt=Date.now()+30000;
  updateOfflineRoute();
  if(navRouteCoords.length>=2||navRouteSteps.length){
    navUpdateInstruction();
    return;
  }
  $('navNextSteps').replaceChildren();
  $('navInstruction').textContent='Turn-by-turn unavailable';
  $('navRoadName').textContent='Check your internet connection';
}finally{
  if(requestId===navRouteRequest)navRequestPending=false;
}}
const shownManeuvers = new WeakMap();
function animateManeuver(target, identity) {
  if (shownManeuvers.get(target) === identity) return;
  shownManeuvers.set(target, identity);
  if (!prefersReducedMotion()) {
    target.getAnimations?.().forEach(animation => animation.cancel());
    target.animate?.(
      [{ opacity: .65, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 160, easing: 'ease-out' },
    );
  }
}

function navUpdateInstruction(){if(navOpen)navUpdateRouteProgress();if(!(navOpen||navDriving||navTrip)||!navStepsCountExists())return;const pos=lastGps?[lastGps.lon,lastGps.lat]:null;if(!navRouteSteps.length){$('navTurnIcon').textContent='↑';$('navTurnLabel').textContent='NAVIGATION';navPayload=null;$('navTurnDistance').innerHTML='—<small>TO TURN</small>';$('navNextSteps').innerHTML='<div class="nav-step-chip">Directions will appear once a route is available.</div>';return;}if(pos){let best=navStepIndex,bestDist=Infinity;for(let i=Math.max(0,navStepIndex);i<Math.min(navRouteSteps.length,navStepIndex+4);i++){const loc=navRouteSteps[i].maneuver?.location;if(!loc)continue;const d=navDistance(pos,loc);if(d<bestDist){bestDist=d;best=i;}}if(bestDist<65&&best<navRouteSteps.length-1){navVoiceStage(navRouteSteps[best],0);navStepIndex=Math.max(navStepIndex,best+1);}}
const step=navRouteSteps[Math.min(navStepIndex,navRouteSteps.length-1)],maneuver=step.maneuver||{},loc=maneuver.location;let meters=loc&&pos?navDistance(pos,loc):Number(step.distance)||0;const text=navManeuverText(step);if(navOpen)animateManeuver($('navInstruction').parentElement,JSON.stringify([loc,text,step.name]));if(pos)navVoiceStage(step,meters);$('navTurnIcon').textContent=navManeuverIcon(maneuver.type,maneuver.modifier);$('navTurnLabel').textContent=navStepIndex===0?'FIRST MANEUVER':'NEXT MANEUVER';$('navInstruction').textContent=text;$('navRoadName').textContent=step.name?`onto ${step.name}`:(maneuver.type==='arrive'?'Destination reached':'Follow the highlighted route');$('navTurnDistance').innerHTML=navFormatDistance(meters)+'<small>TO TURN</small>';navPayload={icon:navManeuverIcon(maneuver.type,maneuver.modifier),text,road:step.name||'',distance:navFormatDistance(meters),arrive:maneuver.type==='arrive',preview:!pos,eta:navEta(meters,maneuver.type==='arrive'&&meters<30)};
const upcoming=navRouteSteps.slice(navStepIndex+1,navStepIndex+5);$('navStepsCount').textContent=`${upcoming.length} after this`; $('navNextSteps').innerHTML=upcoming.map((st,i)=>`<div class="nav-step-chip"><b>${navManeuverIcon(st.maneuver?.type,st.maneuver?.modifier)}</b>${navManeuverText(st)}${st.name?' · '+esc(st.name):''}<br><span style="color:#9ca3af">${navFormatDistance(st.distance)}</span></div>`).join('')||'<div class="nav-step-chip">Final maneuver</div>';}
function navStepsCountExists(){return !!$('navStepsCount');}
function navRenderCars(){if(!navOpen)return;$('navLiveCount').textContent=`${navCars.length} vehicle${navCars.length===1?'':'s'}`;$('navConvoy').innerHTML=navCars.map(c=>{const status=c.status||'offline',color=COLORS[status]||COLORS.offline,isMe=c.id===socket.id;return `<button class="nav-person ${isMe?'me':''}" data-nav-car="${esc(c.id)}">${miniAvatarHtml(c,color)}<span><b>${esc(c.name||'Driver')}${isMe?' (you)':''}</b><small>${esc(LABEL[status]||status)}${Number.isFinite(Number(c.gapKm))&&Number(c.gapKm)>0?' · '+Number(c.gapKm).toFixed(1)+' km back':''}</small></span></button>`}).join('')||'<div class="nav-step-chip">Waiting for convoy positions…</div>';document.querySelectorAll('[data-nav-car]').forEach(b=>b.onclick=()=>{const c=navCars.find(x=>String(x.id)===b.dataset.navCar);if(c&&Number.isFinite(Number(c.lon))&&Number.isFinite(Number(c.lat))&&navMap)navMap.flyTo({center:[Number(c.lon),Number(c.lat)],zoom:16,duration:700});});navUpdateMarkers();}
async function openNavigation(){if(!session||!pendingTrip){showBanner('<b>Start or join a convoy first</b>Select a destination and start your trip to use navigation.','warn',5000);return;}navOpen=true;$('navigationScreen').hidden=false;document.body.style.overflow='hidden';navEnsureMap();navMap.resize();navDrawRoute();updateOfflineRoute();
  // The screen is still sizing itself when it opens, and resizing can drop a camera move made a moment earlier, so (re)apply the camera after each resize.
  [100,700].forEach(ms=>setTimeout(()=>{navMap?.resize();if(navOpen&&lastGps&&navFollow)navFollowCamera(true)},ms));$('navDestination').textContent=pendingTrip.destination?.label||'Selected destination';navRenderCars();if(navRouteCoords.length)navUpdateInstruction();if(!navRouteSteps.length||(Date.now()-navLastRouteAt>120000&&navMatchPosition()?.offset>80))await navFetchDirections();else navUpdateInstruction();navCameraInit=false;navFollow=true;if(navRecenterBtn)navRecenterBtn.hidden=true;navUpdateMarkers();if(lastGps&&navMap)navCameraInit=navFollowCamera(true)}
function closeNavigation(){try{$('openNavigation').focus()}catch{}navOpen=false;$('navigationScreen').hidden=true;document.body.style.overflow='';if(navMap&&map){setTimeout(()=>navMap.resize(),80)}}
$('openNavigation').onclick=openNavigation;
$('openNavigation').addEventListener('click',()=>{setTimeout(()=>{if(navOpen)$('closeNavigation').focus()},150);[300,1200,2500].forEach(ms=>setTimeout(()=>applySat(navMap),ms))});$('closeNavigation').onclick=closeNavigation;
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&navOpen)closeNavigation();});
window.addEventListener('resize',()=>{if(navOpen&&navMap)setTimeout(()=>navMap.resize(),80)});

function clearFuelMarkers(){fuelMarkers.forEach(marker=>marker.remove());fuelMarkers=[];}
async function loadFuelStations(lat,lon){
  if(!map||!fuelVisible)return;
  const requestId=++fuelRequestId;
  const query=`[out:json][timeout:20];(nwr(around:5000,${lat},${lon})[amenity=fuel];);out center tags;`;
  try{
    const response=await fetch('https://overpass-api.de/api/interpreter',{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:'data='+encodeURIComponent(query)
    });
    if(!response.ok)throw new Error('Fuel station search failed');
    const data=await response.json();
    if(!fuelVisible||!map||requestId!==fuelRequestId)return;
    clearFuelMarkers();
    (data.elements||[]).forEach(station=>{
      const stationLat=Number(station.lat??station.center?.lat);
      const stationLon=Number(station.lon??station.center?.lon);
      if(!Number.isFinite(stationLat)||!Number.isFinite(stationLon))return;
      if(Math.abs(stationLat)>90||Math.abs(stationLon)>180)return;
      const tags=station.tags||{};
      const name=tags.name||tags.brand||'Fuel station';
      const el=document.createElement('div');el.className='fuel-pin';el.textContent='⛽';el.title=name;
      const popupContent=document.createElement('div');
      const title=document.createElement('strong');title.textContent=name;popupContent.appendChild(title);
      const addressParts=[tags['addr:street'],tags['addr:city']].filter(Boolean);
      if(addressParts.length){const address=document.createElement('p');address.textContent=addressParts.join(', ');popupContent.appendChild(address);}
      fuelMarkers.push(new maplibregl.Marker({element:el}).setLngLat([stationLon,stationLat]).setPopup(new maplibregl.Popup({offset:18}).setDOMContent(popupContent)).addTo(map));
    });
    showBanner(`<b>${fuelMarkers.length} fuel stations found</b>Within approximately 5 km. Tap a marker for details.`,'ok',4500);
  }catch(e){
    if(requestId===fuelRequestId&&fuelVisible)showBanner('<b>Fuel search failed</b>Check your internet connection and try again.','warn',5000);
  }
}
$('fuelToggle').onclick=()=>{
  fuelVisible=!fuelVisible;
  const button=$('fuelToggle');button.classList.toggle('active',fuelVisible);button.setAttribute('aria-pressed',String(fuelVisible));
  button.textContent=fuelVisible?'⛽ Hide fuel stations':'⛽ Fuel stations';
  if(!fuelVisible){fuelRequestId++;clearFuelMarkers();return;}
  if(lastGps)loadFuelStations(lastGps.lat,lastGps.lon);
  else if(navigator.geolocation){
    getPositionOnce().then(position=>{
      lastGps={lat:position.coords.latitude,lon:position.coords.longitude};lastFixAt=Date.now();
      if(navPreview){navPreview=false;navLastRouteAt=0;navFetchDirections()}
      loadFuelStations(lastGps.lat,lastGps.lon);
    },()=>showBanner('<b>Location unavailable</b>Allow GPS access and try again.','warn',5000));
  }else showBanner('<b>GPS unavailable</b>This browser does not support location access.','warn',5000);
};

function startSharing(){
  if(watchId!==null)geo.clearWatch(watchId);
  let last=0,lastFuelSearch=0;
  onPosition=p=>{
    if(Date.now()-last<1000)return;last=Date.now();lastFixAt=Date.now();
    if(!p.__manual){lastRealFixAt=Date.now();if(gpsMode==='manual'){clearInterval(manualTimer);gpsMode=null}}
    lastGps={lat:p.coords.latitude,lon:p.coords.longitude};noteHeading(p);
    if(navPreview){navPreview=false;navLastRouteAt=0;navFetchDirections()} // first real fix: swap the preview for live directions
    if(navOpen||navDriving||navTrip){navUpdateInstruction();if(((navRoutingUnavailable||!navRouteSteps.length)?Date.now()>=navRetryAt:Date.now()-navLastRouteAt>120000&&navMatchPosition()?.offset>80))navFetchDirections();}if(navOpen){navUpdateMarkers();navFollowCamera()}
    const speedMps=p.coords.speed;lastSpeedKmh=Number.isFinite(speedMps)&&speedMps>=0?Math.round(speedMps*3.6):null;
    $('speedValue').textContent=Number.isFinite(speedMps)&&speedMps>=0?Math.round(speedMps*3.6):'--';
    if(fuelVisible&&Date.now()-lastFuelSearch>30000){lastFuelSearch=Date.now();loadFuelStations(lastGps.lat,lastGps.lon)}
    socket.emit('position',{lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy,speed:p.coords.speed});
  };
  watchId=geo.watchPosition(onPosition,e=>{gpsErrorCode=e.code;showBanner('<b>Location problem</b>'+esc(geoError(e)),'warn',8000)},{enableHighAccuracy:true,maximumAge:1000,timeout:20000});
  keepScreenOn();
}
async function keepScreenOn(){try{if(navigator.wakeLock)wakeLock=await navigator.wakeLock.request('screen')}catch{}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&session)keepScreenOn()});

function showScreen(which){
  window.scrollTo(0,0);bridge.emit('screen',which);
  document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id==='screen-'+which));
  document.querySelectorAll('.nav-btn').forEach(b=>{const on=b.dataset.screen===which;b.classList.toggle('active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
  if(which==='map'&&map)setTimeout(()=>map.resize(),80);
  onSummaryScreen(which==='summary');
}
document.querySelectorAll('.nav-btn').forEach(b=>b.onclick=()=>showScreen(b.dataset.screen));
$('follow').onclick=()=>{$('follow').textContent='Follow: '+((follow=!follow)?'ON':'OFF')};
$('recenter').onclick=()=>{
  if(!map)return;
  const pts=Object.values(markers).map(m=>m.getLngLat());
  if(pts.length){const b=new maplibregl.LngLatBounds(pts[0],pts[0]);pts.forEach(p=>b.extend(p));map.fitBounds(b,{padding:70,maxZoom:15})}
};
$('stop').onclick=()=>{
  if(watchId!==null)geo.clearWatch(watchId);
  if(wakeLock)wakeLock.release().catch(()=>{});
  socket.disconnect();location.reload();
};
socket.on('connect',()=>{if(session)socket.emit('join-trip',session,()=>{})});

socket.on('cars',cars=>{
  if(!Array.isArray(cars))return;
  navCars=cars.slice();lastCars=cars.slice();iAmCreator=!!cars.find(c=>c.id===socket.id&&c.creator);syncPins();
  const me=cars.find(c=>c.id===socket.id);
  if(me&&me.pacing){
    showBanner(`<b>⏱ Regroup Pacing:</b> ${esc(me.pacing.text)}`,'warn',12000);
  }
  if(navOpen){navRenderCars();navUpdateMarkers()}if(navOpen||navDriving||navTrip)navUpdateInstruction();
  if(!map)return;
  const bounds=new maplibregl.LngLatBounds(),seen=new Set();
  $('statuscars').innerHTML='';
  let on=0,maxGap=0;
  cars.forEach(c=>{
    seen.add(c.id);
    if(['ok','behind','arrived'].includes(c.status))on++;
    if(Number.isFinite(Number(c.gapKm)))maxGap=Math.max(maxGap,Number(c.gapKm));
    if(c.lon!=null&&c.lat!=null&&Number.isFinite(Number(c.lon))&&Number.isFinite(Number(c.lat))){
      if(!markers[c.id]){
        const el=document.createElement('div');el.className='pin'+(c.id===socket.id?' me':'');
        el.textContent=String(c.name||'?')[0].toUpperCase();
        markers[c.id]=new maplibregl.Marker({element:el}).setLngLat([c.lon,c.lat]).addTo(map);
      }
      // NEW: glide to the new position instead of jumping
      glideMarker(c.id,markers[c.id],[Number(c.lon),Number(c.lat)]);
      const pinEl=markers[c.id].getElement();
      paintPin(pinEl,c);
      pinEl.classList.toggle('approx',!!c.approx);
      pinEl.dataset.role=c.role||'';pinEl.dataset.id=c.id;pinEl.setAttribute('aria-label',(c.name||'Driver')+(c.role?' ('+ROLE_LABEL[c.role]+')':'')+': open options');
      if(!pinEl.dataset.wired){pinEl.dataset.wired='1';pinEl.tabIndex=0;pinEl.setAttribute('role','button');pinEl.addEventListener('click',()=>openDriverSheet(pinEl.dataset.id));pinEl.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openDriverSheet(pinEl.dataset.id)}})}
      if(c.id===socket.id)mapWaitDone();
      // NEW: ripple ring on off-route drivers
      pinEl.classList.toggle('alert',c.status==='off');
      pinEl.classList.toggle('halted',!!halts[c.id]);
      const stale=c.status==='offline';pinEl.classList.toggle('stale',stale);
      let seenTag=pinEl.querySelector('.seen-tag');
      if(stale&&Number.isFinite(Number(c.silentSec))){if(!seenTag){seenTag=document.createElement('span');seenTag.className='seen-tag';pinEl.appendChild(seenTag)}seenTag.textContent='no signal · '+agoText(Number(c.silentSec))}
      else if(seenTag)seenTag.remove();
      bounds.extend([c.lon,c.lat]);
    }
    const status=c.status||'offline',gap=Number(c.gapKm);
    let detail=LABEL[status]||status;
    if(status==='offline'&&Number.isFinite(Number(c.silentSec)))detail='No signal · last seen '+agoText(Number(c.silentSec));
    if(Number.isFinite(gap)&&gap>0)detail=gap.toFixed(1)+' km'+(Number.isFinite(Number(c.gapMin))?' · '+fmtMins(c.gapMin):'')+' behind';
    if(c.approx)detail='Approximate location (weak GPS)'+(detail?' · '+detail:'');
    if(status==='waiting')detail='Waiting for their GPS…';
    if(c.etaMin!==null&&c.etaMin!==undefined)detail+=' · '+c.etaMin+' min';
    const row=`<div class="row"><div class="person">${avatarHtml(c)}<div><b>${esc(c.name||'Driver')}${c.id===socket.id?' (you)':''}</b>${c.role?`<span class="role-chip ${esc(c.role)}">${esc(ROLE_LABEL[c.role]||'')}</span>`:''}<br><small>${esc(detail)}</small></div></div><div class="row-actions">${status!=='waiting'&&(c.id!==socket.id||iAmCreator)?`<button type="button" class="mini-btn" data-act="menu" data-id="${esc(c.id)}" aria-label="Options for ${esc(c.name||'driver')}">Options</button>`:''}<span class="status ${esc(status)}">${esc(LABEL[status]||status)}</span></div></div>`;
    $('statuscars').insertAdjacentHTML('beforeend',row);
  });
  Object.keys(markers).forEach(id=>{if(!seen.has(id)){cancelAnimationFrame(glides.get(id));markers[id].remove();delete markers[id]}});
  if(follow&&!headingUp&&cars.length&&!bounds.isEmpty())map.fitBounds(bounds,{padding:100,maxZoom:15,duration:500});
  Object.keys(halts).forEach(id=>{if(id!==socket.id&&!seen.has(id))delete halts[id]});
  checkRegroupArrival();renderHalts();checkArrivals(cars);
  // NEW: animated count-up for the metrics
  ['memberCount','smembers','umembers'].forEach(id=>animateNumber($(id),cars.length));
  ['onroute','sonroute','uonroute'].forEach(id=>animateNumber($(id),on));
  ['gap','sgap','ugap'].forEach(id=>animateNumber($(id),maxGap,1,' km'));
  {const gm=Math.max(0,...cars.map(c=>Number(c.gapMin)).filter(Number.isFinite)),sm=$('gap').parentElement.querySelector('small');if(sm)sm.textContent=gm>0?'about '+gm+' min behind':'Distance behind'}
  if(!cars.length){$('statuscars').textContent='Waiting for convoy members…'}
});

socket.on('alert',a=>{
  const who=a.id===socket.id?'You':esc(a.name||'A convoy member');
  if(a.type==='missed-turn'){
    const r=a.rejoin;
    showBanner(`<b>${who} missed a turn</b>${Number(a.offMeters)||0} m off route.`+
      (r?`<br>Suggested: ${esc(r.kind)} at km ${esc(r.km)}.`:''),'warn',10000);
    if(a.id===socket.id&&navVoiceOn&&(speechOK||cloudVoice)){try{navigator.vibrate&&navigator.vibrate([300,100,300])}catch{}navMissedTurn()}
    else{announce(`${a.id===socket.id?'You':(a.name||'A driver')} missed a turn`,[300,100,300]);if(a.id===socket.id){navLastRouteAt=0;if(navOpen||navDriving||navTrip)navFetchDirections()}}
    if(rejoinMarker)rejoinMarker.remove();rejoinMarker=null;
    if(r&&map&&Array.isArray(r.point)){
      const el=document.createElement('div');el.className='rejoin';el.textContent='Rejoin here';
      rejoinMarker=new maplibregl.Marker({element:el}).setLngLat(r.point).addTo(map);
    }
  }else if(a.type==='rejoined'){
    showBanner(`<b>${who} is back on route</b>Convoy whole again.`,'ok',5000);
    announce(`${a.id===socket.id?'You are':(a.name||'A driver')+' is'} back on route`,[120]);
    if(rejoinMarker){rejoinMarker.remove();rejoinMarker=null}
  }else if(a.type==='gap'){
    const gwho=a.role==='sweeper'?'Sweeper '+(a.name||'driver'):(a.name||'A driver'),gmin=Number.isFinite(Number(a.gapMin))?' (about '+a.gapMin+' min)':'';
    showBanner(`<b>${esc(gwho)} is ${esc(a.gapKm)} km behind${esc(gmin)}</b>${a.role==='sweeper'?'The last car is falling behind. Slow down and regroup.':'The convoy is spreading out.'}`,'warn',8000);
    announce(`${gwho} is ${a.gapKm} kilometres behind`,[250,100,250]);
    suggestRegroup(a);
  }
});
async function shareInvite(){
  if(!session)return;
  const url=new URL(inviteLink(session.code));
  const text=`Join my ONEROUTE convoy\nLink: ${url}\nCode: ${session.code}`;
  try{
    if(navigator.share)await navigator.share({title:'Join ONEROUTE',text,url:String(url)});
    else{await navigator.clipboard.writeText(text);showBanner('<b>Invite copied</b>Send it to your group.','ok',4000)}
  }catch(e){if(e.name!=='AbortError')window.prompt('Copy invite',text)}
}
$('share').onclick=shareInvite;
$('copy').onclick=async()=>{
  try{await navigator.clipboard.writeText(session.code);showBanner('<b>Trip code copied</b>'+esc(session.code),'ok',3000)}
  catch{window.prompt('Copy trip code',session.code)}
};
const invite=new URLSearchParams(location.search).get('code');
const inviteCode=invite?invite.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4):'';
if(inviteCode)$('code').value=inviteCode;
$('quickStopToggle').onclick=()=>{
  const menu=$('quickStopMenu');menu.hidden=!menu.hidden;
  $('quickStopToggle').setAttribute('aria-expanded',String(!menu.hidden));
};
$('closeQuickStop').onclick=()=>{$('quickStopMenu').hidden=true;$('quickStopToggle').setAttribute('aria-expanded','false')};
document.querySelectorAll('[data-stop-query]').forEach(button=>button.addEventListener('click',()=>{
  const query=button.dataset.stopQuery;
  $('quickStopMenu').hidden=true;$('quickStopToggle').setAttribute('aria-expanded','false');
  if(!pendingTrip||!session){showBanner('<b>No active trip</b>Create or join a convoy first.','warn',4500);return}
  $('app').hidden=true;$('nav').hidden=true;$('planner').hidden=false;
  if(!plannerMap)openPlanner(pendingTrip);else setTimeout(()=>plannerMap?.resize(),80);
  $('waypointSearch').value=query;$('searchWaypoint').click();
}));
// ===== NEW: map features (roles, ping, note pins, help nearby, weather, route options, map styles) =====
let iAmCreator=false;
const ROLE_LABEL={leader:'Lead car',sweeper:'Sweeper'};
const fmtMins=n=>{n=Number(n);return n<1?'<1 min':n+' min'};
const fmtRouteDur=m=>m<60?m+' min':Math.floor(m/60)+' h '+(m%60)+' min';
const sheetIds=['driverSheet','pinSheet','helpSheet'];
function closeSheets(except){sheetIds.forEach(id=>{if(id!==except)$(id).hidden=true});helpShownId=except==='helpSheet'?helpShownId:null}

// --- Driver options: ping, and (trip creator) leader / sweeper roles ---
function openDriverSheet(id){
  const c=lastCars.find(x=>x.id===id);if(!c)return;
  closeSheets('driverSheet');
  const box=$('driverSheet');box.replaceChildren();
  const title=mk('h2','',(c.name||'Driver')+(id===socket.id?' (you)':''));title.id='driverTitle';
  const info=mk('p','subtitle',[c.role?ROLE_LABEL[c.role]:'',LABEL[c.status]||c.status,Number.isFinite(Number(c.gapKm))&&c.gapKm>0?c.gapKm.toFixed(1)+' km · '+fmtMins(c.gapMin)+' behind':''].filter(Boolean).join(' · '));
  const actions=mk('div','sheet-actions');
  if(id!==socket.id){
    const ping=mk('button','','📍 Ping: where are you?');ping.type='button';
    ping.onclick=()=>socket.emit('ping-driver',{targetId:id},res=>{showNotice(res&&res.ok?'Pinged '+(c.name||'driver'):(res&&res.error)||'Could not ping.',res&&res.ok?'ok':undefined);if(res&&res.ok)closeSheets()});
    actions.append(ping);
  }
  if(iAmCreator){
    [['leader','Make lead car'],['sweeper','Make sweeper'],['auto','Automatic role']].forEach(([role,label])=>{
      if(role==='auto'?!c.roleSet:c.roleSet===role)return;
      const b=mk('button','secondary',label);b.type='button';
      b.onclick=()=>socket.emit('set-role',{memberId:id,role},res=>{showNotice(res&&res.ok?'Role updated.':(res&&res.error)||'Could not set the role.',res&&res.ok?'ok':undefined);if(res&&res.ok)closeSheets()});
      actions.append(b);
    });
  }
  const close=mk('button','secondary','Close');close.type='button';close.onclick=()=>closeSheets();actions.append(close);
  box.append(title,info,actions);box.hidden=false;
  const first=box.querySelector('button');if(first)first.focus();
}
$('statuscars').addEventListener('click',e=>{const b=e.target.closest('[data-act="menu"]');if(b)openDriverSheet(b.dataset.id)});
function flashPin(id){const m=markers[id];if(!m)return;const el=m.getElement();el.classList.add('pinged');setTimeout(()=>el.classList.remove('pinged'),7000)}
socket.on('ping',m=>{
  if(!m)return;flashPin(m.targetId);
  if(m.targetId===socket.id){
    try{navigator.vibrate&&navigator.vibrate([400,150,400,150,400])}catch{}
    showBanner(`<b>📍 ${esc(m.fromName)} is asking: Where are you?</b>Your pin is flashing on everyone's map.`,'warn',9000);
    announce(`${m.fromName} is asking where you are.`,[400,150,400]);
  }else showNotice((m.fromName||'Someone')+' pinged '+(m.targetName||'a driver'),'ok');
});

// --- Note pins & Hazard Crowd-Sourcing ---
const PIN_KINDS=[
  ['good','👍','Good place'],['food','☕','Food / chai'],['police','🚓','Police / Speed Trap'],
  ['hazard','⚠️','Hazard / Danger'],['pothole','🕳️','Pothole'],['accident','💥','Accident'],
  ['fuel','⛽','Fuel / EV'],['bad','⛔','Bad road'],['photo','📷','Photo spot'],['other','📍','Other']
];
const PIN_ICON=Object.fromEntries(PIN_KINDS.map(k=>[k[0],k[1]]));
const pinsStore=new Map(),pinMarkers=new Map();
let pinKind='hazard',dropMode=false;
function renderPinKinds(){
  const row=$('pinKinds');row.replaceChildren();
  PIN_KINDS.forEach(([k,icon,label])=>{const b=mk('button','',icon+' '+label);b.type='button';b.setAttribute('role','radio');b.setAttribute('aria-checked',String(k===pinKind));b.onclick=()=>{pinKind=k;renderPinKinds()};row.append(b)});
}
function syncPins(){
  if(!map)return;
  for(const [id,p] of pinsStore){
    if(pinMarkers.has(id))continue;
    const el=mk('div','note-pin');el.append(mk('span','',PIN_ICON[p.kind]||'📍'));el.tabIndex=0;el.setAttribute('role','button');el.setAttribute('aria-label',(p.text||'Pin')+' by '+p.name);
    const popup=new maplibregl.Popup({offset:22,closeButton:true});
    const open=()=>{
      const box=mk('div','');box.style.cssText='color:#17191d;font:14px system-ui;max-width:240px';
      const t=mk('b','',p.text||(PIN_KINDS.find(k=>k[0]===p.kind)||[])[2]||'Pin');
      const by=mk('div','','by '+p.name+' · '+new Date(p.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}));by.style.cssText='font-size:12px;opacity:.7;margin:2px 0 6px';
      box.append(t,by);

      // Hazard Verification / Voting
      const voteRow=mk('div','');voteRow.style.cssText='display:flex;gap:6px;margin:8px 0';
      const upBtn=mk('button','mini-btn','👍 Still there '+(p.upvotes?.length||1));
      upBtn.type='button';
      upBtn.onclick=()=>socket.emit('vote-pin',{id:p.id,vote:'up'},res=>{if(res&&res.ok){p.upvotes=new Array(res.upvotes);popup.remove();open()}});
      const downBtn=mk('button','mini-btn','✕ Cleared '+(p.downvotes?.length||0));
      downBtn.type='button';
      downBtn.onclick=()=>socket.emit('vote-pin',{id:p.id,vote:'down'},res=>{if(res&&res.ok){if(res.removed){popup.remove()}else{p.downvotes=new Array(res.downvotes);popup.remove();open()}}});
      voteRow.append(upBtn,downBtn);
      box.append(voteRow);

      // Propose Stop button if near food or fuel
      if(['food','fuel','good'].includes(p.kind)){
        const stopBtn=mk('button','mini-btn','Propose Stop Here');
        stopBtn.style.cssText='background:#f4c430;color:#17191d;margin-bottom:6px;width:100%';
        stopBtn.onclick=()=>{
          socket.emit('propose-stop',{lat:p.lat,lon:p.lon,label:p.text||p.name+' stop'},res=>{
            popup.remove();
            if(res&&res.ok)showNotice('Stop proposal sent to convoy.','ok');
            else showNotice((res&&res.error)||'Could not propose stop.');
          });
        };
        box.append(stopBtn);
      }

      if(authUser&&(p.userId===authUser.id||iAmCreator)){
        const rm=mk('button','mini-btn','Remove pin');
        rm.type='button';
        rm.onclick=()=>socket.emit('remove-pin',{id},res=>{if(!res||!res.ok)showNotice((res&&res.error)||'Could not remove it.')});
        box.append(rm);
      }
      popup.setDOMContent(box).setLngLat([p.lon,p.lat]).addTo(map);
    };
    el.addEventListener('click',e=>{e.stopPropagation();open()});el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}});
    pinMarkers.set(id,new maplibregl.Marker({element:el,anchor:'bottom'}).setLngLat([p.lon,p.lat]).addTo(map));
  }
  for(const [id,m] of pinMarkers)if(!pinsStore.has(id)){m.remove();pinMarkers.delete(id)}
}
socket.on('pins-history',list=>{pinsStore.clear();(Array.isArray(list)?list:[]).forEach(p=>pinsStore.set(p.id,p));syncPins()});
socket.on('pin-added',p=>{if(!p)return;pinsStore.set(p.id,p);syncPins();if(p.userId!==(authUser&&authUser.id))showNotice((PIN_ICON[p.kind]||'📍')+' '+p.name+': '+(p.text||'dropped a pin'),'ok')});
socket.on('pin-updated',m=>{if(!m)return;const p=pinsStore.get(m.id);if(p){p.upvotes=new Array(m.upvotes);p.downvotes=new Array(m.downvotes)}});
socket.on('pin-removed',m=>{if(m){pinsStore.delete(m.id);syncPins();if(m.reason==='cleared')showNotice('Hazard marked as cleared.','ok')}});
function sendPin(lat,lon){
  socket.emit('drop-pin',{lat,lon,text:$('pinNote').value,kind:pinKind},res=>{
    if(res&&res.ok){$('pinNote').value='';closeSheets();showNotice('Pin shared with the convoy.','ok')}else showNotice((res&&res.error)||'Could not drop the pin.');
  });
}
$('pinToggle').onclick=()=>{closeSheets('pinSheet');renderPinKinds();$('pinSheet').hidden=false;$('pinToggle').setAttribute('aria-expanded','true');$('pinNote').focus()};
$('pinCancel').onclick=()=>{closeSheets();cancelDrop()};
$('pinHere').onclick=()=>{if(!lastGps){showNotice('Still waiting for your GPS location.');return}sendPin(lastGps.lat,lastGps.lon)};
$('pinChoose').onclick=()=>{
  if(!map)return;dropMode=true;$('pinSheet').hidden=true;map.getCanvas().style.cursor='crosshair';showNotice('Tap the map where the pin should go. Press Esc to cancel.','ok');
  map.once('click',e=>{if(!dropMode)return;cancelDrop();sendPin(e.lngLat.lat,e.lngLat.lng)});
};
function cancelDrop(){dropMode=false;if(map)map.getCanvas().style.cursor='';$('pinToggle').setAttribute('aria-expanded','false')}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeSheets();if(dropMode)cancelDrop()}});

// --- Group Stop Proposal & Voting ---
let currentStopProposal = null;
function openStopVote(prop){
  if(!prop)return;
  currentStopProposal = prop;
  $('stopVoteSubtitle').textContent = (prop.proposerName || 'A driver') + ' proposed a stop:';
  $('stopVoteDetails').textContent = '📍 ' + (prop.label || 'Planned Stop');
  $('stopVoteYes').textContent = prop.votesYes ? prop.votesYes.length : 1;
  $('stopVoteNo').textContent = prop.votesNo ? prop.votesNo.length : 0;
  closeSheets('stopVoteSheet');
  $('stopVoteSheet').hidden = false;
}

$('stopVoteYesBtn').onclick = () => {
  if(!currentStopProposal) return;
  socket.emit('vote-stop', { id: currentStopProposal.id, vote: 'yes' }, res => {
    if(res && res.ok){
      showNotice('Voted Yes for stop.', 'ok');
      $('stopVoteSheet').hidden = true;
    }
  });
};

$('stopVoteNoBtn').onclick = () => {
  if(!currentStopProposal) return;
  socket.emit('vote-stop', { id: currentStopProposal.id, vote: 'no' }, res => {
    if(res && res.ok){
      showNotice('Voted No for stop.', 'ok');
      $('stopVoteSheet').hidden = true;
    }
  });
};

socket.on('stop-proposal', prop => {
  if(!prop) return;
  showBanner(`<b>☕ Stop Proposed:</b> ${esc(prop.proposerName)} proposed: "${esc(prop.label)}"`, 'ok', 10000);
  announce(`${prop.proposerName} proposed a convoy stop at ${prop.label}`);
  openStopVote(prop);
});

socket.on('stop-vote-update', upd => {
  if(currentStopProposal && currentStopProposal.id === upd.id){
    $('stopVoteYes').textContent = upd.yes;
    $('stopVoteNo').textContent = upd.no;
    $('stopVoteNeeded').textContent = upd.required;
  }
});

socket.on('stop-proposal-result', res => {
  $('stopVoteSheet').hidden = true;
  if(res.result === 'approved'){
    showBanner(`<b>✅ Stop Approved!</b> Stop at "${esc(res.label)}" added to convoy route.`, 'ok', 10000);
    announce(`Convoy agreed to stop at ${res.label}`);
  } else {
    showNotice(`Convoy voted against stopping at "${res.label}".`);
  }
  currentStopProposal = null;
});

// --- Nearest help when someone taps SOS ---
const helpData={};let helpShownId=null;
function openHelp(id){closeSheets('helpSheet');helpShownId=id;$('helpSheet').hidden=false;renderHelp()}
function closeHelp(){$('helpSheet').hidden=true;helpShownId=null}
$('helpClose').onclick=closeHelp;
function updateHelpButton(){$('helpOpen').hidden=!Object.keys(sosActive).length}
$('helpOpen').onclick=()=>{const id=Object.keys(sosActive)[0];if(id)openHelp(id)};
function renderHelp(){
  const id=helpShownId,s=sosActive[id],entry=helpData[id],body=$('helpBody');
  if(!s){closeHelp();return}
  $('helpWho').textContent=(id===socket.id?'You asked':s.name+' asked')+' for help. Call 112 for an emergency.';
  body.replaceChildren();
  if(!entry){orbRow(body,'Finding the nearest help…','searching');return}
  if(!entry.help){body.append(mk('p','subtitle','Could not look up nearby help. Call 112.'));return}
  [['hospital','🏥 Hospitals'],['police','🚓 Police stations'],['garage','🔧 Garages']].forEach(([k,title])=>{
    const g=mk('div','help-group');g.append(mk('h3','',title));
    const list=entry.help[k]||[];
    if(!list.length)g.append(mk('p','subtitle','None found within 20 km.'));
    list.forEach(it=>{
      const row=mk('div','help-item'),left=mk('div','');left.append(mk('b','',it.name),mk('br',''),mk('small','',it.distKm+' km away'));
      const right=mk('div','');
      if(it.phone&&/^\+?\d{5,15}$/.test(it.phone)){const a=mk('a','','📞 Call');a.href='tel:'+it.phone;right.append(a,document.createTextNode(' '))}
      if(Number.isFinite(it.lat)&&Number.isFinite(it.lon)){const a=mk('a','','Directions');a.href='https://www.google.com/maps/dir/?api=1&destination='+it.lat+','+it.lon;a.target='_blank';a.rel='noopener noreferrer';right.append(a)}
      row.append(left,right);g.append(row);
    });
    body.append(g);
  });
  body.append(mk('small','muted','From OpenStreetMap data. It may be incomplete, so call 112 first in an emergency.'));
}

// --- Weather on the route (Open-Meteo, fetched by the server) ---
let weatherTimer=null;const rainWarned=new Set();
function startWeather(){setTimeout(loadWeather,2500);clearInterval(weatherTimer);weatherTimer=setInterval(loadWeather,20*60*1000)}
function loadWeather(){
  socket.emit('get-weather',{},res=>{
    const list=$('weatherList');list.replaceChildren();
    if(!res||!res.ok){list.append(mk('p','subtitle',(res&&res.error)||'Weather is not available right now.'));return}
    const soon=[];
    res.points.forEach(w=>{
      const row=mk('div','weather-row'),left=mk('div','');
      left.append(mk('b','',(w.icon||'')+' '+w.label),mk('small','',w.kind==='destination'?'Destination':'Stop'));
      const rain=w.rainInHours!==null&&w.rainInHours<=6?'☔ Rain likely '+(w.rainInHours===0?'now':'in about '+w.rainInHours+' h'):'Rain chance up to '+(w.rainMaxPct??'?')+'%';
      const right=mk('div','');right.style.textAlign='right';right.append(mk('b','',(w.tempC===null?'':w.tempC+'°C ')+w.text),mk('small','',rain));
      row.append(left,right);list.append(row);
      if(w.rainInHours!==null&&w.rainInHours<=3)soon.push(w);
    });
    const alertEl=$('weatherAlert');
    if(soon.length){alertEl.hidden=false;alertEl.textContent='☔ Rain likely at '+soon.map(w=>w.label.split(',')[0]).join(', ')+' in the next few hours.';
      const key=soon.map(w=>w.label).join('|');if(!rainWarned.has(key)){rainWarned.add(key);showBanner('<b>☔ Rain ahead</b>'+esc(alertEl.textContent.replace('☔ ','')),'warn',9000)}}
    else alertEl.hidden=true;
  });
}
$('weatherRefresh').onclick=loadWeather;
socket.on('route-updated',()=>setTimeout(loadWeather,800));

// --- Route options (planner) ---
let routeOptions=[],routeChosen=0;
$('compareRoutes').onclick=()=>{
  if(plannedWaypoints.length){showNotice('Remove the extra stops first. Stops build their own route.');return}
  const job=busyStart('Finding route options…','solving','Comparing the fastest roads.');
  socket.emit('route-options',{},res=>{
    job.stop();
    if(!res||!res.ok){showNotice((res&&res.error)||'Could not look up route options.');return}
    routeOptions=res.options;routeChosen=res.current;renderRouteOptions();drawAlternatives();
  });
};
function renderRouteOptions(){
  const box=$('routeOptions');box.replaceChildren();
  routeOptions.forEach(o=>{
    const label=mk('label','route-option'),input=document.createElement('input');
    input.type='radio';input.name='routeOption';input.checked=o.index===routeChosen;
    input.onchange=()=>chooseRoute(o.index);
    label.append(input,mk('span','','Route '+(o.index+1)+' · '+o.distanceKm+' km · '+fmtRouteDur(o.durationMin)+(o.fastest?' · fastest':'')));
    box.append(label);
  });
}
function chooseRoute(index){
  const job=busyStart('Switching route…','working');
  socket.emit('choose-route',{index},res=>{
    job.stop();
    if(!res||!res.ok){showNotice((res&&res.error)||'Could not switch route.');renderRouteOptions();return}
    routeChosen=index;pendingTrip={...pendingTrip,...res};drawPlannerRoute();drawAlternatives();showNotice('Route '+(index+1)+' selected.','ok');
  });
}
function drawAlternatives(){
  if(!plannerMap||!plannerMap.isStyleLoaded())return;
  const data={type:'FeatureCollection',features:routeOptions.filter(o=>o.index!==routeChosen).map(o=>({type:'Feature',geometry:{type:'LineString',coordinates:o.path},properties:{}}))};
  if(plannerMap.getSource('alt-routes'))plannerMap.getSource('alt-routes').setData(data);
  else{plannerMap.addSource('alt-routes',{type:'geojson',data});plannerMap.addLayer({id:'alt-routes-line',type:'line',source:'alt-routes',paint:{'line-color':'#9aa3b2','line-width':4,'line-dasharray':[2,2]}},plannerMap.getLayer('planned-route-line')?'planned-route-line':undefined)}
}

// --- Map styles: satellite, and heading-up ---
let satOn=false,headingUp=false,lastHeading=null,prevPt=null;
let navDriving=false,navPayload=null,lastSpeedKmh=null;
let lastFixAt=0,chosenStart=null,navTotals=null;
let navFollow=true,navCameraInit=false,navMeMarker=null,navRecenterBtn=null;
let navTrip=false,navPreview=false,onPosition=null,gpsMode=null,gpsErrorCode=null,lastRealFixAt=0,manualTimer=null,approxShown=false;
try{satOn=localStorage.getItem('oneroute-sat')==='1';headingUp=localStorage.getItem('oneroute-headingup')==='1'}catch{}
if(!satelliteAvailable){satOn=false;const sb=$('styleToggle');if(sb)sb.hidden=true}
function applySat(m){
  if(!m||!satelliteAvailable)return;
  setSatellite(m,satOn);
  showAttributionBriefly(m);
}
// A satellite button inside each map (planner, main, navigation). They all share one saved preference.
let satFabs=[];
function addSatFab(m){
  if(!satelliteAvailable||!m)return;
  const host=m.getContainer();
  host.querySelectorAll('.map-sat-fab').forEach(x=>x.remove());
  const b=document.createElement('button');b.type='button';b.className='map-sat-fab';
  b.onclick=()=>{satOn=!satOn;try{localStorage.setItem('oneroute-sat',satOn?'1':'0')}catch{}applySat(map);applySat(navMap);applySat(plannerMap);syncStyleButtons()};
  host.appendChild(b);satFabs.push(b);
  m.on('load',()=>applySat(m));
  syncStyleButtons();
}
function syncStyleButtons(){
  satFabs=satFabs.filter(b=>b.isConnected);
  satFabs.forEach(b=>{b.textContent=satOn?'🗺 Map view':'🛰 Satellite';b.setAttribute('aria-pressed',String(satOn))});
  $('styleToggle').textContent=satOn?'🗺 Map view':'🛰 Satellite';$('styleToggle').setAttribute('aria-pressed',String(satOn));
  $('headingToggle').textContent='🧭 Heading up: '+(headingUp?'ON':'OFF');$('headingToggle').setAttribute('aria-pressed',String(headingUp));
}
$('styleToggle').onclick=()=>{satOn=!satOn;try{localStorage.setItem('oneroute-sat',satOn?'1':'0')}catch{}applySat(map);applySat(navMap);applySat(plannerMap);syncStyleButtons()};
$('headingToggle').onclick=()=>{
  headingUp=!headingUp;try{localStorage.setItem('oneroute-headingup',headingUp?'1':'0')}catch{}syncStyleButtons();
  if(!map)return;
  if(headingUp){showNotice('The map turns to face the way you are driving.','ok');applyHeading()}else map.easeTo({bearing:0,duration:500});
};
syncStyleButtons();
function bearingBetween(a,b){const r=x=>x*Math.PI/180,y=Math.sin(r(b[1]-a[1]))*Math.cos(r(b[0])),x=Math.cos(r(a[0]))*Math.sin(r(b[0]))-Math.sin(r(a[0]))*Math.cos(r(b[0]))*Math.cos(r(b[1]-a[1]));return (Math.atan2(y,x)*180/Math.PI+360)%360}
function noteHeading(p){
  const c=p.coords;
  if(Number.isFinite(c.heading)&&Number.isFinite(c.speed)&&c.speed>1.5)lastHeading=c.heading;
  else if(prevPt){const dLat=(c.latitude-prevPt[0])*111320,dLon=(c.longitude-prevPt[1])*111320*Math.cos(c.latitude*Math.PI/180);if(Math.hypot(dLat,dLon)>12){lastHeading=bearingBetween(prevPt,[c.latitude,c.longitude]);prevPt=[c.latitude,c.longitude]}}
  if(!prevPt)prevPt=[c.latitude,c.longitude];
  if(headingUp)applyHeading();
}
function applyHeading(){
  if(!map||!lastGps)return;
  map.easeTo({center:[lastGps.lon,lastGps.lat],bearing:lastHeading===null?map.getBearing():lastHeading,zoom:Math.max(map.getZoom(),14.5),duration:800});
}

// ===== NEW: map credit folds away after a few seconds (tap the (i) to read it again) =====
function collapseAttribution(m){
  const el=m&&m.getContainer&&m.getContainer().querySelector('.maplibregl-ctrl-attrib');
  if(el){el.classList.add('maplibregl-compact');el.classList.remove('maplibregl-compact-show');el.removeAttribute('open')}
}
function showAttributionBriefly(m,ms=5000){
  const el=m&&m.getContainer&&m.getContainer().querySelector('.maplibregl-ctrl-attrib');
  if(!el)return;
  el.classList.add('maplibregl-compact','maplibregl-compact-show');el.setAttribute('open','');
  clearTimeout(m.__attribTimer);m.__attribTimer=setTimeout(()=>collapseAttribution(m),ms);
}
if(!maplibregl.__oneroute){
  const BaseMap=maplibregl.Map;
  maplibregl.Map=class extends BaseMap{
    constructor(options){
      super({...options,attributionControl:false});
      this.addControl(new maplibregl.AttributionControl({compact:true,customAttribution:'<a href="https://maplibre.org/" target="_blank" rel="noopener noreferrer">MapLibre</a>'}));
      this.once('load',()=>showAttributionBriefly(this));
    }
  };
  maplibregl.__oneroute=true;
}

// ===== NEW: compact navigation. A slim bar; tap it for trip details and buttons. Convoy and turns live in a pull-up sheet. =====
(function compactNavigation(){
  const screen=$('navigationScreen'),turn=screen&&screen.querySelector('.nav-turn'),drawer=screen&&screen.querySelector('.navtop'),sheet=screen&&screen.querySelector('.nav-bottom');
  if(!turn||!drawer||!sheet)return;
  drawer.id='navDrawer';
  const toggle=document.createElement('button');toggle.type='button';toggle.id='navBarToggle';toggle.setAttribute('aria-controls','navDrawer');
  const quick=document.createElement('div');quick.className='nav-quick';
  const sos=$('navSos'),exit=$('closeNavigation');
  sos.textContent='🆘';exit.textContent='✕';
  quick.append(sos,toggle,exit);turn.append(quick);
  let timer=null;
  function setDrawer(open){
    screen.classList.toggle('nav-expanded',open);
    toggle.setAttribute('aria-expanded',String(open));toggle.textContent=open?'⌃':'⌄';
    toggle.setAttribute('aria-label',open?'Hide trip details':'Show trip details and controls');
    clearTimeout(timer);if(open)timer=setTimeout(()=>setDrawer(false),9000); // tidies itself away after a few seconds
  }
  toggle.onclick=e=>{e.stopPropagation();setDrawer(!screen.classList.contains('nav-expanded'))};
  turn.addEventListener('click',e=>{if(!e.target.closest('button'))setDrawer(!screen.classList.contains('nav-expanded'))});
  drawer.addEventListener('pointerdown',()=>{if(screen.classList.contains('nav-expanded')){clearTimeout(timer);timer=setTimeout(()=>setDrawer(false),9000)}});
  setDrawer(false);

  const handle=document.createElement('button');handle.type='button';handle.className='nav-sheet-handle';handle.id='navSheetToggle';
  handle.setAttribute('aria-expanded','false');handle.setAttribute('aria-controls','navConvoy');
  handle.innerHTML='<span class="grab" aria-hidden="true"></span><span>👥 Convoy and upcoming turns</span><span class="chev" aria-hidden="true">▲</span>';
  sheet.prepend(handle);
  function setSheet(open){
    sheet.classList.toggle('open',open);handle.setAttribute('aria-expanded',String(open));
    setTimeout(()=>{if(navMap)navMap.resize()},260);
  }
  handle.onclick=()=>setSheet(!sheet.classList.contains('open'));
  $('openNavigation').addEventListener('click',()=>{setDrawer(false);setSheet(false)});
  if(window.ResizeObserver)new ResizeObserver(()=>screen.style.setProperty('--bar-h',turn.offsetHeight+'px')).observe(turn);
})();

// ===== invite link helpers =====
function inviteLink(code){return location.origin+'/?code='+encodeURIComponent(code)}
function inviteText(code){return '🚗 Join my OneRoute convoy!\nTrip code: '+code+'\nOpen: '+inviteLink(code)+'\nSign in (or create an account), tick the location box and tap “Join trip”.'}

// ===== NEW: profile pictures (shown on the map and in lists instead of the first letter) =====
const AVATAR_RE=/^\/avatar\/[a-f0-9]{32}\.jpg$/;
const safeAvatar=url=>typeof url==='string'&&AVATAR_RE.test(url)?url:null;
function pulseConnectedDriver(marker, car) {
  const online = !!car.status && car.status !== 'offline';
  const wasOnline = marker.dataset.online === 'true';
  marker.dataset.online = String(online);
  if (!online || wasOnline || car.id === socket.id || prefersReducedMotion()) return;
  marker.animate?.(
    [{ outline: '3px solid #f4c430', outlineOffset: '0px' },
     { outline: '0px solid transparent', outlineOffset: '12px' }],
    { duration: 480, easing: 'ease-out' },
  );
}

function paintPin(el,c){
  pulseConnectedDriver(el, c);
  const color=COLORS[c.status]||COLORS.offline,url=safeAvatar(c.avatar);
  if(url){
    el.classList.add('photo');
    if(el.dataset.photo!==url){el.dataset.photo=url;el.style.backgroundImage='url("'+url+'")'}
    el.style.backgroundColor='#23262d';el.style.setProperty('--ring',color);
  }else{
    el.classList.remove('photo');el.dataset.photo='';el.style.backgroundImage='';
    el.style.background=color;el.style.removeProperty('--ring');
  }
}
function avatarHtml(c){
  const url=safeAvatar(c.avatar);
  return url?`<div class="avatar photo" style="background-image:url('${url}')"></div>`:`<div class="avatar">${esc(String(c.name||'?')[0].toUpperCase())}</div>`;
}
function miniAvatarHtml(c,color){
  const url=safeAvatar(c.avatar);
  return url?`<span class="mini-avatar photo" style="background-image:url('${url}');--ring:${color}"></span>`:`<span class="mini-avatar" style="background:${color}">${esc(String(c.name||'?').slice(0,1).toUpperCase())}</span>`;
}
// Crops the middle square of any photo and shrinks it to a small JPEG (also strips location data from the picture).
const uploadAvatar=(blob,token)=>uploadAvatarWith(blob,token||authToken);
function renderAccountPhoto(){
  const url=safeAvatar(authUser&&authUser.avatar);
  $('acctAvatarImg').hidden=!url;if(url)$('acctAvatarImg').src=url;
  $('acctAvatarLetter').hidden=!!url;$('acctAvatarLetter').textContent=String((authUser&&authUser.name)||'?')[0].toUpperCase();
  $('acctChange').textContent=url?'Change photo':'Add photo';$('acctRemove').hidden=!url;
}
function photoMessage(text,ok){$('acctPhotoMsg').textContent=text||'';$('acctPhotoMsg').classList.toggle('ok',!!ok)}
$('acctAvatar').onclick=()=>$('acctPhotoFile').click();
$('acctChange').onclick=()=>$('acctPhotoFile').click();
$('acctPhotoFile').onchange=async e=>{
  const file=e.target.files&&e.target.files[0];e.target.value='';
  if(!file)return;
  photoMessage('Saving your photo…',true);
  try{
    authUser=await uploadAvatar(await squareJpeg(file));
    renderAccountPhoto();photoMessage('Photo saved. It shows on the map when you join a trip.',true);
  }catch(err){photoMessage(err instanceof TypeError?'Could not reach the server.':err.message)}
};
$('acctRemove').onclick=async()=>{
  photoMessage('Removing…',true);
  try{
    const r=await fetch('/api/avatar',{method:'DELETE',headers:authHeaders()});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.error||'Could not remove the photo.');
    authUser=data.user;renderAccountPhoto();photoMessage('Photo removed.',true);
  }catch(err){photoMessage(err.message)}
};
// ===== NEW: accounts (sign in, create account, stay signed in) =====
function storeToken(token,remember){
  authToken=token;
  try{localStorage.removeItem(AUTH_KEY);sessionStorage.removeItem(AUTH_KEY);(remember?localStorage:sessionStorage).setItem(AUTH_KEY,token)}catch{}
}
function clearToken(){authToken='';try{localStorage.removeItem(AUTH_KEY);sessionStorage.removeItem(AUTH_KEY)}catch{}}
function enterApp(user){
  authUser=user;$('setup').hidden=false;
  $('acctName').textContent=user.name;renderAccountPhoto();photoMessage('');syncDeleteUi(user);
  if(!$('name').value.trim())$('name').value=user.name;
  if(!socket.connected)socket.connect();
  loadVoiceInfo();
  if(inviteCode.length===4&&!session)setTimeout(()=>{showNotice('Invite found: trip '+inviteCode+'. Tick the location box, then press Join trip.','ok');$('join').scrollIntoView({behavior:'smooth',block:'center'})},500);
}
$('signOut').onclick=async()=>{
  try{await fetch('/api/logout',{method:'POST',headers:authHeaders()})}catch{}
  clearToken();socket.disconnect();location.reload();
};
// A login that was revoked or expired while away: go back to the sign-in screen.
socket.on('connect_error',err=>{if(err&&err.message==='unauthorized'){clearToken();location.reload()}});
// Accounts that only use Google have no password: deleting asks them to type DELETE instead
function syncDeleteUi(user){
  const noPw=user&&user.hasPassword===false;
  $('deleteLabel').textContent=noPw?'Type DELETE to confirm':'Enter your password to confirm';
  $('deletePassword').type=noPw?'text':'password';$('deletePassword').autocomplete='off';
}
// Delete my account (asks for the password first)
function closeDeletePanel(){$('deletePanel').hidden=true;$('deletePassword').value='';$('deleteError').textContent='';$('acctDelete').focus()}
$('acctDelete').onclick=()=>{$('deletePanel').hidden=false;$('deleteError').textContent='';$('deletePassword').focus()};
$('deleteCancel').onclick=closeDeletePanel;
$('deletePanel').addEventListener('keydown',e=>{if(e.key==='Escape')closeDeletePanel();if(e.key==='Enter'&&e.target===$('deletePassword'))$('deleteConfirm').click()});
$('deleteConfirm').onclick=async()=>{
  const password=$('deletePassword').value;
  if(!password){$('deleteError').textContent=authUser&&authUser.hasPassword===false?'Type DELETE to confirm.':'Enter your password to confirm.';$('deletePassword').focus();return}
  $('deleteConfirm').disabled=true;$('deleteError').textContent='';
  try{
    const r=await fetch('/api/account/delete',{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify({password})});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.error||'Could not delete the account.');
    clearToken();try{Object.keys(localStorage).filter(k=>k.startsWith('oneroute-')).forEach(k=>localStorage.removeItem(k))}catch{}
    socket.disconnect();location.reload();
  }catch(err){
    $('deleteError').textContent=err instanceof TypeError?'Could not reach the server.':err.message;$('deleteConfirm').disabled=false;
  }
};
window.addEventListener('beforeunload',()=>{try{clearTimeout(voiceTimer);clearInterval(voiceClockInterval);if(voiceRecorder&&voiceRecorder.state!=='inactive')voiceRecorder.stop();if(voiceStream)voiceStream.getTracks().forEach(track=>track.stop())}catch{}});

// ===== bridge: what React screens may call, and the live state they may read =====
bridge.commands.getToken=()=>authToken;
bridge.commands.storeToken=(token,remember)=>storeToken(token,remember);
bridge.commands.clearToken=()=>clearToken();
bridge.commands.enterApp=user=>enterApp(user);
bridge.commands.photoMessage=text=>photoMessage(text);
bridge.commands.getInvite=()=>inviteCode.length===4?inviteCode:'';
bridge.commands.sos=()=>{sendSos(mySos()?'cleared':'active',true);setTimeout(publishState,250)};
bridge.commands.halt=()=>{toggleHalt();setTimeout(publishState,250)};
bridge.commands.voice=()=>{toggleVoiceRecording();setTimeout(publishState,400)};
bridge.commands.setStart=p=>{chosenStart=p&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))?{lat:Number(p.lat),lon:Number(p.lon),label:String(p.label||'')}:null};
bridge.commands.openNavigation=()=>openNavigation();
bridge.commands.retryGps=()=>{gpsErrorCode=null;startSharing()};
bridge.commands.manualLocation=()=>{
  if(!map)return;
  mapWaitHide(); // the "finding your location" overlay covers the map and would swallow the tap
  $('map').scrollIntoView({block:'center'}); // the cards above the map can push it below the fold on a phone
  showBanner('<b>'+esc(i18n.t('gps.tapMap'))+'</b>'+esc(i18n.t('gps.tapMapBody')),'ok',9000);
  map.getCanvas().style.cursor='crosshair';
  map.once('click',e=>{map.getCanvas().style.cursor='';setManualPosition(e.lngLat.lat,e.lngLat.lng)});
};
// A hand-placed position behaves like GPS (so convoy, directions and alerts work on a laptop), and is repeated until a real fix appears.
function setManualPosition(lat,lon){
  gpsMode='manual';clearInterval(manualTimer);
  const send=()=>{if(onPosition)onPosition({__manual:true,coords:{latitude:lat,longitude:lon,accuracy:30,speed:null,heading:null,altitude:null,altitudeAccuracy:null},timestamp:Date.now()})};
  send();
  manualTimer=setInterval(()=>{if(gpsMode!=='manual'){clearInterval(manualTimer);return}send()},3000);
}
bridge.on('geo:mode',m=>{
  if(gpsMode==='manual')return;
  gpsMode=m;
  if(m==='approximate'&&!approxShown){approxShown=true;showBanner('<b>'+esc(i18n.t('gps.approxTitle'))+'</b>'+esc(i18n.t('gps.approxBody')),'warn',9000)}
});
bridge.commands.navVoice=on=>{setNavVoice(!!on);setTimeout(publishState,100)};
bridge.commands.navData=on=>{navDriving=!!on;if(!on)return;if(!navRouteSteps.length||(Date.now()-navLastRouteAt>120000&&navMatchPosition()?.offset>80))Promise.resolve(navFetchDirections()).then(navUpdateInstruction);else navUpdateInstruction()};
let lastSnapshot='';
function publishState(){
  const me=lastCars.find(c=>c.id===socket.id)||null;
  const others=lastCars.filter(c=>c.id!==socket.id);
  const issues=others.map(c=>({name:String(c.name||'Driver'),status:String(c.status||''),gapKm:Number(c.gapKm)||0}))
    .filter(c=>c.status==='off'||c.status==='offline'||c.gapKm>0.3)
    .sort((a,b)=>(b.status==='off')-(a.status==='off')||b.gapKm-a.gapKm).slice(0,3);
  const snap={
    inTrip:!!session,tripCode:session?String(session.code||''):null,
    speedKmh:lastSpeedKmh,
    // "has a location" means a RECENT fix: the first position (taken when the trip was created) must not count forever.
    // A rough Wi-Fi fix on a stationary laptop rarely updates, so it stays valid much longer.
    gpsOk:Date.now()-lastFixAt<(gpsMode==='approximate'?600000:20000),
    halted:!!myHalt,sos:mySos(),navVoice:!!navVoiceOn,
    recording:!!(voiceRecorder&&voiceRecorder.state==='recording'),
    connected:!!socket.connected,
    gpsMode,gpsError:gpsErrorCode,
    nav:navPayload,
    convoy:{count:lastCars.length,myStatus:me?String(me.status||''):null,issues},
    incomingSos:Object.keys(sosActive).filter(id=>id!==socket.id).map(id=>String(sosActive[id].name||'Driver')),
  };
  const s=JSON.stringify(snap);
  if(s!==lastSnapshot){lastSnapshot=s;bridge.emit('state',snap)}
}
setInterval(publishState,1000);
if(window.__ONEROUTE_TEST__)window.__oneroute_debug={navMap:()=>navMap,map:()=>map,follow:()=>navFollowCamera(true),state:()=>({navOpen,navCameraInit,navFollow,hasGps:!!lastGps,styleLoaded:navMap?navMap.isStyleLoaded():null,speed:lastSpeedKmh,heading:lastHeading})};
bridge.markReady();
}
