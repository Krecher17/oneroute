
import { useState } from "react";
import "./App.css";

export default function App() {
  const [destination, setDestination] = useState("");
  const [navigating, setNavigating] = useState(false);

  function startNavigation() {
    if (!destination.trim()) {
      alert("Enter a destination first.");
      return;
    }

    setNavigating(true);

    // Connect this action to your routing and navigation logic.
    if ("speechSynthesis" in window) {
      const speech = new SpeechSynthesisUtterance(
        `Navigation requested to ${destination}`
      );
      window.speechSynthesis.speak(speech);
    }
  }

  function stopNavigation() {
    setNavigating(false);
    window.speechSynthesis?.cancel();
  }

  return (
    <main className="app">
      <header className="header">
        <h1>ONEROUTE</h1>
        <p>Keep your convoy together.</p>
      </header>

      <section className="panel">
        <label htmlFor="destination">Destination</label>

        <input
          id="destination"
          value={destination}
          onChange={(event) =>
            setDestination(event.target.value)
          }
          placeholder="Enter a place in India"
        />

        <div className="controls">
          <button onClick={startNavigation}>
            ▶ Start Navigation
          </button>

          <button
            className="secondary"
            onClick={stopNavigation}
            disabled={!navigating}
          >
            ■ Stop
          </button>
        </div>

        <p aria-live="polite">
          {navigating
            ? "Navigation requested"
            : "Ready to start"}
        </p>
      </section>

      <section className="map-placeholder">
        Your interactive map will appear here.
      </section>
    </main>
  );
}
