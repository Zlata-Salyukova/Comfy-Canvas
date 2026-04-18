from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Optional, Tuple

if TYPE_CHECKING:
    import torch
    from PIL import Image

PACKAGE_ROOT = Path(__file__).resolve().parent
LEGACY_SESSION_ROOT = PACKAGE_ROOT / "data" / "sessions"
_SESSION_ROOT: Optional[Path] = None

_LOCK = threading.RLock()


def _get_pil_image():
    from PIL import Image

    return Image


def _get_array_runtime():
    import numpy as np
    import torch

    return np, torch


def normalize_session_id(session_id: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_.-]", "_", (session_id or "").strip())
    normalized = normalized[:128]
    if not normalized:
        raise ValueError("session_id is required")
    return normalized


def _get_session_root() -> Path:
    global _SESSION_ROOT
    if _SESSION_ROOT is not None:
        return _SESSION_ROOT

    try:
        import folder_paths

        root = Path(folder_paths.get_system_user_directory("comfy_canvas")) / "sessions"
    except Exception:
        root = Path.home() / ".comfy_canvas" / "sessions"

    root.mkdir(parents=True, exist_ok=True)
    _SESSION_ROOT = root
    return root


def _migrate_legacy_session_dir(normalized_session_id: str, session_dir: Path) -> None:
    legacy_dir = LEGACY_SESSION_ROOT / normalized_session_id
    if session_dir.exists() or not legacy_dir.exists():
        return

    session_dir.parent.mkdir(parents=True, exist_ok=True)
    with _LOCK:
        if session_dir.exists() or not legacy_dir.exists():
            return
        shutil.move(str(legacy_dir), str(session_dir))


def get_session_dir(session_id: str) -> Path:
    normalized = normalize_session_id(session_id)
    session_dir = _get_session_root() / normalized
    _migrate_legacy_session_dir(normalized, session_dir)
    return session_dir


def _edited_path(session_id: str) -> Path:
    return get_session_dir(session_id) / "edited.png"


def _seed_path(session_id: str) -> Path:
    return get_session_dir(session_id) / "seed.png"


def _mask_path(session_id: str) -> Path:
    return get_session_dir(session_id) / "mask.png"


def _result_path(session_id: str) -> Path:
    return get_session_dir(session_id) / "result.png"


def _metadata_path(session_id: str) -> Path:
    return get_session_dir(session_id) / "metadata.json"


def _document_path(session_id: str) -> Path:
    return get_session_dir(session_id) / "document.json"


def _document_layers_dir(session_id: str) -> Path:
    return get_session_dir(session_id) / "layers"


def _decode_data_url(data_url: str) -> bytes:
    if not data_url or "," not in data_url:
        raise ValueError("invalid data URL")
    _, payload = data_url.split(",", 1)
    return base64.b64decode(payload)


def _write_metadata(path: Path, metadata: dict) -> None:
    path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")


def _read_metadata(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _clamp_opacity(value) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 1.0


def _safe_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _encode_file_data_url(path: Path, mime_type: str = "image/png") -> str:
    payload = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{payload}"


def _save_document_payload(session_id: str, document: dict) -> dict:
    Image = _get_pil_image()
    if not isinstance(document, dict):
        raise ValueError("invalid document payload")

    normalized = normalize_session_id(session_id)
    size = document.get("size") if isinstance(document.get("size"), dict) else {}
    width = _safe_int(size.get("width"), _safe_int(document.get("width"), 0))
    height = _safe_int(size.get("height"), _safe_int(document.get("height"), 0))
    layers = document.get("layers")

    if not isinstance(layers, list):
        raise ValueError("document.layers must be a list")

    layers_dir = _document_layers_dir(normalized)
    shutil.rmtree(layers_dir, ignore_errors=True)
    layers_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "version": _safe_int(document.get("version"), 1),
        "size": {
            "width": width,
            "height": height,
        },
        "activeLayerIndex": _safe_int(document.get("activeLayerIndex"), max(len(layers) - 1, 0)),
        "promptText": str(document.get("promptText") or ""),
        "uiState": document.get("uiState") if isinstance(document.get("uiState"), dict) else {},
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "layers": [],
    }

    for index, layer in enumerate(layers):
        if not isinstance(layer, dict):
            raise ValueError(f"document layer {index} is invalid")

        image_data_url = layer.get("imageDataUrl")
        if not image_data_url:
            raise ValueError(f"document layer {index} is missing imageDataUrl")

        image = Image.open(io.BytesIO(_decode_data_url(image_data_url))).convert("RGBA")
        layer_filename = f"layer_{index:04d}.png"
        image.save(layers_dir / layer_filename)

        mask_filename = None
        mask_data_url = layer.get("maskImageDataUrl")
        if mask_data_url:
            mask = Image.open(io.BytesIO(_decode_data_url(mask_data_url))).convert("RGBA")
            mask_filename = f"layer_mask_{index:04d}.png"
            mask.save(layers_dir / mask_filename)

        manifest["layers"].append(
            {
                "name": str(layer.get("name") or f"Layer {index + 1}"),
                "type": str(layer.get("type") or "paint"),
                "textData": layer.get("textData") if isinstance(layer.get("textData"), dict) else None,
                "opacity": _clamp_opacity(layer.get("opacity", 1.0)),
                "visible": bool(layer.get("visible", True)),
                "locked": bool(layer.get("locked", False)),
                "blendMode": str(layer.get("blendMode") or "normal"),
                "hasMask": bool(layer.get("hasMask", False) or mask_filename),
                "maskEnabled": bool(layer.get("maskEnabled", True)),
                "image": layer_filename,
                "mask": mask_filename,
            }
        )

    _write_metadata(_document_path(normalized), manifest)
    return manifest


