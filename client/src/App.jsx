import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import MapView from "./MapView";
import "./App.css";

// Helper functions moved outside component for better performance
function formatCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(5) : "—";
}

function validCoordinate(lon, lat) {
  const x = Number(lon);
  const y = Number(lat);
  return Number.isFinite(x) && Number.isFinite(y) && x >= -180 && x <= 180 && y >= -90 && y <= 90;
}

function isOnline(member) {
  const status = String(member?.status || "").toLowerCase();
  return member?.connected !== false && member?.online !== false &&
    !["offline", "disconnected", "left"].includes(status);
}

function statusLabel(member) {
  const status = String(member?.status || "").toLowerCase();
  if (!isOnline(member)) return "Disconnected";
  if (["gap", "behind", "falling-behind"].includes(status)) return "Falling behind";
  if (["missed-turn", "off-route"].includes(status)) return "Check route";
  if (Number.isFinite(Number(member?.lat)) && Number.isFinite(Number(member?.lon))) return "Live location";
  return "Connected · waiting for GPS";
}

// Haversine formula to calculate distance between two coordinates in meters
function distanceBetweenCoords(lat1, lon1, lat2, lon2) {
  const toRad = (value) => value * Math.PI / 180;
  const R = 6371e3; // Earth's radius in meters
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c;
}

// Find the nearest point on a route to a given position
function findNearestPointOnRoute(position, routePoints) {
  if (!routePoints || routePoints.length === 0 || !position) return null;

  let minDistance = Infinity;
  let nearestPoint = null;
  let nearestIndex = 0;

  for (let i = 0; i < routePoints.length; i++) {
    const point = routePoints[i];
    const dist = distanceBetweenCoords(
      position.lat, position.lon,
      point[1], point[0] // Note: route points are [lon, lat]
    );

    if (dist < minDistance) {
      minDistance = dist;
      nearestPoint = point;
      nearestIndex = i;
    }
  }

  return { point: nearestPoint, index: nearestIndex, distance: minDistance };
}

// Find a point that's 'distanceMeters' ahead along the route from the nearest point
function lookAheadOnRoute(position, routePoints, distanceMeters) {
  if (!routePoints || routePoints.length < 2 || !position) return null;

  const nearest = findNearestPointOnRoute(position, routePoints);
  if (!nearest) return null;

  let accumulatedDistance = 0;
  let currentIndex = nearest.index;

  // Start from the nearest point and go forward along the route
  for (let i = currentIndex; i < routePoints.length - 1; i++) {
    const startPoint = routePoints[i];
    const endPoint = routePoints[i + 1];

    // Distance between this segment's points
    const segmentDistance = distanceBetweenCoords(
      startPoint[1], startPoint[0],
      endPoint[1], endPoint[0]
    );

    // If we've accumulated enough distance in this segment
    if (accumulatedDistance + segmentDistance >= distanceMeters) {
      // Interpolate within this segment
      const remainingDistance = distanceMeters - accumulatedDistance;
      const ratio = remainingDistance / segmentDistance;

      const lon = startPoint[0] + (endPoint[0] - startPoint[0]) * ratio;
      const lat = startPoint[1] + (endPoint[1] - startPoint[1]) * ratio;

      return [lon, lat];
    }

    accumulatedDistance += segmentDistance;
  }

  // If we reach here, we're near the end - return the last point
  const lastPoint = routePoints[routePoints.length - 1];
  return [lastPoint[0], lastPoint[1]];
}

// Calculate bearing between two points (for compass direction)
function calculateBearing(lat1, lon1, lat2, lon2) {
  const toRad = (value) => value * Math.PI / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) -
            Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  let θ = Math.atan2(y, x);
  const bearing = (θ * 180 / Math.PI + 360) % 360; // Convert to degrees and normalize
  return bearing;
}

