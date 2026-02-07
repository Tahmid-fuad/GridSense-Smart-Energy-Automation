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

function numOrNull(x) {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function computeActiveTotals(latest, device) {
  const relayArr = latest?.relay || device?.relay || [0, 0];
  const r1On = (relayArr?.[0] ?? 0) === 1;
  const r3On = (relayArr?.[1] ?? 0) === 1;

  const v1 = numOrNull(latest?.v1);
  const v3 = numOrNull(latest?.v3);
  const i1 = numOrNull(latest?.i1);
  const i3 = numOrNull(latest?.i3);
  const p1 = numOrNull(latest?.p1);
  const p3 = numOrNull(latest?.p3);

  // Voltage rule:
  // - both ON => mean(v1,v3)
  // - only one ON => that relay's voltage
  // - none ON => fallback to legacy voltage if you want, else null
  let v = null;
  if (r1On && r3On) {
    if (v1 != null && v3 != null) v = (v1 + v3) / 2;
    else v = numOrNull(latest?.voltage) ?? v1 ?? v3;
  } else if (r1On) {
    v = v1 ?? numOrNull(latest?.voltage);
  } else if (r3On) {
    v = v3 ?? numOrNull(latest?.voltage);
  } else {
    v = numOrNull(latest?.voltage); // or null if you prefer
  }

  // Current/Power rule:
  // - sum only ON relays (OFF relays contribute 0)
  const i = (r1On ? (i1 ?? 0) : 0) + (r3On ? (i3 ?? 0) : 0);
  const p = (r1On ? (p1 ?? 0) : 0) + (r3On ? (p3 ?? 0) : 0);

  // If both OFF, you may want to show "—" instead of 0:
  const anyOn = r1On || r3On;

  return {
    r1On,
    r3On,
    anyOn,
    vTotal: v,
    iTotal: anyOn ? i : null,
    pTotal: anyOn ? p : null,
  };
}

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

function normalizeCutoff(c) {
  return {
    enabled: !!c?.enabled,
    limitmWh: Number(c?.limitmWh ?? 1000),
  };
}

function cutoffsEqual(a, b) {
  const A = normalizeCutoff(a);
  const B = normalizeCutoff(b);
  return A.enabled === B.enabled && A.limitmWh === B.limitmWh;
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
  cutoffServer,
  cutoffSavedAt,
  onCutoffFocus,
  onCancelCutoff,
}) {
  const enabled = !!schedule?.enabled;
  const saved = scheduleServer
    ? schedulesEqual(schedule, scheduleServer)
    : true;
  const onLabel = schedule?.invert ? "OFF" : "ON";
  const offLabel = schedule?.invert ? "ON" : "OFF";
  const cutoffEnabled = !!cutoff?.enabled;
  const cutoffSaved = cutoffServer ? cutoffsEqual(cutoff, cutoffServer) : true;
  const appliedLimit =
    typeof cutoffServer?.limitmWh === "number" ? cutoffServer.limitmWh : null;

  const usedmWh =
    typeof cutoffServer?.consumedmWh === "number"
      ? cutoffServer.consumedmWh
      : typeof cutoff?.consumedmWh === "number"
        ? cutoff.consumedmWh
        : 0;

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
          <div className="small">Turn OFF after</div>

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

          <button
            className="btn"
            type="button"
            onClick={() => onStartTimer(ch, "on_for")}
            disabled={disabled}
            title="Turn ON now, then OFF after the duration"
          >
            Apply
          </button>
        </div>

        {/* OFF FOR row */}
        <div className="row" style={{ marginTop: 8 }}>
          <div className="small">Turn ON after</div>

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

          <button
            className="btn"
            type="button"
            onClick={() => onStartTimer(ch, "off_for")}
            disabled={disabled}
            title="Turn OFF now, then ON after the duration"
          >
            Apply
          </button>
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

      {/* Energy budget auto-off */}
      <div className="miniSection">
        <div className="miniTitle">Energy budget auto-off</div>
        <div className="row">
          <label className="check">
            <input
              type="checkbox"
              checked={!!cutoff.enabled}
              onChange={(e) => {
                onCutoffFocus?.(ch);
                setCutoff((r) => ({ ...r, enabled: e.target.checked }));
              }}
              disabled={disabled}
            />
            Enable
          </label>

          <div className="small">Turn OFF after</div>

          <input
            className="input"
            style={{ width: 80 }}
            type="number"
            min={1}
            max={500000}
            value={cutoff.limitmWh ?? 1000}
            onFocus={() => onCutoffFocus?.(ch)}
            onChange={(e) => {
              onCutoffFocus?.(ch);
              setCutoff((r) => ({
                ...r,
                limitmWh: Math.max(1, Math.min(500000, Number(e.target.value))),
              }));
            }}
            disabled={disabled || !cutoff.enabled}
          />
          <div className="small">mWh</div>

          <div className={`chip ${cutoff.enabled ? "" : "muted"}`}>
            {cutoff.enabled ? (
              <>
                Used: <b>{Number(usedmWh).toFixed(1)} mWh</b>
                {"  "} / Limit:{" "}
                <b>{appliedLimit != null ? appliedLimit : "—"} mWh</b>
              </>
            ) : (
              <>Disabled</>
            )}
          </div>

          <button
            className="btn"
            type="button"
            onClick={() => onApplyCutoff(ch)}
            disabled={disabled}
            title="Save energy budget cutoff rule to backend"
          >
            Apply
          </button>

          <button
            className="btn ghost"
            type="button"
            onClick={() => onCancelCutoff(ch)}
            disabled={disabled}
            title="Delete energy cutoff rule from backend"
          >
            Cancel
          </button>

          <div className={`chip ${cutoffSaved ? "" : "warn"}`}>
            {cutoffSaved ? (
              <>
                Saved
                {cutoffSavedAt ? (
                  <span className="small">
                    {" "}
                    •{" "}
                    {new Date(cutoffSavedAt).toLocaleTimeString([], {
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
  );
}

function BellIcon({ size = 34 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.73 21a2 2 0 0 1-3.46 0"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon({ size = 22 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 6h18"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M8 6V4h8v2"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 6l1 16h10l1-16"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path
        d="M10 11v7M14 11v7"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FaultNumberField({ label, value, placeholder, onChange, onUserEdit }) {
  return (
    <div className="faultField">
      <div className="small">{label}</div>
      <input
        className="input"
        type="number"
        value={value}
        placeholder={placeholder}
        onFocus={onUserEdit}
        onChange={(e) => {
          onUserEdit?.();
          onChange(e.target.value);
        }}
      />
    </div>
  );
}

function FaultSettingsModal({
  open,
  onClose,
  draft,
  setDraft,
  onSave,
  onResetLatch,
  latched,
  onUserEdit,
}) {
  if (!open) return null;

  return (
    <div className="modalBackdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <div>
            <div className="modalTitle">Fault Settings</div>
            <div className="small">
              Leave a field empty to disable that bound.
            </div>
          </div>
          <button className="btn ghost" onClick={onClose} type="button">
            Close
          </button>
        </div>

        <div
          className={`chip ${latched ? "warn" : "muted"}`}
          style={{ marginBottom: 12 }}
        >
          {latched ? (
            <>
              Trip is <b>LATCHED</b> (system already tripped)
            </>
          ) : (
            <>
              Fault latch: <b>OK</b>
            </>
          )}
        </div>

        <div className="faultGrid">
          <div className="faultGroup">
            <div className="faultGroupTitle">Voltage (V)</div>
            <div className="faultRow">
              <FaultNumberField
                label="Min"
                value={draft.vMin}
                placeholder="e.g. 180"
                onUserEdit={onUserEdit}
                onChange={(v) => setDraft((s) => ({ ...s, vMin: v }))}
              />
              <FaultNumberField
                label="Max"
                value={draft.vMax}
                placeholder="e.g. 250"
                onUserEdit={onUserEdit}
                onChange={(v) => setDraft((s) => ({ ...s, vMax: v }))}
              />
            </div>
          </div>

          <div className="faultGroup">
            <div className="faultGroupTitle">Current (A)</div>
            <div className="faultRow">
              <FaultNumberField
                label="Min"
                value={draft.iMin}
                placeholder="e.g. 0.05"
                onUserEdit={onUserEdit}
                onChange={(v) => setDraft((s) => ({ ...s, iMin: v }))}
              />
              <FaultNumberField
                label="Max"
                value={draft.iMax}
                placeholder="e.g. 2.5"
                onUserEdit={onUserEdit}
                onChange={(v) => setDraft((s) => ({ ...s, iMax: v }))}
              />
            </div>
          </div>

          <div className="faultGroup">
            <div className="faultGroupTitle">Power (W)</div>
            <div className="faultRow">
              <FaultNumberField
                label="Min"
                value={draft.pMin}
                placeholder="e.g. 5"
                onUserEdit={onUserEdit}
                onChange={(v) => setDraft((s) => ({ ...s, pMin: v }))}
              />
              <FaultNumberField
                label="Max"
                value={draft.pMax}
                placeholder="e.g. 500"
                onUserEdit={onUserEdit}
                onChange={(v) => setDraft((s) => ({ ...s, pMax: v }))}
              />
            </div>
          </div>
        </div>

        <div className="modalActions">
          {latched && (
            <button className="btn" type="button" onClick={onResetLatch}>
              Reset Fault
            </button>
          )}
          <button className="btn" type="button" onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function FaultNotificationsPanel({
  open,
  onClose,
  events,
  onDeleteEvent,
  onDeleteAll,
}) {
  if (!open) return null;

  return (
    <div
      className="notifBackdrop"
      role="presentation"
      onMouseDown={onClose} // click outside closes
    >
      <div
        className="notifPanel"
        role="dialog"
        aria-label="Fault notifications"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="notifHeader">
          <div>
            <div className="notifTitleRow">
              <div className="notifTitle">Fault Notifications</div>

              <button
                className="iconBtn danger"
                type="button"
                title="Delete all notifications"
                onClick={() => onDeleteAll?.()}
                disabled={!events?.length}
              >
                🗑️
              </button>
            </div>

            <div className="small">Recent fault actions and faults</div>
          </div>
        </div>

        <div className="notifList">
          {events?.length ? (
            events.map((ev) => (
              <div key={ev._id} className="notifItem">
                <div className={`notifBadge ${ev.level}`}>
                  {ev.level === "fault"
                    ? "FAULT"
                    : ev.level === "success"
                      ? "SUCCESS"
                      : "INFO"}
                </div>

                <div className="notifBody">
                  <div className="notifMsg">{ev.message || "—"}</div>
                  <div className="notifMeta">
                    <span>
                      {new Date(ev.createdAt).toLocaleString([], {
                        hour12: false,
                      })}
                    </span>
                    {ev.fault ? (
                      <span className="notifFault"> • {ev.fault}</span>
                    ) : null}
                  </div>
                </div>

                <button
                  className="iconBtn danger"
                  type="button"
                  title="Delete notification"
                  onClick={() => onDeleteEvent?.(ev._id)}
                >
                  🗑️
                </button>
              </div>
            ))
          ) : (
            <div className="small" style={{ padding: 10 }}>
              No fault logs yet.
            </div>
          )}
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
  const [scheduleSavedAt, setScheduleSavedAt] = useState({ 1: null, 3: null });

  // --- Fault detection ---
  const [faultBusy, setFaultBusy] = useState(false);
  const [faultOpen, setFaultOpen] = useState(false);
  const faultOpenRef = useRef(false);
  useEffect(() => {
    faultOpenRef.current = faultOpen;
  }, [faultOpen]);

  const [editingFault, setEditingFault] = useState(false);
  const editingFaultRef = useRef(false);
  useEffect(() => {
    editingFaultRef.current = editingFault;
  }, [editingFault]);

  const [notifOpen, setNotifOpen] = useState(false);

  const [faultEvents, setFaultEvents] = useState([]);
  const [faultLatched, setFaultLatched] = useState(false);

  const [faultServer, setFaultServer] = useState(null); // backend truth
  const [faultDraft, setFaultDraft] = useState({
    vMin: "",
    vMax: "",
    iMin: "",
    iMax: "",
    pMin: "",
    pMax: "",
  });

  useEffect(() => {
    editingFaultRef.current = editingFault;
  }, [editingFault]);

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

  // timer minutes input (UI-only)
  const [timerByCh, setTimerByCh] = useState({
    1: { onFor: { min: 10, sec: 0 }, offFor: { min: 10, sec: 0 } },
    3: { onFor: { min: 10, sec: 0 }, offFor: { min: 10, sec: 0 } },
  });

  // countdown tick
  const [tick, setTick] = useState(0);

  // cutoffstates
  const [cutoffsServer, setCutoffsServer] = useState({
    1: { enabled: false, limitmWh: 1000, consumedmWh: 0 },
    3: { enabled: false, limitmWh: 1000, consumedmWh: 0 },
  });

  const [cutoffsDraft, setCutoffsDraft] = useState({
    1: { enabled: false, limitmWh: 1000, consumedmWh: 0 },
    3: { enabled: false, limitmWh: 1000, consumedmWh: 0 },
  });

  const [cutoffSavedAt, setCutoffSavedAt] = useState({ 1: null, 3: null });
  const [editingCutoffCh, setEditingCutoffCh] = useState(null);
  const editingCutoffChRef = useRef(null);

  useEffect(() => {
    editingCutoffChRef.current = editingCutoffCh;
  }, [editingCutoffCh]);

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
      if (d.cutoffs) {
        setCutoffsServer(d.cutoffs);

        const editingCh = editingCutoffChRef.current;

        if (!editingCh) {
          setCutoffsDraft(d.cutoffs);
        } else {
          setCutoffsDraft((prev) => {
            const next = { ...prev };
            for (const ch of [1, 3]) {
              if (ch !== editingCh) next[ch] = d.cutoffs[ch] || next[ch];
            }
            return next;
          });
        }
      }
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

      const c = cutoffsDraft[ch];

      await axios.post(`${API_BASE}/api/cutoff/${DEVICE_ID}`, {
        ch,
        enabled: !!c.enabled,
        limitmWh: Number(c.limitmWh ?? 1000),
      });

      setCutoffSavedAt((prev) => ({ ...prev, [ch]: Date.now() }));
      setEditingCutoffCh(null);

      await fetchAutomations(); // refresh from backend
    } catch {
      setError("Energy cutoff save failed. Check backend logs.");
    } finally {
      setLoadingRelay(false);
    }
  }

  async function fetchFault() {
    try {
      const res = await axios.get(
        `${API_BASE}/api/fault/${DEVICE_ID}?limit=200`,
      );
      const s = res.data?.settings || null;

      setFaultLatched(!!s?.latched);
      setFaultEvents(Array.isArray(res.data?.events) ? res.data.events : []);

      if (!faultOpenRef.current && !editingFaultRef.current) {
        setFaultDraft({
          vMin: s?.vMin ?? "",
          vMax: s?.vMax ?? "",
          iMin: s?.iMin ?? "",
          iMax: s?.iMax ?? "",
          pMin: s?.pMin ?? "",
          pMax: s?.pMax ?? "",
        });
      }

      return s;
    } catch {
      return null;
    }
  }

  async function saveFaultSettings() {
    try {
      setLoadingRelay(true);
      setError("");

      await axios.post(`${API_BASE}/api/fault/${DEVICE_ID}/settings`, {
        vMin: faultDraft.vMin,
        vMax: faultDraft.vMax,
        iMin: faultDraft.iMin,
        iMax: faultDraft.iMax,
        pMin: faultDraft.pMin,
        pMax: faultDraft.pMax,
      });

      await fetchFault();
      setFaultOpen(false);
      setEditingFault(false);
    } catch (e) {
      setError(e?.response?.data?.error || "Fault settings save failed.");
    } finally {
      setLoadingRelay(false);
    }
  }

  async function resetFaultLatch() {
    try {
      setLoadingRelay(true);
      setError("");
      await axios.post(`${API_BASE}/api/fault/${DEVICE_ID}/reset`);
      await fetchFault();
    } catch {
      setError("Fault reset failed.");
    } finally {
      setLoadingRelay(false);
    }
  }

  useEffect(() => {
    editingScheduleChRef.current = editingScheduleCh;
  }, [editingScheduleCh]);

  async function clearFaultEvents() {
    try {
      setFaultBusy(true);
      setError("");
      await axios.delete(`${API_BASE}/api/fault/${DEVICE_ID}/events`);
      await fetchFault(); // refresh list
    } catch (e) {
      setError(
        e?.response?.data?.error || "Failed to clear fault notifications.",
      );
    } finally {
      setFaultBusy(false);
    }
  }

  async function deleteFaultEvent(eventId) {
    if (!eventId) return;
    try {
      setFaultBusy(true);
      setError("");
      await axios.delete(
        `${API_BASE}/api/fault/${DEVICE_ID}/events/${eventId}`,
      );
      await fetchFault(); // refresh list
    } catch (e) {
      setError(e?.response?.data?.error || "Failed to delete notification.");
    } finally {
      setFaultBusy(false);
    }
  }

  // async function deleteFaultEvent(eventId) {
  //   if (!eventId) return;

  //   try {
  //     setError("");
  //     await axios.delete(`${API_BASE}/api/fault/${DEVICE_ID}/events/${eventId}`);
  //     await fetchFault(); // refresh list
  //   } catch (e) {
  //     setError(e?.response?.data?.error || "Delete fault event failed.");
  //   }
  // }

  async function deleteAllFaultEvents() {
    try {
      await axios.delete(`${API_BASE}/api/fault/${DEVICE_ID}/events`);
      await fetchFault();
    } catch (e) {
      setError(e?.response?.data?.error || "Delete all fault events failed.");
    }
  }

  async function cancelCutoff(ch) {
    try {
      setLoadingRelay(true);
      setError("");

      await axios.delete(`${API_BASE}/api/cutoff/${DEVICE_ID}/${ch}`);

      // refresh from backend
      setEditingCutoffCh(null);
      await fetchAutomations();

      // reset local draft immediately (nice UX)
      setCutoffsDraft((prev) => ({
        ...prev,
        [ch]: { enabled: false, limitmWh: 1000, consumedmWh: 0 },
      }));

      setCutoffSavedAt((prev) => ({ ...prev, [ch]: Date.now() }));
    } catch {
      setError("Energy cutoff cancel failed. Check backend logs.");
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

  useEffect(() => {
    editingCutoffChRef.current = editingCutoffCh;
  }, [editingCutoffCh]);

  useEffect(() => {
    fetchLatest();
    fetchHistory();
    fetchAutomations();
    fetchFault();

    const t = setInterval(fetchLatest, 2000);
    const h = setInterval(fetchHistory, 8000);
    const a = setInterval(fetchAutomations, 10000);
    const tr = setInterval(fetchFault, 12000);
    const k = setInterval(() => setTick((x) => x + 1), 1000);

    return () => {
      clearInterval(t);
      clearInterval(h);
      clearInterval(a);
      clearInterval(tr);
      clearInterval(k);
    };
  }, []);

  useEffect(() => {
    function onDocClick(e) {
      if (!notifOpen) return;
    }
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [notifOpen]);

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

  const totals = useMemo(
    () => computeActiveTotals(latest, device),
    [latest, device],
  );

  const totalVoltage = totals.vTotal;
  const totalCurrent = totals.iTotal;
  const pT = totals.pTotal;

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
          <h1 className="title">GridSense: Smart Energy Automation</h1>
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
            className="btn"
            type="button"
            onClick={async () => {
              const s = await fetchFault(); 

              setFaultDraft({
                vMin: s?.vMin ?? "",
                vMax: s?.vMax ?? "",
                iMin: s?.iMin ?? "",
                iMax: s?.iMax ?? "",
                pMin: s?.pMin ?? "",
                pMax: s?.pMax ?? "",
              });

              setEditingFault(false);
              setFaultOpen(true);
            }}
          >
            Fault Settings
          </button>

          <div className="notifWrap">
            <button
              className={`iconBtn ${faultLatched ? "warn" : ""}`}
              type="button"
              onClick={() => setNotifOpen((s) => !s)}
              title="Fault notifications"
            >
              <BellIcon size={26} />
              {faultLatched ? <span className="notifDot" /> : null}
            </button>

            <FaultNotificationsPanel
              open={notifOpen}
              onClose={() => setNotifOpen(false)}
              events={faultEvents}
              onDeleteEvent={deleteFaultEvent}
              onDeleteAll={deleteAllFaultEvents}
            />
          </div>

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
            cutoff={cutoffsDraft[1]}
            setCutoff={(fn) =>
              setCutoffsDraft((c) => ({
                ...c,
                1: typeof fn === "function" ? fn(c[1]) : fn,
              }))
            }
            cutoffServer={cutoffsServer[1]}
            cutoffSavedAt={cutoffSavedAt[1]}
            onCutoffFocus={(ch) => setEditingCutoffCh(ch)}
            onApplyCutoff={applyCutoff}
            timerMode={timers?.[1]?.mode || null}
            onCancelCutoff={cancelCutoff}
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
            cutoff={cutoffsDraft[3]}
            setCutoff={(fn) =>
              setCutoffsDraft((c) => ({
                ...c,
                3: typeof fn === "function" ? fn(c[3]) : fn,
              }))
            }
            cutoffServer={cutoffsServer[3]}
            cutoffSavedAt={cutoffSavedAt[3]}
            onCutoffFocus={(ch) => setEditingCutoffCh(ch)}
            onApplyCutoff={applyCutoff}
            timerMode={timers?.[3]?.mode || null}
            onCancelCutoff={cancelCutoff}
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
      <FaultSettingsModal
        open={faultOpen}
        onClose={() => {
          setFaultOpen(false);
          setEditingFault(false);
        }}
        draft={faultDraft}
        setDraft={setFaultDraft}
        onSave={saveFaultSettings}
        onResetLatch={resetFaultLatch}
        latched={faultLatched}
        onUserEdit={() => setEditingFault(true)}
        events={faultEvents}
        onDeleteEvent={deleteFaultEvent}
      />
    </div>
  );
}
