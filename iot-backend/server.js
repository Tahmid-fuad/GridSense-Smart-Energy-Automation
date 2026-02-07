require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const mqtt = require("mqtt");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const MQTT_URL = process.env.MQTT_URL;
const DEVICE_ID = process.env.DEVICE_ID || "esp32_001";

// ---------- MongoDB Schemas ----------
const TelemetrySchema = new mongoose.Schema(
  {
    deviceId: { type: String, index: true },
    ts: { type: Number, index: true }, // from ESP32 payload (seconds)

    // Legacy totals (still sent)
    voltage: Number,
    current: Number,
    power: Number,
    energyWh: Number,

    // New per-relay calibrated values
    v1: Number,
    i1: Number,
    p1: Number,
    e1Wh: Number,

    v3: Number,
    i3: Number,
    p3: Number,
    e3Wh: Number,

    // Diagnostics (optional)
    clipI1: Number,
    clipI3: Number,

    rssi: Number,

    // Now relay array will be [relay1State, relay3State]
    relay: [Number],

    raw: Object,
  },
  { timestamps: true },
);

const DeviceSchema = new mongoose.Schema(
  {
    deviceId: { type: String, unique: true },
    lastSeen: Number, // server time (seconds)
    relay: [Number], // last reported
  },
  { timestamps: true },
);

