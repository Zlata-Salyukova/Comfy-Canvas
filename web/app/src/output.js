/**
 * Comfy Canvas - Output Module
 * Handles display and interaction for the output/result pane (right side)
 */
import * as PIXI from './pixi.js';

/**
 * Creates an output display pane for showing generated results
 * @param {string} selector - CSS selector for the host element
 * @param {Object} options - Configuration options
 * @param {number} options.width - Initial canvas width
 * @param {number} options.height - Initial canvas height
 * @returns {Object} Output API object
 */
export function createOutput(selector, { width = 1024, height = 1024 } = {}) {
  // ========== INITIALIZATION ==========
  const host = document.querySelector(selector);
  if (!host) {
    throw new Error(`Output host element not found: ${selector}`);
  }
  // Initialize Pixi application with optimized settings
  const app = new PIXI.Application({
    background: '#000000ff',
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    powerPreference: 'high-performance',
    resizeTo: host,
  });
  
  try {
    host.appendChild(app.view);
  } catch (error) {
    console.error('Failed to initialize output canvas:', error);
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
  board.addChild(sprite, border);
  viewport.addChild(board);
  app.stage.addChild(viewport);

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
  }

  let onViewChanged = null;

  function emitViewChanged() {
    if (typeof onViewChanged !== 'function') {
      return;
    }

    try {
      onViewChanged(getViewState());
    } catch (error) {
      console.error('Failed to notify output view change:', error);
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
    return true;
  }
  
  // Initialize with fit and center on first mount
  app.ticker.addOnce(fitAndCenter);
  
  // Auto-fit behavior control
  let autoFitOnResize = false;
  const resizeObserver = new ResizeObserver(() => {
    if (!autoFitOnResize) return;
    requestAnimationFrame(fitAndCenter);
  });
  resizeObserver.observe(host);

  // ========== INTERACTION HANDLING ==========
  // Pan state management
  let panning = false;
  let panStart = { x: 0, y: 0 };
  let viewStart = { x: 0, y: 0 };

  /**
   * Handle mouse wheel zoom with cursor-centered scaling
   */
  app.view.addEventListener('wheel', (ev) => {
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
      viewport.position.set(
        viewport.position.x + (afterZoom.x - beforeZoom.x) * newScale,
        viewport.position.y + (afterZoom.y - beforeZoom.y) * newScale
      );
      emitViewChanged();
    } catch (error) {
      console.error('Output zoom operation failed:', error);
    }
  }, { passive: false });
  // Configure stage for pointer events
  app.stage.eventMode = 'static';
  app.stage.hitArea = app.screen;

  /**
   * Handle pointer down for panning
   */
  app.stage.on('pointerdown', (e) => {
    try {
      panning = true;
      panStart.x = e.globalX;
      panStart.y = e.globalY;
      viewStart.x = viewport.position.x;
      viewStart.y = viewport.position.y;
      app.stage.cursor = 'grab';
    } catch (error) {
      console.error('Output pointer down failed:', error);
    }
  });

  /**
   * Handle pointer move for panning
   */
  app.stage.on('pointermove', (e) => {
    if (!panning) return;
    
    try {
      const deltaX = e.globalX - panStart.x;
      const deltaY = e.globalY - panStart.y;
      viewport.position.set(viewStart.x + deltaX, viewStart.y + deltaY);
    } catch (error) {
      console.error('Output pointer move failed:', error);
    }
  });

  /**
   * End panning interaction
   */
  function endPanning() {
    if (panning) {
      panning = false;
      app.stage.cursor = 'default';
      emitViewChanged();
    }
  }

  // Bind end interaction events
  app.stage.on('pointerup', endPanning);
  app.stage.on('pointerupoutside', endPanning);
  
  // Prevent context menu on canvas
  app.view.addEventListener('contextmenu', (ev) => ev.preventDefault());

  // ========== PUBLIC API ==========
  return {
    /**
     * Fit the canvas to viewport and center it
     */
    fitAndCenter({ notify = true } = {}) {
      fitAndCenter();
      if (notify !== false) {
        emitViewChanged();
      }
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
     * Set auto-fit behavior on resize
     * @param {boolean} enabled - Whether to auto-fit on resize
     */
    setAutoFitOnResize(enabled) {
      autoFitOnResize = !!enabled;
    },
    setOnViewChanged(callback) {
      onViewChanged = callback;
    },

    /**
     * Execute a function with auto-fit temporarily disabled
     * @param {Function} fn - Function to execute
     */
    withViewLocked(fn) {
      const previousAutoFit = autoFitOnResize;
      autoFitOnResize = false;
      try {
        fn();
      } finally {
        autoFitOnResize = previousAutoFit;
      }
    },
    /**
     * Resize the artboard to new dimensions
     * @param {number} newW - New width
     * @param {number} newH - New height
     * @param {Object} options - Resize options
     * @param {boolean} options.preserveView - Whether to preserve the current view
     */
    resizeArtboard(newW, newH, { preserveView = true } = {}) {
      try {
        // Remember current view state
        const prevScale = viewport.scale.x;
        const prevPos = viewport.position.clone();

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
        rt = newRT.baseTexture;
        W = newW;
        H = newH;
        border.clear().lineStyle(1, 0x333333, 1).drawRect(-0.5, -0.5, W + 1, H + 1);

        // Restore view if requested
        if (preserveView) {
          viewport.scale.set(prevScale);
          viewport.position.copyFrom(prevPos);
        }

        // Clean up old texture
        if (oldTexture && oldTexture !== newRT) {
          oldTexture.destroy(true);
        }
      } catch (error) {
        console.error('Failed to resize output artboard:', error);
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
        W = canvas.width;
        H = canvas.height;
        border.clear().lineStyle(1, 0x333333, 1).drawRect(-0.5, -0.5, W + 1, H + 1);
        
        // Clean up old texture if it's different
        if (oldTexture && oldTexture !== texture) {
          oldTexture.destroy(true);
        }
      } catch (error) {
        console.error('Failed to show canvas in output:', error);
      }
    },

    /**
     * Capture the current output as a normalized canvas.
     * @returns {HTMLCanvasElement} Snapshot canvas
     */
    snapshotCanvas() {
      try {
        const extracted = app.renderer.extract.canvas(sprite);
        if (extracted.width === W && extracted.height === H) {
          return extracted;
        }

        const normalized = document.createElement('canvas');
        normalized.width = W;
        normalized.height = H;
        const ctx = normalized.getContext('2d');
        ctx.drawImage(extracted, 0, 0, W, H);
        return normalized;
      } catch (error) {
        console.error('Failed to snapshot output canvas:', error);
        const fallback = document.createElement('canvas');
        fallback.width = W;
        fallback.height = H;
        return fallback;
      }
    },
  };
}


