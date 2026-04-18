/**
 * Comfy Canvas - Main Controller
 * Handles UI interactions, tool switching, and coordination between editor and output panes
 */
import { createEditor } from './editor.js';
import { createOutput } from './output.js';
import { createLayersManager } from './layers.js';
import * as PIXI from './pixi.js';

const runtimeParams = new URLSearchParams(window.location.search);
const runtimeMode = runtimeParams.get('mode') || 'standalone';
const isComfyMode = runtimeMode === 'comfy';
const sessionId = runtimeParams.get('session') || '';
document.body.classList.toggle('comfy-mode', isComfyMode);

// ========== INITIALIZATION ==========
const editor = createEditor('#leftPane', { width: 1024, height: 1024 });
const output = createOutput('#rightPane', { width: 1024, height: 1024 });

let layersManager = createLayersManager(editor.getApp(), 1024, 1024);
let updateLayersUI = () => {};
const sessionChangeListeners = new Set();
let layersPanelMinimized = false;
let setLayersPanelMinimized = () => {};
let pendingRestoredOutputViewState = null;
const UNDO_REDO_STEP_LIMIT = 20;
const UNDO_REDO_SNAPSHOT_LIMIT = UNDO_REDO_STEP_LIMIT + 1;
editor.setLayersManager(layersManager);
initializeLayersUI();

function notifySessionChanged(reason = 'edit') {
  sessionChangeListeners.forEach((listener) => {
    try {
      listener({ reason, timestamp: Date.now() });
    } catch (error) {
      console.error('Failed to notify session change listener:', error);
    }
  });
}

editor.setOnDrawingComplete(() => {
  setTimeout(() => {
    refreshLayerThumbnails(layersManager?.getActiveLayerIndex?.());
  }, 50);
});
editor.setOnDocumentMutated(() => {
  notifySessionChanged('Canvas edit');
});
editor.setOnViewChanged(() => {
  notifySessionChanged('Editor view changed');
});
output.setOnViewChanged(() => {
  notifySessionChanged('Output view changed');
});
editor.setOnMoveStateChanged?.((moveState) => {
  if (!isSelectionAwareTool(currentTool)) {
    return;
  }

  if (currentTool === 'move') {
    syncMoveControlStateFromEditor(moveState);
  }
  buildSettingsFor(currentTool);
});
editor.setOnTextStateChanged?.((textState) => {
  syncTextControlStateFromEditor(textState);
  if (currentTool === 'text') {
    buildSettingsFor(currentTool);
  }
});

// ========== UNDO/REDO SYSTEM ==========
class UndoRedoManager {
  constructor(maxHistorySize = UNDO_REDO_SNAPSHOT_LIMIT) {
    this.history = [];
    this.currentIndex = -1;
    this.maxHistorySize = maxHistorySize;
    this.isRestoring = false;
  }

  captureSnapshot(description = 'Action') {
    if (this.isRestoring) {
      return;
    }

    try {
      const snapshot = {
        timestamp: Date.now(),
        description,
        data: this.getCurrentCanvasData(),
      };

      if (this.currentIndex < this.history.length - 1) {
        this.history = this.history.slice(0, this.currentIndex + 1);
      }

      this.history.push(snapshot);
      this.currentIndex = this.history.length - 1;

      if (this.history.length > this.maxHistorySize) {
        this.history.shift();
        this.currentIndex -= 1;
      }

      this.updateUndoRedoButtons();

      if (description !== 'Initial state' && description !== 'Reset document') {
        notifySessionChanged(description);
      }
    } catch (error) {
      console.error('Failed to capture snapshot:', error);
    }
  }

  getCurrentCanvasData() {
    const canvasSize = { ...editor.getSize() };
    const promptText = getPromptValue();
    const uiState = buildPersistedUiState({ includeViewState: false });

    if (layersManager) {
      const layers = layersManager.getLayers();
      const activeLayerIndex = layersManager.getActiveLayerIndex();
      return {
        type: 'layers',
        activeLayerIndex,
        canvasSize,
        promptText,
        uiState,
        layers: layers.map((layer, index) => {
          const contentCanvas = editor.snapshotLayerContentCanvas?.(index)
            || editor.getApp().renderer.extract.canvas(layer.renderTexture);
          const maskCanvas = layer.maskRenderTexture
            ? editor.snapshotLayerMaskCanvas?.(index, { visualize: false })
            : null;
          return {
            name: layer.name,
            type: layer.type || 'paint',
            textData: layer.textData ? { ...layer.textData } : null,
            opacity: layer.opacity,
            visible: layer.visible,
            locked: layer.locked === true,
            blendMode: layer.blendMode,
            hasMask: !!layer.maskRenderTexture,
            maskEnabled: layer.maskEnabled !== false,
            contentCanvas,
            maskCanvas,
          };
        }),
      };
    }

    return {
      type: 'single',
      canvasSize,
      promptText,
      uiState,
      canvas: editor.snapshotCanvas(),
    };
  }

  getSnapshotCanvasSize(snapshotData = null) {
    const fallbackSize = editor.getSize();
    const rawSize = typeof snapshotData?.canvasSize === 'object' && snapshotData.canvasSize !== null
      ? snapshotData.canvasSize
      : fallbackSize;

    return {
      width: Math.max(64, Math.round(clampNumber(rawSize.width, {
        min: 64,
        max: 8192,
        fallback: fallbackSize.width,
      }))),
      height: Math.max(64, Math.round(clampNumber(rawSize.height, {
        min: 64,
        max: 8192,
        fallback: fallbackSize.height,
      }))),
    };
  }

  restoreSnapshot(snapshot) {
    if (!snapshot) {
      return false;
    }

    this.isRestoring = true;

    try {
      const snapshotData = snapshot.data || {};
      const snapshotSize = this.getSnapshotCanvasSize(snapshotData);
      const currentSize = editor.getSize();
      const preservedEditorView = normalizeViewState(editor.getViewState());
      const preservedOutputView = normalizeViewState(output.getViewState());

      editor.discardTransientState?.();

      if (snapshotSize.width !== currentSize.width || snapshotSize.height !== currentSize.height) {
        editor.resizeArtboard(snapshotSize.width, snapshotSize.height);
        if (!hasOutputImage) {
          output.resizeArtboard(snapshotSize.width, snapshotSize.height, { preserveView: true });
        }
      }

      if (snapshotData.type === 'layers' && layersManager) {
        const layerDataArray = Array.isArray(snapshotData.layers) ? snapshotData.layers : [];
        const activeLayerIndex = Number.isInteger(snapshotData.activeLayerIndex)
          ? snapshotData.activeLayerIndex
          : layerDataArray.length - 1;
        layersManager.clearAllLayers();

        layerDataArray.forEach((layerData, index) => {
          const layer = layersManager.addLayer({
            name: layerData.name,
            type: layerData.type || 'paint',
            textData: layerData.textData ? { ...layerData.textData } : null,
            opacity: layerData.opacity,
            visible: layerData.visible,
            locked: layerData.locked === true,
            blendMode: layerData.blendMode,
            hasMask: layerData.hasMask === true,
            maskEnabled: layerData.maskEnabled !== false,
          });

          const contentCanvas = layerData.contentCanvas;
          if (contentCanvas?.width && contentCanvas?.height) {
            const tempTexture = PIXI.Texture.from(contentCanvas);
            const tempSprite = new PIXI.Sprite(tempTexture);
            const targetRT = layer.renderTexture;

            const clearGraphics = new PIXI.Graphics();
            clearGraphics.beginFill(0x000000, 0);
            clearGraphics.drawRect(0, 0, targetRT.width, targetRT.height);
            clearGraphics.endFill();
            editor.getApp().renderer.render(clearGraphics, { renderTexture: targetRT, clear: true });
            clearGraphics.destroy();

            const scaleX = targetRT.width / contentCanvas.width;
            const scaleY = targetRT.height / contentCanvas.height;
            if (scaleX !== 1 || scaleY !== 1) {
              tempSprite.scale.set(scaleX, scaleY);
            }

            editor.getApp().renderer.render(tempSprite, { renderTexture: targetRT, clear: false });
            tempSprite.destroy();
            tempTexture.destroy();
          }

          if (layerData.hasMask === true && layer.maskRenderTexture && layerData.maskCanvas?.width && layerData.maskCanvas?.height) {
            const tempTexture = PIXI.Texture.from(layerData.maskCanvas);
            const tempSprite = new PIXI.Sprite(tempTexture);
            const targetRT = layer.maskRenderTexture;

            const clearGraphics = new PIXI.Graphics();
            clearGraphics.beginFill(0xffffff, 1);
            clearGraphics.drawRect(0, 0, targetRT.width, targetRT.height);
            clearGraphics.endFill();
            editor.getApp().renderer.render(clearGraphics, { renderTexture: targetRT, clear: true });
            clearGraphics.destroy();

            const scaleX = targetRT.width / layerData.maskCanvas.width;
            const scaleY = targetRT.height / layerData.maskCanvas.height;
            if (scaleX !== 1 || scaleY !== 1) {
              tempSprite.scale.set(scaleX, scaleY);
            }

            editor.getApp().renderer.render(tempSprite, { renderTexture: targetRT, clear: false });
            tempSprite.destroy();
            tempTexture.destroy();
            layersManager.updateLayer(index, { maskEnabled: layerData.maskEnabled !== false });
          }
        });

        const validActiveIndex = Math.min(activeLayerIndex, Math.max(layerDataArray.length - 1, 0));
        layersManager.setActiveLayer(validActiveIndex);
      } else {
        editor.showCanvas(snapshotData.canvas);
      }

      setPromptValue(snapshotData.promptText || '', { notify: false });
      applyPersistedUiState(snapshotData.uiState, { notify: false, restoreViewState: false });
      if (preservedEditorView) {
        editor.setViewState(preservedEditorView);
      }
      if (preservedOutputView) {
        output.setViewState(preservedOutputView);
      }
      updateLayersUI();
      setTimeout(refreshLayerThumbnails, 10);

      this.updateUndoRedoButtons();
      return true;
    } catch (error) {
      console.error('Failed to restore snapshot:', error);
      return false;
    } finally {
      this.isRestoring = false;
    }
  }

  undo() {
    if (!this.canUndo()) {
      return false;
    }
    const previousIndex = this.currentIndex;
    const nextIndex = this.currentIndex - 1;
    this.currentIndex = nextIndex;
    if (this.restoreSnapshot(this.history[nextIndex])) {
      notifySessionChanged('Undo');
      return true;
    }
    this.currentIndex = previousIndex;
    this.updateUndoRedoButtons();
    return false;
  }

  redo() {
    if (!this.canRedo()) {
      return false;
    }
    const previousIndex = this.currentIndex;
    const nextIndex = this.currentIndex + 1;
    this.currentIndex = nextIndex;
    if (this.restoreSnapshot(this.history[nextIndex])) {
      notifySessionChanged('Redo');
      return true;
    }
    this.currentIndex = previousIndex;
    this.updateUndoRedoButtons();
    return false;
  }

  canUndo() {
    return this.currentIndex > 0;
  }

  canRedo() {
    return this.currentIndex < this.history.length - 1;
  }

  updateUndoRedoButtons() {
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    if (undoBtn) {
      undoBtn.disabled = !this.canUndo();
    }
    if (redoBtn) {
      redoBtn.disabled = !this.canRedo();
    }
  }

  clear() {
    this.history = [];
    this.currentIndex = -1;
    this.updateUndoRedoButtons();
  }
}

const undoRedoManager = new UndoRedoManager();
document.getElementById('undoBtn')?.addEventListener('click', () => {
  undoRedoManager.undo();
});
document.getElementById('redoBtn')?.addEventListener('click', () => {
  undoRedoManager.redo();
});
undoRedoManager.updateUndoRedoButtons();

const topbarColor = document.getElementById('topbarColor');

function toMaskGrayscaleHex(hexColor) {
  const normalized = sanitizeHexColor(hexColor, '#ffffff');
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  const gray = Math.max(0, Math.min(255, Math.round((red * 0.299) + (green * 0.587) + (blue * 0.114))));
  const grayHex = gray.toString(16).padStart(2, '0');
  return `#${grayHex}${grayHex}${grayHex}`;
}

function syncActiveColorFromTopbar({ notify = true } = {}) {
  if (!topbarColor) {
    return;
  }

  let nextColor = sanitizeHexColor(topbarColor.value, toolSettings.brush.color);
  if (isMaskEditingTarget()) {
    nextColor = toMaskGrayscaleHex(nextColor);
  }
  const previousColor = toolSettings.brush.color;
  topbarColor.value = nextColor;
  syncColorCircleBackground(nextColor);
  toolSettings.brush.color = nextColor;
  editor.setBrush(buildBrushConfig());
  if (currentTool === 'paint-bucket') {
    editor.setBucket(buildBucketConfig());
  }
  if (notify && previousColor !== nextColor) {
    notifySessionChanged('Active color changed');
  }
}

topbarColor?.addEventListener('input', () => syncActiveColorFromTopbar());
topbarColor?.addEventListener('change', () => syncActiveColorFromTopbar());

const topbarColorBtn = document.getElementById('topbarColorBtn');

function syncColorCircleBackground(color = null) {
  const value = color || (topbarColor ? topbarColor.value : null);
  if (topbarColorBtn && value) {
    topbarColorBtn.style.background = value;
  }
}

topbarColorBtn?.addEventListener('click', () => {
  topbarColor?.click();
});

topbarColor?.addEventListener('input', syncColorCircleBackground);
topbarColor?.addEventListener('change', syncColorCircleBackground);
syncColorCircleBackground();

const uploadBtn = document.getElementById('uploadBtn');
const uploadInput = document.getElementById('uploadInput');
const copyOutputBtn = document.getElementById('copyOutputBtn');
const downloadBtn = document.getElementById('downloadBtn');
const promptInput = document.getElementById('prompt');
const runPromptBtn = document.getElementById('runPromptBtn');
const promptDockStatus = document.getElementById('promptDockStatus');
let hasOutputImage = false;
let runRequestInFlight = false;

function resizePromptInput() {
  if (!promptInput) {
    return;
  }

  promptInput.style.height = 'auto';
  const nextHeight = Math.min(promptInput.scrollHeight, 144);
  promptInput.style.height = `${Math.max(54, nextHeight)}px`;
}

function setPromptDockStatus(message = '', tone = '') {
  if (!promptDockStatus) {
    return;
  }

  promptDockStatus.textContent = message;
  if (tone) {
    promptDockStatus.dataset.tone = tone;
  } else {
    delete promptDockStatus.dataset.tone;
  }
}

function setRunButtonBusy(isBusy) {
  if (!runPromptBtn) {
    return;
  }

  runPromptBtn.disabled = isBusy || !isComfyMode;
  runPromptBtn.classList.toggle('is-running', isBusy);
}

function pulseRunButton() {
  if (!runPromptBtn) {
    return;
  }

  runPromptBtn.classList.remove('is-fired');
  void runPromptBtn.offsetWidth;
  runPromptBtn.classList.add('is-fired');
  window.setTimeout(() => {
    runPromptBtn.classList.remove('is-fired');
  }, 420);
}

function getPromptValue() {
  return promptInput?.value || '';
}

function sanitizeHexColor(value, fallback = '#55cdfc') {
  const normalized = `${value ?? ''}`.trim();
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : fallback;
}