// ---------- Automations Schemas ----------
const TimerSchema = new mongoose.Schema(
  {
    deviceId: { type: String, index: true },
    ch: { type: Number, enum: [1, 3], index: true },

    // "on_for" => turn ON now, then OFF at end
    // "off_for" => turn OFF now, then ON at end
    mode: { type: String, enum: ["on_for", "off_for"], required: true },

    endAt: { type: Date, index: true },
    endState: { type: Number, enum: [0, 1], required: true },

    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const ScheduleSchema = new mongoose.Schema(
  {
    deviceId: { type: String, index: true },
    ch: { type: Number, enum: [1, 3], index: true },
    enabled: { type: Boolean, default: false },
    on: { type: String, default: "18:00" }, // "HH:MM"
    off: { type: String, default: "23:00" }, // "HH:MM"
    tz: { type: String, default: "Asia/Dhaka" },
    lastAppliedState: { type: Number, enum: [0, 1], default: 0 }, // to reduce repeat publishes
    invert: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const CutoffSchema = new mongoose.Schema(
  {
    deviceId: { type: String, index: true },
    ch: { type: Number, enum: [1, 3], index: true },

    enabled: { type: Boolean, default: false },

    // Energy budget threshold (mWh)
    limitmWh: { type: Number, default: 1000 }, // 1000 mWh = 1 Wh

    // Baseline tracking (Wh from ESP32 counters)
    startWh: { type: Number, default: null },
    lastWh: { type: Number, default: null },

    // For UI / debug
    consumedmWh: { type: Number, default: 0 },
  },
  { timestamps: true },
);
// ---------- Trip / Fault detection ----------
const TripSettingsSchema = new mongoose.Schema(
  {
    deviceId: { type: String, unique: true, index: true },

    // Thresholds (null => disabled)
    vMin: { type: Number, default: null },
    vMax: { type: Number, default: null },
    iMin: { type: Number, default: null },
    iMax: { type: Number, default: null },
    pMin: { type: Number, default: null },
    pMax: { type: Number, default: null },

    // Latch: if tripped once, don't keep spamming OFF
    latched: { type: Boolean, default: false },
    latchedAt: { type: Date, default: null },
    lastFault: { type: String, default: "" },
  },
  { timestamps: true },
);

const TripEventSchema = new mongoose.Schema(
  {
    deviceId: { type: String, index: true },

    // "success" | "fault" | "info"
    level: {
      type: String,
      enum: ["success", "fault", "info"],
      default: "info",
    },

    // "settings_saved" | "settings_cleared" | "trip_triggered" | "trip_reset" ...
    kind: { type: String, default: "info" },

    // short fault tag (e.g., "V_HIGH", "P_LOW")
    fault: { type: String, default: "" },

    message: { type: String, default: "" },
    meta: { type: Object, default: {} },
  },
  { timestamps: true },
);

const TripSettings = mongoose.model(
  "TripSettings",
  TripSettingsSchema,
  "trip_settings",
);
const TripEvent = mongoose.model("TripEvent", TripEventSchema, "trip_events");

const Timer = mongoose.model("Timer", TimerSchema, "timers");
const Schedule = mongoose.model("Schedule", ScheduleSchema, "schedules");
const Cutoff = mongoose.model("Cutoff", CutoffSchema, "cutoffs");

// Fix collection names explicitly (easier to find in Compass)
const Telemetry = mongoose.model("Telemetry", TelemetrySchema, "telemetry");
const Device = mongoose.model("Device", DeviceSchema, "devices");

// ---------- MQTT ----------
const topicTelemetry = `home/${DEVICE_ID}/telemetry`;
const topicCmd = `home/${DEVICE_ID}/cmd`;
const topicAck = `home/${DEVICE_ID}/ack`;

const mqttClient = mqtt.connect(MQTT_URL, { reconnectPeriod: 2000 });

mqttClient.on("connect", () => {
  console.log("[MQTT] Connected:", MQTT_URL);
  mqttClient.subscribe([topicTelemetry, topicAck], (err) => {
    if (err) console.error("[MQTT] Subscribe error:", err.message);
    else console.log("[MQTT] Subscribed to:", topicTelemetry, "and", topicAck);
  });
});

function publishRelayCmd(deviceId, ch, state, meta = {}) {
  const cmd = { ch, state, ...meta };
  mqttClient.publish(`home/${deviceId}/cmd`, JSON.stringify(cmd));
  updateDeviceRelayArray(deviceId, ch, state);
}

async function updateDeviceRelayArray(deviceId, ch, state) {
  const idx = ch === 1 ? 0 : 1;
  const path = `relay.${idx}`;
  try {
    await Device.updateOne(
      { deviceId },
      { $set: { [path]: state } },
      { upsert: true },
    );
  } catch (e) {
    console.error("[DB] updateDeviceRelayArray error:", e?.message || e);
  }
}

function relayStateFromArray(ch, relayArr) {
  if (!Array.isArray(relayArr)) return 0;
  return ch === 1 ? (relayArr[0] ?? 0) : (relayArr[1] ?? 0);
}

function minutesFromHHMM(hhmm) {
  const [h, m] = String(hhmm || "00:00")
    .split(":")
    .map((v) => parseInt(v, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return Math.min(1439, Math.max(0, h * 60 + m));
}

function isWithinWindow(nowMin, onMin, offMin) {
  if (onMin === offMin) return false;
  if (onMin < offMin) return nowMin >= onMin && nowMin < offMin;
  return nowMin >= onMin || nowMin < offMin; // crosses midnight
}

function startAutomationEngine() {
  // Timers: check every 1s
  setInterval(async () => {
    const now = new Date();
    const due = await Timer.find({
      active: true,
      endAt: { $lte: now },
    }).lean();
    for (const t of due) {
      publishRelayCmd(t.deviceId, t.ch, t.endState, {
        reason: "timer",
        mode: t.mode,
      });
      await Timer.updateOne({ _id: t._id }, { $set: { active: false } });
    }
  }, 1000);

  // Schedules: check every 20s
  setInterval(async () => {
    const now = new Date();
    // Server timezone matters; easiest: use Dhaka time by offset math
    // Bangladesh is UTC+6 year-round.
    const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const nowDhakaMin = (utcMin + 6 * 60) % 1440;

    const scheds = await Schedule.find({ enabled: true }).lean();

    for (const s of scheds) {
      const onMin = minutesFromHHMM(s.on);
      const offMin = minutesFromHHMM(s.off);
      let desired = isWithinWindow(nowDhakaMin, onMin, offMin) ? 1 : 0;
      if (s.invert) desired = desired ? 0 : 1;

      // Avoid spamming: only publish if desired differs from lastAppliedState
      if (desired !== (s.lastAppliedState ?? 0)) {
        publishRelayCmd(s.deviceId, s.ch, desired, { reason: "schedule" });
        await Schedule.updateOne(
          { _id: s._id },
          { $set: { lastAppliedState: desired } },
        );
      }
    }
  }, 20000);
}

function normalizeCutoff(c) {
  return {
    enabled: !!c?.enabled,
    thresholdW: Number(c?.thresholdW ?? 150),
    holdSec: Number(c?.holdSec ?? 10),
  };
}

function cutoffsEqual(a, b) {
  const A = normalizeCutoff(a);
  const B = normalizeCutoff(b);
  return (
    A.enabled === B.enabled &&
    A.thresholdW === B.thresholdW &&
    A.holdSec === B.holdSec
  );
}

function numberOrNull(x) {
  if (x === "" || x === undefined || x === null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function logTripEvent(
  deviceId,
  { level = "info", kind = "info", fault = "", message = "", meta = {} },
) {
  try {
    await TripEvent.create({ deviceId, level, kind, fault, message, meta });
  } catch (e) {
    console.error("[DB] TripEvent log error:", e?.message || e);
  }
}

async function tripAllOff(deviceId, meta = {}) {
  // same behavior intent as master kill: cancel timers + publish OFF
  await Timer.updateMany(
    { deviceId, active: true },
    { $set: { active: false } },
  );
  publishRelayCmd(deviceId, 1, 0, { reason: "trip", ...meta });
  publishRelayCmd(deviceId, 3, 0, { reason: "trip", ...meta });
}

function hasAnyThreshold(s) {
  return ["vMin", "vMax", "iMin", "iMax", "pMin", "pMax"].some(
    (k) => typeof s?.[k] === "number",
  );
}

function checkTripViolations({ v, i, p }, s) {
  const faults = [];
  const add = (tag, msg) => faults.push({ tag, msg });

  if (typeof v === "number") {
    if (typeof s.vMin === "number" && v < s.vMin)
      add("V_LOW", `Voltage low: ${v.toFixed(2)} < ${s.vMin}`);
    if (typeof s.vMax === "number" && v > s.vMax)
      add("V_HIGH", `Voltage high: ${v.toFixed(2)} > ${s.vMax}`);
  }
  if (typeof i === "number") {
    if (typeof s.iMin === "number" && i < s.iMin)
      add("I_LOW", `Current low: ${i.toFixed(3)} < ${s.iMin}`);
    if (typeof s.iMax === "number" && i > s.iMax)
      add("I_HIGH", `Current high: ${i.toFixed(3)} > ${s.iMax}`);
  }
  if (typeof p === "number") {
    if (typeof s.pMin === "number" && p < s.pMin)
      add("P_LOW", `Power low: ${p.toFixed(2)} < ${s.pMin}`);
    if (typeof s.pMax === "number" && p > s.pMax)
      add("P_HIGH", `Power high: ${p.toFixed(2)} > ${s.pMax}`);
  }

  return faults;
}

async function evaluateTripOnTelemetry(doc) {
  const deviceId = doc.deviceId;

  if (!Array.isArray(doc.relay)) {
    const dev = await Device.findOne({ deviceId: doc.deviceId }).lean();
    doc.relay = Array.isArray(dev?.relay) ? dev.relay : [0, 0];
  }

  const s = await TripSettings.findOne({ deviceId }).lean();
  if (!s || !hasAnyThreshold(s)) return;

  // latched => do nothing until user resets
  if (s.latched) return;

  // Compute totals using relay-aware rule (same as frontend)
  const T = computeTripTotalsFromDoc(doc);

  // If both relays are OFF, skip trip evaluation to avoid false trips
  if (!T.anyOn) return;

  const v = T.v;
  const i = T.i;
  const p = T.p;

  const faults = checkTripViolations({ v, i, p }, s);
  if (!faults.length) return;

  const faultTag = faults.map((f) => f.tag).join("|");
  const msg = faults.map((f) => f.msg).join(" • ");

  await TripSettings.updateOne(
    { deviceId },
    { $set: { latched: true, latchedAt: new Date(), lastFault: msg } },
    { upsert: true },
  );

  await logTripEvent(deviceId, {
    level: "fault",
    kind: "trip_triggered",
    fault: faultTag,
    message: msg,
    meta: {
      v,
      i,
      p,
      relays: { r1On: T.r1On, r3On: T.r3On },
      settings: {
        vMin: s.vMin,
        vMax: s.vMax,
        iMin: s.iMin,
        iMax: s.iMax,
        pMin: s.pMin,
        pMax: s.pMax,
      },
    },
  });

  await tripAllOff(deviceId, { fault: faultTag });
}

function n(x) {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function computeTripTotalsFromDoc(doc) {
  const r1On = relayStateFromArray(1, doc.relay) === 1;
  const r3On = relayStateFromArray(3, doc.relay) === 1;

  const v1 = n(doc.v1);
  const v3 = n(doc.v3);
  const i1 = n(doc.i1);
  const i3 = n(doc.i3);
  const p1 = n(doc.p1);
  const p3 = n(doc.p3);

  let v = null;

  if (r1On && r3On) {
    if (v1 != null && v3 != null) v = (v1 + v3) / 2;
    else v = n(doc.voltage) ?? v1 ?? v3;
  } else if (r1On) {
    v = v1 ?? n(doc.voltage);
  } else if (r3On) {
    v = v3 ?? n(doc.voltage);
  } else {
    v = n(doc.voltage); // or null
  }

  const anyOn = r1On || r3On;

  const i = (r1On ? (i1 ?? 0) : 0) + (r3On ? (i3 ?? 0) : 0);
  const p = (r1On ? (p1 ?? 0) : 0) + (r3On ? (p3 ?? 0) : 0);

  return {
    anyOn,
    r1On,
    r3On,
    v,
    i: anyOn ? i : null,
    p: anyOn ? p : null,
  };
}

mqttClient.on("message", async (topic, buf) => {
  const text = buf.toString();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { rawText: text };
  }

  const now = Math.floor(Date.now() / 1000);

  if (topic === topicTelemetry) {
    try {
      const doc = {
        deviceId: data.deviceId || DEVICE_ID,
        ts: data.ts ?? now,

        // Totals (kept for compatibility)
        voltage: data.voltage,
        current: data.current,
        power: data.power,
        energyWh: data.energyWh,

        // Per-relay values
        v1: data.v1,
        i1: data.i1,
        p1: data.p1,
        e1Wh: data.e1Wh,

        v3: data.v3,
        i3: data.i3,
        p3: data.p3,
        e3Wh: data.e3Wh,

        // Diagnostics
        clipI1: data.clipI1,
        clipI3: data.clipI3,

        rssi: data.rssi,
        relay: data.relay, // [relay1State, relay3State]
        raw: data,
      };
      await Telemetry.create(doc);
      await Device.updateOne(
        { deviceId: doc.deviceId },
        { $set: { lastSeen: now, relay: doc.relay } },
        { upsert: true },
      );

      // --- Power cutoff rules (evaluated on each telemetry packet) ---
      // --- Energy budget auto-off (evaluated on each telemetry packet) ---
      const rules = await Cutoff.find({
        deviceId: doc.deviceId,
        enabled: true,
      }).lean();

      const EPS = 1e-9;

      for (const r of rules) {
        const relayOn = relayStateFromArray(r.ch, doc.relay) === 1;

        // Use ESP32 per-channel cumulative energy (Wh)
        const eWh = r.ch === 1 ? doc.e1Wh : doc.e3Wh;
        if (typeof eWh !== "number") continue;

        const limitmWh = Number(r.limitmWh ?? 0);
        if (!Number.isFinite(limitmWh) || limitmWh <= 0) continue;

        // Initialize baseline once (or if ESP32 counter resets)
        if (r.startWh == null || r.lastWh == null || eWh + EPS < r.lastWh) {
          await Cutoff.updateOne(
            { _id: r._id },
            { $set: { startWh: eWh, lastWh: eWh, consumedmWh: 0 } },
          );
          continue;
        }

        // Compute consumed energy since baseline
        const consumedmWh = Math.max(0, (eWh - r.startWh) * 1000.0);

        // Update tracking for UI/debug
        await Cutoff.updateOne(
          { _id: r._id },
          { $set: { lastWh: eWh, consumedmWh } },
        );

        // Only trigger auto-OFF if relay is currently ON
        if (relayOn && consumedmWh >= limitmWh) {
          publishRelayCmd(doc.deviceId, r.ch, 0, {
            reason: "energy_budget",
            consumedmWh: Number(consumedmWh.toFixed(2)),
            limitmWh,
          });

          // Reset after cutoff triggers (prevents instant re-trigger loop)
          await Cutoff.updateOne(
            { _id: r._id },
            { $set: { startWh: null, lastWh: null, consumedmWh: 0 } },
          );
        }
      }

      await evaluateTripOnTelemetry(doc);

      // Optional: print a short log so you see it's working
      console.log(
        `[DB] Saved: v1=${doc.v1} i1=${doc.i1} p1=${doc.p1} | v3=${doc.v3} i3=${doc.i3} p3=${doc.p3} | totalP=${doc.power}`,
      );
    } catch (e) {
      console.error("[MQTT] Telemetry handler error:", e?.message || e);
    }
  }

  if (topic === topicAck) {
    console.log("[ACK]", data);
  }
});

// ---------- REST API ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, mqtt: mqttClient.connected, deviceId: DEVICE_ID });
});

app.get("/api/latest/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const last = await Telemetry.findOne({ deviceId })
    .sort({ createdAt: -1 })
    .lean();
  res.json(last || null);
});

app.get("/api/history/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const limit = Math.min(parseInt(req.query.limit || "200", 10), 2000);

  const rows = await Telemetry.find({ deviceId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  res.json(rows.reverse());
});

// Relay command: POST { "ch": 1, "state": 1 }
app.post("/api/relay/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const ch = Number(req.body.ch);
  const state = Number(req.body.state);

  if (![1, 3].includes(ch) || ![0, 1].includes(state)) {
    return res.status(400).json({
      ok: false,
      error: "ch must be 1 or 3 and state must be 0/1",
    });
  }

  // Cancel any active timer for this channel (manual override)
  const cancelRes = await Timer.updateMany(
    { deviceId, ch, active: true },
    { $set: { active: false } },
  );

  // Use publishRelayCmd so Device.relay[] is updated consistently
  publishRelayCmd(deviceId, ch, state, { reason: "manual" });

  res.json({
    ok: true,
    published: { ch, state },
    timerCancelled: (cancelRes.modifiedCount || cancelRes.nModified || 0) > 0,
    cancelledCount: cancelRes.modifiedCount || cancelRes.nModified || 0,
  });
});

// Master OFF: POST { "state": 0 } (or 1 if you want master ON too)
app.post("/api/relayAll/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const state = Number(req.body.state);

  if (![0, 1].includes(state)) {
    return res.status(400).json({ ok: false, error: "state must be 0 or 1" });
  }

  // Cancel all active timers for this device
  await Timer.updateMany(
    { deviceId, active: true },
    { $set: { active: false } },
  );

  publishRelayCmd(deviceId, 1, state, { reason: "master" });
  publishRelayCmd(deviceId, 3, state, { reason: "master" });

  res.json({ ok: true, deviceId, relay: [state, state] });
});

app.get("/api/device/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const dev = await Device.findOne({ deviceId }).lean();
  res.json(dev || null);
});

// POST /api/timer/:deviceId
// Body: { ch:1|3, mode:"on_for"|"off_for", minutes:0..720, seconds:0..59 }
app.post("/api/timer/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const { ch, mode, minutes, seconds } = req.body;

  if (![1, 3].includes(ch)) {
    return res.status(400).json({ ok: false, error: "ch must be 1 or 3" });
  }
  if (!["on_for", "off_for"].includes(mode)) {
    return res
      .status(400)
      .json({ ok: false, error: "mode must be on_for/off_for" });
  }

  const m = Number(minutes || 0);
  const s = Number(seconds || 0);
  if (!Number.isFinite(m) || !Number.isFinite(s) || m < 0 || s < 0 || s > 59) {
    return res
      .status(400)
      .json({ ok: false, error: "minutes>=0 and seconds 0..59 required" });
  }

  const durationSec = m * 60 + s;
  if (durationSec <= 0 || durationSec > 12 * 60 * 60) {
    return res
      .status(400)
      .json({ ok: false, error: "duration must be 1..43200 seconds" });
  }

  // cancel any previous active timer for this ch
  await Timer.updateMany(
    { deviceId, ch, active: true },
    { $set: { active: false } },
  );

  // apply immediate state now + decide endState
  const startState = mode === "on_for" ? 1 : 0;
  const endState = mode === "on_for" ? 0 : 1;

  publishRelayCmd(deviceId, ch, startState, { reason: "timer_start", mode });

  const endAt = new Date(Date.now() + durationSec * 1000);

  const doc = await Timer.create({
    deviceId,
    ch,
    mode,
    endAt,
    endState,
    active: true,
  });

  res.json({ ok: true, timer: doc });
});

// DELETE /api/timer/:deviceId/:ch  cancel timer
app.delete("/api/timer/:deviceId/:ch", async (req, res) => {
  const { deviceId, ch } = req.params;
  await Timer.updateMany(
    { deviceId, ch: Number(ch), active: true },
    { $set: { active: false } },
  );
  res.json({ ok: true });
});

// POST /api/cutoff/:deviceId  { "ch": 1, "enabled": true, "limitmWh": 500 }
app.post("/api/cutoff/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const { ch, enabled, limitmWh } = req.body;

  if (![1, 3].includes(ch))
    return res.status(400).json({ ok: false, error: "ch must be 1/3" });

  const lim = Number(limitmWh ?? 1000);
  if (!Number.isFinite(lim) || lim < 1)
    return res.status(400).json({ ok: false, error: "limitmWh must be >= 1" });

  const doc = await Cutoff.findOneAndUpdate(
    { deviceId, ch },
    {
      $set: {
        enabled: !!enabled,
        limitmWh: lim,
        // Reset counters whenever rule is updated
        startWh: null,
        lastWh: null,
        consumedmWh: 0,
      },
    },
    { upsert: true, new: true },
  );

  res.json({ ok: true, cutoff: doc });
});

// POST /api/schedule/:deviceId  { "ch": 1, "enabled": true, "on":"18:00", "off":"23:00" }
app.post("/api/schedule/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const { ch, enabled, on, off, invert } = req.body;

  if (![1, 3].includes(ch)) {
    return res.status(400).json({ ok: false, error: "ch must be 1/3" });
  }

  const doc = await Schedule.findOneAndUpdate(
    { deviceId, ch },
    {
      $set: {
        enabled: !!enabled,
        on: on || "18:00",
        off: off || "23:00",
        invert: !!invert,
      },
    },
    { upsert: true, new: true },
  );

  res.json({ ok: true, schedule: doc });
});

