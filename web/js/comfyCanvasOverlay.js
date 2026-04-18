import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const EXTENSION_NAME = "comfy_canvas.overlay";
const TARGET_NODE_NAMES = new Set([
  "ComfyCanvasEditor",
  "Comfy Canvas Editor",
  "Comfy Canvas",
]);
const SESSION_ROUTE = "/comfy_canvas/sessions";
const OVERLAY_MESSAGE_SOURCE = "comfy-canvas-overlay";
const EDITOR_MESSAGE_SOURCE = "comfy-canvas-editor";
const RUN_REQUEST_MESSAGE_TYPE = "comfy-canvas:run-request";
const RUN_RESULT_MESSAGE_TYPE = "comfy-canvas:run-result";
const EDITOR_URL = new URL("../app/index.html", import.meta.url);
const AUTOSAVE_DELAY_MS = 1000;

let modalState = null;
let nodeStylesInjected = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withCacheBust(url) {
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) {
    return url;
  }
  const next = new URL(url, window.location.origin);
  next.searchParams.set("v", `${Date.now()}`);
  return next.toString();
}

function getWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name) ?? null;
}

function readIntWidget(node, name, fallback) {
  const widget = getWidget(node, name);
  const value = Number.parseInt(widget?.value, 10);
  return Number.isFinite(value) ? value : fallback;
}

function hideWidget(widget) {
  if (!widget) {
    return;
  }
  widget.type = "hidden";
  widget.computeSize = () => [0, -4];
}

function ensureSessionId(node) {
  const widget = getWidget(node, "session_id");
  if (!widget) {
    return "";
  }
  if (!widget.value) {
    widget.value = crypto?.randomUUID?.() ?? `comfy-canvas-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  hideWidget(widget);
  return `${widget.value}`;
}

function buildSessionUrl(sessionId) {
  return `${SESSION_ROUTE}/${encodeURIComponent(sessionId)}`;
}

async function fetchSession(sessionId) {
  const response = await api.fetchApi(buildSessionUrl(sessionId));
  if (!response.ok) {
    throw new Error(`Failed to load editor session (${response.status})`);
  }
  return response.json();
}

async function fetchSessionDocument(sessionId) {
  const response = await api.fetchApi(`${buildSessionUrl(sessionId)}/document`);
  if (!response.ok) {
    throw new Error(`Failed to load editor document (${response.status})`);
  }
  return response.json();
}

async function saveSession(sessionId, payload) {
  const response = await api.fetchApi(buildSessionUrl(sessionId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Failed to save editor session (${response.status})`);
  }

  return response.json();
}

function descriptorToUrl(descriptor) {
  if (!descriptor) {
    return null;
  }

  if (typeof descriptor === "string") {
    return descriptor;
  }

  if (descriptor instanceof HTMLImageElement) {
    return descriptor.currentSrc || descriptor.src || null;
  }

  if (descriptor.src) {
    return descriptor.src;
  }

  if (descriptor.filename) {
    const params = new URLSearchParams({ filename: descriptor.filename });
    if (descriptor.type) {
      params.set("type", descriptor.type);
    }
    if (descriptor.subfolder) {
      params.set("subfolder", descriptor.subfolder);
    }
    return `/view?${params.toString()}`;
  }

  return null;
}

function findPreviewUrl(node, visited = new Set()) {
  if (!node || visited.has(node.id)) {
    return null;
  }
  visited.add(node.id);

  const customPreview = descriptorToUrl(node.__comfyCanvasPreviewImage || node.__comfyCanvasPreviewUrl);
  if (customPreview) {
    return customPreview;
  }

  if (Array.isArray(node.imgs) && node.imgs.length > 0) {
    const direct = descriptorToUrl(node.imgs[0]);
    if (direct) {
      return direct;
    }
  }

  const inputs = node.inputs ?? [];
  for (let index = 0; index < inputs.length; index += 1) {
    const upstream = node.getInputNode?.(index);
    if (!upstream) {
      continue;
    }
    const result = findPreviewUrl(upstream, visited);
    if (result) {
      return result;
    }
  }

  return null;
}

function findInputPreviewUrl(node) {
  const inputs = node?.inputs ?? [];
  for (let index = 0; index < inputs.length; index += 1) {
    const upstream = node.getInputNode?.(index);
    if (!upstream) {
      continue;
    }
    const result = findPreviewUrl(upstream);
    if (result) {
      return result;
    }
  }
  return null;
}

