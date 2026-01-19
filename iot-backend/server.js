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
    voltage: Number,
    current: Number,
    power: Number,
    energyWh: Number,
    rssi: Number,
    relay: [Number],
    raw: Object,
  },
  { timestamps: true }
);

const DeviceSchema = new mongoose.Schema(
  {
    deviceId: { type: String, unique: true },
    lastSeen: Number,     // server time (seconds)
    relay: [Number],      // last reported
  },
  { timestamps: true }
);

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
    const doc = {
      deviceId: data.deviceId || DEVICE_ID,
      ts: data.ts ?? now,
      voltage: data.voltage,
      current: data.current,
      power: data.power,
      energyWh: data.energyWh,
      rssi: data.rssi,
      relay: data.relay,
      raw: data,
    };

    await Telemetry.create(doc);

    await Device.updateOne(
      { deviceId: doc.deviceId },
      { $set: { lastSeen: now, relay: doc.relay } },
      { upsert: true }
    );

    // Optional: print a short log so you see it's working
    console.log(`[DB] Telemetry saved: V=${doc.voltage} I=${doc.current} P=${doc.power}`);
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
  const last = await Telemetry.findOne({ deviceId }).sort({ createdAt: -1 }).lean();
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
  const { ch, state } = req.body;

  if (![1, 2, 3, 4].includes(ch) || ![0, 1].includes(state)) {
    return res.status(400).json({ ok: false, error: "ch must be 1..4 and state must be 0/1" });
  }

  const cmd = { ch, state };
  mqttClient.publish(`home/${deviceId}/cmd`, JSON.stringify(cmd));

  res.json({ ok: true, published: cmd });
});

app.get("/api/device/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const dev = await Device.findOne({ deviceId }).lean();
  res.json(dev || null);
});

// ---------- Start ----------
async function start() {
  await mongoose.connect(MONGO_URI);
  console.log("[Mongo] Connected:", MONGO_URI);

  app.listen(PORT, () => {
    console.log(`[Server] http://localhost:${PORT}`);
  });
}

start().catch((e) => {
  console.error("Startup error:", e);
  process.exit(1);
});
