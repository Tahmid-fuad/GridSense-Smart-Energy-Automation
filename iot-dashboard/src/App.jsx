import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { API_BASE, DEVICE_ID } from "./config";
import "./App.css";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

function Stat({ label, value, hint }) {
  return (
    <div className="stat">
      <div className="statLabel">{label}</div>
      <div className="statValue">{value}</div>
      {hint ? <div className="statHint">{hint}</div> : null}
    </div>
  );
}

function RelayCard({ ch, state, onToggle, disabled }) {
  const isOn = state === 1;
  return (
    <button
      className="relayBtn"
      onClick={() => onToggle(ch, isOn ? 0 : 1)}
      disabled={disabled}
      type="button"
    >
      <div className="relayTop">
        <div className="relayName">Relay {ch}</div>
        <div className={`badge ${isOn ? "on" : ""}`}>{isOn ? "ON" : "OFF"}</div>
      </div>
      <div className="relayDesc">
        Click to {isOn ? "turn OFF" : "turn ON"} channel {ch}.
      </div>
    </button>
  );
}

function formatTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour12: false });
  } catch {
    return "";
  }
}

export default function App() {
  const [latest, setLatest] = useState(null);
  const [device, setDevice] = useState(null);
  const [history, setHistory] = useState([]);

  const [loadingRelay, setLoadingRelay] = useState(false);
  const [error, setError] = useState("");

  // Graph timeframe (minutes)
  const [timeframeMin, setTimeframeMin] = useState(30);

  const timeframeOptions = [
    { label: "15 min", value: 15 },
    { label: "30 min", value: 30 },
    { label: "1 hour", value: 60 },
    { label: "6 hours", value: 360 },
    { label: "24 hours", value: 1440 },
  ];

  const lastSeenText = useMemo(() => {
    if (!device?.lastSeen) return "Unknown";
    const secAgo = Math.max(0, Math.floor(Date.now() / 1000 - device.lastSeen));
    return `${secAgo}s ago`;
  }, [device]);

  const online = useMemo(() => {
    if (!device?.lastSeen) return false;
    const secAgo = Math.max(0, Math.floor(Date.now() / 1000 - device.lastSeen));
    return secAgo <= 6;
  }, [device]);

  async function fetchLatest() {
    try {
      setError("");
      const [latestRes, devRes] = await Promise.all([
        axios.get(`${API_BASE}/api/latest/${DEVICE_ID}`),
        axios.get(`${API_BASE}/api/device/${DEVICE_ID}`),
      ]);
      setLatest(latestRes.data);
      setDevice(devRes.data);
    } catch {
      setError("Backend not reachable. Check API base URL.");
    }
  }

  async function fetchHistory() {
    try {
      const res = await axios.get(
        `${API_BASE}/api/history/${DEVICE_ID}?limit=2000`
      );
      setHistory(Array.isArray(res.data) ? res.data : []);
    } catch {
      // keep silent to avoid flicker; latest fetch already sets error if backend is down
    }
  }

  async function toggleRelay(ch, state) {
    try {
      setLoadingRelay(true);
      setError("");
      await axios.post(`${API_BASE}/api/relay/${DEVICE_ID}`, { ch, state });
      setTimeout(fetchLatest, 400);
    } catch {
      setError("Relay command failed. Check backend logs and MQTT connectivity.");
    } finally {
      setLoadingRelay(false);
    }
  }

  useEffect(() => {
    fetchLatest();
    fetchHistory();

    const t = setInterval(fetchLatest, 2000);
    const h = setInterval(fetchHistory, 8000);

    return () => {
      clearInterval(t);
      clearInterval(h);
    };
  }, []);

  const v = latest?.voltage;
  const i = latest?.current;
  const p = latest?.power;
  const ewh = latest?.energyWh;
  const rssi = latest?.rssi;

  const relay = latest?.relay || device?.relay || [0, 0, 0, 0];

  const chartData = useMemo(() => {
    const rows = (history || [])
      .map((row) => {
        const t = row?.createdAt
          ? new Date(row.createdAt).getTime()
          : row?.ts
          ? row.ts * 1000
          : null;

        const voltage = typeof row?.voltage === "number" ? row.voltage : null;

        return t && voltage != null ? { t, voltage } : null;
      })
      .filter(Boolean);

    if (rows.length === 0) return [];

    const cutoff = Date.now() - timeframeMin * 60 * 1000;
    return rows.filter((pt) => pt.t >= cutoff);
  }, [history, timeframeMin]);

  return (
    <div className="container">
      <div className="header">
        <div>
          <h1 className="title">Smart Energy Dashboard</h1>
          <div className="subtitle">
            Device <b>{DEVICE_ID}</b> connected via backend <b>{API_BASE}</b>
          </div>
        </div>

        <div className="pillRow">
          <div className="pill">
            Status: <b>{online ? "ONLINE" : "OFFLINE"}</b>
          </div>
          <div className="pill">
            Last seen: <b>{lastSeenText}</b>
          </div>
          <button className="btn" onClick={fetchLatest} type="button">
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div
          className="card"
          style={{
            borderColor: "rgba(239,68,68,0.35)",
            background: "rgba(239,68,68,0.08)",
          }}
        >
          <div style={{ fontWeight: 800, marginBottom: 6 }}>Error</div>
          <div className="small">{error}</div>
        </div>
      )}

      <div className="card" style={{ marginTop: 14 }}>
        <div className="cardHeader">
          <div className="statusLine">
            <div className={`dot ${online ? "good" : ""}`} />
            <div>
              <div className="cardTitle">Live Telemetry</div>
              <div className="small">Auto refresh every 2 seconds</div>
            </div>
          </div>
          <div className="actions">
            <a
              className="btn"
              href={`${API_BASE}/api/health`}
              target="_blank"
              rel="noreferrer"
            >
              API Health
            </a>
            <a
              className="btn"
              href={`${API_BASE}/api/latest/${DEVICE_ID}`}
              target="_blank"
              rel="noreferrer"
            >
              Latest JSON
            </a>
          </div>
        </div>

        <div className="gridStats">
          <Stat
            label="Voltage (V)"
            value={v != null ? v.toFixed(2) : "—"}
            hint="Instantaneous"
          />
          <Stat
            label="Current (A)"
            value={i != null ? i.toFixed(3) : "—"}
            hint="Instantaneous"
          />
          <Stat
            label="Power (W)"
            value={p != null ? p.toFixed(2) : "—"}
            hint="Computed: V × I"
          />
          <Stat
            label="Energy (Wh)"
            value={ewh != null ? ewh.toFixed(3) : "—"}
            hint="Accumulated"
          />
          <Stat
            label="RSSI (dBm)"
            value={rssi != null ? rssi : "—"}
            hint="Wi-Fi signal strength"
          />
          <Stat
            label="Relay State"
            value={relay ? JSON.stringify(relay) : "—"}
            hint="Reported by device"
          />
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="cardHeader">
          <div>
            <div className="cardTitle">Voltage Over Time</div>
            <div className="small">
              Default: last 30 minutes • Source:{" "}
              <b>/api/history/{DEVICE_ID}</b>
            </div>
          </div>

          <div className="actions">
            <select
              className="select"
              value={timeframeMin}
              onChange={(e) => setTimeframeMin(Number(e.target.value))}
            >
              {timeframeOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <button className="btn" onClick={fetchHistory} type="button">
              Reload Graph
            </button>
          </div>
        </div>

        <div className="chartBox">
          {chartData.length === 0 ? (
            <div className="small">
              No history data for this timeframe yet. Wait for telemetry to be
              stored or select a larger window.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 18, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={formatTime}
                  minTickGap={28}
                />
                <YAxis
                  dataKey="voltage"
                  width={46}
                  domain={["auto", "auto"]}
                />
                <Tooltip
                  labelFormatter={(label) => `Time: ${formatTime(label)}`}
                  formatter={(val) => [`${Number(val).toFixed(2)} V`, "Voltage"]}
                />
                <Line type="monotone" dataKey="voltage" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="cardHeader">
          <div>
            <div className="cardTitle">Relay Control</div>
            <div className="small">Commands go Dashboard → Backend → MQTT → ESP32</div>
          </div>
        </div>

        <div className="relayRow">
          {[1, 2, 3, 4].map((ch) => (
            <RelayCard
              key={ch}
              ch={ch}
              state={relay[ch - 1] || 0}
              onToggle={toggleRelay}
              disabled={loadingRelay || !online}
            />
          ))}
        </div>

        <div className="footerNote">
          Buttons are disabled when the device is offline to prevent stale commands.
        </div>
      </div>
    </div>
  );
}
