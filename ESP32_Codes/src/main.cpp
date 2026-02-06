#include <WiFi.h>
#include <PubSubClient.h>
#include <math.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <WiFiClientSecure.h> 


#define USE_CLOUD 1

#ifndef WIFI_SSID
  #define WIFI_SSID ""
#endif
#ifndef WIFI_PASS
  #define WIFI_PASS ""
#endif

#ifndef MQTT_HOST_ONLINE
  #define MQTT_HOST_ONLINE "broker.emqx.io"
#endif
#ifndef MQTT_HOST_OFFLINE
  #define MQTT_HOST_OFFLINE "192.168.31.108"
#endif
#ifndef MQTT_PORT
  #define MQTT_PORT 1883
#endif

#ifndef BACKEND_BASE
  #define BACKEND_BASE "https://ete416-iot-server.onrender.com"
#endif
#ifndef BACKEND_HOST
  #define BACKEND_HOST "192.168.1.106"
#endif
#ifndef BACKEND_PORT
  #define BACKEND_PORT 5000
#endif

#ifndef DEVICE_ID
  #define DEVICE_ID "esp32_001"
#endif

const char* ssid = WIFI_SSID;
const char* pass = WIFI_PASS;
const int mqtt_port = MQTT_PORT;
const char* deviceId = DEVICE_ID;

#if USE_CLOUD
const char* backend_base = BACKEND_BASE;
const char* mqtt_server = MQTT_HOST_ONLINE;
#else
const char* mqtt_server = MQTT_HOST_OFFLINE;
const char* backend_host = BACKEND_HOST;
const int backend_port = BACKEND_PORT;
#endif



String topicTelemetry = String("home/") + deviceId + "/telemetry";
String topicCmd       = String("home/") + deviceId + "/cmd";
String topicAck       = String("home/") + deviceId + "/ack";
String topicStatus    = String("home/") + deviceId + "/status";

WiFiClient espClient;
PubSubClient client(espClient);

/* ===================== RELAYS (ONLY 2) ===================== */
static const int RELAY1_PIN = 23; // Relay-1
static const int RELAY3_PIN = 21; // Relay-3

// Active-Low relay module (typical). If yours is Active-High, swap these.
static const int RELAY_ON  = LOW;
static const int RELAY_OFF = HIGH;

// relay states for ch=1 and ch=3 only
int relay1State = 0;
int relay3State = 0;

// static inline void setRelayByCh(int ch, int state) {
//   state = state ? 1 : 0;
//   if (ch == 1) {
//     relay1State = state;
//     digitalWrite(RELAY1_PIN, state ? RELAY_ON : RELAY_OFF);
//   } else if (ch == 3) {
//     relay3State = state;
//     digitalWrite(RELAY3_PIN, state ? RELAY_ON : RELAY_OFF);
//   }
// }

/* ===================== ADC / RMS SETTINGS ===================== */
static const float ADC_VREF   = 3.3f;
static const float ADC_MAX    = 4095.0f;

static const int   SAMPLES        = 2000;
static const int   US_PER_SAMPLE  = 200;   // 200us -> 0.4s window per channel

static const float IOUT_NOISE_VRMS = 0.004f; // gate small noise

static inline float countsRmsToVoltsRms(float rmsCounts) {
  return (rmsCounts / ADC_MAX) * ADC_VREF;
}

// One-pass RMS of AC component: RMS(x - mean)
static void readMeanAndRmsCounts(int pin, float &meanCounts, float &rmsCounts, int &minC, int &maxC) {
  double sum = 0.0, sum2 = 0.0;
  minC = 4095; maxC = 0;

  for (int k = 0; k < SAMPLES; k++) {
    int x = analogRead(pin);
    if (x < minC) minC = x;
    if (x > maxC) maxC = x;
    sum  += x;
    sum2 += (double)x * (double)x;
    delayMicroseconds(US_PER_SAMPLE);
  }

  double mean = sum / SAMPLES;
  double var  = (sum2 / SAMPLES) - mean * mean;
  if (var < 0) var = 0;

  meanCounts = (float)mean;
  rmsCounts  = (float)sqrt(var);
}