function ensureNodeWidgetStyles() {
  if (nodeStylesInjected) {
    return;
  }

  const style = document.createElement("style");
  style.id = "comfy-canvas-node-widget-styles";
  style.textContent = `
    .comfy-canvas-node-widget {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      gap: 10px;
      padding: 8px 10px 10px;
      box-sizing: border-box;
      justify-content: flex-start;
    }
    .comfy-canvas-node-action-row {
      display: flex;
      justify-content: center;
      align-items: center;
      flex: 0 0 auto;
      padding: 4px 0 2px;
    }
    .comfy-canvas-node-button,
    .comfy-canvas-node-button.comfy-button {
      position: relative;
      width: clamp(168px, 72%, 220px) !important;
      max-width: 220px !important;
      min-height: 42px !important;
      padding: 10px 18px !important;
      border-radius: 14px !important;
      border: 1px solid rgba(255, 255, 255, 0.12) !important;
      background:
        radial-gradient(circle at 14% 18%, rgba(85, 205, 252, 0.18), transparent 34%),
        radial-gradient(circle at 86% 16%, rgba(247, 168, 184, 0.16), transparent 32%),
        linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.01)),
        linear-gradient(180deg, rgba(15, 19, 23, 0.86), rgba(13, 15, 19, 0.74)) !important;
      color: #eef6ff !important;
      font-size: 14px !important;
      font-weight: 600 !important;
      letter-spacing: 0.01em !important;
      line-height: 1.1 !important;
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.3);
      flex: 0 0 auto !important;
      align-self: center !important;
      justify-content: center !important;
      box-shadow:
        0 14px 28px rgba(0, 0, 0, 0.2),
        0 0 0 1px rgba(255, 255, 255, 0.04) inset,
        inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
      backdrop-filter: blur(18px) saturate(1.06);
      -webkit-backdrop-filter: blur(18px) saturate(1.06);
      transition:
        transform 0.18s ease,
        box-shadow 0.2s ease,
        border-color 0.2s ease,
        filter 0.2s ease,
        background 0.2s ease;
      cursor: pointer;
      overflow: hidden;
    }
    .comfy-canvas-node-button::before {
      content: "";
      position: absolute;
      inset: 1px;
      border-radius: inherit;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0)),
        radial-gradient(circle at 28% 18%, rgba(255, 255, 255, 0.18), transparent 34%);
      opacity: 0.7;
      pointer-events: none;
      transition: opacity 0.18s ease, transform 0.22s ease;
    }
    .comfy-canvas-node-button:hover,
    .comfy-canvas-node-button.comfy-button:hover {
      transform: translateY(-1px);
      border-color: rgba(85, 205, 252, 0.28) !important;
      background:
        radial-gradient(circle at 14% 18%, rgba(85, 205, 252, 0.22), transparent 34%),
        radial-gradient(circle at 86% 16%, rgba(247, 168, 184, 0.2), transparent 32%),
        linear-gradient(180deg, rgba(255, 255, 255, 0.065), rgba(255, 255, 255, 0.02)),
        linear-gradient(180deg, rgba(17, 23, 29, 0.9), rgba(14, 17, 22, 0.8)) !important;
      box-shadow:
        0 18px 30px rgba(0, 0, 0, 0.24),
        0 0 20px rgba(85, 205, 252, 0.1),
        0 0 14px rgba(247, 168, 184, 0.08),
        0 0 0 1px rgba(255, 255, 255, 0.06) inset,
        inset 0 1px 0 rgba(255, 255, 255, 0.1) !important;
      filter: saturate(1.05) brightness(1.02);
    }
    .comfy-canvas-node-button:hover::before {
      opacity: 1;
      transform: scale(1.02);
    }
    .comfy-canvas-node-button:active,
    .comfy-canvas-node-button.comfy-button:active {
      transform: translateY(0) scale(0.985);
      box-shadow:
        0 10px 18px rgba(0, 0, 0, 0.18),
        0 0 12px rgba(85, 205, 252, 0.08),
        0 0 0 1px rgba(255, 255, 255, 0.05) inset,
        inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
    }
    .comfy-canvas-node-button:focus-visible,
    .comfy-canvas-node-button.comfy-button:focus-visible {
      outline: none;
      border-color: rgba(85, 205, 252, 0.4) !important;
      box-shadow:
        0 0 0 2px rgba(255, 255, 255, 0.08),
        0 0 0 5px rgba(85, 205, 252, 0.14),
        0 14px 28px rgba(0, 0, 0, 0.2) !important;
    }
    .comfy-canvas-node-preview-shell {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1 1 auto;
      min-height: 156px;
      padding: 12px;
      border-radius: 16px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-sizing: border-box;
    }
    .comfy-canvas-node-preview-shell.is-empty {
      background: rgba(255, 255, 255, 0.02);
      border-style: dashed;
    }
    .comfy-canvas-node-preview-image {
      display: block;
      width: 100%;
      height: 100%;
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      border-radius: 12px;
      box-sizing: border-box;
    }
    .comfy-canvas-node-preview-shell.is-empty .comfy-canvas-node-preview-image {
      display: none;
    }
    .comfy-canvas-node-preview-placeholder {
      position: absolute;
      inset: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px;
      text-align: center;
      font-size: 12px;
      line-height: 1.35;
      color: var(--descrip-text, #9ca3af);
      opacity: 0;
      pointer-events: none;
    }
    .comfy-canvas-node-preview-shell.is-empty .comfy-canvas-node-preview-placeholder {
      opacity: 1;
    }
    .comfy-canvas-node-preview-meta {
      min-height: 16px;
      text-align: center;
      font-size: 12px;
      line-height: 1.2;
      color: var(--descrip-text, #9ca3af);
      flex: 0 0 auto;
    }
  `;
  document.head.appendChild(style);
  nodeStylesInjected = true;
}

function getNodeUiRefs(node) {
  return node?.__comfyCanvasNodeUi ?? null;
}

function formatPreviewDimensions(width, height) {
  const nextWidth = Number.parseInt(width, 10);
  const nextHeight = Number.parseInt(height, 10);
  if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || nextWidth <= 0 || nextHeight <= 0) {
    return "";
  }
  return `${nextWidth} x ${nextHeight}`;
}

function clearNodePreview(node, placeholder = "No saved preview yet") {
  if (!node) {
    return;
  }

  node.__comfyCanvasPreviewImage = null;
  node.__comfyCanvasPreviewUrl = "";
  node.__comfyCanvasPreviewDimensions = "";

  const refs = getNodeUiRefs(node);
  if (!refs) {
    return;
  }

  node.imgs = null;
  refs.previewImage.removeAttribute("src");
  refs.previewShell.classList.add("is-empty");
  refs.previewPlaceholder.textContent = placeholder;
  refs.previewMeta.textContent = "";
  invalidateNodeLayout(node);
}

