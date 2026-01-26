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
    thresholdW: { type: Number, default: 150 },
    holdSec: { type: Number, default: 10 },
    aboveSince: { type: Number, default: null }, // unix seconds
  },
  { timestamps: true },
);

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
      const rules = await Cutoff.find({
        deviceId: doc.deviceId,
        enabled: true,
      }).lean();

      for (const r of rules) {
        const relayOn = relayStateFromArray(r.ch, doc.relay) === 1;
        if (!relayOn) {
          // reset if relay is OFF
          await Cutoff.updateOne(
            { _id: r._id },
            { $set: { aboveSince: null } },
          );
          continue;
        }

        const p = r.ch === 1 ? doc.p1 : doc.p3;
        if (typeof p !== "number") continue;

        if (p > r.thresholdW) {
          const aboveSince = r.aboveSince ?? now;
          const dt = now - aboveSince;

          if (!r.aboveSince) {
            await Cutoff.updateOne({ _id: r._id }, { $set: { aboveSince } });
          } else if (dt >= r.holdSec) {
            publishRelayCmd(doc.deviceId, r.ch, 0, {
              reason: "cutoff",
              p,
              thresholdW: r.thresholdW,
            });
            await Cutoff.updateOne(
              { _id: r._id },
              { $set: { aboveSince: null } },
            );
          }
        } else {
          // back below threshold => reset
          if (r.aboveSince) {
            await Cutoff.updateOne(
              { _id: r._id },
              { $set: { aboveSince: null } },
            );
          }
        }
      }

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
    { $set: { active: false } }
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
    { $set: { active: false } }
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

// POST /api/cutoff/:deviceId  { "ch": 1, "enabled": true, "thresholdW":150, "holdSec":10 }
app.post("/api/cutoff/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const { ch, enabled, thresholdW, holdSec } = req.body;

  if (![1, 3].includes(ch))
    return res.status(400).json({ ok: false, error: "ch must be 1/3" });

  const doc = await Cutoff.findOneAndUpdate(
    { deviceId, ch },
    {
      $set: {
        enabled: !!enabled,
        thresholdW: Number(thresholdW ?? 150),
        holdSec: Number(holdSec ?? 10),
        aboveSince: null,
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
  { upsert: true, new: true }
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
    1: { enabled: false, thresholdW: 150, holdSec: 10 },
    3: { enabled: false, thresholdW: 150, holdSec: 10 },
  };
  for (const c of cutoffs) {
    cByCh[c.ch] = {
      enabled: !!c.enabled,
      thresholdW: Number(c.thresholdW ?? 150),
      holdSec: Number(c.holdSec ?? 10),
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