// GET /api/automations/:deviceId
app.get("/api/automations/:deviceId", async (req, res) => {
  const { deviceId } = req.params;

  const [timers, schedules, cutoffs] = await Promise.all([
    Timer.find({ deviceId, active: true, ch: { $in: [1, 3] } }).lean(),
    Schedule.find({ deviceId, ch: { $in: [1, 3] } }).lean(),
    Cutoff.find({ deviceId, ch: { $in: [1, 3] } }).lean(),
  ]);

  // normalize to {1:{...}, 3:{...}} with defaults
  const tByCh = { 1: null, 3: null };
  for (const t of timers) {
    tByCh[t.ch] = {
      endAt: t.endAt,
      active: t.active,
      mode: t.mode,
      endState: t.endState,
    };
  }
  const sByCh = {
    1: { enabled: false, on: "18:00", off: "23:00" },
    3: { enabled: false, on: "18:00", off: "23:00" },
  };
  for (const s of schedules) {
    sByCh[s.ch] = {
      enabled: !!s.enabled,
      on: s.on || "18:00",
      off: s.off || "23:00",
      invert: !!s.invert,
    };
  }

  const cByCh = {
    1: { enabled: false, limitmWh: 1000, consumedmWh: 0 },
    3: { enabled: false, limitmWh: 1000, consumedmWh: 0 },
  };

  for (const c of cutoffs) {
    cByCh[c.ch] = {
      enabled: !!c.enabled,
      limitmWh: Number(c.limitmWh ?? 1000),
      consumedmWh: Number(c.consumedmWh ?? 0),
    };
  }

  res.json({ ok: true, timers: tByCh, schedules: sByCh, cutoffs: cByCh });
});