function setNodePreview(node, imageUrl, metadata = null) {
  if (!node || !imageUrl) {
    clearNodePreview(node);
    return;
  }

  const nextUrl = withCacheBust(imageUrl);
  const requestToken = Symbol("comfy-canvas-node-preview");
  node.__comfyCanvasPreviewRequestToken = requestToken;

  const image = new Image();
  image.onload = () => {
    if (node.__comfyCanvasPreviewRequestToken !== requestToken) {
      return;
    }

    const width = metadata?.width ?? image.naturalWidth ?? image.width;
    const height = metadata?.height ?? image.naturalHeight ?? image.height;
    const refs = getNodeUiRefs(node);

    node.__comfyCanvasPreviewImage = image;
    node.__comfyCanvasPreviewUrl = imageUrl;
    node.__comfyCanvasPreviewDimensions = formatPreviewDimensions(width, height);

    if (refs) {
      refs.previewImage.src = nextUrl;
      refs.previewShell.classList.remove("is-empty");
      refs.previewPlaceholder.textContent = "";
      refs.previewMeta.textContent = node.__comfyCanvasPreviewDimensions;
    }

    if (refs) {
      node.imgs = null;
    }

    invalidateNodeLayout(node);
  };
  image.onerror = () => {
    if (node.__comfyCanvasPreviewRequestToken !== requestToken) {
      return;
    }
    clearNodePreview(node, "Preview unavailable");
  };
  image.src = nextUrl;
}

async function syncNodePreviewFromSession(node) {
  if (!node) {
    return;
  }

  const sessionId = ensureSessionId(node);
  if (!sessionId) {
    clearNodePreview(node);
    return;
  }

  try {
    const sessionInfo = await fetchSession(sessionId);
    if (sessionInfo?.image_url) {
      setNodePreview(node, sessionInfo.image_url, sessionInfo?.metadata);
      return;
    }
    clearNodePreview(node);
  } catch (error) {
    console.warn("Failed to sync Comfy Canvas node preview", error);
    clearNodePreview(node, "Preview unavailable");
  }
}

function scheduleNodePreviewSync(node) {
  if (!node || node.__comfyCanvasPreviewSyncScheduled) {
    return;
  }

  node.__comfyCanvasPreviewSyncScheduled = true;
  queueMicrotask(() => {
    node.__comfyCanvasPreviewSyncScheduled = false;
    syncNodePreviewFromSession(node);
  });
}

function getGraphNodeById(nodeId) {
  return app.graph?.getNodeById?.(nodeId) ?? app.graph?._nodes_by_id?.[nodeId] ?? null;
}

function getGraphLinkById(linkId) {
  return app.graph?.links?.[linkId] ?? app.graph?.links?.get?.(linkId) ?? null;
}

function getGraphNodes() {
  return app.graph?._nodes ?? [];
}

function normalizeName(value) {
  return `${value ?? ""}`.trim().toLowerCase();
}

function getNodeOutput(node, outputName) {
  const normalizedOutputName = normalizeName(outputName);
  return (node?.outputs ?? []).find((output) => normalizeName(output?.name) === normalizedOutputName) ?? null;
}

function isNodeOutputConnected(node, outputName) {
  const output = getNodeOutput(node, outputName);
  return Array.isArray(output?.links) && output.links.length > 0;
}

function isNegativePromptName(value) {
  return /(negative|neg(?:ative)?(?:_| )?prompt|uncond)/i.test(`${value ?? ""}`);
}

