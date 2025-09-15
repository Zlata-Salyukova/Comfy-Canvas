# ComfyUI/custom_nodes/ComfyCanvasBridge/cc_bridge_server.py
import os, io, time, threading, base64, signal
from flask import Flask, request, send_file, jsonify, send_from_directory, Response
try:
    from flask_cors import CORS  # type: ignore
    _CORS_AVAILABLE = True
except Exception:
    _CORS_AVAILABLE = False
    def CORS(app, *_, **__):  # no-op fallback
        print("Warning: flask-cors not installed; CORS disabled. Install with: pip install flask-cors")
        return app

HOST = os.environ.get("CC_BRIDGE_BIND_HOST", os.environ.get("LD_BRIDGE_BIND_HOST", "127.0.0.1"))
PORT = int(os.environ.get("CC_BRIDGE_PORT", os.environ.get("LD_BRIDGE_PORT", "8765")))
FRONTEND_DIR = (
    os.environ.get("CC_FRONTEND_DIR", os.environ.get("LD_FRONTEND_DIR", "")).strip()
    or os.path.join(os.path.dirname(__file__), "frontend")
)
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")

# Print debug information on startup
print(f"Comfy Canvas Bridge Server starting...")
print(f"Frontend directory: {FRONTEND_DIR}")
print(f"Frontend directory exists: {os.path.exists(FRONTEND_DIR)}")

# Check if essential files exist
if os.path.exists(FRONTEND_DIR):
    essential_files = [
        "index.html",
        "styles.css",
        "main.js",
        os.path.join("assets", "icons", "sprite.svg"),
    ]
    for file in essential_files:
        file_path = os.path.join(FRONTEND_DIR, file)
        print(f"  {file}: {'Found' if os.path.exists(file_path) else 'Missing'}")

app = Flask(__name__, static_folder=None)
# Enable permissive CORS so ComfyUI web extension can access the bridge
CORS(app, resources={r"/*": {"origins": "*"}})

# If flask-cors is unavailable, add minimal CORS headers manually
if not _CORS_AVAILABLE:
    @app.after_request
    def _add_cors_headers(resp):
        try:
            resp.headers['Access-Control-Allow-Origin'] = '*'
            resp.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
            resp.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
        except Exception:
            pass
        return resp

    @app.route('/', methods=['OPTIONS'])
    def _root_options():
        return Response(status=204)

    @app.route('/<path:anypath>', methods=['OPTIONS'])
    def _any_options(anypath):
        return Response(status=204)
_lock = threading.Lock()
_latest_input_png = None
_latest_output_png = None
_latest_prompt_text = ""   # latest text prompt from frontend
_latest_negative_text = "" # latest negative prompt from frontend
_latest_strength = 1.0     # strength from frontend (0..1)
_latest_seed = 0           # seed from frontend (int >=0)
_latest_trigger_payload = None  # last known Comfy /prompt payload (from Comfy UI)
_generate_counter = 0     # increments on each /push/input
_debug_enabled = True if (
    os.environ.get("CC_DEBUG", os.environ.get("LD_DEBUG", "1")).strip() not in ("0", "false", "False")
) else False
_autorun_enabled = True if (os.environ.get("CC_AUTORUN", "1").strip() not in ("0","false","False")) else False

# ---- static frontend ----
@app.get("/")
def index():
    try:
        return send_from_directory(FRONTEND_DIR, "index.html")
    except Exception as e:
        print(f"Error serving index.html: {e}")
        return Response(f"Error serving index.html: {e}", status=500)