static float readVrmsCalibrated(int voltPin, float VOLT_CAL) {
  float meanC, rmsC;
  int mn, mx;
  readMeanAndRmsCounts(voltPin, meanC, rmsC, mn, mx);

  float vOutRms = countsRmsToVoltsRms(rmsC);
  float Vrms = vOutRms * VOLT_CAL;

  if (Vrms < 5.0f) Vrms = 0.0f;
  if (Vrms > 400.0f) Vrms = 400.0f;
  return Vrms;
}

static float readIrmsTwoPoint(int currPin, float A, float B) {
  float meanC, rmsC;
  int mn, mx;
  readMeanAndRmsCounts(currPin, meanC, rmsC, mn, mx);

  // crude clipping detect (helps avoid garbage)
  if (mn <= 5 || mx >= 4090) {
    return NAN; // indicates clipping/invalid
  }

  float iOutRms = countsRmsToVoltsRms(rmsC);
  if (iOutRms < IOUT_NOISE_VRMS) return 0.0f;

  float Irms = A * iOutRms + B;
  if (Irms < 0) Irms = 0.0f;
  return Irms;
}

/* ===================== SENSOR PINS (YOU SPECIFIED) ===================== */
// Relay-1 sensors
static const int V1_PIN = 33; // ZMPT101B for Relay-1
static const int I1_PIN = 32; // ZMCT103C for Relay-1

// Relay-3 sensors
static const int V3_PIN = 35; // ZMPT101B for Relay-3 (ADC2)
static const int I3_PIN = 34; // ZMCT103C for Relay-3 (ADC2)

/* ===================== CALIBRATION VALUES (FROM YOUR SKETCHES) ===================== */
// Relay-1
static const float V1_CAL = 840.0f;
// Two-point current model: Irms = A1 * iOutRms + B1
// Points: (I,Vout) = (0.170,0.149) and (0.320,0.212)
static const float I1_A = (0.320f - 0.170f) / (0.212f - 0.149f);
static const float I1_B = 0.170f - I1_A * 0.149f;

// Relay-3
static const float V3_CAL = 592.4f;
// Points: (I,Vout) = (0.170,0.39) and (0.33,0.43)
static const float I3_A = (0.33f - 0.17f) / (0.478f - 0.41f);
static const float I3_B = 0.17f - I3_A * 0.41f;

/* ===================== ENERGY ACCUMULATORS ===================== */
float e1Wh = 0.0f;
float e3Wh = 0.0f;

unsigned long lastTelemetryMs = 0;

/* ===================== MQTT HELPERS ===================== */
void publishStatus(const char* reason) {
  String payload = "{";
  payload += "\"deviceId\":\"" + String(deviceId) + "\",";
  payload += "\"reason\":\"" + String(reason) + "\",";
  payload += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  payload += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  payload += "\"relay\":[" + String(relay1State) + "," + String(relay3State) + "]";
  payload += "}";
  client.publish(topicStatus.c_str(), payload.c_str(), true);
}

void publishAck(const char* info) {
  String payload = "{";
  payload += "\"deviceId\":\"" + String(deviceId) + "\",";
  payload += "\"info\":\"" + String(info) + "\",";
  payload += "\"relay\":[" + String(relay1State) + "," + String(relay3State) + "]";
  payload += "}";
  client.publish(topicAck.c_str(), payload.c_str());
}

void applyRelay(int ch, int state);

