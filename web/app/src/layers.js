/**
 * Comfy Canvas - Layers Module
 * Manages layer state, operations, and rendering for the canvas editor
 */
import * as PIXI from './pixi.js';

const BLEND_MODE_MAP = {
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

/**
 * Creates a layers management system
 * @param {PIXI.Application} app - The PIXI application instance
 * @param {number} width - Canvas width
 * @param {number} height - Canvas height
 * @returns {Object} Layers API object
 */
export function createLayersManager(app, width, height) {
  let layers = [];
  let activeLayerIndex = 0;
  let activeEditTarget = 'content';
  let nextLayerId = 1;

  const layerContainer = new PIXI.Container();

  function cloneTextData(textData) {
    if (!textData || typeof textData !== 'object') {
      return null;
    }

    return {
      ...textData,
    };
  }

  function getPixiBlendMode(blendMode) {
    return BLEND_MODE_MAP[blendMode] || PIXI.BLEND_MODES.NORMAL;
  }

  function clearRenderTexture(renderTexture, fillColor = 0x000000, alpha = 0) {
    const clearGraphics = new PIXI.Graphics();
    clearGraphics.beginFill(fillColor, alpha);
    clearGraphics.drawRect(0, 0, renderTexture.width, renderTexture.height);
    clearGraphics.endFill();
    app.renderer.render(clearGraphics, { renderTexture, clear: true });
    clearGraphics.destroy();
  }

  function createRenderTexture() {
    return PIXI.RenderTexture.create({
      width,
      height,
      resolution: 1,
    });
  }

  function createMaskRenderTexture(fillAlpha = 1) {
    const renderTexture = createRenderTexture();
    clearRenderTexture(renderTexture, 0xffffff, fillAlpha);
    return renderTexture;
  }

  function getEffectiveEditTargetForLayer(layer, requestedTarget = activeEditTarget) {
    return requestedTarget === 'mask' && layer?.maskRenderTexture ? 'mask' : 'content';
  }

  function getLayerRenderTexture(layer, target = activeEditTarget) {
    if (!layer) {
      return null;
    }

    const effectiveTarget = getEffectiveEditTargetForLayer(layer, target);
    return effectiveTarget === 'mask'
      ? layer.maskRenderTexture || null
      : layer.renderTexture;
  }

  function getLayerRenderTargetInfo(renderTexture) {
    if (!renderTexture) {
      return null;
    }

    for (let index = 0; index < layers.length; index += 1) {
      const layer = layers[index];
      if (layer.renderTexture === renderTexture) {
        return { index, layer, target: 'content' };
      }
      if (layer.maskRenderTexture === renderTexture) {
        return { index, layer, target: 'mask' };
      }
    }

    return null;
  }

  function ensureActiveEditTargetIsValid() {
    const layer = layers[activeLayerIndex] || null;
    activeEditTarget = getEffectiveEditTargetForLayer(layer, activeEditTarget);
    return activeEditTarget;
  }

  function destroyLayerMask(layer) {
    if (!layer) {
      return;
    }

    layer.sprite.mask = null;

    if (layer.maskSprite?.parent) {
      layer.maskSprite.parent.removeChild(layer.maskSprite);
    }
    if (layer.maskSprite) {
      layer.maskSprite.destroy();
    }
    if (layer.maskRenderTexture) {
      layer.maskRenderTexture.destroy(true);
    }

    layer.maskSprite = null;
    layer.maskRenderTexture = null;
    layer.maskEnabled = false;
  }

  function syncLayerMaskBinding(layer) {
    if (!layer) {
      return;
    }

    if (!layer.maskRenderTexture) {
      layer.sprite.mask = null;
      return;
    }

    if (!layer.maskSprite) {
      layer.maskSprite = new PIXI.Sprite(layer.maskRenderTexture);
      layer.maskSprite.position.set(0, 0);
      layer.container.addChild(layer.maskSprite);
    } else {
      layer.maskSprite.texture = layer.maskRenderTexture;
    }

    if (layer.maskEnabled === false) {
      layer.sprite.mask = null;
      layer.maskSprite.visible = false;
      return;
    }

    layer.maskSprite.visible = true;
    layer.sprite.mask = layer.maskSprite;
  }

  function applyLayerDisplayState(layer) {
    if (!layer) {
      return;
    }

    layer.sprite.alpha = layer.opacity;
    layer.sprite.visible = layer.visible;
    layer.sprite.blendMode = getPixiBlendMode(layer.blendMode);
    syncLayerMaskBinding(layer);
  }

  function emitActiveLayerState() {
    const layer = layers[activeLayerIndex] || null;
    const editTarget = getEffectiveEditTargetForLayer(layer, activeEditTarget);
    api.emit('activeLayerChanged', {
      layer,
      index: activeLayerIndex,
      editTarget,
    });
    api.emit('activeLayerEditTargetChanged', {
      layer,
      index: activeLayerIndex,
      editTarget,
    });
  }

  function createLayer({
    name = `Layer ${nextLayerId}`,
    opacity = 1,
    blendMode = 'normal',
    visible = true,
    fillColor = null,
    locked = false,
    type = 'paint',
    textData = null,
    hasMask = false,
    maskEnabled = true,
  } = {}) {
    const renderTexture = createRenderTexture();
    clearRenderTexture(renderTexture, fillColor ?? 0x000000, fillColor !== null ? 1 : 0);

    const sprite = new PIXI.Sprite(renderTexture);
    const container = new PIXI.Container();
    container.addChild(sprite);

    const layer = {
      id: nextLayerId++,
      name,
      renderTexture,
      sprite,
      container,
      opacity,
      blendMode,
      visible,
      locked,
      type,
      textData: cloneTextData(textData),
      maskRenderTexture: null,
      maskSprite: null,
      maskEnabled: hasMask ? maskEnabled !== false : false,
    };

    if (hasMask) {
      layer.maskRenderTexture = createMaskRenderTexture(1);
    }

    applyLayerDisplayState(layer);
    return layer;
  }

  function addLayer(options = {}) {
    const {
      insertIndex = layers.length,
      ...layerOptions
    } = options;
    const layer = createLayer(layerOptions);
    const safeInsertIndex = Math.max(0, Math.min(
      Number.isInteger(insertIndex) ? insertIndex : layers.length,
      layers.length,
    ));

    layers.splice(safeInsertIndex, 0, layer);
    layerContainer.addChildAt(layer.container, safeInsertIndex);

    activeLayerIndex = safeInsertIndex;
    ensureActiveEditTargetIsValid();

    api.emit('layerAdded', { layer, index: safeInsertIndex });
    emitActiveLayerState();

    return layer;
  }

  function canRemoveLayer(index, { allowLastLayer = false } = {}) {
    if (index < 0 || index >= layers.length) {
      return false;
    }

    return allowLastLayer || layers.length > 1;
  }

  function removeLayer(index, allowLastLayer = false) {
    if (!canRemoveLayer(index, { allowLastLayer })) {
      return false;
    }

    const layer = layers[index];

    layer.sprite.mask = null;
    layerContainer.removeChild(layer.container);
    layer.renderTexture.destroy(true);
    layer.sprite.destroy();
    destroyLayerMask(layer);
    layer.container.destroy();

    layers.splice(index, 1);

    if (layers.length > 0) {
      if (activeLayerIndex >= index) {
        activeLayerIndex = Math.max(0, activeLayerIndex - 1);
      }

      ensureActiveEditTargetIsValid();
      api.emit('layerRemoved', { layer, index });
      emitActiveLayerState();
    } else {
      activeLayerIndex = -1;
      activeEditTarget = 'content';
      api.emit('layerRemoved', { layer, index });
      api.emit('activeLayerChanged', {
        layer: null,
        index: -1,
        editTarget: 'content',
      });
      api.emit('activeLayerEditTargetChanged', {
        layer: null,
        index: -1,
        editTarget: 'content',
      });
    }

    return true;
  }

  function buildDuplicateLayerName(name = 'Layer') {
    const trimmed = `${name}`.trim() || 'Layer';
    const copyMatch = trimmed.match(/^(.*?)(?: copy(?: (\d+))?)$/i);
    if (!copyMatch) {
      return `${trimmed} copy`;
    }

    const baseName = (copyMatch[1] || 'Layer').trim() || 'Layer';
    const nextCopyIndex = Number.parseInt(copyMatch[2] || '1', 10) + 1;
    return `${baseName} copy ${nextCopyIndex}`;
  }

  function duplicateLayer(index) {
    const sourceLayer = layers[index];
    if (!sourceLayer) {
      return null;
    }

    const duplicatedLayer = addLayer({
      name: buildDuplicateLayerName(sourceLayer.name),
      opacity: sourceLayer.opacity,
      blendMode: sourceLayer.blendMode,
      visible: sourceLayer.visible,
      locked: sourceLayer.locked,
      type: sourceLayer.type || 'paint',
      textData: cloneTextData(sourceLayer.textData),
      hasMask: !!sourceLayer.maskRenderTexture,
      maskEnabled: sourceLayer.maskEnabled !== false,
      insertIndex: index + 1,
    });

    const tempSprite = new PIXI.Sprite(sourceLayer.renderTexture);
    try {
      app.renderer.render(tempSprite, {
        renderTexture: duplicatedLayer.renderTexture,
        clear: true,
      });
    } finally {
      tempSprite.destroy();
    }

    if (sourceLayer.maskRenderTexture && duplicatedLayer.maskRenderTexture) {
      const maskSprite = new PIXI.Sprite(sourceLayer.maskRenderTexture);
      try {
        app.renderer.render(maskSprite, {
          renderTexture: duplicatedLayer.maskRenderTexture,
          clear: true,
        });
      } finally {
        maskSprite.destroy();
      }
      syncLayerMaskBinding(duplicatedLayer);
    }

    return duplicatedLayer;
  }

  function clearAllLayers() {
    const layersToRemove = [...layers];
    layersToRemove.forEach((layer) => {
      layer.sprite.mask = null;
      layerContainer.removeChild(layer.container);
      layer.renderTexture.destroy(true);
      layer.sprite.destroy();
      destroyLayerMask(layer);
      layer.container.destroy();
    });

    layers = [];
    activeLayerIndex = -1;
    activeEditTarget = 'content';
    return true;
  }

  function moveLayer(fromIndex, toIndex) {
    if (fromIndex === toIndex
      || fromIndex < 0
      || toIndex < 0
      || fromIndex >= layers.length
      || toIndex >= layers.length) {
      return false;
    }

    const layer = layers[fromIndex];

    layers.splice(fromIndex, 1);
    layerContainer.removeChildAt(fromIndex);

    layers.splice(toIndex, 0, layer);
    layerContainer.addChildAt(layer.container, toIndex);

    if (activeLayerIndex === fromIndex) {
      activeLayerIndex = toIndex;
    } else if (activeLayerIndex > fromIndex && activeLayerIndex <= toIndex) {
      activeLayerIndex -= 1;
    } else if (activeLayerIndex < fromIndex && activeLayerIndex >= toIndex) {
      activeLayerIndex += 1;
    }

    ensureActiveEditTargetIsValid();
    api.emit('layerMoved', { layer, fromIndex, toIndex });
    emitActiveLayerState();

    return true;
  }

  function setActiveLayer(index) {
    if (index < 0 || index >= layers.length) {
      return false;
    }

    activeLayerIndex = index;
    ensureActiveEditTargetIsValid();
    emitActiveLayerState();
    return true;
  }

  function setActiveEditTarget(target = 'content') {
    const layer = layers[activeLayerIndex] || null;
    const nextTarget = getEffectiveEditTargetForLayer(layer, target);
    const previousTarget = activeEditTarget;
    activeEditTarget = nextTarget;

    if (previousTarget === nextTarget) {
      return false;
    }

    api.emit('activeLayerEditTargetChanged', {
      layer,
      index: activeLayerIndex,
      editTarget: nextTarget,
    });
    api.emit('activeLayerChanged', {
      layer,
      index: activeLayerIndex,
      editTarget: nextTarget,
    });
    return true;
  }

  function createLayerMask(index = activeLayerIndex) {
    if (index < 0 || index >= layers.length) {
      return false;
    }

    const layer = layers[index];
    if (layer.maskRenderTexture) {
      layer.maskEnabled = true;
      syncLayerMaskBinding(layer);
      api.emit('layerUpdated', {
        layer,
        index,
        properties: { hasMask: true, maskEnabled: true },
      });
      if (index === activeLayerIndex) {
        ensureActiveEditTargetIsValid();
        emitActiveLayerState();
      }
      return true;
    }

    layer.maskRenderTexture = createMaskRenderTexture(1);
    layer.maskEnabled = true;
    syncLayerMaskBinding(layer);

    api.emit('layerUpdated', {
      layer,
      index,
      properties: { hasMask: true, maskEnabled: true },
    });

    if (index === activeLayerIndex) {
      ensureActiveEditTargetIsValid();
      emitActiveLayerState();
    }

    return true;
  }

  function removeLayerMask(index = activeLayerIndex) {
    if (index < 0 || index >= layers.length) {
      return false;
    }

    const layer = layers[index];
    if (!layer.maskRenderTexture) {
      return false;
    }

    destroyLayerMask(layer);

    if (index === activeLayerIndex) {
      activeEditTarget = 'content';
    }

    api.emit('layerUpdated', {
      layer,
      index,
      properties: { hasMask: false, maskEnabled: false },
    });

    if (index === activeLayerIndex) {
      emitActiveLayerState();
    }

    return true;
  }

  function setLayerMaskEnabled(index = activeLayerIndex, enabled = true) {
    if (index < 0 || index >= layers.length) {
      return false;
    }

    const layer = layers[index];
    if (!layer.maskRenderTexture) {
      return false;
    }

    layer.maskEnabled = enabled !== false;
    syncLayerMaskBinding(layer);

    api.emit('layerUpdated', {
      layer,
      index,
      properties: { maskEnabled: layer.maskEnabled },
    });

    if (index === activeLayerIndex) {
      ensureActiveEditTargetIsValid();
      emitActiveLayerState();
    }

    return true;
  }

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
    }

    if (properties.visible !== undefined) {
      layer.visible = properties.visible;
    }

    if (properties.locked !== undefined) {
      layer.locked = properties.locked;
    }

    if (properties.type !== undefined) {
      layer.type = properties.type || 'paint';
    }

    if (properties.textData !== undefined) {
      layer.textData = cloneTextData(properties.textData);
    }

    if (properties.blendMode !== undefined) {
      layer.blendMode = properties.blendMode;
    }

    if (properties.hasMask === true && !layer.maskRenderTexture) {
      layer.maskRenderTexture = createMaskRenderTexture(1);
    } else if (properties.hasMask === false && layer.maskRenderTexture) {
      destroyLayerMask(layer);
    }

    if (properties.maskEnabled !== undefined && layer.maskRenderTexture) {
      layer.maskEnabled = properties.maskEnabled === true;
    }

    applyLayerDisplayState(layer);

    if (index === activeLayerIndex) {
      ensureActiveEditTargetIsValid();
    }

    api.emit('layerUpdated', { layer, index, properties });

    if (index === activeLayerIndex && (properties.hasMask !== undefined || properties.maskEnabled !== undefined)) {
      emitActiveLayerState();
    }

    return true;
  }

  function getLayer(index) {
    return layers[index];
  }

  function getLayerIndexById(id) {
    return layers.findIndex((layer) => layer.id === id);
  }

  function getLayerById(id) {
    const index = getLayerIndexById(id);
    return index >= 0 ? layers[index] : null;
  }

  function getLayerIndexByRenderTexture(renderTexture) {
    return getLayerRenderTargetInfo(renderTexture)?.index ?? -1;
  }

  function isBaseLayer(index) {
    return index === 0;
  }

  function isLayerEditable(index) {
    const layer = layers[index];
    return !!layer && layer.locked !== true;
  }

  function canEditRenderTexture(renderTexture) {
    if (!renderTexture) {
      return false;
    }

    const info = getLayerRenderTargetInfo(renderTexture);
    if (!info) {
      return true;
    }

    return isLayerEditable(info.index);
  }

  function getActiveLayer() {
    return layers[activeLayerIndex];
  }

  function getActiveRenderTexture() {
    return getLayerRenderTexture(getActiveLayer(), activeEditTarget);
  }

  function getActiveEditableRenderTexture() {
    return isLayerEditable(activeLayerIndex)
      ? getLayerRenderTexture(getActiveLayer(), activeEditTarget)
      : null;
  }

  function getActiveContentRenderTexture() {
    return getLayerRenderTexture(getActiveLayer(), 'content');
  }

  function getActiveMaskRenderTexture() {
    return getLayerRenderTexture(getActiveLayer(), 'mask');
  }

  const eventListeners = {};

  function emit(eventName, data) {
    const listeners = eventListeners[eventName] || [];
    listeners.forEach((callback) => {
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
    if (!eventListeners[eventName]) {
      return;
    }
    const index = eventListeners[eventName].indexOf(callback);
    if (index > -1) {
      eventListeners[eventName].splice(index, 1);
    }
  }

  const api = {
    addLayer,
    removeLayer,
    duplicateLayer,
    clearAllLayers,
    moveLayer,
    setActiveLayer,
    setActiveEditTarget,
    updateLayer,
    createLayerMask,
    removeLayerMask,
    setLayerMaskEnabled,

    getLayers: () => [...layers],
    getLayer,
    getLayerById,
    getLayerIndexById,
    getLayerIndexByRenderTexture,
    getLayerRenderTargetInfo,
    getActiveLayer,
    getActiveLayerIndex: () => activeLayerIndex,
    getActiveEditTarget: () => getEffectiveEditTargetForLayer(getActiveLayer(), activeEditTarget),
    isEditingMask: () => getEffectiveEditTargetForLayer(getActiveLayer(), activeEditTarget) === 'mask',
    getLayerContainer: () => layerContainer,
    isBaseLayer,
    canRemoveLayer,
    isLayerEditable,
    canEditRenderTexture,

    getActiveRenderTexture,
    getActiveEditableRenderTexture,
    getActiveContentRenderTexture,
    getActiveMaskRenderTexture,

    on,
    off,
    emit,

    resize(newWidth, newHeight) {
      const dx = Math.floor((newWidth - width) / 2);
      const dy = Math.floor((newHeight - height) / 2);

      layers.forEach((layer) => {
        const oldTexture = layer.renderTexture;
        const newRT = PIXI.RenderTexture.create({
          width: newWidth,
          height: newHeight,
          resolution: 1,
        });
        clearRenderTexture(newRT, 0x000000, 0);

        if (oldTexture.width > 0 && oldTexture.height > 0) {
          const tempSprite = new PIXI.Sprite(oldTexture);
          tempSprite.position.set(dx, dy);
          app.renderer.render(tempSprite, { renderTexture: newRT, clear: false });
          tempSprite.destroy();
        }

        layer.renderTexture = newRT;
        layer.sprite.texture = newRT;
        oldTexture.destroy(true);

        if (layer.maskRenderTexture) {
          const oldMaskTexture = layer.maskRenderTexture;
          const newMaskRT = PIXI.RenderTexture.create({
            width: newWidth,
            height: newHeight,
            resolution: 1,
          });
          clearRenderTexture(newMaskRT, 0xffffff, 1);

          if (oldMaskTexture.width > 0 && oldMaskTexture.height > 0) {
            const tempMaskSprite = new PIXI.Sprite(oldMaskTexture);
            tempMaskSprite.position.set(dx, dy);
            app.renderer.render(tempMaskSprite, { renderTexture: newMaskRT, clear: false });
            tempMaskSprite.destroy();
          }

          layer.maskRenderTexture = newMaskRT;
          syncLayerMaskBinding(layer);
          oldMaskTexture.destroy(true);
        }

        if (layer.type === 'text' && layer.textData) {
          layer.textData = {
            ...layer.textData,
            x: Math.round((layer.textData.x || 0) + dx),
            y: Math.round((layer.textData.y || 0) + dy),
          };
        }
      });

      width = newWidth;
      height = newHeight;

      api.emit('layersResized', { width, height });
    },

    getCompositeCanvas() {
      try {
        const extracted = app.renderer.extract.canvas(layerContainer);
        if (extracted.width === width && extracted.height === height) {
          return extracted;
        }

        const normalized = document.createElement('canvas');
        normalized.width = width;
        normalized.height = height;
        const ctx = normalized.getContext('2d');
        ctx.drawImage(extracted, 0, 0, width, height);
        return normalized;
      } catch (error) {
        console.error('Failed to extract composite canvas:', error);
        const fallback = document.createElement('canvas');
        fallback.width = width;
        fallback.height = height;
        return fallback;
      }
    },
  };

  addLayer({ name: 'Background', opacity: 1, fillColor: 0xffffff });

  return api;
}