def read_session_document(session_id: str) -> Optional[dict]:
    normalized = normalize_session_id(session_id)
    manifest = _read_metadata(_document_path(normalized))
    if not manifest:
        return None

    layers = manifest.get("layers")
    if not isinstance(layers, list):
        return None

    document_layers = []
    for layer in layers:
        if not isinstance(layer, dict):
            continue

        layer_filename = layer.get("image")
        if not layer_filename:
            continue

        layer_path = _document_layers_dir(normalized) / layer_filename
        if not layer_path.exists():
            continue

        document_layers.append(
            {
                "name": str(layer.get("name") or "Layer"),
                "type": str(layer.get("type") or "paint"),
                "textData": layer.get("textData") if isinstance(layer.get("textData"), dict) else None,
                "opacity": _clamp_opacity(layer.get("opacity", 1.0)),
                "visible": bool(layer.get("visible", True)),
                "locked": bool(layer.get("locked", False)),
                "blendMode": str(layer.get("blendMode") or "normal"),
                "imageDataUrl": _encode_file_data_url(layer_path),
                "hasMask": bool(layer.get("hasMask", False)),
                "maskEnabled": bool(layer.get("maskEnabled", True)),
                "maskImageDataUrl": None,
            }
        )

        mask_filename = layer.get("mask")
        if mask_filename:
            mask_path = _document_layers_dir(normalized) / mask_filename
            if mask_path.exists():
                document_layers[-1]["maskImageDataUrl"] = _encode_file_data_url(mask_path)
                document_layers[-1]["hasMask"] = True

    size = manifest.get("size") if isinstance(manifest.get("size"), dict) else {}
    return {
        "version": _safe_int(manifest.get("version"), 1),
        "size": {
            "width": _safe_int(size.get("width"), 0),
            "height": _safe_int(size.get("height"), 0),
        },
        "activeLayerIndex": _safe_int(manifest.get("activeLayerIndex"), max(len(document_layers) - 1, 0)),
        "promptText": str(manifest.get("promptText") or ""),
        "uiState": manifest.get("uiState") if isinstance(manifest.get("uiState"), dict) else {},
        "saved_at": manifest.get("saved_at"),
        "layers": document_layers,
    }


def read_session_prompt(session_id: str) -> str:
    normalized = normalize_session_id(session_id)
    manifest = _read_metadata(_document_path(normalized))
    if not manifest:
        return ""
    return str(manifest.get("promptText") or "")


def get_session_state(session_id: str) -> dict:
    session_dir = get_session_dir(session_id)
    edited_path = _edited_path(session_id)
    seed_path = _seed_path(session_id)
    mask_path = _mask_path(session_id)
    result_path = _result_path(session_id)
    metadata_path = _metadata_path(session_id)
    document_path = _document_path(session_id)
    document_layers_dir = _document_layers_dir(session_id)
    preview_path = edited_path if edited_path.exists() else seed_path if seed_path.exists() else None
    return {
        "session_id": normalize_session_id(session_id),
        "session_dir": session_dir,
        "edited_path": edited_path,
        "seed_path": seed_path,
        "mask_path": mask_path,
        "result_path": result_path,
        "metadata_path": metadata_path,
        "document_path": document_path,
        "document_layers_dir": document_layers_dir,
        "metadata": _read_metadata(metadata_path),
        "edited_exists": edited_path.exists(),
        "seed_exists": seed_path.exists(),
        "mask_exists": mask_path.exists(),
        "result_exists": result_path.exists(),
        "document_exists": document_path.exists(),
        "preview_path": preview_path,
        "exists": preview_path is not None or document_path.exists(),
    }


def save_session_payload(
    session_id: str,
    image_data_url: str,
    mask_data_url: Optional[str] = None,
    metadata: Optional[dict] = None,
    document: Optional[dict] = None,
) -> dict:
    Image = _get_pil_image()
    normalized = normalize_session_id(session_id)
    session_dir = get_session_dir(normalized)
    session_dir.mkdir(parents=True, exist_ok=True)

    image_bytes = _decode_data_url(image_data_url)
    mask_bytes = _decode_data_url(mask_data_url) if mask_data_url else None

    with _LOCK:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
        image.save(_edited_path(normalized))

        mask_path = _mask_path(normalized)
        if mask_bytes is not None:
            mask = Image.open(io.BytesIO(mask_bytes)).convert("L")
            mask.save(mask_path)
        elif mask_path.exists():
            mask_path.unlink()

        payload = {
            "session_id": normalized,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "width": image.width,
            "height": image.height,
            "has_mask": mask_bytes is not None,
        }
        if metadata:
            payload.update(metadata)

        if document is not None:
            document_manifest = _save_document_payload(normalized, document)
            payload.update(
                {
                    "document_exists": True,
                    "document_layer_count": len(document_manifest.get("layers", [])),
                    "document_updated_at": document_manifest.get("saved_at"),
                }
            )

        _write_metadata(_metadata_path(normalized), payload)

    return payload


