// geo.js
// Geographic route utilities for ONEROUTE
// Coordinates use the format [longitude, latitude].

const EARTH_RADIUS_METERS = 6371000;

/**
 * Calculate the distance between two geographic coordinates.
 * @param {[number, number]} a - [longitude, latitude]
 * @param {[number, number]} b - [longitude, latitude]
 * @returns {number} Distance in meters
 */
function distanceMeters(a, b) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;

  const lon1 = toRadians(a[0]);
  const lat1 = toRadians(a[1]);
  const lon2 = toRadians(b[0]);
  const lat2 = toRadians(b[1]);

  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(dLon / 2) ** 2;

  return (
    2 *
    EARTH_RADIUS_METERS *
    Math.asin(Math.sqrt(Math.min(1, h)))
  );
}

/**
 * Build a route object from an array of coordinates.
 *
 * Input:
 * [
 *   [longitude, latitude],
 *   [longitude, latitude]
 * ]
 *
 * Output includes:
 * - coordinates
 * - cumulativeKm
 * - totalKm
 */
export function makeRoute(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new Error(
      "A route must contain at least two coordinates."
    );
  }

  const points = coordinates.map((coordinate) => {
    if (
      !Array.isArray(coordinate) ||
      coordinate.length < 2 ||
      !Number.isFinite(Number(coordinate[0])) ||
      !Number.isFinite(Number(coordinate[1]))
    ) {
      throw new Error("Invalid route coordinate.");
    }

    const longitude = Number(coordinate[0]);
    const latitude = Number(coordinate[1]);

    if (
      longitude < -180 ||
      longitude > 180 ||
      latitude < -90 ||
      latitude > 90
    ) {
      throw new Error("Coordinate is outside valid geographic bounds.");
    }

    return [longitude, latitude];
  });

  const cumulativeKm = [0];
  let totalMeters = 0;

  for (let i = 1; i < points.length; i++) {
    totalMeters += distanceMeters(points[i - 1], points[i]);
    cumulativeKm.push(totalMeters / 1000);
  }

  return {
    coordinates: points,
    cumulativeKm,
    totalKm: totalMeters / 1000,
  };
}

/**
 * Find the closest point on a route to a given position.
 *
 * @param {object} route - Route created by makeRoute()
 * @param {[number, number]} position - [longitude, latitude]
 * @returns {{km: number, offMeters: number, point: [number, number], segmentIndex: number}}
 */
export function snap(route, position) {
  if (
    !route ||
    !Array.isArray(route.coordinates) ||
    route.coordinates.length < 2
  ) {
    throw new Error("Invalid route.");
  }

  if (
    !Array.isArray(position) ||
    position.length < 2 ||
    !Number.isFinite(Number(position[0])) ||
    !Number.isFinite(Number(position[1]))
  ) {
    throw new Error("Invalid position.");
  }

  const px = Number(position[0]);
  const py = Number(position[1]);

  let bestDistanceSquared = Infinity;
  let bestPoint = route.coordinates[0];
  let bestSegmentIndex = 0;
  let bestFraction = 0;

  // Approximate conversion from degrees to a local flat coordinate system.
  const latitudeRadians = (py * Math.PI) / 180;
  const longitudeScale = Math.cos(latitudeRadians);

  for (let i = 0; i < route.coordinates.length - 1; i++) {
    const a = route.coordinates[i];
    const b = route.coordinates[i + 1];

    const ax = (a[0] - px) * longitudeScale;
    const ay = a[1] - py;
    const bx = (b[0] - px) * longitudeScale;
    const by = b[1] - py;

    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;

    let fraction = 0;

    if (lengthSquared > 0) {
      fraction = Math.max(
        0,
        Math.min(1, -(ax * dx + ay * dy) / lengthSquared)
      );
    }

    const closestX = ax + fraction * dx;
    const closestY = ay + fraction * dy;
    const distanceSquared =
      closestX * closestX + closestY * closestY;

    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      bestSegmentIndex = i;
      bestFraction = fraction;

      bestPoint = [
        a[0] + fraction * (b[0] - a[0]),
        a[1] + fraction * (b[1] - a[1]),
      ];
    }
  }

  const segmentStartKm = route.cumulativeKm[bestSegmentIndex];
  const segmentEndKm = route.cumulativeKm[bestSegmentIndex + 1];

  const km =
    segmentStartKm +
    bestFraction * (segmentEndKm - segmentStartKm);

  const offMeters = distanceMeters([px, py], bestPoint);

  return {
    km,
    offMeters,
    point: bestPoint,
    segmentIndex: bestSegmentIndex,
  };
}