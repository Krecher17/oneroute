# ONEROUTE 🚗💨
> Real-Time Convoy Navigation & Group Trip Control

ONEROUTE keeps groups and convoys united on long road trips. Instead of relying on static maps or chaotic messaging threads, it provides synchronized real-time telemetry, automated deviation alerts, dynamic route coordination, and smart intercept recovery.
The link to test the site is :-
https://oneroute.dpdns.org/
---

## 📖 The Problem ONEROUTE Solves

Traveling in a multi-vehicle convoy is notoriously stressful:
* **The Accordion Effect**: Traffic lights, toll plazas, and overtaking maneuvers naturally pull cars apart.
* **Missed Exits & Wrong Turns**: A driver trailing behind misses a highway interchange, and nobody realizes until they are 15 kilometers away.
* **Dangerous Distractions**: Calling, texting, or checking group chats while driving at highway speeds is hazardous.
* **Roadside Regrouping**: Pulling an entire fleet over onto highway shoulders to wait for lost cars is inefficient and unsafe.

**ONEROUTE** replaces guesswork with automated convoy intelligence. Every driver connects to a shared trip via a 4-character code. The server continuously watches the fleet, detects deviations before they become disasters, and calculates mathematical rejoin points for the whole group.

---

## ✨ Key Features

### 📡 1. Live Convoy Telemetry & Route Snapping
* **Continuous Real-Time Tracking**: Every vehicle transmits GPS updates with high frequency over persistent WebSockets.
* **3-Point Moving Average Smoothing**: Eliminates GPS jitter and multipath interference in urban canyons or hilly terrain.
* **Accurate Route Snapping**: Projects raw coordinates onto the planned highway polyline to determine exact distance along the route (`snapKm`).
* **Speed Tracking**: Calculates smoothed vehicle velocity and computes individual ETAs to the destination in real time.
* **Arrival Detection**: Automatically transitions vehicles to an "Arrived" state when reaching within 150 meters of the final destination.

### 🚨 2. Smart Deviation & Missed Turn Alerts
* **Intelligent Tolerance Buffer**: Tolerates minor lane drifts, roadside gas stations, and rest areas up to 100 meters from the planned route corridor.
* **10-Second Confirmation Window**: A timer activates only when a vehicle remains >100m off-route. If the deviation persists beyond 10 seconds, the server broadcasts an immediate `missed-turn` alert.
* **Zero Alert Fatigue**: Fleeting deviations or temporary detours do not spam the convoy with false alarms.
* **Automatic Rejoin Notification**: The moment the driver returns to the route, the deviation clears and an alert informs the group that the driver has rejoined.

### 🧠 3. Intelligent Rejoin Recommendations (`bestRejoin`)
When a driver takes a wrong turn, ONEROUTE doesn't just display an error—it computes an actionable recovery strategy:
* **Dynamic Intercept Analysis**: Evaluates the lost driver's current position and speed against the trailing edge of the main convoy (`groupRearKm`).
* **Tactical Decision Engine**: Determines whether it is faster for the lost driver to take an upcoming bypass to catch up, or for the convoy ahead to hold at a designated milestone.
* **Actionable Metrics**:
  * **Rejoin Milestone (`km`)**: The exact point along the route where trajectories will intersect.
  * **Wait Duration (`waitMin`)**: Exactly how long the lead cars should wait at the milestone.
  * **Catch-Up Time (`behindMin`)**: Estimated minutes required for the stray vehicle to close the gap.

### 📏 4. Convoy Gap Monitoring
* **Fleet Spacing Watchdog**: Constantly calculates the spatial gap between the lead car and every trailing vehicle.
* **3 km Separation Warning**: If any car falls more than **3 km** behind the leader (`GAP_WARN_KM`), the system flags the vehicle as "Behind" and alerts the group.
* **Hysteresis Recovery**: Clears the warning only after the trailing car closes the gap below 1.5 km, preventing flickering alerts during stop-and-go driving.

### 🎙️ 5. Integrated Low-Latency Voice Messaging
* **In-App Push-to-Talk**: Drivers can send quick audio callouts without leaving the navigation screen or handling external messaging apps.
* **Web Audio API Streaming**: Records audio directly from the device microphone and transmits compact audio buffers over WebSockets.
* **Convoy Broadcast**: Immediately relays voice notes to every vehicle in the convoy room.