// DELETE /api/schedule/:deviceId/:ch  -> delete schedule entry
app.delete("/api/schedule/:deviceId/:ch", async (req, res) => {
  const { deviceId, ch } = req.params;
  const channel = Number(ch);

  if (![1, 3].includes(channel)) {
    return res.status(400).json({ ok: false, error: "ch must be 1/3" });
  }

  // Delete the schedule document completely
  const result = await Schedule.deleteOne({ deviceId, ch: channel });

  res.json({ ok: true, deletedCount: result.deletedCount || 0 });
});

// DELETE /api/cutoff/:deviceId/:ch  -> delete cutoff entry
app.delete("/api/cutoff/:deviceId/:ch", async (req, res) => {
  const { deviceId, ch } = req.params;
  const channel = Number(ch);

  if (![1, 3].includes(channel)) {
    return res.status(400).json({ ok: false, error: "ch must be 1/3" });
  }

  const result = await Cutoff.deleteOne({ deviceId, ch: channel });

  res.json({ ok: true, deletedCount: result.deletedCount || 0 });
});

// GET trip settings + recent events
app.get("/api/trip/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);

  const [settings, events] = await Promise.all([
    TripSettings.findOne({ deviceId }).lean(),
    TripEvent.find({ deviceId }).sort({ createdAt: -1 }).limit(limit).lean(),
  ]);

  res.json({ ok: true, settings: settings || null, events: events || [] });
});