function titleCaseToken(value) {
  return `${value ?? ''}`
    .split(/[\s-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function clampNumber(value, { min = -Infinity, max = Infinity, fallback = 0 } = {}) {
  const nextValue = Number(value);
  if (!Number.isFinite(nextValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, nextValue));
}

const BRUSH_SHAPE_OPTIONS = new Set(['round', 'square', 'soft-round', 'flat']);
const BRUSH_BLEND_MODE_OPTIONS = new Set(['normal', 'multiply', 'screen', 'overlay']);
const DROPPER_SAMPLE_SIZE_OPTIONS = new Set(['point', '3x3', '5x5', '11x11']);
const DROPPER_LAYER_SOURCE_OPTIONS = new Set(['current-layer', 'all-layers']);
const BUCKET_BLEND_MODE_OPTIONS = new Set(['normal', 'multiply', 'screen', 'overlay']);
const MARQUEE_MODE_OPTIONS = new Set(['rectangle', 'ellipse']);
const MARQUEE_RATIO_OPTIONS = new Set(['free', '1:1', '4:3', '16:9', '3:2']);
const SELECTION_OPERATION_OPTIONS = new Set(['replace', 'add', 'subtract', 'intersect']);
const LASSO_MODE_OPTIONS = new Set(['freehand', 'polygonal', 'magnetic']);
const PEN_PATH_MODE_OPTIONS = new Set(['path', 'selection', 'mask']);
const PEN_SHAPE_MODE_OPTIONS = new Set(['path', 'filled-shape', 'stroked-shape']);
const PEN_CURVE_HANDLE_OPTIONS = new Set(['mirrored', 'independent', 'automatic']);
const TEXT_FONT_FAMILY_OPTIONS = new Set(['space-grotesk', 'jetbrains-mono', 'source-serif', 'system-sans']);
const TEXT_ALIGNMENT_OPTIONS = new Set(['left', 'center', 'right', 'justify']);
const TEXT_WARP_OPTIONS = new Set(['none', 'arc', 'flag', 'bulge']);
const MOVE_TRANSFORM_MODE_OPTIONS = new Set(['move', 'scale', 'rotate']);
const MOVE_PIVOT_POINT_OPTIONS = new Set(['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'custom']);
const SELECTION_AWARE_TOOL_IDS = new Set(['marquee', 'lasso', 'magic-wand', 'move']);

function normalizeOptionValue(value, allowedValues, fallback) {
  return allowedValues.has(value) ? value : fallback;
}

function buildDefaultRuntimeToolSettings() {
  return {
    brush: {
      color: '#55cdfc',
      size: 8,
      hardness: 100,
      opacity: 100,
      flow: 100,
      spacing: 12,
      brushShape: 'round',
      smoothing: 0,
      blendMode: 'normal',
      feather: 0,
    },
    eraser: {
      size: 8,
      hardness: 100,
      opacity: 100,
      flow: 100,
      spacing: 14,
      eraseToTransparency: true,
      softEdge: true,
      feather: 0,
    },
  };
}

function normalizeToolSettingsState(rawState = {}) {
  const defaults = buildDefaultRuntimeToolSettings();
  const brush = typeof rawState?.brush === 'object' && rawState.brush !== null ? rawState.brush : {};
  const eraser = typeof rawState?.eraser === 'object' && rawState.eraser !== null ? rawState.eraser : {};
  const brushHardness = clampNumber(brush.hardness ?? (100 - clampNumber(brush.feather, {
    min: 0,
    max: 100,
    fallback: defaults.brush.feather,
  })), {
    min: 0,
    max: 100,
    fallback: defaults.brush.hardness,
  });
  const eraserHardness = clampNumber(eraser.hardness ?? (100 - clampNumber(eraser.feather, {
    min: 0,
    max: 100,
    fallback: defaults.eraser.feather,
  })), {
    min: 0,
    max: 100,
    fallback: defaults.eraser.hardness,
  });

  return {
    brush: {
      color: sanitizeHexColor(brush.color, defaults.brush.color),
      size: clampNumber(brush.size, { min: 1, max: 256, fallback: defaults.brush.size }),
      hardness: brushHardness,
      opacity: clampNumber(brush.opacity, { min: 0, max: 100, fallback: defaults.brush.opacity }),
      flow: clampNumber(brush.flow, { min: 1, max: 100, fallback: defaults.brush.flow }),
      spacing: clampNumber(brush.spacing, { min: 1, max: 200, fallback: defaults.brush.spacing }),
      brushShape: normalizeOptionValue(brush.brushShape, BRUSH_SHAPE_OPTIONS, defaults.brush.brushShape),
      smoothing: clampNumber(brush.smoothing, { min: 0, max: 100, fallback: defaults.brush.smoothing }),
      blendMode: normalizeOptionValue(brush.blendMode, BRUSH_BLEND_MODE_OPTIONS, defaults.brush.blendMode),
      feather: clampNumber(100 - brushHardness, { min: 0, max: 100, fallback: defaults.brush.feather }),
    },
    eraser: {
      size: clampNumber(eraser.size, { min: 1, max: 256, fallback: defaults.eraser.size }),
      hardness: eraserHardness,
      opacity: clampNumber(eraser.opacity, { min: 0, max: 100, fallback: defaults.eraser.opacity }),
      flow: clampNumber(eraser.flow, { min: 1, max: 100, fallback: defaults.eraser.flow }),
      spacing: clampNumber(eraser.spacing, { min: 1, max: 200, fallback: defaults.eraser.spacing }),
      eraseToTransparency: eraser.eraseToTransparency === undefined ? defaults.eraser.eraseToTransparency : eraser.eraseToTransparency === true,
      softEdge: eraser.softEdge === undefined ? defaults.eraser.softEdge : eraser.softEdge === true,
      feather: clampNumber(100 - eraserHardness, { min: 0, max: 100, fallback: defaults.eraser.feather }),
    },
  };
}

function normalizeViewState(rawState) {
  if (!rawState || typeof rawState !== 'object') {
    return null;
  }

  const scale = clampNumber(rawState.scale, { min: 0.1, max: 8, fallback: NaN });
  const x = clampNumber(rawState.x, { min: -100000, max: 100000, fallback: NaN });
  const y = clampNumber(rawState.y, { min: -100000, max: 100000, fallback: NaN });
  if (!Number.isFinite(scale) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return { scale, x, y };
}

function buildPersistedUiState({ includeViewState = true } = {}) {
  const uiState = {
    currentTool,
    layersPanelMinimized,
    activeLayerEditTarget: layersManager?.getActiveEditTarget?.() || 'content',
    toolSettings: normalizeToolSettingsState(toolSettings),
    toolControlState: normalizeToolControlState(toolControlState),
  };
  if (includeViewState) {
    uiState.editorView = normalizeViewState(editor.getViewState());
    uiState.outputView = normalizeViewState(output.getViewState());
  }
  return uiState;
}

function applyPersistedUiState(uiState, { notify = false, restoreViewState = true } = {}) {
  toolSettings = normalizeToolSettingsState(uiState?.toolSettings);
  toolControlState = normalizeToolControlState(uiState?.toolControlState);
  syncToolControlStateFromRuntimeSettings();

  if (topbarColor) {
    topbarColor.value = toolSettings.brush.color;
    syncColorCircleBackground();
  }

  const allowedTools = new Set(AVAILABLE_TOOL_IDS);
  const nextTool = typeof uiState?.currentTool === 'string' && allowedTools.has(uiState.currentTool)
    ? uiState.currentTool
    : 'brush';

  setActiveTool(nextTool, { notify });

  if (layersManager?.setActiveEditTarget) {
    const requestedEditTarget = uiState?.activeLayerEditTarget === 'mask' ? 'mask' : 'content';
    layersManager.setActiveEditTarget(requestedEditTarget);
    if (layersManager.getActiveEditTarget?.() === 'mask' && nextTool !== MASK_EDIT_PRIMARY_TOOL) {
      setActiveTool('brush', { notify: false });
    } else {
      buildSettingsFor(currentTool, true);
      syncMaskEditingToolAvailability();
    }
  }

  setLayersPanelMinimized(uiState?.layersPanelMinimized === true, { notify });

  if (restoreViewState) {
    const editorView = normalizeViewState(uiState?.editorView);
    if (editorView) {
      editor.setViewState(editorView);
    }

    pendingRestoredOutputViewState = normalizeViewState(uiState?.outputView);
    if (pendingRestoredOutputViewState) {
      output.setViewState(pendingRestoredOutputViewState);
    }
  }
}

function resetUndoHistory(description = 'Initial state') {
  if (!window.undoRedoManager) {
    return;
  }

  window.undoRedoManager.clear();
  window.undoRedoManager.captureSnapshot(description);
}

function setPromptValue(value, { notify = false } = {}) {
  if (!promptInput) {
    return;
  }

  const nextValue = `${value ?? ''}`;
  if (promptInput.value === nextValue) {
    resizePromptInput();
    return;
  }

  promptInput.value = nextValue;
  resizePromptInput();
  if (notify) {
    notifySessionChanged('Prompt changed');
  }
}

function requestWorkflowRun() {
  if (!isComfyMode) {
    setPromptDockStatus('Run is available only inside ComfyUI.', 'error');
    return;
  }

  if (runRequestInFlight) {
    return;
  }

  runRequestInFlight = true;
  pulseRunButton();
  setRunButtonBusy(true);
  setPromptDockStatus('Queueing workflow...', 'busy');
  window.parent.postMessage(
    {
      source: 'comfy-canvas-editor',
      type: 'comfy-canvas:run-request',
      sessionId,
      promptText: getPromptValue(),
    },
    window.location.origin
  );
}

promptInput?.addEventListener('input', () => {
  resizePromptInput();
  notifySessionChanged('Prompt changed');
});
promptInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    requestWorkflowRun();
  }
});
runPromptBtn?.addEventListener('click', () => {
  requestWorkflowRun();
});
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) {
    return;
  }

  const data = event.data;
  if (!data || data.source !== 'comfy-canvas-overlay') {
    return;
  }

  if (data.type === 'comfy-canvas:run-result') {
    runRequestInFlight = false;
    setRunButtonBusy(false);
    setPromptDockStatus(
      data.message || (data.ok ? 'Workflow queued.' : 'Failed to run workflow.'),
      data.ok ? 'success' : 'error'
    );
  }
});
resizePromptInput();
setRunButtonBusy(false);
if (!isComfyMode) {
  setPromptDockStatus('Run is available only inside ComfyUI.');
}

function updateCopyOutputButtonState() {
  if (!copyOutputBtn) {
    return;
  }
  copyOutputBtn.disabled = !hasOutputImage;
}

async function copyOutputToNewLayer() {
  if (!hasOutputImage) {
    return;
  }

  try {
    const canvas = output.snapshotCanvas();
    await addImageLayerFromElement(canvas, { layerName: 'AI Output', fitToArtboard: false });
    notifySessionChanged('Copy output to layer');

    if (window.undoRedoManager) {
      setTimeout(() => {
        window.undoRedoManager.captureSnapshot('Copy output to layer');
      }, 10);
    }
  } catch (error) {
    console.error('Failed to copy output to a new layer:', error);
    alert('Failed to copy the output image into the editor.');
  }
}

uploadBtn?.addEventListener('click', () => uploadInput?.click());
copyOutputBtn?.addEventListener('click', () => {
  copyOutputToNewLayer();
});
updateCopyOutputButtonState();

downloadBtn?.addEventListener('click', () => {
  try {
    const outputCanvas = output.snapshotCanvas();
    if (!outputCanvas) {
      return;
    }

    const dataUrl = outputCanvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `comfy-canvas-output-${Date.now()}.png`;
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (error) {
    console.error('Failed to download output image:', error);
    alert('Failed to download the output image.');
  }
});
uploadInput?.addEventListener('change', () => {
  const [file] = uploadInput.files || [];
  if (file) {
    handleImageUpload(file);
    uploadInput.value = '';
  }
});

const leftPaneHost = document.getElementById('leftPane');
['dragenter', 'dragover'].forEach((eventName) => {
  leftPaneHost?.addEventListener(eventName, (event) => {
    event.preventDefault();
  });
});
leftPaneHost?.addEventListener('drop', (event) => {
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files || []);
  const imageFile = files.find((file) => file.type.startsWith('image/'));
  if (imageFile) {
    handleImageUpload(imageFile);
  }
});
function createPaintLayer(name = 'Paint') {
  return layersManager.addLayer({
    name,
    opacity: 1,
    visible: true,
    blendMode: 'normal'
  });
}

/**
 * Add an image as a layer and optionally prepare the editor for immediate editing.
 * @param {CanvasImageSource} img - Image-like source to draw into the layer.
 * @param {Object} options - Import behavior.
 */
function addImageLayerFromElement(
  img,
  {
    layerName = 'Uploaded Image',
    resetDocument = false,
    selectAfterAdd = false,
    activateTool = null,
    createPaintLayerAfterAdd = false,
    paintLayerName = 'Paint',
    fitToArtboard = true
  } = {}
) {
  try {
    if (resetDocument) {
      resetDocumentState({
        width: img.width,
        height: img.height,
        background: 'transparent'
      });
    }

    editor.clearSelection();

    const fileName = layerName || 'Uploaded Image';
    const imageLayer = layersManager.addLayer({
      name: fileName,
      opacity: 1,
      visible: true,
      blendMode: 'normal'
    });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const artboardWidth = editor.getSize().width;
    const artboardHeight = editor.getSize().height;

    let drawWidth = img.width;
    let drawHeight = img.height;

    if (fitToArtboard && !resetDocument && (drawWidth > artboardWidth || drawHeight > artboardHeight)) {
      const scaleX = artboardWidth / drawWidth;
      const scaleY = artboardHeight / drawHeight;
      const scale = Math.min(scaleX, scaleY);
      drawWidth *= scale;
      drawHeight *= scale;
    }

    drawWidth = Math.max(1, Math.round(drawWidth));
    drawHeight = Math.max(1, Math.round(drawHeight));
    canvas.width = drawWidth;
    canvas.height = drawHeight;
    ctx.drawImage(img, 0, 0, drawWidth, drawHeight);

    const texture = PIXI.Texture.from(canvas);
    const imageSprite = new PIXI.Sprite(texture);
    const centerX = (artboardWidth - drawWidth) / 2;
    const centerY = (artboardHeight - drawHeight) / 2;
    imageSprite.position.set(centerX, centerY);

    editor.getApp().renderer.render(imageSprite, {
      renderTexture: imageLayer.renderTexture,
      clear: false
    });

    imageSprite.destroy();
    texture.destroy();

    let nextTool = activateTool;
    if (createPaintLayerAfterAdd) {
      createPaintLayer(paintLayerName);
      nextTool = nextTool || 'brush';
    }

    if (nextTool) {
      setActiveTool(nextTool);
    }

    if (selectAfterAdd) {
      editor.setSelection({
        x: centerX,
        y: centerY,
        width: drawWidth,
        height: drawHeight
      });
    }

    updateLayersUI();

    if (resetDocument) {
      resetUndoHistory('Initial state');
    }

    return {
      width: drawWidth,
      height: drawHeight,
      activeLayerId: layersManager.getActiveLayer()?.id ?? imageLayer.id,
      importedLayerId: imageLayer.id,
    };
  } catch (error) {
    console.error('Failed to process uploaded image:', error);
    throw error;
  }
}

function loadImageSource(source, options = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        resolve(addImageLayerFromElement(img, options));
      } catch (error) {
        reject(error);
      }
    };
    img.onerror = () => {
      reject(new Error('Failed to load image source'));
    };
    img.src = source;
  });
}

function loadImageElement(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image source'));
    img.src = source;
  });
}

function drawSourceToLayer(layer, source, { clear = true } = {}) {
  if (!layer || !source) {
    return false;
  }

  const texture = PIXI.Texture.from(source);
  const sprite = new PIXI.Sprite(texture);

  try {
    editor.getApp().renderer.render(sprite, {
      renderTexture: layer.renderTexture,
      clear,
    });
    return true;
  } finally {
    sprite.destroy();
    texture.destroy();
  }
}