### 🗺️ 6. Interactive Map Dashboard & HUD
* **High-Contrast Dark Theme**: Designed specifically for in-car dashboard mounting, minimizing glare and eye strain during day and night driving.
* **MapLibre GL Vector Maps**: Smooth, interactive map rendering with dynamic vehicle icons, bearing indicators, and route overlays.
* **Live Status Pills**: Quick-glance color coding for every member:
  * 🟢 **On Route**: Within corridor and keeping pace.
  * 🟡 **Behind**: Trailing more than 3 km from the convoy leader.
  * 🔴 **Off Route**: Diverged from planned route.
  * 🔵 **Arrived**: Reached destination milestone.
  * ⚪ **Offline**: Lost GPS signal or disconnected.
* **Highway Amenity Overlays**: One-tap toggles to display nearby fuel stations and points of interest along the route.

---

## 🛠️ Tech Stack

### Backend Core
* **[Node.js](https://nodejs.org/) & [Express](https://expressjs.com/)**: REST endpoints for health checks, geocoding proxies, and static asset serving.
* **[Socket.IO](https://socket.io/)**: Full-duplex WebSocket communication for telemetry ingestion, state synchronization, voice streaming, and alerts.
* **In-Memory State Engine**: Manages concurrent convoy rooms, driver rosters, and runs a high-performance **1 Hz tick loop** evaluating fleet status.

### Geospatial & Routing
* **[Turf.js](https://turfjs.org/) & Spherical Haversine Math**: High-speed distance calculation, perpendicular line snapping, and coordinate transformation.
* **[OSRM (Open Source Routing Machine)](http://project-osrm.org/)**: Calculates turn-by-turn road geometry and driving distances between start, intermediate waypoints, and destinations.
* **[OpenStreetMap Nominatim](https://nominatim.org/)**: Location search and geocoding engine with boundary constraints.

### Frontend & Client HUD
* **[MapLibre GL JS](https://maplibre.org/)**: Hardware-accelerated vector map rendering.
* **HTML5 Geolocation API**: Continuous GPS tracking with high accuracy mode enabled.
* **Web Audio API**: Browser-native audio capture, buffering, and playback.

---

## 🚦 How It Works (Step-by-Step)

```text
 1. Create Trip       2. Join Convoy        3. Drive in Sync       4. Auto-Recovery
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐    ┌─────────────────┐
│ Enter start, │     │ Enter 4-char │     │ Real-time HUD    │    │ Missed a turn?  │
│ waypoints &  ├────►│ code (e.g.   ├────►│ shows all cars,  ├───►│ Rejoin point & │
│ destination  │     │ "K9XP")      │     │ gaps, and speeds │    │ wait-times sync │
└──────────────┘     └──────────────┘     └──────────────────┘    └─────────────────┘
```

1. **Trip Initialization**: The trip leader enters a start location, optional waypoints, and the final destination. The server queries OSRM, builds the complete route corridor, and issues a 4-character alphanumeric trip code.
2. **Room Admission**: Other drivers open the link on their smartphones, enter the 4-character code, and provide their name or vehicle callsign.
3. **Synchronized Cruising**: All connected devices display the shared route, live positions of all convoy members, and lead-vehicle distance metrics.
4. **Automated Incident Recovery**: If a vehicle takes the wrong exit, the server detects the divergence, notifies all cars, and computes a rendezvous point along the route.

---

## 🚀 Quick Start Guide

### Prerequisites
* [Node.js](https://nodejs.org/) (v18 or higher)
* `npm` (included with Node.js)

### Installation
```bash
# Clone the repository
git clone https://github.com/Krecher17/oneroute.git

# Move into the server directory
cd oneroute/server

# Install required dependencies
npm install
```

### Running Locally (Server & Web Client)
```bash
# Start the server
node index.js

# Or start in watch mode for development
npm run dev
```

Open your browser and navigate to:
```text
http://localhost:3001
```

### Running the Android Mobile App
The repository includes an installable Android app located in `mobile/`, powered by Capacitor 7.

**Prerequisites:**
* JDK 21
* Android Studio / Android SDK

```bash
# Move into the mobile directory
cd ../mobile

# Install dependencies and sync native Android project
npm install
npx cap sync android

# Run on a connected Android phone or emulator
npx cap run android
# Or open in Android Studio:
npx cap open android
```


---

## ⚙️ Configuration

Thresholds can be tuned via environment variables:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `3001` | Server listener port |
| `OFF_SECONDS` | `10` | Seconds a driver can be off-route before triggering an alert |
| `OFF_METERS` | `100` | Deviation distance in meters considered off-route |
| `GAP_WARN_KM` | `3` | Distance in kilometers before triggering a gap alert |
| `MAX_ACCURACY`| `80` | Maximum GPS accuracy radius (meters) accepted by the server |

---

## 📄 License
This project is open-source and licensed under the [MIT License](LICENSE).