void callback(char* topic, byte* message, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) msg += (char)message[i];

  // Expected JSON: {"ch":1,"state":1} OR {"ch":3,"state":0}
  int chPos = msg.indexOf("\"ch\":");
  int stPos = msg.indexOf("\"state\":");
  if (chPos == -1 || stPos == -1) return;

  int ch = msg.substring(chPos + 5).toInt();
  int st = msg.substring(stPos + 8).toInt();

  if ((ch != 1 && ch != 3) || (st != 0 && st != 1)) return;

  applyRelay(ch, st);

  publishAck("cmd_applied");
  publishStatus("relay_changed");

  Serial.printf("Relay updated: ch=%d state=%d\n", ch, st);
}


void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(ssid, pass);

  Serial.print("WiFi connecting");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
    if (millis() - t0 > 20000) {
      Serial.println("\nWiFi timeout, retrying...");
      WiFi.disconnect(true);
      delay(1000);
      WiFi.begin(ssid, pass);
      t0 = millis();
      Serial.print("WiFi connecting");
    }
  }
  Serial.println("\nWiFi connected");
  Serial.print("ESP32 IP: ");
  Serial.println(WiFi.localIP());
}
void restoreRelayStateFromBackend() {
  if (WiFi.status() != WL_CONNECTED) return;

#if USE_CLOUD
  // --- CLOUD (HTTPS) ---
  const String url = String(backend_base) + "/api/device/" + deviceId;

  WiFiClientSecure net;
  net.setInsecure(); // testing only (skips cert validation)

  HTTPClient http;
  http.setTimeout(12000);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  if (!http.begin(net, url)) {
    Serial.println("[BOOT] http.begin() failed (cloud)");
    applyRelay(1, 0);
    applyRelay(3, 0);
    return;
  }

#else
  // --- LOCAL (HTTP) ---
  const String url = "http://" + String(backend_host) + ":" + String(backend_port) +
                     "/api/device/" + deviceId;

  HTTPClient http;
  http.setTimeout(12000);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  if (!http.begin(url)) {
    Serial.println("[BOOT] http.begin() failed (local)");
    applyRelay(1, 0);
    applyRelay(3, 0);
    return;
  }
#endif

  const int code = http.GET();
  Serial.printf("[BOOT] GET %s -> %d\n", url.c_str(), code);

  if (code == 200) {
    const String body = http.getString();

    StaticJsonDocument<512> doc;
    DeserializationError err = deserializeJson(doc, body);

    if (!err && !doc.isNull()) {
      JsonArray relay = doc["relay"].as<JsonArray>();
      int r1 = relay.size() > 0 ? relay[0].as<int>() : 0;
      int r3 = relay.size() > 1 ? relay[1].as<int>() : 0;

      applyRelay(1, r1);
      applyRelay(3, r3);

      Serial.printf("[BOOT] Restored from DB: relay=[%d,%d]\n", r1, r3);
    } else {
      Serial.println("[BOOT] JSON parse failed or null doc, default OFF");
      applyRelay(1, 0);
      applyRelay(3, 0);
    }
  } else {
    Serial.printf("[BOOT] GET device failed (%d). Default OFF.\n", code);
    applyRelay(1, 0);
    applyRelay(3, 0);
  }

  http.end();
}


void connectMQTT() {
  while (!client.connected()) {
    Serial.print("MQTT connecting...");
    String clientId = String(deviceId) + "_" + String((uint32_t)ESP.getEfuseMac(), HEX);

    if (client.connect(clientId.c_str())) {
      Serial.println("connected");
      client.subscribe(topicCmd.c_str());
      publishStatus("boot_connected");
      publishAck("boot_connected");
    } else {
      Serial.printf("failed rc=%d retry in 2s\n", client.state());
      delay(2000);
    }
  }
}

void applyRelay(int ch, int state) {
  state = state ? 1 : 0;
  if (ch == 1) {
    relay1State = state;
    digitalWrite(RELAY1_PIN, state ? RELAY_ON : RELAY_OFF);
  } else if (ch == 3) {
    relay3State = state;
    digitalWrite(RELAY3_PIN, state ? RELAY_ON : RELAY_OFF);
  }
}

