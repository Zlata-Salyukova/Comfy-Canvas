/**
 * Comfy Canvas - Layers Module
 * Manages layer state, operations, and rendering for the canvas editor
 */
import * as PIXI from 'https://unpkg.com/pixi.js@7.4.0/dist/pixi.min.mjs';

/**
 * Creates a layers management system
 * @param {PIXI.Application} app - The PIXI application instance
 * @param {number} width - Canvas width
 * @param {number} height - Canvas height
 * @returns {Object} Layers API object
 */
export function createLayersManager(app, width, height) {
  // ========== LAYER STATE ==========
  let layers = [];
  let activeLayerIndex = 0;
  let nextLayerId = 1;
  
  // Layer composition container
  const layerContainer = new PIXI.Container();
  
  // ========== LAYER CREATION ==========
  /**
   * Create a new layer with specified properties
   * @param {Object} options - Layer configuration
   * @param {string} options.name - Layer name
   * @param {number} options.opacity - Layer opacity (0-1)
   * @param {string} options.blendMode - PIXI blend mode
   * @param {boolean} options.visible - Layer visibility
   * @param {number} options.fillColor - Color to fill the layer (hex, optional)
   * @returns {Object} Created layer object
   */
  function createLayer({ 
    name = `Layer ${nextLayerId}`, 
    opacity = 1, 
    blendMode = 'normal', 
    visible = true,
    fillColor = null
  } = {}) {
    // Create render texture for the layer
    const renderTexture = PIXI.RenderTexture.create({ 
      width, 
      height, 
      resolution: 1 
    });
    
    // Initialize with specified fill color or transparent background
    const clearGraphics = new PIXI.Graphics();
    if (fillColor !== null) {
      // Fill with specified color (opaque)
      clearGraphics.beginFill(fillColor, 1);
    } else {
      // Fill with transparent
      clearGraphics.beginFill(0x000000, 0);
    }
    clearGraphics.drawRect(0, 0, width, height);
    clearGraphics.endFill();
    app.renderer.render(clearGraphics, { renderTexture, clear: true });
    clearGraphics.destroy();
    
    // Create sprite to display the layer
    const sprite = new PIXI.Sprite(renderTexture);
    sprite.alpha = opacity;
    sprite.visible = visible;
    
    // Convert blend mode string to PIXI constant
    const blendModeMap = {
      'normal': PIXI.BLEND_MODES.NORMAL,
      'multiply': PIXI.BLEND_MODES.MULTIPLY,
      'screen': PIXI.BLEND_MODES.SCREEN,
      'overlay': PIXI.BLEND_MODES.OVERLAY,
      'darken': PIXI.BLEND_MODES.DARKEN,
      'lighten': PIXI.BLEND_MODES.LIGHTEN,
      'color-dodge': PIXI.BLEND_MODES.COLOR_DODGE,
      'color-burn': PIXI.BLEND_MODES.COLOR_BURN,
      'hard-light': PIXI.BLEND_MODES.HARD_LIGHT,
      'soft-light': PIXI.BLEND_MODES.SOFT_LIGHT,
      'difference': PIXI.BLEND_MODES.DIFFERENCE,
      'exclusion': PIXI.BLEND_MODES.EXCLUSION
    };
    
    sprite.blendMode = blendModeMap[blendMode] || PIXI.BLEND_MODES.NORMAL;
    
    const layer = {
      id: nextLayerId++,
      name,
      renderTexture,
      sprite,
      opacity,
      blendMode,
      visible,
      locked: false
    };
    
    return layer;
  }
  
  /**
   * Add a new layer to the stack
   * @param {Object} options - Layer configuration
   * @returns {Object} Created layer
   */
  function addLayer(options = {}) {
    const layer = createLayer(options);
    layers.push(layer);
    layerContainer.addChild(layer.sprite);
    
    // Set as active layer
    activeLayerIndex = layers.length - 1;
    
    // Emit layer added event
    api.emit('layerAdded', { layer, index: activeLayerIndex });
    api.emit('activeLayerChanged', { layer, index: activeLayerIndex });
    
    return layer;
  }
  
  /**
   * Remove a layer from the stack
   * @param {number} index - Layer index to remove
   * @param {boolean} allowLastLayer - Allow removal of the last layer (for undo/redo)
   */
  function removeLayer(index, allowLastLayer = false) {
    if (index < 0 || index >= layers.length) {
      return false; // Invalid index
    }
    
    if (!allowLastLayer && layers.length <= 1) {
      return false; // Can't remove if only one layer (normal UI behavior)
    }
    
    const layer = layers[index];
    
    // Remove from container and cleanup
    layerContainer.removeChild(layer.sprite);
    layer.renderTexture.destroy(true);
    layer.sprite.destroy();
    
    // Remove from array
    layers.splice(index, 1);
    
    // Adjust active layer index
    if (layers.length > 0) {
      if (activeLayerIndex >= index) {
        activeLayerIndex = Math.max(0, activeLayerIndex - 1);
      }
      
      // Emit events
      api.emit('layerRemoved', { layer, index });
      api.emit('activeLayerChanged', { 
        layer: layers[activeLayerIndex], 
        index: activeLayerIndex 
      });
    } else {
      // No layers left
      activeLayerIndex = -1;
      api.emit('layerRemoved', { layer, index });
    }
    
    return true;
  }
  
  /**
   * Clear all layers (for undo/redo system)
   */
  function clearAllLayers() {
    // Clear all layers
    const layersToRemove = [...layers]; // Copy array to avoid modification during iteration
    layersToRemove.forEach((layer, index) => {
      layerContainer.removeChild(layer.sprite);
      layer.renderTexture.destroy(true);
      layer.sprite.destroy();
    });
    
    // Reset state
    layers = [];
    activeLayerIndex = -1;
    
    return true;
  }
  
  /**
   * Move a layer to a new position
   * @param {number} fromIndex - Current layer index
   * @param {number} toIndex - Target layer index
   */
  function moveLayer(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || 
        fromIndex >= layers.length || toIndex >= layers.length) {
      return false;
    }
    
    const layer = layers[fromIndex];
    
    // Remove from current position
    layers.splice(fromIndex, 1);
    layerContainer.removeChildAt(fromIndex);
    
    // Insert at new position
    layers.splice(toIndex, 0, layer);
    layerContainer.addChildAt(layer.sprite, toIndex);
    
    // Update active layer index if needed
    if (activeLayerIndex === fromIndex) {
      activeLayerIndex = toIndex;
    } else if (activeLayerIndex > fromIndex && activeLayerIndex <= toIndex) {
      activeLayerIndex--;
    } else if (activeLayerIndex < fromIndex && activeLayerIndex >= toIndex) {
      activeLayerIndex++;
    }
    
    // Emit events
    api.emit('layerMoved', { layer, fromIndex, toIndex });
    api.emit('activeLayerChanged', { 
      layer: layers[activeLayerIndex], 
      index: activeLayerIndex 
    });
    
    return true;
  }

  /**
   * Merge the specified layer down into the one beneath it
   * @param {number} index - Index of the layer to merge (must be > 0)
   * @returns {boolean} True on success
   */
  function mergeDown(index) {
    if (index <= 0 || index >= layers.length) return false;
    const upper = layers[index];
    const lower = layers[index - 1];

    // Create a sprite from the upper layer's texture and render onto lower RT
    const spr = new PIXI.Sprite(upper.renderTexture);
    // Respect opacity and blend mode of the upper layer when merging
    const blendModeMap = {
      'normal': PIXI.BLEND_MODES.NORMAL,
      'multiply': PIXI.BLEND_MODES.MULTIPLY,
      'screen': PIXI.BLEND_MODES.SCREEN,
      'overlay': PIXI.BLEND_MODES.OVERLAY,
      'darken': PIXI.BLEND_MODES.DARKEN,
      'lighten': PIXI.BLEND_MODES.LIGHTEN,
      'color-dodge': PIXI.BLEND_MODES.COLOR_DODGE,
      'color-burn': PIXI.BLEND_MODES.COLOR_BURN,
      'hard-light': PIXI.BLEND_MODES.HARD_LIGHT,
      'soft-light': PIXI.BLEND_MODES.SOFT_LIGHT,
      'difference': PIXI.BLEND_MODES.DIFFERENCE,
      'exclusion': PIXI.BLEND_MODES.EXCLUSION
    };
    spr.alpha = upper.opacity ?? 1;
    spr.blendMode = blendModeMap[upper.blendMode] || PIXI.BLEND_MODES.NORMAL;
    try {
      app.renderer.render(spr, { renderTexture: lower.renderTexture, clear: false });
    } finally {
      spr.destroy();
    }

    // Remove the merged (upper) layer
    removeLayer(index, true);

    // Keep the lower layer selected
    const newIndex = Math.max(0, index - 1);
    setActiveLayer(newIndex);

    api.emit('layersMerged', { from: index, to: newIndex });
    return true;
  }
  
  /**
   * Set the active layer
   * @param {number} index - Layer index to activate
   */
  function setActiveLayer(index) {
    if (index < 0 || index >= layers.length) {
      return false;
    }
    
    activeLayerIndex = index;
    const layer = layers[activeLayerIndex];
    
    api.emit('activeLayerChanged', { layer, index });
    return true;
  }
  
  /**
   * Update layer properties
   * @param {number} index - Layer index
   * @param {Object} properties - Properties to update
   */
  function updateLayer(index, properties) {
    if (index < 0 || index >= layers.length) {
      return false;
    }
    
    const layer = layers[index];
    
    if (properties.name !== undefined) {
      layer.name = properties.name;
    }
    
    if (properties.opacity !== undefined) {
      layer.opacity = Math.max(0, Math.min(1, properties.opacity));
      layer.sprite.alpha = layer.opacity;
    }
    
    if (properties.visible !== undefined) {
      layer.visible = properties.visible;
      layer.sprite.visible = layer.visible;
    }
    
    if (properties.locked !== undefined) {
      layer.locked = properties.locked;
    }
    
    if (properties.blendMode !== undefined) {
      const blendModeMap = {
        'normal': PIXI.BLEND_MODES.NORMAL,
        'multiply': PIXI.BLEND_MODES.MULTIPLY,
        'screen': PIXI.BLEND_MODES.SCREEN,
        'overlay': PIXI.BLEND_MODES.OVERLAY,
        'darken': PIXI.BLEND_MODES.DARKEN,
        'lighten': PIXI.BLEND_MODES.LIGHTEN,
        'color-dodge': PIXI.BLEND_MODES.COLOR_DODGE,
        'color-burn': PIXI.BLEND_MODES.COLOR_BURN,
        'hard-light': PIXI.BLEND_MODES.HARD_LIGHT,
        'soft-light': PIXI.BLEND_MODES.SOFT_LIGHT,
        'difference': PIXI.BLEND_MODES.DIFFERENCE,
        'exclusion': PIXI.BLEND_MODES.EXCLUSION
      };
      
      layer.blendMode = properties.blendMode;
      layer.sprite.blendMode = blendModeMap[properties.blendMode] || PIXI.BLEND_MODES.NORMAL;
    }
    
    api.emit('layerUpdated', { layer, index, properties });
    return true;
  }
  
  // ========== SIMPLE EVENT SYSTEM ==========
  const eventListeners = {};
  
  function emit(eventName, data) {
    const listeners = eventListeners[eventName] || [];
    listeners.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error(`Error in layer event listener for ${eventName}:`, error);
      }
    });
  }
  
  function on(eventName, callback) {
    if (!eventListeners[eventName]) {
      eventListeners[eventName] = [];
    }
    eventListeners[eventName].push(callback);
  }
  
  function off(eventName, callback) {
    if (!eventListeners[eventName]) return;
    const index = eventListeners[eventName].indexOf(callback);
    if (index > -1) {
      eventListeners[eventName].splice(index, 1);
    }
  }
  
  // ========== PUBLIC API ==========
  const api = {
    // Layer management
    addLayer,
    removeLayer,
    clearAllLayers,
    moveLayer,
    setActiveLayer,
    updateLayer,
    mergeDown,
    
    // Getters
    getLayers: () => [...layers], // Return copy to prevent external mutation
    getActiveLayer: () => layers[activeLayerIndex],
    getActiveLayerIndex: () => activeLayerIndex,
    getLayerContainer: () => layerContainer,
    
    // Rendering
    getActiveRenderTexture: () => layers[activeLayerIndex]?.renderTexture,
    
    // Events
    on,
    off,
    emit,
    
    // Utilities
    resize(newWidth, newHeight) {
      layers.forEach(layer => {
        // Create new render texture with new size
        const newRT = PIXI.RenderTexture.create({ 
          width: newWidth, 
          height: newHeight, 
          resolution: 1 
        });
        
        // Copy old content centered
        const oldTexture = layer.renderTexture;
        const dx = Math.floor((newWidth - width) / 2);
        const dy = Math.floor((newHeight - height) / 2);
        
        // Clear new texture
        const clearGraphics = new PIXI.Graphics();
        clearGraphics.beginFill(0x000000, 0);
        clearGraphics.drawRect(0, 0, newWidth, newHeight);
        clearGraphics.endFill();
        app.renderer.render(clearGraphics, { renderTexture: newRT, clear: true });
        clearGraphics.destroy();
        
        // Copy old content if it exists
        if (oldTexture.width > 0 && oldTexture.height > 0) {
          const tempSprite = new PIXI.Sprite(oldTexture);
          tempSprite.position.set(dx, dy);
          app.renderer.render(tempSprite, { renderTexture: newRT, clear: false });
          tempSprite.destroy();
        }
        
        // Update layer
        layer.renderTexture = newRT;
        layer.sprite.texture = newRT;
        
        // Cleanup old texture
        oldTexture.destroy(true);
      });
      
      // Update dimensions
      width = newWidth;
      height = newHeight;
      
      api.emit('layersResized', { width, height });
    },
    
    // Composition
    getCompositeCanvas() {
      try {
        // Render to a 1x resolution render texture to avoid devicePixelRatio scaling
        const rt = PIXI.RenderTexture.create({ width, height, resolution: 1 });
        app.renderer.render(layerContainer, { renderTexture: rt, clear: true });
        const canvas = app.renderer.extract.canvas(rt);
        // Clean up the temporary render texture
        rt.destroy(true);
        return canvas;
      } catch (error) {
        console.error('Failed to extract composite canvas:', error);
        const fallback = document.createElement('canvas');
        fallback.width = width;
        fallback.height = height;
        const ctx = fallback.getContext('2d');
        if (ctx) ctx.fillStyle = '#ffffff', ctx.fillRect(0,0,width,height);
        return fallback;
      }
    }
  };
  
  // Initialize with white background layer
  addLayer({ name: 'Background', opacity: 1, fillColor: 0xffffff });
  
  return api;
}
