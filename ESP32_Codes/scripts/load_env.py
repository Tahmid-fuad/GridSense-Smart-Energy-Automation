import os
from pathlib import Path
import re

def _parse_env_file(path: Path):
    data = {}
    if not path.exists():
        return data
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        data[k] = v
    return data

Import("env")

project_dir = Path(env["PROJECT_DIR"])
env_path = project_dir / ".env"
vars = _parse_env_file(env_path)

# Helper: add -DKEY="value" or -DKEY=value
def define_str(key, default=""):
    val = vars.get(key, default)
    env.Append(CPPDEFINES=[(key, f'\\"{val}\\"')])

def define_int(key, default="0"):
    val = vars.get(key, default)
    env.Append(CPPDEFINES=[(key, val)])

# -------------------------
# WiFi: multi-credential support
# -------------------------
# Choose a maximum slot count ONCE. You can keep this at 10.
WIFI_SLOTS_MAX = int(vars.get("WIFI_SLOTS_MAX", "10"))

# Define WIFI_SSID1..WIFI_SSIDN and WIFI_PASS1..WIFI_PASSN
for i in range(1, WIFI_SLOTS_MAX + 1):
    define_str(f"WIFI_SSID{i}", "")
    define_str(f"WIFI_PASS{i}", "")

# Backward compatibility:
# If your code still expects WIFI_SSID/WIFI_PASS, fill them from slot1 unless explicitly set.
ssid_legacy = vars.get("WIFI_SSID", "")
pass_legacy = vars.get("WIFI_PASS", "")

ssid1 = vars.get("WIFI_SSID1", "")
pass1 = vars.get("WIFI_PASS1", "")

define_str("WIFI_SSID", ssid_legacy if ssid_legacy else ssid1)
define_str("WIFI_PASS", pass_legacy if pass_legacy else pass1)

# -------------------------
# Existing macros (unchanged)
# -------------------------
define_str("MQTT_HOST_ONLINE", vars.get("MQTT_HOST_ONLINE", ""))
define_str("MQTT_HOST_OFFLINE", vars.get("MQTT_HOST_OFFLINE", "192.168.31.108"))
define_int("MQTT_PORT", vars.get("MQTT_PORT", "1883"))

define_str("BACKEND_BASE", vars.get("BACKEND_BASE", ""))
define_str("BACKEND_HOST", vars.get("BACKEND_HOST", "192.168.31.108"))
define_int("BACKEND_PORT", vars.get("BACKEND_PORT", "5000"))

define_str("DEVICE_ID", vars.get("DEVICE_ID", "esp32_001"))
