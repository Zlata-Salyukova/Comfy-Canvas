from .comfy_canvas_session import (
    clear_session,
    get_session_state,
    normalize_session_id,
    read_session_document,
    save_session_payload,
)

_ROUTES_REGISTERED = False
SESSION_ROUTE = "/comfy_canvas/sessions"


def _session_response(session_id: str) -> dict:
    normalized = normalize_session_id(session_id)
    state = get_session_state(normalized)
    image_url = None
    mask_url = None
    result_image_url = None
    document_url = None

    if state["preview_path"] is not None:
        image_url = f"{SESSION_ROUTE}/{normalized}/image"
    if state["mask_exists"]:
        mask_url = f"{SESSION_ROUTE}/{normalized}/mask"
    if state["result_exists"]:
        result_image_url = f"{SESSION_ROUTE}/{normalized}/result"
    if state["document_exists"]:
        document_url = f"{SESSION_ROUTE}/{normalized}/document"

    return {
        "ok": True,
        "session_id": normalized,
        "exists": state["exists"],
        "edited": state["edited_exists"],
        "image_url": image_url,
        "mask_url": mask_url,
        "document_exists": state["document_exists"],
        "document_url": document_url,
        "result_exists": state["result_exists"],
        "result_image_url": result_image_url,
        "result_updated_at": state["metadata"].get("result_updated_at"),
        "metadata": state["metadata"],
    }


def register_routes() -> None:
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED:
        return

    from server import PromptServer

    prompt_server = getattr(PromptServer, "instance", None)
    if prompt_server is None:
        return

    from aiohttp import web

    routes = prompt_server.routes

    async def get_session(request):
        session_id = request.match_info["session_id"]
        return web.json_response(_session_response(session_id))

    async def save_session(request):
        session_id = request.match_info["session_id"]
        payload = await request.json()
        metadata = save_session_payload(
            session_id=session_id,
            image_data_url=payload["image"],
            mask_data_url=payload.get("mask"),
            metadata=payload.get("metadata"),
            document=payload.get("document"),
        )
        response = _session_response(session_id)
        response["metadata"] = metadata
        return web.json_response(response)

    async def clear_session_handler(request):
        session_id = request.match_info["session_id"]
        clear_session(session_id)
        return web.json_response({"ok": True, "session_id": normalize_session_id(session_id)})

    async def get_session_image(request):
        state = get_session_state(request.match_info["session_id"])
        if state["preview_path"] is None or not state["preview_path"].exists():
            raise web.HTTPNotFound()
        return web.FileResponse(state["preview_path"])

    async def get_session_mask(request):
        state = get_session_state(request.match_info["session_id"])
        if not state["mask_exists"]:
            raise web.HTTPNotFound()
        return web.FileResponse(state["mask_path"])

    async def get_session_result(request):
        state = get_session_state(request.match_info["session_id"])
        if not state["result_exists"]:
            raise web.HTTPNotFound()
        return web.FileResponse(state["result_path"])

    async def get_session_document(request):
        document = read_session_document(request.match_info["session_id"])
        if document is None:
            raise web.HTTPNotFound()
        return web.json_response(document)

    routes.get(f"{SESSION_ROUTE}/{{session_id}}")(get_session)
    routes.post(f"{SESSION_ROUTE}/{{session_id}}")(save_session)
    routes.post(f"{SESSION_ROUTE}/{{session_id}}/clear")(clear_session_handler)
    routes.get(f"{SESSION_ROUTE}/{{session_id}}/document")(get_session_document)
    routes.get(f"{SESSION_ROUTE}/{{session_id}}/image")(get_session_image)
    routes.get(f"{SESSION_ROUTE}/{{session_id}}/mask")(get_session_mask)
    routes.get(f"{SESSION_ROUTE}/{{session_id}}/result")(get_session_result)

    _ROUTES_REGISTERED = True