@app.get("/<path:path>")
def static_proxy(path):
    try:
        # Handle the root path
        if path == "" or path == "/":
            return send_from_directory(FRONTEND_DIR, "index.html")
        
        # Construct the full file path
        full_path = os.path.join(FRONTEND_DIR, path)
        
        # Security check: prevent directory traversal
        if not os.path.abspath(full_path).startswith(os.path.abspath(FRONTEND_DIR)):
            return Response("Forbidden", status=403)
        
        # Check if it's a directory
        if os.path.isdir(full_path):
            # Look for index.html in the directory
            index_file = os.path.join(full_path, "index.html")
            if os.path.exists(index_file):
                return send_from_directory(full_path, "index.html")
        
        # Check if the file exists
        if os.path.exists(full_path):
            # For SVG files, we need to set the correct MIME type
            if path.endswith('.svg'):
                return send_from_directory(FRONTEND_DIR, path, mimetype='image/svg+xml')
            # For other files, let Flask determine the MIME type
            return send_from_directory(FRONTEND_DIR, path)
        
        # If file not found, try to serve index.html for SPA routing
        index_file = os.path.join(FRONTEND_DIR, "index.html")
        if os.path.exists(index_file):
            return send_from_directory(FRONTEND_DIR, "index.html")
        
        # File not found
        return Response("Not found", status=404)
    except Exception as e:
        print(f"Error serving static file {path}: {e}")
        return Response(f"Error serving file: {e}", status=500)

# ---- bridge API ----
@app.get("/status")
def status():
    return jsonify({
        "ok": True,
        "frontend_dir": FRONTEND_DIR,
        "url": f"http://{HOST}:{PORT}/",
        "has_input": bool(_latest_input_png),
        "has_output": bool(_latest_output_png),
        "generate_counter": _generate_counter,
        "ts": time.time(),
    }), 200

@app.get("/open")
def open_hint():
    return jsonify({"url": f"http://{HOST}:{PORT}/"}), 200

