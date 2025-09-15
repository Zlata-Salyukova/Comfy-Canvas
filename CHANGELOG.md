# Changelog

All notable version changes to Comfy Canvas will be documented in this file.

---

## Version [0.1.0] - 2025-09-15
### Added
- First public beta release
- Two ComfyUI nodes:
  - Comfy Canvas – Edit: outputs (IMAGE, prompt, negative, strength, seed)
  - Comfy Canvas – Output: streams resulting IMAGE back to the frontend
- Bridge server (`cc_bridge_server.py`) with lightweight HTTP API to serve the SPA and move data between browser and ComfyUI
- Frontend SPA (PIXI.js) multi‑layer editor: brush, eraser, lasso, selection, blend modes, opacity, upload, undo/redo
- New options in prompt bar: Negative prompt textarea and Seed input (0..999999999999999)
- Autorun support: bridge can POST stored `/prompt` payload to ComfyUI when Generate is clicked (even if ComfyUI tab is backgrounded)
- New endpoints: `POST /store/trigger` (store graph payload), `POST /trigger` (forward to ComfyUI), `POST /shutdown`
- README with quick start, venv instructions, and troubleshooting; MIT LICENSE; project `.gitignore`

### Changed
- Rebranded project and nodes to “Comfy Canvas”; folder and module naming aligned
- Environment variables standardized to `CC_*` (fallback to legacy `LD_*` remains)
- Output artboard auto‑resizes to match generated image; editor resize keeps both panes in sync
- Sidebar extension: bridge origin override via `cc_bridge_origin`; includes `client_id` when POSTing to `/prompt`; broader Run/Queue button fallback

### Fixed
- Generate not reliably triggering Run in ComfyUI (origin + client_id + extra fallbacks)
- Background tab throttling (autorun now handled by bridge so runs continue with ComfyUI tab inactive)
- Canvas visibility issues after performance tweaks (ensure PIXI ticker active on init)

### Known Issues
- Layer panel: after uploading an image while the Move tool is active, the preview may not update until creating a new layer. Workaround: switch tools or add a new layer after upload.

---
