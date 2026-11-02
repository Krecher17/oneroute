// ONEROUTE: India-focused driving route and place search utilities.
// Save this file as: server/routing.js
// ES module: keep "type": "module" in package.json.

const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const PHOTON_URL = "https://photon.komoot.io/api/"; // typo-tolerant search on OpenStreetMap data

// Approximate geographic bounds of India.
const INDIA_BOUNDS = {
  minLon: 68.1,
  maxLon: 97.5,
  minLat: 6.5,
  maxLat: 37.6,
};

function isValidCoordinate(lon, lat) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= INDIA_BOUNDS.minLon &&
    lon <= INDIA_BOUNDS.maxLon &&
    lat >= INDIA_BOUNDS.minLat &&
    lat <= INDIA_BOUNDS.maxLat
  );
}

function validateIndiaPoint(point, name = "Location") {
  if (!Array.isArray(point) || point.length < 2) {
    throw new Error(`${name}: coordinates must be [longitude, latitude].`);
  }

  const lon = Number(point[0]);
  const lat = Number(point[1]);

  if (!isValidCoordinate(lon, lat)) {
    throw new Error(`${name} must be within the permitted India search area.`);
  }

  return [lon, lat];
}

function validateRouteGeometry(points) {
  if (
    !Array.isArray(points) ||
    points.length < 2 ||
    !points.every(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        isValidCoordinate(Number(point[0]), Number(point[1]))
    )
  ) {
    throw new Error(
      "The route leaves the permitted India search area or has invalid geometry."
    );
  }

  return points.map(([lon, lat]) => [Number(lon), Number(lat)]);
}

async function requestOsrmRoute(start, end) {
  const [startLon, startLat] = validateIndiaPoint(start, "Start");
  const [endLon, endLat] = validateIndiaPoint(end, "Destination");

  const url =
    `${OSRM_URL}/${startLon},${startLat};${endLon},${endLat}` +
    "?overview=full&geometries=geojson&steps=true";

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`Routing service returned HTTP ${response.status}.`);
  }

  const data = await response.json();
  if (data.code !== "Ok" || !Array.isArray(data.routes) || data.routes.length === 0) {
    throw new Error("No driving route found between these locations.");
  }

  const route = data.routes[0];
  const coordinates = validateRouteGeometry(route.geometry?.coordinates);

  const steps = (route.legs || []).flatMap((leg) =>
    (leg.steps || []).map((step) => ({
      type: step.maneuver?.type || "continue",
      modifier: step.maneuver?.modifier || "",
      maneuverLocation: Array.isArray(step.maneuver?.location)
        ? step.maneuver.location.map(Number)
        : null,
      exit: step.maneuver?.exit ?? null,
      road: step.name || "",
      distance: Number(step.distance) || 0,
      duration: Number(step.duration) || 0,
      coordinates: Array.isArray(step.geometry?.coordinates)
        ? step.geometry.coordinates.map(([lon, lat]) => [Number(lon), Number(lat)])
        : [],
    }))
  );

  return {
    coordinates,
    steps,
    distance: Number(route.distance) || 0,
    duration: Number(route.duration) || 0,
  };
}

/**
 * Fetch a driving route between two coordinates.
 * Coordinates use [longitude, latitude].
 *
 * Explicitly returns an array of [longitude, latitude] coordinate pairs
 * to match buildRoute in server/index.js.
 */
export async function fetchRoute(start, end) {
  const route = await requestOsrmRoute(start, end);
  return route.coordinates;
}

/**
 * Fetch a route plus turn-by-turn steps, total distance, and duration.
 * Coordinates use [longitude, latitude].
 */
export async function fetchRouteWithSteps(start, end) {
  return requestOsrmRoute(start, end);
}

const USER_AGENT = "ONEROUTE-ConvoyApp/1.0";

// Exact-ish search. Nominatim is accurate but strict about spelling.
async function nominatimSearch(search) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", search);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "in");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "1");

  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Place search returned HTTP ${response.status}.`);

  const results = await response.json();
  if (!Array.isArray(results)) throw new Error("Place search returned an invalid response.");

  return results
    .filter((place) => {
      const countryCode = String(place.address?.country_code || "").toLowerCase();
      return countryCode === "in" && isValidCoordinate(Number(place.lon), Number(place.lat));
    })
    .map((place) => ({
      lat: Number(place.lat),
      lon: Number(place.lon),
      label: String(place.display_name || search),
    }));
}

// Fuzzy search. Photon tolerates misspellings and partial names, limited to India's bounding box.
async function photonSearch(search, limit = 8) {
  const url = new URL(PHOTON_URL);
  url.searchParams.set("q", search);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set(
    "bbox",
    `${INDIA_BOUNDS.minLon},${INDIA_BOUNDS.minLat},${INDIA_BOUNDS.maxLon},${INDIA_BOUNDS.maxLat}`
  );

  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Fuzzy place search returned HTTP ${response.status}.`);

  const data = await response.json();
  const features = Array.isArray(data.features) ? data.features : [];

  return features
    .filter((f) => String(f.properties?.countrycode || "").toUpperCase() === "IN")
    .map((f) => {
      const p = f.properties || {};
      const [lon, lat] = (f.geometry?.coordinates || []).map(Number);
      const parts = [p.name, p.street, p.district, p.city, p.state].filter(Boolean);
      const label = [...new Set(parts)].join(", ") || search;
      return { lat, lon, label };
    })
    .filter((r) => isValidCoordinate(r.lon, r.lat));
}