// Save/Update trip thresholds (any field can be empty => null)
// POST body: { vMin, vMax, iMin, iMax, pMin, pMax }
app.post("/api/trip/:deviceId/settings", async (req, res) => {
  const { deviceId } = req.params;

  const next = {
    vMin: numberOrNull(req.body.vMin),
    vMax: numberOrNull(req.body.vMax),
    iMin: numberOrNull(req.body.iMin),
    iMax: numberOrNull(req.body.iMax),
    pMin: numberOrNull(req.body.pMin),
    pMax: numberOrNull(req.body.pMax),
  };

  // optional sanity checks (only when both exist)
  const bad =
    (next.vMin != null && next.vMax != null && next.vMin >= next.vMax) ||
    (next.iMin != null && next.iMax != null && next.iMin >= next.iMax) ||
    (next.pMin != null && next.pMax != null && next.pMin >= next.pMax);

  if (bad)
    return res
      .status(400)
      .json({ ok: false, error: "Min must be < Max (where both are set)." });

  // update + reset latch on settings change (so system can trip again properly)
  const doc = await TripSettings.findOneAndUpdate(
    { deviceId },
    { $set: { ...next, latched: false, latchedAt: null, lastFault: "" } },
    { upsert: true, new: true },
  );

  const kind = hasAnyThreshold(doc) ? "settings_saved" : "settings_cleared";

  await logTripEvent(deviceId, {
    level: "success",
    kind,
    message: hasAnyThreshold(doc)
      ? "Trip thresholds saved."
      : "Trip thresholds cleared (all empty).",
    meta: next,
  });

  res.json({ ok: true, settings: doc });
});

