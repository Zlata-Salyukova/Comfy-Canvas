/**
 * Comfy Canvas - Editor Module
 * Handles drawing tools, canvas manipulation, and user interactions for the left pane
 */
import * as PIXI from 'https://unpkg.com/pixi.js@7.4.0/dist/pixi.min.mjs';

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
  
  // Ensure host has proper styling for canvas
  host.style.width = '100%';
  host.style.height = '100%';
  host.style.position = 'relative';
  
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
    // Ensure canvas fills the container
    app.view.style.width = '100%';
    app.view.style.height = '100%';
    app.view.style.display = 'block';
    // Ensure the PIXI render loop is running so the canvas displays
    try { app.ticker.start(); } catch {}
  } catch (error) {
    console.error('Failed to initialize editor canvas:', error);
    throw error;
  }

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
    if (!app || !app.screen) return;
    
    const s = app.screen;
    const zoom = Math.min(s.width / W, s.height / H, 1);
    viewport.scale.set(zoom);
    viewport.position.set(
      Math.round((s.width - W * zoom) * 0.5),
      Math.round((s.height - H * zoom) * 0.5)
    );
  }
  
  // Set up responsive resize handling
  const resizeObserver = new ResizeObserver(() => {
    if (app) {
      requestAnimationFrame(fitAndCenter);
    }
  });
  resizeObserver.observe(host);
  
  // Initial fit after a short delay to ensure proper sizing
  setTimeout(() => {
    try { if (app && app.ticker) app.ticker.addOnce(fitAndCenter); else fitAndCenter(); } catch {}
  }, 100);

  // ========== TOOL STATE ==========
  let tool = 'brush';
  let color = 0x55cdfc;
  let brushRadius = 8;
  let brushFeather = 0;
  let eraserRadius = 8;
  let eraserFeather = 0;
  let radius = brushRadius;
  let feather = brushFeather;

  // Drawing state
  let drawing = false;
  let lastPoint = null;

  // Selection and movement state
  let selecting = false;
  let selection = null; // {x, y, width, height} - base rectangle in board coordinates
  const selectionG = new PIXI.Graphics();
  viewport.addChild(selectionG); // Add to viewport to appear above layers
  const scaleHandlesG = new PIXI.Graphics(); // Scale handles for move tool
  viewport.addChild(scaleHandlesG);
  // Lasso selection state
  let lassoSelecting = false;
  let lassoPoints = [];
  const lassoPreviewG = new PIXI.Graphics();
  viewport.addChild(lassoPreviewG);
  let selectionSprite = null;
  let draggingSelection = false;
  let scalingSelection = false;
  let rotatingSelection = false;
  let scaleHandle = null; // Which handle is being dragged
  let scaleStartSelection = null; // Original selection for scaling
  let rotationStartAngle = 0; // Starting angle for rotation
  let selectionRotation = 0; // Current rotation angle in radians
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
    transformationMatrix.center.x = selection.x + selection.width / 2;
    transformationMatrix.center.y = selection.y + selection.height / 2;
    transformationMatrix.rotation = selectionRotation;
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
      x: centerX + (dx * cos - dy * sin),
      y: centerY + (dx * sin + dy * cos)
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
    const dx = (transformedX - centerX);
    const dy = (transformedY - centerY);
    
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
    if (selection.type === 'lasso' && Array.isArray(selection.polygon) && selection.polygon.length >= 3) {
      // Transform polygon into local space and ray-cast
      const poly = selection.polygon.map(p => inverseTransformPoint(p.x, p.y));
      let inside = false;
      for (let i=0, j=poly.length-1; i<poly.length; j=i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        const intersect = ((yi > localPoint.y) !== (yj > localPoint.y)) &&
                          (localPoint.x < (xj - xi) * (localPoint.y - yi) / ((yj - yi) || 1e-6) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    }
    return localPoint.x >= selection.x && 
           localPoint.x < selection.x + selection.width &&
           localPoint.y >= selection.y && 
           localPoint.y < selection.y + selection.height;
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
    if (tool === 'brush' || tool === 'eraser') {
      const cursorColor = tool === 'brush' ? color : 0xff0000;
      brushCursor.lineStyle(1 / viewport.scale.x, cursorColor, 0.8);
      brushCursor.drawCircle(0, 0, radius);
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
    selectionG.clear();
    selectionG.lineStyle(1 / viewport.scale.x, 0x55cdfc, 1);
    if (selection.type === 'lasso' && Array.isArray(selection.polygon) && selection.polygon.length >= 2) {
      const verts = selection.polygon.map(pt => {
        const t = transformPoint(pt.x, pt.y);
        const gp = board.toGlobal(new PIXI.Point(t.x, t.y));
        return viewport.toLocal(gp);
      });
      selectionG.moveTo(verts[0].x, verts[0].y);
      for (let i = 1; i < verts.length; i++) selectionG.lineTo(verts[i].x, verts[i].y);
      selectionG.lineTo(verts[0].x, verts[0].y);
    } else {
      // Get transformed corners in board coordinates
      const corners = getTransformedCorners();
      const viewportCorners = corners.map(corner => {
        const globalPoint = board.toGlobal(new PIXI.Point(corner.x, corner.y));
        return viewport.toLocal(globalPoint);
      });
      selectionG.moveTo(viewportCorners[0].x, viewportCorners[0].y);
      for (let i = 1; i < viewportCorners.length; i++) selectionG.lineTo(viewportCorners[i].x, viewportCorners[i].y);
      selectionG.lineTo(viewportCorners[0].x, viewportCorners[0].y);
    }
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
    
    scaleHandlesG.clear();
    
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
    transformedHandles.forEach(handle => {
      scaleHandlesG.beginFill(0xffffff, 1);
      scaleHandlesG.lineStyle(1 / viewport.scale.x, 0x55cdfc, 1);
      scaleHandlesG.drawRect(
        handle.x - halfHandle,
        handle.y - halfHandle,
        handleSize,
        handleSize
      );
      scaleHandlesG.endFill();
    });
    
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
    
    scaleHandlesG.lineStyle(1 / viewport.scale.x, 0x55cdfc, 0.6);
    scaleHandlesG.moveTo(viewportTopEdge.x, viewportTopEdge.y);
    scaleHandlesG.lineTo(viewportRotateHandle.x, viewportRotateHandle.y);
    
    // Draw rotation handle as a circle with rotation icon
    scaleHandlesG.beginFill(0xffffff, 1);
    scaleHandlesG.lineStyle(1 / viewport.scale.x, 0x55cdfc, 1);
    scaleHandlesG.drawCircle(viewportRotateHandle.x, viewportRotateHandle.y, rotateHandleRadius);
    scaleHandlesG.endFill();
    
    // Draw rotation arrow inside the circle
    const arrowRadius = rotateHandleRadius * 0.6;
    scaleHandlesG.lineStyle(1 / viewport.scale.x, 0x55cdfc, 1);
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
    
    // Check rotation handle first (highest priority)
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
  let stamp = new PIXI.Graphics();
  
  /**
   * Rebuild the stamp graphic when radius changes
   */
  function rebuildStamp() {
    if (stamp) {
      stamp.destroy();
    }
    
    if (feather > 0) {
      // Create feathered brush with stronger gradient
      const featherRatio = feather / 100;
      const solidRadius = Math.max(1, radius * (1 - featherRatio * 0.8)); // Stronger feather effect
      
      // Create radial gradient for feathering
      const canvas = document.createElement('canvas');
      const size = Math.ceil(radius * 2 + 16);
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      
      const centerX = size / 2;
      const centerY = size / 2;
      
      // Create more pronounced radial gradient
      const gradient = ctx.createRadialGradient(
        centerX, centerY, solidRadius,
        centerX, centerY, radius
      );
      
      // More aggressive feathering with multiple color stops
      gradient.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
      gradient.addColorStop(0.3, 'rgba(255, 255, 255, 0.8)');
      gradient.addColorStop(0.7, 'rgba(255, 255, 255, 0.3)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
      
      // Fill the entire circle with gradient
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fill();
      
      // Create texture from canvas and apply to stamp
      const texture = PIXI.Texture.from(canvas);
      stamp = new PIXI.Sprite(texture);
      stamp.anchor.set(0.5);
    } else {
      // Solid brush (no feathering)
      stamp = new PIXI.Graphics();
      stamp.beginFill(0xffffff).drawCircle(0, 0, radius).endFill();
    }
    
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
      // Get the current render texture (either layers or fallback)
      if (layersManager && layersManager.getActiveLayer && layersManager.getActiveLayer()?.locked) {
        console.warn('Active layer is locked; stamp ignored');
        return;
      }
      const renderTexture = layersManager ? layersManager.getActiveRenderTexture() : rt;
      if (!renderTexture) {
        console.warn('No render texture available for stamping');
        return;
      }
      
      stamp.tint = (tool === 'eraser') ? 0xffffff : color;
      stamp.position.set(x, y);
      
      if (stamp instanceof PIXI.Sprite && feather > 0) {
        // Feathered stamp - use reduced opacity for smoother blending
        const oldAlpha = stamp.alpha;
        const oldBlendMode = stamp.blendMode;
        stamp.alpha = 0.3 + (feather / 100) * 0.4; // Dynamic alpha based on feather amount
        
        if (tool === 'eraser') {
          stamp.blendMode = PIXI.BLEND_MODES.ERASE;
        } else {
          stamp.blendMode = PIXI.BLEND_MODES.NORMAL;
        }
        
        app.renderer.render(stamp, { renderTexture, clear: false });
        stamp.alpha = oldAlpha;
        stamp.blendMode = oldBlendMode;
      } else {
        // Solid stamp
        if (tool === 'eraser') {
          const oldBlendMode = stamp.blendMode;
          stamp.blendMode = PIXI.BLEND_MODES.ERASE;
          app.renderer.render(stamp, { renderTexture, clear: false });
          stamp.blendMode = oldBlendMode;
        } else {
          app.renderer.render(stamp, { renderTexture, clear: false });
        }
      }
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
    
    // Adjust steps based on feather amount to reduce overlap
    let stepSize = 1;
    if (feather > 0) {
      stepSize = Math.max(1, radius * 0.3); // Larger steps for feathered brushes
    }
    
    const steps = Math.ceil(distance / stepSize);
    
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      const x = pointA.x + (dx * t);
      const y = pointA.y + (dy * t);
      stampAt(x, y);
    }
  }

  // ========== LAYER SYSTEM INTEGRATION ==========
  let layersManager = null;
  let onDrawingComplete = null; // Callback for when drawing operations complete
  
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
      board.addChild(layerContainer);
      
      // Update rt to always use the active layer's render texture
      rt = layersManager.getActiveRenderTexture();
      
      // Listen for active layer changes
      layersManager.on('activeLayerChanged', ({ layer }) => {
        rt = layer.renderTexture;
      });
      
      // Listen for resize events
      layersManager.on('layersResized', ({ width, height }) => {
        W = width;
        H = height;
        border.clear().lineStyle(1, 0x333333, 1).drawRect(-0.5, -0.5, W + 1, H + 1);
        updateFadeOverlay();
        fitAndCenter();
      });
    }
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
      tool = name;
      
      // Handle tool-specific setup
      if (name === 'brush') {
        radius = brushRadius;
        feather = brushFeather;
        rebuildStamp();
      } else if (name === 'eraser') {
        radius = eraserRadius;
        feather = eraserFeather;
        rebuildStamp();
      } else {
        hideBrushCursor();
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
     * @param {number} options.feather - Brush feather amount (0-50)
     */
    setBrush({ colorHex, size, feather: featherValue } = {}) {
      if (colorHex) {
        color = parseInt(colorHex.slice(1), 16);
      }
      if (typeof size === 'number' && size > 0) {
        brushRadius = size;
        if (tool === 'brush') {
          radius = size;
          rebuildStamp();
        }
      }
      if (typeof featherValue === 'number' && featherValue >= 0) {
        brushFeather = featherValue;
        if (tool === 'brush') {
          feather = featherValue;
          rebuildStamp();
        }
      }
      // Update brush cursor to reflect new color/size/feather
      if (tool === 'brush') {
        updateBrushCursor();
      }
    },

    /**
     * Configure eraser settings
     * @param {Object} options - Eraser configuration
     * @param {number} options.size - Eraser size in pixels
     * @param {number} options.feather - Eraser feather amount (0-50)
     */
    setEraser({ size, feather: featherValue } = {}) {
      if (typeof size === 'number' && size > 0) {
        eraserRadius = size;
        if (tool === 'eraser') {
          radius = size;
          rebuildStamp();
        }
      }
      if (typeof featherValue === 'number' && featherValue >= 0) {
        eraserFeather = featherValue;
        if (tool === 'eraser') {
          feather = featherValue;
          rebuildStamp();
        }
      }
      // Update brush cursor to reflect new eraser size/feather
      if (tool === 'eraser') {
        updateBrushCursor();
      }
    },

    /**
     * Clear the current selection with transformation support
     */
    clearSelection() {
      // Clean up extracted selection sprite and commit any changes
      if (selectionSprite && selection) {
        updateTransformationMatrix();
        
        // If there's a selection sprite, it means content was extracted
        // We should commit it back to the layer before clearing
        const renderTexture = layersManager ? layersManager.getActiveRenderTexture() : rt;
        if (renderTexture) {
          // Create a properly sized sprite for committing with current transformations
          const commitSprite = new PIXI.Sprite(selectionSprite.texture);
          
          // Apply current transformations using transformation matrix
          commitSprite.width = selection.width;
          commitSprite.height = selection.height;
          
          if (transformationMatrix.rotation !== 0) {
            // For rotated content, use center-based positioning
            commitSprite.anchor.set(0.5, 0.5);
            commitSprite.position.set(
              transformationMatrix.center.x,
              transformationMatrix.center.y
            );
            commitSprite.rotation = transformationMatrix.rotation;
          } else {
            // For non-rotated content, use normal positioning
            commitSprite.position.set(
              transformationMatrix.position.x,
              transformationMatrix.position.y
            );
          }
          
          // Render the content back to the canvas
          app.renderer.render(commitSprite, { renderTexture, clear: false });
          commitSprite.destroy();
        }
        
        // Clean up the selection sprite
        board.removeChild(selectionSprite);
        if (selectionSprite.texture) {
          selectionSprite.texture.destroy({ destroyBase: true });
        }
        selectionSprite.destroy({ children: true });
        selectionSprite = null;
      }
      
      // Now clear selection data and states
      selection = null;
      selectionG.clear();
      scaleHandlesG.clear(); // Clear scale handles
      lassoSelecting = false; lassoPoints = []; lassoPreviewG.clear();
      
      // Reset selection-related states
      draggingSelection = false;
      scalingSelection = false;
      rotatingSelection = false;
      scaleHandle = null;
      scaleStartSelection = null;
      selectionRotation = 0;
      
      // Reset transformation matrix
      transformationMatrix = {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        center: { x: 0, y: 0 }
      };
      
      // Reset cursor
      app.stage.cursor = 'default';
    },

    /**
     * Capture the current canvas as an HTML5 canvas element
     * @returns {HTMLCanvasElement} Canvas with current drawing
     */
    snapshotCanvas() {
      try {
        if (layersManager) {
          // Use composite canvas from layers manager
          return layersManager.getCompositeCanvas();
        } else {
          // Fallback to single sprite
          return app.renderer.extract.canvas(sprite);
        }
      } catch (error) {
        console.error('Failed to snapshot canvas:', error);
        // Return empty canvas as fallback
        const fallback = document.createElement('canvas');
        fallback.width = W;
        fallback.height = H;
        const ctx = fallback.getContext('2d');
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, W, H);
        return fallback;
      }
    },

    fitAndCenter,

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
      
      // Clear any existing selection first
      this.clearSelection();
      
      // Set the new selection
      selection = {
        x: x,
        y: y, 
        width: width,
        height: height
      };
      
      // Reset selection states
      draggingSelection = false;
      scalingSelection = false;
      rotatingSelection = false;
      scaleHandle = null;
      scaleStartSelection = null;
      selectionRotation = 0;
      
      // Update transformation matrix
      updateTransformationMatrix();
      
      // Draw selection outline
      drawSelectionOutline();
      
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
    // Prevent painting on locked layers for destructive tools
    try {
      if (layersManager && layersManager.getActiveLayer && layersManager.getActiveLayer()) {
        const active = layersManager.getActiveLayer();
        if (active && active.locked && (tool === 'brush' || tool === 'eraser' || tool === 'paint-bucket')) {
          console.warn('Active layer is locked; ignoring paint action');
          return;
        }
      }
    } catch {}
    // Brush and eraser tools - allow drawing outside bounds
    if (tool === 'brush' || tool === 'eraser') {
      drawing = true;
      lastPoint = localPoint; // Remove clampToBounds to allow outside drawing
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
        // Clamp coordinates to ensure they're within canvas bounds
        const clampedPoint = clampToBounds(localPoint);
        const sampleX = Math.floor(clampedPoint.x);
        const sampleY = Math.floor(clampedPoint.y);
        
        // Double-check bounds to prevent getImageData errors
        if (sampleX < 0 || sampleY < 0 || sampleX >= W || sampleY >= H) {
          console.warn('Eyedropper coordinates out of bounds:', { sampleX, sampleY, W, H });
          return;
        }
        
        // Use composite canvas if layers are available
        const canvas = layersManager ? 
          layersManager.getCompositeCanvas() : 
          app.renderer.extract.canvas(sprite);
        const ctx = canvas.getContext('2d');
        
        // Account for potential canvas scaling due to device pixel ratio
        const scaleX = canvas.width / W;
        const scaleY = canvas.height / H;
        const scaledX = Math.floor(sampleX * scaleX);
        const scaledY = Math.floor(sampleY * scaleY);
        
        // Ensure scaled coordinates are within canvas bounds
        const finalX = Math.max(0, Math.min(canvas.width - 1, scaledX));
        const finalY = Math.max(0, Math.min(canvas.height - 1, scaledY));
        
        const pixelData = ctx.getImageData(finalX, finalY, 1, 1).data;
        
        const hex = '#' + Array.from(pixelData.slice(0, 3))
          .map(v => v.toString(16).padStart(2, '0'))
          .join('');
        
        color = parseInt(hex.slice(1), 16);
        
        // Update UI color picker if available
        const colorInput = document.getElementById('topbarColor');
        if (colorInput) {
          colorInput.value = hex;
          // Trigger the input event to update persistent settings
          colorInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
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
      if (inBounds(localPoint)) {
        performFloodFill(localPoint);
      }
      return;
    }

    // Marquee selection tool - allow selection outside bounds
    if (tool === 'marquee') {
      selecting = true;
      // Clear selection directly
      selection = null;
      selectionG.clear();
      scaleHandlesG.clear();
      draggingSelection = false;
      scalingSelection = false;
      rotatingSelection = false;
      scaleHandle = null;
      scaleStartSelection = null;
      selectionRotation = 0;
      if (selectionSprite) {
        board.removeChild(selectionSprite);
        if (selectionSprite.texture) {
          selectionSprite.texture.destroy({ destroyBase: true });
        }
        selectionSprite.destroy({ children: true });
        selectionSprite = null;
      }
      
      // Allow selection to start outside bounds
      selection = {
        x: localPoint.x,
        y: localPoint.y,
        width: 0,
        height: 0
      };
      selectionG.clear();
      return;
    }

    if (tool === 'lasso') {
      lassoSelecting = true;
      lassoPoints = [{ x: localPoint.x, y: localPoint.y }];
      // Reset any previous selection
      selection = null; selectionG.clear(); scaleHandlesG.clear();
      if (selectionSprite) {
        try { board.removeChild(selectionSprite); selectionSprite.texture?.destroy({ destroyBase: true }); selectionSprite.destroy({ children: true }); } catch(_){}
        selectionSprite = null;
      }
      lassoPreviewG.clear();
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
      // Get the current render texture
      if (layersManager && layersManager.getActiveLayer && layersManager.getActiveLayer()?.locked) {
        console.warn('Active layer is locked; flood-fill ignored');
        return;
      }
      const renderTexture = layersManager ? layersManager.getActiveRenderTexture() : rt;
      if (!renderTexture) {
        console.warn('No render texture available for flood fill');
        return;
      }
      
      // Extract canvas data directly from render texture to avoid scaling issues
      const canvas = app.renderer.extract.canvas(renderTexture);
      const ctx = canvas.getContext('2d');
      
      // Ensure canvas dimensions match expected dimensions
      if (canvas.width !== W || canvas.height !== H) {
        console.warn('Canvas size mismatch in flood fill:', {
          canvasW: canvas.width, canvasH: canvas.height,
          expectedW: W, expectedH: H
        });
        // Scale coordinates if necessary
        const scaleX = canvas.width / W;
        const scaleY = canvas.height / H;
        localPoint = {
          x: localPoint.x * scaleX,
          y: localPoint.y * scaleY
        };
      }
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      
      const startX = Math.floor(Math.max(0, Math.min(canvas.width - 1, localPoint.x)));
      const startY = Math.floor(Math.max(0, Math.min(canvas.height - 1, localPoint.y)));
      const startIndex = (startY * canvas.width + startX) * 4;
      
      // Get target and replacement colors
      const targetR = data[startIndex];
      const targetG = data[startIndex + 1];
      const targetB = data[startIndex + 2];
      const fillR = (color >> 16) & 255;
      const fillG = (color >> 8) & 255;
      const fillB = color & 255;
      
      // Don't fill if colors are the same
      if (targetR === fillR && targetG === fillG && targetB === fillB) {
        return;
      }
      
      // Non-recursive flood fill using stack
      const stack = [[startX, startY]];
      
      while (stack.length > 0) {
        const [x, y] = stack.pop();
        
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
        
        const pixelIndex = (y * canvas.width + x) * 4;
        
        if (data[pixelIndex] !== targetR || 
            data[pixelIndex + 1] !== targetG || 
            data[pixelIndex + 2] !== targetB) {
          continue;
        }
        
        // Fill the pixel
        data[pixelIndex] = fillR;
        data[pixelIndex + 1] = fillG;
        data[pixelIndex + 2] = fillB;
        data[pixelIndex + 3] = 255;
        
        // Add neighboring pixels to stack
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      }
      
      // Put modified image data back to the canvas
      ctx.putImageData(imageData, 0, 0);
      
      // Create a temporary sprite to render the modified canvas back to the render texture
      const tempTexture = PIXI.Texture.from(canvas);
      const tempSprite = new PIXI.Sprite(tempTexture);
      
      // Ensure the sprite has the correct size and position
      tempSprite.width = W;
      tempSprite.height = H;
      tempSprite.position.set(0, 0);
      
      // Render back to the original render texture
      app.renderer.render(tempSprite, { renderTexture, clear: true });
      
      // Clean up temporary objects
      tempSprite.destroy();
      tempTexture.destroy();
      
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
      clearSelection();
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
      const renderTexture = layersManager ? layersManager.getActiveRenderTexture() : rt;
      if (!renderTexture) {
        console.warn('No render texture available for move tool');
        return;
      }
      
      if (selection.type === 'lasso' && Array.isArray(selection.polygon) && selection.polygon.length >= 3) {
        // Masked extraction for polygon selection
        const container = new PIXI.Container();
        const src = new PIXI.Sprite(renderTexture);
        src.position.set(-x, -y);
        const maskG = new PIXI.Graphics();
        maskG.beginFill(0xffffff, 1);
        maskG.moveTo(selection.polygon[0].x - x, selection.polygon[0].y - y);
        for (let i=1;i<selection.polygon.length;i++) maskG.lineTo(selection.polygon[i].x - x, selection.polygon[i].y - y);
        maskG.closePath();
        maskG.endFill();
        src.mask = maskG; container.addChild(src, maskG);
        const newRT = PIXI.RenderTexture.create({ width: sw, height: sh, resolution: 1 });
        app.renderer.render(container, { renderTexture: newRT, clear: true });
        container.destroy({ children: true });
        // Erase polygon area
        const eraseG = new PIXI.Graphics();
        eraseG.beginFill(0xffffff, 1);
        eraseG.moveTo(selection.polygon[0].x, selection.polygon[0].y);
        for (let i=1;i<selection.polygon.length;i++) eraseG.lineTo(selection.polygon[i].x, selection.polygon[i].y);
        eraseG.closePath(); eraseG.endFill();
        eraseG.blendMode = PIXI.BLEND_MODES.ERASE;
        app.renderer.render(eraseG, { renderTexture, clear: false });
        eraseG.destroy();
        selectionSprite = new PIXI.Sprite(newRT);
      } else {
        // Rectangle extraction via canvas crop
        const extractCanvas = app.renderer.extract.canvas(renderTexture);
        const scaleX = extractCanvas.width / W; const scaleY = extractCanvas.height / H;
        const scaledX = Math.floor(x * scaleX), scaledY = Math.floor(y * scaleY);
        const scaledW = Math.floor(sw * scaleX), scaledH = Math.floor(sh * scaleY);
        const regionCanvas = document.createElement('canvas'); regionCanvas.width = scaledW; regionCanvas.height = scaledH;
        const regionCtx = regionCanvas.getContext('2d');
        regionCtx.drawImage(extractCanvas, scaledX, scaledY, scaledW, scaledH, 0, 0, scaledW, scaledH);
        const clearGraphics = new PIXI.Graphics(); clearGraphics.beginFill(0xffffff, 1); clearGraphics.drawRect(x, y, sw, sh); clearGraphics.endFill();
        clearGraphics.blendMode = PIXI.BLEND_MODES.ERASE; app.renderer.render(clearGraphics, { renderTexture, clear: false }); clearGraphics.destroy();
        selectionSprite = new PIXI.Sprite(PIXI.Texture.from(regionCanvas));
      }
      
      // Set correct size and position for the sprite
      selectionSprite.width = sw;
      selectionSprite.height = sh;
      selectionSprite.position.set(x, y);
      
      // Add to board container
      board.addChild(selectionSprite);
      
      // Initialize transformation matrix for this selection
      updateTransformationMatrix();
      
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
          app.stage.cursor = isOverSelection ? 'grab' : 'default';
        }
      } else if (tool === 'move' && !draggingSelection && !scalingSelection && !rotatingSelection) {
        app.stage.cursor = 'default';
      }

      // Handle drawing (brush/eraser) - allow drawing outside canvas bounds
      if (drawing && lastPoint) {
        // Draw segment without clamping to allow extension beyond canvas
        drawSegment(lastPoint, localPoint);
        lastPoint = localPoint; // Don't clamp the point
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
          
          switch (scaleHandle.type) {
            case 'nw': // Northwest corner
              newSelection.x = localMouse.x;
              newSelection.y = localMouse.y;
              newSelection.width = Math.max(1, scaleStartSelection.x + scaleStartSelection.width - newSelection.x);
              newSelection.height = Math.max(1, scaleStartSelection.y + scaleStartSelection.height - newSelection.y);
              break;
              
            case 'ne': // Northeast corner
              newSelection.y = localMouse.y;
              newSelection.width = Math.max(1, localMouse.x - scaleStartSelection.x);
              newSelection.height = Math.max(1, scaleStartSelection.y + scaleStartSelection.height - newSelection.y);
              break;
              
            case 'sw': // Southwest corner
              newSelection.x = localMouse.x;
              newSelection.width = Math.max(1, scaleStartSelection.x + scaleStartSelection.width - newSelection.x);
              newSelection.height = Math.max(1, localMouse.y - scaleStartSelection.y);
              break;
              
            case 'se': // Southeast corner
              newSelection.width = Math.max(1, localMouse.x - scaleStartSelection.x);
              newSelection.height = Math.max(1, localMouse.y - scaleStartSelection.y);
              break;
              
            case 'n': // North edge
              newSelection.y = localMouse.y;
              newSelection.height = Math.max(1, scaleStartSelection.y + scaleStartSelection.height - newSelection.y);
              break;
              
            case 's': // South edge
              newSelection.height = Math.max(1, localMouse.y - scaleStartSelection.y);
              break;
              
            case 'w': // West edge
              newSelection.x = localMouse.x;
              newSelection.width = Math.max(1, scaleStartSelection.x + scaleStartSelection.width - newSelection.x);
              break;
              
            case 'e': // East edge
              newSelection.width = Math.max(1, localMouse.x - scaleStartSelection.x);
              break;
          }
          // Photoshop-like constraint: hold Shift to maintain aspect ratio on corner handles
          try {
            const keepAspect = !!(e?.shiftKey || e?.originalEvent?.shiftKey);
            if (keepAspect && ['nw','ne','sw','se'].includes(scaleHandle.type)) {
              const ratio = (scaleStartSelection.width || 1) / (scaleStartSelection.height || 1);
              if (ratio > 0) {
                if (newSelection.height > 0) {
                  newSelection.width = Math.max(1, Math.round(newSelection.height * ratio));
                } else {
                  newSelection.height = Math.max(1, Math.round(newSelection.width / ratio));
                }
                // Re-anchor X/Y for west/north handles
                if (['nw','sw'].includes(scaleHandle.type)) newSelection.x = scaleStartSelection.x + (scaleStartSelection.width - newSelection.width);
                if (['nw','ne'].includes(scaleHandle.type)) newSelection.y = scaleStartSelection.y + (scaleStartSelection.height - newSelection.height);
              }
            }
          } catch {}
          
          // Update selection dimensions
          selection = newSelection;
          
          // Update transformation matrix
          updateTransformationMatrix();
          
          // Scale is represented by selection.width/height directly; keep matrix scale at 1
          
          // Update sprite with transformation
          if (transformationMatrix.rotation !== 0) {
            selectionSprite.anchor.set(0.5, 0.5);
            selectionSprite.position.set(
              transformationMatrix.center.x,
              transformationMatrix.center.y
            );
            selectionSprite.rotation = transformationMatrix.rotation;
          } else {
            selectionSprite.anchor.set(0, 0);
            selectionSprite.position.set(selection.x, selection.y);
            selectionSprite.rotation = 0;
          }
          
          selectionSprite.width = selection.width;
          selectionSprite.height = selection.height;
          
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
        let deltaAngle = currentAngle - rotationStartAngle;
        // Photoshop-like snapping: hold Shift to snap to 15° increments
        try {
          const snap = !!(e?.shiftKey || e?.originalEvent?.shiftKey);
          if (snap) {
            const step = Math.PI / 12; // 15 degrees
            deltaAngle = Math.round(deltaAngle / step) * step;
          }
        } catch {}
        selectionRotation = deltaAngle;
        
        // Update transformation matrix
        transformationMatrix.rotation = selectionRotation;
        
        // Apply rotation to the selection sprite
        selectionSprite.anchor.set(0.5, 0.5);
        selectionSprite.position.set(centerX, centerY);
        selectionSprite.rotation = selectionRotation;
        
        // Update the visual selection outline and handles to match rotation
        drawSelectionOutline();
        drawScaleHandles();
        
        return;
      }

      // Handle selection dragging with transformation matrix support
      if (draggingSelection && selectionSprite && selection) {
        // Calculate new position based on drag offset in selection's local coordinate system
        const newLocalX = localPoint.x - dragOffset.x;
        const newLocalY = localPoint.y - dragOffset.y;
        
        // Update selection position
        selection.x = newLocalX;
        selection.y = newLocalY;
        
        // Update transformation matrix
        updateTransformationMatrix();
        
        // Apply transformation to sprite
        if (transformationMatrix.rotation !== 0) {
          selectionSprite.anchor.set(0.5, 0.5);
          selectionSprite.position.set(
            transformationMatrix.center.x,
            transformationMatrix.center.y
          );
          selectionSprite.rotation = transformationMatrix.rotation;
        } else {
          selectionSprite.anchor.set(0, 0);
          selectionSprite.position.set(selection.x, selection.y);
          selectionSprite.rotation = 0;
        }
        
        return;
      }

      // Handle marquee selection - allow selection beyond canvas bounds
      if (selecting && selection) {
        // Allow selection to extend beyond canvas bounds - no clamping
        const minX = Math.min(selection.x, localPoint.x);
        const minY = Math.min(selection.y, localPoint.y);
        const maxX = Math.max(selection.x, localPoint.x);
        const maxY = Math.max(selection.y, localPoint.y);
        
        selection.x = minX;
        selection.y = minY;
        selection.width = maxX - minX;
        selection.height = maxY - minY;
        
        // Reset rotation for new selections
        selectionRotation = 0;
        
        // Convert board coordinates to viewport coordinates for drawing
        const viewportPos = board.toGlobal(new PIXI.Point(selection.x, selection.y));
        const localViewportPos = viewport.toLocal(viewportPos);
        const viewportWidth = selection.width * board.scale.x;
        const viewportHeight = selection.height * board.scale.y;
        
        // Draw selection rectangle with animated dashed line
        selectionG.clear()
          .lineStyle(1 / viewport.scale.x, 0x55cdfc, 1)
          .drawRect(localViewportPos.x, localViewportPos.y, viewportWidth, viewportHeight);
        
        // Add inner dashed line for better visibility
        if (viewportWidth > 6 && viewportHeight > 6) {
          selectionG.lineStyle(1 / viewport.scale.x, 0xffffff, 0.8);
          selectionG.drawRect(
            localViewportPos.x + 1 / viewport.scale.x, 
            localViewportPos.y + 1 / viewport.scale.y, 
            viewportWidth - 2 / viewport.scale.x, 
            viewportHeight - 2 / viewport.scale.y
          );
        }
      }

      // Lasso live preview
      if (lassoSelecting && lassoPoints.length > 0) {
        const last = lassoPoints[lassoPoints.length-1];
        const dx = localPoint.x - last.x, dy = localPoint.y - last.y;
        if ((dx*dx + dy*dy) > 1.5) { lassoPoints.push({ x: localPoint.x, y: localPoint.y }); }
        lassoPreviewG.clear();
        lassoPreviewG.lineStyle(1 / viewport.scale.x, 0x55cdfc, 1);
        const toViewport = (pt) => viewport.toLocal(board.toGlobal(new PIXI.Point(pt.x, pt.y)));
        const v0 = toViewport(lassoPoints[0]);
        lassoPreviewG.moveTo(v0.x, v0.y);
        for (let i=1;i<lassoPoints.length;i++){ const v=toViewport(lassoPoints[i]); lassoPreviewG.lineTo(v.x, v.y); }
      }
    } catch (error) {
      console.error('Pointer move event failed:', error);
    }
  });

  /**
   * End all active interactions (drawing, panning, selecting, dragging)
   */
  function endAllInteractions() {
    // Reset cursor first
    app.stage.cursor = 'default';
    
    // Handle panning end
    if (panning) {
      panning = false;
      app.stage.cursor = 'default';
    }
    
    // Capture undo snapshot when drawing ends
    let shouldCaptureSnapshot = false;
    let snapshotDescription = '';
    
    if (drawing) {
      drawing = false;
      lastPoint = null;
      shouldCaptureSnapshot = true;
      snapshotDescription = tool === 'brush' ? 'Brush stroke' : 'Eraser stroke';
    }
    
    if (selecting) {
      selecting = false;
      // Clear selection if it's too small (minimum 3x3 pixels)
      if (selection && (selection.width < 3 || selection.height < 3)) {
        // Clear selection directly
        selection = null;
        selectionG.clear();
        scaleHandlesG.clear();
        draggingSelection = false;
        scalingSelection = false;
        rotatingSelection = false;
        scaleHandle = null;
        scaleStartSelection = null;
        selectionRotation = 0;
        if (selectionSprite) {
          board.removeChild(selectionSprite);
          if (selectionSprite.texture) {
            selectionSprite.texture.destroy({ destroyBase: true });
          }
          selectionSprite.destroy({ children: true });
          selectionSprite = null;
        }
      } else if (selection) {
        // Ensure the selection outline is properly drawn
        drawSelectionOutline();
        
        // Draw scale handles and extract content if in move tool
        if (tool === 'move') {
          drawScaleHandles();
          // Extract content only once when selection is finalized and we're in move tool
          if (!selectionSprite) {
            extractSelectionContent();
          }
        }
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

  // Lasso finalize/cancel shortcuts
  function finalizeLasso() {
    try {
      if (!lassoSelecting || lassoPoints.length < 3) { lassoSelecting=false; lassoPreviewG.clear(); return; }
      // Compute bounding box of path
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
      for (const p of lassoPoints) { if (p.x<minX)minX=p.x; if (p.y<minY)minY=p.y; if (p.x>maxX)maxX=p.x; if (p.y>maxY)maxY=p.y; }
      const w = Math.max(1, Math.round(maxX - minX));
      const h = Math.max(1, Math.round(maxY - minY));
      selection = { x: minX, y: minY, width: w, height: h, type: 'lasso', polygon: [...lassoPoints] };
      lassoSelecting = false; lassoPreviewG.clear(); selectionRotation = 0; updateTransformationMatrix(); drawSelectionOutline();
      // Switch to move tool for transform handles and interactions
      try { window.dispatchEvent(new CustomEvent('ld_request_tool', { detail: { tool: 'move' } })); } catch {}
      if (!selectionSprite) { extractSelectionContent(); drawScaleHandles(); }
    } catch (e) { console.error('Finalize lasso failed:', e); }
  }
  function cancelLasso(){ lassoSelecting=false; lassoPoints=[]; lassoPreviewG.clear(); }
  app.view.addEventListener('dblclick', ()=>{ if (tool==='lasso') finalizeLasso(); });
  window.addEventListener('keydown', (ev)=>{
    if (tool!=='lasso') return;
    if (ev.key==='Enter') { ev.preventDefault(); finalizeLasso(); }
    if (ev.key==='Escape') { ev.preventDefault(); cancelLasso(); }
  });

  return api;
}
