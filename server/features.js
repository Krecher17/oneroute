// features.js
// ONEROUTE extras: nearest help for SOS, weather on the route, and route alternatives.
// Uses only free services and Node's built-in fetch. No extra packages.

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';
const USER_AGENT = 'ONEROUTE-ConvoyApp/1.0';

const toRad = (d) => (d * Math.PI) / 180;
function distKm(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, h)));
}

// -------------------- Nearest help --------------------
const helpCache = new Map(); // "lat,lon" rounded -> { at, value }

function cleanPhone(raw) {
  const first = String(raw || '').split(/[;,/]/)[0];
  const digits = first.replace(/[^\d+]/g, '');
  return digits.length >= 5 && digits.length <= 15 ? digits : null;
}

export async function nearestHelp(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = helpCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;

  const around = `(around:20000,${lat},${lon})`;
  const query = `[out:json][timeout:14];(nwr${around}[amenity=hospital];nwr${around}[amenity=police];nwr${around}[shop=car_repair];);out center tags 120;`;
  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(18000),
  });
  if (!response.ok) throw new Error(`overpass ${response.status}`);
  const data = await response.json();

  const groups = { hospital: [], police: [], garage: [] };
  for (const el of data.elements || []) {
    const tags = el.tags || {};
    const pLat = el.lat ?? el.center?.lat;
    const pLon = el.lon ?? el.center?.lon;
    if (!Number.isFinite(pLat) || !Number.isFinite(pLon)) continue;
    const kind = tags.amenity === 'hospital' ? 'hospital' : tags.amenity === 'police' ? 'police' : tags.shop === 'car_repair' ? 'garage' : null;
    if (!kind) continue;
    const fallback = { hospital: 'Hospital', police: 'Police station', garage: 'Garage / car repair' }[kind];
    groups[kind].push({
      name: String(tags.name || tags['name:en'] || fallback).slice(0, 80),
      lat: pLat,
      lon: pLon,
      distKm: +distKm(lat, lon, pLat, pLon).toFixed(1),
      phone: cleanPhone(tags.phone || tags['contact:phone']),
    });
  }
  const value = {};
  for (const k of Object.keys(groups)) value[k] = groups[k].sort((a, b) => a.distKm - b.distKm).slice(0, 2);
  helpCache.set(key, { at: Date.now(), value });
  if (helpCache.size > 200) helpCache.clear();
  return value;
}

// -------------------- Weather --------------------
const WMO = (code) => {
  if (code === 0) return ['☀️', 'Clear'];
  if (code <= 2) return ['🌤️', 'Partly cloudy'];
  if (code === 3) return ['☁️', 'Overcast'];
  if (code === 45 || code === 48) return ['🌫️', 'Fog'];
  if (code >= 51 && code <= 57) return ['🌦️', 'Drizzle'];
  if (code >= 61 && code <= 67) return ['🌧️', 'Rain'];
  if (code >= 71 && code <= 77) return ['🌨️', 'Snow'];
  if (code >= 80 && code <= 82) return ['🌧️', 'Rain showers'];
  if (code >= 95) return ['⛈️', 'Thunderstorm'];
  return ['🌡️', 'Unknown'];
};

// points: [{ label, kind, lat, lon }]
export async function getWeather(points) {
  const list = points.slice(0, 22);
  if (!list.length) return [];
  const url = new URL(WEATHER_URL);
  url.searchParams.set('latitude', list.map((p) => p.lat.toFixed(3)).join(','));
  url.searchParams.set('longitude', list.map((p) => p.lon.toFixed(3)).join(','));
  url.searchParams.set('current', 'temperature_2m,weather_code');
  url.searchParams.set('hourly', 'precipitation_probability,precipitation');
  url.searchParams.set('forecast_hours', '12');
  url.searchParams.set('timezone', 'auto');
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`weather ${response.status}`);
  const body = await response.json();
  const results = Array.isArray(body) ? body : [body];

  return list.map((p, i) => {
    const r = results[i] || {};
    const probs = r.hourly?.precipitation_probability || [];
    const mm = r.hourly?.precipitation || [];
    const [icon, text] = WMO(Number(r.current?.weather_code));
    const rainMaxPct = probs.length ? Math.max(...probs.map(Number).filter(Number.isFinite), 0) : null;
    const firstRain = probs.findIndex((v) => Number(v) >= 50);
    return {
      label: p.label,
      kind: p.kind,
      tempC: Number.isFinite(r.current?.temperature_2m) ? Math.round(r.current.temperature_2m) : null,
      icon,
      text,
      rainMaxPct,
      rainInHours: firstRain >= 0 ? firstRain : null, // 0 = this hour
      rainMm: +(mm.slice(0, 6).reduce((a, b) => a + (Number(b) || 0), 0)).toFixed(1),
    };
  });
}

// -------------------- Route alternatives --------------------
const INDIA = { minLon: 68.1, maxLon: 97.5, minLat: 6.5, maxLat: 37.6 };
const inIndia = (lon, lat) => lon >= INDIA.minLon && lon <= INDIA.maxLon && lat >= INDIA.minLat && lat <= INDIA.maxLat;