// Reset trip latch (after a trip)
app.post("/api/trip/:deviceId/reset", async (req, res) => {
  const { deviceId } = req.params;

  const doc = await TripSettings.findOneAndUpdate(
    { deviceId },
    { $set: { latched: false, latchedAt: null, lastFault: "" } },
    { upsert: true, new: true },
  );

  await logTripEvent(deviceId, {
    level: "success",
    kind: "trip_reset",
    message: "Trip latch reset.",
  });

  res.json({ ok: true, settings: doc });
});

// ---------------- Trip Events deletion ----------------

// DELETE all trip events for a device
app.delete("/api/trip/:deviceId/events", async (req, res) => {
  try {
    const { deviceId } = req.params;

    const result = await TripEvent.deleteMany({ deviceId });

    return res.json({
      ok: true,
      deletedCount: result.deletedCount || 0,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Failed to delete trip events.",
    });
  }
});

// DELETE one trip event by id (only if it belongs to the device)
app.delete("/api/trip/:deviceId/events/:eventId", async (req, res) => {
  try {
    const { deviceId, eventId } = req.params;

    // prevent CastError on invalid ObjectId
    if (!mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ ok: false, error: "Invalid eventId." });
    }

    const result = await TripEvent.deleteOne({ _id: eventId, deviceId });

    if ((result.deletedCount || 0) === 0) {
      return res
        .status(404)
        .json({ ok: false, error: "Trip event not found." });
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Failed to delete trip event.",
    });
  }
});

// ---------- Start ----------
async function start() {
  await mongoose.connect(MONGO_URI);
  console.log("[Mongo] Connected:", MONGO_URI);

  app.listen(PORT, () => {
    console.log(`[Server] http://localhost:${PORT}`);
  });

  startAutomationEngine();
}

start().catch((e) => {
  console.error("Startup error:", e);
  process.exit(1);
});
