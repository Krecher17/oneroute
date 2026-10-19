import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

import { makeRoute, snap } from './geo.js';
import { fetchRoute, geocode } from './routing.js';
import { bestRejoin } from './rejoin.js';

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
const MAX_VOICE_LENGTH = 700000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const trips = new Map(); // trip code -> trip data

app.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'Oneroute', trips: trips.size });
});

app.get('/geocode', async (req, res) => {
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

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 2_000_000,
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
  const clean = String(name || 'Driver').trim().slice(0, 20) || 'Driver';
  // Replace an old disconnected entry if this driver rejoins with the same name.
  for (const [id, member] of trip.members) {
    if (!member.online && member.name === clean) trip.members.delete(id);
  }

  socket.join(trip.code);
  trip.members.set(socket.id, {
    id: socket.id,
    name: clean,
    online: true,
    pos: null,
    history: [],
    accuracy: null,
    snapKm: 0,
    offMeters: 0,
    offSince: null,
    flagged: false,
    gapWarned: false,
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
    }
    member.offSince = null;
    member.flagged = false;
  }

  member.arrived = member.offMeters <= OFF_METERS && snapped.km >= trip.route.totalKm - 0.15;
}

const isLive = (member) => member.online && member.pos && Date.now() - member.lastSeen < STALE_MS;

function flagDeviation(trip, member) {
  member.flagged = true;
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

            if (gapKm !== null && gapKm >= GAP_WARN_KM && !member.gapWarned) {
              member.gapWarned = true;
              io.to(trip.code).emit('alert', {
                type: 'gap', id: member.id, name: member.name, gapKm,
              });
            }
            if (gapKm !== null && gapKm < GAP_WARN_KM / 2) member.gapWarned = false;

            let status = 'ok';
            if (member.arrived) status = 'arrived';
            else if (!live) status = 'offline';
            else if (off) status = 'off';
            else if (gapKm >= GAP_WARN_KM) status = 'behind';

            return {
              id: member.id,
              name: member.name,
              lon: member.pos[0],
              lat: member.pos[1],
              km: +member.snapKm.toFixed(2),
              status,
              gapKm,
              accuracy: member.accuracy,
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
      trip = {
        code,
        start: cleanStart,
        route: makeRoute(coords),
        destination: cleanDestination,
        waypoints: [],
        creatorId: socket.id,
        members: new Map(),
        voiceMessages: [],
      };
      trips.set(code, trip);
      addMember(trip, socket, name);

      console.log(`[${code}] trip created: ${trip.route.totalKm.toFixed(1)} km to ${cleanDestination.label}`);
      ack({ ok: true, code, route: coords, destination: cleanDestination, waypoints: [] });
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
      console.log(`[${trip.code}] ${String(name || 'Driver')} joined (${trip.members.size} members)`);
      if (typeof ack === 'function') {
        ack({
          ok: true,
          code: trip.code,
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
      reply({ ok: true });
    } catch (error) {
      console.error('voice-message failed:', error);
      if (typeof callback === 'function') {
        callback({ ok: false, error: 'Failed to process voice message.' });
      }
    }
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
      if (member) member.online = false;
    } catch (error) {
      console.error('disconnect error:', error);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Oneroute server running on port ${PORT}`);
});