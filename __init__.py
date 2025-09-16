# ComfyUI/custom_nodes/comfy_canvas (__init__.py)

# Import underlying nodes, then expose class/display mappings
from . import nodes as _nodes

NODE_CLASS_MAPPINGS = dict(getattr(_nodes, "NODE_CLASS_MAPPINGS", {}))
NODE_DISPLAY_NAME_MAPPINGS = dict(getattr(_nodes, "NODE_DISPLAY_NAME_MAPPINGS", {}))

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

# Register web extension directory so ComfyUI serves our panel JS under /extensions
WEB_DIRECTORY = "./web"