async function restorePersistedDocument(documentData) {
  const layers = Array.isArray(documentData?.layers) ? documentData.layers : [];
  if (!layers.length) {
    setPromptValue(documentData?.promptText || '', { notify: false });
    applyPersistedUiState(documentData?.uiState, { notify: false });
    return false;
  }

  const size = typeof documentData?.size === 'object' && documentData.size !== null
    ? documentData.size
    : {};
  const width = Math.max(64, Math.round(size.width || editor.getSize().width));
  const height = Math.max(64, Math.round(size.height || editor.getSize().height));

  resetDocumentState({ width, height, background: 'transparent' });
  layersManager.clearAllLayers();

  for (const layerData of layers) {
    const layer = layersManager.addLayer({
      name: layerData?.name || 'Layer',
      type: layerData?.type || 'paint',
      textData: layerData?.textData ? { ...layerData.textData } : null,
      opacity: typeof layerData?.opacity === 'number' ? layerData.opacity : 1,
      visible: layerData?.visible !== false,
      locked: layerData?.locked === true,
      blendMode: layerData?.blendMode || 'normal',
      hasMask: layerData?.hasMask === true || !!layerData?.maskImageDataUrl,
      maskEnabled: layerData?.maskEnabled !== false,
    });

    if (layerData?.imageDataUrl) {
      const image = await loadImageElement(layerData.imageDataUrl);
      drawSourceToLayer(layer, image);
    }

    if (layerData?.maskImageDataUrl && layer.maskRenderTexture) {
      const maskImage = await loadImageElement(layerData.maskImageDataUrl);
      drawSourceToLayer({ renderTexture: layer.maskRenderTexture }, maskImage);
      layersManager.updateLayer(layersManager.getLayerIndexById(layer.id), {
        maskEnabled: layerData?.maskEnabled !== false,
      });
    }
  }

  const activeLayerIndex = Number.isInteger(documentData?.activeLayerIndex)
    ? documentData.activeLayerIndex
    : layers.length - 1;
  const boundedActiveLayerIndex = Math.max(0, Math.min(activeLayerIndex, layers.length - 1));
  layersManager.setActiveLayer(boundedActiveLayerIndex);
  setPromptValue(documentData?.promptText || '', { notify: false });
  applyPersistedUiState(documentData?.uiState, { notify: false });

  updateLayersUI();

  resetUndoHistory('Initial state');

  return {
    width,
    height,
    activeLayerIndex: boundedActiveLayerIndex,
    promptText: getPromptValue(),
  };
}

function buildPersistedDocumentPayload() {
  if (!layersManager) {
    return null;
  }

  const size = editor.getSize();
  return {
    version: 3,
    size: {
      width: size.width,
      height: size.height,
    },
    activeLayerIndex: layersManager.getActiveLayerIndex(),
    promptText: getPromptValue(),
    uiState: buildPersistedUiState(),
    layers: layersManager.getLayers().map((layer, index) => ({
      name: layer.name,
      type: layer.type || 'paint',
      textData: layer.textData ? { ...layer.textData } : null,
      opacity: layer.opacity,
      visible: layer.visible,
      locked: layer.locked === true,
      blendMode: layer.blendMode,
      hasMask: !!layer.maskRenderTexture,
      maskEnabled: layer.maskEnabled !== false,
      imageDataUrl: editor.snapshotLayerContentCanvas(index).toDataURL('image/png'),
      maskImageDataUrl: layer.maskRenderTexture
        ? editor.snapshotLayerMaskCanvas(index, { visualize: false }).toDataURL('image/png')
        : null,
    })),
  };
}

function createTransparentCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function applyPendingOutputViewState() {
  if (!pendingRestoredOutputViewState) {
    return false;
  }

  const applied = output.setViewState(pendingRestoredOutputViewState);
  if (applied) {
    pendingRestoredOutputViewState = null;
  }
  return applied;
}

function clearOutputPreview({ width = output.getSize().width, height = output.getSize().height } = {}) {
  const canvas = createTransparentCanvas(width, height);
  output.showCanvas(canvas);
  output.fitAndCenter({ notify: false });
  applyPendingOutputViewState();
  hasOutputImage = false;
  updateCopyOutputButtonState();
}

function loadOutputImageSource(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = createTransparentCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        output.showCanvas(canvas);
        output.fitAndCenter({ notify: false });
        applyPendingOutputViewState();
        hasOutputImage = true;
        updateCopyOutputButtonState();
        resolve({ width: canvas.width, height: canvas.height });
      } catch (error) {
        reject(error);
      }
    };
    img.onerror = () => {
      reject(new Error('Failed to load output image source'));
    };
    img.src = source;
  });
}

function resetDocumentState({ width, height, background = 'transparent' } = {}) {
  const nextWidth = Math.max(64, Math.round(width || editor.getSize().width));
  const nextHeight = Math.max(64, Math.round(height || editor.getSize().height));

  pendingRestoredOutputViewState = null;
  editor.discardTransientState?.();
  editor.resizeArtboard(nextWidth, nextHeight);
  output.resizeArtboard(nextWidth, nextHeight, { preserveView: false });

  layersManager.clearAllLayers();
  layersManager.addLayer({
    name: 'Background',
    opacity: 1,
    visible: true,
    blendMode: 'normal',
    fillColor: background === 'white' ? 0xffffff : null
  });

  updateLayersUI();

  resetUndoHistory('Reset document');

  if (isComfyMode) {
    clearOutputPreview({ width: nextWidth, height: nextHeight });
  }
}

function exportMaskDataUrl() {
  const sourceCanvas = editor.snapshotCanvas();
  const sourceCtx = sourceCanvas.getContext('2d');
  const imageData = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const maskCanvas = document.createElement('canvas');
  const maskCtx = maskCanvas.getContext('2d');

  maskCanvas.width = sourceCanvas.width;
  maskCanvas.height = sourceCanvas.height;

  const maskData = maskCtx.createImageData(sourceCanvas.width, sourceCanvas.height);
  for (let i = 0; i < imageData.data.length; i += 4) {
    const value = 255 - imageData.data[i + 3];
    maskData.data[i] = value;
    maskData.data[i + 1] = value;
    maskData.data[i + 2] = value;
    maskData.data[i + 3] = 255;
  }

  maskCtx.putImageData(maskData, 0, 0);
  return maskCanvas.toDataURL('image/png');
}

function syncOutputFromEditor() {
  const canvas = editor.snapshotCanvas();
  output.showCanvas(canvas);
  hasOutputImage = true;
  updateCopyOutputButtonState();
}

function handleImageUpload(file) {
  const reader = new FileReader();

  reader.onload = async (e) => {
    try {
      const fileName = file.name.replace(/\.[^/.]+$/, '');
      await loadImageSource(e.target.result, {
        layerName: fileName || 'Uploaded Image',
        selectAfterAdd: true,
        activateTool: 'move'
      });
      notifySessionChanged('Upload image');

      if (window.undoRedoManager) {
        setTimeout(() => {
          window.undoRedoManager.captureSnapshot('Upload image: ' + fileName);
        }, 10);
      }
    } catch (error) {
      console.error('Failed to process uploaded image:', error);
      alert('Failed to upload image. Please try again.');
    }
  };

  reader.onerror = () => {
    console.error('Failed to read image file');
    alert('Failed to read image file. Please try again.');
  };

  reader.readAsDataURL(file);
}

// Expose undo/redo manager to the editor
window.undoRedoManager = undoRedoManager;

if (isComfyMode) {
  clearOutputPreview();
}

// ========== TOOLBAR AND TOOL MANAGEMENT ==========
const toolbar = document.getElementById('floatingToolbar');
const settings = document.getElementById('toolSettings');

let currentTool = 'brush';

// Persistent tool settings state
let toolSettings = buildDefaultRuntimeToolSettings();

const TOOL_DEFINITIONS = {
  brush: {
    label: 'Brush',
    settings: [
      { key: 'size', label: 'Size', type: 'range', min: 1, max: 256, step: 1, default: 8 },
      { key: 'hardness', label: 'Hardness', type: 'range', min: 0, max: 100, step: 1, default: 100 },
      { key: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 100, step: 1, default: 100 },
      { key: 'flow', label: 'Flow', type: 'range', min: 1, max: 100, step: 1, default: 100 },
      { key: 'spacing', label: 'Spacing', type: 'range', min: 1, max: 200, step: 1, default: 12 },
      {
        key: 'brushShape',
        label: 'Brush Shape',
        shortLabel: 'Shape',
        type: 'select',
        default: 'round',
        options: ['round', 'square', 'soft-round', 'flat'],
      },
      { key: 'smoothing', label: 'Smoothing', type: 'range', min: 0, max: 100, step: 1, default: 0 },
      {
        key: 'blendMode',
        label: 'Blend Mode',
        shortLabel: 'Blend',
        type: 'select',
        default: 'normal',
        options: ['normal', 'multiply', 'screen', 'overlay'],
      },
    ],
  },
  eraser: {
    label: 'Eraser',
    settings: [
      { key: 'size', label: 'Size', type: 'range', min: 1, max: 256, step: 1, default: 8 },
      { key: 'hardness', label: 'Hardness', type: 'range', min: 0, max: 100, step: 1, default: 100 },
      { key: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 100, step: 1, default: 100 },
      { key: 'flow', label: 'Flow', type: 'range', min: 1, max: 100, step: 1, default: 100 },
      { key: 'spacing', label: 'Spacing', type: 'range', min: 1, max: 200, step: 1, default: 14 },
      { key: 'eraseToTransparency', label: 'Erase To Transparency', shortLabel: 'To Alpha', type: 'toggle', default: true },
      { key: 'softEdge', label: 'Soft Edge', type: 'toggle', default: true },
    ],
  },
  dropper: {
    label: 'Eyedropper',
    settings: [
      {
        key: 'sampleSize',
        label: 'Sample Size',
        shortLabel: 'Sample',
        type: 'select',
        default: 'point',
        options: [
          { value: 'point', label: 'Point' },
          { value: '3x3', label: '3 x 3' },
          { value: '5x5', label: '5 x 5' },
          { value: '11x11', label: '11 x 11' },
        ],
      },
      {
        key: 'layerSource',
        label: 'Layer Source',
        shortLabel: 'Layers',
        type: 'select',
        default: 'current-layer',
        options: [
          { value: 'current-layer', label: 'Current Layer' },
          { value: 'all-layers', label: 'All Layers' },
        ],
      },
      { key: 'sampleMerged', label: 'Sample Merged', shortLabel: 'Merged', type: 'toggle', default: false },
      { key: 'averageSampling', label: 'Average Sampling', shortLabel: 'Average', type: 'toggle', default: false },
    ],
  },
  'paint-bucket': {
    label: 'Bucket',
    settings: [
      { key: 'tolerance', label: 'Tolerance', type: 'range', min: 0, max: 255, step: 1, default: 32 },
      { key: 'contiguous', label: 'Contiguous', type: 'toggle', default: true },
      { key: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 100, step: 1, default: 100 },
      {
        key: 'blendMode',
        label: 'Blend Mode',
        shortLabel: 'Blend',
        type: 'select',
        default: 'normal',
        options: ['normal', 'multiply', 'screen', 'overlay'],
      },
      { key: 'allLayers', label: 'All Layers', shortLabel: 'Layers', type: 'toggle', default: false },
      { key: 'antiAlias', label: 'Anti Alias', shortLabel: 'AA', type: 'toggle', default: true },
    ],
  },
  marquee: {
    label: 'Marquee',
    settings: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        default: 'rectangle',
        options: ['rectangle', 'ellipse'],
      },
      { key: 'feather', label: 'Feather', type: 'range', min: 0, max: 100, step: 1, default: 0 },
      { key: 'antiAlias', label: 'Anti Alias', shortLabel: 'AA', type: 'toggle', default: true },
      { key: 'fixedSize', label: 'Fixed Size', shortLabel: 'Fixed', type: 'toggle', default: false },
      {
        key: 'fixedWidth',
        label: 'Fixed Width',
        shortLabel: 'W',
        type: 'range',
        min: 1,
        max: 4096,
        step: 1,
        default: 256,
        isDisabled: (toolState) => toolState.fixedSize !== true,
      },
      {
        key: 'fixedHeight',
        label: 'Fixed Height',
        shortLabel: 'H',
        type: 'range',
        min: 1,
        max: 4096,
        step: 1,
        default: 256,
        isDisabled: (toolState) => toolState.fixedSize !== true,
      },
      {
        key: 'fixedRatio',
        label: 'Fixed Ratio',
        shortLabel: 'Ratio',
        type: 'select',
        default: 'free',
        isDisabled: (toolState) => toolState.fixedSize !== true,
        options: [
          { value: 'free', label: 'Free' },
          { value: '1:1', label: '1 : 1' },
          { value: '4:3', label: '4 : 3' },
          { value: '16:9', label: '16 : 9' },
          { value: '3:2', label: '3 : 2' },
        ],
      },
      {
        key: 'selectionOperation',
        label: 'Selection',
        shortLabel: 'Select',
        type: 'select',
        default: 'replace',
        options: ['replace', 'add', 'subtract', 'intersect'],
      },
    ],
  },
  lasso: {
    label: 'Lasso',
    settings: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        default: 'freehand',
        options: ['freehand', 'polygonal', 'magnetic'],
      },
      { key: 'feather', label: 'Feather', type: 'range', min: 0, max: 100, step: 1, default: 0 },
      { key: 'antiAlias', label: 'Anti Alias', shortLabel: 'AA', type: 'toggle', default: true },
      { key: 'edgeDetection', label: 'Edge Detection', shortLabel: 'Edge', type: 'range', min: 0, max: 100, step: 1, default: 50 },
      {
        key: 'selectionOperation',
        label: 'Selection',
        shortLabel: 'Select',
        type: 'select',
        default: 'replace',
        options: ['replace', 'add', 'subtract', 'intersect'],
      },
    ],
  },
  pen: {
    label: 'Pen',
    settings: [
      {
        key: 'pathMode',
        label: 'Path Mode',
        shortLabel: 'Path',
        type: 'select',
        default: 'path',
        options: [
          { value: 'path', label: 'Path' },
          { value: 'selection', label: 'Selection' },
          { value: 'mask', label: 'Mask' },
        ],
      },
      {
        key: 'shapeMode',
        label: 'Shape Mode',
        shortLabel: 'Shape',
        type: 'select',
        default: 'path',
        options: [
          { value: 'path', label: 'Path' },
          { value: 'filled-shape', label: 'Filled Shape' },
          { value: 'stroked-shape', label: 'Stroked Shape' },
        ],
      },
      { key: 'strokeColor', label: 'Stroke Color', shortLabel: 'Stroke', type: 'color', default: '#f7a8b8' },
      { key: 'fillColor', label: 'Fill Color', shortLabel: 'Fill', type: 'color', default: '#55cdfc' },
      { key: 'strokeWidth', label: 'Stroke Width', shortLabel: 'Width', type: 'range', min: 1, max: 64, step: 1, default: 4 },
      { key: 'anchorEdit', label: 'Anchor Edit', shortLabel: 'Anchors', type: 'toggle', default: true },
      {
        key: 'curveHandles',
        label: 'Curve Handles',
        shortLabel: 'Handles',
        type: 'select',
        default: 'mirrored',
        options: ['mirrored', 'independent', 'automatic'],
      },
      { key: 'closePath', label: 'Close Path', shortLabel: 'Close', type: 'toggle', default: false },
    ],
  },
  move: {
    label: 'Move / Scale / Rotate',
    settings: [
      {
        key: 'transformMode',
        label: 'Transform',
        shortLabel: 'Mode',
        type: 'select',
        default: 'move',
        options: ['move', 'scale', 'rotate'],
      },
      { key: 'uniformScale', label: 'Uniform Scale', shortLabel: 'Uniform', type: 'toggle', default: true },
      {
        key: 'pivotPoint',
        label: 'Pivot Point',
        shortLabel: 'Pivot',
        type: 'select',
        default: 'center',
        options: [
          { value: 'center', label: 'Center' },
          { value: 'top-left', label: 'Top Left' },
          { value: 'top-right', label: 'Top Right' },
          { value: 'bottom-left', label: 'Bottom Left' },
          { value: 'bottom-right', label: 'Bottom Right' },
          { value: 'custom', label: 'Custom' },
        ],
      },
      { key: 'snap', label: 'Snap', type: 'toggle', default: false },
      {
        key: 'angle',
        label: 'Angle',
        type: 'number',
        min: 0,
        max: 360,
        step: 1,
        default: 0,
        isDisabled: (_toolState, uiContext) => uiContext.hasSelection !== true,
      },
      {
        key: 'width',
        label: 'Width',
        type: 'number',
        min: 1,
        max: 4096,
        step: 1,
        default: 1024,
        isDisabled: (_toolState, uiContext) => uiContext.hasSelection !== true,
      },
      {
        key: 'height',
        label: 'Height',
        type: 'number',
        min: 1,
        max: 4096,
        step: 1,
        default: 1024,
        isDisabled: (_toolState, uiContext) => uiContext.hasSelection !== true,
      },
      {
        key: 'flipHorizontal',
        label: 'Flip Horizontal',
        shortLabel: 'Flip H',
        type: 'toggle',
        default: false,
        isDisabled: (_toolState, uiContext) => uiContext.hasSelection !== true,
      },
      {
        key: 'flipVertical',
        label: 'Flip Vertical',
        shortLabel: 'Flip V',
        type: 'toggle',
        default: false,
        isDisabled: (_toolState, uiContext) => uiContext.hasSelection !== true,
      },
    ],
  },
  text: {
    label: 'Text',
    settings: [
      {
        key: 'fontFamily',
        label: 'Font Family',
        shortLabel: 'Font',
        type: 'select',
        default: 'space-grotesk',
        options: [
          { value: 'space-grotesk', label: 'Space Grotesk' },
          { value: 'jetbrains-mono', label: 'JetBrains Mono' },
          { value: 'source-serif', label: 'Source Serif' },
          { value: 'system-sans', label: 'System Sans' },
        ],
      },
      { key: 'fontSize', label: 'Font Size', shortLabel: 'Size', type: 'range', min: 8, max: 240, step: 1, default: 48 },
      { key: 'bold', label: 'Bold', type: 'toggle', default: false },
      { key: 'italic', label: 'Italic', type: 'toggle', default: false },
      {
        key: 'alignment',
        label: 'Alignment',
        shortLabel: 'Align',
        type: 'select',
        default: 'left',
        options: ['left', 'center', 'right', 'justify'],
      },
      { key: 'color', label: 'Color', type: 'color', default: '#f5f7fa' },
      { key: 'lineHeight', label: 'Line Height', shortLabel: 'Line', type: 'range', min: 80, max: 240, step: 1, default: 120 },
      { key: 'letterSpacing', label: 'Letter Spacing', shortLabel: 'Track', type: 'range', min: -10, max: 40, step: 1, default: 0 },
      {
        key: 'warp',
        label: 'Warp',
        type: 'select',
        default: 'none',
        options: ['none', 'arc', 'flag', 'bulge'],
      },
      { key: 'fixedWidth', label: 'Fixed Width', shortLabel: 'Wrap', type: 'toggle', default: false },
      {
        key: 'textBoxWidth',
        label: 'Text Box Width',
        shortLabel: 'Box',
        type: 'range',
        min: 80,
        max: 1200,
        step: 10,
        default: 420,
        isDisabled: (toolState) => toolState.fixedWidth !== true,
      },
    ],
  },
  'magic-wand': {
    label: 'Magic Wand',
    settings: [
      { key: 'tolerance', label: 'Tolerance', type: 'range', min: 0, max: 255, step: 1, default: 24 },
      { key: 'contiguous', label: 'Contiguous', type: 'toggle', default: true },
      { key: 'antiAlias', label: 'Anti Alias', shortLabel: 'AA', type: 'toggle', default: true },
      { key: 'allLayers', label: 'All Layers', shortLabel: 'Layers', type: 'toggle', default: false },
      { key: 'sampleMerged', label: 'Sample Merged', shortLabel: 'Merged', type: 'toggle', default: false },
      {
        key: 'selectionOperation',
        label: 'Selection',
        shortLabel: 'Select',
        type: 'select',
        default: 'replace',
        options: ['replace', 'add', 'subtract', 'intersect'],
      },
    ],
  },
};

