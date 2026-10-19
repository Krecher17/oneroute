import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const EMPTY_FEATURES = { type: "FeatureCollection", features: [] };

function validCoordinate(lon, lat) {
  const x = Number(lon);
  const y = Number(lat);
  return Number.isFinite(x) && Number.isFinite(y) && x >= -180 && x <= 180 && y >= -90 && y <= 90;
}

function makePointFeature(member, index) {
  if (!validCoordinate(member?.lon, member?.lat)) return null;
  return {
    type: "Feature",
    properties: {
      id: String(member?.id ?? index),
      name: String(member?.name || `Driver ${index + 1}`),
      status: String(member?.status || "live"),
      color: member?.isSelf ? "#1976d2" : "#7c3aed",
    },
    geometry: { type: "Point", coordinates: [Number(member.lon), Number(member.lat)] },
  };
}

// Function to create a navigation lookahead feature
function makeLookaheadFeature(point) {
  if (!point || !Array.isArray(point) || point.length !== 2) return null;
  return {
    type: "Feature",
    properties: {
      id: "lookahead",
      name: "Direction",
      status: "lookahead",
      color: "#ff9800", // Orange color for lookahead point
    },
    geometry: { type: "Point", coordinates: [Number(point[0]), Number(point[1])] },
  };
}

