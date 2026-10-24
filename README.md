# ONEROUTE 🚗💨
> **Real-Time Convoy Navigation, Group Trip Control & Fleet Synchronization**

[![Live Demo](https://img.shields.io/badge/Live_Demo-oneroute.dpdns.org-42c786?style=for-the-badge&logo=googlechrome&logoColor=white)](https://oneroute.dpdns.org)
[![Node.js](https://img.shields.io/badge/Node.js-v18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-Realtime-010101?style=for-the-badge&logo=socketdotio&logoColor=white)](https://socket.io)
[![Android](https://img.shields.io/badge/Android-Capacitor_7-3DDC84?style=for-the-badge&logo=android&logoColor=white)](https://capacitorjs.com)
[![MapLibre](https://img.shields.io/badge/MapLibre_GL-Vector_Maps-0085FF?style=for-the-badge&logo=maplibre&logoColor=white)](https://maplibre.org)
[![License: Restricted](https://img.shields.io/badge/License-Restricted_Source--Available-red.svg?style=for-the-badge)](LICENSE)

---

### 🌐 Live Deployment
**Test the live application right now:** 👉 **[https://oneroute.dpdns.org](https://oneroute.dpdns.org/)**

---

## 📖 The Problem ONEROUTE Solves

Traveling together in a multi-vehicle convoy or road trip is notoriously difficult:
* **The Accordion Effect:** Traffic lights, toll plazas, and highway overtakes naturally pull cars apart.
* **Missed Exits & Wrong Turns:** A driver trailing behind takes a wrong exit, and nobody realizes until they are 15 kilometers away.
* **Dangerous Distractions:** Calling, texting, or checking group chats while driving at highway speeds is hazardous.
* **Roadside Regrouping:** Pulling an entire fleet over onto highway shoulders or highway exits to wait for lost cars is inefficient and unsafe.

**ONEROUTE** replaces guesswork with automated convoy intelligence. Every driver connects to a shared trip with a simple 4-character code. The server continuously monitors the fleet, detects deviations before they become emergencies, alerts drivers hands-free, and calculates mathematical rendezvous intercept points for the group.

---

## 🏗️ Repository Architecture

This repository is organized as a monorepo containing both the real-time server / web client and the installable Android companion app:

```text
oneroute/
├── server/                     # Node.js + Express + Socket.IO backend & Web HUD
│   ├── index.js                # Core telemetry engine, WebSocket rooms & 1 Hz watchdog loop
│   ├── geo.js                  # Polyline snapping, distance math & smoothing
│   ├── routing.js              # OSRM highway corridor routing & Nominatim geocoding
│   ├── rejoin.js               # Mathematical intercept calculation for lost drivers
│   └── public/                 # High-contrast MapLibre driver dashboard
├── mobile/                     # Installable native Android application
│   ├── android/                # Native Gradle project (Java 21, Android SDK)
│   ├── web/                    # Embedded WebView shell with fallback custom server switcher
│   └── capacitor.config.ts     # Capacitor 7 Android bridge configuration
└── README.md
```

---

## ✨ Key Features

### 📡 1. Live Convoy Telemetry & Route Snapping
* **Continuous Real-Time Tracking:** High-frequency GPS updates transmitted over persistent WebSockets.
* **3-Point Moving Average Smoothing:** Filters out GPS multipath interference and altitude jitter in tunnels, hills, and urban areas.
* **Accurate Polyline Snapping:** Projects raw GPS coordinates onto the planned highway corridor to determine exact travel distance along the route (`snapKm`).
* **Velocity & Dynamic ETAs:** Computes smoothed velocity to predict individual arrival times for each vehicle.
* **Arrival Detection:** Automatically transitions vehicles to an "Arrived" state when crossing within 150 meters of the destination.

### 🚨 2. Smart Deviation & Missed-Turn Alerts
* **Intelligent Tolerance Corridor:** Permits roadside stops, gas stations, and rest areas up to 100 meters off the planned route without nuisance alerts.
* **10-Second Confirmation Window:** If a vehicle drifts >100m away for longer than 10 seconds, the server broadcasts an immediate `missed-turn` alert to the entire convoy.
* **Zero Alert Fatigue:** Fleeting lane drifts or momentary GPS blips do not trigger false alarms.
* **Automatic Rejoin Notification:** The moment the driver returns to the highway corridor, the deviation clears and an alert announces the driver has rejoined.

### 🧠 3. Intelligent Intercept & Rejoin Engine (`bestRejoin`)
When a driver takes a wrong turn, ONEROUTE computes an actionable group recovery strategy:
* **Dynamic Intercept Analysis:** Evaluates the separated driver's current position and speed against the trailing edge of the main convoy (`groupRearKm`).
* **Tactical Decision Engine:** Determines whether the lost vehicle should take an upcoming bypass to catch up, or if the lead convoy should hold at an upcoming milestone.
* **Actionable Metrics Provided:**
  * **Rejoin Milestone (`km`):** The exact distance mark where trajectories will intersect.
  * **Wait Duration (`waitMin`):** Exactly how many minutes lead cars should pause at the milestone.
  * **Catch-Up Time (`behindMin`):** Estimated minutes required for the stray vehicle to close the gap.

### 📏 4. Convoy Gap Monitoring
* **Fleet Spacing Watchdog:** Constantly tracks spatial gaps between the lead car and trailing vehicles.
* **3 km Separation Warning:** If any vehicle falls >3 km behind the lead vehicle (`GAP_WARN_KM`), the system flags the vehicle as "Behind" and alerts the group.
* **Hysteresis Recovery:** Clears the warning only after the trailing car closes the gap below 1.5 km, preventing flickering alerts during stop-and-go driving.

### 🎙️ 5. Push-to-Talk Voice Messaging & Canned Quick Replies
* **In-App Voice Broadcast:** Drivers can send quick audio callouts without leaving the navigation screen or handling messaging apps.
* **Web Audio API Streaming:** Compresses and streams low-latency audio chunks over WebSockets to all cars.
* **Canned Quick Messages:** One-tap status updates ("Fuel stop", "Need a break", "Overtaking") to communicate instantly without talking.

### 🔗 6. Read-Only Spectator Live Links
* **Live View for Family & Friends:** Every trip generates an optional read-only view link (`/live/:token`).
* Spectators can follow the convoy's live positions and route progress in their browser without joining the driver room or transmitting audio.

### 📱 7. Native Android App (Capacitor 7)
* **Dedicated Mobile Shell:** Runs in full-screen in-car mode with no browser URL bars or accidental tab closing.
* **Custom Server Switcher:** Built-in connection screen allows switching between the deployed cloud server (`oneroute.dpdns.org`) and local self-hosted development servers.

### 🗺️ 8. High-Contrast Dashboard HUD
* **In-Car Dark Theme:** High contrast, glare-resistant interface optimized for windshield or dashboard phone mounts.
* **Live Status Markers:** Instant visual indicators:
  * 🟢 **On Route**: Within corridor and keeping pace.
  * 🟡 **Behind**: Trailing >3 km behind the convoy leader.
  * 🔴 **Off Route**: Diverged from planned route.
  * 🔵 **Arrived**: Reached destination milestone.
  * ⚪ **Offline**: Lost GPS signal or disconnected.
* **Highway Amenities:** One-tap Overpass API overlay displaying nearby fuel stations along the route.

---

## 🛠️ Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Backend Core** | Node.js, Express, Socket.IO (WebSocket rooms & 1 Hz tick loop) |
| **Mobile App** | Capacitor 7, Android SDK, Java 21, Gradle |
| **Geospatial & Routing** | OSRM (Open Source Routing Machine), Turf.js, OpenStreetMap Nominatim, Overpass API |
| **Frontend UI** | MapLibre GL JS, Web Audio API, HTML5 Geolocation API |

---

## 🚦 How It Works

```text
 1. Create Trip       2. Join Convoy        3. Drive in Sync       4. Auto-Recovery
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐    ┌─────────────────┐
│ Enter start, │     │ Enter 4-char │     │ Real-time HUD    │    │ Missed a turn?  │
│ waypoints &  ├────►│ code (e.g.   ├────►│ shows all cars,  ├───►│ Rejoin point & │
│ destination  │     │ "K9XP")      │     │ gaps, and speeds │    │ wait-times sync │
└──────────────┘     └──────────────┘     └──────────────────┘    └─────────────────┘
```

1. **Trip Initialization:** The convoy leader enters start, optional waypoints, and destination. The server queries OSRM to generate the highway corridor polyline and assigns a unique 4-character trip code.
2. **Convoy Admission:** Other drivers enter the 4-character code on their phone or Android app to enter the shared room.
3. **Synchronized Cruising:** All connected vehicles stream GPS telemetry and render real-time positions, speeds, and gaps on the map HUD.
4. **Automated Recovery:** If any car takes a wrong turn, the server alerts the convoy and computes a designated rendezvous point.

---

## 🚀 Quick Start Guide

### Prerequisites
* [Node.js](https://nodejs.org/) (v18 or higher) & `npm`
* *(Optional for Android build)*: JDK 21, Android Studio / Android SDK

---

### Option 1: Running the Server & Web HUD Locally

```bash
# Clone the repository
git clone https://github.com/Krecher17/oneroute.git
cd oneroute/server

# Install dependencies
npm install

# Start the server (runs on port 3001 by default)
node index.js

# Or start in development watch mode
npm run dev
```

Open your browser and navigate to:
```text
http://localhost:3001
```

---

### Option 2: Running the Android Mobile App

The `mobile/` directory contains the Capacitor Android application:

```bash
# Navigate to the mobile directory
cd oneroute/mobile

# Install dependencies and sync native assets
npm install
npx cap sync android

# Run on a connected Android phone or active emulator
npx cap run android

# Or open the project in Android Studio
npx cap open android
```

#### Connecting the Android App to Your Local Server:
* **Android Emulator:** Use `http://10.0.2.2:3001` in the app's connection prompt.
* **Physical Device over Wi-Fi:** Ensure your phone and computer share the same Wi-Fi network, and use `http://<YOUR_LAN_IP>:3001`.
* **Production:** Enter `https://oneroute.dpdns.org`.

---

## ⚙️ Environment Variables

The server can be configured via environment variables (or a `.env` file):

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `3001` | HTTP / WebSocket server port |
| `OFF_SECONDS` | `10` | Deviation duration in seconds before declaring a missed turn |
| `OFF_METERS` | `100` | Deviation threshold from route corridor in meters |
| `GAP_WARN_KM` | `3` | Distance gap from lead car before triggering a lag warning |
| `MAX_ACCURACY`| `80` | Maximum acceptable GPS accuracy radius in meters |

---

## 📄 License & Access

Copyright (c) 2026 **Akshay Shankar (Krecher17)**. All rights reserved.

This project is protected under a **Restricted Source-Available License**.
* ✅ **Permitted:** Viewing, personal testing, academic/educational study, and portfolio evaluation.
* ❌ **Prohibited:** Commercial use, commercial hosting/SaaS deployments, re-distribution, or creating closed/re-branded derivative works without explicit written permission.

For full terms, see the [LICENSE](LICENSE) file. For licensing or partnership inquiries, contact: **jiya.lenu@gmail.com**.