const AVAILABLE_TOOL_IDS = Object.keys(TOOL_DEFINITIONS);

function isSelectionAwareTool(toolId) {
  return SELECTION_AWARE_TOOL_IDS.has(toolId);
}

function getToolUiContext() {
  const moveState = typeof editor.getMoveState === 'function'
    ? editor.getMoveState()
    : { hasSelection: typeof editor.hasSelection === 'function' && editor.hasSelection() };
  return {
    hasSelection: moveState?.hasSelection === true,
    moveState,
    isMaskEditing: layersManager?.getActiveEditTarget?.() === 'mask',
  };
}

function normalizeSelectOptions(options = []) {
  return options.map((option) => {
    if (typeof option === 'string') {
      return {
        value: option,
        label: titleCaseToken(option),
      };
    }
    return option;
  });
}

function buildDefaultToolControlState() {
  return Object.fromEntries(
    Object.entries(TOOL_DEFINITIONS).map(([toolId, definition]) => [
      toolId,
      Object.fromEntries(definition.settings.map((setting) => [setting.key, setting.default])),
    ])
  );
}

function normalizeToolControlState(rawState = {}) {
  const normalized = buildDefaultToolControlState();

  Object.entries(TOOL_DEFINITIONS).forEach(([toolId, definition]) => {
    const rawToolState = typeof rawState?.[toolId] === 'object' && rawState[toolId] !== null
      ? rawState[toolId]
      : {};

    definition.settings.forEach((setting) => {
      const rawValue = rawToolState[setting.key];
      let nextValue = setting.default;

      if (setting.type === 'range' || setting.type === 'number') {
        nextValue = clampNumber(rawValue, {
          min: setting.min ?? -Infinity,
          max: setting.max ?? Infinity,
          fallback: setting.default,
        });
      } else if (setting.type === 'toggle') {
        nextValue = rawValue === undefined ? setting.default : rawValue === true;
      } else if (setting.type === 'color') {
        nextValue = sanitizeHexColor(rawValue, setting.default);
      } else if (setting.type === 'select') {
        const validValues = new Set(normalizeSelectOptions(setting.options).map((option) => option.value));
        nextValue = validValues.has(rawValue) ? rawValue : setting.default;
      }

      normalized[toolId][setting.key] = nextValue;
    });
  });

  return normalized;
}

let toolControlState = buildDefaultToolControlState();

function syncToolControlStateFromRuntimeSettings() {
  toolSettings.brush.size = clampNumber(toolControlState.brush.size, { min: 1, max: 256, fallback: toolSettings.brush.size });
  toolSettings.brush.hardness = clampNumber(toolControlState.brush.hardness, { min: 0, max: 100, fallback: toolSettings.brush.hardness });
  toolSettings.brush.opacity = clampNumber(toolControlState.brush.opacity, { min: 0, max: 100, fallback: toolSettings.brush.opacity });
  toolSettings.brush.flow = clampNumber(toolControlState.brush.flow, { min: 1, max: 100, fallback: toolSettings.brush.flow });
  toolSettings.brush.spacing = clampNumber(toolControlState.brush.spacing, { min: 1, max: 200, fallback: toolSettings.brush.spacing });
  toolSettings.brush.brushShape = normalizeOptionValue(toolControlState.brush.brushShape, BRUSH_SHAPE_OPTIONS, toolSettings.brush.brushShape);
  toolSettings.brush.smoothing = clampNumber(toolControlState.brush.smoothing, { min: 0, max: 100, fallback: toolSettings.brush.smoothing });
  toolSettings.brush.blendMode = normalizeOptionValue(toolControlState.brush.blendMode, BRUSH_BLEND_MODE_OPTIONS, toolSettings.brush.blendMode);
  toolSettings.brush.feather = clampNumber(100 - toolSettings.brush.hardness, { min: 0, max: 100, fallback: toolSettings.brush.feather });

  toolControlState.brush.size = toolSettings.brush.size;
  toolControlState.brush.hardness = toolSettings.brush.hardness;
  toolControlState.brush.opacity = toolSettings.brush.opacity;
  toolControlState.brush.flow = toolSettings.brush.flow;
  toolControlState.brush.spacing = toolSettings.brush.spacing;
  toolControlState.brush.brushShape = toolSettings.brush.brushShape;
  toolControlState.brush.smoothing = toolSettings.brush.smoothing;
  toolControlState.brush.blendMode = toolSettings.brush.blendMode;

  toolSettings.eraser.size = clampNumber(toolControlState.eraser.size, { min: 1, max: 256, fallback: toolSettings.eraser.size });
  toolSettings.eraser.hardness = clampNumber(toolControlState.eraser.hardness, { min: 0, max: 100, fallback: toolSettings.eraser.hardness });
  toolSettings.eraser.opacity = clampNumber(toolControlState.eraser.opacity, { min: 0, max: 100, fallback: toolSettings.eraser.opacity });
  toolSettings.eraser.flow = clampNumber(toolControlState.eraser.flow, { min: 1, max: 100, fallback: toolSettings.eraser.flow });
  toolSettings.eraser.spacing = clampNumber(toolControlState.eraser.spacing, { min: 1, max: 200, fallback: toolSettings.eraser.spacing });
  toolSettings.eraser.eraseToTransparency = toolControlState.eraser.eraseToTransparency === undefined
    ? toolSettings.eraser.eraseToTransparency
    : toolControlState.eraser.eraseToTransparency === true;
  toolSettings.eraser.softEdge = toolControlState.eraser.softEdge === undefined
    ? toolSettings.eraser.softEdge
    : toolControlState.eraser.softEdge === true;
  toolSettings.eraser.feather = clampNumber(100 - toolSettings.eraser.hardness, { min: 0, max: 100, fallback: toolSettings.eraser.feather });

  toolControlState.eraser.size = toolSettings.eraser.size;
  toolControlState.eraser.hardness = toolSettings.eraser.hardness;
  toolControlState.eraser.opacity = toolSettings.eraser.opacity;
  toolControlState.eraser.flow = toolSettings.eraser.flow;
  toolControlState.eraser.spacing = toolSettings.eraser.spacing;
  toolControlState.eraser.eraseToTransparency = toolSettings.eraser.eraseToTransparency;
  toolControlState.eraser.softEdge = toolSettings.eraser.softEdge;
}

syncToolControlStateFromRuntimeSettings();

function buildBrushConfig() {
  const brushState = toolControlState.brush || {};
  return {
    colorHex: toolSettings.brush.color,
    size: clampNumber(brushState.size, { min: 1, max: 256, fallback: toolSettings.brush.size }),
    hardness: clampNumber(brushState.hardness, { min: 0, max: 100, fallback: toolSettings.brush.hardness }),
    opacity: clampNumber(brushState.opacity, { min: 0, max: 100, fallback: toolSettings.brush.opacity }),
    flow: clampNumber(brushState.flow, { min: 1, max: 100, fallback: toolSettings.brush.flow }),
    spacing: clampNumber(brushState.spacing, { min: 1, max: 200, fallback: toolSettings.brush.spacing }),
    brushShape: normalizeOptionValue(brushState.brushShape, BRUSH_SHAPE_OPTIONS, toolSettings.brush.brushShape),
    smoothing: clampNumber(brushState.smoothing, { min: 0, max: 100, fallback: toolSettings.brush.smoothing }),
    blendMode: normalizeOptionValue(brushState.blendMode, BRUSH_BLEND_MODE_OPTIONS, toolSettings.brush.blendMode),
  };
}

function buildEraserConfig() {
  const eraserState = toolControlState.eraser || {};
  return {
    size: clampNumber(eraserState.size, { min: 1, max: 256, fallback: toolSettings.eraser.size }),
    hardness: clampNumber(eraserState.hardness, { min: 0, max: 100, fallback: toolSettings.eraser.hardness }),
    opacity: clampNumber(eraserState.opacity, { min: 0, max: 100, fallback: toolSettings.eraser.opacity }),
    flow: clampNumber(eraserState.flow, { min: 1, max: 100, fallback: toolSettings.eraser.flow }),
    spacing: clampNumber(eraserState.spacing, { min: 1, max: 200, fallback: toolSettings.eraser.spacing }),
    eraseToTransparency: eraserState.eraseToTransparency === undefined
      ? toolSettings.eraser.eraseToTransparency
      : eraserState.eraseToTransparency === true,
    softEdge: eraserState.softEdge === undefined
      ? toolSettings.eraser.softEdge
      : eraserState.softEdge === true,
  };
}

function buildDropperConfig() {
  const dropperState = toolControlState.dropper || {};
  return {
    sampleSize: normalizeOptionValue(dropperState.sampleSize, DROPPER_SAMPLE_SIZE_OPTIONS, 'point'),
    layerSource: normalizeOptionValue(dropperState.layerSource, DROPPER_LAYER_SOURCE_OPTIONS, 'current-layer'),
    sampleMerged: dropperState.sampleMerged === undefined ? false : dropperState.sampleMerged === true,
    averageSampling: dropperState.averageSampling === undefined ? false : dropperState.averageSampling === true,
  };
}

function buildBucketConfig() {
  const bucketState = toolControlState['paint-bucket'] || {};
  return {
    colorHex: toolSettings.brush.color,
    tolerance: clampNumber(bucketState.tolerance, { min: 0, max: 255, fallback: 32 }),
    contiguous: bucketState.contiguous === undefined ? true : bucketState.contiguous === true,
    opacity: clampNumber(bucketState.opacity, { min: 0, max: 100, fallback: 100 }),
    blendMode: normalizeOptionValue(bucketState.blendMode, BUCKET_BLEND_MODE_OPTIONS, 'normal'),
    allLayers: bucketState.allLayers === undefined ? false : bucketState.allLayers === true,
    antiAlias: bucketState.antiAlias === undefined ? true : bucketState.antiAlias === true,
  };
}

function buildMagicWandConfig() {
  const magicWandState = toolControlState['magic-wand'] || {};
  return {
    tolerance: clampNumber(magicWandState.tolerance, { min: 0, max: 255, fallback: 24 }),
    contiguous: magicWandState.contiguous === undefined ? true : magicWandState.contiguous === true,
    antiAlias: magicWandState.antiAlias === undefined ? true : magicWandState.antiAlias === true,
    allLayers: magicWandState.allLayers === undefined ? false : magicWandState.allLayers === true,
    sampleMerged: magicWandState.sampleMerged === undefined ? false : magicWandState.sampleMerged === true,
    selectionOperation: normalizeOptionValue(magicWandState.selectionOperation, SELECTION_OPERATION_OPTIONS, 'replace'),
  };
}