export default function App() {
  const socketRef = useRef(null);
  const [destination, setDestination] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState("Driver");
  const [position, setPosition] = useState(null);
  const [route, setRoute] = useState([]);
  const [tripCode, setTripCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [convoyPositions, setConvoyPositions] = useState([]);
  const [status, setStatus] = useState("Ready to plan your journey");
  const [busy, setBusy] = useState(false);

  // Navigation state
  const [isNavigating, setIsNavigating] = useState(false);
  const [lookaheadPoint, setLookaheadPoint] = useState(null);
  const [navigationBearing, setNavigationBearing] = useState(null);
  const [deviationWarning, setDeviationWarning] = useState(false);

  useEffect(() => {
    const socket = io("/", { autoConnect: true });
    socketRef.current = socket;

    socket.on("connect", () => setStatus("Connected to ONEROUTE server"));
    socket.on("connect_error", () => setStatus("Cannot connect to server. Check that it is running."));
    socket.on("cars", (cars) => setConvoyPositions(Array.isArray(cars) ? cars : []));
    socket.on("alert", (alert) => {
      const alertName = alert?.name || "A convoy driver";
      setStatus(`${alertName}: ${alert?.type || "update"}`);
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
        const message = alert?.type === "missed-turn"
          ? `${alertName} may have missed a turn`
          : alert?.type === "gap"
            ? `${alertName} is falling behind`
            : `${alertName} has rejoined the route`;
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(message));
      }
    });
    socket.on("route-updated", (update) => setRoute(update?.route || []));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  function getLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Your browser does not support GPS location."));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (result) => resolve({
          lat: result.coords.latitude,
          lon: result.coords.longitude,
          label: "My current location",
        }),
        () => reject(new Error("Location permission denied. Allow location access and try again.")),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
      );
    });
  }

  async function searchDestination(event) {
    event.preventDefault();
    if (!destination.trim()) {
      setStatus("Enter a destination to search.");
      return;
    }
    setStatus("Searching places in India...");
    setResults([]);
    setSelected(null);
    try {
      const response = await fetch(`/geocode?q=${encodeURIComponent(destination.trim())}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Place search failed.");
      setResults(Array.isArray(data) ? data : []);
      if (!data?.length) setStatus("No matching places found. Try another search.");
      else setStatus("Select your destination from the results.");
    } catch (error) {
      setStatus(error.message || "Could not search destinations.");
    }
  }

  async function createTrip() {
    if (!selected) {
      setStatus("Search for and select a destination first.");
      return;
    }
    setBusy(true);
    setStatus("Getting your current location...");
    try {
      const start = await getLocation();
      setPosition(start);
      const socket = socketRef.current;
      if (!socket?.connected) throw new Error("Server is disconnected. Restart the backend.");
      socket.emit("create-trip", { name: name.trim() || "Driver", start, destination: selected }, (reply) => {
        setBusy(false);
        if (!reply?.ok) {
          setStatus(reply?.error || "Could not create convoy.");
          return;
        }
        setTripCode(reply.code);
        setJoinCode(reply.code);
        setRoute(reply.route || []);
        setStatus(`Convoy created successfully. Share code ${reply.code} with other drivers.`);
      });
    } catch (error) {
      setBusy(false);
      setStatus(error.message || "Could not get your location.");
    }
  }

  async function joinTrip() {
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setStatus("Enter the convoy code shared by the group leader.");
      return;
    }
    setBusy(true);
    setStatus("Getting your current location...");
    try {
      const start = await getLocation();
      setPosition(start);
      const socket = socketRef.current;
      if (!socket?.connected) throw new Error("Server is disconnected. Restart the backend.");
      setStatus("Joining convoy...");
      socket.emit("join-trip", { code, name: name.trim() || "Driver", start }, (reply) => {
        setBusy(false);
        if (!reply?.ok) {
          setStatus(reply?.error || "Could not join convoy. Check the code and try again.");
          return;
        }
        setTripCode(reply.code || code);
        setRoute(reply.route || []);
        setStatus(`Joined convoy ${reply.code || code}. Your live location is being shared.`);
      });
    } catch (error) {
      setBusy(false);
      setStatus(error.message || "Could not get your location.");
    }
  }

  useEffect(() => {
    if (!tripCode || !navigator.geolocation) return undefined;
    const watchId = navigator.geolocation.watchPosition(
      (result) => {
        const next = {
          lat: result.coords.latitude,
          lon: result.coords.longitude,
          accuracy: result.coords.accuracy,
          speed: result.coords.speed,
        };
        setPosition(next);
        socketRef.current?.emit("position", next);
      },
      () => setStatus("GPS update failed. Check your location permission."),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [tripCode]);

  // Navigation logic - update lookahead point and bearing when position or route changes
  useEffect(() => {
    if (!isNavigating || !position || !route || route.length === 0) {
      setLookaheadPoint(null);
      setNavigationBearing(null);
      setDeviationWarning(false);
      return;
    }

    const nearest = findNearestPointOnRoute(position, route);
    if (!nearest) {
      setLookaheadPoint(null);
      setNavigationBearing(null);
      setDeviationWarning(true); // Far off route
      return;
    }

    // Check if we're too far off route (> 50 meters)
    if (nearest.distance > 50) {
      setLookaheadPoint(null);
      setNavigationBearing(null);
      setDeviationWarning(true);
      return;
    }

    setDeviationWarning(false);

    // Look 30 meters ahead on the route
    const lookahead = lookAheadOnRoute(position, route, 30);
    if (lookahead) {
      setLookaheadPoint(lookahead);

      // Calculate bearing from current position to lookahead point
      const bearing = calculateBearing(
        position.lat, position.lon,
        lookahead[1], lookahead[0] // lookahead is [lon, lat]
      );
      setNavigationBearing(bearing);
    } else {
      // Near end of route
      setLookaheadPoint(null);
      setNavigationBearing(null);
    }
  }, [isNavigating, position, route]);

  // Improved members memoization with correct dependencies
  const members = useMemo(() => {
    if (!tripCode || !position) return [];

    const list = Array.isArray(convoyPositions) ? convoyPositions : [];
    const normalized = list.map((member, index) => ({
      ...member,
      id: member?.id ?? member?.socketId ?? `${member?.name || "Driver"}-${index}`,
      name: member?.name || "Driver",
    }));

    const selfAlreadyListed = normalized.some((member) =>
      (member.name || "").trim().toLowerCase() === (name.trim() || "Driver").toLowerCase()
    );

    if (!selfAlreadyListed) {
      normalized.unshift({
        id: "current-user",
        name: `${name.trim() || "Driver"} (you)`,
        lat: position.lat,
        lon: position.lon,
        status: "live",
        connected: true,
        isSelf: true,
      });
    }

    return normalized;
  }, [convoyPositions, name, position, tripCode]);

  const onlineCount = members.filter(isOnline).length;

  return (
    <main className="app">
      <style>{`
        .convoy-members-card { margin-top: 20px; }
        .members-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
        .members-heading .description { margin-top: 6px; }
        .member-count { white-space: nowrap; border-radius: 999px; padding: 6px 10px; background: #e8f7ed; color: #176b35; font-size: 13px; font-weight: 700; }
        .members-empty { padding: 14px; border-radius: 10px; background: rgba(127,127,127,.08); }
        .member-list { display: grid; gap: 10px; margin-top: 14px; }
        .member-row { display: flex; align-items: center; gap: 11px; padding: 12px; border: 1px solid rgba(127,127,127,.22); border-radius: 12px; min-width: 0; }
        .member-dot { width: 10px; height: 10px; flex: 0 0 10px; border-radius: 50%; }
        .member-dot.online { background: #16a34a; box-shadow: 0 0 0 3px rgba(22,163,74,.13); }
        .member-dot.offline { background: #9ca3af; }
        .member-main { display: grid; gap: 3px; min-width: 0; flex: 1; }
        .member-status, .member-coords, .member-meta, .members-note { color: #737373; font-size: 12px; overflow-wrap: anywhere; }
        .member-meta { display: grid; gap: 3px; text-align: right; }
        .members-note { margin-top: 12px; line-height: 1.45; }
        @media (max-width: 520px) { .member-row { align-items: flex-start; } .member-meta { max-width: 90px; } }

        /* Navigation styles */
        .navigation-controls { position: absolute; top: 20px; left: 20px; z-index: 1000; }
        .nav-button { background: rgba(255,255,255,0.9); border: none; border-radius: 8px; padding: 12px 16px; margin: 8px 0; cursor: pointer; font-weight: bold; }
        .nav-button.start { background: #65efb1; color: #0b1119; }
        .nav-button.stop { background: #ff6b6b; color: white; }
        .nav-button:disabled { opacity: 0.5; cursor: not-allowed; }
        .navigation-info { background: rgba(0,0,0,0.7); color: white; padding: 12px; border-radius: 8px; margin-top: 12px; font-size: 14px; }
        .deviation-warning { background: rgba(255,0,0,0.8); color: white; padding: 12px; border-radius: 8px; margin-top: 12px; animation: pulse 2s infinite; }
        @keyframes pulse { 0% { opacity: 0.8; } 50% { opacity: 1; } 100% { opacity: 0.8; } }
        .compass-container { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 1000; }
        .compass { width: 60px; height: 60px; background: rgba(255,255,255,0.9); border-radius: 50%; display: flex; align-items: center; justify-content: center; }
        .compass-needle { width: 0; height: 0; border-left: 15px solid transparent; border-right: 15px solid transparent; border-top: 25px solid #65efb1; }
      `}</style>
      <header className="header">
        <div className="logo">🧭 ONEROUTE</div>
        <span className="status">CONVOY NAVIGATION</span>
      </header>

      <section className="hero">
        <p className="eyebrow">TRAVEL AS ONE</p>
        <h1>Travel together.<br /><span>Arrive together.</span></h1>
        <p className="description">Create a convoy or join your group with a shared code.</p>
      </section>

      <section className="navigation-card">
        <h2>Plan your journey</h2>
        <label htmlFor="driverName">Driver name</label>
        <input id="driverName" value={name} onChange={(event) => setName(event.target.value)} placeholder="Enter your name" maxLength={20} />

        <form onSubmit={searchDestination}>
          <label htmlFor="destination">Destination in India</label>
          <div className="search-row">
            <input id="destination" value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Search city or place" />
            <button type="submit" disabled={busy}>Search</button>
          </div>
        </form>

        {results.length > 0 && (
          <div className="results">
            {results.map((place, index) => (
              <button type="button" key={`${place.lat}-${place.lon}-${index}`} className={`result ${selected === place ? "chosen" : ""}`} onClick={() => {
                setSelected(place);
                setStatus(`Destination selected: ${place.label}`);
              }}>
                📍 {place.label}
              </button>
            ))}
          </div>
        )}
        {selected && <p className="selected">Selected destination: <strong>{selected.label}</strong></p>}

        <div className="buttons">
          <button onClick={createTrip} disabled={busy || !selected}>{busy ? "Please wait..." : "🚘 Create Convoy"}</button>
        </div>

        <div className="join-panel">
          <h3>Joining an existing convoy?</h3>
          <p>Ask the convoy leader for their code, enter it below, and join.</p>
          <label htmlFor="joinCode">Convoy code</label>
          <div className="search-row">
            <input id="joinCode" value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="Enter convoy code" maxLength={12} />
            <button type="button" onClick={joinTrip} disabled={busy}>{busy ? "Joining..." : "Join Convoy"}</button>
          </div>
        </div>

        <div className="instruction" aria-live="polite">
          <span className="arrow">↑</span>
          <div><strong>{tripCode ? `Convoy code: ${tripCode}` : "Your journey"}</strong><p>{status}</p></div>
        </div>
      </section>

      <section className="map-card">
        <h2>Live route map</h2>
        <MapView
          route={route}
          position={position}
          convoyPositions={convoyPositions}
          isNavigating={isNavigating}
          lookaheadPoint={lookaheadPoint}
          navigationBearing={navigationBearing}
          deviationWarning={deviationWarning}
        />
        {tripCode && <p className="selected">Vehicle markers update when location reports arrive from the server.</p>}

        {/* Navigation Controls */}
        {route.length > 0 && position && !isNavigating && (
          <div className="navigation-controls">
            <button
              className="nav-button start"
              onClick={() => setIsNavigating(true)}
              disabled={busy || !position}
            >
              Start Navigation
            </button>
          </div>
        )}

        {isNavigating && (
          <>
            <div className="navigation-controls">
              <button
                className="nav-button stop"
                onClick={() => setIsNavigating(false)}
              >
                Stop Navigation
              </button>
            </div>

            {deviationWarning && (
              <div className="deviation-warning">
                You've deviated from the route. Please return to the blue line.
              </div>
            )}

            {!deviationWarning && lookaheadPoint && navigationBearing !== null && (
              <div className="navigation-info">
                Follow the blue line ahead. Turn when indicated.
              </div>
            )}

            <div className="compass-container">
              <div className="compass">
                <div className="compass-needle" style={{ transform: `rotate(${navigationBearing}deg)` }}></div>
              </div>
              <div style={{ textAlign: 'center', marginTop: 8px, fontSize: 12px, color: '#666' }}>
                Heading: {Math.round(navigationBearing || 0)}°
              </div>
            </div>
          </>
        )}
      </section>

      <section className="navigation-card convoy-members-card" aria-live="polite">
        <div className="members-heading">
          <div>
            <h2>Convoy members</h2>
            <p className="description">Driver locations and the latest status received by this app.</p>
          </div>
          <span className="member-count">{onlineCount} live</span>
        </div>
        {!tripCode ? (
          <p className="members-empty">Create or join a convoy to see its drivers here.</p>
        ) : members.length === 0 ? (
          <p className="members-empty">Waiting for vehicle reports. Allow location access and keep the app open.</p>
        ) : (
          <div className="member-list">
            {members.map((member) => {
              const online = isOnline(member);
              const hasCoordinates = validCoordinate(member?.lon, member?.lat);
              const label = statusLabel(member);
              return (
                <article className="member-row" key={member.id}>
                  <span className={`member-dot ${online ? "online" : "offline"}`} aria-label={online ? "Connected" : "Disconnected"} />
                  <div className="member-main">
                    <strong>{member.name}{member.isSelf ? "" : ""}</strong>
                    <span className="member-status">{label}</span>
                    {hasCoordinates && <span className="member-coords">{formatCoordinate(member.lat)}, {formatCoordinate(member.lon)}</span>}
                  </div>
                  <div className="member-meta">
                    {Number.isFinite(Number(member.gapKm)) && <span>{Number(member.gapKm).toFixed(1)} km gap</span>}
                    {Number.isFinite(Number(member.etaMin)) && <span>{Math.round(Number(member.etaMin))} min ETA</span>}
                  </div>
                </article>
              );
            })}
          </div>
        )}
        <p className="members-note">Connected status is based on the latest member data sent by your backend. A driver may appear offline only if the backend sends an offline/disconnected status.</p>
      </section>

      <footer>ONEROUTE · Keep the convoy together.</footer>
    </main>
  );
}