/* ===================== SETUP / LOOP ===================== */
void setup() {
  Serial.begin(115200);

  // Relays
  pinMode(RELAY1_PIN, OUTPUT);
  pinMode(RELAY3_PIN, OUTPUT);
  digitalWrite(RELAY1_PIN, RELAY_OFF);
  digitalWrite(RELAY3_PIN, RELAY_OFF);

  // ADC
  analogReadResolution(12);
  analogSetPinAttenuation(V1_PIN, ADC_11db);
  analogSetPinAttenuation(I1_PIN, ADC_11db);
  analogSetPinAttenuation(V3_PIN, ADC_11db);
  analogSetPinAttenuation(I3_PIN, ADC_11db);

  connectWiFi();
  restoreRelayStateFromBackend();
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);
  client.setBufferSize(1024);
  client.setKeepAlive(30);
  connectMQTT();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!client.connected()) connectMQTT();
  client.loop();

  if (millis() - lastTelemetryMs > 2000) {
    unsigned long nowMs = millis();
    float dtHours = 0.0f;
    if (lastTelemetryMs != 0) dtHours = (nowMs - lastTelemetryMs) / 1000.0f / 3600.0f;
    lastTelemetryMs = nowMs;

    // ---- Relay-1 measurements ----
    float v1 = readVrmsCalibrated(V1_PIN, V1_CAL);
    float i1 = readIrmsTwoPoint(I1_PIN, I1_A, I1_B);
    bool  i1Bad = isnan(i1);
    if (i1Bad) i1 = 0.0f;
    float p1 = v1 * i1;
    e1Wh += p1 * dtHours;

    // ---- Relay-3 measurements ----
    float v3 = readVrmsCalibrated(V3_PIN, V3_CAL);
    float i3 = readIrmsTwoPoint(I3_PIN, I3_A, I3_B);
    bool  i3Bad = isnan(i3);
    if (i3Bad) i3 = 0.0f;
    float p3 = v3 * i3;
    e3Wh += p3 * dtHours;

    // Totals (optional convenience)
    float pTotal = p1 + p3;
    float eTotal = e1Wh + e3Wh;

    String payload = "{";
    payload += "\"deviceId\":\"" + String(deviceId) + "\",";
    payload += "\"ts\":" + String((uint32_t)(nowMs / 1000)) + ",";

    // Per-relay calibrated values
    payload += "\"v1\":" + String(v1, 2) + ",";
    payload += "\"i1\":" + String(i1, 3) + ",";
    payload += "\"p1\":" + String(p1, 2) + ",";
    payload += "\"e1Wh\":" + String(e1Wh, 3) + ",";

    payload += "\"v3\":" + String(v3, 2) + ",";
    payload += "\"i3\":" + String(i3, 3) + ",";
    payload += "\"p3\":" + String(p3, 2) + ",";
    payload += "\"e3Wh\":" + String(e3Wh, 3) + ",";

    // Totals (keeps your original fields meaningful)
    payload += "\"voltage\":" + String(v1, 2) + ",";         // use v1 as main voltage reference
    payload += "\"current\":" + String(i1 + i3, 3) + ",";
    payload += "\"power\":"   + String(pTotal, 2) + ",";
    payload += "\"energyWh\":" + String(eTotal, 3) + ",";

    payload += "\"rssi\":" + String(WiFi.RSSI()) + ",";
    payload += "\"relay\":[" + String(relay1State) + "," + String(relay3State) + "],";

    // Flags if ADC clipping happened on current channels
    payload += "\"clipI1\":" + String(i1Bad ? 1 : 0) + ",";
    payload += "\"clipI3\":" + String(i3Bad ? 1 : 0);

    payload += "}";

    client.publish(topicTelemetry.c_str(), payload.c_str());
    Serial.printf("Telemetry: v1=%.1f i1=%.3f | v3=%.1f i3=%.3f\n", v1, i1, v3, i3);
  }
}