function buildMarqueeConfig() {
  const marqueeState = toolControlState.marquee || {};
  return {
    mode: normalizeOptionValue(marqueeState.mode, MARQUEE_MODE_OPTIONS, 'rectangle'),
    feather: clampNumber(marqueeState.feather, { min: 0, max: 100, fallback: 0 }),
    antiAlias: marqueeState.antiAlias === undefined ? true : marqueeState.antiAlias === true,
    fixedSize: marqueeState.fixedSize === undefined ? false : marqueeState.fixedSize === true,
    fixedWidth: clampNumber(marqueeState.fixedWidth, { min: 1, max: 4096, fallback: 256 }),
    fixedHeight: clampNumber(marqueeState.fixedHeight, { min: 1, max: 4096, fallback: 256 }),
    fixedRatio: normalizeOptionValue(marqueeState.fixedRatio, MARQUEE_RATIO_OPTIONS, 'free'),
    selectionOperation: normalizeOptionValue(marqueeState.selectionOperation, SELECTION_OPERATION_OPTIONS, 'replace'),
  };
}

function buildLassoConfig() {
  const lassoState = toolControlState.lasso || {};
  return {
    mode: normalizeOptionValue(lassoState.mode, LASSO_MODE_OPTIONS, 'freehand'),
    feather: clampNumber(lassoState.feather, { min: 0, max: 100, fallback: 0 }),
    antiAlias: lassoState.antiAlias === undefined ? true : lassoState.antiAlias === true,
    edgeDetection: clampNumber(lassoState.edgeDetection, { min: 0, max: 100, fallback: 50 }),
    selectionOperation: normalizeOptionValue(lassoState.selectionOperation, SELECTION_OPERATION_OPTIONS, 'replace'),
  };
}

function buildPenConfig() {
  const penState = toolControlState.pen || {};
  return {
    pathMode: normalizeOptionValue(penState.pathMode, PEN_PATH_MODE_OPTIONS, 'path'),
    shapeMode: normalizeOptionValue(penState.shapeMode, PEN_SHAPE_MODE_OPTIONS, 'path'),
    strokeColor: sanitizeHexColor(penState.strokeColor, '#f7a8b8'),
    fillColor: sanitizeHexColor(penState.fillColor, '#55cdfc'),
    strokeWidth: clampNumber(penState.strokeWidth, { min: 1, max: 64, fallback: 4 }),
    anchorEdit: penState.anchorEdit === undefined ? true : penState.anchorEdit === true,
    curveHandles: normalizeOptionValue(penState.curveHandles, PEN_CURVE_HANDLE_OPTIONS, 'mirrored'),
    closePath: penState.closePath === undefined ? false : penState.closePath === true,
  };
}

function buildTextConfig() {
  const textState = toolControlState.text || {};
  return {
    fontFamily: normalizeOptionValue(textState.fontFamily, TEXT_FONT_FAMILY_OPTIONS, 'space-grotesk'),
    fontSize: clampNumber(textState.fontSize, { min: 8, max: 240, fallback: 48 }),
    bold: textState.bold === undefined ? false : textState.bold === true,
    italic: textState.italic === undefined ? false : textState.italic === true,
    alignment: normalizeOptionValue(textState.alignment, TEXT_ALIGNMENT_OPTIONS, 'left'),
    color: sanitizeHexColor(textState.color, '#f5f7fa'),
    lineHeight: clampNumber(textState.lineHeight, { min: 80, max: 240, fallback: 120 }),
    letterSpacing: clampNumber(textState.letterSpacing, { min: -10, max: 40, fallback: 0 }),
    warp: normalizeOptionValue(textState.warp, TEXT_WARP_OPTIONS, 'none'),
    fixedWidth: textState.fixedWidth === undefined ? false : textState.fixedWidth === true,
    textBoxWidth: clampNumber(textState.textBoxWidth, { min: 80, max: 1200, fallback: 420 }),
  };
}

function buildMoveConfig() {
  const moveState = toolControlState.move || {};
  return {
    transformMode: normalizeOptionValue(moveState.transformMode, MOVE_TRANSFORM_MODE_OPTIONS, 'move'),
    uniformScale: moveState.uniformScale === undefined ? true : moveState.uniformScale === true,
    pivotPoint: normalizeOptionValue(moveState.pivotPoint, MOVE_PIVOT_POINT_OPTIONS, 'center'),
    snap: moveState.snap === undefined ? false : moveState.snap === true,
    angle: clampNumber(moveState.angle, { min: 0, max: 360, fallback: 0 }),
    width: clampNumber(moveState.width, { min: 1, max: 4096, fallback: NaN }),
    height: clampNumber(moveState.height, { min: 1, max: 4096, fallback: NaN }),
    flipHorizontal: moveState.flipHorizontal === undefined ? false : moveState.flipHorizontal === true,
    flipVertical: moveState.flipVertical === undefined ? false : moveState.flipVertical === true,
  };
}

function syncMoveControlStateFromEditor(moveState = null) {
  if (typeof editor.getMoveState !== 'function' || !toolControlState.move) {
    return;
  }

  const nextMoveState = moveState || editor.getMoveState();
  if (!nextMoveState?.hasSelection) {
    return;
  }

  toolControlState.move.transformMode = nextMoveState.transformMode;
  toolControlState.move.uniformScale = nextMoveState.uniformScale;
  toolControlState.move.pivotPoint = nextMoveState.pivotPoint;
  toolControlState.move.snap = nextMoveState.snap;
  toolControlState.move.angle = Math.round(nextMoveState.angle);
  toolControlState.move.width = Math.max(1, Math.round(nextMoveState.width));
  toolControlState.move.height = Math.max(1, Math.round(nextMoveState.height));
  toolControlState.move.flipHorizontal = nextMoveState.flipHorizontal === true;
  toolControlState.move.flipVertical = nextMoveState.flipVertical === true;
}

function syncTextControlStateFromEditor(textState = null) {
  if (!toolControlState.text) {
    return;
  }

  const nextTextState = textState || buildTextConfig();
  toolControlState.text.fontFamily = nextTextState.fontFamily;
  toolControlState.text.fontSize = Math.max(8, Math.round(nextTextState.fontSize));
  toolControlState.text.bold = nextTextState.bold === true;
  toolControlState.text.italic = nextTextState.italic === true;
  toolControlState.text.alignment = nextTextState.alignment;
  toolControlState.text.color = nextTextState.color;
  toolControlState.text.lineHeight = Math.max(80, Math.round(nextTextState.lineHeight));
  toolControlState.text.letterSpacing = Math.round(nextTextState.letterSpacing);
  toolControlState.text.warp = nextTextState.warp;
  toolControlState.text.fixedWidth = nextTextState.fixedWidth === true;
  toolControlState.text.textBoxWidth = Math.max(80, Math.round(nextTextState.textBoxWidth));
}

function resetToolUiState({ notify = false } = {}) {
  toolSettings = buildDefaultRuntimeToolSettings();
  toolControlState = buildDefaultToolControlState();
  syncToolControlStateFromRuntimeSettings();

  if (topbarColor) {
    topbarColor.value = toolSettings.brush.color;
    syncColorCircleBackground();
  }

  editor.setBrush(buildBrushConfig());
  editor.setEraser(buildEraserConfig());
  editor.setDropper(buildDropperConfig());
  editor.setBucket(buildBucketConfig());
  editor.setMagicWand(buildMagicWandConfig());
  editor.setMarquee(buildMarqueeConfig());
  editor.setLasso(buildLassoConfig());
  editor.setPen(buildPenConfig());
  editor.setText(buildTextConfig());
  editor.setMove(buildMoveConfig());
  setActiveTool('brush', { notify: false });

  if (notify) {
    notifySessionChanged('Tool settings reset');
  }
}

function getToolSettingUnit(toolId, setting) {
  const explicitUnit = typeof setting.unit === 'string' ? setting.unit : '';
  if (explicitUnit) {
    return explicitUnit;
  }

  switch (`${toolId}:${setting.key}`) {
    case 'brush:size':
    case 'eraser:size':
    case 'marquee:feather':
    case 'marquee:fixedWidth':
    case 'marquee:fixedHeight':
    case 'lasso:feather':
    case 'pen:strokeWidth':
    case 'text:fontSize':
    case 'text:letterSpacing':
    case 'text:textBoxWidth':
    case 'move:width':
    case 'move:height':
      return 'px';
    case 'brush:hardness':
    case 'brush:opacity':
    case 'brush:flow':
    case 'brush:spacing':
    case 'brush:smoothing':
    case 'eraser:hardness':
    case 'eraser:opacity':
    case 'eraser:flow':
    case 'eraser:spacing':
    case 'paint-bucket:opacity':
    case 'lasso:edgeDetection':
    case 'text:lineHeight':
      return '%';
    case 'move:angle':
      return 'deg';
    default:
      return '';
  }
}

// Initialize tool button event handlers
const toolButtons = [...toolbar.querySelectorAll('.tool-btn')];
toolButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;
    setActiveTool(tool, { notify: true });
  });
});

const MASK_EDIT_PRIMARY_TOOL = 'brush';

function isMaskEditingTarget() {
  return layersManager?.getActiveEditTarget?.() === 'mask';
}

function normalizeToolForCurrentEditTarget(tool) {
  if (!tool) {
    return tool;
  }

  if (isMaskEditingTarget()) {
    return MASK_EDIT_PRIMARY_TOOL;
  }

  return tool;
}

function syncMaskEditingToolAvailability() {
  const isMaskEditing = isMaskEditingTarget();

  toolButtons.forEach((btn) => {
    const isAvailable = !isMaskEditing || btn.dataset.tool === MASK_EDIT_PRIMARY_TOOL;
    btn.disabled = !isAvailable;
    btn.classList.toggle('is-disabled', !isAvailable);
    btn.setAttribute('aria-disabled', isAvailable ? 'false' : 'true');
  });

  if (topbarColor) {
    topbarColor.value = isMaskEditing
      ? toMaskGrayscaleHex(toolSettings.brush.color)
      : toolSettings.brush.color;
    syncColorCircleBackground();
    const colorLabel = isMaskEditing
      ? 'Mask brush tone - black hides, white reveals, gray is partial'
      : 'Select drawing color';
    topbarColor.title = colorLabel;
    topbarColor.setAttribute('aria-label', colorLabel);
    if (topbarColorBtn) {
      topbarColorBtn.title = colorLabel;
      topbarColorBtn.setAttribute('aria-label', colorLabel);
    }
  }
}

function createToolSettingRow(labelText, control, valueText = '', titleText = '') {
  const label = document.createElement('label');
  label.className = 'tool-setting-row';
  if (titleText && titleText !== labelText) {
    label.title = titleText;
  }

  const title = document.createElement('span');
  title.className = 'tool-setting-label';
  title.textContent = labelText;
  label.appendChild(title);
  label.appendChild(control);

  if (valueText) {
    const value = document.createElement('span');
      value.textContent = valueText;
    value.dataset.role = 'value';
    value.className = 'tool-setting-value';
    label.appendChild(value);
  }

  return label;
}

