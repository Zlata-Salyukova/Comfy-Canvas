# ComfyUI/custom_nodes/comfy_canvas (__init__.py)

# Import underlying nodes, then normalize display names to avoid encoding issues
from . import nodes as _nodes

# Pass through class mappings
NODE_CLASS_MAPPINGS = _nodes.NODE_CLASS_MAPPINGS

# Normalize display names (ASCII only)
NODE_DISPLAY_NAME_MAPPINGS = dict(getattr(_nodes, "NODE_DISPLAY_NAME_MAPPINGS", {}))
NODE_DISPLAY_NAME_MAPPINGS.update({
    "LD_Edit": "Comfy Canvas - Edit",
    "LD_Output": "Comfy Canvas - Output",
})

# Re-export so ComfyUI can see them
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

# Register web extension directory so ComfyUI serves our panel JS under /extensions
# This enables the Comfy Canvas LD_Edit sidebar UI and auto-queue behavior.
WEB_DIRECTORY = "./web"

