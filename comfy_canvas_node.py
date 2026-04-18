from __future__ import annotations

from comfy_api.latest import ComfyExtension, io

from .comfy_canvas_session import (
    blank_document,
    normalize_session_id,
    pil_to_image_tensor,
    pil_to_mask_tensor,
    read_session_image,
    read_session_mask,
    read_session_prompt,
    result_signature,
    save_result_tensor,
    seed_session_from_tensor,
    session_signature,
    tensor_signature,
    tensor_to_pil_image,
)


def _resolve_session_id(session_id: str) -> str:
    if not session_id:
        return ""
    return normalize_session_id(session_id)


class ComfyCanvasNode(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="ComfyCanvasEditor",
            display_name="Comfy Canvas",
            description="Open the Comfy Canvas overlay and output the saved image, mask, session id, and latest dock prompt for the current session.",
            category="Comfy Canvas",
            search_aliases=["comfy canvas", "canvas", "paint", "mask"],
            inputs=[
                io.String.Input("session_id", default="", multiline=False),
                io.Int.Input("canvas_width", default=1024, min=64, max=4096, step=8),
                io.Int.Input("canvas_height", default=1024, min=64, max=4096, step=8),
                io.Combo.Input("background", options=["transparent", "white"], default="transparent"),
                io.Image.Input("image", optional=True),
            ],
            outputs=[
                io.Image.Output(display_name="image"),
                io.Mask.Output(display_name="mask"),
                io.String.Output(display_name="session_id"),
                io.String.Output(display_name="prompt"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, session_id, canvas_width, canvas_height, background, image=None):
        resolved_session_id = _resolve_session_id(session_id) if session_id else ""
        image_fingerprint = tensor_signature(image)
        session_fingerprint = session_signature(resolved_session_id) if resolved_session_id else "missing"
        return f"{canvas_width}x{canvas_height}:{background}:{session_fingerprint}:{image_fingerprint}"

    @classmethod
    def execute(cls, session_id, canvas_width, canvas_height, background, image=None) -> io.NodeOutput:
        resolved_session_id = _resolve_session_id(session_id) if session_id else ""
        edited = read_session_image(resolved_session_id) if resolved_session_id else None
        prompt_text = read_session_prompt(resolved_session_id) if resolved_session_id else ""

        if edited is not None:
            result_image = edited
            result_mask = read_session_mask(resolved_session_id)
        elif image is not None:
            if resolved_session_id:
                seed_session_from_tensor(resolved_session_id, image)
            result_image = tensor_to_pil_image(image)
            result_mask = None
        else:
            result_image = blank_document(canvas_width, canvas_height, background)
            result_mask = None

        image_tensor = pil_to_image_tensor(result_image)
        mask_tensor = pil_to_mask_tensor(result_mask or result_image, result_image.size)
        return io.NodeOutput(image_tensor, mask_tensor, resolved_session_id, prompt_text)


class ComfyCanvasOutputNode(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="ComfyCanvasOutput",
            display_name="Comfy Canvas Output",
            description="Store a workflow result image in the Comfy Canvas session so the popup can display it on the output side.",
            category="Comfy Canvas",
            search_aliases=["comfy canvas output", "canvas output", "session result", "ai output"],
            not_idempotent=True,
            is_output_node=True,
            inputs=[
                io.Image.Input("image"),
                io.String.Input("session_id", default="", multiline=False),
            ],
            outputs=[
                io.Image.Output(display_name="image"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, image, session_id=""):
        resolved_session_id = _resolve_session_id(session_id) if session_id else ""
        result_fingerprint = result_signature(resolved_session_id) if resolved_session_id else "missing"
        return f"{tensor_signature(image)}:{resolved_session_id}:{result_fingerprint}"

    @classmethod
    def execute(cls, image, session_id="") -> io.NodeOutput:
        resolved_session_id = _resolve_session_id(session_id) if session_id else ""
        if resolved_session_id:
            save_result_tensor(resolved_session_id, image)
        return io.NodeOutput(image)


class ComfyCanvasExtension(ComfyExtension):
    async def on_load(self) -> None:
        try:
            from .comfy_canvas_routes import register_routes

            register_routes()
        except Exception as exc:
            print(f"[Comfy Canvas] route registration skipped: {exc}")

    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [ComfyCanvasNode, ComfyCanvasOutputNode]


async def comfy_entrypoint() -> ComfyCanvasExtension:
    return ComfyCanvasExtension()
