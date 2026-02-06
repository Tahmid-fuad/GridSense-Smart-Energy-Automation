import os
from pathlib import Path

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

# Define macros used in code
define_str("WIFI_SSID", "")
define_str("WIFI_PASS", "")

define_str("MQTT_HOST_ONLINE", "broker.emqx.io")
define_str("MQTT_HOST_OFFLINE", "192.168.31.108")
define_int("MQTT_PORT", "1883")

define_str("BACKEND_BASE", "https://ete416-iot-server.onrender.com")
define_str("BACKEND_HOST", "192.168.31.108")
define_int("BACKEND_PORT", "5000")

define_str("DEVICE_ID", "esp32_001")
