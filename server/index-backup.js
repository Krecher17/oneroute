import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import crypto from 'crypto';

import { makeRoute, snap } from './geo.js';
import { fetchRoute, geocode } from './routing.js';
import { bestRejoin } from './rejoin.js';
import { registerAuthRoutes, requireAuth, authUserFromToken, avatarForUser } from './auth.js';

// -------------------- Settings --------------------
const PORT = process.env.PORT || 3001;
const OFF_METERS = 100;
const OFF_SECONDS = Number(process.env.OFF_SECONDS || 10);
const GAP_WARN_KM = 3;
const STALE_MS = 30000;
const MAX_ACCURACY = 80;
const MIN_SPEED = 20;
const DEFAULT_SPEED = 50;
const MAX_WAYPOINTS = 20;

// Voice-message settings
const MAX_VOICE_MESSAGES = 50;
const MAX_VOICE_LENGTH = 1000000;

// Quick replies: only these exact messages are accepted
const QUICK_MESSAGES = new Set([
  'Need a break', 'Fuel low', 'Slow down', 'On my way', 'Need to stop soon', 'All good',
]);
const MAX_QUICK_LOG = 30;

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
registerAuthRoutes(app); // /api/signup, /api/login, /api/me, /api/logout

const trips = new Map(); // trip code -> trip data
const viewTokens = new Map(); // read-only live-link token -> trip code

app.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'Oneroute', trips: trips.size });
});

app.get('/geocode', requireAuth, async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) return res.status(400).json({ error: 'Enter a place to search for.' });
    const result = await geocode(query);
    res.json(result);
  } catch (error) {
    console.error('geocode failed:', error.message);
    res.status(502).json({ error: 'Search failed' });
  }
});

// -------------------- Read-only live link --------------------
const liveHits = new Map();
function liveLimiter(req, res, next) {
  const now = Date.now();
  if (liveHits.size > 1000) liveHits.clear();
  const hit = liveHits.get(req.ip) || { n: 0, reset: now + 60000 };
  if (now > hit.reset) { hit.n = 0; hit.reset = now + 60000; }
  hit.n += 1;
  liveHits.set(req.ip, hit);
  if (hit.n > 90) return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  next();
}

