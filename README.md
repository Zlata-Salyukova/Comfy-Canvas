# Comfy Canvas (ComfyUI Custom Nodes)

Comfy Canvas is a modern, multi‑layer web canvas that bridges to ComfyUI via a lightweight Flask server. It ships two nodes to move images and text between your browser and a running ComfyUI workflow.

---

## Features

- Fast, multi‑layer editor (PIXI.js) with brush, eraser, lasso, selection, blend modes, opacity, upload, and undo/redo
- Live input: send canvas + prompt/negative/strength/seed to ComfyUI
- Live output: stream result images back into the UI
- Auto‑run (optional): bridge triggers Comfy’s `/prompt` even if the ComfyUI tab is backgrounded
- Robust ComfyUI integration: auto‑queue via UI API or direct `/prompt` with `client_id`

---

## Node Overview

- Comfy Canvas – Edit (input node)
  - Outputs (IMAGE, STRING, STRING, FLOAT, INT)
    - IMAGE: painted canvas
    - STRING: prompt text
    - STRING: negative prompt text
    - FLOAT: strength (0..1, e.g., use as denoise strength)
    - INT: seed (0..999999999999999)

- Comfy Canvas – Output (output node)
  - Accepts an IMAGE and streams it back to the frontend for display

---

## Installation

Prerequisites
- ComfyUI installed and running
- Python 3.10+

Install
- Place this folder at:
  - Windows: `<ComfyUI root>\comfyui\custom_nodes\comfy_canvas`
  - Linux/macOS: `<ComfyUI root>/comfyui/custom_nodes/comfy_canvas`
- Install dependencies:
  ```bash
  cd <ComfyUI root>/comfyui/custom_nodes/comfy_canvas
  pip install -r requirements.txt
  ```

---

## Quick Start

1) Start ComfyUI normally.
2) Start the Comfy Canvas bridge (separate terminal):
   - Windows (PowerShell):
     ```powershell
     cd <ComfyUI root>\comfyui\custom_nodes\comfy_canvas
     python cc_bridge_server.py
     ```
   - Linux/macOS:
     ```bash
     cd <ComfyUI root>/comfyui/custom_nodes/comfy_canvas
     python3 cc_bridge_server.py
     ```
   - Bridge serves the UI at `http://127.0.0.1:8765/` (configurable)
3) In ComfyUI, add nodes:
   - “Comfy Canvas – Edit”: wire `IMAGE` to your pipeline input (e.g., VAE encode)
   - Wire `prompt` to `CLIPTextEncode.text` and `negative` to your negative text input
   - Wire `seed` to your sampler seed; `strength` to a denoise/strength input (as desired)
   - “Comfy Canvas – Output”: wire final `IMAGE` to stream result back
4) Open the frontend: `http://127.0.0.1:8765/`
   - Paint on the left canvas, type a prompt, click Generate

Tip: The Edit node’s right‑panel shows bridge status and can open the frontend.

---

## Configuration

Environment variables (set before starting the bridge):
- `CC_BRIDGE_PORT` — TCP port for the bridge (default: 8765)
- `CC_BRIDGE_HOST` — Host Comfy nodes use to reach the bridge (default: 127.0.0.1)
- `CC_FRONTEND_DIR` — Override path to the `frontend` folder (default: bundled)
- `COMFY_URL` — URL to the ComfyUI server (default: http://127.0.0.1:8188)
- `CC_AUTORUN` — If “1” (default), auto‑trigger Comfy on Generate using a stored graph payload
- `CC_DEBUG` — Enable verbose bridge logging when not “0/false” (default: on)

Legacy env vars (still supported): `LD_BRIDGE_PORT`, `LD_BRIDGE_HOST`, `LD_FRONTEND_DIR`, `LD_DEBUG`.

---

## HTTP Endpoints (Bridge)

- `GET /status` — `{ ok, frontend_dir, url, has_input, has_output, generate_counter, ts }`
- `POST /push/input` — multipart form (`file`=PNG, `prompt`, `negative`, `strength`, `seed`) or JSON `{ png_base64, prompt, negative, strength, seed }`
- `GET /get/input` — image/png of last input (204 if none)
- `GET /get/prompt` — `{ prompt, negative, strength, seed }` (204 if none)
- `POST /push/output` — multipart form `file` or JSON `{ png_base64 }`
- `GET /get/output` — image/png of last output (204 if none)
- `POST /store/trigger` — `{ prompt: { prompt: <graphNodes>, client_id?: <id> } }` (stores payload for autorun)
- `POST /trigger` — `{ prompt }` (or uses stored payload) → forwards to `${COMFY_URL}/prompt`

Quick test:
```bash
curl http://127.0.0.1:8765/status
```

---

## Notes & Tips

- Auto‑run: The ComfyUI sidebar extension publishes your current graph to the bridge; the bridge can then POST `/prompt` after a Generate, even if the ComfyUI tab is backgrounded.
- Bridge origin override in ComfyUI: in browser console, you can set the bridge URL if you changed the port/host:
  ```js
  localStorage.setItem('cc_bridge_origin', 'http://127.0.0.1:8765')
  location.reload()
  ```

---

## Troubleshooting

- Bridge shows offline in the node panel
  - Ensure it’s running on the expected port; confirm `/status` is reachable
- Frontend doesn’t open or icons missing
  - Check bridge logs for the resolved `frontend` directory
- Generate doesn’t queue a run
  - Ensure the “Comfy Canvas – Edit” panel was loaded at least once (so the graph payload is stored)
  - Set `cc_bridge_origin` in ComfyUI localStorage if you changed the bridge URL
  - Check bridge logs for “Stored trigger payload” and “Autorun trigger status=200”
- Output doesn’t appear
  - Verify your pipeline wires the final image into “Comfy Canvas – Output”
  - Confirm `/get/output` returns 200 after a run

---

## License

MIT or project’s default — add your preferred license here.

