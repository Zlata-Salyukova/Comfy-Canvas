# ComfyUI/custom_nodes/comfy_canvas/nodes.py
import os, time, io
import requests
from PIL import Image
import torch, numpy as np

PLUGIN_DIR   = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(PLUGIN_DIR, "frontend")
# Prefer CC_* env vars, fallback to legacy LD_* for compatibility
BRIDGE_HOST  = os.environ.get("CC_BRIDGE_HOST", os.environ.get("LD_BRIDGE_HOST", "127.0.0.1"))
BRIDGE_PORT  = int(os.environ.get("CC_BRIDGE_PORT", os.environ.get("LD_BRIDGE_PORT", "8765")))
BRIDGE_URL   = f"http://{BRIDGE_HOST}:{BRIDGE_PORT}"

# ---- server lifecycle ----
# Manual startup: the bridge server should be started separately

def _server_up(timeout=0.6):
    try:
        r = requests.get(f"{BRIDGE_URL}/status", timeout=timeout)
        return r.ok
    except Exception:
        return False

def _start_server():
    """Server should be started manually in a separate terminal"""
    if _server_up():
        return True
    else:
        print(f"WARNING: Comfy Canvas server not running at {BRIDGE_URL}")
        print("Please start the server manually with: python cc_bridge_server.py (from the comfy_canvas folder)")
        return False

def _stop_server():
    """Server shutdown should be done manually"""
    pass

# ---- tensor <-> PIL ----
def _tensor_from_pil(img: Image.Image) -> torch.Tensor:
    arr = np.array(img.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]  # [1,H,W,3]

def _pil_from_tensor(t: torch.Tensor) -> Image.Image:
    if t.dim() == 4:
        t = t[0]
    arr = (t.clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
    return Image.fromarray(arr, "RGB")

# ---- Node 1: Comfy Canvas - Edit ----
class LD_Edit:
    """Outputs latest editor canvas, prompt text, negative prompt, strength, and seed from the frontend.
       UI (web/ld_panel.js) shows preview, status, and URL.
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "wait_for_image": ("BOOLEAN", {"default": True}),
                "timeout_sec": ("INT", {"default": 3, "min": 0, "max": 120}),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING", "FLOAT", "INT")
    RETURN_NAMES = ("image", "prompt", "negative", "strength", "seed")
    FUNCTION = "pull_image_and_prompt"
    CATEGORY = "ComfyCanvas"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float(time.time())

    def pull_image_and_prompt(self, wait_for_image, timeout_sec):
        # Server must be started manually; we only read from it

        deadline = time.time() + float(timeout_sec)
        img_tensor = None
        while True:
            try:
                r = requests.get(f"{BRIDGE_URL}/get/input", timeout=1.5)
                if r.status_code == 200 and r.headers.get("Content-Type", "").startswith("image/"):
                    img = Image.open(io.BytesIO(r.content)).convert("RGB")
                    img_tensor = _tensor_from_pil(img)
                    break
                if not wait_for_image:
                    break
            except Exception as e:
                print(f"Error getting input: {e}")
                if not wait_for_image:
                    break
            if time.time() > deadline:
                break
            time.sleep(0.12)

        if img_tensor is None:
            img = Image.new("RGB", (1024, 1024), (255, 255, 255))
            img_tensor = _tensor_from_pil(img)

        prompt_txt = ""
        negative_txt = ""
        strength_val = 1.0
        seed_val = 0
        try:
            rp = requests.get(f"{BRIDGE_URL}/get/prompt", timeout=0.8)
            if rp.status_code == 200:
                data = rp.json() or {}
                prompt_txt = data.get("prompt", "")
                negative_txt = data.get("negative", "")
                try:
                    s = float(data.get("strength", strength_val))
                    if np.isfinite(s):
                        strength_val = max(0.0, min(1.0, s))
                except Exception:
                    pass
                try:
                    seed_v = int(data.get("seed", seed_val))
                    if seed_v < 0:
                        seed_v = 0
                    seed_val = seed_v
                except Exception:
                    pass
        except Exception as e:
            print(f"Error getting prompt: {e}")

        return (img_tensor, prompt_txt, negative_txt, float(strength_val), int(seed_val))

# ---- Node 2: Comfy Canvas - Output ----
class LD_Output:
    """Push a Comfy IMAGE to the built-in frontend for display."""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "open_frontend": ("BOOLEAN", {"default": False}),
            }
        }
    RETURN_TYPES = ()
    FUNCTION = "push_image"
    OUTPUT_NODE = True
    CATEGORY = "ComfyCanvas"

    def push_image(self, image, open_frontend):
        img = _pil_from_tensor(image)
        buf = io.BytesIO(); img.save(buf, format="PNG")
        try:
            requests.post(
                f"{BRIDGE_URL}/push/output",
                files={"file": ("result.png", buf.getvalue(), "image/png")},
                timeout=3,
            )
            if open_frontend:
                try:
                    import webbrowser
                    webbrowser.open(f"{BRIDGE_URL}/")
                except Exception:
                    pass
        except Exception as e:
            print(f"Error pushing output: {e}")
        return ()

NODE_CLASS_MAPPINGS = {
    "LD_Edit": LD_Edit,
    "LD_Output": LD_Output,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "LD_Edit": "Comfy Canvas - Edit",
    "LD_Output": "Comfy Canvas - Output",
}
