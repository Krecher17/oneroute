// ONEROUTE: India-focused driving route and place search utilities.
// Save this file as: server/routing.js
// ES module: keep "type": "module" in package.json.

const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

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

/**
 * Search for places in India only.
 * Returns { lat, lon, label } objects for the frontend.
 */
export async function geocode(query) {
  const search = String(query || "").trim();
  if (!search) {
    throw new Error("Enter a place name to search.");
  }

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", search);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "in");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "1");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "ONEROUTE-ConvoyApp/1.0",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Place search returned HTTP ${response.status}.`);
  }

  const results = await response.json();
  if (!Array.isArray(results)) {
    throw new Error("Place search returned an invalid response.");
  }

  return results
    .filter((place) => {
      const countryCode = String(place.address?.country_code || "").toLowerCase();
      const lon = Number(place.lon);
      const lat = Number(place.lat);
      return countryCode === "in" && isValidCoordinate(lon, lat);
    })
    .map((place) => ({
      lat: Number(place.lat),
      lon: Number(place.lon),
      label: String(place.display_name || search),
    }));}