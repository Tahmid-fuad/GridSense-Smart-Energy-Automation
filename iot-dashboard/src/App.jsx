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
  BarChart,
  Bar,
  PieChart,
  Pie,
  Legend,
  Cell,
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

function formatTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour12: false });
  } catch {
    return "";
  }
}

function clampNum(x, digits = 2) {
  if (typeof x !== "number" || Number.isNaN(x)) return "—";
  return x.toFixed(digits);
}

function RelayCardBackend({
  ch,
  label,
  isOn,
  disabled,
  onToggle,

  // timer
  timerMin,
  setTimerMin,
  onStartTimer,
  timerRemainingSec,
  onCancelTimer,

  // schedule
  schedule,
  setSchedule,
  onApplySchedule,

  // cutoff
  cutoff,
  setCutoff,
  onApplyCutoff,
}) {
  return (
    <div className="loadCard">
      <div className="loadHeader">
        <div>
          <div className="loadTitle">{label}</div>
          <div className="small">
            Relay channel <b>{ch}</b>
          </div>
        </div>

        <button
          className={`toggleBtn ${isOn ? "on" : ""}`}
          onClick={() => onToggle(ch, isOn ? 0 : 1)}
          disabled={disabled}
          type="button"
          title={isOn ? "Turn OFF" : "Turn ON"}
        >
          <span className="toggleDot" />
          <span className="toggleText">{isOn ? "ON" : "OFF"}</span>
        </button>
      </div>

      {/* Timer */}
      <div className="miniSection">
        <div className="miniTitle">Timed switching (backend)</div>
        <div className="row">
          <input
            className="input"
            style={{ width: 120 }}
            type="number"
            min={1}
            max={720}
            value={timerMin}
            onChange={(e) =>
              setTimerMin(Math.max(1, Math.min(720, Number(e.target.value))))
            }
            disabled={disabled}
          />
          <div className="small">minutes</div>

          <button
            className="btn"
            type="button"
            onClick={() => onStartTimer(ch)}
            disabled={disabled}
            title="Turns relay ON now and auto-OFF after X minutes (backend)"
          >
            Turn ON for
          </button>

          {timerRemainingSec > 0 ? (
            <>
              <div className="chip">
                Auto-OFF in <b>{timerRemainingSec}s</b>
              </div>
              <button
                className="btn ghost"
                type="button"
                onClick={() => onCancelTimer(ch)}
                disabled={disabled}
              >
                Cancel
              </button>
            </>
          ) : (
            <div className="chip muted">No active timer</div>
          )}
        </div>
      </div>

      {/* Schedule */}
      <div className="miniSection">
        <div className="miniTitle">Daily schedule (backend)</div>
        <div className="row">
          <label className="check">
            <input
              type="checkbox"
              checked={!!schedule.enabled}
              onChange={(e) =>
                setSchedule((s) => ({ ...s, enabled: e.target.checked }))
              }
              disabled={disabled}
            />
            Enable
          </label>

          <div className="small">ON</div>
          <input
            className="input"
            type="time"
            value={schedule.on}
            onChange={(e) =>
              setSchedule((s) => ({ ...s, on: e.target.value }))
            }
            disabled={disabled || !schedule.enabled}
          />

          <div className="small">OFF</div>
          <input
            className="input"
            type="time"
            value={schedule.off}
            onChange={(e) =>
              setSchedule((s) => ({ ...s, off: e.target.value }))
            }
            disabled={disabled || !schedule.enabled}
          />

          <button
            className="btn"
            type="button"
            onClick={() => onApplySchedule(ch)}
            disabled={disabled}
            title="Save schedule to backend"
          >
            Apply
          </button>

          <div className="chip muted">
            Window: {schedule.on} → {schedule.off}
          </div>
        </div>
      </div>

      {/* Cutoff */}
      <div className="miniSection">
        <div className="miniTitle">Power-based auto cutoff (backend)</div>
        <div className="row">
          <label className="check">
            <input
              type="checkbox"
              checked={!!cutoff.enabled}
              onChange={(e) =>
                setCutoff((r) => ({ ...r, enabled: e.target.checked }))
              }
              disabled={disabled}
            />
            Enable
          </label>

          <div className="small">If P &gt;</div>
          <input
            className="input"
            style={{ width: 110 }}
            type="number"
            min={1}
            max={5000}
            value={cutoff.thresholdW}
            onChange={(e) =>
              setCutoff((r) => ({
                ...r,
                thresholdW: Math.max(1, Math.min(5000, Number(e.target.value))),
              }))
            }
            disabled={disabled || !cutoff.enabled}
          />
          <div className="small">W for</div>
          <input
            className="input"
            style={{ width: 90 }}
            type="number"
            min={1}
            max={600}
            value={cutoff.holdSec}
            onChange={(e) =>
              setCutoff((r) => ({
                ...r,
                holdSec: Math.max(1, Math.min(600, Number(e.target.value))),
              }))
            }
            disabled={disabled || !cutoff.enabled}
          />
          <div className="small">sec → OFF</div>

          <button
            className="btn"
            type="button"
            onClick={() => onApplyCutoff(ch)}
            disabled={disabled}
            title="Save cutoff rule to backend"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [latest, setLatest] = useState(null);
  const [device, setDevice] = useState(null);
  const [history, setHistory] = useState([]);

  const [loadingRelay, setLoadingRelay] = useState(false);
  const [error, setError] = useState("");

  // timeframe and chart mode
  const [timeframeMin, setTimeframeMin] = useState(30);
  const timeframeOptions = [
    { label: "15 min", value: 15 },
    { label: "30 min", value: 30 },
    { label: "1 hour", value: 60 },
    { label: "6 hours", value: 360 },
    { label: "24 hours", value: 1440 },
  ];
  const [chartMode, setChartMode] = useState("power"); // power | current | voltage

  // automations state from backend
  const [timers, setTimers] = useState({ 1: null, 3: null }); // {endAt,...} or null
  const [schedules, setSchedules] = useState({
    1: { enabled: false, on: "18:00", off: "23:00" },
    3: { enabled: false, on: "18:00", off: "23:00" },
  });
  const [cutoffs, setCutoffs] = useState({
    1: { enabled: false, thresholdW: 150, holdSec: 10 },
    3: { enabled: false, thresholdW: 150, holdSec: 10 },
  });

  // timer minutes input (UI-only)
  const [timerMinByCh, setTimerMinByCh] = useState({ 1: 10, 3: 10 });

  // countdown tick
  const [tick, setTick] = useState(0);

  const colors = {
    load1: "#60a5fa",
    load3: "#34d399",
  };

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
      // silent
    }
  }

  async function fetchAutomations() {
    try {
      const res = await axios.get(`${API_BASE}/api/automations/${DEVICE_ID}`);
      const d = res.data || {};
      if (d.timers) setTimers(d.timers);
      if (d.schedules) setSchedules(d.schedules);
      if (d.cutoffs) setCutoffs(d.cutoffs);
    } catch {
      // if endpoint missing or down, show a single clean message
      // (doesn't block telemetry)
    }
  }

  async function toggleRelay(ch, state) {
    try {
      setLoadingRelay(true);
      setError("");
      await axios.post(`${API_BASE}/api/relay/${DEVICE_ID}`, { ch, state });
      setTimeout(fetchLatest, 350);
    } catch {
      setError("Relay command failed. Check backend logs and MQTT connectivity.");
    } finally {
      setLoadingRelay(false);
    }
  }

  async function startTimerOnFor(ch) {
    try {
      setLoadingRelay(true);
      setError("");
      const minutes = timerMinByCh[ch] || 10;
      const res = await axios.post(`${API_BASE}/api/timer/${DEVICE_ID}`, {
        ch,
        minutes,
      });
      // refresh backend state (timer endAt is authoritative)
      await fetchAutomations();
      // small refresh of telemetry too
      setTimeout(fetchLatest, 350);
      return res.data;
    } catch {
      setError("Timer request failed. Check backend logs.");
    } finally {
      setLoadingRelay(false);
    }
  }

  async function cancelTimer(ch) {
    try {
      setLoadingRelay(true);
      setError("");
      await axios.delete(`${API_BASE}/api/timer/${DEVICE_ID}/${ch}`);
      await fetchAutomations();
      setTimeout(fetchLatest, 350);
    } catch {
      setError("Cancel timer failed. Check backend logs.");
    } finally {
      setLoadingRelay(false);
    }
  }

  async function applySchedule(ch) {
    try {
      setLoadingRelay(true);
      setError("");
      const s = schedules[ch];
      await axios.post(`${API_BASE}/api/schedule/${DEVICE_ID}`, {
        ch,
        enabled: !!s.enabled,
        on: s.on,
        off: s.off,
      });
      await fetchAutomations();
    } catch {
      setError("Schedule save failed. Check backend logs.");
    } finally {
      setLoadingRelay(false);
    }
  }

  async function applyCutoff(ch) {
    try {
      setLoadingRelay(true);
      setError("");
      const c = cutoffs[ch];
      await axios.post(`${API_BASE}/api/cutoff/${DEVICE_ID}`, {
        ch,
        enabled: !!c.enabled,
        thresholdW: Number(c.thresholdW ?? 150),
        holdSec: Number(c.holdSec ?? 10),
      });
      await fetchAutomations();
    } catch {
      setError("Cutoff save failed. Check backend logs.");
    } finally {
      setLoadingRelay(false);
    }
  }

  // initial + periodic fetch
  useEffect(() => {
    fetchLatest();
    fetchHistory();
    fetchAutomations();

    const t = setInterval(fetchLatest, 2000);
    const h = setInterval(fetchHistory, 8000);
    const a = setInterval(fetchAutomations, 10000);
    const k = setInterval(() => setTick((x) => x + 1), 1000);

    return () => {
      clearInterval(t);
      clearInterval(h);
      clearInterval(a);
      clearInterval(k);
    };
  }, []);

  // Relay array is now [relay1State, relay3State]
  const relayArr = latest?.relay || device?.relay || [0, 0];
  const relay1 = relayArr?.[0] ?? 0;
  const relay3 = relayArr?.[1] ?? 0;

  // per-load metrics
  const v1 = typeof latest?.v1 === "number" ? latest.v1 : null;
  const i1 = typeof latest?.i1 === "number" ? latest.i1 : null;
  const p1 = typeof latest?.p1 === "number" ? latest.p1 : null;
  const e1Wh = typeof latest?.e1Wh === "number" ? latest.e1Wh : null;

  const v3 = typeof latest?.v3 === "number" ? latest.v3 : null;
  const i3 = typeof latest?.i3 === "number" ? latest.i3 : null;
  const p3 = typeof latest?.p3 === "number" ? latest.p3 : null;
  const e3Wh = typeof latest?.e3Wh === "number" ? latest.e3Wh : null;

  // totals
  const pT = typeof latest?.power === "number" ? latest.power : null;
  const eT = typeof latest?.energyWh === "number" ? latest.energyWh : null;
  const rssi = typeof latest?.rssi === "number" ? latest.rssi : null;

  const disabled = loadingRelay || !online;

  // timer remaining (backend endAt)
  function timerRemainingSec(ch) {
    const t = timers?.[ch];
    if (!t?.endAt) return 0;
    const endMs = new Date(t.endAt).getTime();
    const rem = Math.floor((endMs - Date.now()) / 1000);
    return Math.max(0, rem);
  }

  // time series
  const series = useMemo(() => {
    const rows = (history || [])
      .map((row) => {
        const t =
          row?.createdAt
            ? new Date(row.createdAt).getTime()
            : row?.ts
            ? row.ts * 1000
            : null;

        if (!t) return null;
        return {
          t,
          v1: typeof row?.v1 === "number" ? row.v1 : null,
          i1: typeof row?.i1 === "number" ? row.i1 : null,
          p1: typeof row?.p1 === "number" ? row.p1 : null,
          e1Wh: typeof row?.e1Wh === "number" ? row.e1Wh : null,
          v3: typeof row?.v3 === "number" ? row.v3 : null,
          i3: typeof row?.i3 === "number" ? row.i3 : null,
          p3: typeof row?.p3 === "number" ? row.p3 : null,
          e3Wh: typeof row?.e3Wh === "number" ? row.e3Wh : null,
        };
      })
      .filter(Boolean);

    if (!rows.length) return [];
    const cutoff = Date.now() - timeframeMin * 60 * 1000;
    return rows.filter((pt) => pt.t >= cutoff);
  }, [history, timeframeMin]);

  const avgBars = useMemo(() => {
    if (!series.length) return [];
    const avg = (k) => {
      const v = series.filter((x) => typeof x[k] === "number");
      if (!v.length) return 0;
      return v.reduce((acc, x) => acc + x[k], 0) / v.length;
    };

    if (chartMode === "voltage") {
      return [
        { name: "Load-1", value: avg("v1") },
        { name: "Load-3", value: avg("v3") },
      ];
    }
    if (chartMode === "current") {
      return [
        { name: "Load-1", value: avg("i1") },
        { name: "Load-3", value: avg("i3") },
      ];
    }
    return [
      { name: "Load-1", value: avg("p1") },
      { name: "Load-3", value: avg("p3") },
    ];
  }, [series, chartMode]);

  const energyPie = useMemo(() => {
    if (!series.length) return [];
    const first = series[0];
    const last = series[series.length - 1];

    const e1a =
      typeof first.e1Wh === "number" && typeof last.e1Wh === "number"
        ? last.e1Wh - first.e1Wh
        : 0;
    const e3a =
      typeof first.e3Wh === "number" && typeof last.e3Wh === "number"
        ? last.e3Wh - first.e3Wh
        : 0;

    const e1 = e1a >= 0 ? e1a : typeof last.e1Wh === "number" ? last.e1Wh : 0;
    const e3 = e3a >= 0 ? e3a : typeof last.e3Wh === "number" ? last.e3Wh : 0;

    return [
      { name: "Load-1", value: Math.max(0, e1) },
      { name: "Load-3", value: Math.max(0, e3) },
    ];
  }, [series]);

  const yKey =
    chartMode === "voltage"
      ? ["v1", "v3"]
      : chartMode === "current"
      ? ["i1", "i3"]
      : ["p1", "p3"];

  const yLabel =
    chartMode === "voltage"
      ? "Voltage (V)"
      : chartMode === "current"
      ? "Current (A)"
      : "Power (W)";

  const unit = chartMode === "voltage" ? "V" : chartMode === "current" ? "A" : "W";
  const digits = chartMode === "voltage" ? 1 : chartMode === "current" ? 3 : 2;

  return (
    <div className="container">
      <div className="header">
        <div>
          <h1 className="title">Smart Energy Dashboard</h1>
          <div className="subtitle">
            Device <b>{DEVICE_ID}</b> via backend <b>{API_BASE}</b>
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

      {/* Overview */}
      <div className="card" style={{ marginTop: 14 }}>
        <div className="cardHeader">
          <div className="statusLine">
            <div className={`dot ${online ? "good" : ""}`} />
            <div>
              <div className="cardTitle">Overview</div>
              <div className="small">Auto refresh every 2 seconds</div>
            </div>
          </div>
          <div className="actions">
            <a className="btn" href={`${API_BASE}/api/health`} target="_blank" rel="noreferrer">
              API Health
            </a>
            <a className="btn" href={`${API_BASE}/api/latest/${DEVICE_ID}`} target="_blank" rel="noreferrer">
              Latest JSON
            </a>
          </div>
        </div>

        <div className="gridStats">
          <Stat label="Total Power (W)" value={pT != null ? clampNum(pT, 2) : "—"} hint="device total" />
          <Stat label="Total Energy (Wh)" value={eT != null ? clampNum(eT, 3) : "—"} hint="device total" />
          <Stat label="Wi-Fi RSSI (dBm)" value={rssi != null ? rssi : "—"} hint="Signal strength" />
          <Stat label="Relay State" value={JSON.stringify([relay1, relay3])} hint="[Relay-1, Relay-3]" />
          <Stat label="Load-1 (W)" value={p1 != null ? clampNum(p1, 2) : "—"} hint="Relay-1 power" />
          <Stat label="Load-3 (W)" value={p3 != null ? clampNum(p3, 2) : "—"} hint="Relay-3 power" />
        </div>

        <div className="loadStatsGrid">
          <div className="miniCard">
            <div className="miniCardTitle">Load-1 (Relay-1)</div>
            <div className="miniRow">
              <div className="kv"><span>Vrms</span><b>{v1 != null ? clampNum(v1, 1) : "—"} V</b></div>
              <div className="kv"><span>Irms</span><b>{i1 != null ? clampNum(i1, 3) : "—"} A</b></div>
              <div className="kv"><span>Power</span><b>{p1 != null ? clampNum(p1, 2) : "—"} W</b></div>
              <div className="kv"><span>Energy</span><b>{e1Wh != null ? clampNum(e1Wh, 3) : "—"} Wh</b></div>
            </div>
          </div>

          <div className="miniCard">
            <div className="miniCardTitle">Load-3 (Relay-3)</div>
            <div className="miniRow">
              <div className="kv"><span>Vrms</span><b>{v3 != null ? clampNum(v3, 1) : "—"} V</b></div>
              <div className="kv"><span>Irms</span><b>{i3 != null ? clampNum(i3, 3) : "—"} A</b></div>
              <div className="kv"><span>Power</span><b>{p3 != null ? clampNum(p3, 2) : "—"} W</b></div>
              <div className="kv"><span>Energy</span><b>{e3Wh != null ? clampNum(e3Wh, 3) : "—"} Wh</b></div>
            </div>
          </div>
        </div>
      </div>

      {/* Charts */}
      <div className="card" style={{ marginTop: 14 }}>
        <div className="cardHeader">
          <div>
            <div className="cardTitle">Charts</div>
            <div className="small">Line + Bar + Pie for the selected timeframe</div>
          </div>

          <div className="actions">
            <div className="tabs">
              <button
                className={`tabBtn ${chartMode === "power" ? "active" : ""}`}
                onClick={() => setChartMode("power")}
                type="button"
              >
                Power
              </button>
              <button
                className={`tabBtn ${chartMode === "current" ? "active" : ""}`}
                onClick={() => setChartMode("current")}
                type="button"
              >
                Current
              </button>
              <button
                className={`tabBtn ${chartMode === "voltage" ? "active" : ""}`}
                onClick={() => setChartMode("voltage")}
                type="button"
              >
                Voltage
              </button>
            </div>

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
              Reload
            </button>
          </div>
        </div>

        <div className="chartGrid">
          <div className="chartCard">
            <div className="chartTitle">Line chart: {yLabel}</div>
            <div className="chartBox">
              {series.length === 0 ? (
                <div className="small">
                  No history data for this timeframe yet. Wait for telemetry or select a larger window.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series} margin={{ top: 10, right: 18, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="t"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={formatTime}
                      minTickGap={28}
                    />
                    <YAxis width={52} domain={["auto", "auto"]} />
                    <Tooltip
                      labelFormatter={(label) => `Time: ${formatTime(label)}`}
                      formatter={(val, name) => {
                        const n = Number(val);
                        if (Number.isNaN(n)) return ["—", name];
                        return [`${n.toFixed(digits)} ${unit}`, name];
                      }}
                    />
                    <Line type="monotone" dataKey={yKey[0]} name="Load-1" dot={false} stroke={colors.load1} strokeWidth={2} />
                    <Line type="monotone" dataKey={yKey[1]} name="Load-3" dot={false} stroke={colors.load3} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="chartCard">
            <div className="chartTitle">Bar chart: Avg {yLabel} (window)</div>
            <div className="chartBox">
              {avgBars.length === 0 ? (
                <div className="small">No data in the selected window.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={avgBars} margin={{ top: 10, right: 18, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis width={52} domain={["auto", "auto"]} />
                    <Tooltip
                      formatter={(val) => {
                        const n = Number(val);
                        return [`${n.toFixed(digits)} ${unit}`, "Avg"];
                      }}
                    />
                    <Bar dataKey="value" fill="#93c5fd" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="chartCard">
            <div className="chartTitle">Pie chart: Energy share (Wh) in window</div>
            <div className="chartBox">
              {energyPie.length === 0 ? (
                <div className="small">No data in the selected window.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Tooltip formatter={(v) => [`${Number(v).toFixed(3)} Wh`, "Energy"]} />
                    <Legend />
                    <Pie data={energyPie} dataKey="value" nameKey="name" outerRadius={90} label>
                      <Cell fill={colors.load1} />
                      <Cell fill={colors.load3} />
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Relay + automations */}
      <div className="card" style={{ marginTop: 14 }}>
        <div className="cardHeader">
          <div>
            <div className="cardTitle">Relay Control & Automations</div>
            <div className="small">Automations are executed by the backend (timers/schedules/cutoffs)</div>
          </div>
        </div>

        <div className="loadGrid">
          <RelayCardBackend
            ch={1}
            label="Load-1"
            isOn={relay1 === 1}
            disabled={disabled}
            onToggle={toggleRelay}
            timerMin={timerMinByCh[1]}
            setTimerMin={(v) => setTimerMinByCh((s) => ({ ...s, 1: v }))}
            onStartTimer={startTimerOnFor}
            timerRemainingSec={timerRemainingSec(1) + (tick * 0)}
            onCancelTimer={cancelTimer}
            schedule={schedules[1]}
            setSchedule={(fn) => setSchedules((s) => ({ ...s, 1: typeof fn === "function" ? fn(s[1]) : fn }))}
            onApplySchedule={applySchedule}
            cutoff={cutoffs[1]}
            setCutoff={(fn) => setCutoffs((c) => ({ ...c, 1: typeof fn === "function" ? fn(c[1]) : fn }))}
            onApplyCutoff={applyCutoff}
          />

          <RelayCardBackend
            ch={3}
            label="Load-3"
            isOn={relay3 === 1}
            disabled={disabled}
            onToggle={toggleRelay}
            timerMin={timerMinByCh[3]}
            setTimerMin={(v) => setTimerMinByCh((s) => ({ ...s, 3: v }))}
            onStartTimer={startTimerOnFor}
            timerRemainingSec={timerRemainingSec(3) + (tick * 0)}
            onCancelTimer={cancelTimer}
            schedule={schedules[3]}
            setSchedule={(fn) => setSchedules((s) => ({ ...s, 3: typeof fn === "function" ? fn(s[3]) : fn }))}
            onApplySchedule={applySchedule}
            cutoff={cutoffs[3]}
            setCutoff={(fn) => setCutoffs((c) => ({ ...c, 3: typeof fn === "function" ? fn(c[3]) : fn }))}
            onApplyCutoff={applyCutoff}
          />
        </div>

        <div className="footerNote">
          The dashboard only configures automations. Execution happens in the backend even if the browser is closed.
        </div>
      </div>

      {/* keep tick alive for countdown refresh */}
      <div style={{ display: "none" }}>{tick}</div>
    </div>
  );
}