def clear_session(session_id: str) -> None:
    state = get_session_state(session_id)
    with _LOCK:
        shutil.rmtree(state["session_dir"], ignore_errors=True)


def read_session_image(session_id: str) -> Optional[Image.Image]:
    Image = _get_pil_image()
    state = get_session_state(session_id)
    if not state["edited_exists"]:
        return None
    return Image.open(state["edited_path"]).convert("RGBA")


def read_session_mask(session_id: str) -> Optional[Image.Image]:
    Image = _get_pil_image()
    state = get_session_state(session_id)
    if not state["mask_exists"]:
        return None
    return Image.open(state["mask_path"]).convert("L")


def session_signature(session_id: str) -> str:
    try:
        state = get_session_state(session_id)
    except ValueError:
        return "missing"

    parts = []
    for key in ("edited_path", "seed_path", "mask_path", "document_path"):
        path = state[key]
        if path.exists():
            stat = path.stat()
            parts.append(f"{path.name}:{stat.st_mtime_ns}:{stat.st_size}")
    return "|".join(parts) if parts else "empty"


def result_signature(session_id: str) -> str:
    try:
        state = get_session_state(session_id)
    except ValueError:
        return "missing"

    path = state["result_path"]
    if not path.exists():
        return "empty"

    stat = path.stat()
    return f"{path.name}:{stat.st_mtime_ns}:{stat.st_size}"


def tensor_signature(image_tensor: Optional["torch.Tensor"]) -> str:
    if image_tensor is None:
        return "none"

    image = tensor_to_pil_image(image_tensor).convert("RGB")
    preview = image.resize((32, 32))
    digest = hashlib.sha1(preview.tobytes()).hexdigest()
    return f"{image.width}x{image.height}:{digest}"


def tensor_to_pil_image(image_tensor: "torch.Tensor") -> "Image.Image":
    np, _torch = _get_array_runtime()
    Image = _get_pil_image()
    tensor = image_tensor.detach().cpu()
    if tensor.ndim == 4:
        tensor = tensor[0]
    tensor = tensor.clamp(0, 1)
    if tensor.shape[-1] == 1:
        tensor = tensor.repeat(1, 1, 3)
    image = (tensor.numpy() * 255.0).round().astype(np.uint8)
    return Image.fromarray(image, mode="RGB").convert("RGBA")


def pil_to_image_tensor(image: "Image.Image"):
    np, torch = _get_array_runtime()
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(rgb)[None, ...]


def pil_to_mask_tensor(image: Optional["Image.Image"], fallback_size: Tuple[int, int]):
    np, torch = _get_array_runtime()
    if image is None:
        width, height = fallback_size
        return torch.zeros((height, width), dtype=torch.float32)

    if image.mode == "L":
        mask = np.asarray(image, dtype=np.float32) / 255.0
        return torch.from_numpy(mask)

    rgba = image.convert("RGBA")
    alpha = np.asarray(rgba.getchannel("A"), dtype=np.float32) / 255.0
    return torch.from_numpy(1.0 - alpha)


def blank_document(width: int, height: int, background: str) -> "Image.Image":
    Image = _get_pil_image()
    if background == "white":
        return Image.new("RGBA", (width, height), (255, 255, 255, 255))
    return Image.new("RGBA", (width, height), (0, 0, 0, 0))


def save_result_tensor(session_id: str, image_tensor: Optional["torch.Tensor"]) -> None:
    if image_tensor is None:
        return

    normalized = normalize_session_id(session_id)
    session_dir = get_session_dir(normalized)
    session_dir.mkdir(parents=True, exist_ok=True)

    image = tensor_to_pil_image(image_tensor)
    with _LOCK:
        image.save(_result_path(normalized))
        metadata = _read_metadata(_metadata_path(normalized))
        metadata.update(
            {
                "session_id": normalized,
                "result_width": image.width,
                "result_height": image.height,
                "result_updated_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        _write_metadata(_metadata_path(normalized), metadata)


def seed_session_from_tensor(session_id: str, image_tensor: Optional["torch.Tensor"]) -> None:
    if image_tensor is None:
        return

    normalized = normalize_session_id(session_id)
    session_dir = get_session_dir(normalized)
    session_dir.mkdir(parents=True, exist_ok=True)

    image = tensor_to_pil_image(image_tensor)
    with _LOCK:
        image.save(_seed_path(normalized))
        metadata = _read_metadata(_metadata_path(normalized))
        metadata.update(
            {
                "session_id": normalized,
                "seed_width": image.width,
                "seed_height": image.height,
                "seed_updated_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        _write_metadata(_metadata_path(normalized), metadata)