function getNodeSearchText(node) {
  return normalizeName(
    [
      node?.title,
      node?.type,
      node?.comfyClass,
      node?.constructor?.comfyClass,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function getWidgetSearchText(widget) {
  return normalizeName([widget?.name, widget?.label].filter(Boolean).join(" "));
}

function getNodeLinkTargetInputs(node) {
  const targets = [];
  for (const output of node?.outputs ?? []) {
    for (const linkId of output?.links ?? []) {
      const link = getGraphLinkById(linkId);
      if (!link) {
        continue;
      }

      const targetNode = getGraphNodeById(link.target_id);
      const inputName = targetNode?.inputs?.[link.target_slot]?.name;
      if (!inputName) {
        continue;
      }

      targets.push(normalizeName(inputName));
    }
  }
  return targets;
}

function collectReachableNodeIds(startNode, direction = "downstream") {
  if (startNode?.id == null) {
    return new Set();
  }

  const visited = new Set();
  const queue = [startNode];

  while (queue.length > 0) {
    const node = queue.shift();
    const nodeId = node?.id;
    if (nodeId == null || visited.has(nodeId)) {
      continue;
    }

    visited.add(nodeId);

    if (direction === "upstream") {
      for (const input of node.inputs ?? []) {
        if (input?.link == null) {
          continue;
        }

        const link = getGraphLinkById(input.link);
        const upstreamNode = getGraphNodeById(link?.origin_id);
        if (upstreamNode && !visited.has(upstreamNode.id)) {
          queue.push(upstreamNode);
        }
      }
      continue;
    }

    for (const output of node.outputs ?? []) {
      for (const linkId of output?.links ?? []) {
        const link = getGraphLinkById(linkId);
        const downstreamNode = getGraphNodeById(link?.target_id);
        if (downstreamNode && !visited.has(downstreamNode.id)) {
          queue.push(downstreamNode);
        }
      }
    }
  }

  return visited;
}

function getPromptScopeNodes(scopeNode = null) {
  const nodes = getGraphNodes();
  if (scopeNode?.id == null) {
    return nodes;
  }

  const downstreamIds = collectReachableNodeIds(scopeNode, "downstream");
  if (!downstreamIds.size) {
    return [scopeNode];
  }

  const scopedIds = new Set(downstreamIds);
  downstreamIds.forEach((nodeId) => {
    const node = getGraphNodeById(nodeId);
    collectReachableNodeIds(node, "upstream").forEach((upstreamId) => {
      scopedIds.add(upstreamId);
    });
  });

  return nodes.filter((node) => scopedIds.has(node?.id));
}

function getPromptCandidateWidgets(node) {
  const widgets = (node?.widgets ?? []).filter((widget) => typeof widget?.value === "string" && widget?.type !== "hidden");
  if (!widgets.length) {
    return [];
  }

  const explicit = widgets.filter((widget) => {
    const searchText = getWidgetSearchText(widget);
    return searchText && !isNegativePromptName(searchText) && /(positive|prompt|caption|instruction)/i.test(searchText);
  });
  if (explicit.length) {
    return explicit;
  }

  return widgets.filter((widget) => {
    const searchText = getWidgetSearchText(widget);
    return !isNegativePromptName(searchText) && /(^text$|(?:^| )text(?:$| ))/i.test(searchText);
  });
}

function resolvePromptTargets(scopeNode = null) {
  const nodes = getPromptScopeNodes(scopeNode);
  const positiveLinked = [];
  const namedPositive = [];
  const generic = [];
  const seen = new Set();

  const pushTargets = (bucket, node, widgets) => {
    widgets.forEach((widget, index) => {
      const key = `${node?.id ?? "node"}:${widget?.name ?? widget?.label ?? `widget-${index}`}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      bucket.push({ node, widget });
    });
  };

  for (const node of nodes) {
    const widgets = getPromptCandidateWidgets(node);
    if (!widgets.length) {
      continue;
    }

    const nodeText = getNodeSearchText(node);
    const targetInputs = getNodeLinkTargetInputs(node);
    const feedsNegative = targetInputs.some((name) => isNegativePromptName(name));
    const feedsPositive = targetInputs.some((name) => /(positive|prompt)/i.test(name) && !isNegativePromptName(name));

    if (feedsNegative) {
      continue;
    }
    if (feedsPositive) {
      pushTargets(positiveLinked, node, widgets);
      continue;
    }
    if (/(positive|prompt)/i.test(nodeText) && !isNegativePromptName(nodeText)) {
      pushTargets(namedPositive, node, widgets);
      continue;
    }
    if (/(clip.?text.?encode|text.?encode|conditioning|caption|prompt)/i.test(nodeText)) {
      pushTargets(generic, node, widgets);
    }
  }

  if (positiveLinked.length) {
    return positiveLinked;
  }
  if (namedPositive.length) {
    return namedPositive;
  }
  return generic;
}

function applyPromptTextToGraph(promptText, scopeNode = null) {
  const targets = resolvePromptTargets(scopeNode);
  const text = `${promptText ?? ""}`;
  let updatedCount = 0;

  for (const { node, widget } of targets) {
    widget.value = text;
    if (typeof widget.callback === "function") {
      try {
        widget.callback(text);
      } catch (error) {
        console.warn("Comfy Canvas prompt widget callback failed", error);
      }
    }
    node?.setDirtyCanvas?.(true, true);
    updatedCount += 1;
  }

  if (updatedCount > 0) {
    app.graph?.setDirtyCanvas(true, true);
  }

  return updatedCount;
}

function getCurrentPromptText(scopeNode = null) {
  const target = resolvePromptTargets(scopeNode)[0];
  return typeof target?.widget?.value === "string" ? target.widget.value : "";
}

function postEditorMessage(type, payload = {}) {
  const frameWindow = ensureModal().iframe?.contentWindow;
  if (!frameWindow) {
    return;
  }

  frameWindow.postMessage(
    {
      source: OVERLAY_MESSAGE_SOURCE,
      type,
      ...payload,
    },
    window.location.origin
  );
}

function ensureModal() {
  if (modalState) {
    return modalState;
  }

  const style = document.createElement("style");
  style.textContent = `
    .comfy-canvas-modal {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(10, 12, 16, 0.72);
      backdrop-filter: blur(10px);
    }
    .comfy-canvas-modal.is-open {
      display: flex;
    }
    .comfy-canvas-shell {
      width: min(1500px, calc(100vw - 48px));
      height: min(920px, calc(100vh - 48px));
      border-radius: 18px;
      overflow: hidden;
      background: #101215;
      border: 1px solid rgba(133, 145, 166, 0.28);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
      display: grid;
      grid-template-rows: auto 1fr;
    }
    .comfy-canvas-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 18px;
      background: linear-gradient(180deg, rgba(20, 24, 31, 0.96), rgba(16, 18, 21, 0.94));
      border-bottom: 1px solid rgba(133, 145, 166, 0.18);
    }
    .comfy-canvas-title {
      font-size: 14px;
      font-weight: 600;
      color: #f3f4f6;
    }
    .comfy-canvas-status {
      font-size: 12px;
      color: #9ca3af;
    }
    .comfy-canvas-spacer {
      flex: 1;
    }
    .comfy-canvas-header button {
      border: 1px solid rgba(133, 145, 166, 0.24);
      background: rgba(24, 28, 35, 0.92);
      color: #e5e7eb;
      border-radius: 10px;
      padding: 8px 12px;
      cursor: pointer;
    }
    .comfy-canvas-header button:hover {
      border-color: rgba(85, 205, 252, 0.55);
    }
    .comfy-canvas-header .primary {
      background: linear-gradient(135deg, rgba(85, 205, 252, 0.95), rgba(247, 168, 184, 0.92));
      border: none;
      color: #101215;
      font-weight: 700;
    }
    .comfy-canvas-frame {
      width: 100%;
      height: 100%;
      border: 0;
      background: #0f1115;
    }
  `;
  document.head.appendChild(style);

  const backdrop = document.createElement("div");
  backdrop.className = "comfy-canvas-modal";
  backdrop.innerHTML = `
    <div class="comfy-canvas-shell" role="dialog" aria-modal="true" aria-label="Comfy Canvas">
      <div class="comfy-canvas-header">
        <div>
          <div class="comfy-canvas-title">Comfy Canvas</div>
          <div class="comfy-canvas-status">Loading...</div>
        </div>
        <div class="comfy-canvas-spacer"></div>
        <button type="button" data-action="reset">Reset Session</button>
        <button type="button" data-action="close">Close</button>
      </div>
      <iframe class="comfy-canvas-frame" title="Comfy Canvas"></iframe>
    </div>
  `;

  document.body.appendChild(backdrop);

  const status = backdrop.querySelector(".comfy-canvas-status");
  const iframe = backdrop.querySelector("iframe");
  const title = backdrop.querySelector(".comfy-canvas-title");

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      requestCloseModal();
    }
  });

  backdrop.querySelector('[data-action="close"]').addEventListener("click", () => {
    requestCloseModal();
  });

  backdrop.querySelector('[data-action="reset"]').addEventListener("click", async () => {
    if (!modalState?.node || modalState.closing) {
      return;
    }

    stopAutosave(modalState);
    if (modalState.savePromise) {
      try {
        await modalState.savePromise;
      } catch (error) {
        console.warn("Pending autosave failed before reset", error);
      }
    }

    modalState.dirty = false;
    modalState.changeToken = 0;
    modalState.saveQueued = false;

    const sessionId = ensureSessionId(modalState.node);
    const editorApi = modalState.editorApi ?? await waitForEditorApi(modalState.iframe);
    modalState.editorApi = editorApi;
    status.textContent = "Resetting session...";
    await api.fetchApi(`${buildSessionUrl(sessionId)}/clear`, { method: "POST" });
    if (typeof editorApi?.resetToolUiState === "function") {
      editorApi.resetToolUiState({ notify: false });
    }
    clearNodePreview(modalState.node);
    await primeEditor(modalState.node, { ok: true, exists: false, edited: false, metadata: {} });
    status.textContent = "Session reset";
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && backdrop.classList.contains("is-open")) {
      requestCloseModal();
    }
  });

  modalState = { backdrop, status, iframe, title, node: null, editorApi: null, sessionId: "", resultToken: "", pollTimer: null, pollInFlight: false, autoSaveTimer: null, changeUnsubscribe: null, dirty: false, changeToken: 0, savePromise: null, saveQueued: false, closing: false };
  return modalState;
}

function stopResultPolling() {
  if (!modalState) {
    return;
  }
  if (modalState.pollTimer) {
    window.clearInterval(modalState.pollTimer);
    modalState.pollTimer = null;
  }
  modalState.pollInFlight = false;
}

function stopAutosave(modal = modalState) {
  if (!modal?.autoSaveTimer) {
    return;
  }
  window.clearTimeout(modal.autoSaveTimer);
  modal.autoSaveTimer = null;
}

function detachSessionChangeTracking(modal = modalState) {
  if (typeof modal?.changeUnsubscribe === "function") {
    modal.changeUnsubscribe();
  }

  if (modal) {
    modal.changeUnsubscribe = null;
  }
}

function scheduleAutosave(delayMs = AUTOSAVE_DELAY_MS) {
  const modal = ensureModal();
  if (!modal.node || modal.closing || !modal.dirty) {
    return;
  }

  stopAutosave(modal);
  modal.autoSaveTimer = window.setTimeout(() => {
    modal.autoSaveTimer = null;
    persistCurrentSession({ reason: "autosave" }).catch((error) => {
      console.error(error);
      if (!modal.closing) {
        modal.status.textContent = error.message;
      }
    });
  }, delayMs);
}

function attachSessionChangeTracking(editorApi) {
  const modal = ensureModal();
  detachSessionChangeTracking(modal);
  modal.dirty = false;
  modal.changeToken = 0;
  modal.saveQueued = false;

  if (typeof editorApi?.subscribeToSessionChanges !== "function") {
    return;
  }

  modal.changeUnsubscribe = editorApi.subscribeToSessionChanges(() => {
    if (!modal.node || modal.closing || !modal.backdrop.classList.contains("is-open")) {
      return;
    }

    modal.dirty = true;
    modal.changeToken += 1;
    scheduleAutosave();
  });
}

function finalizeCloseModal() {
  if (!modalState) {
    return;
  }

  stopResultPolling();
  stopAutosave(modalState);
  detachSessionChangeTracking(modalState);
  modalState.backdrop.classList.remove("is-open");
  modalState.node = null;
  modalState.editorApi = null;
  modalState.sessionId = "";
  modalState.resultToken = "";
  modalState.dirty = false;
  modalState.changeToken = 0;
  modalState.savePromise = null;
  modalState.saveQueued = false;
  modalState.closing = false;
}

async function requestCloseModal() {
  const modal = ensureModal();
  if (!modal.node || modal.closing || !modal.backdrop.classList.contains("is-open")) {
    return;
  }

  modal.closing = true;
  stopAutosave(modal);

  try {
    while (modal.savePromise || modal.dirty) {
      modal.status.textContent = "Saving changes before closing...";
      await persistCurrentSession({ reason: "close", force: modal.dirty });
      if (!modal.dirty) {
        break;
      }
    }

    finalizeCloseModal();
  } catch (error) {
    console.error(error);
    modal.status.textContent = error.message;
    modal.closing = false;
  }
}

async function handleEditorRunRequest(payload = {}) {
  const modal = ensureModal();
  if (!modal.node || !modal.backdrop.classList.contains("is-open")) {
    throw new Error("Editor is not open");
  }

  const promptText = `${payload.promptText ?? ""}`;
  const promptOutputConnected = isNodeOutputConnected(modal.node, "prompt");
  const updatedTargets = promptOutputConnected ? 0 : applyPromptTextToGraph(promptText, modal.node);

  modal.status.textContent = updatedTargets > 0 ? "Saving prompt and session..." : "Saving session...";
  await persistCurrentSession({ reason: "run", force: modal.dirty });

  if (typeof app.queuePrompt !== "function") {
    throw new Error("ComfyUI queue API is unavailable");
  }

  await app.queuePrompt(0, 1);
  modal.status.textContent = "Workflow queued";

  if (promptText && promptOutputConnected) {
    return {
      ok: true,
      message: "Workflow queued. The dock prompt will be read from the Comfy Canvas prompt output.",
    };
  }

  if (promptText && updatedTargets === 0) {
    return {
      ok: true,
      message: "Workflow queued. No positive prompt target was found in the graph, so the dock prompt was not applied.",
    };
  }

  return {
    ok: true,
    message: updatedTargets > 0
      ? `Workflow queued. Updated ${updatedTargets} prompt node${updatedTargets === 1 ? "" : "s"}.`
      : "Workflow queued.",
  };
}

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) {
    return;
  }

  const data = event.data;
  if (!data || data.source !== EDITOR_MESSAGE_SOURCE || data.type !== RUN_REQUEST_MESSAGE_TYPE) {
    return;
  }

  const modal = ensureModal();
  if (event.source !== modal.iframe?.contentWindow) {
    return;
  }

  handleEditorRunRequest(data)
    .then((result) => {
      postEditorMessage(RUN_RESULT_MESSAGE_TYPE, result);
    })
    .catch((error) => {
      console.error(error);
      modal.status.textContent = error.message;
      postEditorMessage(RUN_RESULT_MESSAGE_TYPE, {
        ok: false,
        message: error.message || "Failed to queue workflow.",
      });
    });
});

async function waitForEditorApi(iframe, timeoutMs = 20000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const frameWindow = iframe.contentWindow;
    const bootError = frameWindow?.comfyCanvasBoot?.error;
    if (bootError) {
      throw new Error(`Editor failed to load: ${bootError}`);
    }

    const editorApi = frameWindow?.comfyCanvasApp;
    if (editorApi?.isReady) {
      return editorApi;
    }
    await sleep(50);
  }

  const bootError = iframe.contentWindow?.comfyCanvasBoot?.error;
  if (bootError) {
    throw new Error(`Editor failed to load: ${bootError}`);
  }

  throw new Error("Editor did not finish loading");
}

function getResultToken(sessionInfo) {
  if (!sessionInfo?.result_exists || !sessionInfo?.result_image_url) {
    return "";
  }
  return `${sessionInfo.result_updated_at || ""}:${sessionInfo.result_image_url}`;
}

async function syncResultPreview(sessionInfo, size = null) {
  const modal = ensureModal();
  const editorApi = modal.editorApi ?? await waitForEditorApi(modal.iframe);
  modal.editorApi = editorApi;

  const resultToken = getResultToken(sessionInfo);
  if (resultToken) {
    await editorApi.loadOutputImage({
      url: withCacheBust(sessionInfo.result_image_url),
    });
  } else if (size) {
    editorApi.clearOutput(size);
  } else {
    editorApi.clearOutput();
  }

  modal.resultToken = resultToken;
  return resultToken;
}

async function pollResultPreview() {
  const modal = ensureModal();
  if (
    modal.pollInFlight ||
    !modal.node ||
    !modal.sessionId ||
    !modal.backdrop.classList.contains("is-open")
  ) {
    return;
  }

  modal.pollInFlight = true;
  try {
    const sessionInfo = await fetchSession(modal.sessionId);
    const nextToken = getResultToken(sessionInfo);
    if (nextToken === modal.resultToken) {
      return;
    }

    await syncResultPreview(sessionInfo);
    modal.status.textContent = nextToken ? "Updated AI output" : "Waiting for AI output";
  } catch (error) {
    console.warn("Failed to refresh AI output", error);
  } finally {
    modal.pollInFlight = false;
  }
}

function startResultPolling() {
  const modal = ensureModal();
  stopResultPolling();
  if (!modal.sessionId) {
    return;
  }

  modal.pollTimer = window.setInterval(() => {
    pollResultPreview();
  }, 1000);
}
async function primeEditor(node, sessionInfo) {
  const modal = ensureModal();
  const editorApi = await waitForEditorApi(modal.iframe);
  const width = readIntWidget(node, "canvas_width", 1024);
  const height = readIntWidget(node, "canvas_height", 1024);
  const background = getWidget(node, "background")?.value || "transparent";

  modal.editorApi = editorApi;

  let sourceStatus = "Blank canvas ready";
  let outputClearSize = { width, height };
  let documentLoaded = false;

  if (sessionInfo?.document_exists) {
    try {
      modal.status.textContent = "Loading saved document...";
      const document = await fetchSessionDocument(sessionInfo.session_id || modal.sessionId);
      const loadedDocument = await editorApi.loadDocument({ document });
      if (loadedDocument?.width && loadedDocument?.height) {
        outputClearSize = loadedDocument;
        sourceStatus = "Loaded saved document";
        documentLoaded = true;
      }
    } catch (error) {
      console.warn("Failed to load saved document, falling back to preview image", error);
    }
  }

  if (!documentLoaded) {
    const sourceUrl = sessionInfo?.image_url || findInputPreviewUrl(node);
    if (sourceUrl) {
      modal.status.textContent = "Loading source image...";
      const loadedSize = await editorApi.loadImage({
        url: withCacheBust(sourceUrl),
        reset: true,
        layerName: sessionInfo?.edited ? "Edited Image" : "Source Image",
      });
      if (loadedSize?.width && loadedSize?.height) {
        outputClearSize = loadedSize;
      }
      sourceStatus = sessionInfo?.edited ? "Loaded saved edit" : "Loaded source image";
    } else {
      modal.status.textContent = "Preparing blank canvas...";
      editorApi.resetDocument({ width, height, background });
    }
  }

  const currentPromptText = typeof editorApi.getPromptText === "function" ? editorApi.getPromptText() : "";
  if (!currentPromptText && typeof editorApi.setPromptText === "function") {
    editorApi.setPromptText({ text: getCurrentPromptText(node), notify: false });
  }

  const resultToken = await syncResultPreview(sessionInfo, outputClearSize);
  attachSessionChangeTracking(editorApi);
  modal.status.textContent = resultToken ? `${sourceStatus} and AI output` : `${sourceStatus}; waiting for AI output`;
}

async function persistCurrentSession({ reason = "autosave", force = false } = {}) {
  const modal = ensureModal();
  if (!modal.node) {
    return false;
  }

  if (modal.savePromise) {
    if (modal.dirty || force) {
      modal.saveQueued = true;
    }
    return modal.savePromise;
  }

  if (!force && !modal.dirty) {
    return false;
  }

  stopAutosave(modal);

  const sessionId = ensureSessionId(modal.node);
  const editorApi = modal.editorApi ?? await waitForEditorApi(modal.iframe);
  modal.editorApi = editorApi;

  const saveToken = modal.changeToken;
  modal.saveQueued = false;
  modal.status.textContent = reason === "close" ? "Saving changes before closing..." : "Saving...";

  modal.savePromise = (async () => {
    const exported = await editorApi.exportSession();
    const payload = {
      image: exported.imageDataUrl,
      mask: exported.maskDataUrl,
      document: exported.document,
      metadata: {
        width: exported.size.width,
        height: exported.size.height,
        saved_from: "comfy_canvas_overlay",
      },
    };

    const response = await saveSession(sessionId, payload);

    if (modal.node) {
      setNodePreview(modal.node, response.image_url, response.metadata);
    }

    if (modal.changeToken === saveToken) {
      modal.dirty = false;
    } else {
      modal.dirty = true;
      modal.saveQueued = true;
    }

    if (!modal.closing) {
      modal.status.textContent = modal.dirty
        ? "Saved; syncing latest changes..."
        : `Saved ${exported.size.width}x${exported.size.height} to node session`;
    }

    return true;
  })().catch((error) => {
    modal.dirty = true;
    throw error;
  }).finally(() => {
    modal.savePromise = null;
    if (modal.saveQueued && !modal.closing && modal.node && modal.backdrop.classList.contains("is-open")) {
      scheduleAutosave(300);
    }
  });

  return modal.savePromise;
}

function loadIframe(iframe, url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeoutId);
      iframe.removeEventListener("load", handleLoad);
      iframe.removeEventListener("error", handleError);
    };

    const handleLoad = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error("Editor iframe failed to load"));
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Editor iframe load timed out"));
    }, timeoutMs);

    iframe.addEventListener("load", handleLoad, { once: true });
    iframe.addEventListener("error", handleError, { once: true });
    iframe.src = url;
  });
}

async function openEditor(node) {
  const modal = ensureModal();
  const sessionId = ensureSessionId(node);
  const frameUrl = new URL(EDITOR_URL);
  frameUrl.searchParams.set("mode", "comfy");
  frameUrl.searchParams.set("session", sessionId);
  frameUrl.searchParams.set("v", `${Date.now()}`);

  stopResultPolling();
  stopAutosave(modal);
  detachSessionChangeTracking(modal);
  modal.node = node;
  modal.editorApi = null;
  modal.sessionId = sessionId;
  modal.resultToken = "";
  modal.dirty = false;
  modal.changeToken = 0;
  modal.savePromise = null;
  modal.saveQueued = false;
  modal.closing = false;
  modal.title.textContent = node.title || "Comfy Canvas";
  modal.status.textContent = "Loading canvas...";
  modal.backdrop.classList.add("is-open");

  await loadIframe(modal.iframe, frameUrl.toString());
  modal.status.textContent = "Initializing canvas...";

  let sessionInfo = null;
  try {
    sessionInfo = await fetchSession(sessionId);
  } catch (error) {
    console.warn("Failed to fetch session, falling back to preview image", error);
  }

  await primeEditor(node, sessionInfo);
  startResultPolling();
}
function handleOpenEditor(node) {
  openEditor(node).catch((error) => {
    console.error(error);
    ensureModal().status.textContent = error.message;
  });
}

function isTargetNode(node) {
  return [
    node?.constructor?.comfyClass,
    node?.comfyClass,
    node?.type,
    node?.title,
  ].some((name) => TARGET_NODE_NAMES.has(name));
}

function moveWidgetToBottom(node, widgetName) {
  if (!Array.isArray(node?.widgets)) {
    return;
  }

  const index = node.widgets.findIndex((widget) => widget?.name === widgetName);
  if (index === -1 || index === node.widgets.length - 1) {
    return;
  }

  const [widget] = node.widgets.splice(index, 1);
  node.widgets.push(widget);
}

function removeWidgetByName(node, widgetName, predicate = () => true) {
  if (!Array.isArray(node?.widgets)) {
    return null;
  }

  const index = node.widgets.findIndex((widget) => widget?.name === widgetName && predicate(widget));
  if (index === -1) {
    return null;
  }

  const [widget] = node.widgets.splice(index, 1);
  return widget ?? null;
}

function createOpenEditorDomWidget(node) {
  ensureNodeWidgetStyles();

  const container = document.createElement("div");
  container.className = "comfy-canvas-node-widget";
  container.addEventListener("pointerdown", (event) => event.stopPropagation());
  container.addEventListener("mousedown", (event) => event.stopPropagation());

  const actionRow = document.createElement("div");
  actionRow.className = "comfy-canvas-node-action-row";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "comfy-button comfy-canvas-node-button";
  button.textContent = "Open Canvas";
  button.title = "Open the Comfy Canvas";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handleOpenEditor(node);
  });

  const previewShell = document.createElement("div");
  previewShell.className = "comfy-canvas-node-preview-shell is-empty";

  const previewImage = document.createElement("img");
  previewImage.className = "comfy-canvas-node-preview-image";
  previewImage.alt = "Comfy Canvas node preview";
  previewImage.decoding = "async";
  previewImage.loading = "lazy";

  const previewPlaceholder = document.createElement("div");
  previewPlaceholder.className = "comfy-canvas-node-preview-placeholder";
  previewPlaceholder.textContent = "No saved preview yet";

  const previewMeta = document.createElement("div");
  previewMeta.className = "comfy-canvas-node-preview-meta";

  previewShell.appendChild(previewImage);
  previewShell.appendChild(previewPlaceholder);
  actionRow.appendChild(button);
  container.appendChild(actionRow);
  container.appendChild(previewShell);
  container.appendChild(previewMeta);

  node.__comfyCanvasNodeUi = {
    container,
    button,
    previewShell,
    previewImage,
    previewPlaceholder,
    previewMeta,
  };

  return node.addDOMWidget("open_editor", "comfy_canvas_open_editor", container, {
    serialize: false,
    hideOnZoom: false,
    selectOn: ["click"],
    getValue: () => null,
    setValue: () => {},
    getMinHeight: () => 260,
    margin: 0,
  });
}

function ensureOpenEditorWidget(node) {
  let widget = getWidget(node, "open_editor");

  if (widget?.type === "button" || (widget && !getNodeUiRefs(node))) {
    removeWidgetByName(node, "open_editor", (candidate) => candidate === widget);
    widget = null;
  }

  if (!widget && typeof node.addDOMWidget === "function") {
    widget = createOpenEditorDomWidget(node);
  }

  if (!widget) {
    widget = node.addWidget("button", "Open Canvas", null, () => {
      handleOpenEditor(node);
    });
  }

  widget.name = "open_editor";
  widget.serialize = false;
  widget.options = { ...(widget.options ?? {}), serialize: false };
  return widget;
}

function resizeNodeForWidgets(node) {
  const computedSize = node.computeSize?.();
  if (!Array.isArray(computedSize) || computedSize.length < 2) {
    return;
  }

  const currentSize = Array.isArray(node.size) ? node.size : [0, 0];
  const nextSize = [
    Math.max(currentSize[0] ?? 0, computedSize[0] ?? 0),
    Math.max(currentSize[1] ?? 0, computedSize[1] ?? 0),
  ];

  node.setSize?.(nextSize);
  node.size = nextSize;
}

function invalidateNodeLayout(node) {
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas(true, true);
}

function attachNodeUi(node) {
  ensureSessionId(node);
  ensureOpenEditorWidget(node);
  if (getNodeUiRefs(node)) {
    node.imgs = null;
  }
  moveWidgetToBottom(node, "open_editor");
  resizeNodeForWidgets(node);
  scheduleNodePreviewSync(node);
  invalidateNodeLayout(node);
}

function queueAttachNodeUi(node) {
  if (!isTargetNode(node)) {
    return;
  }

  queueMicrotask(() => {
    attachNodeUi(node);
    window.requestAnimationFrame(() => {
      attachNodeUi(node);
    });
  });
}

function patchNodeType(nodeType) {
  if (!nodeType?.prototype || nodeType.prototype.__comfyCanvasPatched) {
    return;
  }

  const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function onNodeCreated() {
    const result = originalOnNodeCreated?.apply(this, arguments);
    queueAttachNodeUi(this);
    return result;
  };

  const originalConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function onConfigure() {
    const result = originalConfigure?.apply(this, arguments);
    queueAttachNodeUi(this);
    return result;
  };

  const originalDrawBackground = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function onDrawBackground() {
    const result = originalDrawBackground?.apply(this, arguments);
    if (getNodeUiRefs(this) && this.imgs) {
      this.imgs = null;
    }
    return result;
  };

  nodeType.prototype.__comfyCanvasPatched = true;
}

app.registerExtension({
  name: EXTENSION_NAME,
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!TARGET_NODE_NAMES.has(nodeData?.name)) {
      return;
    }

    patchNodeType(nodeType);
  },
  nodeCreated(node) {
    queueAttachNodeUi(node);
  },

  loadedGraphNode(node) {
    queueAttachNodeUi(node);
  },

  afterConfigureGraph() {
    for (const node of app.graph?._nodes ?? []) {
      queueAttachNodeUi(node);
    }
  },

  getNodeMenuItems(node) {
    if (!isTargetNode(node)) {
      return [];
    }

    return [
      {
        content: "Open Comfy Canvas",
        callback: () => {
          handleOpenEditor(node);
        },
      },
    ];
  },
});




