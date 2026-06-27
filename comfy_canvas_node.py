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
            # 當偵測到節點輸入的寬高與現存快取圖片不符時，執行深度的硬碟實體檔案同步
            if edited.width != canvas_width or edited.height != canvas_height:
                from .comfy_canvas_session import get_session_state, _read_metadata, _write_metadata
                from PIL import Image
                
                # 取得該 Session 的所有硬碟實體路徑
                state = get_session_state(resolved_session_id)
                
                # 1. 縮放主圖片並強制覆寫回硬碟的 edited.png
                edited = edited.resize((canvas_width, canvas_height))
                edited.save(state["edited_path"])
                
                # 2. 縮放主遮罩並強制覆寫回硬碟的 mask.png
                result_mask = read_session_mask(resolved_session_id)
                if result_mask is not None:
                    result_mask = result_mask.resize((canvas_width, canvas_height))
                    result_mask.save(state["mask_path"])
                
                # 3. 更新 metadata.json 內的尺寸紀錄
                meta = _read_metadata(state["metadata_path"])
                if isinstance(meta, dict):
                    meta["width"] = canvas_width
                    meta["height"] = canvas_height
                    _write_metadata(state["metadata_path"], meta)
                
                # 4. 更新 document.json (這步能徹底改變網頁前端的畫布可畫範圍與下方顯示的數字)
                doc = _read_metadata(state["document_path"])
                if isinstance(doc, dict):
                    if "size" in doc and isinstance(doc["size"], dict):
                        doc["size"]["width"] = canvas_width
                        doc["size"]["height"] = canvas_height
                    doc["width"] = canvas_width
                    doc["height"] = canvas_height
                    
                    # 5. 同步縮放 layers 資料夾內所有歷史圖層的實體 png 檔案，防止前端載入時畫面與畫布錯位
                    layers_dir = state["document_layers_dir"]
                    if "layers" in doc and isinstance(doc["layers"], list) and layers_dir.exists():
                        for layer_item in doc["layers"]:
                            if isinstance(layer_item, dict):
                                img_name = layer_item.get("image")
                                if img_name:
                                    img_p = layers_dir / img_name
                                    if img_p.exists():
                                        try:
                                            with Image.open(img_p) as limg:
                                                limg.resize((canvas_width, canvas_height)).save(img_p)
                                        except Exception:
                                            pass
                                mask_name = layer_item.get("mask")
                                if mask_name:
                                    msk_p = layers_dir / mask_name
                                    if msk_p.exists():
                                        try:
                                            with Image.open(msk_p) as lmsk:
                                                lmsk.resize((canvas_width, canvas_height)).save(msk_p)
                                        except Exception:
                                            pass
                    _write_metadata(state["document_path"], doc)
                
                result_image = edited
                result_mask = read_session_mask(resolved_session_id)
            else:
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