@app.post("/push/input")
def push_input():
    global _latest_input_png, _latest_prompt_text, _latest_negative_text, _latest_strength, _latest_seed, _generate_counter
    try:
        if request.files.get("file"):
            _latest_input_png = request.files["file"].read()
            _latest_prompt_text = request.form.get("prompt", _latest_prompt_text)
            _latest_negative_text = request.form.get("negative", _latest_negative_text)
            # strength may come as form field
            try:
                if "strength" in request.form:
                    _latest_strength = max(0.0, min(1.0, float(request.form.get("strength", _latest_strength))))
            except Exception:
                pass
            # seed may come as form field
            try:
                if "seed" in request.form:
                    v = int(request.form.get("seed", _latest_seed) or 0)
                    if v < 0: v = 0
                    if v > 999_999_999_999_999: v = 999_999_999_999_999
                    _latest_seed = v
            except Exception:
                pass
        else:
            data = request.get_json(silent=True) or {}
            b64 = data.get("png_base64", "")
            if "," in b64:
                b64 = b64.split(",",1)[1]
            _latest_input_png = base64.b64decode(b64) if b64 else None
            if "prompt" in data and isinstance(data["prompt"], str):
                _latest_prompt_text = data["prompt"]
            if "negative" in data and isinstance(data["negative"], str):
                _latest_negative_text = data["negative"]
            try:
                if "strength" in data:
                    _latest_strength = max(0.0, min(1.0, float(data.get("strength", _latest_strength))))
            except Exception:
                pass
            try:
                if "seed" in data:
                    v = int(data.get("seed", _latest_seed) or 0)
                    if v < 0: v = 0
                    if v > 999_999_999_999_999: v = 999_999_999_999_999
                    _latest_seed = v
            except Exception:
                pass
    except Exception as e:
        print(f"/push/input error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 400
    if _latest_input_png:
        _generate_counter += 1
        if _debug_enabled:
            try:
                size_kb = round(len(_latest_input_png) / 1024.0, 1)
                print(f"[CC DEBUG] Received input PNG ~{size_kb} KB, prompt_len={len(_latest_prompt_text or '')}, counter={_generate_counter}")
            except Exception:
                pass
        # Optional autorun: if we have a stored /prompt payload, trigger Comfy server directly
        try:
            if _autorun_enabled and _latest_trigger_payload:
                def _fire():
                    try:
                        import requests as _rq
                        r = _rq.post(f"{COMFY_URL}/prompt", json=_latest_trigger_payload, timeout=12)
                        if _debug_enabled:
                            print(f"[CC DEBUG] Autorun trigger status={r.status_code}")
                    except Exception as _e:
                        print(f"[CC DEBUG] Autorun trigger failed: {_e}")
                threading.Thread(target=_fire, daemon=True).start()
        except Exception:
            pass
        return jsonify({"ok": True, "generate_counter": _generate_counter}), 200
    return jsonify({"ok": False}), 400

@app.get("/get/input")
def get_input():
    if _latest_input_png:
        return send_file(io.BytesIO(_latest_input_png), mimetype="image/png", as_attachment=False, download_name="input.png")
    return ("", 204)

@app.get("/get/prompt")
def get_prompt():
    if (_latest_prompt_text or _latest_negative_text) or (_latest_strength is not None) or (_latest_seed is not None):
        return jsonify({
            "prompt": _latest_prompt_text,
            "negative": _latest_negative_text,
            "strength": _latest_strength,
            "seed": _latest_seed,
        }), 200
    return ("", 204)

@app.post("/push/output")
def push_output():
    global _latest_output_png
    if request.files.get("file"):
        _latest_output_png = request.files["file"].read()
    else:
        data = request.get_json(silent=True) or {}
        b64 = data.get("png_base64", "")
        if "," in b64:
            b64 = b64.split(",",1)[1]
        _latest_output_png = base64.b64decode(b64) if b64 else None
    if _debug_enabled and _latest_output_png:
        try:
            size_kb = round(len(_latest_output_png) / 1024.0, 1)
            print(f"[CC DEBUG] Output image updated ~{size_kb} KB")
        except Exception:
            pass
    return (jsonify({"ok": True}), 200) if _latest_output_png else (jsonify({"ok": False}), 400)

@app.get("/get/output")
def get_output():
    if _latest_output_png:
        return send_file(io.BytesIO(_latest_output_png), mimetype="image/png", as_attachment=False, download_name="output.png")
    return ("", 204)

@app.post("/trigger")
def trigger():
    import requests
    try:
        data = request.get_json(silent=True) or {}
    except Exception:
        data = {}
    prompt = data.get("prompt") or _latest_trigger_payload
    if not prompt:
        return jsonify({"ok": False, "error": "missing prompt (and no stored payload)"}), 400
    try:
        r = requests.post(f"{COMFY_URL}/prompt", json=prompt, timeout=12)
        return (r.text, r.status_code, r.headers.items())
    except requests.RequestException as e:
        return jsonify({"ok": False, "error": f"request failed: {e}"}), 502

@app.post("/store/trigger")
def store_trigger():
    global _latest_trigger_payload
    try:
        data = request.get_json(force=True) or {}
    except Exception as e:
        return jsonify({"ok": False, "error": f"invalid JSON: {e}"}), 400
    payload = data.get("prompt")
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "missing or invalid 'prompt'"}), 400
    _latest_trigger_payload = payload
    if _debug_enabled:
        try:
            node_count = len((payload or {}).get("prompt", {}))
        except Exception:
            node_count = None
        print(f"[CC DEBUG] Stored trigger payload (nodes={node_count})")
    return jsonify({"ok": True}), 200

@app.post("/shutdown")
def shutdown():
    def _kill_self():
        time.sleep(0.1)
        os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=_kill_self, daemon=True).start()
    return jsonify({"ok": True}), 200

# ---- debug hooks ----
@app.post("/debug/event")
def debug_event():
    if not _debug_enabled:
        return jsonify({"ok": True, "ignored": True}), 200
    try:
        data = request.get_json(silent=True) or {}
    except Exception:
        data = {"raw": True}
    ts = time.strftime("%H:%M:%S")
    etype = data.get("type", "event")
    try:
        print(f"[CC DEBUG {ts}] {etype}: {data}")
    except Exception:
        print(f"[CC DEBUG {ts}] {etype} (unprintable)")
    return jsonify({"ok": True}), 200

if __name__ == "__main__":
    try:
        print(f"Starting Comfy Canvas Bridge Server...")
        print(f"Frontend directory: {FRONTEND_DIR}")
        print(f"Serving on: http://{HOST}:{PORT}/")
        app.run(host=HOST, port=PORT, debug=False)
    except Exception as e:
        print(f"Failed to start server: {e}")
        import traceback
        traceback.print_exc()
