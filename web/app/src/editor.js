/**
 * Comfy Canvas - Editor Module
 * Handles drawing tools, canvas manipulation, and user interactions for the left pane
 */
import * as PIXI from './pixi.js';

/**
 * Creates an interactive drawing editor pane
 * @param {string} selector - CSS selector for the host element
 * @param {Object} options - Configuration options
 * @param {number} options.width - Initial canvas width
 * @param {number} options.height - Initial canvas height
 * @returns {Object} Editor API object
 */
export function createEditor(selector, { width = 1024, height = 1024 } = {}) {
  // ========== INITIALIZATION ==========
  const host = document.querySelector(selector);
  if (!host) {
    throw new Error(`Editor host element not found: ${selector}`);
  }
  // Initialize Pixi application with optimized settings
  const app = new PIXI.Application({
    background: '#222222',
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    powerPreference: 'high-performance',
    resizeTo: host,
  });
  
  try {
    host.appendChild(app.view);
  } catch (error) {
    console.error('Failed to initialize editor canvas:', error);
    throw error;
  }

  const textEditorOverlay = document.createElement('div');
  textEditorOverlay.className = 'text-editor-overlay is-hidden';
  const textEditorInput = document.createElement('textarea');
  textEditorInput.className = 'text-editor-input';
  textEditorInput.rows = 1;
  textEditorInput.spellcheck = false;
  textEditorInput.placeholder = 'Type text';
  textEditorOverlay.appendChild(textEditorInput);
  host.appendChild(textEditorOverlay);

  const SELECTION_OUTLINE_DARK = 0x0b0f14;
  const SELECTION_OUTLINE_LIGHT = 0xffffff;
  const SELECTION_HANDLE_FILL = 0xffffff;
  const SELECTION_HANDLE_STROKE = 0x0b0f14;
  const SELECTION_HANDLE_DETAIL = 0x0b0f14;
  let layersManager = null;
  let onDrawingComplete = null; // Callback for when drawing operations complete
  let onDocumentMutated = null; // Callback for when the document changes
  let onMoveStateChanged = null;
  let onTextStateChanged = null;

  // ========== ARTBOARD SETUP ==========
  // Canvas dimensions and render texture
  let W = width, H = height;
  let rt = PIXI.RenderTexture.create({ width: W, height: H, resolution: 1 });
  
  // Initialize with white background
  {
    const g = new PIXI.Graphics();
    g.beginFill(0xffffff).drawRect(0, 0, W, H).endFill();
    app.renderer.render(g, { renderTexture: rt, clear: true });
    g.destroy(); // Clean up graphics object
  }
  // Create sprite and border for the artboard
  const sprite = new PIXI.Sprite(rt);
  const border = new PIXI.Graphics()
    .lineStyle(1, 0x333333, 1)
    .drawRect(-0.5, -0.5, W + 1, H + 1);

  // Scene graph setup
  const viewport = new PIXI.Container();
  const board = new PIXI.Container();
  
  // Create fade overlay for content outside artboard
  const fadeOverlay = new PIXI.Container();
  
  /**
   * Update the fade overlay to create fading effect for content outside artboard
   */
  function updateFadeOverlay() {
    fadeOverlay.removeChildren();
    
    // Add subtle border highlights to show artboard boundaries
    const border = new PIXI.Graphics();
    border.lineStyle(2, 0x55cdfc, 0.2);
    border.drawRect(-1, -1, W + 2, H + 2);
    fadeOverlay.addChild(border);
  }
  
  board.addChild(sprite, border);
  let brushStrokeTexture = PIXI.RenderTexture.create({ width: W, height: H, resolution: 1 });
  const brushStrokePreview = new PIXI.Sprite(brushStrokeTexture);
  brushStrokePreview.visible = false;
  brushStrokePreview.renderable = false;
  brushStrokePreview.alpha = 1;
  board.addChildAt(brushStrokePreview, Math.max(0, board.children.length - 1));
  viewport.addChild(board, fadeOverlay);
  app.stage.addChild(viewport);
  
  // Initialize fade overlay
  updateFadeOverlay();
  
  // Ensure stage is interactive
  app.stage.interactive = true;
  app.stage.interactiveChildren = true;

  // ========== VIEW MANAGEMENT ==========
  /**
   * Fit the canvas to the viewport and center it
   */
  function fitAndCenter() {
    const s = app.screen;
    const zoom = Math.min(s.width / W, s.height / H, 1);
    viewport.scale.set(zoom);
    viewport.position.set(
      Math.round((s.width - W * zoom) * 0.5),
      Math.round((s.height - H * zoom) * 0.5)
    );
    updateTextEditorOverlay();
  }

  let onViewChanged = null;

  function emitViewChanged() {
    if (typeof onViewChanged !== 'function') {
      return;
    }

    try {
      onViewChanged(getViewState());
    } catch (error) {
      console.error('Failed to notify editor view change:', error);
    }
  }

  function getViewState() {
    return {
      scale: Number.isFinite(viewport.scale.x) ? viewport.scale.x : 1,
      x: Number.isFinite(viewport.position.x) ? viewport.position.x : 0,
      y: Number.isFinite(viewport.position.y) ? viewport.position.y : 0,
    };
  }

  function setViewState(viewState) {
    if (!viewState || typeof viewState !== 'object') {
      return false;
    }

    const scale = Number(viewState.scale);
    const x = Number(viewState.x);
    const y = Number(viewState.y);
    if (!Number.isFinite(scale) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return false;
    }

    viewport.scale.set(Math.max(0.1, Math.min(8, scale)));
    viewport.position.set(x, y);
    updateBrushCursor();
    drawPenDraft();
    updateTextEditorOverlay();
    drawSelectionOutline();
    drawScaleHandles();
    return true;
  }
  
  // Set up responsive resize handling
  const resizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(fitAndCenter);
  });
  resizeObserver.observe(host);
  app.ticker.addOnce(fitAndCenter);

  // ========== TOOL STATE ==========
  let tool = 'brush';
  let color = 0x55cdfc;
  const blendModeMap = {
    normal: PIXI.BLEND_MODES.NORMAL,
    multiply: PIXI.BLEND_MODES.MULTIPLY,
    screen: PIXI.BLEND_MODES.SCREEN,
    overlay: PIXI.BLEND_MODES.OVERLAY,
    darken: PIXI.BLEND_MODES.DARKEN,
    lighten: PIXI.BLEND_MODES.LIGHTEN,
    'color-dodge': PIXI.BLEND_MODES.COLOR_DODGE,
    'color-burn': PIXI.BLEND_MODES.COLOR_BURN,
    'hard-light': PIXI.BLEND_MODES.HARD_LIGHT,
    'soft-light': PIXI.BLEND_MODES.SOFT_LIGHT,
    difference: PIXI.BLEND_MODES.DIFFERENCE,
    exclusion: PIXI.BLEND_MODES.EXCLUSION,
  };
  let brushSettings = {
    size: 8,
    hardness: 100,
    opacity: 100,
    flow: 100,
    spacing: 12,
    brushShape: 'round',
    smoothing: 0,
    blendMode: 'normal',
  };
  let eraserSettings = {
    size: 8,
    hardness: 100,
    opacity: 100,
    flow: 100,
    spacing: 14,
    eraseToTransparency: true,
    softEdge: true,
  };
  let dropperSettings = {
    sampleSize: 'point',
    layerSource: 'current-layer',
    sampleMerged: false,
    averageSampling: false,
  };
  let bucketSettings = {
    tolerance: 32,
    contiguous: true,
    opacity: 100,
    blendMode: 'normal',
    allLayers: false,
    antiAlias: true,
  };
  let magicWandSettings = {
    tolerance: 24,
    contiguous: true,
    antiAlias: true,
    allLayers: false,
    sampleMerged: false,
    selectionOperation: 'replace',
  };
  let marqueeSettings = {
    mode: 'rectangle',
    feather: 0,
    antiAlias: true,
    fixedSize: false,
    fixedWidth: 256,
    fixedHeight: 256,
    fixedRatio: 'free',
    selectionOperation: 'replace',
  };
  let lassoSettings = {
    mode: 'freehand',
    feather: 0,
    antiAlias: true,
    edgeDetection: 50,
    selectionOperation: 'replace',
  };
  let penSettings = {
    pathMode: 'path',
    shapeMode: 'path',
    strokeColor: '#f7a8b8',
    fillColor: '#55cdfc',
    strokeWidth: 4,
    anchorEdit: true,
    curveHandles: 'mirrored',
    closePath: false,
  };
  let textSettings = {
    fontFamily: 'space-grotesk',
    fontSize: 48,
    bold: false,
    italic: false,
    alignment: 'left',
    color: '#f5f7fa',
    lineHeight: 120,
    letterSpacing: 0,
    warp: 'none',
    textBoxWidth: 420,
    fixedWidth: false,
  };
  let moveSettings = {
    transformMode: 'move',
    uniformScale: true,
    pivotPoint: 'center',
    snap: false,
  };
  const MOVE_SNAP_GRID = 8;
  const MOVE_SNAP_ANGLE_DEGREES = 15;
  let radius = brushSettings.size;
  let feather = Math.max(0, 100 - brushSettings.hardness);

  // Drawing state
  let drawing = false;
  let lastPoint = null;
  let lastRawPoint = null;
  let strokeRemainder = 0;

  // Selection and movement state
  let selecting = false;
  let selection = null; // {x, y, width, height, shape, maskCanvas, localMaskCanvas}
  let marqueeDraft = null;
  let lassoDraft = null;
  let penDraft = null;
  let penPointerState = null;
  let textDraft = null;
  let lastTextToolClick = null;
  let selectionMaskPreviewTexture = null;
  let selectionInverseMaskTexture = null;
  const selectionMaskPreview = new PIXI.Sprite(PIXI.Texture.EMPTY);
  selectionMaskPreview.visible = false;
  selectionMaskPreview.renderable = false;
  selectionMaskPreview.alpha = 0.24;
  selectionMaskPreview.tint = SELECTION_OUTLINE_LIGHT;
  selectionMaskPreview.blendMode = PIXI.BLEND_MODES.DIFFERENCE ?? PIXI.BLEND_MODES.NORMAL;
  selectionMaskPreview.position.set(0, 0);
  selectionMaskPreview.width = W;
  selectionMaskPreview.height = H;
  board.addChild(selectionMaskPreview);
  const selectionG = new PIXI.Graphics();
  viewport.addChild(selectionG); // Add to viewport to appear above layers
  const penG = new PIXI.Graphics();
  viewport.addChild(penG);
  const scaleHandlesG = new PIXI.Graphics(); // Scale handles for move tool
  viewport.addChild(scaleHandlesG);
  let selectionSprite = null;
  let selectionSourceRenderTexture = null;
  let draggingSelection = false;
  let scalingSelection = false;
  let rotatingSelection = false;
  let scaleHandle = null; // Which handle is being dragged
  let scaleStartSelection = null; // Original selection for scaling
  let rotationStartAngle = 0; // Starting angle for rotation
  let rotationStartSelectionRotation = 0; // Rotation before the current rotate drag
  let selectionRotation = 0; // Current rotation angle in radians
  let selectionFlipX = false;
  let selectionFlipY = false;
  let dragOffset = { x: 0, y: 0 };
  
  // Transformation state - unified approach
  let transformationMatrix = {
    position: { x: 0, y: 0 },  // Translation
    scale: { x: 1, y: 1 },     // Scale factors
    rotation: 0,               // Rotation in radians
    center: { x: 0, y: 0 }     // Rotation center
  };

  // ========== TRANSFORMATION UTILITIES ==========
  
  /**
   * Update the transformation matrix when selection changes
   */
  function updateTransformationMatrix() {
    if (!selection) {
      transformationMatrix = {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        center: { x: 0, y: 0 }
      };
      return;
    }
    
    transformationMatrix.position.x = selection.x;
    transformationMatrix.position.y = selection.y;
    transformationMatrix.scale.x = 1;
    transformationMatrix.scale.y = 1;
    const pivotPoint = getSelectionPivotPoint();
    transformationMatrix.center.x = pivotPoint.x;
    transformationMatrix.center.y = pivotPoint.y;
    transformationMatrix.rotation = selectionRotation;
  }

  function getPivotRatio(pivotPoint = moveSettings.pivotPoint) {
    switch (pivotPoint) {
      case 'top-left':
        return { x: 0, y: 0 };
      case 'top-right':
        return { x: 1, y: 0 };
      case 'bottom-left':
        return { x: 0, y: 1 };
      case 'bottom-right':
        return { x: 1, y: 1 };
      case 'center':
      case 'custom':
      default:
        return { x: 0.5, y: 0.5 };
    }
  }

  function getSelectionPivotPoint(pivotPoint = moveSettings.pivotPoint) {
    if (!selection) {
      return { x: 0, y: 0 };
    }

    const ratio = getPivotRatio(pivotPoint);
    return {
      x: selection.x + selection.width * ratio.x,
      y: selection.y + selection.height * ratio.y,
    };
  }

  function roundToStep(value, step) {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
      return value;
    }
    return Math.round(value / step) * step;
  }

  function snapPositionValue(value) {
    return moveSettings.snap ? roundToStep(value, MOVE_SNAP_GRID) : value;
  }

  function snapAngleRadians(radians) {
    if (!moveSettings.snap) {
      return radians;
    }

    const degrees = radians * 180 / Math.PI;
    return roundToStep(degrees, MOVE_SNAP_ANGLE_DEGREES) * Math.PI / 180;
  }

  function normalizeAngleDegrees(degrees) {
    if (!Number.isFinite(degrees)) {
      return 0;
    }
    return ((degrees % 360) + 360) % 360;
  }

  function resizeSelectionFromPivot(nextWidth, nextHeight) {
    if (!selection) {
      return false;
    }

    const width = Math.max(1, Math.min(4096, nextWidth));
    const height = Math.max(1, Math.min(4096, nextHeight));
    const pivot = getSelectionPivotPoint();
    const ratio = getPivotRatio();
    selection.x = snapPositionValue(pivot.x - width * ratio.x);
    selection.y = snapPositionValue(pivot.y - height * ratio.y);
    selection.width = moveSettings.snap ? Math.max(1, roundToStep(width, MOVE_SNAP_GRID)) : width;
    selection.height = moveSettings.snap ? Math.max(1, roundToStep(height, MOVE_SNAP_GRID)) : height;
    updateTransformationMatrix();
    applySelectionSpriteTransform();
    drawSelectionOutline();
    drawScaleHandles();
    return true;
  }

  function applySelectionSpriteTransform() {
    if (!selection || !selectionSprite) {
      return;
    }

    updateTransformationMatrix();
    const pivotRatio = getPivotRatio();
    const pivotPoint = getSelectionPivotPoint();
    selectionSprite.anchor.set(pivotRatio.x, pivotRatio.y);
    selectionSprite.position.set(pivotPoint.x, pivotPoint.y);
    selectionSprite.rotation = selectionRotation;
    selectionSprite.width = Math.max(1, selection.width);
    selectionSprite.height = Math.max(1, selection.height);
    selectionSprite.scale.x = (selectionFlipX ? -1 : 1) * Math.abs(selectionSprite.scale.x);
    selectionSprite.scale.y = (selectionFlipY ? -1 : 1) * Math.abs(selectionSprite.scale.y);
  }
  
  /**
   * Transform a point from local coordinates to transformed coordinates
   */
  function transformPoint(localX, localY) {
    if (!selection) return { x: localX, y: localY };
    
    const cos = Math.cos(transformationMatrix.rotation);
    const sin = Math.sin(transformationMatrix.rotation);
    const centerX = transformationMatrix.center.x;
    const centerY = transformationMatrix.center.y;
    
    // Translate to center, rotate, then translate back
    const dx = localX - centerX;
    const dy = localY - centerY;
    
    return {
      x: centerX + (dx * cos - dy * sin) * transformationMatrix.scale.x,
      y: centerY + (dx * sin + dy * cos) * transformationMatrix.scale.y
    };
  }
  
  /**
   * Transform a point from transformed coordinates back to local coordinates
   */
  function inverseTransformPoint(transformedX, transformedY) {
    if (!selection) return { x: transformedX, y: transformedY };
    
    const cos = Math.cos(-transformationMatrix.rotation); // Inverse rotation
    const sin = Math.sin(-transformationMatrix.rotation);
    const centerX = transformationMatrix.center.x;
    const centerY = transformationMatrix.center.y;
    
    // Reverse the transformation
    const dx = (transformedX - centerX) / transformationMatrix.scale.x;
    const dy = (transformedY - centerY) / transformationMatrix.scale.y;
    
    return {
      x: centerX + (dx * cos - dy * sin),
      y: centerY + (dx * sin + dy * cos)
    };
  }
  
  /**
   * Get the transformed bounding box corners of the selection
   */
  function getTransformedCorners() {
    if (!selection) return [];
    
    const corners = [
      { x: selection.x, y: selection.y },
      { x: selection.x + selection.width, y: selection.y },
      { x: selection.x + selection.width, y: selection.y + selection.height },
      { x: selection.x, y: selection.y + selection.height }
    ];
    
    return corners.map(corner => transformPoint(corner.x, corner.y));
  }
  
  /**
   * Check if a point is inside the transformed selection
   */
  function isPointInTransformedSelection(localX, localY) {
    if (!selection) return false;
    
    // Transform the point to the selection's local space
    const localPoint = inverseTransformPoint(localX, localY);
    
    const insideBounds = localPoint.x >= selection.x &&
      localPoint.x < selection.x + selection.width &&
      localPoint.y >= selection.y &&
      localPoint.y < selection.y + selection.height;

    if (!insideBounds) {
      return false;
    }

    if (!selection.localMaskData) {
      return true;
    }

    const u = (localPoint.x - selection.x) / Math.max(1, selection.width);
    const v = (localPoint.y - selection.y) / Math.max(1, selection.height);
    const maskX = Math.max(0, Math.min(selection.localMaskData.width - 1, Math.floor(u * selection.localMaskData.width)));
    const maskY = Math.max(0, Math.min(selection.localMaskData.height - 1, Math.floor(v * selection.localMaskData.height)));
    const alphaIndex = ((maskY * selection.localMaskData.width) + maskX) * 4 + 3;
    return selection.localMaskData.data[alphaIndex] > 8;
  }

  function clampValue(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeSelectionRect(rect) {
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
        !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
      return null;
    }

    const x1 = Math.min(rect.x, rect.x + rect.width);
    const y1 = Math.min(rect.y, rect.y + rect.height);
    const x2 = Math.max(rect.x, rect.x + rect.width);
    const y2 = Math.max(rect.y, rect.y + rect.height);
    return {
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
    };
  }

  function getFixedRatioValue(value) {
    switch (value) {
      case '1:1':
        return 1;
      case '4:3':
        return 4 / 3;
      case '16:9':
        return 16 / 9;
      case '3:2':
        return 3 / 2;
      case 'free':
      default:
        return null;
    }
  }

  function distanceBetweenPoints(pointA, pointB) {
    if (!pointA || !pointB) {
      return Infinity;
    }
    return Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
  }

  function toOverlayPoint(point) {
    return viewport.toLocal(board.toGlobal(new PIXI.Point(point.x, point.y)));
  }

  function getSelectionOutlineWidths() {
    const scale = Math.max(0.1, Math.abs(viewport.scale.x) || 1);
    return {
      outer: 3 / scale,
      inner: 1.25 / scale,
      detail: 0.9 / scale,
    };
  }

  function traceOverlayPolyline(graphics, points, { closed = false } = {}) {
    if (!graphics || !Array.isArray(points) || points.length < 1) {
      return;
    }

    const first = points[0];
    graphics.moveTo(first.x, first.y);
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index];
      graphics.lineTo(point.x, point.y);
    }
    if (closed && points.length > 1) {
      graphics.lineTo(first.x, first.y);
    }
  }

  function drawContrastPolyline(points, {
    clear = false,
    closed = false,
    outerColor = SELECTION_OUTLINE_DARK,
    innerColor = SELECTION_OUTLINE_LIGHT,
    outerAlpha = 0.98,
    innerAlpha = 0.96,
  } = {}) {
    if (!Array.isArray(points) || points.length < 1) {
      if (clear) {
        selectionG.clear();
      }
      return;
    }

    if (clear) {
      selectionG.clear();
    }

    const { outer, inner } = getSelectionOutlineWidths();
    selectionG.lineStyle(outer, outerColor, outerAlpha);
    traceOverlayPolyline(selectionG, points, { closed });
    selectionG.lineStyle(inner, innerColor, innerAlpha);
    traceOverlayPolyline(selectionG, points, { closed });
  }

  function drawContrastShapeOutline(rect, { clear = true } = {}) {
    if (!rect) {
      if (clear) {
        selectionG.clear();
      }
      return;
    }

    if (clear) {
      selectionG.clear();
    }

    const { outer, inner } = getSelectionOutlineWidths();
    const drawShape = (lineWidth, colorValue, alpha = 1) => {
      selectionG.lineStyle(lineWidth, colorValue, alpha);
      if (rect.shape === 'ellipse') {
        const center = board.toGlobal(new PIXI.Point(rect.x + rect.width / 2, rect.y + rect.height / 2));
        const viewportCenter = viewport.toLocal(center);
        selectionG.drawEllipse(viewportCenter.x, viewportCenter.y, rect.width / 2, rect.height / 2);
      } else {
        const topLeft = viewport.toLocal(board.toGlobal(new PIXI.Point(rect.x, rect.y)));
        const bottomRight = viewport.toLocal(board.toGlobal(new PIXI.Point(rect.x + rect.width, rect.y + rect.height)));
        selectionG.drawRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
      }
    };

    drawShape(outer, SELECTION_OUTLINE_DARK, 0.98);
    drawShape(inner, SELECTION_OUTLINE_LIGHT, 0.96);
  }

  function prepareSelectionDraftOperation(operation) {
    if (operation === 'replace') {
      clearSelectionState({ commitSprite: true });
    } else if (selectionSprite) {
      clearSelectionState({ commitSprite: true });
    }
  }

  function buildMarqueeRect(startPoint, currentPoint) {
    const dx = currentPoint.x - startPoint.x;
    const dy = currentPoint.y - startPoint.y;
    const signX = dx < 0 ? -1 : 1;
    const signY = dy < 0 ? -1 : 1;
    let width = Math.abs(dx);
    let height = Math.abs(dy);

    if (marqueeSettings.fixedSize) {
      width = Math.max(1, marqueeSettings.fixedWidth || selection?.width || 256);
      height = Math.max(1, marqueeSettings.fixedHeight || selection?.height || 256);
    } else {
      const ratio = getFixedRatioValue(marqueeSettings.fixedRatio);
      if (ratio && (width > 0 || height > 0)) {
        if (width === 0) {
          width = height * ratio;
        } else if (height === 0) {
          height = width / ratio;
        } else if (width / height > ratio) {
          height = width / ratio;
        } else {
          width = height * ratio;
        }
      }
    }

    return normalizeSelectionRect({
      x: signX < 0 ? startPoint.x - width : startPoint.x,
      y: signY < 0 ? startPoint.y - height : startPoint.y,
      width,
      height,
    });
  }

  function drawSelectionShapeOutline(selectionRect, { clear = true } = {}) {
    if (!selectionRect) {
      if (clear) {
        selectionG.clear();
      }
      return;
    }

    const rect = normalizeSelectionRect(selectionRect);
    if (!rect) {
      return;
    }

    if (clear) {
      selectionG.clear();
    }
    drawContrastShapeOutline(rect, { clear: false });
  }

  function drawMarqueeDraft(rect) {
    if (!rect) {
      selectionG.clear();
      return;
    }

    drawSelectionShapeOutline({
      ...rect,
      shape: marqueeSettings.mode,
    });
  }

  function getLassoDraftPreviewPoints() {
    if (!lassoDraft?.points?.length) {
      return [];
    }

    if (lassoDraft.previewPoint && lassoDraft.mode === 'polygonal') {
      return [...lassoDraft.points, lassoDraft.previewPoint];
    }

    return lassoDraft.points;
  }

  function drawLassoDraft() {
    const points = getLassoDraftPreviewPoints();
    selectionG.clear();
    if (points.length < 1) {
      return;
    }

    const overlayPoints = points.map((point) => toOverlayPoint(point));
    const first = overlayPoints[0];
    drawContrastPolyline(overlayPoints, { clear: true, closed: false });

    if (lassoDraft.isClosingPreview && points.length > 2) {
      const last = overlayPoints[overlayPoints.length - 1];
      drawContrastPolyline([last, first], { clear: false, closed: false, outerAlpha: 0.82, innerAlpha: 0.82 });
    }

    if (lassoDraft.mode === 'polygonal' && lassoDraft.points.length > 0) {
      const { outer, inner, detail } = getSelectionOutlineWidths();
      const radius = 5 / viewport.scale.x;
      selectionG.beginFill(SELECTION_HANDLE_FILL, 1);
      selectionG.lineStyle(outer, SELECTION_HANDLE_STROKE, 1);
      selectionG.drawCircle(first.x, first.y, radius);
      selectionG.endFill();
      selectionG.beginFill(SELECTION_HANDLE_DETAIL, 1);
      selectionG.lineStyle(inner, SELECTION_OUTLINE_LIGHT, 0);
      selectionG.drawCircle(first.x, first.y, Math.max(detail * 1.8, 1.2 / viewport.scale.x));
      selectionG.endFill();
    }
  }

  function getCanvasLuminance(imageData, x, y) {
    const clampedX = Math.max(0, Math.min(imageData.width - 1, x));
    const clampedY = Math.max(0, Math.min(imageData.height - 1, y));
    const index = ((clampedY * imageData.width) + clampedX) * 4;
    return (
      imageData.data[index] * 0.2126 +
      imageData.data[index + 1] * 0.7152 +
      imageData.data[index + 2] * 0.0722
    ) * (imageData.data[index + 3] / 255);
  }

  function snapMagneticLassoPoint(point) {
    if (lassoSettings.mode !== 'magnetic' || !lassoDraft?.sourceImageData || lassoSettings.edgeDetection <= 0) {
      return point;
    }

    const imageData = lassoDraft.sourceImageData;
    const centerX = Math.max(1, Math.min(imageData.width - 2, Math.round(point.x)));
    const centerY = Math.max(1, Math.min(imageData.height - 2, Math.round(point.y)));
    const radius = Math.max(2, Math.round(3 + lassoSettings.edgeDetection * 0.16));
    const threshold = Math.max(8, 48 - lassoSettings.edgeDetection * 0.32);
    let bestPoint = point;
    let bestScore = threshold;

    for (let y = Math.max(1, centerY - radius); y <= Math.min(imageData.height - 2, centerY + radius); y += 1) {
      for (let x = Math.max(1, centerX - radius); x <= Math.min(imageData.width - 2, centerX + radius); x += 1) {
        const gradientX = Math.abs(getCanvasLuminance(imageData, x + 1, y) - getCanvasLuminance(imageData, x - 1, y));
        const gradientY = Math.abs(getCanvasLuminance(imageData, x, y + 1) - getCanvasLuminance(imageData, x, y - 1));
        const distancePenalty = Math.hypot(x - centerX, y - centerY) * 1.35;
        const score = gradientX + gradientY - distancePenalty;
        if (score > bestScore) {
          bestScore = score;
          bestPoint = { x, y };
        }
      }
    }

    return bestPoint;
  }

  function getPreparedLassoPoint(point) {
    return snapMagneticLassoPoint({ x: point.x, y: point.y });
  }

  function addLassoPoint(point, { force = false } = {}) {
    if (!lassoDraft) {
      return false;
    }

    const nextPoint = getPreparedLassoPoint(point);
    const previousPoint = lassoDraft.points[lassoDraft.points.length - 1];
    const minSpacing = lassoDraft.mode === 'polygonal'
      ? 1
      : (lassoDraft.mode === 'magnetic' ? Math.max(2, 7 - lassoSettings.edgeDetection * 0.03) : 2);
    if (!force && previousPoint && distanceBetweenPoints(previousPoint, nextPoint) < minSpacing) {
      return false;
    }

    lassoDraft.points.push(nextPoint);
    drawLassoDraft();
    return true;
  }

  function beginLassoDraft(point, { polygonal = false } = {}) {
    const operation = lassoSettings.selectionOperation;
    prepareSelectionDraftOperation(operation);
    lassoDraft = {
      mode: lassoSettings.mode,
      operation,
      points: [],
      previewPoint: null,
      isDrawing: !polygonal,
      isClosingPreview: false,
      sourceImageData: null,
    };

    if (lassoSettings.mode === 'magnetic') {
      try {
        const sourceCanvas = buildVisibleCompositeCanvas();
        lassoDraft.sourceImageData = sourceCanvas
          .getContext('2d', { willReadFrequently: true })
          .getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
      } catch (error) {
        console.warn('Failed to prepare magnetic lasso source data:', error);
      }
    }

    addLassoPoint(point, { force: true });
  }

  function cancelLassoDraft({ restoreSelectionOutline = true } = {}) {
    lassoDraft = null;
    if (restoreSelectionOutline) {
      drawSelectionOutline();
      drawScaleHandles();
    } else {
      selectionG.clear();
    }
  }

  function thresholdMaskAlpha(maskCanvas) {
    const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    for (let index = 0; index < imageData.data.length; index += 4) {
      const alpha = imageData.data[index + 3] >= 128 ? 255 : 0;
      imageData.data[index] = 255;
      imageData.data[index + 1] = 255;
      imageData.data[index + 2] = 255;
      imageData.data[index + 3] = alpha;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  function buildLassoMask(points) {
    const maskCanvas = createBlankMaskCanvas();
    if (!points || points.length < 3) {
      return maskCanvas;
    }

    const featherPixels = Math.max(0, Math.min(256, lassoSettings.feather || 0));
    const shapeCanvas = featherPixels > 0 ? createBlankMaskCanvas() : maskCanvas;
    const shapeCtx = shapeCanvas.getContext('2d');
    shapeCtx.imageSmoothingEnabled = lassoSettings.antiAlias;
    shapeCtx.fillStyle = '#ffffff';
    shapeCtx.beginPath();
    shapeCtx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      shapeCtx.lineTo(points[index].x, points[index].y);
    }
    shapeCtx.closePath();
    shapeCtx.fill();

    if (!lassoSettings.antiAlias && featherPixels <= 0) {
      thresholdMaskAlpha(maskCanvas);
    }

    if (featherPixels > 0) {
      const maskCtx = maskCanvas.getContext('2d');
      maskCtx.filter = `blur(${featherPixels}px)`;
      maskCtx.drawImage(shapeCanvas, 0, 0);
      maskCtx.filter = 'none';
    }

    return maskCanvas;
  }

  function finalizeLassoSelection() {
    if (!lassoDraft) {
      drawSelectionOutline();
      return false;
    }

    const points = lassoDraft.points.slice();
    const operation = lassoDraft.operation || 'replace';
    lassoDraft = null;

    if (points.length < 3) {
      if (!selection) {
        clearSelectionState({ commitSprite: false });
      } else {
        drawSelectionOutline();
      }
      return false;
    }

    const nextMask = buildLassoMask(points);
    const combinedMask = combineSelectionMasks(selection?.maskCanvas || null, nextMask, operation);
    if (!combinedMask) {
      clearSelectionState({ commitSprite: false });
      return false;
    }

    return setSelectionFromMask(combinedMask, { shape: 'custom' });
  }

  function handlePolygonalLassoPointerDown(point, event) {
    const preparedPoint = getPreparedLassoPoint(point);
    const isDoubleClick = event?.detail >= 2 || event?.data?.originalEvent?.detail >= 2;

    if (!lassoDraft || lassoDraft.mode !== 'polygonal') {
      beginLassoDraft(preparedPoint, { polygonal: true });
      return;
    }

    const firstPoint = lassoDraft.points[0];
    const closeDistance = 9 / Math.max(0.5, viewport.scale.x);
    if ((isDoubleClick || distanceBetweenPoints(preparedPoint, firstPoint) <= closeDistance) && lassoDraft.points.length >= 3) {
      finalizeLassoSelection();
      return;
    }

    addLassoPoint(preparedPoint, { force: true });
  }

  function getLocalMaskAlpha(maskData, x, y) {
    if (x < 0 || y < 0 || x >= maskData.width || y >= maskData.height) {
      return 0;
    }

    return maskData.data[((y * maskData.width) + x) * 4 + 3];
  }

  function drawSelectionMaskEdgeOutline(targetSelection = selection) {
    if (!targetSelection?.localMaskData) {
      return false;
    }

    const maskData = targetSelection.localMaskData;
    const threshold = 16;
    const maxSegments = 24000;
    const overlaySegments = [];

    for (let y = 0; y < maskData.height; y++) {
      for (let x = 0; x < maskData.width; x++) {
        if (getLocalMaskAlpha(maskData, x, y) <= threshold) {
          continue;
        }

        const baseX = targetSelection.x + x;
        const baseY = targetSelection.y + y;
        const leftOpen = getLocalMaskAlpha(maskData, x - 1, y) <= threshold;
        const rightOpen = getLocalMaskAlpha(maskData, x + 1, y) <= threshold;
        const topOpen = getLocalMaskAlpha(maskData, x, y - 1) <= threshold;
        const bottomOpen = getLocalMaskAlpha(maskData, x, y + 1) <= threshold;

        if (leftOpen) {
          overlaySegments.push([
            toOverlayPoint({ x: baseX, y: baseY }),
            toOverlayPoint({ x: baseX, y: baseY + 1 }),
          ]);
        }
        if (rightOpen) {
          overlaySegments.push([
            toOverlayPoint({ x: baseX + 1, y: baseY }),
            toOverlayPoint({ x: baseX + 1, y: baseY + 1 }),
          ]);
        }
        if (topOpen) {
          overlaySegments.push([
            toOverlayPoint({ x: baseX, y: baseY }),
            toOverlayPoint({ x: baseX + 1, y: baseY }),
          ]);
        }
        if (bottomOpen) {
          overlaySegments.push([
            toOverlayPoint({ x: baseX, y: baseY + 1 }),
            toOverlayPoint({ x: baseX + 1, y: baseY + 1 }),
          ]);
        }

        if (overlaySegments.length > maxSegments) {
          selectionG.clear();
          return false;
        }
      }
    }

    if (!overlaySegments.length) {
      selectionG.clear();
      return false;
    }

    const { outer, inner } = getSelectionOutlineWidths();
    selectionG.clear();
    selectionG.lineStyle(outer, SELECTION_OUTLINE_DARK, 0.98);
    overlaySegments.forEach(([start, end]) => {
      selectionG.moveTo(start.x, start.y);
      selectionG.lineTo(end.x, end.y);
    });
    selectionG.lineStyle(inner, SELECTION_OUTLINE_LIGHT, 0.96);
    overlaySegments.forEach(([start, end]) => {
      selectionG.moveTo(start.x, start.y);
      selectionG.lineTo(end.x, end.y);
    });

    return true;
  }

  function createBlankMaskCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    return canvas;
  }

  function quantizeRectToPixels(rect) {
    const x = Math.floor(rect.x);
    const y = Math.floor(rect.y);
    const right = Math.ceil(rect.x + rect.width);
    const bottom = Math.ceil(rect.y + rect.height);
    return {
      x,
      y,
      width: Math.max(0, right - x),
      height: Math.max(0, bottom - y),
    };
  }

  function drawHardEllipseMask(ctx, rect) {
    const pixelRect = quantizeRectToPixels(rect);
    const minX = Math.max(0, pixelRect.x);
    const minY = Math.max(0, pixelRect.y);
    const maxX = Math.min(W, pixelRect.x + pixelRect.width);
    const maxY = Math.min(H, pixelRect.y + pixelRect.height);
    if (minX >= maxX || minY >= maxY) {
      return;
    }

    const imageData = ctx.getImageData(minX, minY, maxX - minX, maxY - minY);
    const data = imageData.data;
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const radiusX = Math.max(0.0001, rect.width / 2);
    const radiusY = Math.max(0.0001, rect.height / 2);

    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        const normalizedX = ((x + 0.5) - centerX) / radiusX;
        const normalizedY = ((y + 0.5) - centerY) / radiusY;
        if ((normalizedX * normalizedX) + (normalizedY * normalizedY) <= 1) {
          const index = (((y - minY) * imageData.width) + (x - minX)) * 4;
          data[index] = 255;
          data[index + 1] = 255;
          data[index + 2] = 255;
          data[index + 3] = 255;
        }
      }
    }

    ctx.putImageData(imageData, minX, minY);
  }

  function drawMarqueeShapeToMask(ctx, rect) {
    if (marqueeSettings.mode === 'ellipse') {
      if (!marqueeSettings.antiAlias && marqueeSettings.feather <= 0) {
        drawHardEllipseMask(ctx, rect);
        return;
      }

      ctx.beginPath();
      ctx.ellipse(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        Math.max(0.5, rect.width / 2),
        Math.max(0.5, rect.height / 2),
        0,
        0,
        Math.PI * 2
      );
      ctx.fill();
      return;
    }

    const pixelRect = quantizeRectToPixels(rect);
    ctx.fillRect(pixelRect.x, pixelRect.y, pixelRect.width, pixelRect.height);
  }

  function buildMarqueeMask(rect) {
    const maskCanvas = createBlankMaskCanvas();
    const featherPixels = Math.max(0, Math.min(256, marqueeSettings.feather || 0));
    const shapeCanvas = featherPixels > 0 ? createBlankMaskCanvas() : maskCanvas;
    const shapeCtx = shapeCanvas.getContext('2d');
    shapeCtx.fillStyle = '#ffffff';
    drawMarqueeShapeToMask(shapeCtx, rect);

    if (featherPixels > 0) {
      const maskCtx = maskCanvas.getContext('2d');
      maskCtx.filter = `blur(${featherPixels}px)`;
      maskCtx.drawImage(shapeCanvas, 0, 0);
      maskCtx.filter = 'none';
    }

    return maskCanvas;
  }

  function combineSelectionMasks(baseMask, nextMask, operation = 'replace') {
    if (!baseMask || operation === 'replace') {
      if (operation === 'subtract' || operation === 'intersect') {
        return null;
      }
      return nextMask;
    }

    const result = createBlankMaskCanvas();
    const resultCtx = result.getContext('2d');
    const resultImageData = resultCtx.createImageData(W, H);
    const resultData = resultImageData.data;
    const baseData = baseMask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    const nextData = nextMask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;

    for (let i = 0; i < resultData.length; i += 4) {
      const baseAlpha = baseData[i + 3];
      const nextAlpha = nextData[i + 3];
      let alpha = nextAlpha;

      if (operation === 'add') {
        alpha = Math.max(baseAlpha, nextAlpha);
      } else if (operation === 'subtract') {
        alpha = Math.round(baseAlpha * (1 - nextAlpha / 255));
      } else if (operation === 'intersect') {
        alpha = Math.round(baseAlpha * (nextAlpha / 255));
      }

      resultData[i] = 255;
      resultData[i + 1] = 255;
      resultData[i + 2] = 255;
      resultData[i + 3] = alpha;
    }

    resultCtx.putImageData(resultImageData, 0, 0);
    return result;
  }

  function getMaskBounds(maskCanvas) {
    const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, W, H);
    const data = imageData.data;
    let minX = W;
    let minY = H;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const alpha = data[((y * W) + x) * 4 + 3];
        if (alpha <= 0) {
          continue;
        }
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    if (maxX < minX || maxY < minY) {
      return null;
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
  }

  function createLocalMask(maskCanvas, bounds) {
    const localCanvas = document.createElement('canvas');
    localCanvas.width = Math.max(1, Math.ceil(bounds.width));
    localCanvas.height = Math.max(1, Math.ceil(bounds.height));
    const localCtx = localCanvas.getContext('2d', { willReadFrequently: true });
    localCtx.drawImage(
      maskCanvas,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      0,
      0,
      localCanvas.width,
      localCanvas.height
    );
    return {
      canvas: localCanvas,
      data: localCtx.getImageData(0, 0, localCanvas.width, localCanvas.height),
    };
  }

  function clearSelectionMaskPreview() {
    selectionMaskPreview.visible = false;
    selectionMaskPreview.renderable = false;
    selectionMaskPreview.texture = PIXI.Texture.EMPTY;

    if (selectionMaskPreviewTexture) {
      selectionMaskPreviewTexture.destroy(true);
      selectionMaskPreviewTexture = null;
    }
    if (selectionInverseMaskTexture) {
      selectionInverseMaskTexture.destroy(true);
      selectionInverseMaskTexture = null;
    }
  }

  function buildInverseSelectionMaskCanvas(maskCanvas) {
    const inverseCanvas = document.createElement('canvas');
    inverseCanvas.width = W;
    inverseCanvas.height = H;
    const inverseCtx = inverseCanvas.getContext('2d');
    const sourceData = maskCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
    const inverseData = inverseCtx.createImageData(W, H);

    for (let i = 0; i < inverseData.data.length; i += 4) {
      const inverseAlpha = 255 - sourceData.data[i + 3];
      inverseData.data[i] = 255;
      inverseData.data[i + 1] = 255;
      inverseData.data[i + 2] = 255;
      inverseData.data[i + 3] = inverseAlpha;
    }

    inverseCtx.putImageData(inverseData, 0, 0);
    return inverseCanvas;
  }

  function refreshSelectionMaskPreview() {
    clearSelectionMaskPreview();
    if (!selection?.maskCanvas || selectionSprite) {
      return;
    }

    selectionMaskPreviewTexture = PIXI.Texture.from(selection.maskCanvas);
    selectionMaskPreview.texture = selectionMaskPreviewTexture;
    selectionMaskPreview.width = W;
    selectionMaskPreview.height = H;
    selectionMaskPreview.visible = true;
    selectionMaskPreview.renderable = true;
    selectionInverseMaskTexture = PIXI.Texture.from(buildInverseSelectionMaskCanvas(selection.maskCanvas));
  }

  function hasActiveSelectionMask() {
    return Boolean(selection?.maskCanvas && !selectionSprite);
  }

  function getSelectionMaskCanvasForSize(width, height) {
    if (!hasActiveSelectionMask()) {
      return null;
    }

    if (selection.maskCanvas.width === width && selection.maskCanvas.height === height) {
      return selection.maskCanvas;
    }

    const scaledMask = document.createElement('canvas');
    scaledMask.width = width;
    scaledMask.height = height;
    scaledMask.getContext('2d').drawImage(selection.maskCanvas, 0, 0, width, height);
    return scaledMask;
  }

  function clipBrushStrokeTextureToSelection() {
    if (!hasActiveSelectionMask() || !selectionInverseMaskTexture) {
      return;
    }

    const inverseMaskSprite = new PIXI.Sprite(selectionInverseMaskTexture);
    inverseMaskSprite.width = W;
    inverseMaskSprite.height = H;
    inverseMaskSprite.position.set(0, 0);
    inverseMaskSprite.blendMode = PIXI.BLEND_MODES.ERASE;
    app.renderer.render(inverseMaskSprite, { renderTexture: brushStrokeTexture, clear: false });
    inverseMaskSprite.destroy();
  }

  function applySelectionMaskToFillMask(mask, width, height) {
    const maskCanvas = getSelectionMaskCanvasForSize(width, height);
    if (!maskCanvas) {
      return mask;
    }

    const selectionData = maskCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    const constrainedMask = new Uint8Array(mask.length);
    for (let pixel = 0; pixel < mask.length; pixel++) {
      constrainedMask[pixel] = Math.round(mask[pixel] * (selectionData[pixel * 4 + 3] / 255));
    }
    return constrainedMask;
  }

  function resetSelectionTransform() {
    selectionRotation = 0;
    rotationStartAngle = 0;
    rotationStartSelectionRotation = 0;
    const pivotPoint = getSelectionPivotPoint();
    transformationMatrix = {
      position: { x: selection?.x || 0, y: selection?.y || 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      center: pivotPoint,
    };
  }

  function setSelectionFromMask(maskCanvas, { shape = 'custom' } = {}) {
    const bounds = getMaskBounds(maskCanvas);
    if (!bounds || bounds.width < 1 || bounds.height < 1) {
      clearSelectionState({ commitSprite: false });
      return false;
    }

    const localMask = createLocalMask(maskCanvas, bounds);
    selection = {
      ...bounds,
      shape,
      maskCanvas,
      localMaskCanvas: localMask.canvas,
      localMaskData: localMask.data,
    };

    draggingSelection = false;
    scalingSelection = false;
    rotatingSelection = false;
    scaleHandle = null;
    scaleStartSelection = null;
    selectionFlipX = false;
    selectionFlipY = false;
    marqueeDraft = null;
    resetSelectionTransform();
    updateTransformationMatrix();
    refreshSelectionMaskPreview();
    drawSelectionOutline();
    drawScaleHandles();
    notifyMoveStateChanged();
    return true;
  }

  function disposeSelectionSprite() {
    if (!selectionSprite) {
      return;
    }

    if (selectionSprite.parent) {
      selectionSprite.parent.removeChild(selectionSprite);
    }
    if (selectionSprite.texture) {
      selectionSprite.texture.destroy({ destroyBase: true });
    }
    selectionSprite.destroy({ children: true });
    selectionSprite = null;
  }

  function commitSelectionSprite() {
    if (!selectionSprite) {
      return false;
    }

    const renderTexture = selectionSourceRenderTexture || getActiveEditableRenderTexture();
    if (!renderTexture || !canEditRenderTexture(renderTexture)) {
      return false;
    }

    rasterizeLayerForRenderTexture(renderTexture);

    const commitSprite = new PIXI.Sprite(selectionSprite.texture);
    commitSprite.anchor.copyFrom(selectionSprite.anchor);
    commitSprite.position.copyFrom(selectionSprite.position);
    commitSprite.scale.copyFrom(selectionSprite.scale);
    commitSprite.rotation = selectionSprite.rotation;
    commitSprite.alpha = selectionSprite.alpha;
    commitSprite.visible = true;
    commitSprite.blendMode = selectionSprite.blendMode;
    app.renderer.render(commitSprite, { renderTexture, clear: false });
    commitSprite.destroy();
    return true;
  }

  function clearSelectionState({ commitSprite = true } = {}) {
    const committed = commitSprite && commitSelectionSprite();
    disposeSelectionSprite();
    selectionSourceRenderTexture = null;

    selection = null;
    marqueeDraft = null;
    lassoDraft = null;
    selecting = false;
    selectionG.clear();
    scaleHandlesG.clear();
    clearSelectionMaskPreview();
    draggingSelection = false;
    scalingSelection = false;
    rotatingSelection = false;
    scaleHandle = null;
    scaleStartSelection = null;
    selectionFlipX = false;
    selectionFlipY = false;
    resetSelectionTransform();
    app.stage.cursor = 'default';

    if (committed) {
      notifyDocumentMutated();
    }
    notifyMoveStateChanged();
  }

  function deleteSelectionContents() {
    if (!selection) {
      return false;
    }

    try {
      if (selectionSprite) {
        clearSelectionState({ commitSprite: false });
        notifyDocumentMutated();
        captureDocumentSnapshot('Delete selection');
        return true;
      }

      const renderTexture = getActiveEditableRenderTexture();
      if (!renderTexture || !selection.maskCanvas) {
        return false;
      }

      rasterizeLayerForRenderTexture(renderTexture);

      const eraseTexture = PIXI.Texture.from(selection.maskCanvas);
      const eraseSprite = new PIXI.Sprite(eraseTexture);
      eraseSprite.width = W;
      eraseSprite.height = H;
      eraseSprite.position.set(0, 0);
      eraseSprite.blendMode = PIXI.BLEND_MODES.ERASE;
      app.renderer.render(eraseSprite, { renderTexture, clear: false });
      eraseSprite.destroy();
      eraseTexture.destroy(true);

      clearSelectionState({ commitSprite: false });
      notifyDocumentMutated();
      captureDocumentSnapshot('Delete selection');
      return true;
    } catch (error) {
      console.error('Failed to delete selection contents:', error);
      return false;
    }
  }

  function discardTransientState() {
    clearSelectionState({ commitSprite: false });
    cancelPenDraft();
    cancelTextDraft();
    clearBrushStrokePreview();
    hideBrushCursor();
    app.stage.cursor = 'default';
  }

  // ========== BRUSH CURSOR ==========
  // Create brush cursor circle that follows mouse
  const brushCursor = new PIXI.Graphics();
  brushCursor.visible = false;
  viewport.addChild(brushCursor); // Add to viewport so it scales with zoom
  
  /**
   * Update brush cursor appearance
   */
  function updateBrushCursor() {
    brushCursor.clear();
    brushCursor.rotation = 0;
    if (tool === 'brush' || tool === 'eraser') {
      const cursorColor = tool === 'brush'
        ? getEffectiveBrushTint()
        : (isEditingLayerMask() ? 0x111111 : 0xff0000);
      brushCursor.lineStyle(1 / viewport.scale.x, cursorColor, 0.8);
      const currentShape = getCurrentBrushShape();
      if (currentShape === 'square') {
        brushCursor.drawRect(-radius, -radius, radius * 2, radius * 2);
      } else if (currentShape === 'flat' && tool === 'brush') {
        brushCursor.rotation = -Math.PI / 6;
        brushCursor.drawEllipse(0, 0, radius, radius * 0.55);
      } else {
        brushCursor.drawCircle(0, 0, radius);
      }
    }
  }
  
  /**
   * Show brush cursor at specified position
   */
  function showBrushCursor(localX, localY) {
    if (tool === 'brush' || tool === 'eraser') {
      brushCursor.position.set(localX, localY);
      brushCursor.visible = true;
      updateBrushCursor();
    }
  }
  
  /**
   * Hide brush cursor
   */
  function hideBrushCursor() {
    brushCursor.visible = false;
  }
  
  /**
   * Draw selection outline using transformation matrix
   */
  function drawSelectionOutline() {
    if (!selection) {
      selectionG.clear();
      return;
    }
    
    updateTransformationMatrix();

    if (selection.shape === 'ellipse' && transformationMatrix.rotation === 0 && !selectionSprite) {
      drawSelectionShapeOutline(selection);
      return;
    }

    if (selection.shape === 'custom' && transformationMatrix.rotation === 0 && !selectionSprite && drawSelectionMaskEdgeOutline(selection)) {
      return;
    }
    
    // Get transformed corners in board coordinates
    const corners = getTransformedCorners();
    
    // Convert to viewport coordinates
    const viewportCorners = corners.map(corner => {
      const globalPoint = board.toGlobal(new PIXI.Point(corner.x, corner.y));
      return viewport.toLocal(globalPoint);
    });
    
    drawContrastPolyline(viewportCorners, { clear: true, closed: true });
  }
  
  /**
   * Draw scale handles using transformation matrix
   */
  function drawScaleHandles() {
    if (!selection || tool !== 'move') {
      scaleHandlesG.clear();
      return;
    }
    
    updateTransformationMatrix();
    
    const handleSize = 6 / viewport.scale.x;
    const halfHandle = handleSize / 2;
    const { outer, inner, detail } = getSelectionOutlineWidths();
    
    scaleHandlesG.clear();
    const allowScaleHandles = moveSettings.transformMode !== 'rotate';
    const allowRotateHandle = moveSettings.transformMode !== 'scale';
    
    // Define handle positions relative to selection box (before transformation)
    const handlePositions = [
      // Corners
      { x: selection.x, y: selection.y, type: 'nw', cursor: 'nw-resize' },
      { x: selection.x + selection.width, y: selection.y, type: 'ne', cursor: 'ne-resize' },
      { x: selection.x, y: selection.y + selection.height, type: 'sw', cursor: 'sw-resize' },
      { x: selection.x + selection.width, y: selection.y + selection.height, type: 'se', cursor: 'se-resize' },
      // Edges
      { x: selection.x + selection.width / 2, y: selection.y, type: 'n', cursor: 'n-resize' },
      { x: selection.x + selection.width / 2, y: selection.y + selection.height, type: 's', cursor: 's-resize' },
      { x: selection.x, y: selection.y + selection.height / 2, type: 'w', cursor: 'w-resize' },
      { x: selection.x + selection.width, y: selection.y + selection.height / 2, type: 'e', cursor: 'e-resize' }
    ];
    
    // Transform handle positions and convert to viewport coordinates
    const transformedHandles = handlePositions.map(handle => {
      const transformed = transformPoint(handle.x, handle.y);
      const globalPoint = board.toGlobal(new PIXI.Point(transformed.x, transformed.y));
      const viewportPoint = viewport.toLocal(globalPoint);
      return { ...handle, x: viewportPoint.x, y: viewportPoint.y };
    });
    
    // Draw scale handles at transformed positions
    if (allowScaleHandles) {
      transformedHandles.forEach(handle => {
        scaleHandlesG.beginFill(SELECTION_HANDLE_FILL, 1);
        scaleHandlesG.lineStyle(outer, SELECTION_HANDLE_STROKE, 1);
        scaleHandlesG.drawRect(
          handle.x - halfHandle,
          handle.y - halfHandle,
          handleSize,
          handleSize
        );
        scaleHandlesG.endFill();
        scaleHandlesG.lineStyle(inner, SELECTION_OUTLINE_LIGHT, 0.7);
        scaleHandlesG.drawRect(
          handle.x - halfHandle,
          handle.y - halfHandle,
          handleSize,
          handleSize
        );
        scaleHandlesG.beginFill(SELECTION_HANDLE_DETAIL, 1);
        scaleHandlesG.drawCircle(handle.x, handle.y, Math.max(detail * 1.35, 1.1 / viewport.scale.x));
        scaleHandlesG.endFill();
      });
    }

    if (!allowRotateHandle) {
      return;
    }
    
    // Draw rotation handle above the selection
    const rotateDistance = 20 / viewport.scale.x;
    const rotateHandleLocal = { x: selection.x + selection.width / 2, y: selection.y - rotateDistance };
    const rotatedRotateHandle = transformPoint(rotateHandleLocal.x, rotateHandleLocal.y);
    const globalRotateHandle = board.toGlobal(new PIXI.Point(rotatedRotateHandle.x, rotatedRotateHandle.y));
    const viewportRotateHandle = viewport.toLocal(globalRotateHandle);
    
    const rotateHandleRadius = 4 / viewport.scale.x;
    
    // Draw connection line from top edge to rotate handle
    const topEdgeLocal = { x: selection.x + selection.width / 2, y: selection.y };
    const transformedTopEdge = transformPoint(topEdgeLocal.x, topEdgeLocal.y);
    const globalTopEdge = board.toGlobal(new PIXI.Point(transformedTopEdge.x, transformedTopEdge.y));
    const viewportTopEdge = viewport.toLocal(globalTopEdge);
    
    scaleHandlesG.lineStyle(outer, SELECTION_HANDLE_STROKE, 0.92);
    scaleHandlesG.moveTo(viewportTopEdge.x, viewportTopEdge.y);
    scaleHandlesG.lineTo(viewportRotateHandle.x, viewportRotateHandle.y);
    scaleHandlesG.lineStyle(inner, SELECTION_OUTLINE_LIGHT, 0.9);
    scaleHandlesG.moveTo(viewportTopEdge.x, viewportTopEdge.y);
    scaleHandlesG.lineTo(viewportRotateHandle.x, viewportRotateHandle.y);
    
    // Draw rotation handle as a circle with rotation icon
    scaleHandlesG.beginFill(SELECTION_HANDLE_FILL, 1);
    scaleHandlesG.lineStyle(outer, SELECTION_HANDLE_STROKE, 1);
    scaleHandlesG.drawCircle(viewportRotateHandle.x, viewportRotateHandle.y, rotateHandleRadius);
    scaleHandlesG.endFill();
    
    // Draw rotation arrow inside the circle
    const arrowRadius = rotateHandleRadius * 0.6;
    scaleHandlesG.lineStyle(inner, SELECTION_HANDLE_DETAIL, 1);
    scaleHandlesG.arc(viewportRotateHandle.x, viewportRotateHandle.y, arrowRadius, -Math.PI / 4, Math.PI * 1.25);
    
    // Draw arrow tip
    const tipX = viewportRotateHandle.x + Math.cos(Math.PI * 1.25) * arrowRadius;
    const tipY = viewportRotateHandle.y + Math.sin(Math.PI * 1.25) * arrowRadius;
    const tipSize = 1.5 / viewport.scale.x;
    scaleHandlesG.moveTo(tipX, tipY);
    scaleHandlesG.lineTo(tipX - tipSize, tipY - tipSize);
    scaleHandlesG.moveTo(tipX, tipY);
    scaleHandlesG.lineTo(tipX + tipSize, tipY - tipSize);
  }
  
  /**
   * Get scale handle at the given viewport coordinates using transformation matrix
   */
  function getScaleHandleAt(viewportPoint) {
    if (!selection || tool !== 'move') return null;
    
    updateTransformationMatrix();
    
    const handleSize = 6 / viewport.scale.x;
    const tolerance = handleSize / 2 + 2 / viewport.scale.x;
    const allowScaleHandles = moveSettings.transformMode !== 'rotate';
    const allowRotateHandle = moveSettings.transformMode !== 'scale';
    
    // Check rotation handle first (highest priority)
    if (allowRotateHandle) {
      const rotateDistance = 20 / viewport.scale.x;
      const rotateHandleLocal = { x: selection.x + selection.width / 2, y: selection.y - rotateDistance };
      const rotatedRotateHandle = transformPoint(rotateHandleLocal.x, rotateHandleLocal.y);
      const globalRotateHandle = board.toGlobal(new PIXI.Point(rotatedRotateHandle.x, rotatedRotateHandle.y));
      const viewportRotateHandle = viewport.toLocal(globalRotateHandle);
      
      const rotateHandleRadius = 4 / viewport.scale.x;
      const rotateTolerance = rotateHandleRadius + 2 / viewport.scale.x;
      
      const rotateDistance2 = Math.hypot(
        viewportPoint.x - viewportRotateHandle.x,
        viewportPoint.y - viewportRotateHandle.y
      );
      
      if (rotateDistance2 <= rotateTolerance) {
        return { x: viewportRotateHandle.x, y: viewportRotateHandle.y, type: 'rotate', cursor: 'grab' };
      }
    }

    if (!allowScaleHandles) {
      return null;
    }
    
    // Define regular scale handle positions (before transformation)
    const handlePositions = [
      // Corners (higher priority)
      { x: selection.x, y: selection.y, type: 'nw', cursor: 'nw-resize' },
      { x: selection.x + selection.width, y: selection.y, type: 'ne', cursor: 'ne-resize' },
      { x: selection.x, y: selection.y + selection.height, type: 'sw', cursor: 'sw-resize' },
      { x: selection.x + selection.width, y: selection.y + selection.height, type: 'se', cursor: 'se-resize' },
      // Edges
      { x: selection.x + selection.width / 2, y: selection.y, type: 'n', cursor: 'n-resize' },
      { x: selection.x + selection.width / 2, y: selection.y + selection.height, type: 's', cursor: 's-resize' },
      { x: selection.x, y: selection.y + selection.height / 2, type: 'w', cursor: 'w-resize' },
      { x: selection.x + selection.width, y: selection.y + selection.height / 2, type: 'e', cursor: 'e-resize' }
    ];
    
    // Transform handle positions and convert to viewport coordinates
    const transformedHandles = handlePositions.map(handle => {
      const transformed = transformPoint(handle.x, handle.y);
      const globalPoint = board.toGlobal(new PIXI.Point(transformed.x, transformed.y));
      const viewportPoint = viewport.toLocal(globalPoint);
      return { ...handle, x: viewportPoint.x, y: viewportPoint.y };
    });
    
    // Check each transformed handle
    for (const handle of transformedHandles) {
      const dx = Math.abs(viewportPoint.x - handle.x);
      const dy = Math.abs(viewportPoint.y - handle.y);
      if (dx <= tolerance && dy <= tolerance) {
        return handle;
      }
    }
    
    return null;
  }

  // ========== DRAWING UTILITIES ==========
  // Reusable stamp graphic for efficient drawing
  let stamp = new PIXI.Sprite(PIXI.Texture.WHITE);

  function getPixiBlendMode(name = 'normal') {
    return blendModeMap[name] || PIXI.BLEND_MODES.NORMAL;
  }

  function isEditingLayerMask() {
    return layersManager?.isEditingMask?.() === true;
  }

  function getMaskBrushGrayValue() {
    const red = (color >> 16) & 0xff;
    const green = (color >> 8) & 0xff;
    const blue = color & 0xff;
    return Math.max(0, Math.min(255, Math.round((red * 0.299) + (green * 0.587) + (blue * 0.114))));
  }

  function getMaskBrushTint() {
    const gray = getMaskBrushGrayValue();
    return (gray << 16) | (gray << 8) | gray;
  }

  function getMaskBrushTargetAlpha() {
    return getMaskBrushGrayValue() / 255;
  }

  function getEffectiveBrushTint() {
    return isEditingLayerMask() ? getMaskBrushTint() : color;
  }

  function getBrushStrokeBlendMode() {
    if (tool === 'eraser') {
      return isEditingLayerMask() || eraserSettings.eraseToTransparency
        ? PIXI.BLEND_MODES.ERASE
        : PIXI.BLEND_MODES.NORMAL;
    }

    return isEditingLayerMask()
      ? PIXI.BLEND_MODES.NORMAL
      : getPixiBlendMode(brushSettings.blendMode);
  }

  function getMaskVisualizationCanvas(sourceCanvas) {
    if (!sourceCanvas) {
      return null;
    }

    const normalizedCanvas = normalizeExtractedCanvas(sourceCanvas);
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = normalizedCanvas.width;
    outputCanvas.height = normalizedCanvas.height;

    const sourceCtx = normalizedCanvas.getContext('2d', { willReadFrequently: true });
    const sourceData = sourceCtx.getImageData(0, 0, normalizedCanvas.width, normalizedCanvas.height);
    const outputCtx = outputCanvas.getContext('2d');
    const outputData = outputCtx.createImageData(normalizedCanvas.width, normalizedCanvas.height);

    for (let i = 0; i < sourceData.data.length; i += 4) {
      const alpha = sourceData.data[i + 3];
      outputData.data[i] = alpha;
      outputData.data[i + 1] = alpha;
      outputData.data[i + 2] = alpha;
      outputData.data[i + 3] = 255;
    }

    outputCtx.putImageData(outputData, 0, 0);
    return outputCanvas;
  }

  function getCurrentBrushShape() {
    return tool === 'brush' ? brushSettings.brushShape : 'round';
  }

  function getCurrentHardness() {
    if (tool === 'brush') {
      return brushSettings.hardness;
    }
    return eraserSettings.softEdge
      ? eraserSettings.hardness
      : 100;
  }

  function ensureBrushStrokeTexture() {
    if (brushStrokeTexture && brushStrokeTexture.width === W && brushStrokeTexture.height === H) {
      return;
    }

    if (brushStrokeTexture) {
      brushStrokeTexture.destroy(true);
    }

    brushStrokeTexture = PIXI.RenderTexture.create({ width: W, height: H, resolution: 1 });
    brushStrokePreview.texture = brushStrokeTexture;
    brushStrokePreview.width = W;
    brushStrokePreview.height = H;
    brushStrokePreview.position.set(0, 0);
  }

  function clearRenderTexture(renderTexture) {
    const clearGraphics = new PIXI.Graphics();
    clearGraphics.beginFill(0x000000, 0);
    clearGraphics.drawRect(0, 0, renderTexture.width, renderTexture.height);
    clearGraphics.endFill();
    app.renderer.render(clearGraphics, { renderTexture, clear: true });
    clearGraphics.destroy();
  }

  function clearBrushStrokePreview() {
    ensureBrushStrokeTexture();
    clearRenderTexture(brushStrokeTexture);
    brushStrokePreview.visible = false;
    brushStrokePreview.renderable = false;
    brushStrokePreview.alpha = 1;
    brushStrokePreview.blendMode = PIXI.BLEND_MODES.NORMAL;
  }

  function beginBrushStroke() {
    ensureBrushStrokeTexture();
    clearRenderTexture(brushStrokeTexture);
    brushStrokePreview.visible = true;
    brushStrokePreview.renderable = true;
    brushStrokePreview.alpha = Math.max(0, Math.min(1, (
      tool === 'eraser' ? eraserSettings.opacity : brushSettings.opacity
    ) / 100));
    brushStrokePreview.blendMode = getBrushStrokeBlendMode();
    strokeRemainder = 0;
  }

  function commitBrushStroke() {
    if (!brushStrokePreview.visible) {
      return false;
    }

    const renderTexture = getActiveEditableRenderTexture();
    if (!renderTexture) {
      clearBrushStrokePreview();
      return false;
    }

    if (isEditingLayerMask() && tool === 'brush') {
      const didCommitMaskStroke = commitMaskBrushStroke(renderTexture);
      clearBrushStrokePreview();
      return didCommitMaskStroke;
    }

    app.renderer.render(brushStrokePreview, { renderTexture, clear: false });
    clearBrushStrokePreview();
    return true;
  }

  function commitMaskBrushStroke(renderTexture) {
    try {
      const targetCanvas = normalizeExtractedCanvas(app.renderer.extract.canvas(renderTexture));
      const strokeCanvas = normalizeExtractedCanvas(app.renderer.extract.canvas(brushStrokeTexture));
      const targetCtx = targetCanvas.getContext('2d', { willReadFrequently: true });
      const strokeCtx = strokeCanvas.getContext('2d', { willReadFrequently: true });
      const targetImage = targetCtx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
      const strokeImage = strokeCtx.getImageData(0, 0, strokeCanvas.width, strokeCanvas.height);
      const targetAlpha = getMaskBrushTargetAlpha();
      const strokeOpacity = Math.max(0, Math.min(1, brushStrokePreview.alpha));
      let didChange = false;

      for (let i = 0; i < strokeImage.data.length; i += 4) {
        const strokeAlpha = (strokeImage.data[i + 3] / 255) * strokeOpacity;
        if (strokeAlpha <= 0) {
          continue;
        }

        const currentAlpha = targetImage.data[i + 3] / 255;
        const nextAlpha = currentAlpha + ((targetAlpha - currentAlpha) * strokeAlpha);
        const nextAlphaByte = Math.max(0, Math.min(255, Math.round(nextAlpha * 255)));

        if (
          targetImage.data[i] !== 255
          || targetImage.data[i + 1] !== 255
          || targetImage.data[i + 2] !== 255
          || targetImage.data[i + 3] !== nextAlphaByte
        ) {
          targetImage.data[i] = 255;
          targetImage.data[i + 1] = 255;
          targetImage.data[i + 2] = 255;
          targetImage.data[i + 3] = nextAlphaByte;
          didChange = true;
        }
      }

      if (!didChange) {
        return false;
      }

      targetCtx.putImageData(targetImage, 0, 0);

      const nextTexture = PIXI.Texture.from(targetCanvas);
      const nextSprite = new PIXI.Sprite(nextTexture);
      try {
        app.renderer.render(nextSprite, { renderTexture, clear: true });
      } finally {
        nextSprite.destroy();
        nextTexture.destroy(true);
      }

      return true;
    } catch (error) {
      console.error('Failed to commit mask brush stroke:', error);
      return false;
    }
  }

  function getBrushSpacingDistance() {
    const activeSize = tool === 'eraser' ? eraserSettings.size : brushSettings.size;
    const activeSpacing = tool === 'eraser' ? eraserSettings.spacing : brushSettings.spacing;
    const diameter = Math.max(1, activeSize * 2);
    return Math.max(1, diameter * (activeSpacing / 100));
  }

  function getBrushFlowAlpha() {
    const activeFlow = tool === 'eraser' ? eraserSettings.flow : brushSettings.flow;
    return Math.max(0.01, Math.min(1, activeFlow / 100));
  }

  function getBrushSmoothingFollow() {
    const smoothing = Math.max(0, Math.min(100, brushSettings.smoothing)) / 100;
    return Math.max(0.08, 1 - smoothing * 0.92);
  }

  function smoothBrushPoint(point) {
    if (tool !== 'brush' || !lastPoint) {
      return point;
    }

    const follow = getBrushSmoothingFollow();
    return {
      x: lastPoint.x + ((point.x - lastPoint.x) * follow),
      y: lastPoint.y + ((point.y - lastPoint.y) * follow),
    };
  }

  function buildBrushStampCanvas() {
    const currentShape = getCurrentBrushShape();
    const currentHardness = Math.max(0, Math.min(100, getCurrentHardness()));
    const baseRadiusX = Math.max(1, radius);
    const baseRadiusY = currentShape === 'flat' ? Math.max(1, radius * 0.55) : Math.max(1, radius);
    const maxRadius = Math.max(baseRadiusX, baseRadiusY);
    const padding = 4;
    const size = Math.ceil((maxRadius * 2) + (padding * 2));
    const center = size / 2;
    const rotation = currentShape === 'flat' ? -Math.PI / 6 : 0;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const softnessBias = currentShape === 'soft-round' ? 0.48 : 1;
    const hardnessRatio = Math.max(0, Math.min(0.999, (currentHardness / 100) * softnessBias));

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(size, size);
    const data = imageData.data;

    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const dx = (px + 0.5) - center;
        const dy = (py + 0.5) - center;
        const rx = (dx * cos) - (dy * sin);
        const ry = (dx * sin) + (dy * cos);

        let distance = 0;
        if (currentShape === 'square') {
          distance = Math.max(Math.abs(rx) / baseRadiusX, Math.abs(ry) / baseRadiusY);
        } else {
          distance = Math.hypot(rx / baseRadiusX, ry / baseRadiusY);
        }

        if (distance > 1) {
          continue;
        }

        let alpha = 1;
        if (distance > hardnessRatio) {
          const fadeSpan = Math.max(0.001, 1 - hardnessRatio);
          const fadeT = Math.max(0, Math.min(1, (distance - hardnessRatio) / fadeSpan));
          alpha = 1 - (fadeT * fadeT * (3 - (2 * fadeT)));
        }

        const index = ((py * size) + px) * 4;
        data[index] = 255;
        data[index + 1] = 255;
        data[index + 2] = 255;
        data[index + 3] = Math.round(alpha * 255);
      }
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }
  
  /**
   * Rebuild the stamp graphic when radius changes
   */
  function rebuildStamp() {
    if (stamp) {
      stamp.destroy({ children: true, texture: true, baseTexture: true });
    }

    feather = Math.max(0, 100 - getCurrentHardness());
    const texture = PIXI.Texture.from(buildBrushStampCanvas());
    stamp = new PIXI.Sprite(texture);
    stamp.anchor.set(0.5);
    updateBrushCursor();
  }
  
  rebuildStamp();

  // ========== COORDINATE UTILITIES ==========
  /**
   * Convert global coordinates to local sprite coordinates
   */
  const toLocal = (gx, gy) => {
    // Always use the board container for coordinate conversion
    // since it contains the artboard positioning regardless of layers
    return board.toLocal(new PIXI.Point(gx, gy));
  };
  
  /**
   * Check if a point is within canvas bounds
   */
  const inBounds = (point) => {
    return point.x >= 0 && point.y >= 0 && point.x < W && point.y < H;
  };

  /**
   * Constrain a point to canvas boundaries
   */
  const clampToBounds = (point) => ({
    x: Math.max(0, Math.min(W - 1, point.x)),
    y: Math.max(0, Math.min(H - 1, point.y))
  });

  // ========== DRAWING FUNCTIONS ==========
  /**
   * Stamp the current brush at the specified coordinates
   */
  function stampAt(x, y) {
    try {
      const renderTexture = (tool === 'brush' || tool === 'eraser') && drawing
        ? brushStrokeTexture
        : getActiveEditableRenderTexture();
      if (!renderTexture) {
        console.warn('No render texture available for stamping');
        return;
      }
      
      stamp.tint = tool === 'eraser' ? 0xffffff : getEffectiveBrushTint();
      stamp.position.set(x, y);
      const oldAlpha = stamp.alpha;
      const oldBlendMode = stamp.blendMode;

      if (tool === 'brush' || tool === 'eraser') {
        stamp.alpha = getBrushFlowAlpha();
        stamp.blendMode = PIXI.BLEND_MODES.NORMAL;
      } else {
        stamp.alpha = 1;
        stamp.blendMode = PIXI.BLEND_MODES.NORMAL;
      }

      app.renderer.render(stamp, { renderTexture, clear: false });
      if ((tool === 'brush' || tool === 'eraser') && drawing) {
        clipBrushStrokeTextureToSelection();
      }
      stamp.alpha = oldAlpha;
      stamp.blendMode = oldBlendMode;
    } catch (error) {
      console.error('Failed to stamp at position:', { x, y, error });
    }
  }
  
  /**
   * Draw a smooth line segment between two points
   */
  function drawSegment(pointA, pointB) {
    const dx = pointB.x - pointA.x;
    const dy = pointB.y - pointA.y;
    const distance = Math.hypot(dx, dy);

    if (distance === 0) {
      stampAt(pointA.x, pointA.y);
      return;
    }

    const stepSize = getBrushSpacingDistance();
    let travel = stepSize - strokeRemainder;

    while (travel <= distance) {
      const t = travel / distance;
      const x = pointA.x + (dx * t);
      const y = pointA.y + (dy * t);
      stampAt(x, y);
      travel += stepSize;
    }

    strokeRemainder = distance - (travel - stepSize);
  }

  // ========== PEN TOOL ==========
  function normalizePenHexColor(value, fallback = '#55cdfc') {
    const normalized = `${value ?? ''}`.trim();
    return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : fallback;
  }

  function clonePoint(point) {
    return point ? { x: point.x, y: point.y } : null;
  }

  function clonePenAnchor(anchor) {
    return {
      x: anchor.x,
      y: anchor.y,
      in: clonePoint(anchor.in),
      out: clonePoint(anchor.out),
    };
  }

  function createPenAnchor(point) {
    return {
      x: point.x,
      y: point.y,
      in: null,
      out: null,
    };
  }

  function getPenClosePath() {
    return Boolean(penDraft?.isClosed || penSettings.closePath);
  }

  function getPenPathSegmentControls(anchors, fromIndex, toIndex, closed) {
    const from = anchors[fromIndex];
    const to = anchors[toIndex];
    let cp1 = clonePoint(from.out);
    let cp2 = clonePoint(to.in);

    if (!cp1 && !cp2 && penSettings.curveHandles === 'automatic' && anchors.length >= 3) {
      const previousIndex = closed
        ? (fromIndex - 1 + anchors.length) % anchors.length
        : Math.max(0, fromIndex - 1);
      const nextNextIndex = closed
        ? (toIndex + 1) % anchors.length
        : Math.min(anchors.length - 1, toIndex + 1);
      const p0 = anchors[previousIndex];
      const p3 = anchors[nextNextIndex];
      cp1 = {
        x: from.x + (to.x - p0.x) / 6,
        y: from.y + (to.y - p0.y) / 6,
      };
      cp2 = {
        x: to.x - (p3.x - from.x) / 6,
        y: to.y - (p3.y - from.y) / 6,
      };
    }

    return {
      cp1: cp1 || { x: from.x, y: from.y },
      cp2: cp2 || { x: to.x, y: to.y },
      isCurve: Boolean(cp1 || cp2),
    };
  }

  function forEachPenPathSegment(anchors, closed, callback) {
    if (!anchors || anchors.length < 2) {
      return;
    }

    const segmentCount = closed && anchors.length >= 3
      ? anchors.length
      : anchors.length - 1;
    for (let index = 0; index < segmentCount; index += 1) {
      const nextIndex = (index + 1) % anchors.length;
      const from = anchors[index];
      const to = anchors[nextIndex];
      const controls = getPenPathSegmentControls(anchors, index, nextIndex, closed);
      callback(from, to, controls, index);
    }
  }

  function tracePenPath(ctx, anchors, closed) {
    if (!anchors || anchors.length < 2) {
      return false;
    }

    ctx.beginPath();
    ctx.moveTo(anchors[0].x, anchors[0].y);
    forEachPenPathSegment(anchors, closed, (_from, to, controls) => {
      if (controls.isCurve) {
        ctx.bezierCurveTo(
          controls.cp1.x,
          controls.cp1.y,
          controls.cp2.x,
          controls.cp2.y,
          to.x,
          to.y
        );
      } else {
        ctx.lineTo(to.x, to.y);
      }
    });

    if (closed) {
      ctx.closePath();
    }

    return true;
  }

  function drawPenPathGraphics(anchors, closed, { colorValue = 0x55cdfc, alpha = 1, lineWidth = 1 / viewport.scale.x } = {}) {
    if (!anchors || anchors.length < 2) {
      return;
    }

    penG.lineStyle(lineWidth, colorValue, alpha);
    const start = toOverlayPoint(anchors[0]);
    penG.moveTo(start.x, start.y);
    forEachPenPathSegment(anchors, closed, (_from, to, controls) => {
      const end = toOverlayPoint(to);
      if (controls.isCurve) {
        const cp1 = toOverlayPoint(controls.cp1);
        const cp2 = toOverlayPoint(controls.cp2);
        penG.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
      } else {
        penG.lineTo(end.x, end.y);
      }
    });
  }

  function drawPenDraft() {
    penG.clear();
    if (!penDraft?.anchors?.length) {
      return;
    }

    const anchors = penDraft.anchors;
    const closed = getPenClosePath();
    const strokeColor = parseInt(normalizePenHexColor(penSettings.strokeColor, '#f7a8b8').slice(1), 16);
    drawPenPathGraphics(anchors, closed, { colorValue: strokeColor, alpha: 0.95 });

    if (!closed && penDraft.previewPoint && anchors.length > 0) {
      const lastAnchor = anchors[anchors.length - 1];
      const previewAnchor = createPenAnchor(penDraft.previewPoint);
      previewAnchor.in = null;
      const previewControls = lastAnchor.out
        ? { cp1: lastAnchor.out, cp2: penDraft.previewPoint, isCurve: true }
        : { cp1: lastAnchor, cp2: penDraft.previewPoint, isCurve: false };
      const start = toOverlayPoint(lastAnchor);
      const end = toOverlayPoint(previewAnchor);
      penG.lineStyle(1 / viewport.scale.x, 0xffffff, 0.45);
      penG.moveTo(start.x, start.y);
      if (previewControls.isCurve) {
        const cp1 = toOverlayPoint(previewControls.cp1);
        penG.bezierCurveTo(cp1.x, cp1.y, end.x, end.y, end.x, end.y);
      } else {
        penG.lineTo(end.x, end.y);
      }
    }

    const handleColor = 0xf7a8b8;
    const anchorColor = 0x55cdfc;
    const handleRadius = 3.5 / viewport.scale.x;
    const anchorSize = 7 / viewport.scale.x;

    anchors.forEach((anchor, index) => {
      const anchorPoint = toOverlayPoint(anchor);
      ['in', 'out'].forEach((handleKey) => {
        const handlePoint = anchor[handleKey];
        if (!handlePoint) {
          return;
        }

        const overlayHandle = toOverlayPoint(handlePoint);
        penG.lineStyle(1 / viewport.scale.x, handleColor, 0.55);
        penG.moveTo(anchorPoint.x, anchorPoint.y);
        penG.lineTo(overlayHandle.x, overlayHandle.y);
        penG.beginFill(0x151a1f, 0.95);
        penG.lineStyle(1 / viewport.scale.x, handleColor, 1);
        penG.drawCircle(overlayHandle.x, overlayHandle.y, handleRadius);
        penG.endFill();
      });

      penG.beginFill(index === 0 ? 0xffffff : 0x151a1f, 0.98);
      penG.lineStyle(1.25 / viewport.scale.x, anchorColor, 1);
      penG.drawRect(anchorPoint.x - anchorSize / 2, anchorPoint.y - anchorSize / 2, anchorSize, anchorSize);
      penG.endFill();
    });
  }

  function ensurePenDraft() {
    if (!penDraft) {
      penDraft = {
        anchors: [],
        isClosed: false,
        previewPoint: null,
      };
    }

    return penDraft;
  }

  function setMirroredPenHandle(anchor, handleKey, handlePoint) {
    const oppositeKey = handleKey === 'in' ? 'out' : 'in';
    anchor[handleKey] = clonePoint(handlePoint);

    if (penSettings.curveHandles === 'independent') {
      return;
    }

    const dx = handlePoint.x - anchor.x;
    const dy = handlePoint.y - anchor.y;
    anchor[oppositeKey] = {
      x: anchor.x - dx,
      y: anchor.y - dy,
    };
  }

  function addPenAnchor(point) {
    const draft = ensurePenDraft();
    if (draft.isClosed) {
      return false;
    }

    const anchor = createPenAnchor(point);
    draft.anchors.push(anchor);
    draft.previewPoint = null;
    penPointerState = {
      type: 'new-handle',
      anchorIndex: draft.anchors.length - 1,
      startPoint: clonePoint(point),
      didDrag: false,
    };
    drawPenDraft();
    return true;
  }

  function beginPenDraft(point) {
    penDraft = {
      anchors: [],
      isClosed: false,
      previewPoint: null,
    };
    return addPenAnchor(point);
  }

  function hitPenControl(point) {
    if (!penDraft?.anchors?.length || !penSettings.anchorEdit) {
      return null;
    }

    const tolerance = 9 / Math.max(0.5, viewport.scale.x);
    for (let index = penDraft.anchors.length - 1; index >= 0; index -= 1) {
      const anchor = penDraft.anchors[index];
      for (const handleKey of ['in', 'out']) {
        if (anchor[handleKey] && distanceBetweenPoints(point, anchor[handleKey]) <= tolerance) {
          return { type: 'handle', anchorIndex: index, handleKey };
        }
      }
    }

    for (let index = penDraft.anchors.length - 1; index >= 0; index -= 1) {
      if (distanceBetweenPoints(point, penDraft.anchors[index]) <= tolerance) {
        return { type: 'anchor', anchorIndex: index };
      }
    }

    return null;
  }

  function startPenControlDrag(hit, point) {
    if (!hit || !penDraft?.anchors?.[hit.anchorIndex]) {
      return false;
    }

    const anchor = penDraft.anchors[hit.anchorIndex];
    penPointerState = {
      type: hit.type,
      anchorIndex: hit.anchorIndex,
      handleKey: hit.handleKey || null,
      startPoint: clonePoint(point),
      anchorStart: clonePenAnchor(anchor),
      didDrag: false,
    };
    app.stage.cursor = hit.type === 'handle' ? 'crosshair' : 'grabbing';
    return true;
  }

  function updatePenPointerDrag(point) {
    if (!penPointerState || !penDraft?.anchors?.[penPointerState.anchorIndex]) {
      return false;
    }

    const anchor = penDraft.anchors[penPointerState.anchorIndex];
    const dx = point.x - penPointerState.startPoint.x;
    const dy = point.y - penPointerState.startPoint.y;
    penPointerState.didDrag = penPointerState.didDrag || Math.hypot(dx, dy) > (2 / Math.max(0.5, viewport.scale.x));

    if (penPointerState.type === 'new-handle') {
      if (penPointerState.didDrag) {
        setMirroredPenHandle(anchor, 'out', {
          x: anchor.x + dx,
          y: anchor.y + dy,
        });
      }
      drawPenDraft();
      return true;
    }

    if (penPointerState.type === 'anchor') {
      anchor.x = penPointerState.anchorStart.x + dx;
      anchor.y = penPointerState.anchorStart.y + dy;
      if (penPointerState.anchorStart.in) {
        anchor.in = {
          x: penPointerState.anchorStart.in.x + dx,
          y: penPointerState.anchorStart.in.y + dy,
        };
      }
      if (penPointerState.anchorStart.out) {
        anchor.out = {
          x: penPointerState.anchorStart.out.x + dx,
          y: penPointerState.anchorStart.out.y + dy,
        };
      }
      drawPenDraft();
      return true;
    }

    if (penPointerState.type === 'handle') {
      setMirroredPenHandle(anchor, penPointerState.handleKey, point);
      drawPenDraft();
      return true;
    }

    return false;
  }

  function cancelPenDraft() {
    penDraft = null;
    penPointerState = null;
    penG.clear();
    app.stage.cursor = 'default';
  }

  function deleteLastPenAnchor() {
    if (!penDraft?.anchors?.length) {
      return false;
    }

    if (penDraft.isClosed) {
      penDraft.isClosed = false;
    } else {
      penDraft.anchors.pop();
    }

    penPointerState = null;
    if (!penDraft.anchors.length) {
      cancelPenDraft();
      return true;
    }

    penDraft.previewPoint = null;
    drawPenDraft();
    return true;
  }

  function buildPenMask(anchors) {
    const maskCanvas = createBlankMaskCanvas();
    if (!anchors || anchors.length < 3) {
      return maskCanvas;
    }

    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.fillStyle = '#ffffff';
    tracePenPath(maskCtx, anchors, true);
    maskCtx.fill();
    return maskCanvas;
  }

  function buildPenRenderCanvas(anchors, closed) {
    if (!anchors || anchors.length < 2) {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, Math.min(64, penSettings.strokeWidth || 1));

    const shouldFill = penSettings.shapeMode === 'filled-shape';
    const shouldClose = closed || shouldFill;
    if (shouldFill && anchors.length < 3) {
      return null;
    }

    if (!tracePenPath(ctx, anchors, shouldClose)) {
      return null;
    }

    if (shouldFill) {
      ctx.fillStyle = normalizePenHexColor(penSettings.fillColor, '#55cdfc');
      ctx.fill();
    } else {
      ctx.strokeStyle = normalizePenHexColor(penSettings.strokeColor, '#f7a8b8');
      ctx.stroke();
    }

    return canvas;
  }

  function clipCanvasToSelectionMask(sourceCanvas) {
    if (!hasActiveSelectionMask()) {
      return sourceCanvas;
    }

    const clippedCanvas = document.createElement('canvas');
    clippedCanvas.width = W;
    clippedCanvas.height = H;
    const clippedCtx = clippedCanvas.getContext('2d');
    clippedCtx.drawImage(sourceCanvas, 0, 0);
    clippedCtx.globalCompositeOperation = 'destination-in';
    clippedCtx.drawImage(selection.maskCanvas, 0, 0);
    clippedCtx.globalCompositeOperation = 'source-over';
    return clippedCanvas;
  }

  function renderSourceCanvasToActiveLayer(sourceCanvas) {
    if (!ensureActiveLayerPreparedForPixelEdit()) {
      return false;
    }

    const renderTexture = getActiveEditableRenderTexture();
    if (!renderTexture || !sourceCanvas) {
      return false;
    }

    const clippedCanvas = clipCanvasToSelectionMask(sourceCanvas);
    const texture = PIXI.Texture.from(clippedCanvas);
    const tempSprite = new PIXI.Sprite(texture);

    try {
      app.renderer.render(tempSprite, { renderTexture, clear: false });
      return true;
    } finally {
      tempSprite.destroy();
      texture.destroy(true);
    }
  }

  function applyPenMaskToActiveLayer(maskCanvas) {
    if (!ensureActiveLayerPreparedForPixelEdit()) {
      return false;
    }

    const renderTexture = getActiveEditableRenderTexture();
    if (!renderTexture || !maskCanvas) {
      return false;
    }

    const inverseMaskCanvas = buildInverseSelectionMaskCanvas(maskCanvas);
    const eraseTexture = PIXI.Texture.from(inverseMaskCanvas);
    const eraseSprite = new PIXI.Sprite(eraseTexture);
    eraseSprite.width = W;
    eraseSprite.height = H;
    eraseSprite.position.set(0, 0);
    eraseSprite.blendMode = PIXI.BLEND_MODES.ERASE;

    try {
      app.renderer.render(eraseSprite, { renderTexture, clear: false });
      return true;
    } finally {
      eraseSprite.destroy();
      eraseTexture.destroy(true);
    }
  }

  function captureDocumentSnapshot(description) {
    if (!window.undoRedoManager) {
      return;
    }

    setTimeout(() => {
      window.undoRedoManager.captureSnapshot(description);
      if (onDrawingComplete && typeof onDrawingComplete === 'function') {
        onDrawingComplete();
      }
    }, 10);
  }

  function commitPenDraft({ forceClose = false } = {}) {
    if (!penDraft?.anchors?.length) {
      cancelPenDraft();
      return false;
    }

    const anchors = penDraft.anchors.map(clonePenAnchor);
    const closed = forceClose ||
      penDraft.isClosed ||
      penSettings.closePath ||
      penSettings.pathMode !== 'path' ||
      penSettings.shapeMode === 'filled-shape';

    if (penSettings.pathMode === 'selection') {
      if (anchors.length < 3) {
        return false;
      }
      const didSetSelection = setSelectionFromMask(buildPenMask(anchors), { shape: 'custom' });
      cancelPenDraft();
      return didSetSelection;
    }

    if (penSettings.pathMode === 'mask') {
      if (anchors.length < 3) {
        return false;
      }
      const didMask = applyPenMaskToActiveLayer(buildPenMask(anchors));
      cancelPenDraft();
      if (didMask) {
        notifyDocumentMutated();
        captureDocumentSnapshot('Pen mask');
      }
      return didMask;
    }

    const penCanvas = buildPenRenderCanvas(anchors, closed);
    const didRender = renderSourceCanvasToActiveLayer(penCanvas);
    cancelPenDraft();
    if (didRender) {
      notifyDocumentMutated();
      captureDocumentSnapshot(penSettings.shapeMode === 'filled-shape' ? 'Pen shape' : 'Pen path');
    }
    return didRender;
  }

  function handlePenPointerDown(localPoint, event) {
    const isDoubleClick = event?.detail >= 2 || event?.data?.originalEvent?.detail >= 2;
    if (!penDraft) {
      beginPenDraft(localPoint);
      return;
    }

    const anchors = penDraft.anchors;
    if (!anchors.length) {
      addPenAnchor(localPoint);
      return;
    }

    const closeDistance = 10 / Math.max(0.5, viewport.scale.x);
    if (!penDraft.isClosed && anchors.length >= 3 && distanceBetweenPoints(localPoint, anchors[0]) <= closeDistance) {
      penDraft.isClosed = true;
      penDraft.previewPoint = null;
      penPointerState = null;
      drawPenDraft();
      if (isDoubleClick) {
        commitPenDraft({ forceClose: true });
      }
      return;
    }

    const hit = hitPenControl(localPoint);
    if (hit && startPenControlDrag(hit, localPoint)) {
      return;
    }

    if (penDraft.isClosed) {
      return;
    }

    addPenAnchor(localPoint);
  }

  // ========== TEXT TOOL ==========
  const TEXT_BOX_PADDING_X = 12;
  const TEXT_BOX_PADDING_Y = 10;
  const TEXT_BOX_MIN_WIDTH = 48;
  const TEXT_BOX_MIN_HEIGHT = 36;
  const TEXT_PLACEHOLDER_LABEL = 'Type text';
  const TEXT_DRAG_BORDER_THRESHOLD = 12;

  function isTextLayer(layer) {
    return layer?.type === 'text' && !!layer?.textData;
  }

  function cloneTextStyle(source = textSettings) {
    return {
      fontFamily: source?.fontFamily || textSettings.fontFamily,
      fontSize: Math.max(8, Math.min(240, source?.fontSize || textSettings.fontSize)),
      bold: source?.bold === true,
      italic: source?.italic === true,
      alignment: ['left', 'center', 'right', 'justify'].includes(source?.alignment) ? source.alignment : 'left',
      color: normalizePenHexColor(source?.color, textSettings.color),
      lineHeight: Math.max(80, Math.min(240, source?.lineHeight || textSettings.lineHeight)),
      letterSpacing: Math.max(-10, Math.min(40, source?.letterSpacing || textSettings.letterSpacing)),
      warp: ['none', 'arc', 'flag', 'bulge'].includes(source?.warp) ? source.warp : 'none',
      textBoxWidth: Math.max(80, Math.min(1200, source?.textBoxWidth || source?.width || textSettings.textBoxWidth)),
      fixedWidth: source?.fixedWidth === true,
    };
  }

  function buildStoredTextLayerData(source = {}) {
    const style = cloneTextStyle(source);
    return {
      x: Math.round(Number.isFinite(source?.x) ? source.x : 0),
      y: Math.round(Number.isFinite(source?.y) ? source.y : 0),
      width: Math.max(style.fixedWidth ? 80 : TEXT_BOX_MIN_WIDTH, Math.round(Number.isFinite(source?.width) ? source.width : style.textBoxWidth)),
      height: Math.max(TEXT_BOX_MIN_HEIGHT, Math.round(Number.isFinite(source?.height) ? source.height : TEXT_BOX_MIN_HEIGHT)),
      text: `${source?.text ?? ''}`.replace(/\r/g, ''),
      ...style,
    };
  }

  function applyTextStyleToDefaults(source = {}) {
    const nextStyle = cloneTextStyle(source);
    textSettings.fontFamily = nextStyle.fontFamily;
    textSettings.fontSize = nextStyle.fontSize;
    textSettings.bold = nextStyle.bold;
    textSettings.italic = nextStyle.italic;
    textSettings.alignment = nextStyle.alignment;
    textSettings.color = nextStyle.color;
    textSettings.lineHeight = nextStyle.lineHeight;
    textSettings.letterSpacing = nextStyle.letterSpacing;
    textSettings.warp = nextStyle.warp;
    textSettings.textBoxWidth = nextStyle.textBoxWidth;
    textSettings.fixedWidth = nextStyle.fixedWidth;
  }

  function getCurrentTextStateSnapshot() {
    const source = textDraft || textSettings;
    const state = cloneTextStyle(source);
    if (textDraft) {
      state.textBoxWidth = Math.max(80, Math.round(textDraft.width || state.textBoxWidth));
    }
    return state;
  }

  function notifyTextStateChanged() {
    if (typeof onTextStateChanged === 'function') {
      onTextStateChanged(getCurrentTextStateSnapshot());
    }
  }

  function getTextFontFamilyCss(fontFamily) {
    switch (fontFamily) {
      case 'jetbrains-mono':
        return '"JetBrains Mono", "Cascadia Code", "SFMono-Regular", Consolas, monospace';
      case 'source-serif':
        return '"Source Serif 4", "Iowan Old Style", Georgia, serif';
      case 'system-sans':
        return '"Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      case 'space-grotesk':
      default:
        return '"Space Grotesk", "Avenir Next", "Segoe UI", system-ui, sans-serif';
    }
  }

  function getTextFontSpec(textState = textSettings, fontSize = textState.fontSize || textSettings.fontSize) {
    const style = textState?.italic ? 'italic ' : '';
    const weight = textState?.bold ? '700 ' : '400 ';
    return `${style}${weight}${Math.max(1, fontSize)}px ${getTextFontFamilyCss(textState?.fontFamily || textSettings.fontFamily)}`;
  }

  function setTextEditorVisibility(isVisible) {
    textEditorOverlay.classList.toggle('is-hidden', !isVisible);
  }

  let textDragState = null;

  function setTextEditorCursor(cursor = 'text') {
    textEditorOverlay.style.cursor = cursor;
    textEditorInput.style.cursor = cursor;
  }

  function clearTextDragState() {
    if (textDragState?.pointerId !== undefined && typeof textEditorInput.hasPointerCapture === 'function') {
      try {
        if (textEditorInput.hasPointerCapture(textDragState.pointerId)) {
          textEditorInput.releasePointerCapture(textDragState.pointerId);
        }
      } catch (error) {
        console.warn('Failed to release text drag pointer capture:', error);
      }
    }
    textDragState = null;
    textEditorOverlay.classList.remove('is-dragging');
    setTextEditorCursor('text');
  }

  function isTextDragHandleHit(event) {
    if (!textDraft || !event) {
      return false;
    }

    const rect = textEditorInput.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return false;
    }

    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    if (pointerX < 0 || pointerX > rect.width || pointerY < 0 || pointerY > rect.height) {
      return false;
    }

    const edgeX = Math.max(6, Math.min(TEXT_DRAG_BORDER_THRESHOLD, (rect.width * 0.5) - 2));
    const edgeY = Math.max(6, Math.min(TEXT_DRAG_BORDER_THRESHOLD, (rect.height * 0.5) - 2));

    return (
      pointerX <= edgeX ||
      pointerX >= rect.width - edgeX ||
      pointerY <= edgeY ||
      pointerY >= rect.height - edgeY
    );
  }

  function refreshTextEditorCursor(event) {
    if (textDragState) {
      setTextEditorCursor('move');
      return;
    }
    setTextEditorCursor(isTextDragHandleHit(event) ? 'move' : 'text');
  }

  function restoreTextEditorSelection(selectionStart, selectionEnd) {
    requestAnimationFrame(() => {
      if (!textDraft) {
        return;
      }

      textEditorInput.focus({ preventScroll: true });
      if (!Number.isInteger(selectionStart) || !Number.isInteger(selectionEnd)) {
        return;
      }

      const maxLength = textEditorInput.value.length;
      const start = Math.max(0, Math.min(maxLength, selectionStart));
      const end = Math.max(start, Math.min(maxLength, selectionEnd));
      textEditorInput.setSelectionRange(start, end);
    });
  }

  function beginTextDraftDrag(event) {
    if (!textDraft || !event) {
      return false;
    }

    textDragState = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: textDraft.x,
      startY: textDraft.y,
      selectionStart: textEditorInput.selectionStart,
      selectionEnd: textEditorInput.selectionEnd,
    };
    textEditorOverlay.classList.add('is-dragging');
    setTextEditorCursor('move');

    if (typeof textEditorInput.setPointerCapture === 'function' && event.pointerId !== undefined) {
      try {
        textEditorInput.setPointerCapture(event.pointerId);
      } catch (error) {
        console.warn('Failed to capture pointer for text drag:', error);
      }
    }

    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function updateTextDraftDrag(event) {
    if (!textDragState || !textDraft || !event) {
      return false;
    }

    const scaleX = Math.max(0.1, viewport.scale.x || 1);
    const scaleY = Math.max(0.1, viewport.scale.y || viewport.scale.x || 1);
    const deltaX = (event.clientX - textDragState.startClientX) / scaleX;
    const deltaY = (event.clientY - textDragState.startClientY) / scaleY;

    textDraft.x = Math.round(textDragState.startX + deltaX);
    textDraft.y = Math.round(textDragState.startY + deltaY);
    updateTextEditorOverlay();
    event.preventDefault();
    return true;
  }

  function endTextDraftDrag() {
    if (!textDragState) {
      return false;
    }

    const { selectionStart, selectionEnd } = textDragState;
    clearTextDragState();
    restoreTextEditorSelection(selectionStart, selectionEnd);
    return true;
  }

  function focusTextEditorInput({ selectAll = false } = {}) {
    requestAnimationFrame(() => {
      textEditorInput.focus();
      if (selectAll) {
        textEditorInput.select();
      } else {
        const cursorIndex = textEditorInput.value.length;
        textEditorInput.setSelectionRange(cursorIndex, cursorIndex);
      }
    });
  }

  function buildNewTextLayerName(textValue = '') {
    const normalized = `${textValue ?? ''}`.replace(/\s+/g, ' ').trim();
    return normalized ? normalized.slice(0, 28) : 'Text';
  }

  function wasTextLayerDoubleClicked(hitTextLayer, point, event) {
    if (!hitTextLayer?.layer) {
      lastTextToolClick = null;
      return false;
    }

    const explicitDoubleClick = event?.detail >= 2 || event?.data?.originalEvent?.detail >= 2;
    const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const previousClick = lastTextToolClick;
    lastTextToolClick = {
      layerId: hitTextLayer.layer.id,
      x: point.x,
      y: point.y,
      timestamp: now,
    };

    if (explicitDoubleClick) {
      return true;
    }

    if (!previousClick || previousClick.layerId !== hitTextLayer.layer.id) {
      return false;
    }

    const elapsed = now - previousClick.timestamp;
    if (elapsed > 400) {
      return false;
    }

    return distanceBetweenPoints(point, previousClick) <= 12 / Math.max(0.5, viewport.scale.x);
  }

  function measureTrackedText(ctx, text, letterSpacing = 0, extraWordSpacing = 0) {
    const characters = Array.from(text || '');
    if (!characters.length) {
      return 0;
    }

    let width = 0;
    characters.forEach((character, index) => {
      width += ctx.measureText(character).width;
      if (index < characters.length - 1) {
        width += letterSpacing;
        if (character === ' ') {
          width += extraWordSpacing;
        }
      }
    });
    return width;
  }

  function wrapTextIntoLines(ctx, text, maxWidth, letterSpacing = 0) {
    const normalizedText = `${text ?? ''}`.replace(/\r/g, '');
    const safeWidth = Math.max(1, maxWidth);
    const paragraphs = normalizedText.split('\n');
    const lines = [];

    paragraphs.forEach((paragraph) => {
      if (!paragraph.length) {
        lines.push('');
        return;
      }

      const tokens = paragraph.match(/\S+\s*/g) || [paragraph];
      let currentLine = '';
      tokens.forEach((token) => {
        const candidate = currentLine + token;
        const candidateTrimmed = candidate.replace(/\s+$/g, '');
        if (currentLine && measureTrackedText(ctx, candidateTrimmed, letterSpacing) > safeWidth) {
          lines.push(currentLine.replace(/\s+$/g, ''));
          if (measureTrackedText(ctx, token.replace(/\s+$/g, ''), letterSpacing) > safeWidth) {
            let segment = '';
            Array.from(token).forEach((character) => {
              const nextSegment = segment + character;
              const nextTrimmed = nextSegment.replace(/\s+$/g, '');
              if (segment && measureTrackedText(ctx, nextTrimmed, letterSpacing) > safeWidth) {
                lines.push(segment.replace(/\s+$/g, ''));
                segment = character === ' ' ? '' : character;
              } else {
                segment = nextSegment;
              }
            });
            currentLine = segment;
          } else {
            currentLine = token;
          }
        } else {
          currentLine = candidate;
        }
      });
      lines.push(currentLine.replace(/\s+$/g, ''));
    });

    return lines.length ? lines : [''];
  }

  function renderTrackedTextLine(ctx, text, startX, topY, letterSpacing = 0, extraWordSpacing = 0) {
    let cursorX = startX;
    Array.from(text || '').forEach((character, index, characters) => {
      ctx.fillText(character, cursorX, topY);
      cursorX += ctx.measureText(character).width;
      if (index < characters.length - 1) {
        cursorX += letterSpacing;
        if (character === ' ') {
          cursorX += extraWordSpacing;
        }
      }
    });
  }

  function renderWarpedTextLine(ctx, text, startX, topY, fontSize, letterSpacing, warp, extraWordSpacing = 0) {
    const characters = Array.from(text || '');
    if (!characters.length) {
      return;
    }

    const glyphs = [];
    let cursorX = 0;
    characters.forEach((character, index) => {
      const glyphWidth = ctx.measureText(character).width;
      glyphs.push({
        character,
        x: cursorX,
        width: glyphWidth,
      });
      cursorX += glyphWidth;
      if (index < characters.length - 1) {
        cursorX += letterSpacing;
        if (character === ' ') {
          cursorX += extraWordSpacing;
        }
      }
    });

    const totalWidth = Math.max(1, cursorX);
    const amplitude = fontSize * 0.28;

    glyphs.forEach((glyph) => {
      const center = (glyph.x + glyph.width * 0.5) / totalWidth;
      let offsetY = 0;
      let rotation = 0;
      let scaleX = 1;
      let scaleY = 1;

      switch (warp) {
        case 'arc':
          offsetY = -Math.sin(center * Math.PI) * amplitude;
          rotation = (center - 0.5) * 0.55;
          break;
        case 'flag':
          offsetY = Math.sin(center * Math.PI * 2) * amplitude * 0.6;
          rotation = Math.cos(center * Math.PI * 2) * 0.08;
          break;
        case 'bulge':
          scaleY = 1 + Math.sin(center * Math.PI) * 0.34;
          offsetY = -(scaleY - 1) * fontSize * 0.18;
          break;
        case 'none':
        default:
          break;
      }

      ctx.save();
      ctx.translate(startX + glyph.x, topY + offsetY);
      if (rotation) {
        ctx.rotate(rotation);
      }
      if (scaleX !== 1 || scaleY !== 1) {
        ctx.scale(scaleX, scaleY);
      }
      ctx.fillText(glyph.character, 0, 0);
      ctx.restore();
    });
  }

  function renderTextLine(ctx, line, boxX, topY, innerWidth, fontSize, letterSpacing, alignment, warp, isLastLine) {
    const safeWidth = Math.max(1, innerWidth);
    let extraWordSpacing = 0;
    let measuredWidth = measureTrackedText(ctx, line, letterSpacing);
    const justify = alignment === 'justify' && !isLastLine && /\s/.test(line);

    if (justify) {
      const spaceCount = Array.from(line).filter((character) => character === ' ').length;
      if (spaceCount > 0 && measuredWidth < safeWidth) {
        extraWordSpacing = (safeWidth - measuredWidth) / spaceCount;
        measuredWidth = safeWidth;
      }
    }

    let drawX = boxX;
    if (alignment === 'center') {
      drawX += (safeWidth - measuredWidth) * 0.5;
    } else if (alignment === 'right') {
      drawX += safeWidth - measuredWidth;
    }

    if (warp && warp !== 'none') {
      renderWarpedTextLine(ctx, line, drawX, topY, fontSize, letterSpacing, warp, extraWordSpacing);
      return;
    }

    renderTrackedTextLine(ctx, line, drawX, topY, letterSpacing, extraWordSpacing);
  }

  function measureTextLayout(source = {}) {
    const textData = buildStoredTextLayerData(source);
    const measureCanvas = document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d');
    const fontSize = Math.max(8, textData.fontSize);
    const lineHeightPx = fontSize * Math.max(0.8, textData.lineHeight / 100);
    const letterSpacing = textData.letterSpacing;

    ctx.font = getTextFontSpec(textData, fontSize);
    ctx.textBaseline = 'top';

    let boxWidth = textData.fixedWidth
      ? Math.max(80, textData.width || textData.textBoxWidth)
      : Math.max(TEXT_BOX_MIN_WIDTH, textData.width || TEXT_BOX_MIN_WIDTH);
    let lines = [];

    if (textData.fixedWidth) {
      const innerWidth = Math.max(1, boxWidth - TEXT_BOX_PADDING_X * 2);
      lines = wrapTextIntoLines(ctx, textData.text, innerWidth, letterSpacing);
    } else {
      lines = textData.text.split('\n');
      if (!lines.length) {
        lines = [''];
      }
      const widestLine = lines.reduce((maxWidth, line) => Math.max(maxWidth, measureTrackedText(ctx, line, letterSpacing)), 0);
      const placeholderWidth = !textData.text.trim()
        ? measureTrackedText(ctx, TEXT_PLACEHOLDER_LABEL, letterSpacing)
        : 0;
      boxWidth = Math.max(TEXT_BOX_MIN_WIDTH, Math.ceil(widestLine + TEXT_BOX_PADDING_X * 2));
      boxWidth = Math.max(boxWidth, Math.ceil(placeholderWidth + TEXT_BOX_PADDING_X * 2));
    }

    if (!lines.length) {
      lines = [''];
    }

    const innerWidth = Math.max(1, boxWidth - TEXT_BOX_PADDING_X * 2);
    const boxHeight = Math.max(TEXT_BOX_MIN_HEIGHT, Math.ceil((lines.length * lineHeightPx) + (TEXT_BOX_PADDING_Y * 2)));

    return {
      ...textData,
      width: Math.round(boxWidth),
      height: Math.round(boxHeight),
      lines,
      innerWidth,
      fontSize,
      lineHeightPx,
      letterSpacing,
    };
  }

  function syncTextDraftLayout() {
    if (!textDraft) {
      return null;
    }

    const layout = measureTextLayout(textDraft);
    Object.assign(textDraft, {
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height,
      text: layout.text,
      fontFamily: layout.fontFamily,
      fontSize: layout.fontSize,
      bold: layout.bold,
      italic: layout.italic,
      alignment: layout.alignment,
      color: layout.color,
      lineHeight: layout.lineHeight,
      letterSpacing: layout.letterSpacing,
      warp: layout.warp,
      textBoxWidth: Math.max(80, layout.fixedWidth ? layout.width : layout.textBoxWidth),
      fixedWidth: layout.fixedWidth,
    });
    return layout;
  }

  function updateTextEditorOverlay() {
    if (!textDraft) {
      setTextEditorVisibility(false);
      return;
    }

    const layout = syncTextDraftLayout();
    const topLeft = board.toGlobal(new PIXI.Point(layout.x, layout.y));
    const scale = Math.max(0.1, viewport.scale.x);
    const paddingX = TEXT_BOX_PADDING_X * scale;
    const paddingY = TEXT_BOX_PADDING_Y * scale;
    const fontSize = Math.max(10, layout.fontSize * scale);
    const letterSpacing = layout.letterSpacing * scale;
    const overlayWidth = Math.max(TEXT_BOX_MIN_WIDTH * scale, layout.width * scale);
    const overlayHeight = Math.max(TEXT_BOX_MIN_HEIGHT * scale, layout.height * scale);

    textEditorOverlay.style.left = `${topLeft.x}px`;
    textEditorOverlay.style.top = `${topLeft.y}px`;
    textEditorOverlay.style.width = `${overlayWidth}px`;
    textEditorOverlay.style.height = `${overlayHeight}px`;
    textEditorOverlay.dataset.fixedWidth = String(layout.fixedWidth === true);

    textEditorInput.wrap = layout.fixedWidth ? 'soft' : 'off';
    textEditorInput.style.width = '100%';
    textEditorInput.style.height = `${overlayHeight}px`;
    textEditorInput.style.font = getTextFontSpec(layout, fontSize);
    textEditorInput.style.fontSize = `${fontSize}px`;
    textEditorInput.style.fontFamily = getTextFontFamilyCss(layout.fontFamily);
    textEditorInput.style.fontWeight = layout.bold ? '700' : '400';
    textEditorInput.style.fontStyle = layout.italic ? 'italic' : 'normal';
    textEditorInput.style.lineHeight = String(Math.max(0.8, layout.lineHeight / 100));
    textEditorInput.style.letterSpacing = `${letterSpacing}px`;
    textEditorInput.style.textAlign = layout.alignment === 'justify' ? 'left' : layout.alignment;
    textEditorInput.style.color = normalizePenHexColor(layout.color, '#f5f7fa');
    textEditorInput.style.padding = `${paddingY}px ${paddingX}px`;
    textEditorInput.style.whiteSpace = layout.fixedWidth ? 'pre-wrap' : 'pre';
    textEditorInput.style.overflowX = 'hidden';
    textEditorInput.style.overflowY = 'hidden';

    setTextEditorVisibility(true);
  }

  function getTextLayerHit(localPoint) {
    if (!layersManager) {
      return null;
    }

    const layers = layersManager.getLayers();
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const layer = layers[index];
      if (!layer || layer.visible === false || !isTextLayer(layer)) {
        continue;
      }

      const bounds = measureTextLayout(layer.textData);
      if (
        localPoint.x >= bounds.x &&
        localPoint.x <= bounds.x + bounds.width &&
        localPoint.y >= bounds.y &&
        localPoint.y <= bounds.y + bounds.height
      ) {
        return { layer, index, textData: bounds };
      }
    }

    return null;
  }

  function buildTextRenderCanvas(source) {
    const layout = measureTextLayout(source);
    if (!layout.text.trim()) {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.font = getTextFontSpec(layout, layout.fontSize);
    ctx.textBaseline = 'top';
    ctx.fillStyle = normalizePenHexColor(layout.color, '#f5f7fa');
    ctx.imageSmoothingEnabled = true;

    layout.lines.forEach((line, index) => {
      renderTextLine(
        ctx,
        line,
        layout.x + TEXT_BOX_PADDING_X,
        layout.y + TEXT_BOX_PADDING_Y + (index * layout.lineHeightPx),
        layout.innerWidth,
        layout.fontSize,
        layout.letterSpacing,
        layout.alignment,
        layout.warp,
        index === layout.lines.length - 1
      );
    });

    return {
      canvas,
      layout,
    };
  }

  function clearRenderTexture(renderTexture) {
    if (!renderTexture) {
      return false;
    }

    const clearGraphics = new PIXI.Graphics();
    clearGraphics.beginFill(0x000000, 0);
    clearGraphics.drawRect(0, 0, renderTexture.width, renderTexture.height);
    clearGraphics.endFill();
    app.renderer.render(clearGraphics, { renderTexture, clear: true });
    clearGraphics.destroy();
    return true;
  }

  function renderCanvasToLayer(renderTexture, sourceCanvas) {
    if (!renderTexture || !sourceCanvas) {
      return false;
    }

    const texture = PIXI.Texture.from(sourceCanvas);
    const tempSprite = new PIXI.Sprite(texture);
    try {
      app.renderer.render(tempSprite, { renderTexture, clear: false });
      return true;
    } finally {
      tempSprite.destroy();
      texture.destroy(true);
    }
  }

  function renderTextDataToLayer(layerIndex, source) {
    if (!layersManager || !Number.isInteger(layerIndex) || layerIndex < 0) {
      return false;
    }

    const layer = layersManager.getLayer(layerIndex);
    if (!layer) {
      return false;
    }

    const renderResult = buildTextRenderCanvas(source);
    const nextTextData = renderResult?.layout ? buildStoredTextLayerData(renderResult.layout) : null;

    clearRenderTexture(layer.renderTexture);
    if (renderResult?.canvas) {
      renderCanvasToLayer(layer.renderTexture, renderResult.canvas);
    }

    layersManager.updateLayer(layerIndex, {
      type: nextTextData ? 'text' : 'paint',
      textData: nextTextData,
    });
    return true;
  }

  function findLayerIndexById(layerId) {
    if (!layersManager || !Number.isInteger(layerId)) {
      return -1;
    }
    return layersManager.getLayerIndexById(layerId);
  }

  function resolveTextDraftLayer() {
    const layerIndex = findLayerIndexById(textDraft?.layerId);
    if (layerIndex < 0 || !layersManager) {
      return null;
    }

    const layer = layersManager.getLayer(layerIndex);
    return layer ? { layer, layerIndex } : null;
  }

  function finalizeTextDraftState() {
    clearTextDragState();
    textDraft = null;
    lastTextToolClick = null;
    textEditorInput.value = '';
    setTextEditorVisibility(false);
    notifyTextStateChanged();
  }

  function beginTextDraft(point) {
    if (textDraft) {
      commitTextDraft();
    }

    lastTextToolClick = null;

    const initialDraft = buildStoredTextLayerData({
      ...cloneTextStyle(textSettings),
      x: point.x,
      y: point.y,
      width: textSettings.fixedWidth ? textSettings.textBoxWidth : TEXT_BOX_MIN_WIDTH,
      height: TEXT_BOX_MIN_HEIGHT,
      text: '',
    });

    if (!layersManager) {
      textDraft = {
        mode: 'new',
        layerId: null,
        originalName: '',
        originalTextData: null,
        ...initialDraft,
      };
    } else {
      const activeLayerIndex = layersManager.getActiveLayerIndex();
      const insertIndex = Number.isInteger(activeLayerIndex)
        ? activeLayerIndex + 1
        : layersManager.getLayers().length;
      const layer = layersManager.addLayer({
        insertIndex,
        name: buildNewTextLayerName(),
        type: 'text',
        textData: null,
      });
      textDraft = {
        mode: 'new',
        layerId: layer.id,
        originalName: layer.name,
        originalTextData: null,
        ...initialDraft,
      };
    }

    textEditorInput.value = '';
    updateTextEditorOverlay();
    notifyTextStateChanged();
    focusTextEditorInput();
  }

  function beginTextLayerEdit(layerIndex) {
    if (!layersManager || !Number.isInteger(layerIndex)) {
      return false;
    }

    const layer = layersManager.getLayer(layerIndex);
    if (!layer || !isTextLayer(layer) || layer.locked === true) {
      return false;
    }

    if (textDraft?.layerId !== layer.id) {
      commitTextDraft();
    }

    layersManager.setActiveLayer(layerIndex);
    lastTextToolClick = null;
    const textData = buildStoredTextLayerData(layer.textData);
    textDraft = {
      mode: 'edit',
      layerId: layer.id,
      originalName: layer.name,
      originalTextData: buildStoredTextLayerData(layer.textData),
      ...textData,
    };
    applyTextStyleToDefaults(textData);
    textEditorInput.value = textData.text;
    updateTextEditorOverlay();
    notifyTextStateChanged();
    focusTextEditorInput();
    return true;
  }

  function cancelTextDraft({ removeNewLayer = true } = {}) {
    const draftLayer = resolveTextDraftLayer();
    const shouldRemoveLayer = removeNewLayer &&
      textDraft?.mode === 'new' &&
      draftLayer;

    if (shouldRemoveLayer && layersManager) {
      layersManager.removeLayer(draftLayer.layerIndex, true);
    }

    finalizeTextDraftState();
  }

  function commitTextDraft() {
    if (!textDraft) {
      return false;
    }

    const textMode = textDraft.mode;
    textDraft.text = textEditorInput.value.replace(/\r/g, '');
    const draftLayer = resolveTextDraftLayer();

    if (!textDraft.text.trim()) {
      if (draftLayer?.layerIndex >= 0 && layersManager) {
        layersManager.removeLayer(draftLayer.layerIndex, true);
        if (textMode === 'edit') {
          notifyDocumentMutated();
          captureDocumentSnapshot('Delete text');
        }
      }
      finalizeTextDraftState();
      return false;
    }

    if (!draftLayer) {
      const textRenderResult = buildTextRenderCanvas(textDraft);
      const didRender = renderSourceCanvasToActiveLayer(textRenderResult?.canvas || null);
      finalizeTextDraftState();
      if (didRender) {
        notifyDocumentMutated();
        captureDocumentSnapshot('Text');
      }
      return didRender;
    }

    const nextTextData = buildStoredTextLayerData(syncTextDraftLayout());
    const didRender = renderTextDataToLayer(draftLayer.layerIndex, nextTextData);
    if (didRender) {
      layersManager.updateLayer(draftLayer.layerIndex, {
        name: textMode === 'new'
          ? buildNewTextLayerName(nextTextData.text)
          : draftLayer.layer.name,
      });
    }
    finalizeTextDraftState();

    if (didRender) {
      notifyDocumentMutated();
      captureDocumentSnapshot(textMode === 'edit' ? 'Edit text' : 'Add text');
    }

    return didRender;
  }

  textEditorInput.addEventListener('input', () => {
    if (!textDraft) {
      return;
    }
    textDraft.text = textEditorInput.value.replace(/\r/g, '');
    updateTextEditorOverlay();
  });

  textEditorInput.addEventListener('keydown', (event) => {
    const commitWithModifier = event.key === 'Enter' && (event.metaKey || event.ctrlKey);
    const commitPointText = event.key === 'Enter' && !event.shiftKey && !textDraft?.fixedWidth;

    if (commitWithModifier || commitPointText) {
      event.preventDefault();
      commitTextDraft();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelTextDraft();
    }
  });

  textEditorInput.addEventListener('blur', () => {
    requestAnimationFrame(() => {
      if (textDragState) {
        return;
      }
      if (textDraft && document.activeElement !== textEditorInput) {
        commitTextDraft();
      }
    });
  });

  textEditorInput.addEventListener('pointerdown', (event) => {
    if (!textDraft || !isTextDragHandleHit(event)) {
      refreshTextEditorCursor(event);
      return;
    }
    beginTextDraftDrag(event);
  });

  textEditorInput.addEventListener('pointermove', (event) => {
    if (textDragState?.pointerId === event.pointerId) {
      updateTextDraftDrag(event);
      return;
    }
    refreshTextEditorCursor(event);
  });

  textEditorInput.addEventListener('pointerup', (event) => {
    if (textDragState?.pointerId === event.pointerId) {
      event.preventDefault();
      endTextDraftDrag();
      return;
    }
    refreshTextEditorCursor(event);
  });

  textEditorInput.addEventListener('pointercancel', () => {
    endTextDraftDrag();
  });

  textEditorInput.addEventListener('lostpointercapture', () => {
    endTextDraftDrag();
  });

  textEditorInput.addEventListener('pointerleave', () => {
    if (!textDragState) {
      setTextEditorCursor('text');
    }
  });

  function notifyDocumentMutated() {
    if (onDocumentMutated && typeof onDocumentMutated === 'function') {
      onDocumentMutated();
    }
  }

  function getMoveStateSnapshot() {
    return {
      hasSelection: Boolean(selection),
      transformMode: moveSettings.transformMode,
      uniformScale: moveSettings.uniformScale,
      pivotPoint: moveSettings.pivotPoint,
      snap: moveSettings.snap,
      angle: normalizeAngleDegrees(selectionRotation * 180 / Math.PI),
      width: selection ? Math.round(selection.width) : null,
      height: selection ? Math.round(selection.height) : null,
      flipHorizontal: selectionFlipX,
      flipVertical: selectionFlipY,
    };
  }

  function notifyMoveStateChanged() {
    if (typeof onMoveStateChanged !== 'function') {
      return;
    }

    try {
      onMoveStateChanged(getMoveStateSnapshot());
    } catch (error) {
      console.error('Failed to notify move state listener:', error);
    }
  }

  function getActiveReadRenderTexture() {
    return layersManager ? layersManager.getActiveRenderTexture() : rt;
  }

  function getActiveEditableRenderTexture() {
    return layersManager ? layersManager.getActiveEditableRenderTexture() : rt;
  }

  function canEditRenderTexture(renderTexture) {
    if (!renderTexture) {
      return false;
    }

    return layersManager ? layersManager.canEditRenderTexture(renderTexture) : true;
  }

  function hasEditableActiveLayer() {
    return !!getActiveEditableRenderTexture();
  }

  function rasterizeLayerAtIndex(layerIndex) {
    if (!layersManager || !Number.isInteger(layerIndex) || layerIndex < 0) {
      return false;
    }

    const layer = layersManager.getLayer(layerIndex);
    if (!layer || !isTextLayer(layer)) {
      return false;
    }

    layersManager.updateLayer(layerIndex, {
      type: 'paint',
      textData: null,
    });
    return true;
  }

  function rasterizeLayerForRenderTexture(renderTexture) {
    if (!layersManager || !renderTexture) {
      return false;
    }

    const targetInfo = layersManager.getLayerRenderTargetInfo?.(renderTexture);
    if (!targetInfo || targetInfo.target === 'mask') {
      return false;
    }

    return rasterizeLayerAtIndex(targetInfo.index);
  }

  function ensureActiveLayerPreparedForPixelEdit() {
    if (!layersManager) {
      return true;
    }

    const activeLayerIndex = layersManager.getActiveLayerIndex();
    if (!Number.isInteger(activeLayerIndex) || activeLayerIndex < 0) {
      return false;
    }

    const layer = layersManager.getLayer(activeLayerIndex);
    if (!layer || layer.locked === true) {
      return false;
    }

    if (layersManager.isEditingMask?.()) {
      return true;
    }

    if (isTextLayer(layer)) {
      rasterizeLayerAtIndex(activeLayerIndex);
    }

    return true;
  }
  
  /**
   * Set the layers manager for this editor
   * @param {Object} manager - Layers manager instance
   */
  function setLayersManager(manager) {
    layersManager = manager;
    
    // Replace the single sprite with the layer container
    if (layersManager) {
      board.removeChild(sprite);
      const layerContainer = layersManager.getLayerContainer();
      board.addChildAt(layerContainer, 0);
      
      const syncActiveRenderTarget = () => {
        rt = layersManager.getActiveEditableRenderTexture()
          || layersManager.getActiveRenderTexture()
          || rt;
        updateBrushCursor();
      };

      syncActiveRenderTarget();

      layersManager.on('activeLayerChanged', () => {
        syncActiveRenderTarget();
      });
      layersManager.on('activeLayerEditTargetChanged', () => {
        syncActiveRenderTarget();
      });
      
      // Listen for resize events
      layersManager.on('layersResized', ({ width, height }) => {
        W = width;
        H = height;
        ensureBrushStrokeTexture();
        clearBrushStrokePreview();
        border.clear().lineStyle(1, 0x333333, 1).drawRect(-0.5, -0.5, W + 1, H + 1);
        updateFadeOverlay();
        fitAndCenter();
      });
    }
  }

  function normalizeExtractedCanvas(extracted) {
    if (extracted.width === W && extracted.height === H) {
      return extracted;
    }

    const normalized = document.createElement('canvas');
    normalized.width = W;
    normalized.height = H;
    const ctx = normalized.getContext('2d');
    ctx.drawImage(extracted, 0, 0, W, H);
    return normalized;
  }

  function addSelectionOverlaySprite(targetRoot, tempSprites) {
    if (!selectionSprite) {
      return;
    }

    const overlaySprite = new PIXI.Sprite(selectionSprite.texture);
    overlaySprite.anchor.copyFrom(selectionSprite.anchor);
    overlaySprite.position.copyFrom(selectionSprite.position);
    overlaySprite.scale.copyFrom(selectionSprite.scale);
    overlaySprite.rotation = selectionSprite.rotation;
    overlaySprite.alpha = selectionSprite.alpha;
    overlaySprite.visible = selectionSprite.visible;
    overlaySprite.blendMode = selectionSprite.blendMode;
    targetRoot.addChild(overlaySprite);
    tempSprites.push(overlaySprite);
  }

  function addBrushPreviewSprite(targetRoot, tempSprites) {
    if (!brushStrokePreview.visible) {
      return;
    }

    const strokeSprite = new PIXI.Sprite(brushStrokeTexture);
    strokeSprite.alpha = brushStrokePreview.alpha;
    strokeSprite.visible = true;
    strokeSprite.blendMode = brushStrokePreview.blendMode;
    targetRoot.addChild(strokeSprite);
    tempSprites.push(strokeSprite);
  }

  function appendLayerDisplayToRoot(targetRoot, layer, tempSprites, {
    includeOpacity = true,
    includeBlendMode = true,
    respectVisibility = true,
  } = {}) {
    if (!layer) {
      return;
    }

    const layerContainerClone = new PIXI.Container();
    layerContainerClone.visible = respectVisibility ? layer.visible !== false : true;
    layerContainerClone.alpha = includeOpacity ? layer.opacity : 1;

    const layerSprite = new PIXI.Sprite(layer.renderTexture);
    layerSprite.alpha = 1;
    layerSprite.visible = true;
    layerSprite.blendMode = includeBlendMode ? layer.sprite.blendMode : PIXI.BLEND_MODES.NORMAL;
    layerContainerClone.addChild(layerSprite);
    tempSprites.push(layerSprite);

    if (layer.maskRenderTexture && layer.maskEnabled !== false) {
      const maskSprite = new PIXI.Sprite(layer.maskRenderTexture);
      maskSprite.position.set(0, 0);
      layerContainerClone.addChild(maskSprite);
      layerSprite.mask = maskSprite;
      tempSprites.push(maskSprite);
    }

    targetRoot.addChild(layerContainerClone);
    tempSprites.push(layerContainerClone);
  }

  function renderDisplayRootToCanvas(displayRoot) {
    let renderTexture = null;

    try {
      renderTexture = PIXI.RenderTexture.create({ width: W, height: H, resolution: 1 });
      app.renderer.render(displayRoot, { renderTexture, clear: true });
      const extracted = app.renderer.extract.canvas(renderTexture);
      return normalizeExtractedCanvas(extracted);
    } finally {
      if (renderTexture) {
        renderTexture.destroy(true);
      }
    }
  }

  function buildVisibleCompositeCanvas() {
    const compositeRoot = new PIXI.Container();
    const tempSprites = [];

    try {
      if (layersManager) {
        layersManager.getLayers().forEach((layer) => {
          if (!layer.visible) {
            return;
          }

          appendLayerDisplayToRoot(compositeRoot, layer, tempSprites, {
            includeOpacity: true,
            includeBlendMode: true,
            respectVisibility: true,
          });
        });
      } else {
        const baseSprite = new PIXI.Sprite(sprite.texture);
        compositeRoot.addChild(baseSprite);
        tempSprites.push(baseSprite);
      }

      if (!isEditingLayerMask()) {
        addSelectionOverlaySprite(compositeRoot, tempSprites);
        addBrushPreviewSprite(compositeRoot, tempSprites);
      }
      return renderDisplayRootToCanvas(compositeRoot);
    } catch (error) {
      console.error('Failed to build visible composite canvas:', error);
      const fallback = document.createElement('canvas');
      fallback.width = W;
      fallback.height = H;
      return fallback;
    } finally {
      tempSprites.forEach((tempSprite) => tempSprite.destroy());
    }
  }

  function buildLayerTargetCanvas(layerIndex, target = 'content', { visualizeMask = false } = {}) {
    const layerRoot = new PIXI.Container();
    const tempSprites = [];

    try {
      if (!layersManager) {
        if (layerIndex !== 0) {
          return null;
        }

        const baseSprite = new PIXI.Sprite(sprite.texture);
        layerRoot.addChild(baseSprite);
        tempSprites.push(baseSprite);
      } else {
        const layers = layersManager.getLayers();
        const layer = layers[layerIndex];
        if (!layer) {
          return null;
        }

        const sourceTexture = target === 'mask'
          ? layer.maskRenderTexture
          : layer.renderTexture;
        if (!sourceTexture) {
          return null;
        }

        const layerSprite = new PIXI.Sprite(sourceTexture);
        layerSprite.alpha = 1;
        layerSprite.visible = true;
        layerSprite.blendMode = PIXI.BLEND_MODES.NORMAL;
        layerRoot.addChild(layerSprite);
        tempSprites.push(layerSprite);

        const activeLayerTarget = layersManager.getActiveEditTarget?.() || 'content';
        const shouldIncludeTransientState = layerIndex === layersManager.getActiveLayerIndex()
          && activeLayerTarget === target;
        if (shouldIncludeTransientState) {
          addSelectionOverlaySprite(layerRoot, tempSprites);
          addBrushPreviewSprite(layerRoot, tempSprites);
        }
      }

      const renderedCanvas = renderDisplayRootToCanvas(layerRoot);
      if (target === 'mask' && visualizeMask) {
        return getMaskVisualizationCanvas(renderedCanvas);
      }
      return renderedCanvas;
    } catch (error) {
      console.error(`Failed to build ${target} layer canvas:`, error);
      const fallback = document.createElement('canvas');
      fallback.width = W;
      fallback.height = H;
      return fallback;
    } finally {
      tempSprites.forEach((tempSprite) => tempSprite.destroy());
    }
  }

  function buildLayerCanvas(layerIndex) {
    const layerRoot = new PIXI.Container();
    const tempSprites = [];

    try {
      if (!layersManager) {
        return buildLayerTargetCanvas(layerIndex, 'content');
      }

      const layers = layersManager.getLayers();
      const layer = layers[layerIndex];
      if (!layer) {
        return null;
      }

      appendLayerDisplayToRoot(layerRoot, layer, tempSprites, {
        includeOpacity: false,
        includeBlendMode: false,
        respectVisibility: false,
      });

      if (layerIndex === layersManager.getActiveLayerIndex()
        && layersManager.getActiveEditTarget?.() === 'content') {
        addSelectionOverlaySprite(layerRoot, tempSprites);
        addBrushPreviewSprite(layerRoot, tempSprites);
      }

      return renderDisplayRootToCanvas(layerRoot);
    } catch (error) {
      console.error('Failed to build layer canvas:', error);
      const fallback = document.createElement('canvas');
      fallback.width = W;
      fallback.height = H;
      return fallback;
    } finally {
      tempSprites.forEach((tempSprite) => tempSprite.destroy());
    }
  }

  function getDropperSampleSize() {
    switch (dropperSettings.sampleSize) {
      case '3x3':
        return 3;
      case '5x5':
        return 5;
      case '11x11':
        return 11;
      case 'point':
      default:
        return 1;
    }
  }

  function getDropperSourceCanvas() {
    if (isEditingLayerMask()) {
      const renderTexture = getActiveReadRenderTexture();
      if (!renderTexture) {
        return buildVisibleCompositeCanvas();
      }

      const canvas = app.renderer.extract.canvas(renderTexture);
      return getMaskVisualizationCanvas(canvas) || buildVisibleCompositeCanvas();
    }

    if (dropperSettings.sampleMerged) {
      return buildVisibleCompositeCanvas();
    }

    if (dropperSettings.layerSource === 'current-layer' && layersManager) {
      const layerCanvas = buildLayerCanvas(layersManager.getActiveLayerIndex());
      if (layerCanvas) {
        return layerCanvas;
      }
    }

    if (dropperSettings.layerSource === 'current-layer' && !layersManager) {
      const canvas = app.renderer.extract.canvas(rt);
      return normalizeExtractedCanvas(canvas);
    }

    return buildVisibleCompositeCanvas();
  }

  function sampleCanvasColor(canvas, sampleX, sampleY) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const scaleX = canvas.width / W;
    const scaleY = canvas.height / H;
    const centerX = Math.max(0, Math.min(canvas.width - 1, Math.floor(sampleX * scaleX)));
    const centerY = Math.max(0, Math.min(canvas.height - 1, Math.floor(sampleY * scaleY)));
    const sampleSize = getDropperSampleSize();

    if (!dropperSettings.averageSampling || sampleSize <= 1) {
      return ctx.getImageData(centerX, centerY, 1, 1).data;
    }

    const halfSize = Math.floor(sampleSize / 2);
    const startX = Math.max(0, centerX - halfSize);
    const startY = Math.max(0, centerY - halfSize);
    const width = Math.min(canvas.width - startX, sampleSize);
    const height = Math.min(canvas.height - startY, sampleSize);
    const imageData = ctx.getImageData(startX, startY, width, height).data;
    let weightedR = 0;
    let weightedG = 0;
    let weightedB = 0;
    let totalWeight = 0;

    for (let i = 0; i < imageData.length; i += 4) {
      const alpha = imageData[i + 3] / 255;
      if (alpha <= 0) {
        continue;
      }
      weightedR += imageData[i] * alpha;
      weightedG += imageData[i + 1] * alpha;
      weightedB += imageData[i + 2] * alpha;
      totalWeight += alpha;
    }

    if (totalWeight <= 0) {
      return ctx.getImageData(centerX, centerY, 1, 1).data;
    }

    return [
      Math.round(weightedR / totalWeight),
      Math.round(weightedG / totalWeight),
      Math.round(weightedB / totalWeight),
      Math.round(Math.min(1, totalWeight / (width * height)) * 255),
    ];
  }

  function setSampledColorFromPixel(pixelData) {
    const hex = '#' + Array.from(pixelData.slice(0, 3))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');

    color = parseInt(hex.slice(1), 16);

    const colorInput = document.getElementById('topbarColor');
    if (colorInput) {
      colorInput.value = hex;
      colorInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function sampleColorAt(localPoint) {
    const clampedPoint = clampToBounds(localPoint);
    const sampleX = Math.floor(clampedPoint.x);
    const sampleY = Math.floor(clampedPoint.y);

    if (sampleX < 0 || sampleY < 0 || sampleX >= W || sampleY >= H) {
      console.warn('Eyedropper coordinates out of bounds:', { sampleX, sampleY, W, H });
      return;
    }

    const canvas = getDropperSourceCanvas();
    const pixelData = sampleCanvasColor(canvas, sampleX, sampleY);
    setSampledColorFromPixel(pixelData);
  }

  function getBucketSourceCanvas(renderTexture) {
    if (isEditingLayerMask()) {
      const canvas = app.renderer.extract.canvas(renderTexture);
      return normalizeExtractedCanvas(canvas);
    }

    if (bucketSettings.allLayers) {
      return buildVisibleCompositeCanvas();
    }

    const canvas = app.renderer.extract.canvas(renderTexture);
    return normalizeExtractedCanvas(canvas);
  }

  function getMagicWandSourceCanvas(renderTexture) {
    if (isEditingLayerMask()) {
      const canvas = app.renderer.extract.canvas(renderTexture);
      return normalizeExtractedCanvas(canvas);
    }

    if (magicWandSettings.allLayers || magicWandSettings.sampleMerged) {
      return buildVisibleCompositeCanvas();
    }

    const canvas = app.renderer.extract.canvas(renderTexture);
    return normalizeExtractedCanvas(canvas);
  }

  function colorDistance(data, pixelIndex, target) {
    const dr = data[pixelIndex] - target.r;
    const dg = data[pixelIndex + 1] - target.g;
    const db = data[pixelIndex + 2] - target.b;
    const da = data[pixelIndex + 3] - target.a;
    return Math.hypot(dr, dg, db, da) * 0.5;
  }

  function pixelMatchesTarget(data, pixelIndex, target, tolerance) {
    return colorDistance(data, pixelIndex, target) <= tolerance;
  }

  function buildFloodMask(imageData, startX, startY, {
    tolerance = 32,
    contiguous = true,
    antiAlias = true,
  } = {}) {
    const { width, height, data } = imageData;
    const pixelCount = width * height;
    const startPixel = (startY * width) + startX;
    const startIndex = startPixel * 4;
    const target = {
      r: data[startIndex],
      g: data[startIndex + 1],
      b: data[startIndex + 2],
      a: data[startIndex + 3],
    };
    const clampedTolerance = Math.max(0, Math.min(255, tolerance));
    const mask = new Uint8Array(pixelCount);

    if (contiguous) {
      const visited = new Uint8Array(pixelCount);
      const stack = new Int32Array(pixelCount);
      let stackLength = 0;
      stack[stackLength++] = startPixel;
      visited[startPixel] = 1;

      while (stackLength > 0) {
        const pixel = stack[--stackLength];
        const pixelIndex = pixel * 4;
        if (!pixelMatchesTarget(data, pixelIndex, target, clampedTolerance)) {
          continue;
        }

        mask[pixel] = 255;
        const x = pixel % width;
        const y = Math.floor(pixel / width);

        if (x > 0 && !visited[pixel - 1]) {
          visited[pixel - 1] = 1;
          stack[stackLength++] = pixel - 1;
        }
        if (x < width - 1 && !visited[pixel + 1]) {
          visited[pixel + 1] = 1;
          stack[stackLength++] = pixel + 1;
        }
        if (y > 0 && !visited[pixel - width]) {
          visited[pixel - width] = 1;
          stack[stackLength++] = pixel - width;
        }
        if (y < height - 1 && !visited[pixel + width]) {
          visited[pixel + width] = 1;
          stack[stackLength++] = pixel + width;
        }
      }
    } else {
      for (let pixel = 0; pixel < pixelCount; pixel++) {
        if (pixelMatchesTarget(data, pixel * 4, target, clampedTolerance)) {
          mask[pixel] = 255;
        }
      }
    }

    if (!antiAlias) {
      return mask;
    }

    const smoothedMask = new Uint8Array(mask);
    const fringeTolerance = Math.min(255, clampedTolerance + 16);
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      if (mask[pixel]) {
        continue;
      }

      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const touchesFill = (x > 0 && mask[pixel - 1])
        || (x < width - 1 && mask[pixel + 1])
        || (y > 0 && mask[pixel - width])
        || (y < height - 1 && mask[pixel + width]);

      if (touchesFill && pixelMatchesTarget(data, pixel * 4, target, fringeTolerance)) {
        smoothedMask[pixel] = 96;
      }
    }

    return smoothedMask;
  }

  function buildBucketFillMask(imageData, startX, startY) {
    return buildFloodMask(imageData, startX, startY, {
      tolerance: bucketSettings.tolerance,
      contiguous: bucketSettings.contiguous,
      antiAlias: bucketSettings.antiAlias,
    });
  }

  function buildMagicWandPixelMask(imageData, startX, startY) {
    return buildFloodMask(imageData, startX, startY, {
      tolerance: magicWandSettings.tolerance,
      contiguous: magicWandSettings.contiguous,
      antiAlias: magicWandSettings.antiAlias,
    });
  }

  function buildSelectionMaskCanvas(mask, width, height) {
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskCtx = maskCanvas.getContext('2d');
    const maskImageData = maskCtx.createImageData(width, height);
    const maskData = maskImageData.data;

    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      const alpha = mask[pixel];
      if (!alpha) {
        continue;
      }

      const pixelIndex = pixel * 4;
      maskData[pixelIndex] = 255;
      maskData[pixelIndex + 1] = 255;
      maskData[pixelIndex + 2] = 255;
      maskData[pixelIndex + 3] = alpha;
    }

    maskCtx.putImageData(maskImageData, 0, 0);
    return maskCanvas;
  }

  function buildSelectionMaskFromCanvasAlpha(sourceCanvas, { alphaThreshold = 1 } = {}) {
    if (!sourceCanvas) {
      return null;
    }

    const normalizedCanvas = (sourceCanvas.width === W && sourceCanvas.height === H)
      ? sourceCanvas
      : normalizeExtractedCanvas(sourceCanvas);
    const ctx = normalizedCanvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, normalizedCanvas.width, normalizedCanvas.height);
    const mask = new Uint8Array(normalizedCanvas.width * normalizedCanvas.height);
    let hasSelectedPixels = false;

    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      const alpha = imageData.data[(pixel * 4) + 3];
      if (alpha < alphaThreshold) {
        continue;
      }
      mask[pixel] = 255;
      hasSelectedPixels = true;
    }

    if (!hasSelectedPixels) {
      return null;
    }

    return buildSelectionMaskCanvas(mask, normalizedCanvas.width, normalizedCanvas.height);
  }

  function buildBucketFillCanvas(mask, width, height) {
    const fillCanvas = document.createElement('canvas');
    fillCanvas.width = width;
    fillCanvas.height = height;
    const fillCtx = fillCanvas.getContext('2d');
    const fillImageData = fillCtx.createImageData(width, height);
    const fillData = fillImageData.data;
    const fillColor = getEffectiveBrushTint();
    const fillR = (fillColor >> 16) & 255;
    const fillG = (fillColor >> 8) & 255;
    const fillB = fillColor & 255;

    for (let pixel = 0; pixel < mask.length; pixel++) {
      const alpha = mask[pixel];
      if (!alpha) {
        continue;
      }

      const pixelIndex = pixel * 4;
      fillData[pixelIndex] = fillR;
      fillData[pixelIndex + 1] = fillG;
      fillData[pixelIndex + 2] = fillB;
      fillData[pixelIndex + 3] = alpha;
    }

    fillCtx.putImageData(fillImageData, 0, 0);
    return fillCanvas;
  }

  function renderBucketFillToLayer(fillCanvas, renderTexture) {
    rasterizeLayerForRenderTexture(renderTexture);

    const tempTexture = PIXI.Texture.from(fillCanvas);
    const tempSprite = new PIXI.Sprite(tempTexture);
    tempSprite.width = W;
    tempSprite.height = H;
    tempSprite.position.set(0, 0);
    tempSprite.alpha = Math.max(0, Math.min(1, bucketSettings.opacity / 100));
    tempSprite.blendMode = isEditingLayerMask()
      ? PIXI.BLEND_MODES.NORMAL
      : getPixiBlendMode(bucketSettings.blendMode);

    app.renderer.render(tempSprite, { renderTexture, clear: false });

    tempSprite.destroy();
    tempTexture.destroy(true);
  }

  const api = {
    /**
     * Set the layers manager
     * @param {Object} manager - Layers manager instance
     */
    setLayersManager,
    
    /**
     * Set callback for when drawing operations complete
     * @param {Function} callback - Function to call when drawing ends
     */
    setOnDrawingComplete(callback) {
      onDrawingComplete = callback;
    },
    setOnDocumentMutated(callback) {
      onDocumentMutated = callback;
    },
    setOnViewChanged(callback) {
      onViewChanged = callback;
    },
    setOnMoveStateChanged(callback) {
      onMoveStateChanged = callback;
    },
    setOnTextStateChanged(callback) {
      onTextStateChanged = callback;
    },
    
    /**
     * Get the PIXI application instance
     * @returns {PIXI.Application} The PIXI app
     */
    getApp() {
      return app;
    },
    
    /**
     * Set the active drawing tool
     * @param {string} name - Tool name (brush, eraser, dropper, etc.)
     */
    setTool(name) {
      const previousTool = tool;
      if (name === 'text' && layersManager?.isEditingMask?.()) {
        layersManager.setActiveEditTarget('content');
      }
      if (previousTool === 'move' && name !== 'move' && selectionSprite && selection) {
        api.clearSelection();
      }
      if (previousTool === 'lasso' && name !== 'lasso' && lassoDraft) {
        cancelLassoDraft();
      }
      if (previousTool === 'pen' && name !== 'pen' && penDraft) {
        cancelPenDraft();
      }
      if (previousTool === 'text' && name !== 'text' && textDraft) {
        commitTextDraft();
      }
      if ((previousTool === 'brush' || previousTool === 'eraser') && previousTool !== name) {
        clearBrushStrokePreview();
      }
      tool = name;
      
      // Handle tool-specific setup
      if (name === 'brush') {
        radius = brushSettings.size;
        feather = Math.max(0, 100 - brushSettings.hardness);
        rebuildStamp();
      } else if (name === 'eraser') {
        radius = eraserSettings.size;
        feather = Math.max(0, 100 - getCurrentHardness());
        rebuildStamp();
      } else {
        hideBrushCursor();
      }

      if (name === 'pen') {
        drawPenDraft();
      } else if (name === 'text') {
        updateTextEditorOverlay();
      } else {
        setTextEditorVisibility(false);
      }
      
      // Show/hide scale handles based on tool
      if (name === 'move' && selection) {
        drawScaleHandles();
        // Extract content immediately when switching to move tool with existing selection
        if (!selectionSprite) {
          extractSelectionContent();
        }
      } else {
        scaleHandlesG.clear();
      }
      
      // Reset cursor when changing tools
      if (previousTool !== name) {
        app.stage.cursor = 'default';
      }
      
      updateBrushCursor();
    },

    /**
     * Configure brush settings
     * @param {Object} options - Brush configuration
     * @param {string} options.colorHex - Hex color string
     * @param {number} options.size - Brush size in pixels
     * @param {number} options.hardness - Brush hardness (0-100)
     * @param {number} options.opacity - Stroke opacity (0-100)
     * @param {number} options.flow - Stamp flow (1-100)
     * @param {number} options.spacing - Stamp spacing as diameter percent
     * @param {string} options.brushShape - Brush shape identifier
     * @param {number} options.smoothing - Pointer smoothing amount (0-100)
     * @param {string} options.blendMode - Blend mode name
     */
    setBrush({
      colorHex,
      size,
      feather: featherValue,
      hardness,
      opacity,
      flow,
      spacing,
      brushShape,
      smoothing,
      blendMode,
    } = {}) {
      let shouldRebuildStamp = false;
      let shouldRefreshPreview = false;

      if (colorHex) {
        color = parseInt(colorHex.slice(1), 16);
        shouldRefreshPreview = true;
      }
      if (typeof size === 'number' && size > 0) {
        brushSettings.size = size;
        if (tool === 'brush') {
          radius = size;
        }
        shouldRebuildStamp = true;
      }
      const normalizedHardness = typeof hardness === 'number'
        ? Math.max(0, Math.min(100, hardness))
        : (typeof featherValue === 'number' && featherValue >= 0
          ? Math.max(0, Math.min(100, 100 - featherValue))
          : null);
      if (normalizedHardness !== null) {
        brushSettings.hardness = normalizedHardness;
        if (tool === 'brush') {
          feather = Math.max(0, 100 - normalizedHardness);
        }
        shouldRebuildStamp = true;
      }
      if (typeof opacity === 'number') {
        brushSettings.opacity = Math.max(0, Math.min(100, opacity));
        shouldRefreshPreview = true;
      }
      if (typeof flow === 'number') {
        brushSettings.flow = Math.max(1, Math.min(100, flow));
      }
      if (typeof spacing === 'number') {
        brushSettings.spacing = Math.max(1, Math.min(200, spacing));
      }
      if (typeof brushShape === 'string' && brushShape) {
        brushSettings.brushShape = brushShape;
        shouldRebuildStamp = true;
      }
      if (typeof smoothing === 'number') {
        brushSettings.smoothing = Math.max(0, Math.min(100, smoothing));
      }
      if (typeof blendMode === 'string' && blendMode) {
        brushSettings.blendMode = blendMode;
        shouldRefreshPreview = true;
      }

      if (tool === 'brush') {
        radius = brushSettings.size;
        feather = Math.max(0, 100 - brushSettings.hardness);
        if (shouldRebuildStamp) {
          rebuildStamp();
        }
        if (brushStrokePreview.visible && shouldRefreshPreview) {
          brushStrokePreview.alpha = Math.max(0, Math.min(1, brushSettings.opacity / 100));
          brushStrokePreview.blendMode = getBrushStrokeBlendMode();
        }
        updateBrushCursor();
      }
    },

    /**
     * Configure eraser settings
     * @param {Object} options - Eraser configuration
     * @param {number} options.size - Eraser size in pixels
     * @param {number} options.hardness - Eraser hardness (0-100)
     * @param {number} options.opacity - Stroke opacity (0-100)
     * @param {number} options.flow - Stamp flow (1-100)
     * @param {number} options.spacing - Stamp spacing as diameter percent
     * @param {boolean} options.eraseToTransparency - Whether erase cuts alpha
     * @param {boolean} options.softEdge - Whether hardness controls edge softness
     */
    setEraser({
      size,
      feather: featherValue,
      hardness,
      opacity,
      flow,
      spacing,
      eraseToTransparency,
      softEdge,
    } = {}) {
      let shouldRebuildStamp = false;
      let shouldRefreshPreview = false;

      if (typeof size === 'number' && size > 0) {
        eraserSettings.size = size;
        if (tool === 'eraser') {
          radius = size;
        }
        shouldRebuildStamp = true;
      }
      const normalizedHardness = typeof hardness === 'number'
        ? Math.max(0, Math.min(100, hardness))
        : (typeof featherValue === 'number' && featherValue >= 0
          ? Math.max(0, Math.min(100, 100 - featherValue))
          : null);
      if (normalizedHardness !== null) {
        eraserSettings.hardness = normalizedHardness;
        if (tool === 'eraser') {
          feather = Math.max(0, 100 - getCurrentHardness());
        }
        shouldRebuildStamp = true;
      }
      if (typeof opacity === 'number') {
        eraserSettings.opacity = Math.max(0, Math.min(100, opacity));
        shouldRefreshPreview = true;
      }
      if (typeof flow === 'number') {
        eraserSettings.flow = Math.max(1, Math.min(100, flow));
      }
      if (typeof spacing === 'number') {
        eraserSettings.spacing = Math.max(1, Math.min(200, spacing));
      }
      if (typeof eraseToTransparency === 'boolean') {
        eraserSettings.eraseToTransparency = eraseToTransparency;
        shouldRefreshPreview = true;
      }
      if (typeof softEdge === 'boolean') {
        eraserSettings.softEdge = softEdge;
        if (tool === 'eraser') {
          feather = Math.max(0, 100 - getCurrentHardness());
        }
        shouldRebuildStamp = true;
      }

      if (tool === 'eraser') {
        radius = eraserSettings.size;
        feather = Math.max(0, 100 - getCurrentHardness());
        if (shouldRebuildStamp) {
          rebuildStamp();
        }
        if (brushStrokePreview.visible && shouldRefreshPreview) {
          brushStrokePreview.alpha = Math.max(0, Math.min(1, eraserSettings.opacity / 100));
          brushStrokePreview.blendMode = getBrushStrokeBlendMode();
        }
        updateBrushCursor();
      }
    },

    /**
     * Configure eyedropper sampling settings.
     * @param {Object} options - Eyedropper configuration
     * @param {string} options.sampleSize - Point, 3x3, 5x5, or 11x11 sampling footprint
     * @param {string} options.layerSource - Current layer or all layers
     * @param {boolean} options.sampleMerged - Whether to sample the visible merged result
     * @param {boolean} options.averageSampling - Whether to average the sample footprint
     */
    setDropper({
      sampleSize,
      layerSource,
      sampleMerged,
      averageSampling,
    } = {}) {
      if (['point', '3x3', '5x5', '11x11'].includes(sampleSize)) {
        dropperSettings.sampleSize = sampleSize;
      }
      if (['current-layer', 'all-layers'].includes(layerSource)) {
        dropperSettings.layerSource = layerSource;
      }
      if (typeof sampleMerged === 'boolean') {
        dropperSettings.sampleMerged = sampleMerged;
      }
      if (typeof averageSampling === 'boolean') {
        dropperSettings.averageSampling = averageSampling;
      }
    },

    /**
     * Configure paint bucket fill settings.
     * @param {Object} options - Paint bucket configuration
     * @param {string} options.colorHex - Fill color hex string
     * @param {number} options.tolerance - Color match tolerance (0-255)
     * @param {boolean} options.contiguous - Whether to fill connected pixels only
     * @param {number} options.opacity - Fill opacity (0-100)
     * @param {string} options.blendMode - Fill blend mode name
     * @param {boolean} options.allLayers - Whether to sample the visible composite
     * @param {boolean} options.antiAlias - Whether to soften fill edges
     */
    setBucket({
      colorHex,
      tolerance,
      contiguous,
      opacity,
      blendMode,
      allLayers,
      antiAlias,
    } = {}) {
      if (colorHex) {
        color = parseInt(colorHex.slice(1), 16);
      }
      if (typeof tolerance === 'number') {
        bucketSettings.tolerance = Math.max(0, Math.min(255, tolerance));
      }
      if (typeof contiguous === 'boolean') {
        bucketSettings.contiguous = contiguous;
      }
      if (typeof opacity === 'number') {
        bucketSettings.opacity = Math.max(0, Math.min(100, opacity));
      }
      if (typeof blendMode === 'string' && blendMode) {
        bucketSettings.blendMode = blendMode;
      }
      if (typeof allLayers === 'boolean') {
        bucketSettings.allLayers = allLayers;
      }
      if (typeof antiAlias === 'boolean') {
        bucketSettings.antiAlias = antiAlias;
      }
    },

    /**
     * Configure magic wand selection settings.
     * @param {Object} options - Magic wand configuration
     * @param {number} options.tolerance - Color match tolerance (0-255)
     * @param {boolean} options.contiguous - Whether to select connected pixels only
     * @param {boolean} options.antiAlias - Whether to soften selection edges
     * @param {boolean} options.allLayers - Whether to sample all visible layers
     * @param {boolean} options.sampleMerged - Whether to sample the merged visible result
     * @param {string} options.selectionOperation - replace, add, subtract, or intersect
     */
    setMagicWand({
      tolerance,
      contiguous,
      antiAlias,
      allLayers,
      sampleMerged,
      selectionOperation,
    } = {}) {
      if (typeof tolerance === 'number') {
        magicWandSettings.tolerance = Math.max(0, Math.min(255, tolerance));
      }
      if (typeof contiguous === 'boolean') {
        magicWandSettings.contiguous = contiguous;
      }
      if (typeof antiAlias === 'boolean') {
        magicWandSettings.antiAlias = antiAlias;
      }
      if (typeof allLayers === 'boolean') {
        magicWandSettings.allLayers = allLayers;
      }
      if (typeof sampleMerged === 'boolean') {
        magicWandSettings.sampleMerged = sampleMerged;
      }
      if (['replace', 'add', 'subtract', 'intersect'].includes(selectionOperation)) {
        magicWandSettings.selectionOperation = selectionOperation;
      }
    },

    /**
     * Configure marquee selection settings.
     * @param {Object} options - Marquee configuration
     * @param {string} options.mode - rectangle or ellipse
     * @param {number} options.feather - Feather radius in pixels
     * @param {boolean} options.antiAlias - Whether to anti-alias selection edges
     * @param {boolean} options.fixedSize - Whether to use fixed dimensions
     * @param {number} options.fixedWidth - Fixed selection width in pixels
     * @param {number} options.fixedHeight - Fixed selection height in pixels
     * @param {string} options.fixedRatio - free, 1:1, 4:3, 16:9, or 3:2
     * @param {string} options.selectionOperation - replace, add, subtract, or intersect
     */
    setMarquee({
      mode,
      feather: featherValue,
      antiAlias,
      fixedSize,
      fixedWidth,
      fixedHeight,
      fixedRatio,
      selectionOperation,
    } = {}) {
      if (['rectangle', 'ellipse'].includes(mode)) {
        marqueeSettings.mode = mode;
      }
      if (typeof featherValue === 'number') {
        marqueeSettings.feather = Math.max(0, Math.min(256, featherValue));
      }
      if (typeof antiAlias === 'boolean') {
        marqueeSettings.antiAlias = antiAlias;
      }
      if (typeof fixedSize === 'boolean') {
        marqueeSettings.fixedSize = fixedSize;
      }
      if (typeof fixedWidth === 'number') {
        marqueeSettings.fixedWidth = Math.max(1, Math.min(4096, fixedWidth));
      }
      if (typeof fixedHeight === 'number') {
        marqueeSettings.fixedHeight = Math.max(1, Math.min(4096, fixedHeight));
      }
      if (['free', '1:1', '4:3', '16:9', '3:2'].includes(fixedRatio)) {
        marqueeSettings.fixedRatio = fixedRatio;
      }
      if (['replace', 'add', 'subtract', 'intersect'].includes(selectionOperation)) {
        marqueeSettings.selectionOperation = selectionOperation;
      }
    },

    /**
     * Configure lasso selection settings.
     * @param {Object} options - Lasso configuration
     * @param {string} options.mode - freehand, polygonal, or magnetic
     * @param {number} options.feather - Feather radius in pixels
     * @param {boolean} options.antiAlias - Whether to anti-alias selection edges
     * @param {number} options.edgeDetection - Magnetic edge sensitivity (0-100)
     * @param {string} options.selectionOperation - replace, add, subtract, or intersect
     */
    setLasso({
      mode,
      feather: featherValue,
      antiAlias,
      edgeDetection,
      selectionOperation,
    } = {}) {
      if (['freehand', 'polygonal', 'magnetic'].includes(mode) && mode !== lassoSettings.mode) {
        if (lassoDraft) {
          cancelLassoDraft();
        }
        lassoSettings.mode = mode;
      }
      if (typeof featherValue === 'number') {
        lassoSettings.feather = Math.max(0, Math.min(256, featherValue));
      }
      if (typeof antiAlias === 'boolean') {
        lassoSettings.antiAlias = antiAlias;
      }
      if (typeof edgeDetection === 'number') {
        lassoSettings.edgeDetection = Math.max(0, Math.min(100, edgeDetection));
      }
      if (['replace', 'add', 'subtract', 'intersect'].includes(selectionOperation)) {
        lassoSettings.selectionOperation = selectionOperation;
      }
    },

    /**
     * Configure pen path settings.
     * @param {Object} options - Pen tool configuration
     * @param {string} options.pathMode - path, selection, or mask
     * @param {string} options.shapeMode - path, filled-shape, or stroked-shape
     * @param {string} options.strokeColor - Stroke color hex string
     * @param {string} options.fillColor - Fill color hex string
     * @param {number} options.strokeWidth - Stroke width in pixels
     * @param {boolean} options.anchorEdit - Whether anchors and handles can be edited
     * @param {string} options.curveHandles - mirrored, independent, or automatic
     * @param {boolean} options.closePath - Whether commits should close the path
     */
    setPen({
      pathMode,
      shapeMode,
      strokeColor,
      fillColor,
      strokeWidth,
      anchorEdit,
      curveHandles,
      closePath,
    } = {}) {
      if (['path', 'selection', 'mask'].includes(pathMode)) {
        penSettings.pathMode = pathMode;
      }
      if (['path', 'filled-shape', 'stroked-shape'].includes(shapeMode)) {
        penSettings.shapeMode = shapeMode;
      }
      if (typeof strokeColor === 'string') {
        penSettings.strokeColor = normalizePenHexColor(strokeColor, penSettings.strokeColor);
      }
      if (typeof fillColor === 'string') {
        penSettings.fillColor = normalizePenHexColor(fillColor, penSettings.fillColor);
      }
      if (typeof strokeWidth === 'number') {
        penSettings.strokeWidth = Math.max(1, Math.min(64, strokeWidth));
      }
      if (typeof anchorEdit === 'boolean') {
        penSettings.anchorEdit = anchorEdit;
      }
      if (['mirrored', 'independent', 'automatic'].includes(curveHandles)) {
        penSettings.curveHandles = curveHandles;
      }
      if (typeof closePath === 'boolean') {
        penSettings.closePath = closePath;
      }

      if (tool === 'pen') {
        drawPenDraft();
      }
    },

    /**
     * Configure text settings and refresh the active editor overlay.
     * @param {Object} options - Text tool configuration
     * @param {string} options.fontFamily - Font family identifier
     * @param {number} options.fontSize - Font size in pixels
     * @param {boolean} options.bold - Bold style
     * @param {boolean} options.italic - Italic style
     * @param {string} options.alignment - left, center, right, or justify
     * @param {string} options.color - Text color hex string
     * @param {number} options.lineHeight - Line height percentage
     * @param {number} options.letterSpacing - Letter spacing in pixels
     * @param {string} options.warp - none, arc, flag, or bulge
     * @param {number} options.textBoxWidth - Text box width in pixels
     */
    setText({
      fontFamily,
      fontSize,
      bold,
      italic,
      alignment,
     color: colorHex,
     lineHeight,
     letterSpacing,
     warp,
      fixedWidth,
      textBoxWidth,
    } = {}) {
      if (['space-grotesk', 'jetbrains-mono', 'source-serif', 'system-sans'].includes(fontFamily)) {
        textSettings.fontFamily = fontFamily;
      }
      if (typeof fontSize === 'number') {
        textSettings.fontSize = Math.max(8, Math.min(240, fontSize));
      }
      if (typeof bold === 'boolean') {
        textSettings.bold = bold;
      }
      if (typeof italic === 'boolean') {
        textSettings.italic = italic;
      }
      if (['left', 'center', 'right', 'justify'].includes(alignment)) {
        textSettings.alignment = alignment;
      }
      if (typeof colorHex === 'string') {
        textSettings.color = normalizePenHexColor(colorHex, textSettings.color);
      }
      if (typeof lineHeight === 'number') {
        textSettings.lineHeight = Math.max(80, Math.min(240, lineHeight));
      }
      if (typeof letterSpacing === 'number') {
        textSettings.letterSpacing = Math.max(-10, Math.min(40, letterSpacing));
      }
      if (['none', 'arc', 'flag', 'bulge'].includes(warp)) {
        textSettings.warp = warp;
      }
      if (typeof fixedWidth === 'boolean') {
        textSettings.fixedWidth = fixedWidth;
      }
      if (typeof textBoxWidth === 'number') {
        textSettings.textBoxWidth = Math.max(80, Math.min(1200, textBoxWidth));
      }

      if (textDraft) {
        textDraft.fontFamily = textSettings.fontFamily;
        textDraft.fontSize = textSettings.fontSize;
        textDraft.bold = textSettings.bold;
        textDraft.italic = textSettings.italic;
        textDraft.alignment = textSettings.alignment;
        textDraft.color = textSettings.color;
        textDraft.lineHeight = textSettings.lineHeight;
        textDraft.letterSpacing = textSettings.letterSpacing;
        textDraft.warp = textSettings.warp;
        textDraft.fixedWidth = textSettings.fixedWidth;
        textDraft.textBoxWidth = textSettings.textBoxWidth;
        if (textDraft.fixedWidth) {
          textDraft.width = Math.max(80, textSettings.textBoxWidth);
        }
      }

      if (tool === 'text') {
        updateTextEditorOverlay();
      }
      notifyTextStateChanged();
    },

    /**
     * Configure move/scale/rotate settings and apply explicit transform values.
     * @param {Object} options - Move tool configuration
     * @param {string} options.transformMode - move, scale, or rotate
     * @param {boolean} options.uniformScale - Preserve aspect ratio when resizing
     * @param {string} options.pivotPoint - Transform pivot point
     * @param {boolean} options.snap - Enable grid/angle snapping
     * @param {number} options.angle - Rotation angle in degrees
     * @param {number} options.width - Target selection width in pixels
     * @param {number} options.height - Target selection height in pixels
     * @param {boolean} options.flipHorizontal - Mirror the floating selection horizontally
     * @param {boolean} options.flipVertical - Mirror the floating selection vertically
     */
    setMove({
      transformMode,
      uniformScale,
      pivotPoint,
      snap,
      angle,
      width,
      height,
      flipHorizontal,
      flipVertical,
    } = {}) {
      if (['move', 'scale', 'rotate'].includes(transformMode)) {
        moveSettings.transformMode = transformMode;
      }
      if (typeof uniformScale === 'boolean') {
        moveSettings.uniformScale = uniformScale;
      }
      if (['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'custom'].includes(pivotPoint)) {
        moveSettings.pivotPoint = pivotPoint;
      }
      if (typeof snap === 'boolean') {
        moveSettings.snap = snap;
      }

      if (selection) {
        if (typeof angle === 'number') {
          selectionRotation = snapAngleRadians(normalizeAngleDegrees(angle) * Math.PI / 180);
        }

        const hasWidth = typeof width === 'number' && width > 0;
        const hasHeight = typeof height === 'number' && height > 0;
        if (hasWidth || hasHeight) {
          let nextWidth = hasWidth ? width : selection.width;
          let nextHeight = hasHeight ? height : selection.height;
          if (moveSettings.uniformScale && hasWidth !== hasHeight) {
            const aspectRatio = selection.width / Math.max(1, selection.height);
            if (hasWidth) {
              nextHeight = nextWidth / Math.max(0.0001, aspectRatio);
            } else {
              nextWidth = nextHeight * aspectRatio;
            }
          }
          resizeSelectionFromPivot(nextWidth, nextHeight);
        }

        if (typeof flipHorizontal === 'boolean') {
          selectionFlipX = flipHorizontal;
        }
        if (typeof flipVertical === 'boolean') {
          selectionFlipY = flipVertical;
        }

        updateTransformationMatrix();
        applySelectionSpriteTransform();
        drawSelectionOutline();
        drawScaleHandles();
      } else {
        scaleHandlesG.clear();
      }
    },

    getMoveState() {
      return getMoveStateSnapshot();
    },

    /**
     * Clear the current selection with transformation support
     */
    clearSelection() {
      clearSelectionState({ commitSprite: true });
    },

    hasSelection() {
      return Boolean(selection);
    },

    selectAll() {
      const activeLayerIndex = layersManager ? layersManager.getActiveLayerIndex() : 0;
      return api.selectLayerPixels(activeLayerIndex);
    },

    selectLayerPixels(layerIndex = null) {
      const resolvedLayerIndex = Number.isInteger(layerIndex)
        ? layerIndex
        : (layersManager ? layersManager.getActiveLayerIndex() : 0);

      clearSelectionState({ commitSprite: true });

      if (!layersManager) {
        const sourceCanvas = buildVisibleCompositeCanvas();
        const maskCanvas = buildSelectionMaskFromCanvasAlpha(sourceCanvas);
        if (!maskCanvas) {
          return false;
        }
        const didSetSelection = setSelectionFromMask(maskCanvas, { shape: 'custom' });
        if (didSetSelection && tool === 'move') {
          drawScaleHandles();
          if (!selectionSprite) {
            extractSelectionContent();
          }
        }
        return didSetSelection;
      }

      const layer = layersManager.getLayer(resolvedLayerIndex);
      if (!layer) {
        return false;
      }

      const activeLayerTarget = resolvedLayerIndex === layersManager.getActiveLayerIndex()
        ? (layersManager.getActiveEditTarget?.() || 'content')
        : 'content';
      const extracted = buildLayerTargetCanvas(resolvedLayerIndex, activeLayerTarget, {
        visualizeMask: false,
      });
      const maskCanvas = buildSelectionMaskFromCanvasAlpha(extracted);
      if (!maskCanvas) {
        return false;
      }

      layersManager.setActiveLayer(resolvedLayerIndex);
      const didSetSelection = setSelectionFromMask(maskCanvas, { shape: 'custom' });
      if (didSetSelection && tool === 'move') {
        drawScaleHandles();
        if (!selectionSprite) {
          extractSelectionContent();
        }
      }
      return didSetSelection;
    },

    deleteSelectionContents() {
      return deleteSelectionContents();
    },

    discardTransientState() {
      discardTransientState();
    },

    /**
     * Capture the current canvas as an HTML5 canvas element
     * @returns {HTMLCanvasElement} Canvas with current drawing
     */
    snapshotCanvas() {
      try {
        return buildVisibleCompositeCanvas();
      } catch (error) {
        console.error('Failed to snapshot canvas:', error);
        const fallback = document.createElement('canvas');
        fallback.width = W;
        fallback.height = H;
        const ctx = fallback.getContext('2d');
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, W, H);
        return fallback;
      }
    },

    snapshotLayerCanvas(layerIndex) {
      try {
        return buildLayerCanvas(layerIndex);
      } catch (error) {
        console.error('Failed to snapshot layer canvas:', error);
        const fallback = document.createElement('canvas');
        fallback.width = W;
        fallback.height = H;
        return fallback;
      }
    },

    snapshotLayerContentCanvas(layerIndex) {
      try {
        return buildLayerTargetCanvas(layerIndex, 'content', { visualizeMask: false });
      } catch (error) {
        console.error('Failed to snapshot layer content canvas:', error);
        const fallback = document.createElement('canvas');
        fallback.width = W;
        fallback.height = H;
        return fallback;
      }
    },

    snapshotLayerMaskCanvas(layerIndex, { visualize = false } = {}) {
      try {
        return buildLayerTargetCanvas(layerIndex, 'mask', { visualizeMask: visualize });
      } catch (error) {
        console.error('Failed to snapshot layer mask canvas:', error);
        const fallback = document.createElement('canvas');
        fallback.width = W;
        fallback.height = H;
        return fallback;
      }
    },

    fitAndCenter() {
      fitAndCenter();
      emitViewChanged();
    },
    getViewState,
    setViewState,

    /**
     * Get current canvas dimensions
     * @returns {Object} Width and height
     */
    getSize() {
      return { width: W, height: H };
    },
    /**
     * Resize the artboard to new dimensions
     * @param {number} newW - New width
     * @param {number} newH - New height
     */
    resizeArtboard(newW, newH) {
      try {
        if (layersManager) {
          // Use layers manager resize method
          layersManager.resize(newW, newH);
          W = newW;
          H = newH;
          border.clear().lineStyle(1, 0x333333, 1).drawRect(-0.5, -0.5, newW + 1, newH + 1);
          updateFadeOverlay(); // Update fade overlay for new dimensions
        } else {
          // Fallback to single sprite resize
          const oldTexture = sprite.texture;
          const newRT = PIXI.RenderTexture.create({
            width: newW,
            height: newH,
            resolution: 1
          });
          
          // Fill with white background
          const bg = new PIXI.Graphics();
          bg.beginFill(0xffffff).drawRect(0, 0, newW, newH).endFill();
          app.renderer.render(bg, { renderTexture: newRT, clear: true });
          bg.destroy();
          
          // Center old content in new canvas
          const dx = Math.floor((newW - oldTexture.width) / 2);
          const dy = Math.floor((newH - oldTexture.height) / 2);
          const src = new PIXI.Sprite(oldTexture);
          src.position.set(dx, dy);
          app.renderer.render(src, { renderTexture: newRT, clear: false });
          src.destroy();
          
          // Update sprite and dimensions
          sprite.texture = newRT;
          border.clear().lineStyle(1, 0x333333, 1).drawRect(-0.5, -0.5, newW + 1, newH + 1);
          W = newW;
          H = newH;
          rt = newRT;
          updateFadeOverlay(); // Update fade overlay for new dimensions
          
          // Clean up old texture
          if (oldTexture && oldTexture !== newRT) {
            oldTexture.destroy(true);
          }
        }
        
        ensureBrushStrokeTexture();
        clearBrushStrokePreview();
        fitAndCenter();
      } catch (error) {
        console.error('Failed to resize artboard:', error);
      }
    },

    /**
     * Display a canvas on the artboard
     * @param {HTMLCanvasElement} canvas - Canvas to display
     */
    showCanvas(canvas) {
      try {
        const texture = PIXI.Texture.from(canvas);
        const oldTexture = sprite.texture;
        
        sprite.texture = texture;
        rt = texture.baseTexture;
        W = canvas.width;
        H = canvas.height;
        border.clear().lineStyle(1, 0x333333, 1).drawRect(-0.5, -0.5, W + 1, H + 1);
        updateFadeOverlay(); // Update fade overlay for new dimensions
        
        // Clean up old texture if it's different
        if (oldTexture && oldTexture !== texture) {
          oldTexture.destroy(true);
        }
        
        ensureBrushStrokeTexture();
        clearBrushStrokePreview();
        fitAndCenter();
      } catch (error) {
        console.error('Failed to show canvas:', error);
      }
    },

    /**
     * Set a selection programmatically (for upload functionality)
     * @param {Object} selectionRect - Selection rectangle {x, y, width, height}
     */
    setSelection(selectionRect) {
      if (!selectionRect || typeof selectionRect !== 'object') {
        return false;
      }
      
      const { x, y, width, height } = selectionRect;
      
      // Validate selection parameters
      if (typeof x !== 'number' || typeof y !== 'number' || 
          typeof width !== 'number' || typeof height !== 'number' ||
          width <= 0 || height <= 0) {
        return false;
      }
      
      clearSelectionState({ commitSprite: true });

      const maskCanvas = createBlankMaskCanvas();
      const maskCtx = maskCanvas.getContext('2d');
      maskCtx.fillStyle = '#ffffff';
      maskCtx.fillRect(x, y, width, height);
      const didSetSelection = setSelectionFromMask(maskCanvas, { shape: 'rectangle' });
      if (!didSetSelection) {
        return false;
      }
      
      // If we're in move tool, show handles and extract content
      if (tool === 'move') {
        drawScaleHandles();
        // Extract content immediately for transformation
        if (!selectionSprite) {
          extractSelectionContent();
        }
      }
      
      return true;
    }
  };

  // ========== EVENT HANDLING ==========
  // Configure stage for pointer events
  app.stage.eventMode = 'static';
  app.stage.hitArea = app.screen;

  // ========== ZOOM AND PAN ==========
  /**
   * Handle mouse wheel zoom with cursor-centered scaling
   */
  app.view.addEventListener('wheel', (ev) => {
    // Don't zoom when prompt input is focused
    if (document.activeElement === document.getElementById('prompt')) {
      return;
    }
    
    ev.preventDefault();
    
    try {
      const oldScale = viewport.scale.x;
      const zoomFactor = ev.deltaY > 0 ? 1 / 1.1 : 1.1;
      const newScale = Math.max(0.1, Math.min(8, oldScale * zoomFactor));
      
      // Get mouse position relative to canvas
      const rect = app.view.getBoundingClientRect();
      const mousePos = new PIXI.Point(
        ev.clientX - rect.left,
        ev.clientY - rect.top
      );
      
      // Calculate zoom center
      const beforeZoom = viewport.toLocal(mousePos);
      viewport.scale.set(newScale);
      const afterZoom = viewport.toLocal(mousePos);
      
      // Adjust position to keep mouse point stable
      const deltaX = (afterZoom.x - beforeZoom.x) * newScale;
      const deltaY = (afterZoom.y - beforeZoom.y) * newScale;
      viewport.position.set(
        viewport.position.x + deltaX,
        viewport.position.y + deltaY
      );
      drawPenDraft();
      updateTextEditorOverlay();
      emitViewChanged();
    } catch (error) {
      console.error('Zoom operation failed:', error);
    }
  }, { passive: false });

  // Pan state management
  let panning = false;
  let panStart = { x: 0, y: 0 };
  let viewStart = { x: 0, y: 0 };

  /**
   * Handle pointer down events for all tools and interactions
   */
  app.stage.on('pointerdown', (e) => {
    try {
      // Check for middle mouse button first - most reliable detection
      const isMiddleClick = (e.button === 1) || (e.which === 2) || (e.buttons === 4);
      const isRightClick = (e.button === 2) || (e.which === 3) || (e.buttons === 2);
      const isPanClick = isMiddleClick || isRightClick;

      // Handle panning with right/middle mouse button - highest priority
      if (isPanClick) {
        panning = true;
        panStart.x = e.globalX;
        panStart.y = e.globalY;
        viewStart.x = viewport.position.x;
        viewStart.y = viewport.position.y;
        app.stage.cursor = 'grabbing';
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }

      // Only handle left clicks for tools (button === 0)
      if (e.button !== 0) {
        return;
      }

      const localPoint = toLocal(e.globalX, e.globalY);
      
      // Handle tool-specific interactions only for left clicks
      // Remove hard boundary restriction - allow tools to work outside artboard
      handleToolInteraction(localPoint, e);
    } catch (error) {
      console.error('Pointer down event failed:', error);
    }
  });

  /**
   * Handle tool-specific interactions
   * @param {Object} localPoint - Local coordinate point
   * @param {Object} event - Pointer event
   */
  function handleToolInteraction(localPoint, event) {
    // Brush and eraser tools - allow drawing outside bounds
    if (tool === 'brush' || tool === 'eraser') {
      if (!hasEditableActiveLayer() || !ensureActiveLayerPreparedForPixelEdit()) {
        return;
      }
      drawing = true;
      strokeRemainder = 0;
      lastRawPoint = localPoint;
      lastPoint = tool === 'brush' ? smoothBrushPoint(localPoint) : localPoint;
      if (tool === 'brush' || tool === 'eraser') {
        beginBrushStroke();
      }
      // Only stamp if within extended area (some buffer beyond canvas)
      const extendedBounds = 200; // Allow drawing 200px beyond canvas
      if (localPoint.x >= -extendedBounds && localPoint.x < W + extendedBounds &&
          localPoint.y >= -extendedBounds && localPoint.y < H + extendedBounds) {
        stampAt(lastPoint.x, lastPoint.y);
      }
      return;
    }

    // Color dropper tool - only work within canvas bounds
    if (tool === 'dropper') {
      try {
        sampleColorAt(localPoint);
      } catch (error) {
        console.error('Color dropper failed:', error, {
          localPoint,
          canvasSize: { W, H }
        });
      }
      return;
    }

    // Paint bucket (flood fill) tool - only work within canvas bounds
    if (tool === 'paint-bucket') {
      if (hasEditableActiveLayer() && ensureActiveLayerPreparedForPixelEdit() && inBounds(localPoint)) {
        performFloodFill(localPoint);
      }
      return;
    }

    if (tool === 'magic-wand') {
      if (inBounds(localPoint)) {
        performMagicWandSelection(localPoint);
      }
      return;
    }

    // Marquee selection tool - allow selection outside bounds
    if (tool === 'marquee') {
      const operation = marqueeSettings.selectionOperation;
      prepareSelectionDraftOperation(operation);

      selecting = true;
      scaleHandlesG.clear();
      draggingSelection = false;
      scalingSelection = false;
      rotatingSelection = false;
      scaleHandle = null;
      scaleStartSelection = null;
      selectionRotation = 0;
      marqueeDraft = {
        start: { x: localPoint.x, y: localPoint.y },
        current: { x: localPoint.x, y: localPoint.y },
        operation,
        rect: null,
      };
      selectionG.clear();
      return;
    }

    if (tool === 'lasso') {
      if (lassoSettings.mode === 'polygonal') {
        handlePolygonalLassoPointerDown(localPoint, event);
        return;
      }

      beginLassoDraft(localPoint);
      return;
    }

    if (tool === 'pen') {
      if (penSettings.pathMode !== 'selection' && !hasEditableActiveLayer()) {
        return;
      }
      handlePenPointerDown(localPoint, event);
      return;
    }

    if (tool === 'text') {
      const hitTextLayer = getTextLayerHit(localPoint);
      if (hitTextLayer) {
        layersManager?.setActiveLayer(hitTextLayer.index);
        if (wasTextLayerDoubleClicked(hitTextLayer, localPoint, event)) {
          beginTextLayerEdit(hitTextLayer.index);
        }
        return;
      }
      lastTextToolClick = null;
      beginTextDraft(localPoint);
      return;
    }

    // Move tool - allow operations outside bounds
    if (tool === 'move') {
      handleMoveToolInteraction(localPoint);
      return;
    }
  }

  /**
   * Perform flood fill operation at the specified point
   * @param {Object} localPoint - Local coordinate point
   */
  function performFloodFill(localPoint) {
    try {
      const renderTexture = getActiveEditableRenderTexture();
      if (!renderTexture) {
        console.warn('No render texture available for flood fill');
        return;
      }

      if (hasActiveSelectionMask() && !isPointInTransformedSelection(localPoint.x, localPoint.y)) {
        return;
      }

      const sourceCanvas = getBucketSourceCanvas(renderTexture);
      const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
      const imageData = ctx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
      const scaleX = sourceCanvas.width / W;
      const scaleY = sourceCanvas.height / H;
      const startX = Math.floor(Math.max(0, Math.min(sourceCanvas.width - 1, localPoint.x * scaleX)));
      const startY = Math.floor(Math.max(0, Math.min(sourceCanvas.height - 1, localPoint.y * scaleY)));
      const mask = applySelectionMaskToFillMask(
        buildBucketFillMask(imageData, startX, startY),
        sourceCanvas.width,
        sourceCanvas.height
      );

      let filledPixels = 0;
      for (let i = 0; i < mask.length; i++) {
        if (mask[i]) {
          filledPixels += 1;
        }
      }

      if (filledPixels === 0 || bucketSettings.opacity <= 0) {
        return;
      }

      const fillCanvas = buildBucketFillCanvas(mask, sourceCanvas.width, sourceCanvas.height);
      renderBucketFillToLayer(fillCanvas, renderTexture);
      notifyDocumentMutated();

      // Capture undo snapshot
      if (window.undoRedoManager) {
        setTimeout(() => {
          window.undoRedoManager.captureSnapshot('Flood fill');
        }, 10);
      }
    } catch (error) {
      console.error('Flood fill operation failed:', error);
    }
  }

  /**
   * Perform magic wand selection at the specified point
   * @param {Object} localPoint - Local coordinate point
   */
  function performMagicWandSelection(localPoint) {
    try {
      const renderTexture = getActiveReadRenderTexture();
      if (!renderTexture) {
        console.warn('No render texture available for magic wand');
        return false;
      }

      const sourceCanvas = getMagicWandSourceCanvas(renderTexture);
      const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
      const imageData = ctx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
      const scaleX = sourceCanvas.width / W;
      const scaleY = sourceCanvas.height / H;
      const startX = Math.floor(Math.max(0, Math.min(sourceCanvas.width - 1, localPoint.x * scaleX)));
      const startY = Math.floor(Math.max(0, Math.min(sourceCanvas.height - 1, localPoint.y * scaleY)));
      const operation = magicWandSettings.selectionOperation;

      prepareSelectionDraftOperation(operation);

      const mask = buildMagicWandPixelMask(imageData, startX, startY);
      let selectedPixels = 0;
      for (let i = 0; i < mask.length; i += 1) {
        if (mask[i]) {
          selectedPixels += 1;
        }
      }

      if (selectedPixels === 0) {
        return false;
      }

      const nextMask = buildSelectionMaskCanvas(mask, sourceCanvas.width, sourceCanvas.height);
      const combinedMask = combineSelectionMasks(selection?.maskCanvas || null, nextMask, operation);
      if (!combinedMask) {
        clearSelectionState({ commitSprite: false });
        return false;
      }

      return setSelectionFromMask(combinedMask, { shape: 'custom' });
    } catch (error) {
      console.error('Magic wand selection failed:', error);
      return false;
    }
  }

  /**
   * Handle move tool interaction with proper transformation support
   * @param {Object} localPoint - Local coordinate point
   */
  function handleMoveToolInteraction(localPoint) {
    if (!selection) return;
    
    // Convert local point to viewport coordinates for handle detection
    const globalPoint = board.toGlobal(localPoint);
    const viewportPoint = viewport.toLocal(globalPoint);
    
    // Check if clicking on a handle
    const handle = getScaleHandleAt(viewportPoint);
    if (handle) {
      // Content should already be extracted when switching to move tool or creating selection
      // Do not re-extract here to avoid grabbing new pixels
      
      if (handle.type === 'rotate') {
        // Start rotation operation
        rotatingSelection = true;
        scaleHandle = handle;
        
        // Calculate initial angle from selection center to mouse in board coordinates
        updateTransformationMatrix();
        const centerX = transformationMatrix.center.x;
        const centerY = transformationMatrix.center.y;
        rotationStartAngle = Math.atan2(localPoint.y - centerY, localPoint.x - centerX);
        rotationStartSelectionRotation = selectionRotation;
        
        app.stage.cursor = 'grabbing';
      } else {
        // Start scaling operation
        scalingSelection = true;
        scaleHandle = handle;
        scaleStartSelection = { ...selection };
        app.stage.cursor = handle.cursor;
      }
      return;
    }
    
    // Check if click is inside transformed selection for moving
    if (isPointInTransformedSelection(localPoint.x, localPoint.y)) {
      // Content should already be extracted when switching to move tool or creating selection
      // Do not re-extract here to avoid grabbing new pixels

      if (moveSettings.transformMode === 'rotate') {
        rotatingSelection = true;
        scaleHandle = { type: 'rotate', cursor: 'grab' };
        updateTransformationMatrix();
        const centerX = transformationMatrix.center.x;
        const centerY = transformationMatrix.center.y;
        rotationStartAngle = Math.atan2(localPoint.y - centerY, localPoint.x - centerX);
        rotationStartSelectionRotation = selectionRotation;
        app.stage.cursor = 'grabbing';
        return;
      }
      
      // Set up dragging state
      draggingSelection = true;
      
      // Calculate drag offset in selection's local coordinate system
      const localInSelection = inverseTransformPoint(localPoint.x, localPoint.y);
      dragOffset.x = localInSelection.x - selection.x;
      dragOffset.y = localInSelection.y - selection.y;
      
      // Hide selection outline and scale handles while dragging
      selectionG.clear();
      scaleHandlesG.clear();
      
      // Change cursor to indicate dragging
      app.stage.cursor = 'grabbing';
      
    } else {
      // Click outside selection - clear it directly
      clearSelectionState({ commitSprite: true });
    }
  }
  
  /**
   * Extract the selected content from the current layer and prepare it for transformation
   */
  function extractSelectionContent() {
    if (!selection || selectionSprite) {
      return; // Already extracted or no selection
    }
    
    const { x, y, width: sw, height: sh } = selection;
    
    try {
      // Get the current render texture for extraction
      const renderTexture = getActiveEditableRenderTexture();
      if (!renderTexture) {
        console.warn('No render texture available for move tool');
        return;
      }
      rasterizeLayerForRenderTexture(renderTexture);
      selectionSourceRenderTexture = renderTexture;
      
      // Extract the full canvas to get the selected region
      const extractCanvas = app.renderer.extract.canvas(renderTexture);
      
      // Handle potential canvas scaling
      const scaleX = extractCanvas.width / W;
      const scaleY = extractCanvas.height / H;
      
      // Calculate scaled selection coordinates
      const scaledX = Math.floor(x * scaleX);
      const scaledY = Math.floor(y * scaleY);
      const scaledW = Math.floor(sw * scaleX);
      const scaledH = Math.floor(sh * scaleY);
      
      // Create canvas for the selected region
      const regionCanvas = document.createElement('canvas');
      regionCanvas.width = scaledW;
      regionCanvas.height = scaledH;
      
      const regionCtx = regionCanvas.getContext('2d');
      regionCtx.drawImage(extractCanvas, 
        scaledX, scaledY, scaledW, scaledH,  // source
        0, 0, scaledW, scaledH               // destination
      );

      if (selection.localMaskCanvas) {
        regionCtx.globalCompositeOperation = 'destination-in';
        regionCtx.drawImage(selection.localMaskCanvas, 0, 0, scaledW, scaledH);
        regionCtx.globalCompositeOperation = 'source-over';
      }
      
      // Clear only the selected pixels from the render texture, respecting soft masks.
      if (selection.maskCanvas) {
        const eraseTexture = PIXI.Texture.from(selection.maskCanvas);
        const eraseSprite = new PIXI.Sprite(eraseTexture);
        eraseSprite.width = W;
        eraseSprite.height = H;
        eraseSprite.position.set(0, 0);
        eraseSprite.blendMode = PIXI.BLEND_MODES.ERASE;
        app.renderer.render(eraseSprite, { renderTexture, clear: false });
        eraseSprite.destroy();
        eraseTexture.destroy(true);
      }
      
      // Create moveable sprite from the extracted region
      const texture = PIXI.Texture.from(regionCanvas);
      selectionSprite = new PIXI.Sprite(texture);
      
      // Add to board container
      board.addChild(selectionSprite);
      refreshSelectionMaskPreview();
      
      // Initialize transformation matrix for this selection
      updateTransformationMatrix();
      applySelectionSpriteTransform();
      
    } catch (error) {
      console.error('Selection content extraction failed:', error);
    }
  }

  /**
   * Handle pointer move events for drawing, selection, and dragging
   */
  app.stage.on('pointermove', (e) => {
    try {
      // Handle panning first - absolute highest priority
      if (panning) {
        const deltaX = e.globalX - panStart.x;
        const deltaY = e.globalY - panStart.y;
        viewport.position.set(viewStart.x + deltaX, viewStart.y + deltaY);
        updateTextEditorOverlay();
        // Don't process any other interactions while panning
        return;
      }
      
      const localPoint = toLocal(e.globalX, e.globalY);
      
      // Update brush cursor position for brush and eraser tools - allow outside bounds
      if ((tool === 'brush' || tool === 'eraser')) {
        showBrushCursor(localPoint.x, localPoint.y);
      } else {
        hideBrushCursor();
      }
      
      // Update cursor for move tool when not panning or in other operations
      if (tool === 'move' && selection && !draggingSelection && !scalingSelection && !rotatingSelection) {
        // Check if hovering over a scale handle
        const globalPoint = board.toGlobal(localPoint);
        const viewportPoint = viewport.toLocal(globalPoint);
        const handle = getScaleHandleAt(viewportPoint);
        
        if (handle) {
          app.stage.cursor = handle.cursor;
        } else {
          // Use transformation-aware hit detection
          const isOverSelection = isPointInTransformedSelection(localPoint.x, localPoint.y);
          app.stage.cursor = isOverSelection
            ? (moveSettings.transformMode === 'rotate' ? 'crosshair' : 'grab')
            : 'default';
        }
      } else if (tool === 'move' && !draggingSelection && !scalingSelection && !rotatingSelection) {
        app.stage.cursor = 'default';
      }

      if (tool === 'pen') {
        if (penPointerState) {
          updatePenPointerDrag(localPoint);
          return;
        }

        if (penDraft?.anchors?.length && !penDraft.isClosed) {
          penDraft.previewPoint = { x: localPoint.x, y: localPoint.y };
          drawPenDraft();
        }

        const hit = hitPenControl(localPoint);
        app.stage.cursor = hit
          ? (hit.type === 'handle' ? 'crosshair' : 'grab')
          : 'crosshair';
        return;
      }

      if (tool === 'text') {
        app.stage.cursor = 'text';
        return;
      }

      // Handle drawing (brush/eraser) - allow drawing outside canvas bounds
      if (drawing && lastPoint) {
        lastRawPoint = localPoint;
        const nextPoint = tool === 'brush' ? smoothBrushPoint(localPoint) : localPoint;
        drawSegment(lastPoint, nextPoint);
        lastPoint = nextPoint;
        return;
      }

      // Handle scaling operations with transformation matrix support
      if (scalingSelection && scaleHandle && scaleStartSelection && selection && selectionSprite) {
        // Only handle scaling if not rotating
        if (scaleHandle.type !== 'rotate') {
          // Calculate new selection dimensions based on handle type
          let newSelection = { ...selection };
          
          // Transform current mouse position to selection's local space
          const localMouse = inverseTransformPoint(localPoint.x, localPoint.y);
          const snappedMouse = {
            x: snapPositionValue(localMouse.x),
            y: snapPositionValue(localMouse.y),
          };
          
          switch (scaleHandle.type) {
            case 'nw': // Northwest corner
              newSelection.x = snappedMouse.x;
              newSelection.y = snappedMouse.y;
              newSelection.width = Math.max(1, scaleStartSelection.x + scaleStartSelection.width - newSelection.x);
              newSelection.height = Math.max(1, scaleStartSelection.y + scaleStartSelection.height - newSelection.y);
              break;
              
            case 'ne': // Northeast corner
              newSelection.y = snappedMouse.y;
              newSelection.width = Math.max(1, snappedMouse.x - scaleStartSelection.x);
              newSelection.height = Math.max(1, scaleStartSelection.y + scaleStartSelection.height - newSelection.y);
              break;
              
            case 'sw': // Southwest corner
              newSelection.x = snappedMouse.x;
              newSelection.width = Math.max(1, scaleStartSelection.x + scaleStartSelection.width - newSelection.x);
              newSelection.height = Math.max(1, snappedMouse.y - scaleStartSelection.y);
              break;
              
            case 'se': // Southeast corner
              newSelection.width = Math.max(1, snappedMouse.x - scaleStartSelection.x);
              newSelection.height = Math.max(1, snappedMouse.y - scaleStartSelection.y);
              break;
              
            case 'n': // North edge
              newSelection.y = snappedMouse.y;
              newSelection.height = Math.max(1, scaleStartSelection.y + scaleStartSelection.height - newSelection.y);
              break;
              
            case 's': // South edge
              newSelection.height = Math.max(1, snappedMouse.y - scaleStartSelection.y);
              break;
              
            case 'w': // West edge
              newSelection.x = snappedMouse.x;
              newSelection.width = Math.max(1, scaleStartSelection.x + scaleStartSelection.width - newSelection.x);
              break;
              
            case 'e': // East edge
              newSelection.width = Math.max(1, snappedMouse.x - scaleStartSelection.x);
              break;
          }

          if (moveSettings.uniformScale && ['nw', 'ne', 'sw', 'se'].includes(scaleHandle.type)) {
            const aspectRatio = scaleStartSelection.width / Math.max(1, scaleStartSelection.height);
            if (newSelection.width / Math.max(1, newSelection.height) > aspectRatio) {
              newSelection.height = newSelection.width / Math.max(0.0001, aspectRatio);
            } else {
              newSelection.width = newSelection.height * aspectRatio;
            }

            if (scaleHandle.type.includes('n')) {
              newSelection.y = scaleStartSelection.y + scaleStartSelection.height - newSelection.height;
            }
            if (scaleHandle.type.includes('w')) {
              newSelection.x = scaleStartSelection.x + scaleStartSelection.width - newSelection.width;
            }
          }
          
          // Update selection dimensions
          selection = newSelection;
          
          // Update transformation matrix
          updateTransformationMatrix();
          
          applySelectionSpriteTransform();
          
          // Redraw selection outline and scale handles
          drawSelectionOutline();
          drawScaleHandles();
        }
        return;
      }
      
      // Handle rotation operations with transformation matrix support
      if (rotatingSelection && scaleHandle && scaleHandle.type === 'rotate' && selection && selectionSprite) {
        // Calculate current angle from selection center to mouse in board coordinates
        updateTransformationMatrix();
        const centerX = transformationMatrix.center.x;
        const centerY = transformationMatrix.center.y;
        const currentAngle = Math.atan2(localPoint.y - centerY, localPoint.x - centerX);
        
        // Calculate rotation delta
        const deltaAngle = currentAngle - rotationStartAngle;
        selectionRotation = snapAngleRadians(rotationStartSelectionRotation + deltaAngle);
        
        // Update transformation matrix
        transformationMatrix.rotation = selectionRotation;
        
        applySelectionSpriteTransform();
        
        // Update the visual selection outline and handles to match rotation
        drawSelectionOutline();
        drawScaleHandles();
        
        return;
      }

      // Handle selection dragging with transformation matrix support
      if (draggingSelection && selectionSprite && selection) {
        // Calculate new position based on drag offset in selection's local coordinate system
        const newLocalX = snapPositionValue(localPoint.x - dragOffset.x);
        const newLocalY = snapPositionValue(localPoint.y - dragOffset.y);
        
        // Update selection position
        selection.x = newLocalX;
        selection.y = newLocalY;
        
        // Update transformation matrix
        updateTransformationMatrix();
        
        applySelectionSpriteTransform();
        
        return;
      }

      // Handle marquee selection - allow selection to start outside the artboard.
      if (selecting && marqueeDraft) {
        marqueeDraft.current = { x: localPoint.x, y: localPoint.y };
        marqueeDraft.rect = buildMarqueeRect(marqueeDraft.start, marqueeDraft.current);
        drawMarqueeDraft(marqueeDraft.rect);
        return;
      }

      if (tool === 'lasso' && lassoDraft) {
        if (lassoDraft.isDrawing) {
          addLassoPoint(localPoint);
          return;
        }

        if (lassoDraft.mode === 'polygonal') {
          lassoDraft.previewPoint = getPreparedLassoPoint(localPoint);
          lassoDraft.isClosingPreview = lassoDraft.points.length >= 3 &&
            distanceBetweenPoints(lassoDraft.previewPoint, lassoDraft.points[0]) <= 9 / Math.max(0.5, viewport.scale.x);
          drawLassoDraft();
        }
      }
    } catch (error) {
      console.error('Pointer move event failed:', error);
    }
  });

  function finalizeMarqueeSelection() {
    if (!marqueeDraft) {
      drawSelectionOutline();
      return false;
    }

    const rect = marqueeDraft.rect || buildMarqueeRect(marqueeDraft.start, marqueeDraft.current);
    const operation = marqueeDraft.operation || 'replace';
    marqueeDraft = null;

    if (!rect || rect.width < 3 || rect.height < 3) {
      if (!selection) {
        clearSelectionState({ commitSprite: false });
      } else {
        refreshSelectionMaskPreview();
        drawSelectionOutline();
      }
      return false;
    }

    const nextMask = buildMarqueeMask(rect);
    const combinedMask = combineSelectionMasks(selection?.maskCanvas || null, nextMask, operation);
    if (!combinedMask) {
      clearSelectionState({ commitSprite: false });
      return false;
    }

    const isSimpleReplace = operation === 'replace';
    const shape = isSimpleReplace ? marqueeSettings.mode : 'custom';
    return setSelectionFromMask(combinedMask, { shape });
  }

  /**
   * End all active interactions (drawing, panning, selecting, dragging)
   */
  function endAllInteractions() {
    // Reset cursor first
    app.stage.cursor = 'default';
    
    // Handle panning end
    let shouldNotifyViewChange = false;
    if (panning) {
      panning = false;
      app.stage.cursor = 'default';
      shouldNotifyViewChange = true;
    }
    
    // Capture undo snapshot when drawing ends
    let shouldCaptureSnapshot = false;
    let shouldNotifyMutation = false;
    let snapshotDescription = '';
    
    if (drawing) {
      if (tool === 'brush' && lastPoint && lastRawPoint) {
        drawSegment(lastPoint, lastRawPoint);
        lastPoint = lastRawPoint;
      }
      if (tool === 'brush' || tool === 'eraser') {
        commitBrushStroke();
      }
      drawing = false;
      lastPoint = null;
      lastRawPoint = null;
      strokeRemainder = 0;
      shouldCaptureSnapshot = true;
      shouldNotifyMutation = true;
      snapshotDescription = tool === 'brush' ? 'Brush stroke' : 'Eraser stroke';
    }
    
    if (selecting) {
      selecting = false;
      finalizeMarqueeSelection();

      if (selection && tool === 'move') {
        drawScaleHandles();
        if (!selectionSprite) {
          extractSelectionContent();
        }
      }
    }

    if (lassoDraft?.isDrawing) {
      lassoDraft.isDrawing = false;
      finalizeLassoSelection();
    }

    if (penPointerState) {
      penPointerState = null;
      if (tool === 'pen') {
        app.stage.cursor = 'crosshair';
        drawPenDraft();
      }
    }
    
    if (scalingSelection && selection) {
      try {
        scalingSelection = false;
        scaleHandle = null;
        scaleStartSelection = null;
        app.stage.cursor = 'default';
        
        // Keep selection sprite active for continuous transformations
        // Do not commit back to canvas until explicitly deselected
        
        // Redraw selection outline and scale handles at new size
        drawSelectionOutline();
        
        // Redraw scale handles
        drawScaleHandles();
        notifyMoveStateChanged();
        
        shouldNotifyMutation = true;

        // Capture undo snapshot for scaling operation
        if (window.undoRedoManager) {
          setTimeout(() => {
            window.undoRedoManager.captureSnapshot('Scale selection');
          }, 10);
        }
        
      } catch (error) {
        console.error('Failed to end scaling operation:', error);
      }
    }
    
    if (rotatingSelection && selection) {
      try {
        rotatingSelection = false;
        scaleHandle = null;
        app.stage.cursor = 'default';
        
        // Keep selection sprite active for continuous transformations
        // Do not commit back to canvas until explicitly deselected
        
        // Redraw selection outline and scale handles
        drawSelectionOutline();
        
        // Redraw scale handles
        drawScaleHandles();
        notifyMoveStateChanged();
        
        shouldNotifyMutation = true;

        // Capture undo snapshot for rotation operation
        if (window.undoRedoManager) {
          setTimeout(() => {
            window.undoRedoManager.captureSnapshot('Rotate selection');
          }, 10);
        }
        
      } catch (error) {
        console.error('Failed to end rotation operation:', error);
      }
    }
    
    if (draggingSelection && selection) {
      try {
        draggingSelection = false;
        app.stage.cursor = 'default';
        
        // Keep selection sprite active for continuous transformations
        // Do not commit back to canvas until explicitly deselected
        
        // Redraw selection outline at new position
        drawSelectionOutline();
        
        // Redraw scale handles after moving
        drawScaleHandles();
        notifyMoveStateChanged();
        
        shouldNotifyMutation = true;

        // Capture undo snapshot for move operation
        if (window.undoRedoManager) {
          setTimeout(() => {
            window.undoRedoManager.captureSnapshot('Move selection');
          }, 10);
        }
        
      } catch (error) {
        console.error('Failed to end selection drag:', error);
      }
    }
    
    if (shouldNotifyMutation) {
      notifyDocumentMutated();
    }

    if (shouldNotifyViewChange) {
      emitViewChanged();
    }

    // Capture undo snapshot for drawing operations
    if (shouldCaptureSnapshot && window.undoRedoManager) {
      // Use setTimeout to ensure the render operations complete before snapshot
      setTimeout(() => {
        window.undoRedoManager.captureSnapshot(snapshotDescription);
        
        // Trigger thumbnail refresh after drawing operations complete
        if (onDrawingComplete && typeof onDrawingComplete === 'function') {
          onDrawingComplete();
        }
      }, 10);
    }
  }

  window.addEventListener('keydown', (event) => {
    const activeElement = document.activeElement;
    if (activeElement?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement?.tagName)) {
      return;
    }

    if (tool === 'lasso' && lassoDraft) {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        finalizeLassoSelection();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelLassoDraft();
      }
      return;
    }

    if (tool === 'pen' && penDraft) {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        commitPenDraft({ forceClose: penSettings.closePath });
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelPenDraft();
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        event.stopPropagation();
        deleteLastPenAnchor();
      }
    }
  });

  // Bind end interaction events
  app.stage.on('pointerup', endAllInteractions);
  app.stage.on('pointerupoutside', endAllInteractions);
  
  // Handle mouse enter/leave for brush cursor
  app.stage.on('pointerenter', () => {
    if (tool === 'brush' || tool === 'eraser') {
      updateBrushCursor();
    }
  });
  
  app.stage.on('pointerleave', () => {
    hideBrushCursor();
  });
  
  // Prevent context menu on canvas
  app.view.addEventListener('contextmenu', (ev) => ev.preventDefault());
  
  // Prevent middle mouse button default behavior (auto-scroll)
  app.view.addEventListener('mousedown', (ev) => {
    if (ev.button === 1) { // Middle mouse button
      ev.preventDefault();
      ev.stopPropagation();
    }
  });
  
  // Also prevent on auxiliary button events
  app.view.addEventListener('auxclick', (ev) => {
    if (ev.button === 1) { // Middle mouse button
      ev.preventDefault();
      ev.stopPropagation();
    }
  });

  return api;
}