// "mysore palce road" -> ["mysore palce road", "mysore palce"], so a bad last word still finds the area.
function shorterQueries(search) {
  const words = search.split(/\s+/);
  const out = [];
  for (let drop = 1; drop <= 2 && words.length - drop >= 1; drop++) {
    out.push(words.slice(0, words.length - drop).join(" "));
  }
  return out;
}

// ---- "Did you mean" helpers ----
// Skeleton: lowercase, no accents, no vowels, no repeated letters. "Ambalpuzha" and "Ambalappuzha" both become "mblpzh".
function skeleton(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "")
    .replace(/w/g, "v")
    .replace(/h/g, "")
    .replace(/[aeiouy]/g, "")
    .replace(/(.)\1+/g, "$1");
}

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = temp;
    }
  }
  return prev[b.length];
}

// 0..1, higher means the place name looks or sounds more like what the user typed.
function similarity(query, placeName) {
  const q = query.toLowerCase().replace(/[^a-z]/g, "");
  const n = String(placeName || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!q || !n) return 0;
  const plain = 1 - editDistance(q, n) / Math.max(q.length, n.length);
  const qs = skeleton(query);
  const ns = skeleton(placeName);
  const sound = qs && ns ? 1 - editDistance(qs, ns) / Math.max(qs.length, ns.length) : 0;
  return Math.max(plain, sound * 0.95);
}

// Other spellings worth trying: shorter beginnings, doubled consonants ("ambapuzha" -> "ambappuzha"),
// and a missing "a" inside consonant clusters.
function spellingVariants(word) {
  const w = word.toLowerCase();
  const isCons = (c) => /[bcdfgjklmnpqrstvwxz]/.test(c);
  const isVowel = (c) => /[aeiou]/.test(c);
  const out = new Set();

  // Shorter beginnings. Short ones are broad, so they are searched with a bigger limit.
  for (let cut = 1; cut <= 5 && w.length - cut >= 4; cut++) out.add(w.slice(0, w.length - cut));

  // Doubled consonant between vowels: Indian place names often have these (Ambalappuzha, Kozhikode).
  let doubled = 0;
  for (let i = 1; i < w.length - 1 && doubled < 3; i++) {
    if (isCons(w[i]) && isVowel(w[i - 1]) && isVowel(w[i + 1]) && w[i] !== "h") {
      out.add(w.slice(0, i + 1) + w[i] + w.slice(i + 1));
      doubled++;
    }
  }

  // Missing "a" inside a consonant cluster.
  let added = 0;
  for (let i = 1; i < w.length - 1 && added < 3; i++) {
    const digraph = w[i + 1] === "h"; // sh, th, zh, kh... are one sound, do not split
    if (isCons(w[i]) && isCons(w[i + 1]) && !digraph && !(w[i] === "n" && "gk".includes(w[i + 1]))) {
      out.add(w.slice(0, i + 1) + "a" + w.slice(i + 1));
      added++;
    }
  }
  return [...out];
}

// Collects candidates for several spellings at once, then keeps the ones that look most like the query.
async function didYouMean(search) {
  const lastWord = search.split(/\s+/).pop();
  const prefix = search.slice(0, search.length - lastWord.length);
  const variants = spellingVariants(lastWord).map((v) => prefix + v);
  const settled = await Promise.allSettled(variants.map((v) => photonSearch(v, v.length <= 5 ? 40 : 15)));
  const pool = dedupe(settled.flatMap((r) => (r.status === "fulfilled" ? r.value : [])));
  return pool
    .map((r) => ({ ...r, score: similarity(lastWord, r.label.split(",")[0]) }))
    .filter((r) => r.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ score, ...r }) => ({ ...r, approx: true }));
}

function dedupe(results) {
  const seen = new Set();
  return results.filter((r) => {
    const key = `${r.lat.toFixed(3)},${r.lon.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Search for places in India only. Always tries to return the closest match.
 * 1) Nominatim (exact), 2) Photon (typo-tolerant), 3) Photon with trailing words dropped,
 * 4) "did you mean": other spellings, ranked by similarity to what was typed.
 * Returns { lat, lon, label, approx? } objects for the frontend.
 * "approx: true" means it is a best guess, not an exact match.
 */
export async function geocode(query) {
  const search = String(query || "").trim().replace(/\s+/g, " ");
  if (!search) {
    throw new Error("Enter a place name to search.");
  }

  let firstError = null;
  const log = (step, n) => console.log(`[geocode] "${search}" ${step}: ${n} result(s)`);
  const attempt = async (fn, text) => {
    try {
      return await fn(text);
    } catch (error) {
      console.error(`[geocode] "${text}" failed: ${error.message}`);
      firstError = firstError || error; // remember it, but keep trying other methods
      return [];
    }
  };

  // 1) Exact search
  let results = await attempt(nominatimSearch, search);
  log("nominatim", results.length);
  if (results.length) return results;

  // 2) Fuzzy search on the full text
  results = await attempt(photonSearch, search);
  log("photon", results.length);
  if (results.length) return dedupe(results).slice(0, 5).map((r) => ({ ...r, approx: true }));

  // 3) Fuzzy search on shortened text
  for (const shorter of shorterQueries(search)) {
    results = await attempt(photonSearch, shorter);
    if (results.length) return dedupe(results).slice(0, 5).map((r) => ({ ...r, approx: true }));
  }

  // 4) "Did you mean": try other spellings and rank by how similar they look and sound
  results = await attempt(didYouMean, search);
  log("did-you-mean", results.length);
  if (results.length) return results;

  // Nothing found anywhere. If every service failed, report that; otherwise it is a genuine "no match".
  if (firstError) throw firstError;
  return [];
}