// start / end: { lat, lon }. Returns up to 3 routes: [{ coordinates, distanceKm, durationMin }]
export async function fetchAlternatives(start, end) {
  if (!inIndia(start.lon, start.lat) || !inIndia(end.lon, end.lat)) throw new Error('outside the permitted area');
  const url = `${OSRM_URL}/${start.lon},${start.lat};${end.lon},${end.lat}?alternatives=3&overview=full&geometries=geojson`;
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`routing ${response.status}`);
  const data = await response.json();
  if (data.code !== 'Ok' || !Array.isArray(data.routes) || !data.routes.length) throw new Error('no route');
  return data.routes.slice(0, 3).map((r) => ({
    coordinates: (r.geometry?.coordinates || []).map(([lon, lat]) => [Number(lon), Number(lat)]).filter(([lon, lat]) => inIndia(lon, lat)),
    distanceKm: +(Number(r.distance) / 1000).toFixed(1),
    durationMin: Math.round(Number(r.duration) / 60),
  })).filter((r) => r.coordinates.length >= 2);
}

// Keeps the shape of a long route but with few points, so previews are light to send.
export function thin(coordinates, max = 350) {
  if (coordinates.length <= max) return coordinates;
  const step = coordinates.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(coordinates[Math.floor(i * step)]);
  out.push(coordinates[coordinates.length - 1]);
  return out;
}

// -------------------- Navigation voice (ElevenLabs) --------------------
// The API key stays on the server. Phones ask /api/tts, and we cache every phrase so repeats cost nothing.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(HERE, 'data');
// Reads config.json forgivingly: handles Windows encodings, curly quotes and trailing commas, and remembers what went wrong.
let configProblem = '';
function readConfigFile() {
  const file = path.join(HERE, 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    configProblem = `config.json was not found. It must be in ${HERE}`;
    return {};
  }
  let text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8'); // PowerShell often saves UTF-16
  text = text.replace(/^\uFEFF/, '').replace(/[\u201c\u201d]/g, '"').replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(text);
  } catch (error) {
    configProblem = `config.json could not be read (${error.message}). Check every line has "quotes" and commas between lines.`;
    return {};
  }
}
const CFG = readConfigFile();
const cleanKey = (value) => String(value || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
const EL_KEY = cleanKey(process.env.ELEVENLABS_API_KEY || CFG.elevenLabsApiKey);
const EL_VOICE = cleanKey(process.env.ELEVENLABS_VOICE_ID || CFG.elevenLabsVoiceId) || '7vmb1wpSAT1c83jjLIeZ';
const EL_MODEL = String(process.env.ELEVENLABS_MODEL || CFG.elevenLabsModel || 'eleven_flash_v2_5').trim();
const DAILY_CHARS = Number(process.env.TTS_DAILY_CHARS || CFG.ttsDailyChars || 30000); // spend guard for uncached text
const TTS_DIR = path.join(DATA_DIR, 'tts');

export const ttsEnabled = () => !!EL_KEY;
export const ttsStatus = () => {
  if (EL_KEY) return `Navigation voice: ElevenLabs is ON (voice ${EL_VOICE}, model ${EL_MODEL}, key ${EL_KEY.slice(0, 5)}...${EL_KEY.slice(-3)})`;
  const why = configProblem || 'config.json has no elevenLabsApiKey filled in';
  return `Navigation voice: browser voice. ElevenLabs is OFF because ${why}.`;
};

const memCache = new Map(); // key -> Buffer
let spend = { day: '', chars: 0 };
const loggedErrors = new Set();

export function cleanSpeechText(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 160) return null;
  if (/[\u0000-\u001f<>{}\\]/.test(text)) return null;
  return text;
}

// Returns an MP3 Buffer. Throws Error with .status on trouble.
export async function speakText(rawText) {
  if (!EL_KEY) throw Object.assign(new Error('voice not configured'), { status: 404 });
  const text = cleanSpeechText(rawText);
  if (!text) throw Object.assign(new Error('bad text'), { status: 400 });

  const key = crypto.createHash('sha256').update(`${EL_VOICE}|${EL_MODEL}|${text}`).digest('hex');
  if (memCache.has(key)) return memCache.get(key);
  const file = path.join(TTS_DIR, `${key}.mp3`);
  try {
    const onDisk = fs.readFileSync(file);
    memCache.set(key, onDisk);
    return onDisk;
  } catch {
    /* not cached yet */
  }

  const today = new Date().toISOString().slice(0, 10);
  if (spend.day !== today) spend = { day: today, chars: 0 };
  if (spend.chars + text.length > DAILY_CHARS) throw Object.assign(new Error('daily voice limit reached'), { status: 429 });

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(EL_VOICE)}?output_format=mp3_44100_64`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: EL_MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    const tag = `${response.status}`;
    if (!loggedErrors.has(tag)) {
      loggedErrors.add(tag);
      console.error(`ElevenLabs refused the request (${response.status}). ${detail}`);
    }
    throw Object.assign(new Error(`elevenlabs ${response.status}`), { status: 502 });
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 200) throw Object.assign(new Error('empty audio'), { status: 502 });
  spend.chars += text.length;
  memCache.set(key, audio);
  if (memCache.size > 400) memCache.delete(memCache.keys().next().value);
  try {
    fs.mkdirSync(TTS_DIR, { recursive: true });
    fs.writeFileSync(file, audio);
  } catch {
    /* cache on disk is optional */
  }
  return audio;
}