function createNumericSettingRow(labelText, {
  min,
  max,
  step = 1,
  value,
  unit = '',
  onInput,
  disabled = false,
}, titleText = '', variantClass = 'is-number') {
  const field = document.createElement('div');
  field.className = 'tool-setting-input-wrap';

  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.inputMode = 'decimal';
  input.setAttribute('aria-label', titleText || labelText);
  input.className = 'tool-setting-number-input';
  input.disabled = disabled === true;

  field.appendChild(input);

  if (unit) {
    const suffix = document.createElement('span');
    suffix.className = 'tool-setting-unit';
    suffix.textContent = unit;
    field.appendChild(suffix);
  }

  let currentValue = value;
  const numericStep = Number(step) || 1;
  const stepPrecision = String(step).includes('.') ? String(step).split('.')[1].length : 0;

  const normalizeValue = rawValue => {
    const nextValue = clampNumber(rawValue, { min, max, fallback: currentValue });
    return stepPrecision > 0 ? Number(nextValue.toFixed(stepPrecision)) : nextValue;
  };

  const applyValue = nextValue => {
    currentValue = normalizeValue(nextValue);
    input.value = String(currentValue);
    onInput(currentValue);
  };

  const stepper = document.createElement('div');
  stepper.className = 'tool-setting-stepper';

  const createStepButton = (direction, labelSuffix, path) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tool-setting-step-btn ${direction > 0 ? 'is-up' : 'is-down'}`;
    button.setAttribute('aria-label', `${labelSuffix} ${titleText || labelText}`);
    button.disabled = input.disabled;
    button.innerHTML = `
      <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        <path d="${path}" />
      </svg>
    `;
    button.addEventListener('pointerdown', event => {
      event.preventDefault();
    });
    button.addEventListener('click', event => {
      event.preventDefault();
      applyValue(currentValue + (numericStep * direction));
    });
    return button;
  };

  stepper.appendChild(createStepButton(1, 'Increase', 'M2 6.5L5 3.5L8 6.5'));
  stepper.appendChild(createStepButton(-1, 'Decrease', 'M2 3.5L5 6.5L8 3.5'));
  field.appendChild(stepper);

  input.addEventListener('input', () => {
    if (input.value === '' || input.value === '-' || input.value === '.' || input.value === '-.') {
      return;
    }
    const parsedValue = Number(input.value);
    if (!Number.isFinite(parsedValue)) {
      return;
    }
    currentValue = normalizeValue(parsedValue);
    onInput(currentValue);
  });

  const commitValue = () => {
    applyValue(input.value);
  };

  input.addEventListener('change', commitValue);
  input.addEventListener('blur', commitValue);

  const row = createToolSettingRow(labelText, field, '', titleText);
  if (unit) {
    row.classList.add('has-unit');
  }
  row.classList.toggle('is-disabled', input.disabled);
  row.classList.add(variantClass);
  return row;
}

function createRangeSetting(labelText, config, titleText = '') {
  return createNumericSettingRow(labelText, config, titleText, 'is-range');
}

function createColorSetting(labelText, value, onInput, titleText = '', disabled = false) {
  const input = document.createElement('input');
  input.type = 'color';
  input.value = value;
  input.setAttribute('aria-label', labelText);
  input.disabled = disabled === true;
  input.addEventListener('input', () => {
    onInput(input.value);
  });

  const row = createToolSettingRow(labelText, input, '', titleText);
  row.classList.toggle('is-disabled', input.disabled);
  row.classList.add('is-color');
  return row;
}

function createSelectSetting(labelText, value, options, onInput, titleText = '', disabled = false) {
  const input = document.createElement('select');
  normalizeSelectOptions(options).forEach((option) => {
    const optionElement = document.createElement('option');
    optionElement.value = option.value;
    optionElement.textContent = option.label;
    optionElement.selected = option.value === value;
    input.appendChild(optionElement);
  });
  input.disabled = disabled === true;

  input.addEventListener('input', () => {
    onInput(input.value);
  });

  const row = createToolSettingRow(labelText, input, '', titleText);
  row.classList.toggle('is-disabled', input.disabled);
  row.classList.add('is-select');
  return row;
}

function createToggleSetting(labelText, value, onInput, titleText = '', disabled = false) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value === true;
  input.disabled = disabled === true;
  input.addEventListener('input', () => {
    onInput(input.checked);
  });

  const row = createToolSettingRow(labelText, input, '', titleText);
  row.classList.toggle('is-disabled', input.disabled);
  row.classList.add('is-toggle');
  return row;
}

function createNumberSetting(labelText, { min, max, step = 1, value, unit = '', onInput, disabled = false }, titleText = '') {
  return createNumericSettingRow(labelText, { min, max, step, value, unit, onInput, disabled }, titleText, 'is-number');
}

function createToolActionButton(labelText, onClick, {
  titleText = '',
  disabled = false,
  tone = 'secondary',
} = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tool-settings-action-btn';
  if (tone === 'danger') {
    button.classList.add('is-danger');
  }
  button.textContent = labelText;
  button.disabled = disabled === true;
  button.setAttribute('aria-label', titleText || labelText);
  if (titleText) {
    button.title = titleText;
  }
  button.addEventListener('click', (event) => {
    event.preventDefault();
    onClick?.();
  });
  return button;
}

function createToolActionRow(actions = []) {
  const row = document.createElement('div');
  row.className = 'tool-settings-actions';
  actions.forEach((action) => {
    row.appendChild(createToolActionButton(action.label, action.onClick, action));
  });
  return row;
}

function createToolSettingNotice(message) {
  const note = document.createElement('div');
  note.className = 'tool-setting-notice';
  note.textContent = message;
  return note;
}

function updateToolControlValue(tool, setting, value) {
  if (!toolControlState[tool]) {
    toolControlState[tool] = {};
  }

  toolControlState[tool][setting.key] = value;

  if (tool === 'brush') {
    toolSettings.brush[setting.key] = value;
    if (setting.key === 'hardness') {
      toolSettings.brush.feather = clampNumber(100 - value, { min: 0, max: 100, fallback: toolSettings.brush.feather });
    }
    if (currentTool === 'brush') {
      editor.setBrush(buildBrushConfig());
    }
  } else if (tool === 'eraser') {
    toolSettings.eraser[setting.key] = value;
    if (setting.key === 'hardness') {
      toolSettings.eraser.feather = clampNumber(100 - value, { min: 0, max: 100, fallback: toolSettings.eraser.feather });
    }
    if (currentTool === 'eraser') {
      editor.setEraser(buildEraserConfig());
    }
  } else if (tool === 'dropper' && currentTool === 'dropper') {
    editor.setDropper(buildDropperConfig());
  } else if (tool === 'paint-bucket' && currentTool === 'paint-bucket') {
    editor.setBucket(buildBucketConfig());
  } else if (tool === 'magic-wand' && currentTool === 'magic-wand') {
    editor.setMagicWand(buildMagicWandConfig());
  } else if (tool === 'marquee' && currentTool === 'marquee') {
    editor.setMarquee(buildMarqueeConfig());
  } else if (tool === 'lasso' && currentTool === 'lasso') {
    editor.setLasso(buildLassoConfig());
  } else if (tool === 'pen' && currentTool === 'pen') {
    editor.setPen(buildPenConfig());
  } else if (tool === 'text' && currentTool === 'text') {
    editor.setText(buildTextConfig());
  } else if (tool === 'move' && currentTool === 'move') {
    editor.setMove(buildMoveConfig());
    syncMoveControlStateFromEditor();
  }

  notifySessionChanged(`${TOOL_DEFINITIONS[tool]?.label || titleCaseToken(tool)} ${setting.label} changed`);
}

function buildSettingsFor(tool, keepExpanded = false) {
  if (!settings) {
    return;
  }

  settings.replaceChildren();

  const inner = document.createElement('div');
  inner.className = 'inner';
  inner.dataset.tool = tool;

  const toolDefinition = TOOL_DEFINITIONS[tool];
  const toolState = toolControlState[tool] || {};
  const uiContext = getToolUiContext();
  if (uiContext.isMaskEditing === true && tool === 'brush') {
    inner.appendChild(createToolSettingNotice('Editing layer mask: use the Brush tool only. Paint with black to hide, white to reveal, and gray for partial transparency.'));
  }
  (toolDefinition?.settings || []).forEach((setting) => {
    if (uiContext.isMaskEditing === true && tool === 'brush' && setting.key === 'blendMode') {
      return;
    }

    const value = toolState[setting.key];
    const onInput = (nextValue) => updateToolControlValue(tool, setting, nextValue);
    const displayLabel = setting.shortLabel || setting.label;
    const unit = getToolSettingUnit(tool, setting);
    const disabled = typeof setting.isDisabled === 'function'
      ? setting.isDisabled(toolState, uiContext)
      : setting.disabled === true;

    if (setting.type === 'range') {
      inner.appendChild(createRangeSetting(displayLabel, {
        min: setting.min,
        max: setting.max,
        step: setting.step ?? 1,
        value,
        unit,
        onInput,
        disabled,
      }, setting.label));
    } else if (setting.type === 'select') {
      inner.appendChild(createSelectSetting(displayLabel, value, setting.options, onInput, setting.label, disabled));
    } else if (setting.type === 'toggle') {
      inner.appendChild(createToggleSetting(displayLabel, value, onInput, setting.label, disabled));
    } else if (setting.type === 'number') {
      inner.appendChild(createNumberSetting(displayLabel, {
        min: setting.min,
        max: setting.max,
        step: setting.step ?? 1,
        value,
        unit,
        onInput,
        disabled,
      }, setting.label));
    } else if (setting.type === 'color') {
      inner.appendChild(createColorSetting(displayLabel, value, onInput, setting.label, disabled));
    }
  });

  if (isSelectionAwareTool(tool)) {
    if (tool === 'move' && uiContext.hasSelection !== true) {
      inner.appendChild(createToolSettingNotice('No active selection. Use Marquee, Lasso, Magic Wand, or Select All.'));
    }

    inner.appendChild(createToolActionRow([
      {
        label: 'Select All',
        titleText: 'Select all visible pixels on the active layer',
        onClick: () => selectEntireCanvas(),
      },
      {
        label: tool === 'move' ? 'Apply' : 'Deselect',
        titleText: tool === 'move'
          ? 'Commit the current transform and clear the selection'
          : 'Clear the current selection',
        onClick: () => clearCurrentSelection(),
        disabled: uiContext.hasSelection !== true,
      },
      {
        label: 'Delete',
        titleText: 'Delete the selected pixels from the active layer',
        onClick: () => deleteCurrentSelection(),
        disabled: uiContext.hasSelection !== true,
        tone: 'danger',
      },
    ]));
  }

  settings.appendChild(inner);

  const hasControls = inner.childElementCount > 0;
  settings.classList.toggle('collapsed', !hasControls && !keepExpanded);
}

function refreshSelectionAwareSettings() {
  if (isSelectionAwareTool(currentTool)) {
    buildSettingsFor(currentTool, true);
  }
}

function refreshSelectionMutationUi() {
  refreshSelectionAwareSettings();
  setTimeout(() => {
    refreshLayerThumbnails(layersManager?.getActiveLayerIndex?.());
  }, 10);
}

function selectEntireCanvas() {
  if (typeof editor.selectAll !== 'function') {
    return false;
  }

  const didSelect = editor.selectAll();
  if (didSelect) {
    refreshSelectionMutationUi();
  }
  return didSelect;
}

function selectLayerPixelsFromThumbnail(index) {
  if (typeof editor.selectLayerPixels !== 'function' || !Number.isInteger(index)) {
    return false;
  }

  layersManager?.setActiveLayer?.(index);
  layersManager?.setActiveEditTarget?.('content');
  if (currentTool === 'text') {
    setActiveTool('brush', { notify: false });
  }
  const didSelect = editor.selectLayerPixels(index);
  if (didSelect) {
    refreshSelectionMutationUi();
  }
  return didSelect;
}

function clearCurrentSelection() {
  if (typeof editor.hasSelection === 'function' && !editor.hasSelection()) {
    return false;
  }
  if (typeof editor.clearSelection !== 'function') {
    return false;
  }

  editor.clearSelection();
  refreshSelectionMutationUi();
  return true;
}

function deleteCurrentSelection() {
  if (typeof editor.deleteSelectionContents !== 'function') {
    return false;
  }

  const didDelete = editor.deleteSelectionContents();
  if (didDelete) {
    refreshSelectionMutationUi();
  }
  return didDelete;
}

function getToolSettingDefinition(tool, settingKey) {
  return TOOL_DEFINITIONS[tool]?.settings?.find((setting) => setting.key === settingKey) ?? null;
}

function nudgeCurrentToolSetting(settingKey, direction, stepMultiplier = 1) {
  if (!['brush', 'eraser'].includes(currentTool)) {
    return false;
  }

  const setting = getToolSettingDefinition(currentTool, settingKey);
  if (!setting) {
    return false;
  }

  const currentValue = toolControlState?.[currentTool]?.[settingKey] ?? setting.default;
  const baseStep = Number(setting.step ?? 1) || 1;
  const nextValue = clampNumber(currentValue + (baseStep * stepMultiplier * direction), {
    min: setting.min,
    max: setting.max,
    fallback: currentValue,
  });
  if (nextValue === currentValue) {
    return false;
  }

  updateToolControlValue(currentTool, setting, nextValue);
  buildSettingsFor(currentTool, true);
  return true;
}

function setActiveTool(tool, { notify = false } = {}) {
  if (!tool) {
    return;
  }

  const normalizedTool = normalizeToolForCurrentEditTarget(tool);
  const previousTool = currentTool;
  currentTool = normalizedTool;

  toolButtons.forEach((btn) => {
    const isActive = btn.dataset.tool === normalizedTool;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  editor.setTool(normalizedTool);
  editor.setBrush(buildBrushConfig());

  if (normalizedTool === 'brush') {
    if (topbarColor) {
      topbarColor.value = toolSettings.brush.color;
      syncColorCircleBackground();
    }
  } else if (normalizedTool === 'eraser') {
    editor.setEraser(buildEraserConfig());
  } else if (normalizedTool === 'dropper') {
    editor.setDropper(buildDropperConfig());
  } else if (normalizedTool === 'paint-bucket') {
    editor.setBucket(buildBucketConfig());
  } else if (normalizedTool === 'magic-wand') {
    editor.setMagicWand(buildMagicWandConfig());
  } else if (normalizedTool === 'marquee') {
    editor.setMarquee(buildMarqueeConfig());
  } else if (normalizedTool === 'lasso') {
    editor.setLasso(buildLassoConfig());
  } else if (normalizedTool === 'pen') {
    editor.setPen(buildPenConfig());
  } else if (normalizedTool === 'text') {
    editor.setText(buildTextConfig());
  } else if (normalizedTool === 'move') {
    syncMoveControlStateFromEditor();
    editor.setMove(buildMoveConfig());
  }

  buildSettingsFor(normalizedTool);
  syncMaskEditingToolAvailability();

  if (notify && previousTool !== normalizedTool) {
    notifySessionChanged(`Tool changed to ${normalizedTool}`);
  }
}

// Initialize the tool UI and editor state.
setActiveTool('brush');
resetUndoHistory('Initial state');

// ========== VIEW CONTROLS ==========
// Fit and center controls
document.getElementById('fitBothBtn').addEventListener('click', () => {
  editor.fitAndCenter();
  output.fitAndCenter();
});

document.getElementById('fitEditorBtn').addEventListener('click', () => {
  editor.fitAndCenter();
});

document.getElementById('fitOutputBtn').addEventListener('click', () => {
  output.fitAndCenter();
});

// Swap panes functionality
document.getElementById('swapBtn').addEventListener('click', () => {
  swapPanes();
});

/**
 * Swap the positions of editor and output panes
 */
function swapPanes() {
  const panes = document.querySelector('.panes');
  const leftPane = document.getElementById('leftPane');
  const rightPane = document.getElementById('rightPane');
  const divider = document.querySelector('.divider');
  
  if (leftPane.nextElementSibling === divider) {
    // Move right pane to the left
    panes.insertBefore(rightPane, leftPane);
    panes.insertBefore(divider, leftPane);
  } else {
    // Move left pane back to the left
    panes.insertBefore(leftPane, rightPane);
    panes.insertBefore(divider, rightPane);
  }
}

// ========== KEYBOARD SHORTCUTS ==========
/**
 * Global keyboard shortcut handler
 */
window.addEventListener('keydown', (e) => {
  // Ignore shortcuts when typing in input fields
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    return;
  }
  
  const key = e.key.toLowerCase();
  
  // Undo/Redo shortcuts
  if (e.ctrlKey || e.metaKey) {
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoRedoManager.undo();
      return;
    }
    if ((key === 'y') || (key === 'z' && e.shiftKey)) {
      e.preventDefault();
      undoRedoManager.redo();
      return;
    }
    if (key === 'a') {
      e.preventDefault();
      selectEntireCanvas();
      return;
    }
    if (key === 'd') {
      e.preventDefault();
      clearCurrentSelection();
      return;
    }
  }

  if (e.key === 'Escape' && clearCurrentSelection()) {
    e.preventDefault();
    return;
  }

  if ((e.key === 'Backspace' || e.key === 'Delete') && deleteCurrentSelection()) {
    e.preventDefault();
    return;
  }

  if (e.key === '[' || e.key === ']') {
    if (nudgeCurrentToolSetting('size', e.key === ']' ? 1 : -1, 2)) {
      e.preventDefault();
      return;
    }
  }

  if (e.key === '{' || e.key === '}') {
    if (nudgeCurrentToolSetting('hardness', e.key === '}' ? 1 : -1, 5)) {
      e.preventDefault();
      return;
    }
  }
  
  // Tool shortcuts
  switch (key) {
    case 'b':
      setActiveTool('brush', { notify: true });
      break;
    case 'e':
      setActiveTool('eraser', { notify: true });
      break;
    case 'i':
      setActiveTool('dropper', { notify: true });
      break;
    case 'g':
      setActiveTool('paint-bucket', { notify: true });
      break;
    case 'm':
      setActiveTool('marquee', { notify: true });
      break;
    case 'l':
      setActiveTool('lasso', { notify: true });
      break;
    case 'w':
      setActiveTool('magic-wand', { notify: true });
      break;
    case 'p':
      setActiveTool('pen', { notify: true });
      break;
    case 't':
      setActiveTool('text', { notify: true });
      break;
    case 'v':
      setActiveTool('move', { notify: true });
      break;
    case 'f':
      // Fit both panes to canvas
      editor.fitAndCenter();
      output.fitAndCenter();
      break;
    default:
      // No action for other keys
      break;
  }
});

// ========== LAYERS MANAGEMENT ==========
/**
 * Refresh thumbnails for all visible layer items
 */
function replaceLayerThumbnailCanvas(thumbnail, nextCanvas) {
  if (!thumbnail || !nextCanvas) {
    return false;
  }

  const existingCanvas = thumbnail.querySelector('canvas');
  if (existingCanvas) {
    thumbnail.removeChild(existingCanvas);
  }

  thumbnail.appendChild(nextCanvas);
  return true;
}

function paintThumbnailBackdrop(ctx, size, { dark = false } = {}) {
  const checkSize = 4;
  for (let y = 0; y < size; y += checkSize) {
    for (let x = 0; x < size; x += checkSize) {
      const isEven = Math.floor(x / checkSize) % 2 === Math.floor(y / checkSize) % 2;
      if (dark) {
        ctx.fillStyle = isEven ? '#1a1c20' : '#252830';
      } else {
        ctx.fillStyle = isEven ? '#f0f0f0' : '#e0e0e0';
      }
      ctx.fillRect(x, y, checkSize, checkSize);
    }
  }
}

function drawThumbnailImage(sourceCanvas, size = 40, { darkBackdrop = false } = {}) {
  const thumbnailCanvas = document.createElement('canvas');
  thumbnailCanvas.width = size;
  thumbnailCanvas.height = size;

  const ctx = thumbnailCanvas.getContext('2d');
  paintThumbnailBackdrop(ctx, size, { dark: darkBackdrop });

  const scale = Math.min(size / sourceCanvas.width, size / sourceCanvas.height);
  const scaledWidth = sourceCanvas.width * scale;
  const scaledHeight = sourceCanvas.height * scale;
  const offsetX = (size - scaledWidth) / 2;
  const offsetY = (size - scaledHeight) / 2;

  ctx.drawImage(sourceCanvas, offsetX, offsetY, scaledWidth, scaledHeight);
  ctx.strokeStyle = darkBackdrop ? 'rgba(255,255,255,0.18)' : '#ddd';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
  return thumbnailCanvas;
}

function refreshLayerThumbnailForIndex(index, size = 48) {
  if (!layersManager || !Number.isInteger(index)) {
    return false;
  }

  const layers = layersManager.getLayers();
  if (index < 0 || index >= layers.length) {
    return false;
  }

  const item = document.querySelector(`.layer-item[data-layer-index="${index}"]`);
  const contentThumbnail = item?.querySelector('.layer-thumbnail-content');
  if (!contentThumbnail) {
    return false;
  }

  const didRefreshContent = replaceLayerThumbnailCanvas(
    contentThumbnail,
    generateLayerThumbnail(layers[index], index, size),
  );

  const maskThumbnail = item?.querySelector('.layer-thumbnail-mask');
  if (layers[index].maskRenderTexture && maskThumbnail) {
    replaceLayerThumbnailCanvas(maskThumbnail, generateMaskThumbnail(layers[index], index, 28));
  }

  return didRefreshContent;
}

function refreshLayerThumbnails(targetIndexes = null) {
  if (!layersManager) return;

  const layers = layersManager.getLayers();
  const indexes = Number.isInteger(targetIndexes)
    ? [targetIndexes]
    : Array.isArray(targetIndexes)
      ? targetIndexes
      : layers.map((_, index) => index);

  [...new Set(indexes.filter((index) => Number.isInteger(index)))].forEach((index) => {
    refreshLayerThumbnailForIndex(index, 48);
  });
}

/**
 * Generate a thumbnail canvas from the layer's visible result
 * @param {Object} layer - Layer object with renderTexture
 * @param {number} index - Layer index
 * @param {number} size - Thumbnail size (square)
 * @returns {HTMLCanvasElement} Thumbnail canvas
 */
function generateLayerThumbnail(layer, index, size = 40) {
  try {
    const fullCanvas = editor.snapshotLayerCanvas(index);
    if (!fullCanvas || fullCanvas.width === 0 || fullCanvas.height === 0) {
      throw new Error('Invalid canvas extracted');
    }
    return drawThumbnailImage(fullCanvas, size);
  } catch (error) {
    console.error('Failed to generate layer thumbnail for layer:', layer.name);
    console.error('Error details:', error);
    console.error('Layer object:', layer);
    console.error('Editor app state:', editor ? 'Available' : 'Not available');
    
    // Fallback: create a simple colored rectangle with layer name initial
    const fallbackCanvas = document.createElement('canvas');
    fallbackCanvas.width = size;
    fallbackCanvas.height = size;
    const ctx = fallbackCanvas.getContext('2d');
    
    // Use a color based on layer name hash for variety
    const layerNameHash = layer.name ? layer.name.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0) : 0;
    
    const hue = Math.abs(layerNameHash) % 360;
    ctx.fillStyle = `hsl(${hue}, 50%, 40%)`;
    ctx.fillRect(0, 0, size, size);
    
    // Add layer name initial or layer type indicator
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    const initial = layer.name ? layer.name.charAt(0).toUpperCase() : 'L';
    ctx.fillText(initial, size / 2, size / 2);
    
    return fallbackCanvas;
  }
}

function generateMaskThumbnail(layer, index, size = 28) {
  try {
    if (!layer.maskRenderTexture) {
      return null;
    }

    const maskCanvas = editor.snapshotLayerMaskCanvas(index, { visualize: true });
    if (!maskCanvas || maskCanvas.width === 0 || maskCanvas.height === 0) {
      throw new Error('Invalid mask canvas extracted');
    }

    return drawThumbnailImage(maskCanvas, size, { darkBackdrop: true });
  } catch (error) {
    console.error('Failed to generate mask thumbnail for layer:', layer.name, error);
    const fallbackCanvas = document.createElement('canvas');
    fallbackCanvas.width = size;
    fallbackCanvas.height = size;
    const ctx = fallbackCanvas.getContext('2d');
    paintThumbnailBackdrop(ctx, size, { dark: true });
    ctx.fillStyle = '#d8dee9';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('M', size / 2, size / 2);
    return fallbackCanvas;
  }
}

/**
 * Initialize layers UI and event handlers
 */
function initializeLayersUI() {
  if (!layersManager) return;
  
  const layersPanel = document.getElementById('layersPanel');
  const layersList = document.getElementById('layersList');
  const addLayerBtn = document.getElementById('addLayerBtn');
  const deleteLayerBtn = document.getElementById('deleteLayerBtn');
  const duplicateLayerBtn = document.getElementById('duplicateLayerBtn');
  const removeMaskBtn = document.getElementById('removeMaskBtn');
  const blendModeSelect = document.getElementById('blendModeSelect');
  const minimizedLayersBtn = document.getElementById('minimizedLayersBtn');
  
  // Layer UI state
  let draggedLayerIndex = null;
  let thumbnailRefreshHandle = 0;
  const pendingThumbnailIndexes = new Set();

  function clearLayerDragState() {
    document.querySelectorAll('.layer-item').forEach((element) => {
      element.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
    });
    draggedLayerIndex = null;
  }

  function moveLayerFromDisplayDrop(sourceIndex, targetIndex, dropAbove) {
    const layers = layersManager.getLayers();
    const displayOrder = layers.map((_, layerIndex) => layerIndex).reverse();
    const sourceDisplayIndex = displayOrder.indexOf(sourceIndex);
    const targetDisplayIndex = displayOrder.indexOf(targetIndex);

    if (sourceDisplayIndex === -1 || targetDisplayIndex === -1) {
      return false;
    }

    let insertDisplayIndex = targetDisplayIndex + (dropAbove ? 0 : 1);
    if (sourceDisplayIndex < insertDisplayIndex) {
      insertDisplayIndex -= 1;
    }

    const nextDisplayOrder = displayOrder.filter((layerIndex) => layerIndex !== sourceIndex);
    insertDisplayIndex = Math.max(0, Math.min(insertDisplayIndex, nextDisplayOrder.length));
    nextDisplayOrder.splice(insertDisplayIndex, 0, sourceIndex);

    const nextLayerOrder = nextDisplayOrder.slice().reverse();
    const nextIndex = nextLayerOrder.indexOf(sourceIndex);
    if (nextIndex === -1 || nextIndex === sourceIndex) {
      return false;
    }

    return layersManager.moveLayer(sourceIndex, nextIndex);
  }

  function scheduleLayerThumbnailRefresh(targetIndexes = null) {
    const layers = layersManager.getLayers();
    const indexes = Number.isInteger(targetIndexes)
      ? [targetIndexes]
      : Array.isArray(targetIndexes)
        ? targetIndexes
        : layers.map((_, index) => index);

    indexes
      .filter((index) => Number.isInteger(index) && index >= 0)
      .forEach((index) => pendingThumbnailIndexes.add(index));

    if (thumbnailRefreshHandle) {
      return;
    }

    thumbnailRefreshHandle = window.setTimeout(() => {
      thumbnailRefreshHandle = 0;
      const indexesToRefresh = [...pendingThumbnailIndexes];
      pendingThumbnailIndexes.clear();
      indexesToRefresh.forEach((index) => {
        refreshLayerThumbnailForIndex(index, 48);
      });
    }, 40);
  }

  function normalizeLayerName(value, fallback = 'Layer') {
    const normalized = `${value ?? ''}`.replace(/\s+/g, ' ').trim();
    return normalized || fallback;
  }

  function captureLayerSnapshot(description) {
    if (!window.undoRedoManager) {
      return;
    }

    setTimeout(() => {
      window.undoRedoManager.captureSnapshot(description);
    }, 10);
  }

  function getActiveLayerEditTarget() {
    return layersManager?.getActiveEditTarget?.() || 'content';
  }

  function selectLayerEditTarget(index, target = 'content') {
    if (!layersManager || !Number.isInteger(index)) {
      return false;
    }

    layersManager.setActiveLayer(index);
    layersManager.setActiveEditTarget(target);
    if (target === 'mask' && currentTool !== MASK_EDIT_PRIMARY_TOOL) {
      setActiveTool('brush', { notify: false });
    } else {
      buildSettingsFor(currentTool, true);
      syncMaskEditingToolAvailability();
    }
    refreshSelectionAwareSettings();
    updateLayerControlsState();
    syncAllLayerCards();
    return true;
  }

  function createOrSelectLayerMask(index) {
    const layer = layersManager.getLayer(index);
    if (!layer) {
      return false;
    }

    if (!layer.maskRenderTexture) {
      layersManager.createLayerMask(index);
      notifySessionChanged('Add layer mask');
      captureLayerSnapshot('Add layer mask');
    }

    return selectLayerEditTarget(index, 'mask');
  }

  function toggleLayerMaskEnabled(index) {
    const layer = layersManager.getLayer(index);
    if (!layer?.maskRenderTexture) {
      return false;
    }

    const nextEnabled = layer.maskEnabled === false;
    layersManager.setLayerMaskEnabled(index, nextEnabled);
    notifySessionChanged(nextEnabled ? 'Enable layer mask' : 'Disable layer mask');
    captureLayerSnapshot(nextEnabled ? 'Enable layer mask' : 'Disable layer mask');
    refreshLayerThumbnails(index);
    return true;
  }

  function updateLayerControlsState() {
    const activeIndex = layersManager.getActiveLayerIndex();
    const activeLayer = layersManager.getActiveLayer();
    const canDelete = layersManager.canRemoveLayer(activeIndex);
    const canDuplicate = !!activeLayer;
    const canRemoveMask = !!activeLayer?.maskRenderTexture;

    deleteLayerBtn.disabled = !canDelete;
    deleteLayerBtn.classList.toggle('disabled', !canDelete);
    duplicateLayerBtn.disabled = !canDuplicate;
    duplicateLayerBtn.classList.toggle('disabled', !canDuplicate);
    if (removeMaskBtn) {
      removeMaskBtn.disabled = !canRemoveMask;
      removeMaskBtn.classList.toggle('disabled', !canRemoveMask);
    }
    blendModeSelect.disabled = !activeLayer;

    if (activeLayer) {
      blendModeSelect.value = activeLayer.blendMode;
    }
  }

  function syncLayerCard(index) {
    const item = layersList.querySelector(`.layer-item[data-layer-index="${index}"]`);
    const layer = layersManager.getLayer(index);
    if (!item || !layer) {
      return false;
    }

    const isActive = index === layersManager.getActiveLayerIndex();
    const activeEditTarget = getActiveLayerEditTarget();
    const isMaskEditing = isActive && activeEditTarget === 'mask';
    item.classList.toggle('active', isActive);
    item.classList.toggle('is-hidden', !layer.visible);
    item.classList.toggle('is-locked', layer.locked === true);
    item.classList.toggle('is-base-layer', layersManager.isBaseLayer(index));
    item.classList.toggle('has-mask', !!layer.maskRenderTexture);
    item.classList.toggle('is-mask-disabled', !!layer.maskRenderTexture && layer.maskEnabled === false);
    item.classList.toggle('is-mask-editing', isMaskEditing);
    item.setAttribute('aria-selected', String(isActive));
    item.dataset.layerId = String(layer.id);

    const nameInput = item.querySelector('.layer-name');
    if (nameInput && document.activeElement !== nameInput) {
      nameInput.value = layer.name;
    }

    const opacityPercent = Math.round(layer.opacity * 100);
    const opacityInput = item.querySelector('.layer-opacity-input');
    if (opacityInput && document.activeElement !== opacityInput) {
      opacityInput.value = String(opacityPercent);
    }

    const visibilityBtn = item.querySelector('.visibility-btn');
    if (visibilityBtn) {
      const visibilityLabel = layer.visible ? 'Hide layer' : 'Show layer';
      visibilityBtn.innerHTML = `<svg class="icon"><use href="#${layer.visible ? 'eye-open' : 'eye-closed'}"></use></svg>`;
      visibilityBtn.title = visibilityLabel;
      visibilityBtn.setAttribute('aria-label', visibilityLabel);
    }

    const lockBtn = item.querySelector('.lock-btn');
    if (lockBtn) {
      const isLocked = layer.locked === true;
      const lockLabel = isLocked ? 'Unlock layer' : 'Lock layer';
      lockBtn.innerHTML = `<svg class="icon"><use href="#${isLocked ? 'lock' : 'unlock'}"></use></svg>`;
      lockBtn.title = lockLabel;
      lockBtn.setAttribute('aria-label', lockLabel);
      lockBtn.classList.toggle('is-active', isLocked);
    }

    const contentThumbnail = item.querySelector('.layer-thumbnail-content');
    if (contentThumbnail) {
      contentThumbnail.classList.toggle('is-active-target', isActive && activeEditTarget === 'content');
      contentThumbnail.title = 'Edit layer pixels';
    }

    const maskThumbnail = item.querySelector('.layer-thumbnail-mask');
    if (maskThumbnail) {
      maskThumbnail.classList.toggle('is-active-target', isMaskEditing);
      maskThumbnail.classList.toggle('is-disabled', layer.maskEnabled === false);
      maskThumbnail.title = layer.maskEnabled === false
        ? 'Layer mask disabled. Shift+click to enable, click to edit.'
        : 'Edit layer mask. Shift+click to disable.';
    }

    const maskBtn = item.querySelector('.mask-btn');
    if (maskBtn) {
      const hasMask = !!layer.maskRenderTexture;
      maskBtn.classList.toggle('is-active', hasMask);
      maskBtn.textContent = hasMask ? 'M' : '+M';
      maskBtn.title = hasMask ? 'Select or edit this layer mask' : 'Add a layer mask';
      maskBtn.setAttribute('aria-label', maskBtn.title);
    }

    return true;
  }

  function syncAllLayerCards() {
    const layers = layersManager.getLayers();
    const items = [...layersList.querySelectorAll('.layer-item')];
    if (items.length !== layers.length) {
      return false;
    }

    let isInExpectedOrder = true;
    items.forEach((item, itemIndex) => {
      const displayIndex = layers.length - 1 - itemIndex;
      if (Number.parseInt(item.dataset.layerIndex, 10) !== displayIndex) {
        isInExpectedOrder = false;
      }
    });

    if (!isInExpectedOrder) {
      return false;
    }

    layers.forEach((_, index) => {
      if (!syncLayerCard(index)) {
        isInExpectedOrder = false;
      }
    });

    if (!isInExpectedOrder) {
      return false;
    }

    updateLayerControlsState();
    return true;
  }

  setLayersPanelMinimized = (nextValue, { notify = false } = {}) => {
    layersPanelMinimized = nextValue === true;

    if (layersPanelMinimized) {
      layersPanel.classList.add('minimized');
      minimizedLayersBtn.hidden = false;
      minimizedLayersBtn.classList.add('active');
    } else {
      layersPanel.classList.remove('minimized');
      minimizedLayersBtn.hidden = true;
      minimizedLayersBtn.classList.remove('active');
    }

    if (notify) {
      notifySessionChanged(layersPanelMinimized ? 'Layers panel minimized' : 'Layers panel expanded');
    }
  };

  function toggleLayersPanel() {
    setLayersPanelMinimized(!layersPanelMinimized, { notify: true });
  }

  setLayersPanelMinimized(layersPanelMinimized, { notify: false });
  
  // Event listener
  minimizedLayersBtn.addEventListener('click', toggleLayersPanel);
  
  // Add layer button handler
  addLayerBtn.addEventListener('click', () => {
    const activeIndex = layersManager.getActiveLayerIndex();
    const nextIndex = Number.isInteger(activeIndex)
      ? activeIndex + 1
      : layersManager.getLayers().length;
    layersManager.addLayer({ insertIndex: nextIndex });
    notifySessionChanged('Add layer');
    captureLayerSnapshot('Add layer');
  });
  
  // Delete layer button handler
  deleteLayerBtn.addEventListener('click', () => {
    const activeIndex = layersManager.getActiveLayerIndex();
    if (layersManager.canRemoveLayer(activeIndex)) {
      layersManager.removeLayer(activeIndex);
      notifySessionChanged('Delete layer');
      captureLayerSnapshot('Delete layer');
    }
  });
  
  // Duplicate layer button handler
  duplicateLayerBtn.addEventListener('click', () => {
    const activeIndex = layersManager.getActiveLayerIndex();
    if (activeIndex >= 0 && layersManager.duplicateLayer(activeIndex)) {
      notifySessionChanged('Duplicate layer');
      captureLayerSnapshot('Duplicate layer');
    }
  });

  removeMaskBtn?.addEventListener('click', () => {
    const activeIndex = layersManager.getActiveLayerIndex();
    if (activeIndex < 0) {
      return;
    }

    if (layersManager.removeLayerMask(activeIndex)) {
      notifySessionChanged('Remove layer mask');
      captureLayerSnapshot('Remove layer mask');
    }
  });
  
  // Blend mode change handler
  blendModeSelect.addEventListener('change', () => {
    const activeIndex = layersManager.getActiveLayerIndex();
    layersManager.updateLayer(activeIndex, {
      blendMode: blendModeSelect.value
    });
    notifySessionChanged('Change blend mode');
    captureLayerSnapshot('Change blend mode');
  });

  // Listen to layers events
  layersManager.on('layerAdded', () => {
    updateLayersUI();
  });
  layersManager.on('layerRemoved', () => {
    updateLayersUI();
  });
  layersManager.on('layerMoved', () => {
    updateLayersUI();
  });
  layersManager.on('layerUpdated', ({ layer, index, properties }) => {
    if (properties?.hasMask !== undefined) {
      updateLayersUI();
      return;
    }

    if (!syncLayerCard(index)) {
      updateLayersUI();
      return;
    }

    updateLayerControlsState();

    if (properties?.maskEnabled !== undefined) {
      refreshLayerThumbnails(index);
    }

    if (properties?.blendMode !== undefined && index === layersManager.getActiveLayerIndex()) {
      blendModeSelect.value = layer.blendMode;
    }

    if (properties?.name !== undefined && !layer.name) {
      syncLayerCard(index);
    }
  });
  layersManager.on('activeLayerChanged', ({ layer, index }) => {
    if (!syncAllLayerCards()) {
      updateLayersUI();
      return;
    }
    if (layer) {
      blendModeSelect.value = layer.blendMode;
    }
  });
  layersManager.on('activeLayerEditTargetChanged', () => {
    if (getActiveLayerEditTarget() === 'mask' && currentTool !== MASK_EDIT_PRIMARY_TOOL) {
      setActiveTool('brush', { notify: false });
    } else {
      syncMaskEditingToolAvailability();
      buildSettingsFor(currentTool, true);
    }
    if (!syncAllLayerCards()) {
      updateLayersUI();
      return;
    }
    refreshSelectionAwareSettings();
  });
  
  /**
   * Update the layers UI to reflect current state
   */
  updateLayersUI = function updateLayersUI() {
    if (!layersManager) return;
    
    const layers = layersManager.getLayers();
    const activeIndex = layersManager.getActiveLayerIndex();
    
    // Clear existing layer items
    layersList.innerHTML = '';
    
    // Create layer items (reverse order - top layer first)
    layers.slice().reverse().forEach((layer, reversedIndex) => {
      const index = layers.length - 1 - reversedIndex;
      const isActive = index === activeIndex;
      
      const layerItem = createLayerItem(layer, index, isActive);
      layersList.appendChild(layerItem);
    });
    
    syncAllLayerCards();
    updateLayerControlsState();
  }
  
  /**
   * Refresh thumbnails for all visible layer items
   */
  refreshLayerThumbnails = function refreshLayerThumbnails(targetIndexes = null) {
    if (targetIndexes === null || targetIndexes === undefined) {
      scheduleLayerThumbnailRefresh();
      return;
    }
    scheduleLayerThumbnailRefresh(targetIndexes);
  };

  /**
   * Create a layer item element
   */
  function createLayerItem(layer, index, isActive) {
    const item = document.createElement('div');
    item.className = 'layer-item';
    item.dataset.layerIndex = index;
    item.dataset.layerId = String(layer.id);
    item.setAttribute('role', 'listitem');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-selected', String(isActive));

    const thumbnailStack = document.createElement('div');
    thumbnailStack.className = 'layer-thumbnail-stack';

    const contentThumbnail = document.createElement('div');
    contentThumbnail.className = 'layer-thumbnail layer-thumbnail-content';
    const thumbnailCanvas = generateLayerThumbnail(layer, index, 48);
    contentThumbnail.appendChild(thumbnailCanvas);
    contentThumbnail.addEventListener('pointerdown', (event) => event.stopPropagation());
    contentThumbnail.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.ctrlKey || event.metaKey) {
        selectLayerEditTarget(index, 'content');
        selectLayerPixelsFromThumbnail(index);
        return;
      }

      selectLayerEditTarget(index, 'content');
    });
    thumbnailStack.appendChild(contentThumbnail);

    if (layer.maskRenderTexture) {
      const maskThumbnail = document.createElement('div');
      maskThumbnail.className = 'layer-thumbnail layer-thumbnail-mask';
      const maskCanvas = generateMaskThumbnail(layer, index, 28);
      if (maskCanvas) {
        maskThumbnail.appendChild(maskCanvas);
      }
      maskThumbnail.addEventListener('pointerdown', (event) => event.stopPropagation());
      maskThumbnail.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (event.shiftKey) {
          toggleLayerMaskEnabled(index);
          return;
        }

        createOrSelectLayerMask(index);
      });
      thumbnailStack.appendChild(maskThumbnail);
    }
    
    const header = document.createElement('div');
    header.className = 'layer-card-header';
    
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'layer-name';
    nameInput.value = layer.name;
    nameInput.addEventListener('pointerdown', (e) => e.stopPropagation());
    nameInput.addEventListener('click', (e) => e.stopPropagation());
    nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        nameInput.blur();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        nameInput.value = layer.name;
        nameInput.blur();
      }
    });

    const commitLayerName = () => {
      const nextName = normalizeLayerName(nameInput.value, layer.name || 'Layer');
      nameInput.value = nextName;
      if (nextName === layer.name) {
        return;
      }

      layersManager.updateLayer(index, { name: nextName });
      notifySessionChanged('Rename layer');
      captureLayerSnapshot('Rename layer');
    };
    nameInput.addEventListener('change', commitLayerName);
    nameInput.addEventListener('blur', commitLayerName);

    const controls = document.createElement('div');
    controls.className = 'layer-card-controls';
    
    const visibilityBtn = document.createElement('button');
    visibilityBtn.type = 'button';
    visibilityBtn.className = 'layer-card-btn visibility-btn';
    visibilityBtn.innerHTML = `<svg class="icon"><use href="#${layer.visible ? 'eye-open' : 'eye-closed'}"></use></svg>`;
    visibilityBtn.title = layer.visible ? 'Hide layer' : 'Show layer';
    visibilityBtn.setAttribute('aria-label', visibilityBtn.title);
    visibilityBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    visibilityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      layersManager.updateLayer(index, { visible: !layer.visible });
      notifySessionChanged('Toggle layer visibility');
      captureLayerSnapshot('Toggle layer visibility');
    });

    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'layer-card-btn lock-btn';
    lockBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    lockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextLocked = !layer.locked;
      layersManager.updateLayer(index, { locked: nextLocked });
      notifySessionChanged(nextLocked ? 'Lock layer' : 'Unlock layer');
      captureLayerSnapshot(nextLocked ? 'Lock layer' : 'Unlock layer');
    });

    const maskBtn = document.createElement('button');
    maskBtn.type = 'button';
    maskBtn.className = 'layer-card-btn mask-btn';
    maskBtn.textContent = layer.maskRenderTexture ? 'M' : '+M';
    maskBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    maskBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      createOrSelectLayerMask(index);
    });
    
    const reorderHandle = document.createElement('button');
    reorderHandle.type = 'button';
    reorderHandle.className = 'layer-card-btn layer-reorder-handle';
    reorderHandle.title = 'Drag to reorder layer';
    reorderHandle.setAttribute('aria-label', 'Drag to reorder layer');
    reorderHandle.draggable = true;
    reorderHandle.innerHTML = `
      <span class="layer-reorder-glyph" aria-hidden="true">
        <svg class="icon caret-up"><use href="#caret-down"></use></svg>
        <svg class="icon caret-down"><use href="#caret-down"></use></svg>
      </span>
    `;
    reorderHandle.addEventListener('pointerdown', (e) => e.stopPropagation());
    reorderHandle.addEventListener('click', (e) => e.stopPropagation());
    reorderHandle.addEventListener('dragstart', (e) => {
      draggedLayerIndex = index;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    });
    reorderHandle.addEventListener('dragend', () => {
      clearLayerDragState();
    });

    header.appendChild(nameInput);

    const metaColumn = document.createElement('div');
    metaColumn.className = 'layer-card-meta';

    const opacityField = document.createElement('div');
    opacityField.className = 'layer-opacity-input-wrap';

    const opacityInput = document.createElement('input');
    opacityInput.type = 'number';
    opacityInput.min = '0';
    opacityInput.max = '100';
    opacityInput.step = '1';
    opacityInput.value = String(Math.round(layer.opacity * 100));
    opacityInput.inputMode = 'numeric';
    opacityInput.className = 'layer-opacity-input';
    opacityInput.setAttribute('aria-label', 'Layer opacity percent');
    opacityInput.addEventListener('pointerdown', (e) => e.stopPropagation());
    opacityInput.addEventListener('click', (e) => e.stopPropagation());
    opacityInput.addEventListener('keydown', (e) => e.stopPropagation());

    let currentOpacityPercent = Math.round(layer.opacity * 100);
    const applyOpacityValue = (nextValue, { capture = false } = {}) => {
      currentOpacityPercent = clampNumber(nextValue, { min: 0, max: 100, fallback: currentOpacityPercent });
      opacityInput.value = String(currentOpacityPercent);
      layersManager.updateLayer(index, { opacity: currentOpacityPercent / 100 });
      notifySessionChanged('Change layer opacity');
      if (capture) {
        captureLayerSnapshot('Change layer opacity');
      }
    };

    opacityInput.addEventListener('input', (e) => {
      e.stopPropagation();
      if (opacityInput.value === '' || opacityInput.value === '-') {
        return;
      }

      const parsedValue = Number(opacityInput.value);
      if (Number.isFinite(parsedValue)) {
        applyOpacityValue(parsedValue);
      }
    });

    opacityInput.addEventListener('change', (e) => {
      e.stopPropagation();
      const nextValue = opacityInput.value === ''
        ? Math.round(layer.opacity * 100)
        : Number(opacityInput.value);
      applyOpacityValue(nextValue, { capture: true });
    });

    const opacityUnit = document.createElement('span');
    opacityUnit.className = 'layer-opacity-unit';
    opacityUnit.textContent = '%';

    const opacityStepper = document.createElement('div');
    opacityStepper.className = 'layer-opacity-stepper';

    const createOpacityStepButton = (direction, labelSuffix, path) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `layer-opacity-step-btn ${direction > 0 ? 'is-up' : 'is-down'}`;
      button.setAttribute('aria-label', `${labelSuffix} layer opacity`);
      button.innerHTML = `
        <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <path d="${path}" />
        </svg>
      `;
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const liveValue = opacityInput.value === ''
          ? Math.round(layer.opacity * 100)
          : Number(opacityInput.value);
        applyOpacityValue(liveValue + direction, { capture: true });
      });
      return button;
    };

    opacityStepper.appendChild(createOpacityStepButton(1, 'Increase', 'M2 6.5L5 3.5L8 6.5'));
    opacityStepper.appendChild(createOpacityStepButton(-1, 'Decrease', 'M2 3.5L5 6.5L8 3.5'));

    opacityField.appendChild(opacityInput);
    opacityField.appendChild(opacityUnit);
    opacityField.appendChild(opacityStepper);

    const toolbarRow = document.createElement('div');
    toolbarRow.className = 'layer-card-toolbar';

    const bodyRow = document.createElement('div');
    bodyRow.className = 'layer-card-body';

    metaColumn.appendChild(opacityField);

    controls.appendChild(visibilityBtn);
    controls.appendChild(lockBtn);
    controls.appendChild(maskBtn);
    controls.appendChild(reorderHandle);

    toolbarRow.appendChild(controls);
    metaColumn.appendChild(toolbarRow);

    bodyRow.appendChild(thumbnailStack);
    bodyRow.appendChild(metaColumn);

    item.appendChild(header);
    item.appendChild(bodyRow);
    
    item.addEventListener('click', () => {
      selectLayerEditTarget(index, 'content');
    });
    
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectLayerEditTarget(index, 'content');
      }
    });
    
    item.addEventListener('dragover', (e) => {
      if (draggedLayerIndex === null || draggedLayerIndex === index) {
        return;
      }

      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      item.classList.remove('drag-over-top', 'drag-over-bottom');
      item.classList.add(e.clientY < midY ? 'drag-over-top' : 'drag-over-bottom');
    });
    
    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    
    item.addEventListener('drop', (e) => {
      if (draggedLayerIndex === null || draggedLayerIndex === index) {
        clearLayerDragState();
        return;
      }

      e.preventDefault();
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const moved = moveLayerFromDisplayDrop(draggedLayerIndex, index, e.clientY < midY);

      clearLayerDragState();

      if (moved) {
        notifySessionChanged('Reorder layers');
      }

      if (moved) {
        captureLayerSnapshot('Reorder layers');
      }
    });
    
    return item;
  }
  
  // Initial layers UI update
  updateLayersUI();
  updateLayerControlsState();
}


window.comfyCanvasApp = {
  isReady: true,
  mode: runtimeMode,
  sessionId,
  async loadImage({ url, reset = true, layerName = 'Source Image' } = {}) {
    if (!url) {
      return null;
    }
    return loadImageSource(url, {
      layerName,
      resetDocument: reset,
      createPaintLayerAfterAdd: reset,
      activateTool: reset ? 'brush' : 'move',
      selectAfterAdd: !reset,
    });
  },
  resetDocument({ width, height, background = 'transparent' } = {}) {
    resetDocumentState({ width, height, background });
  },
  async loadDocument({ document } = {}) {
    if (!document) {
      return null;
    }
    return restorePersistedDocument(document);
  },
  async loadOutputImage({ url } = {}) {
    if (!url) {
      clearOutputPreview({ width: editor.getSize().width, height: editor.getSize().height });
      return null;
    }
    return loadOutputImageSource(url);
  },
  clearOutput({ width, height } = {}) {
    clearOutputPreview({
      width: width || editor.getSize().width,
      height: height || editor.getSize().height,
    });
  },
  resetToolUiState({ notify = false } = {}) {
    resetToolUiState({ notify });
  },
  setPromptText({ text = '', notify = false } = {}) {
    setPromptValue(text, { notify });
    return getPromptValue();
  },
  getPromptText() {
    return getPromptValue();
  },
  setRunStatus({ message = '', tone = '' } = {}) {
    setPromptDockStatus(message, tone);
  },
  syncPreview() {
    syncOutputFromEditor();
  },
  subscribeToSessionChanges(callback) {
    if (typeof callback !== 'function') {
      return () => {};
    }

    sessionChangeListeners.add(callback);
    return () => {
      sessionChangeListeners.delete(callback);
    };
  },
  exportSession() {
    const canvas = editor.snapshotCanvas();
    return {
      imageDataUrl: canvas.toDataURL('image/png'),
      maskDataUrl: exportMaskDataUrl(),
      size: { width: canvas.width, height: canvas.height },
      sessionId,
      document: buildPersistedDocumentPayload(),
    };
  },
};