export default function MapView({
  route = [],
  position = null,
  convoyPositions = [],
  isNavigating = false,
  lookaheadPoint = null,
  navigationBearing = null,
  deviationWarning = false
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const routeRef = useRef(route);
  const positionRef = useRef(position);
  const carsRef = useRef(convoyPositions);
  const markersRef = useRef(new Map());

  useEffect(() => { routeRef.current = route; }, [route]);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { carsRef.current = convoyPositions; }, [convoyPositions]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://demotiles.maplibre.org/style.json",
      center: [78.9629, 20.5937],
      zoom: 4,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    const updateRouteSource = () => {
      if (!map.isStyleLoaded()) return;
      const routeSource = map.getSource("oneroute-route");
      if (routeSource) {
        const coordinates = Array.isArray(routeRef.current) ? routeRef.current : [];
        const usable = coordinates.filter((point) => Array.isArray(point) && validCoordinate(point[0], point[1])).map((point) => [Number(point[0]), Number(point[1])]);
        routeSource.setData(usable.length >= 2 ? {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: usable },
        } : EMPTY_FEATURES);
        if (usable.length >= 2 && !map.__onerouteHasFit) {
          const bounds = usable.reduce((b, coord) => b.extend(coord), new maplibregl.LngLatBounds(usable[0], usable[0]));
          map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 });
          map.__onerouteHasFit = true;
        }
      }
    };

    const updateMarkers = () => {
      if (!map.isStyleLoaded()) return;

      const current = positionRef.current;
      const members = Array.isArray(carsRef.current) ? [...carsRef.current] : [];
      const selfListed = current && members.some((car) =>
        validCoordinate(car?.lon, car?.lat) &&
        Math.abs(Number(car.lon) - Number(current.lon)) < 0.00001 &&
        Math.abs(Number(car.lat) - Number(current.lat)) < 0.00001
      );
      if (current && validCoordinate(current.lon, current.lat) && !selfListed) {
        members.unshift({ id: "current-user", name: "You", lon: current.lon, lat: current.lat, isSelf: true });
      }

      const activeIds = new Set();
      members.forEach((member, index) => {
        const feature = makePointFeature(member, index);
        if (!feature) return;
        const id = feature.properties.id;
        activeIds.add(id);
        let markerEntry = markersRef.current.get(id);
        if (!markerEntry) {
          const element = document.createElement("div");
          element.className = "oneroute-map-marker";
          element.style.width = "18px";
          element.style.height = "18px";
          element.style.borderRadius = "50%";
          element.style.border = "3px solid white";
          element.style.boxShadow = "0 1px 7px rgba(0,0,0,.45)";
          const marker = new maplibregl.Marker({ element, anchor: "center" })
            .setLngLat(feature.geometry.coordinates)
            .addTo(map);
          markerEntry = { marker, element, popup: null };
          markersRef.current.set(id, markerEntry);
        }
        markerEntry.element.style.backgroundColor = feature.properties.color;
        markerEntry.element.title = `${feature.properties.name} — ${feature.properties.status}`;
        markerEntry.marker.setLngLat(feature.geometry.coordinates);
        if (markerEntry.popup) markerEntry.popup.remove();
        markerEntry.popup = new maplibregl.Popup({ offset: 14, closeButton: false, closeOnClick: false })
          .setText(`${feature.properties.name} · ${feature.properties.status}`);
        markerEntry.marker.setPopup(markerEntry.popup);
      });
      for (const [id, entry] of markersRef.current.entries()) {
        if (!activeIds.has(id)) {
          entry.marker.remove();
          markersRef.current.delete(id);
        }
      }
    };

    const updateLookaheadMarker = () => {
      if (!map.isStyleLoaded() || !isNavigating || !lookaheadPoint) {
        // Remove lookahead marker if it exists
        const lookaheadEntry = markersRef.current.get("lookahead");
        if (lookaheadEntry) {
          lookaheadEntry.marker.remove();
          markersRef.current.delete("lookahead");
        }
        return;
      }

      const lookaheadFeature = makeLookaheadFeature(lookaheadPoint);
      if (!lookaheadFeature) return;

      const id = lookaheadFeature.properties.id;
      let markerEntry = markersRef.current.get(id);
      if (!markerEntry) {
        const element = document.createElement("div");
        element.className = "oneroute-map-marker lookahead-marker";
        element.style.width = "24px"; // Slightly larger than regular markers
        element.style.height = "24px";
        element.style.borderRadius = "50%";
        element.style.border = "3px solid white";
        element.style.boxShadow = "0 2px 10px rgba(0,0,0,.6)";
        element.style.backgroundColor = lookaheadFeature.properties.color;
        const marker = new maplibregl.Marker({ element, anchor: "center" })
          .setLngLat(lookaheadFeature.geometry.coordinates)
          .addTo(map);
        markerEntry = { marker, element, popup: null };
        markersRef.current.set(id, markerEntry);
      }
      markerEntry.marker.setLngLat(lookaheadFeature.geometry.coordinates);
    };

    const syncData = () => {
      updateRouteSource();
      updateMarkers();
      updateLookaheadMarker();
    };

    map.on("load", () => {
      map.addSource("oneroute-route", { type: "geojson", data: EMPTY_FEATURES });
      map.addLayer({
        id: "oneroute-route-line",
        type: "line",
        source: "oneroute-route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#2563eb", "line-width": 5, "line-opacity": 0.85 },
      });
      syncData();
    });
    map.on("styledata", syncData);
    map.on("idle", syncData);

    // Keep the map aligned with the most recent props even if the map loads slowly.
    const interval = window.setInterval(() => {
      if (mapRef.current && map.isStyleLoaded()) syncData();
    }, 1200);

    return () => {
      window.clearInterval(interval);
      map.off("styledata", syncData);
      map.off("idle", syncData);
      markersRef.current.forEach((entry) => entry.marker.remove());
      markersRef.current.clear();
      map.remove();
      mapRef.current = null;
    };
  }, [isNavigating, lookaheadPoint]);

  // Prop changes update refs above; this event prompts a fresh draw without recreating the map.
  useEffect(() => {
    const map = mapRef.current;
    if (map && map.isStyleLoaded()) map.fire("idle");
  }, [route, position, convoyPositions]);

  return (
    <div className={`oneroute-map-wrap ${isNavigating ? 'navigating' : ''}`}>
      <style>{`
        .oneroute-map-wrap { width: 100%; min-width: 0; position: relative; }
        .oneroute-map { width: 100%; height: 420px; min-height: 320px; border-radius: 12px; overflow: hidden; background: #e5e7eb; transition: all 0.3s ease; }
        .oneroute-map-wrap.navigating .oneroute-map { height: 100vh; max-height: none; border-radius: 0; }
        .oneroute-map-legend { display: flex; gap: 16px; flex-wrap: wrap; padding: 10px 2px 0; font-size: 12px; color: #737373; position: absolute; bottom: 20px; left: 20px; z-index: 1000; background: rgba(0,0,0,0.7); border-radius: 8px; }
        .oneroute-map-legend span { display: inline-flex; align-items: center; gap: 6px; }
        .legend-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; }
        .legend-dot.you { background: #1976d2; }
        .legend-dot.others { background: #7c3aed; }
        .legend-dot.lookahead { background: #ff9800; }
        @media (max-width: 520px) { .oneroute-map { height: 340px; } }

        /* Compass styles for navigation */
        .compass-wrapper { position: absolute; bottom: 20px; right: 20px; z-index: 1000; }
        .compass { width: 80px; height: 80px; background: rgba(255,255,255,0.9); border-radius: 50%; display: flex; align-items: center; justify-content: center; position: relative; }
        .compass-ring { width: 60px; height: 60px; border: 2px solid #666; border-radius: 50%; position: absolute; }
        .compass-needle { width: 0; height: 0; border-left: 15px solid transparent; border-right: 15px solid transparent; border-top: 25px solid #65efb1; position: absolute; top: 10px; left: 50%; transform: translateX(-50%) rotate(var(--bearing)); }
        .compass-center { width: 6px; height: 6px; background: #65efb1; border-radius: 50%; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); }
        .compass-label { position: absolute; bottom: -20px; left: 50%; transform: translateX(-50%); font-size: 12px; color: #666; }

        /* Deviation warning styles */
        .deviation-warning { position: absolute; top: 20px; right: 20px; background: rgba(255,0,0,0.8); color: white; padding: 12px 16px; border-radius: 8px; z-index: 1000; font-weight: bold; animation: pulse 2s infinite; }
        @keyframes pulse { 0% { opacity: 0.8; } 50% { opacity: 1; } 100% { opacity: 0.8; } }

        /* Lookahead marker styles */
        .loneroute-map-marker.lookahead-marker { border: 3px solid #ff9800; box-shadow: 0 0 0 3px rgba(255,152,0,0.3); }
      `}</style>
      <div ref={containerRef} className="oneroute-map" role="application" aria-label="Live convoy route map" />

      {/* Navigation overlays */}
      {isNavigating && (
        <>
          {deviationWarning && (
            <div className="deviation-warning">
              Off route! Please return to the blue line.
            </div>
          )}

          <div className="compass-wrapper">
            <div className="compass">
              <div className="compass-ring"></div>
              <div className="compass-needle" style={{ '--bearing': `${navigationBearing !== null ? navigationBearing : 0}deg` }}></div>
              <div className="compass-center"></div>
            </div>
            <div className="compass-label">Heading</div>
          </div>
        </>
      )}

      <div className="oneroute-map-legend">
        <span><i className="legend-dot you" /> Your vehicle</span>
        <span><i className="legend-dot others" /> Convoy vehicles</span>
        {isNavigating && <span><i className="legend-dot lookahead" /> Direction ahead</span>}
      </div>
    </div>
  );
}