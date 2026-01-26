import { useEffect, useMemo, useRef, useState } from "react";
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

function normalizeSchedule(s) {
  return {
    enabled: !!s?.enabled,
    invert: !!s?.invert,
    on: s?.on || "00:00",
    off: s?.off || "00:00",
  };
}

function schedulesEqual(a, b) {
  const A = normalizeSchedule(a);
  const B = normalizeSchedule(b);
  return (
    A.enabled === B.enabled &&
    A.invert === B.invert &&
    A.on === B.on &&
    A.off === B.off
  );
}

function RelayCardBackend({
  ch,
  label,
  isOn,
  disabled,
  onToggle,

  // timer
  timerVal,
  setTimerVal,
  onStartTimer,
  timerRemainingSec,
  onCancelTimer,
  timerMode,

  // schedule
  schedule,
  setSchedule,
  onApplySchedule,
  onScheduleFocus,
  scheduleServer,
  scheduleSavedAt,
  onCancelSchedule,

  // cutoff
  cutoff,
  setCutoff,
  onApplyCutoff,
}) {
  const enabled = !!schedule?.enabled;
  const saved = scheduleServer
    ? schedulesEqual(schedule, scheduleServer)
    : true;
  const onLabel = schedule?.invert ? "OFF" : "ON";
  const offLabel = schedule?.invert ? "ON" : "OFF";

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
        <div className="miniTitle">Timed switching</div>

        {/* ON FOR row */}
        <div className="row">
          <button
            className="btn"
            type="button"
            onClick={() => onStartTimer(ch, "on_for")}
            disabled={disabled}
            title="Turn ON now, then OFF after the duration"
          >
            Turn ON for
          </button>

          <input
            className="input"
            style={{ width: 90 }}
            type="number"
            min={0}
            max={720}
            value={timerVal?.onFor?.min ?? 0}
            onChange={(e) =>
              setTimerVal((s) => ({
                ...(s || {
                  onFor: { min: 0, sec: 0 },
                  offFor: { min: 0, sec: 0 },
                }),
                onFor: {
                  ...((s && s.onFor) || { min: 0, sec: 0 }),
                  min: Math.max(0, Math.min(720, Number(e.target.value))),
                },
              }))
            }
            disabled={disabled}
          />
          <div className="small">min</div>

          <input
            className="input"
            style={{ width: 90 }}
            type="number"
            min={0}
            max={59}
            value={timerVal?.onFor?.sec ?? 0}
            onChange={(e) =>
              setTimerVal((s) => ({
                ...(s || {
                  onFor: { min: 0, sec: 0 },
                  offFor: { min: 0, sec: 0 },
                }),
                onFor: {
                  ...((s && s.onFor) || { min: 0, sec: 0 }),
                  sec: Math.max(0, Math.min(59, Number(e.target.value))),
                },
              }))
            }
            disabled={disabled}
          />
          <div className="small">sec</div>
        </div>

        {/* OFF FOR row */}
        <div className="row" style={{ marginTop: 8 }}>
          <button
            className="btn"
            type="button"
            onClick={() => onStartTimer(ch, "off_for")}
            disabled={disabled}
            title="Turn OFF now, then ON after the duration"
          >
            Turn OFF for
          </button>

          <input
            className="input"
            style={{ width: 90 }}
            type="number"
            min={0}
            max={720}
            value={timerVal?.offFor?.min ?? 0}
            onChange={(e) =>
              setTimerVal((s) => ({
                ...(s || {
                  onFor: { min: 0, sec: 0 },
                  offFor: { min: 0, sec: 0 },
                }),
                offFor: {
                  ...((s && s.offFor) || { min: 0, sec: 0 }),
                  min: Math.max(0, Math.min(720, Number(e.target.value))),
                },
              }))
            }
            disabled={disabled}
          />
          <div className="small">min</div>

          <input
            className="input"
            style={{ width: 90 }}
            type="number"
            min={0}
            max={59}
            value={timerVal?.offFor?.sec ?? 0}
            onChange={(e) =>
              setTimerVal((s) => ({
                ...(s || {
                  onFor: { min: 0, sec: 0 },
                  offFor: { min: 0, sec: 0 },
                }),
                offFor: {
                  ...((s && s.offFor) || { min: 0, sec: 0 }),
                  sec: Math.max(0, Math.min(59, Number(e.target.value))),
                },
              }))
            }
            disabled={disabled}
          />
          <div className="small">sec</div>
        </div>
        <div className="timerStatusWrap">
          <div className={`chip ${timerRemainingSec > 0 ? "" : "muted"}`}>
            {timerRemainingSec > 0 ? (
              timerMode ? (
                <>
                  Running: <b>{timerMode}</b> • <b>{timerRemainingSec}s</b>
                </>
              ) : (
                <>
                  Timer: <b>{timerRemainingSec}s</b>
                </>
              )
            ) : (
              <>No active timer</>
            )}
          </div>

          {timerRemainingSec > 0 && (
            <button
              className="btn ghost"
              type="button"
              onClick={() => onCancelTimer(ch)}
              disabled={disabled}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Schedule */}
      <div className="miniSection">
        <div className="miniTitle">Daily schedule </div>
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

          <label className="check">
            <input
              type="checkbox"
              checked={!!schedule.invert}
              onChange={(e) =>
                setSchedule((s) => ({ ...s, invert: e.target.checked }))
              }
              disabled={disabled || !schedule.enabled}
            />
            Reverse
          </label>

          <div className="small">{onLabel}</div>
          <input
            className="input"
            type="time"
            value={schedule.on}
            onFocus={() => onScheduleFocus(ch)}
            onChange={(e) => setSchedule((s) => ({ ...s, on: e.target.value }))}
            disabled={disabled || !schedule.enabled}
          />

          <div className="small">{offLabel}</div>
          <input
            className="input"
            type="time"
            value={schedule.off}
            onFocus={() => onScheduleFocus(ch)}
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

          <button
            className="btn ghost"
            type="button"
            onClick={() => onCancelSchedule(ch)}
            disabled={disabled}
            title="Delete schedule from backend"
          >
            Cancel
          </button>

          <div className="scheduleStatusRow">
            <div className={`chip ${enabled ? "" : "muted"}`}>
              {enabled ? (
                <>
                  Schedule: <b>{schedule.on}</b> → <b>{schedule.off}</b>
                  {schedule.invert ? (
                    <span className="small"> • Reverse</span>
                  ) : null}
                </>
              ) : (
                <>Schedule disabled</>
              )}
            </div>

            <div className={`chip ${saved ? "" : "warn"}`}>
              {saved ? (
                <>
                  Saved
                  {scheduleSavedAt ? (
                    <span className="small">
                      {" "}
                      •{" "}
                      {new Date(scheduleSavedAt).toLocaleTimeString([], {
                        hour12: false,
                      })}
                    </span>
                  ) : null}
                </>
              ) : (
                <>Unsaved changes</>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Cutoff */}
      {/* <div className="miniSection">
        <div className="miniTitle">Power-based auto cutoff </div>
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
      </div> */}
    </div>
  );
}

export default function App() {
  const [latest, setLatest] = useState(null);
  const [device, setDevice] = useState(null);
  const [history, setHistory] = useState([]);

  const [loadingRelay, setLoadingRelay] = useState(false);
  const [error, setError] = useState("");
  const [scheduleSavedAt, setScheduleSavedAt] = useState({ 1: null, 3: null });

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
  const [schedulesServer, setSchedulesServer] = useState({
    1: { enabled: false, on: "18:00", off: "23:00", invert: false },
    3: { enabled: false, on: "18:00", off: "23:00", invert: false },
  });

  const [schedulesDraft, setSchedulesDraft] = useState({
    1: { enabled: false, on: "18:00", off: "23:00", invert: false },
    3: { enabled: false, on: "18:00", off: "23:00", invert: false },
  });

  // editing lock per channel (so only that card stops overwriting)
  const [editingScheduleCh, setEditingScheduleCh] = useState(null);
  const editingScheduleChRef = useRef(null);

  const [cutoffs, setCutoffs] = useState({
    1: { enabled: false, thresholdW: 150, holdSec: 10 },
    3: { enabled: false, thresholdW: 150, holdSec: 10 },
  });

  // timer minutes input (UI-only)
  const [timerByCh, setTimerByCh] = useState({
    1: { onFor: { min: 10, sec: 0 }, offFor: { min: 10, sec: 0 } },
    3: { onFor: { min: 10, sec: 0 }, offFor: { min: 10, sec: 0 } },
  });

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
        `${API_BASE}/api/history/${DEVICE_ID}?limit=2000`,
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
      if (d.schedules) {
        setSchedulesServer(d.schedules);

        const editingCh = editingScheduleChRef.current;

        // Only overwrite drafts if user is NOT editing.
        if (!editingCh) {
          setSchedulesDraft(d.schedules);
        } else {
          setSchedulesDraft((prev) => {
            const next = { ...prev };

            for (const ch of [1, 3]) {
              if (ch !== editingCh) {
                next[ch] = d.schedules[ch] || next[ch];
              }
            }

            return next;
          });
        }
      }
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
      setTimeout(() => {
        fetchLatest();
        fetchAutomations();
      }, 350);
    } catch {
      setError(
        "Relay command failed. Check backend logs and MQTT connectivity.",
      );
    } finally {
      setLoadingRelay(false);
    }
  }

  async function masterOff() {
    try {
      setLoadingRelay(true);
      setError("");
      await axios.post(`${API_BASE}/api/relayAll/${DEVICE_ID}`, { state: 0 });
      setTimeout(fetchLatest, 350);
    } catch {
      setError("Master OFF failed. Check backend and MQTT connectivity.");
    } finally {
      setLoadingRelay(false);
    }
  }

  async function startTimer(ch, mode) {
    try {
      setLoadingRelay(true);
      setError("");

      const cfg = timerByCh[ch] || {};
      const t = mode === "on_for" ? cfg.onFor : cfg.offFor;

      await axios.post(`${API_BASE}/api/timer/${DEVICE_ID}`, {
        ch,
        mode,
        minutes: Number(t?.min || 0),
        seconds: Number(t?.sec || 0),
      });

      await fetchAutomations();
      setTimeout(fetchLatest, 350);
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

      const s = schedulesDraft[ch];

      await axios.post(`${API_BASE}/api/schedule/${DEVICE_ID}`, {
        ch,
        enabled: !!s.enabled,
        on: s.on,
        off: s.off,
        invert: !!s.invert,
      });

      setScheduleSavedAt((prev) => ({ ...prev, [ch]: Date.now() }));

      setEditingScheduleCh(null);
      await fetchAutomations();
    } catch {
      setError("Schedule save failed. Check backend logs.");
    } finally {
      setLoadingRelay(false);
    }
  }

  function normalizeSchedule(s) {
    return {
      enabled: !!s?.enabled,
      invert: !!s?.invert,
      on: s?.on || "00:00",
      off: s?.off || "00:00",
    };
  }

  function schedulesEqual(a, b) {
    const A = normalizeSchedule(a);
    const B = normalizeSchedule(b);
    return (
      A.enabled === B.enabled &&
      A.invert === B.invert &&
      A.on === B.on &&
      A.off === B.off
    );
  }

  async function cancelSchedule(ch) {
    try {
      setLoadingRelay(true);
      setError("");

      await axios.delete(`${API_BASE}/api/schedule/${DEVICE_ID}/${ch}`);

      // Refresh automations from backend
      setEditingScheduleCh(null);
      await fetchAutomations();

      // Optional: also reset local draft UI immediately
      setSchedulesDraft((prev) => ({
        ...prev,
        [ch]: { enabled: false, on: "18:00", off: "23:00", invert: false },
      }));
    } catch {
      setError("Schedule cancel failed. Check backend logs.");
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

  useEffect(() => {
    editingScheduleChRef.current = editingScheduleCh;
  }, [editingScheduleCh]);

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

  const totalVoltage = useMemo(() => {
    if (typeof latest?.v1 === "number" && typeof latest?.v3 === "number") {
      return (latest.v1 + latest.v3) / 2;
    }
    if (typeof latest?.voltage === "number") return latest.voltage;
    return typeof latest?.v1 === "number"
      ? latest.v1
      : typeof latest?.v3 === "number"
        ? latest.v3
        : null;
  }, [latest]);

  const totalCurrent = useMemo(() => {
    if (typeof latest?.i1 === "number" || typeof latest?.i3 === "number") {
      return Number(latest?.i1 || 0) + Number(latest?.i3 || 0);
    }
    return typeof latest?.current === "number" ? latest.current : null;
  }, [latest]);

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
        const t = row?.createdAt
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
        { name: "Load-2", value: avg("v3") },
      ];
    }
    if (chartMode === "current") {
      return [
        { name: "Load-1", value: avg("i1") },
        { name: "Load-2", value: avg("i3") },
      ];
    }
    return [
      { name: "Load-1", value: avg("p1") },
      { name: "Load-2", value: avg("p3") },
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
      { name: "Load-2", value: Math.max(0, e3) },
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

  const unit =
    chartMode === "voltage" ? "V" : chartMode === "current" ? "A" : "W";
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
          <button
            className="btn masterOff"
            onClick={masterOff}
            type="button"
            disabled={disabled}
            title="Turn OFF both relays"
          >
            KILL Switch
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

        <div className="overviewLine">
          <Stat
            label="Total Power"
            value={pT != null ? `${clampNum(pT, 2)} W` : "—"}
          />
          <Stat
            label="Total Energy"
            value={eT != null ? `${clampNum(eT, 3)} Wh` : "—"}
          />
          <Stat
            label="Total Voltage"
            value={
              totalVoltage != null ? `${clampNum(totalVoltage, 1)} V` : "—"
            }
          />
          <Stat
            label="Total Current"
            value={
              totalCurrent != null ? `${clampNum(totalCurrent, 3)} A` : "—"
            }
          />
          <Stat label="RSSI" value={rssi != null ? `${rssi} dBm` : "—"} />
        </div>

        <div className="loadStatsGrid">
          <div className="miniCard">
            <div className="miniCardTitle">Load-1 (Relay-1)</div>
            <div className="miniRow">
              <div className="kv">
                <span>Vrms</span>
                <b>{v1 != null ? clampNum(v1, 1) : "—"} V</b>
              </div>
              <div className="kv">
                <span>Irms</span>
                <b>{i1 != null ? clampNum(i1, 3) : "—"} A</b>
              </div>
              <div className="kv">
                <span>Power</span>
                <b>{p1 != null ? clampNum(p1, 2) : "—"} W</b>
              </div>
              <div className="kv">
                <span>Energy</span>
                <b>{e1Wh != null ? clampNum(e1Wh, 3) : "—"} Wh</b>
              </div>
            </div>
          </div>

          <div className="miniCard">
            <div className="miniCardTitle">Load-2 (Relay-3)</div>
            <div className="miniRow">
              <div className="kv">
                <span>Vrms</span>
                <b>{v3 != null ? clampNum(v3, 1) : "—"} V</b>
              </div>
              <div className="kv">
                <span>Irms</span>
                <b>{i3 != null ? clampNum(i3, 3) : "—"} A</b>
              </div>
              <div className="kv">
                <span>Power</span>
                <b>{p3 != null ? clampNum(p3, 2) : "—"} W</b>
              </div>
              <div className="kv">
                <span>Energy</span>
                <b>{e3Wh != null ? clampNum(e3Wh, 3) : "—"} Wh</b>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Relay + automations */}
      <div className="card" style={{ marginTop: 14 }}>
        <div className="cardHeader">
          <div>
            <div className="cardTitle">Relay Control & Automations</div>
            <div className="small"></div>
          </div>
        </div>

        <div className="loadGrid">
          <RelayCardBackend
            ch={1}
            label="Load-1"
            isOn={relay1 === 1}
            disabled={disabled}
            onToggle={toggleRelay}
            timerVal={timerByCh[1]}
            setTimerVal={(fn) =>
              setTimerByCh((s) => ({
                ...s,
                1: typeof fn === "function" ? fn(s[1]) : fn,
              }))
            }
            onStartTimer={startTimer}
            timerRemainingSec={timerRemainingSec(1) + tick * 0}
            onCancelTimer={cancelTimer}
            schedule={schedulesDraft[1]}
            setSchedule={(fn) =>
              setSchedulesDraft((s) => ({
                ...s,
                1: typeof fn === "function" ? fn(s[1]) : fn,
              }))
            }
            onScheduleFocus={(ch) => setEditingScheduleCh(ch)}
            onScheduleBlur={() => setEditingScheduleCh(null)}
            scheduleServer={schedulesServer[1]}
            scheduleSavedAt={scheduleSavedAt[1]}
            onApplySchedule={applySchedule}
            onCancelSchedule={cancelSchedule}
            cutoff={cutoffs[1]}
            setCutoff={(fn) =>
              setCutoffs((c) => ({
                ...c,
                1: typeof fn === "function" ? fn(c[1]) : fn,
              }))
            }
            onApplyCutoff={applyCutoff}
            timerMode={timers?.[1]?.mode || null}
          />

          <RelayCardBackend
            ch={3}
            label="Load-2"
            isOn={relay3 === 1}
            disabled={disabled}
            onToggle={toggleRelay}
            timerVal={timerByCh[3]}
            setTimerVal={(fn) =>
              setTimerByCh((s) => ({
                ...s,
                3: typeof fn === "function" ? fn(s[3]) : fn,
              }))
            }
            onStartTimer={startTimer}
            timerRemainingSec={timerRemainingSec(3) + tick * 0}
            onCancelTimer={cancelTimer}
            schedule={schedulesDraft[3]}
            setSchedule={(fn) =>
              setSchedulesDraft((s) => ({
                ...s,
                3: typeof fn === "function" ? fn(s[3]) : fn,
              }))
            }
            onScheduleFocus={(ch) => setEditingScheduleCh(ch)}
            onScheduleBlur={() => setEditingScheduleCh(null)}
            onApplySchedule={applySchedule}
            scheduleServer={schedulesServer[3]}
            scheduleSavedAt={scheduleSavedAt[3]}
            onCancelSchedule={cancelSchedule}
            cutoff={cutoffs[3]}
            setCutoff={(fn) =>
              setCutoffs((c) => ({
                ...c,
                3: typeof fn === "function" ? fn(c[3]) : fn,
              }))
            }
            onApplyCutoff={applyCutoff}
            timerMode={timers?.[3]?.mode || null}
          />
        </div>
      </div>

      {/* Charts */}
      <div className="card" style={{ marginTop: 14 }}>
        <div className="cardHeader">
          <div>
            <div className="cardTitle">Charts</div>
            <div className="small">
              Line + Bar + Pie for the selected timeframe
            </div>
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
                  No history data for this timeframe yet. Wait for telemetry or
                  select a larger window.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={series}
                    margin={{ top: 10, right: 18, bottom: 0, left: 0 }}
                  >
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
                    <Line
                      type="monotone"
                      dataKey={yKey[0]}
                      name="Load-1"
                      dot={false}
                      stroke={colors.load1}
                      strokeWidth={2}
                    />
                    <Line
                      type="monotone"
                      dataKey={yKey[1]}
                      name="Load-2"
                      dot={false}
                      stroke={colors.load3}
                      strokeWidth={2}
                    />
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
                  <BarChart
                    data={avgBars}
                    margin={{ top: 10, right: 18, bottom: 0, left: 0 }}
                  >
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
            <div className="chartTitle">
              Pie chart: Energy share (Wh) in window
            </div>
            <div className="chartBox">
              {energyPie.length === 0 ? (
                <div className="small">No data in the selected window.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Tooltip
                      formatter={(v) => [
                        `${Number(v).toFixed(3)} Wh`,
                        "Energy",
                      ]}
                    />
                    <Legend />
                    <Pie
                      data={energyPie}
                      dataKey="value"
                      nameKey="name"
                      outerRadius={90}
                      label
                    >
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

      {/* keep tick alive for countdown refresh */}
      <div style={{ display: "none" }}>{tick}</div>
    </div>
  );
}
