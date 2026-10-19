// rejoin.js
// ONEROUTE: Convoy rejoin recommendation utilities

const EARTH_RADIUS_METERS = 6371000;
const MIN_SPEED_KMH = 20;

/**
 * Calculate distance between two coordinates in meters.
 * Coordinates use [longitude, latitude].
 */
function distanceMeters(a, b) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;

  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLat = lat2 - lat1;
  const dLon = toRad(b[0] - a[0]);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS *
    Math.asin(Math.sqrt(Math.min(1, h)));
}

/**
 * Find a suggested rejoin point on the planned route.
 *
 * @param {object} options
 * @param {object} options.route - Route returned by makeRoute() in geo.js
 * @param {[number, number]} options.pos - Driver position [longitude, latitude]
 * @param {number} options.snapKm - Driver's current distance along the route
 * @param {number} options.speed - Driver's speed in km/h
 * @param {number} options.groupRearKm - Rear-most convoy member's route distance
 * @param {number} options.groupSpeed - Average convoy speed in km/h
 *
 * @returns {object|null} Rejoin recommendation
 */
export function bestRejoin({
  route,
  pos,
  snapKm,
  speed,
  groupRearKm,
  groupSpeed,
}) {
  if (
    !route ||
    !Array.isArray(route.coordinates) ||
    route.coordinates.length < 2 ||
    !Array.isArray(pos) ||
    pos.length < 2
  ) {
    return null;
  }

  const coordinates = route.coordinates;
  const cumulativeKm = route.cumulativeKm;

  if (
    !Array.isArray(cumulativeKm) ||
    cumulativeKm.length !== coordinates.length
  ) {
    return null;
  }

  const totalKm = Number(route.totalKm);

  if (!Number.isFinite(totalKm) || totalKm <= 0) {
    return null;
  }

  const currentKm = Number.isFinite(snapKm)
    ? Math.max(0, Math.min(totalKm, snapKm))
    : 0;

  const driverSpeed = Math.max(
    Number(speed) || MIN_SPEED_KMH,
    MIN_SPEED_KMH
  );

  const convoySpeed = Math.max(
    Number(groupSpeed) || MIN_SPEED_KMH,
    MIN_SPEED_KMH
  );

  const rearKm = Number.isFinite(groupRearKm)
    ? Math.max(0, Math.min(totalKm, groupRearKm))
    : currentKm;

  // Find the nearest point on the planned route.
  let nearest = {
    distance: Infinity,
    point: coordinates[0],
    km: cumulativeKm[0],
  };

  for (let i = 0; i < coordinates.length - 1; i++) {
    const a = coordinates[i];
    const b = coordinates[i + 1];

    const meanLat = ((a[1] + b[1]) / 2) * Math.PI / 180;
    const lonScale = Math.cos(meanLat);

    const ax = (a[0] - pos[0]) * lonScale;
    const ay = a[1] - pos[1];
    const bx = (b[0] - pos[0]) * lonScale;
    const by = b[1] - pos[1];

    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;

    let t = 0;

    if (lengthSquared > 0) {
      t = Math.max(
        0,
        Math.min(1, -(ax * dx + ay * dy) / lengthSquared)
      );
    }

    const projectedX = ax + t * dx;
    const projectedY = ay + t * dy;
    const distance = Math.hypot(projectedX, projectedY);

    if (distance < nearest.distance) {
      const point = [
        a[0] + t * (b[0] - a[0]),
        a[1] + t * (b[1] - a[1]),
      ];

      const km =
        cumulativeKm[i] +
        t * (cumulativeKm[i + 1] - cumulativeKm[i]);

      nearest = {
        distance,
        point,
        km,
      };
    }
  }

  // Compare rejoining near the driver's closest route point
  // with continuing forward to catch the convoy.
  const directKm = Math.max(currentKm, nearest.km);
  const catchupKm = Math.max(directKm, rearKm);

  const directWaitMin =
    (Math.abs(directKm - currentKm) / driverSpeed) * 60;

  const catchupWaitMin =
    (Math.abs(catchupKm - currentKm) / driverSpeed) * 60;

  const convoyDelayMin =
    (Math.abs(catchupKm - rearKm) / convoySpeed) * 60;

  const useCatchup =
    catchupKm > directKm + 0.5 &&
    catchupWaitMin > directWaitMin;

  const rejoinKm = useCatchup ? catchupKm : directKm;
  const rejoinWait = useCatchup ? catchupWaitMin : directWaitMin;

  // Find the coordinate on the route closest to the chosen route distance.
  let point = coordinates[coordinates.length - 1];

  for (let i = 0; i < cumulativeKm.length - 1; i++) {
    if (rejoinKm <= cumulativeKm[i + 1]) {
      const segmentLength =
        cumulativeKm[i + 1] - cumulativeKm[i];

      const t =
        segmentLength > 0
          ? Math.max(
              0,
              Math.min(
                1,
                (rejoinKm - cumulativeKm[i]) / segmentLength
              )
            )
          : 0;

      point = [
        coordinates[i][0] +
          t * (coordinates[i + 1][0] - coordinates[i][0]),
        coordinates[i][1] +
          t * (coordinates[i + 1][1] - coordinates[i][1]),
      ];

      break;
    }
  }

  return {
    kind: useCatchup ? "catch-up" : "nearest-route",
    km: rejoinKm,
    waitMin: rejoinWait,
    behindMin: convoyDelayMin,
    point,
  };
}