const LIVE_HTML = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ONEROUTE Live</title>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css">
<style>
:root{--bg:#17191d;--line:#393e48;--text:#f5f3eb;--muted:#9ca3af;--yellow:#f4c430}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,sans-serif}
header{padding:14px 16px;background:#1d2025;border-bottom:1px solid var(--line)}
.brand{color:var(--yellow);font-weight:950;letter-spacing:2px;font-size:13px}
h1{font-size:19px;margin:6px 0 2px}small{color:var(--muted)}
#map{height:55vh;min-height:300px}
#sos{display:none;background:#482725;color:#ffaaa5;padding:12px 16px;font-weight:800;font-size:14px}
.list{padding:8px 16px}.row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 0;border-top:1px solid var(--line);font-size:14px}
.row:first-child{border-top:0}.tag{font-size:11px;font-weight:800;border-radius:20px;padding:5px 9px;background:#343943;white-space:nowrap}
.ok{background:#1d3b2c;color:#8ce4b4}.behind{background:#47351f;color:#ffd18b}.off{background:#482725;color:#ffaaa5}
.pin{width:30px;height:30px;border:3px solid #fff;border-radius:50%;display:grid;place-items:center;font-weight:900;color:#17191d;font-size:12px}
.sospin{background:#f05b57;color:#fff;border:2px solid #fff;padding:4px 8px;border-radius:8px;font-size:12px;font-weight:900;white-space:nowrap}
.note{padding:4px 16px 28px;font-size:12px;color:var(--muted)}
</style></head><body>
<header><div class="brand">&#11041; ONEROUTE &middot; LIVE VIEW</div><h1 id="dest">Loading...</h1><small id="meta">Read-only view</small></header>
<div id="sos"></div><div id="map"></div><div class="list" id="list"></div>
<div class="note">Read-only view. It refreshes every few seconds and shows the same positions the convoy sees.</div>
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<script>
(function(){
var token=location.pathname.split('/').filter(Boolean).pop();
var COLORS={ok:'#42c786',behind:'#f2a23a',off:'#f05b57',offline:'#9ca3af',arrived:'#6aa8ff'};
var LABEL={ok:'On route',behind:'Behind',off:'Off route',offline:'No signal',arrived:'Arrived'};
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function ago(s){if(s==null)return '';var m=Math.floor(s/60);return m<1?'just now':m<60?m+' min ago':Math.floor(m/60)+' h '+(m%60)+' min ago'}
var map=new maplibregl.Map({container:'map',center:[77.6,13],zoom:9,style:{version:8,sources:{osm:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256,attribution:'(c) OpenStreetMap contributors'}},layers:[{id:'osm',type:'raster',source:'osm'}]}});
map.addControl(new maplibregl.NavigationControl());
var markers={},sosMarkers=[],fitted=false,first=true;
function drawRoute(route){
  if(!route||route.length<2||map.getSource('route'))return;
  map.addSource('route',{type:'geojson',data:{type:'Feature',geometry:{type:'LineString',coordinates:route}}});
  map.addLayer({id:'route-casing',type:'line',source:'route',paint:{'line-color':'#17191d','line-width':9}});
  map.addLayer({id:'route-line',type:'line',source:'route',paint:{'line-color':'#f4c430','line-width':5}});
}
function render(d){
  document.getElementById('dest').textContent='To '+(d.destination||'destination');
  document.getElementById('meta').textContent=d.cars.length+' vehicle'+(d.cars.length===1?'':'s')+' - '+d.totalKm+' km route - read-only';
  var list=document.getElementById('list');list.replaceChildren();
  var seen={},pts=[];
  d.cars.forEach(function(c){
    seen[c.k]=1;
    if(typeof c.lon==='number'&&typeof c.lat==='number'){
      if(!markers[c.k]){var pe=el('div','pin',(c.name||'?').charAt(0).toUpperCase());if(c.avatar&&/^\/avatar\/[a-f0-9]{32}\.jpg$/.test(c.avatar)){pe.style.backgroundImage='url('+c.avatar+')';pe.style.backgroundSize='cover';pe.style.backgroundPosition='center';pe.style.color='transparent';pe.setAttribute('data-photo','1')}markers[c.k]=new maplibregl.Marker({element:pe}).setLngLat([c.lon,c.lat]).addTo(map)}
      markers[c.k].setLngLat([c.lon,c.lat]);
      var pk=markers[c.k].getElement();if(pk.getAttribute('data-photo'))pk.style.borderColor=COLORS[c.status]||COLORS.offline;else pk.style.background=COLORS[c.status]||COLORS.offline;
      pts.push([c.lon,c.lat]);
    }
    var row=el('div','row'),left=el('div');
    left.appendChild(el('b','',c.name||'Driver'));left.appendChild(document.createElement('br'));
    var detail=LABEL[c.status]||c.status;
    if(c.status==='offline'&&c.silentSec!=null)detail='No signal - last seen '+ago(c.silentSec);
    else if(c.gapKm>0)detail=c.gapKm.toFixed(1)+' km behind';
    if(c.halted)detail+=' - stopped';
    if(c.etaMin!=null)detail+=' - ETA '+c.etaMin+' min';
    left.appendChild(el('small','',detail));
    row.appendChild(left);
    row.appendChild(el('span','tag '+(c.status==='ok'||c.status==='arrived'?'ok':c.status==='behind'?'behind':'off'),LABEL[c.status]||c.status));
    list.appendChild(row);
  });
  Object.keys(markers).forEach(function(k){if(!seen[k]){markers[k].remove();delete markers[k]}});
  sosMarkers.forEach(function(m){m.remove()});sosMarkers=[];
  var sosBox=document.getElementById('sos');
  if(d.sos&&d.sos.length){
    sosBox.style.display='block';sosBox.textContent='SOS: '+d.sos.map(function(s){return s.name}).join(', ')+' need(s) help';
    d.sos.forEach(function(s){if(typeof s.lat==='number'&&typeof s.lon==='number'){sosMarkers.push(new maplibregl.Marker({element:el('div','sospin','SOS '+s.name)}).setLngLat([s.lon,s.lat]).addTo(map));pts.push([s.lon,s.lat])}});
  }else{sosBox.style.display='none'}
  if(!fitted&&pts.length){var b=new maplibregl.LngLatBounds(pts[0],pts[0]);pts.forEach(function(p){b.extend(p)});map.fitBounds(b,{padding:60,maxZoom:14,duration:0});fitted=true}
}
function poll(){
  fetch('/api/live/'+encodeURIComponent(token)+(first?'?route=1':''),{cache:'no-store'})
    .then(function(r){if(!r.ok)throw new Error(String(r.status));return r.json()})
    .then(function(d){if(first&&d.route){drawRoute(d.route);first=false}render(d)})
    .catch(function(){document.getElementById('dest').textContent='Link not available';document.getElementById('meta').textContent='This live link is invalid or the trip has ended.'});
}
map.on('load',function(){poll();setInterval(poll,4000)});
})();
</script></body></html>`;

app.get('/live/:token', (_req, res) => {
  res.type('html').send(LIVE_HTML);
});

app.get('/api/live/:token', liveLimiter, (req, res) => {
  const code = viewTokens.get(String(req.params.token));
  const trip = code ? trips.get(code) : null;
  if (!trip) return res.status(404).json({ error: 'Live link not found or the trip has ended.' });

  const sos = [...trip.members.values()]
    .filter((m) => m.sos)
    .map((m) => ({ name: m.name, lat: m.sos.lat, lon: m.sos.lon, at: m.sos.at }));

  res.set('Cache-Control', 'no-store');
  res.json({
    destination: trip.destination.label,
    totalKm: +trip.route.totalKm.toFixed(1),
    route: req.query.route === '1' ? trip.route.coords : undefined,
    cars: (trip.lastReport || []).map((c) => ({
      k: crypto.createHash('sha1').update(String(c.id)).digest('hex').slice(0, 8),
      name: c.name, avatar: c.avatar || null, lat: c.lat, lon: c.lon, status: c.status,
      gapKm: c.gapKm, etaMin: c.etaMin, silentSec: c.silentSec, halted: c.halted,
    })),
    sos,
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 2_000_000,
});

// Only signed-in people can connect. The page sends its saved login token with the connection.
io.use((socket, next) => {
  const user = authUserFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});

function newCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (trips.has(code));
  return code;
}

const validPoint = (p) =>
  p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)) &&
  Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lon)) <= 180;

function cleanPoint(p, fallbackLabel = 'Waypoint') {
  if (!validPoint(p)) return null;
  return {
    lat: Number(p.lat),
    lon: Number(p.lon),
    label: String(p.label || fallbackLabel).trim().slice(0, 100) || fallbackLabel,
  };
}

// Request a road route for start -> waypoint(s) -> destination.
// fetchRoute expects [longitude, latitude] coordinate pairs.
async function buildRoute(start, destination, waypoints = []) {
  const stops = [start, ...waypoints, destination];
  const fullCoords = [];

  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i];
    const to = stops[i + 1];
    const leg = await fetchRoute([from.lon, from.lat], [to.lon, to.lat]);
    if (!Array.isArray(leg) || leg.length < 2) {
      throw new Error(`No route found for leg ${i + 1}`);
    }
    // Avoid duplicating the shared coordinate between adjacent route legs.
    fullCoords.push(...(i === 0 ? leg : leg.slice(1)));
  }

  return fullCoords;
}

function addMember(trip, socket, name) {
  const clean = String(name || socket.data?.user?.name || 'Driver').trim().slice(0, 20) || 'Driver';
  // Replace an old disconnected entry if this driver rejoins with the same name.
  for (const [id, member] of trip.members) {
    if (!member.online && member.name === clean) {
      // A rejoining driver replaces their old entry, so clear any SOS that entry still had.
      if (member.sos) io.to(trip.code).emit('sos', { id, name: member.name, state: 'cleared', lat: null, lon: null, at: Date.now() });
      trip.members.delete(id);
    }
  }

  socket.join(trip.code);
  trip.members.set(socket.id, {
    id: socket.id,
    name: clean,
    avatar: avatarForUser(socket.data?.user?.id), // profile picture shown on the map instead of the first letter
    online: true,
    pos: null,
    history: [],
    accuracy: null,
    snapKm: 0,
    offMeters: 0,
    offSince: null,
    flagged: false,
    gapWarned: false,
    halted: false, // NEW: true while the driver has announced "I'm stopping"
    sepOff: null, // NEW: open off-route episode in the trip report
    sepGap: null, // NEW: open fell-behind episode in the trip report
    haltEp: null, // NEW: open halt entry in the trip report
    sos: null, // NEW: active SOS { at, lat, lon } or null
    lastQuickAt: 0, // NEW: rate limit for quick replies
    speed: DEFAULT_SPEED,
    lastSeen: 0,
    lastKm: null,
    lastT: null,
    arrived: false,
  });
}

function updatePosition(trip, member, p) {
  if (!validPoint(p)) return;
  const now = Date.now();
  member.accuracy = Number.isFinite(p.accuracy) ? Math.round(p.accuracy) : null;
  if (member.accuracy !== null && member.accuracy > MAX_ACCURACY) return;

  member.history.push([Number(p.lon), Number(p.lat)]);
  if (member.history.length > 3) member.history.shift();
  member.pos = [
    member.history.reduce((sum, point) => sum + point[0], 0) / member.history.length,
    member.history.reduce((sum, point) => sum + point[1], 0) / member.history.length,
  ];
  member.lastSeen = now;

  const snapped = snap(trip.route, member.pos);
  member.snapKm = snapped.km;
  member.offMeters = snapped.offMeters;

  let kmh = Number.isFinite(p.speed) && p.speed >= 0 ? p.speed * 3.6 : null;
  if (kmh === null && member.lastT && member.lastKm !== null && now > member.lastT) {
    kmh = (Math.max(0, snapped.km - member.lastKm) / (now - member.lastT)) * 3600000;
  }
  if (kmh !== null) member.speed = member.speed * 0.7 + kmh * 0.3;
  member.lastKm = snapped.km;
  member.lastT = now;

  if (member.offMeters > OFF_METERS) {
    if (!member.offSince) member.offSince = now;
  } else {
    if (member.flagged) {
      io.to(trip.code).emit('alert', {
        type: 'rejoined', id: member.id, name: member.name, km: +snapped.km.toFixed(1),
      });
      closeSeparation(trip, member, 'sepOff', snapped.km);
    }
    member.offSince = null;
    member.flagged = false;
  }

  const wasArrived = member.arrived;
  member.arrived = member.offMeters <= OFF_METERS && snapped.km >= trip.route.totalKm - 0.15;
  if (member.arrived && !wasArrived && !trip.log.arrivals[member.name]) {
    trip.log.arrivals[member.name] = { name: member.name, at: now };
    closeSeparation(trip, member, 'sepGap', snapped.km, 'arrived');
    emitSummary(trip);
  }
}

const isLive = (member) => member.online && member.pos && Date.now() - member.lastSeen < STALE_MS;

// -------------------- Trip report: separations, arrivals and stops --------------------
const MAX_LOG_ITEMS = 200;

function pushLog(list, item) {
  list.push(item);
  if (list.length > MAX_LOG_ITEMS) list.shift();
  return item;
}

function buildSummary(trip) {
  const now = Date.now();
  const separations = trip.log.separations.map((e) => ({ ...e, durationMs: (e.endedAt ?? now) - e.startedAt }));
  const halts = trip.log.halts.map((h) => ({ ...h, durationMs: (h.endedAt ?? now) - h.startedAt }));
  return {
    now,
    startedAt: trip.createdAt,
    totalKm: +trip.route.totalKm.toFixed(1),
    members: [...trip.members.values()].map((m) => ({
      name: m.name,
      online: m.online,
      arrivedAt: trip.log.arrivals[m.name]?.at ?? null,
    })),
    separations,
    halts,
    totals: {
      separations: separations.length,
      longestMs: separations.reduce((max, e) => Math.max(max, e.durationMs), 0),
      haltMs: halts.reduce((sum, h) => sum + h.durationMs, 0),
    },
  };
}

function emitSummary(trip) {
  try {
    io.to(trip.code).emit('summary', buildSummary(trip));
  } catch (err) {
    console.error(`summary emit failed for ${trip.code}:`, err);
  }
}

function openSeparation(trip, member, type, gapKm = null) {
  const episode = pushLog(trip.log.separations, {
    id: `${member.id}-${type}-${Date.now()}`,
    name: member.name,
    type, // 'off-route' (missed a turn) or 'behind' (fell too far back)
    startedAt: Date.now(),
    endedAt: null,
    atKm: +member.snapKm.toFixed(1),
    lat: member.pos ? member.pos[1] : null,
    lon: member.pos ? member.pos[0] : null,
    maxGapKm: gapKm,
    rejoinKm: null,
    endReason: null,
  });
  emitSummary(trip);
  return episode;
}

function closeSeparation(trip, member, field, rejoinKm = null, reason = 'resolved') {
  const episode = member[field];
  if (!episode) return;
  episode.endedAt = Date.now();
  episode.rejoinKm = rejoinKm === null ? null : +rejoinKm.toFixed(1);
  episode.endReason = reason;
  member[field] = null;
  emitSummary(trip);
}

function closeHalt(trip, member) {
  if (!member.haltEp) return;
  member.haltEp.endedAt = Date.now();
  member.haltEp = null;
  emitSummary(trip);
}

function flagDeviation(trip, member) {
  member.flagged = true;
  member.sepOff = openSeparation(trip, member, 'off-route');
  const group = [...trip.members.values()].filter(
    (other) => other !== member && isLive(other) && other.offMeters <= OFF_METERS && !other.arrived,
  );

  const best = group.length
    ? bestRejoin({
        route: trip.route,
        pos: member.pos,
        snapKm: member.snapKm,
        speed: Math.max(member.speed, MIN_SPEED),
        groupRearKm: Math.min(...group.map((other) => other.snapKm)),
        groupSpeed: group.reduce((sum, other) => sum + Math.max(other.speed, MIN_SPEED), 0) / group.length,
      })
    : null;

  const alert = {
    type: 'missed-turn',
    id: member.id,
    name: member.name,
    offMeters: Math.round(member.offMeters),
    rejoin: best && {
      kind: best.kind,
      km: +best.km.toFixed(1),
      waitMin: Math.round(best.waitMin),
      behindMin: Math.round(best.behindMin),
      point: best.point,
    },
  };

  console.log(
    `[${trip.code}] ALERT ${member.name} missed a turn`,
    best ? `-> ${best.kind} km ${alert.rejoin.km}, wait ${alert.rejoin.waitMin} min, behind ${alert.rejoin.behindMin} min` : '',
  );
  io.to(trip.code).emit('alert', alert);
}

function tick() {
  try {
    const now = Date.now();
    for (const trip of trips.values()) {
      try {
        const members = [...trip.members.values()];

        for (const member of members) {
          try {
            if (isLive(member) && member.offSince && !member.flagged && now - member.offSince >= OFF_SECONDS * 1000) {
              flagDeviation(trip, member);
            }
          } catch (err) {
            console.error(`Error in flagDeviation for member ${member?.id}:`, err);
          }
        }

        const onRoute = members.filter(
          (member) => isLive(member) && member.offMeters <= OFF_METERS && !member.arrived,
        );
        const leadKm = onRoute.length ? Math.max(...onRoute.map((member) => member.snapKm)) : 0;

        const report = members.filter((member) => member.pos).map((member) => {
          try {
            const live = isLive(member);
            const off = member.offMeters > OFF_METERS;
            const gapKm = !live || off || member.arrived ? null : +(leadKm - member.snapKm).toFixed(2);
            const speed = Math.max(member.speed, MIN_SPEED);

            // NEW: no gap alert for a driver who announced a planned stop.
            if (gapKm !== null && gapKm >= GAP_WARN_KM && !member.gapWarned && !member.halted) {
              member.gapWarned = true;
              io.to(trip.code).emit('alert', {
                type: 'gap', id: member.id, name: member.name, gapKm,
              });
              member.sepGap = openSeparation(trip, member, 'behind', gapKm);
            }
            if (member.sepGap && gapKm !== null) {
              member.sepGap.maxGapKm = Math.max(member.sepGap.maxGapKm ?? 0, gapKm);
            }
            if (gapKm !== null && gapKm < GAP_WARN_KM / 2) {
              member.gapWarned = false;
              closeSeparation(trip, member, 'sepGap', member.snapKm);
            }
            if (member.sepGap && (member.arrived || off)) {
              closeSeparation(trip, member, 'sepGap', null, member.arrived ? 'arrived' : 'off-route');
            }

            let status = 'ok';
            if (member.arrived) status = 'arrived';
            else if (!live) status = 'offline';
            else if (off) status = 'off';
            else if (gapKm >= GAP_WARN_KM) status = 'behind';

            return {
              id: member.id,
              name: member.name,
              avatar: member.avatar || null,
              lon: member.pos[0],
              lat: member.pos[1],
              km: +member.snapKm.toFixed(2),
              status,
              gapKm,
              accuracy: member.accuracy,
              silentSec: member.lastSeen ? Math.round((now - member.lastSeen) / 1000) : null,
              halted: !!member.halted,
              etaMin: live && !off && !member.arrived
                ? Math.round(((trip.route.totalKm - member.snapKm) / speed) * 60)
                : null,
            };
          } catch (err) {
            console.error(`Error processing member ${member?.id} for report:`, err);
            // Return a safe default object to avoid breaking the report
            return {
              id: member?.id || 'unknown',
              name: member?.name || 'Unknown',
              lon: 0,
              lat: 0,
              km: 0,
              status: 'error',
              gapKm: null,
              accuracy: null,
              etaMin: null,
            };
          }
        });

        try {
          trip.lastReport = report;
          io.to(trip.code).emit('cars', report);
        } catch (err) {
          console.error(`Error emitting cars for trip ${trip.code}:`, err);
        }
      } catch (err) {
        console.error(`Error processing trip ${trip.code}:`, err);
      }
    }
  } catch (err) {
    console.error('Error in tick function:', err);
  }
}

setInterval(tick, 1000);

io.on('connection', (socket) => {
  let trip = null;

  // Leave the current trip before switching this socket to another one.
  function detachCurrentTrip() {
    if (!trip) return;

    const member = trip.members.get(socket.id);
    if (member) member.online = false;

    socket.leave(trip.code);
    trip = null;
  }

  socket.on('create-trip', async ({ name, start, destination } = {}, ack) => {
    try {
      if (typeof ack !== 'function') return;

      const cleanStart = cleanPoint(start, 'Start');
      const cleanDestination = cleanPoint(destination, 'Destination');
      if (!cleanStart || !cleanDestination) {
        return ack({ ok: false, error: 'Missing or invalid start or destination.' });
      }

      const coords = await buildRoute(cleanStart, cleanDestination, []);
      const code = newCode();
      const viewToken = crypto.randomBytes(9).toString('hex');
      trip = {
        code,
        start: cleanStart,
        route: makeRoute(coords),
        destination: cleanDestination,
        waypoints: [],
        creatorId: socket.id,
        members: new Map(),
        voiceMessages: [],
        createdAt: Date.now(),
        log: { separations: [], arrivals: {}, halts: [] },
        viewToken,
        quickMessages: [],
        lastReport: [],
      };
      trips.set(code, trip);
      viewTokens.set(viewToken, code);
      addMember(trip, socket, name);

      console.log(`[${code}] trip created: ${trip.route.totalKm.toFixed(1)} km to ${cleanDestination.label}`);
      ack({ ok: true, code, route: coords, destination: cleanDestination, waypoints: [], viewToken });
    } catch (error) {
      console.error('create-trip failed:', error.message);
      if (typeof ack === 'function') {
        ack({
          ok: false,
          error:
            'Could not find a driving route. Check the destination and your internet connection.',
        });
      }
    }
  });

  socket.on('join-trip', ({ code, name } = {}, ack) => {
    try {
      const foundTrip = trips.get(String(code || '').toUpperCase().trim());
      if (!foundTrip) {
        return typeof ack === 'function' && ack({ ok: false, error: 'No trip with that code.' });
      }

      trip = foundTrip;
      addMember(trip, socket, name);

      // Send previous voice messages to the joining member.
      socket.emit('voice-history', trip.voiceMessages || []);

      // NEW: tell the joining member who is currently stopped.
      for (const other of trip.members.values()) {
        if (other.halted && other.online && other.id !== socket.id) {
          socket.emit('halt', {
            id: other.id, name: other.name, state: 'stopped', lat: null, lon: null,
          });
        }
      }

      socket.emit('summary', buildSummary(trip));
      socket.emit('quick-history', trip.quickMessages || []);
      for (const other of trip.members.values()) {
        if (other.sos && other.id !== socket.id) {
          socket.emit('sos', {
            id: other.id, name: other.name, state: 'active',
            lat: other.sos.lat, lon: other.sos.lon, at: other.sos.at,
          });
        }
      }

      console.log(`[${trip.code}] ${String(name || 'Driver')} joined (${trip.members.size} members)`);
      if (typeof ack === 'function') {
        ack({
          ok: true,
          code: trip.code,
          viewToken: trip.viewToken,
          route: trip.route.coords,
          destination: trip.destination,
          start: trip.start,
          waypoints: trip.waypoints,
        });
      }
    } catch (error) {
      console.error('join-trip failed:', error);
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'An unexpected error occurred while joining the trip.' });
      }
    }
  });

  socket.on('voice-message', (data, callback) => {
    try {
      const reply = typeof callback === 'function' ? callback : () => {};

      if (!trip || !trips.has(trip.code)) {
        return reply({ ok: false, error: 'Join a trip before sending a voice message.' });
      }

      if (
        !data ||
        typeof data.audio !== 'string' ||
        data.audio.length === 0 ||
        data.audio.length > MAX_VOICE_LENGTH ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data.audio) ||
        typeof data.mimeType !== 'string' ||
        !/^audio\/[a-z0-9.+-]+(?:\s*;.*)?$/i.test(data.mimeType)
      ) {
        return reply({ ok: false, error: 'Invalid audio message or recording too large.' });
      }

      const member = trip.members.get(socket.id);
      if (!member || !member.online) {
        return reply({ ok: false, error: 'Your trip connection is no longer active.' });
      }

      const message = {
        id: `${Date.now()}-${socket.id}`,
        name: member.name,
        audio: data.audio,
        mimeType: data.mimeType,
        timestamp: Date.now(),
      };

      if (!Array.isArray(trip.voiceMessages)) trip.voiceMessages = [];
      trip.voiceMessages.push(message);
      if (trip.voiceMessages.length > MAX_VOICE_MESSAGES) {
        trip.voiceMessages = trip.voiceMessages.slice(-MAX_VOICE_MESSAGES);
      }

      io.to(trip.code).emit('voice-message', message);
      console.log(`[${trip.code}] voice from ${member.name}: ${Math.round(data.audio.length / 1024)} KB (${data.mimeType}), ${io.sockets.adapter.rooms.get(trip.code)?.size || 0} in room`);
      reply({ ok: true });
    } catch (error) {
      console.error('voice-message failed:', error);
      if (typeof callback === 'function') {
        callback({ ok: false, error: 'Failed to process voice message.' });
      }
    }
  });

  // NEW: "I'm stopping" / "I'm moving again" relay
  socket.on('halt', (data, ack) => {
    try {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!trip || !trips.has(trip.code)) {
        return reply({ ok: false, error: 'Join a trip first.' });
      }
      const member = trip.members.get(socket.id);
      if (!member || !member.online) {
        return reply({ ok: false, error: 'Your trip connection is no longer active.' });
      }

      const stopped = data?.state !== 'moving';
      if (stopped && !member.halted) {
        member.haltEp = pushLog(trip.log.halts, { name: member.name, startedAt: Date.now(), endedAt: null });
        emitSummary(trip);
      } else if (!stopped) {
        closeHalt(trip, member);
      }
      member.halted = stopped;

      io.to(trip.code).emit('halt', {
        id: member.id,
        name: member.name,
        state: stopped ? 'stopped' : 'moving',
        lat: Number.isFinite(Number(data?.lat)) ? Number(data.lat) : null,
        lon: Number.isFinite(Number(data?.lon)) ? Number(data.lon) : null,
      });
      console.log(`[${trip.code}] ${member.name} ${stopped ? 'stopped' : 'is moving again'}`);
      reply({ ok: true });
    } catch (error) {
      console.error('halt failed:', error);
      if (typeof ack === 'function') ack({ ok: false, error: 'Could not share your stop.' });
    }
  });

  // NEW: SOS / breakdown broadcast
  socket.on('sos', (data, ack) => {
    try {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!trip || !trips.has(trip.code)) return reply({ ok: false, error: 'Join a trip first.' });
      const member = trip.members.get(socket.id);
      if (!member || !member.online) return reply({ ok: false, error: 'Your trip connection is no longer active.' });

      const active = data?.state !== 'cleared';
      const lat = num(data?.lat) ?? (member.pos ? member.pos[1] : null);
      const lon = num(data?.lon) ?? (member.pos ? member.pos[0] : null);
      member.sos = active ? { at: Date.now(), lat, lon } : null;

      io.to(trip.code).emit('sos', {
        id: member.id, name: member.name, state: active ? 'active' : 'cleared', lat, lon, at: Date.now(),
      });
      console.log(`[${trip.code}] SOS ${active ? 'SENT' : 'cleared'} by ${member.name}`);
      reply({ ok: true });
    } catch (error) {
      console.error('sos failed:', error);
      if (typeof ack === 'function') ack({ ok: false, error: 'Could not send the SOS.' });
    }
  });

  // NEW: one-tap quick replies (fixed list only)
  socket.on('quick-message', (data, ack) => {
    try {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!trip || !trips.has(trip.code)) return reply({ ok: false, error: 'Join a trip first.' });
      const member = trip.members.get(socket.id);
      if (!member || !member.online) return reply({ ok: false, error: 'Your trip connection is no longer active.' });

      const text = typeof data?.text === 'string' ? data.text : '';
      if (!QUICK_MESSAGES.has(text)) return reply({ ok: false, error: 'Unknown quick reply.' });
      if (Date.now() - member.lastQuickAt < 1500) return reply({ ok: false, error: 'Slow down a little.' });
      member.lastQuickAt = Date.now();

      const message = { id: `${Date.now()}-${socket.id}`, memberId: member.id, name: member.name, text, at: Date.now() };
      if (!Array.isArray(trip.quickMessages)) trip.quickMessages = [];
      trip.quickMessages.push(message);
      if (trip.quickMessages.length > MAX_QUICK_LOG) trip.quickMessages = trip.quickMessages.slice(-MAX_QUICK_LOG);
      io.to(trip.code).emit('quick-message', message);
      reply({ ok: true });
    } catch (error) {
      console.error('quick-message failed:', error);
      if (typeof ack === 'function') ack({ ok: false, error: 'Could not send the message.' });
    }
  });

  // NEW: the Summary tab asks for the current trip report
  socket.on('get-summary', (ack) => {
    if (typeof ack !== 'function') return;
    if (!trip || !trips.has(trip.code)) return ack({ ok: false, error: 'Join a trip first.' });
    ack({ ok: true, summary: buildSummary(trip) });
  });

  socket.on('update-waypoints', async ({ waypoints } = {}, ack) => {
    try {
      if (!trip) {
        return typeof ack === 'function' && ack({ ok: false, error: 'Join or create a trip first.' });
      }
      if (socket.id !== trip.creatorId) {
        return typeof ack === 'function' && ack({ ok: false, error: 'Only the trip creator can change waypoints.' });
      }
      if (!Array.isArray(waypoints) || waypoints.length > MAX_WAYPOINTS) {
        return typeof ack === 'function' && ack({ ok: false, error: `Choose between 0 and ${MAX_WAYPOINTS} waypoints.` });
      }

      const cleanWaypoints = [];
      for (let i = 0; i < waypoints.length; i++) {
        const point = cleanPoint(waypoints[i], `Waypoint ${i + 1}`);
        if (!point) {
          return typeof ack === 'function' && ack({ ok: false, error: `Waypoint ${i + 1} has invalid coordinates.` });
        }
        cleanWaypoints.push(point);
      }

      const coords = await buildRoute(trip.start, trip.destination, cleanWaypoints);
      trip.route = makeRoute(coords);
      trip.waypoints = cleanWaypoints;

      // Reset route-progress calculations so old route distances are not reused.
      for (const member of trip.members.values()) {
        closeSeparation(trip, member, 'sepOff', null, 'route-changed');
        closeSeparation(trip, member, 'sepGap', null, 'route-changed');
        member.snapKm = 0;
        member.offMeters = 0;
        member.offSince = null;
        member.flagged = false;
        member.gapWarned = false;
        member.arrived = false;
        member.lastKm = null;
        member.lastT = null;
      }

      const update = {
        code: trip.code,
        route: coords,
        destination: trip.destination,
        start: trip.start,
        waypoints: trip.waypoints,
        totalKm: +trip.route.totalKm.toFixed(2),
      };
      io.to(trip.code).emit('route-updated', update);
      io.to(trip.code).emit('waypoints', trip.waypoints);
      console.log(`[${trip.code}] waypoints updated (${cleanWaypoints.length} stops; ${trip.route.totalKm.toFixed(1)} km)`);

      if (typeof ack === 'function') ack({ ok: true, ...update });
    } catch (error) {
      console.error('update-waypoints failed:', error);
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Could not build a driving route through those waypoints. Try removing a stop and try again.' });
      }
    }
  });

  socket.on('position', (point) => {
    try {
      const member = trip?.members.get(socket.id);
      if (member) updatePosition(trip, member, point);
    } catch (error) {
      console.error('position error:', error);
      // Optionally, we could emit an error to the socket, but we don't want to spam.
    }
  });

  socket.on('disconnect', () => {
    try {
      const member = trip?.members.get(socket.id);
      if (member) {
        member.online = false;
        // NEW: a driver who leaves while halted should not stay "stopped" for everyone else.
        if (member.halted) {
          member.halted = false;
          io.to(trip.code).emit('halt', {
            id: member.id, name: member.name, state: 'moving', lat: null, lon: null,
          });
        }
        closeSeparation(trip, member, 'sepOff', null, 'disconnected');
        closeSeparation(trip, member, 'sepGap', null, 'disconnected');
        closeHalt(trip, member);
      }
    } catch (error) {
      console.error('disconnect error:', error);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Oneroute server running on port ${PORT}`);
});