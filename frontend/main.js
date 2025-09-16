/**
 * Comfy Canvas - Main Controller (Comfy bridge edition)
 * Sends editor PNG + prompt/negative/strength/seed to the bridge.
 */
import { createEditor } from './editor.js';
import { createOutput } from './output.js';
import { createLayersManager } from './layers.js';
import * as PIXI from 'https://unpkg.com/pixi.js@7.4.0/dist/pixi.min.mjs';

// ========== INIT ==========
const editor = createEditor('#leftPane', { width: 1024, height: 1024 });
const output = createOutput('#rightPane', { width: 1024, height: 1024 });

// Layers manager
let layersManager = createLayersManager(editor.getApp(), 1024, 1024);
editor.setLayersManager(layersManager);
initializeLayersUI();

// Refresh thumbnails after drawings
editor.setOnDrawingComplete(() => setTimeout(refreshLayerThumbnails, 50));

// ========== UNDO/REDO ==========
class UndoRedoManager {
  constructor(maxHistorySize = 50) {
    this.history = [];
    this.currentIndex = -1;
    this.maxHistorySize = maxHistorySize;
    this.isRestoring = false;
  }
  captureSnapshot(description = 'Action') {
    if (this.isRestoring) return;
    try {
      const layers = layersManager.getLayers();
      const activeIndex = layersManager.getActiveLayerIndex();
      const data = {
        type: 'layers',
        activeLayerIndex: activeIndex,
        canvasSize: { width: 1024, height: 1024 },
        layers: layers.map(layer => {
          const canvas = editor.getApp().renderer.extract.canvas(layer.renderTexture);
          return { name: layer.name, opacity: layer.opacity, visible: layer.visible, blendMode: layer.blendMode, canvas };
        })
      };
      if (this.currentIndex < this.history.length - 1) {
        this.history = this.history.slice(0, this.currentIndex + 1);
      }
      this.history.push({ timestamp: Date.now(), description, data });
      this.currentIndex = this.history.length - 1;
      if (this.history.length > this.maxHistorySize) {
        this.history.shift(); this.currentIndex--;
      }
      this.updateUndoRedoButtons();
    } catch (err) { console.error('Failed to capture snapshot:', err); }
  }
  restoreSnapshot(snapshot) {
    if (!snapshot) return false;
    this.isRestoring = true;
    try {
      if (snapshot.data.type === 'layers') {
        const { layers: arr, activeLayerIndex } = snapshot.data;
        layersManager.clearAllLayers();
        arr.forEach((ld, idx) => {
          const isBg = idx === 0 && ld.name === 'Background';
          const layer = layersManager.addLayer({ name: ld.name, opacity: ld.opacity, visible: ld.visible, blendMode: ld.blendMode, fillColor: isBg ? 0xffffff : null });
          const canvas = ld.canvas; if (!canvas) return;
          const tex = PIXI.Texture.from(canvas); const spr = new PIXI.Sprite(tex);
          const rt = layer.renderTexture;
          const g = new PIXI.Graphics(); g.beginFill(isBg ? 0xffffff : 0x000000, isBg ? 1 : 0).drawRect(0,0,rt.width,rt.height).endFill();
          editor.getApp().renderer.render(g, { renderTexture: rt, clear: true }); g.destroy();
          const sx = rt.width / canvas.width, sy = rt.height / canvas.height;
          if (sx !== 1 || sy !== 1) spr.scale.set(sx, sy);
          editor.getApp().renderer.render(spr, { renderTexture: rt, clear: false });
          spr.destroy(); tex.destroy();
        });
        layersManager.setActiveLayer(Math.min(activeLayerIndex, arr.length - 1));
      }
      this.updateUndoRedoButtons(); return true;
    } catch (err) { console.error('Failed to restore snapshot:', err); return false; }
    finally { this.isRestoring = false; }
  }
  undo(){ if (this.canUndo()) { this.currentIndex--; this.restoreSnapshot(this.history[this.currentIndex]); } }
  redo(){ if (this.canRedo()) { this.currentIndex++; this.restoreSnapshot(this.history[this.currentIndex]); } }
  canUndo(){ return this.currentIndex > 0; }
  canRedo(){ return this.currentIndex < this.history.length - 1; }
  updateUndoRedoButtons(){
    const u=document.getElementById('undoBtn'), r=document.getElementById('redoBtn');
    if (u) u.disabled=!this.canUndo(); if (r) r.disabled=!this.canRedo();
  }
  clear(){ this.history=[]; this.currentIndex=-1; this.updateUndoRedoButtons(); }
}
const undoRedoManager = new UndoRedoManager();
setTimeout(()=>undoRedoManager.captureSnapshot('Initial state'),100);
document.getElementById('undoBtn').addEventListener('click',()=>undoRedoManager.undo());
document.getElementById('redoBtn').addEventListener('click',()=>undoRedoManager.redo());
window.undoRedoManager = undoRedoManager;

// ========== COLOR / UPLOAD ==========
document.getElementById('topbarColor').addEventListener('input', (e) => {
  toolSettings.brush.color = e.target.value;
  editor.setBrush({ colorHex: e.target.value });
});
document.getElementById('uploadBtn').addEventListener('click', () => document.getElementById('uploadInput').click());
document.getElementById('uploadInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file && file.type.startsWith('image/')) handleImageUpload(file);
  e.target.value = '';
});
document.getElementById('copyOutputBtn').addEventListener('click', () => {
  try {
    const canvas = output.getSnapshotCanvas?.();
    if (!canvas) { alert('No output available to copy.'); return; }
    const newLayer = layersManager.addLayer({ name: `Output ${new Date().toLocaleTimeString()}` });
    const app = editor.getApp();
    const tex = PIXI.Texture.from(canvas);
    const spr = new PIXI.Sprite(tex);
    // Scale to layer size if necessary
    const rt = newLayer.renderTexture;
    const sx = rt.width / canvas.width;
    const sy = rt.height / canvas.height;
    if (sx !== 1 || sy !== 1) spr.scale.set(sx, sy);
    app.renderer.render(spr, { renderTexture: rt, clear: true });
    spr.destroy(); tex.destroy(true);
    updateLayersUI();
    setTimeout(() => window.undoRedoManager?.captureSnapshot('Copy output to new layer'), 10);
  } catch (err) {
    console.error('Failed to copy output to layer:', err);
    alert('Failed to copy output to layer.');
  }
});
const editorPane = document.getElementById('leftPane');
editorPane.addEventListener('dragover', (e)=>{e.preventDefault(); e.dataTransfer.dropEffect='copy'; editorPane.style.opacity='0.7';});
editorPane.addEventListener('dragleave', (e)=>{ if(!editorPane.contains(e.relatedTarget)) editorPane.style.opacity='1';});
editorPane.addEventListener('drop', (e)=>{
  e.preventDefault(); editorPane.style.opacity='1';
  const files = Array.from(e.dataTransfer.files);
  const imageFile = files.find(f => f.type.startsWith('image/')); if (imageFile) handleImageUpload(imageFile);
});
function handleImageUpload(file){
  const reader=new FileReader();
  reader.onload=(e)=>{
    const img=new Image();
    img.onload=()=>{
      try{
        const fileName=file.name.replace(/\.[^/.]+$/, '');
        const imageLayer=layersManager.addLayer({ name:fileName||'Uploaded Image', opacity:1, visible:true, blendMode:'normal' });
        const canvas=document.createElement('canvas'); const ctx=canvas.getContext('2d');
        const W=editor.getSize().width, H=editor.getSize().height;
        let dw=img.width, dh=img.height;
        if (dw>W || dh>H){ const s=Math.min(W/dw,H/dh); dw*=s; dh*=s;}
        canvas.width=dw; canvas.height=dh; ctx.drawImage(img,0,0,dw,dh);
        const tex=PIXI.Texture.from(canvas); const spr=new PIXI.Sprite(tex);
        const cx=(W-dw)/2, cy=(H-dh)/2; spr.position.set(cx,cy);
        const rt=imageLayer.renderTexture;
        editor.getApp().renderer.render(spr,{renderTexture:rt,clear:false});
        spr.destroy(); tex.destroy(); updateLayersUI(); setActiveTool('move');
        editor.setSelection({x:cx,y:cy,width:dw,height:dh});
        setTimeout(()=>window.undoRedoManager?.captureSnapshot(`Upload image: ${fileName}`),10);
      }catch(err){ console.error('Upload failed:',err); alert('Failed to upload image.');}
    };
    img.onerror=()=>{ console.error('Failed to load image file'); alert('Failed to load image file.'); };
    img.src=e.target.result;
  };
  reader.onerror=()=>{ console.error('Failed to read image file'); alert('Failed to read image file.'); };
  reader.readAsDataURL(file);
}

// ========== TOOLS ==========
const toolbar = document.getElementById('floatingToolbar');
const settings = document.getElementById('toolSettings');
let currentTool = 'brush';
let toolSettings = { brush:{ color:'#55cdfc', size:8, feather:0 }, eraser:{ size:8, feather:0 } };
const toolButtons = [...toolbar.querySelectorAll('.tool-btn')];
toolButtons.forEach(btn => btn.addEventListener('click', ()=> setActiveTool(btn.dataset.tool)));

function setActiveTool(tool){
  const wasOpen = !settings.classList.contains('collapsed');
  if (currentTool===tool && wasOpen){ toggleSettings(); return; }
  currentTool = tool;
  toolButtons.forEach(btn=>btn.classList.toggle('is-active', btn.dataset.tool===tool));
  editor.setTool(tool);
  if (tool==='brush') editor.setBrush({ colorHex: toolSettings.brush.color, size: toolSettings.brush.size, feather: toolSettings.brush.feather });
  else if (tool==='eraser') editor.setEraser({ size: toolSettings.eraser.size, feather: toolSettings.eraser.feather });
  buildSettingsFor(tool, true);
  const drawingTools=['brush','eraser','dropper','paint-bucket']; if (drawingTools.includes(tool)) editor.clearSelection();
}

// Allow editor to request a tool switch (e.g., after lasso finalize)
window.addEventListener('ld_request_tool', (ev) => {
  try {
    const t = ev?.detail?.tool;
    if (t) setActiveTool(t);
  } catch {}
});

function buildSettingsFor(tool, open=false){
  settings.innerHTML=''; const wrap=document.createElement('div'); wrap.className='inner';
  if (tool==='brush'){
    wrap.innerHTML=`
      <label>Brush <input type="range" id="brush" min="1" max="128" value="${toolSettings.brush.size}"> <span id="bsize">${toolSettings.brush.size}</span> px</label>
      <label>Feather <input type="range" id="brushFeather" min="0" max="50" value="${toolSettings.brush.feather}"> <span id="bfeather">${toolSettings.brush.feather}</span>%</label>`;
  } else if (tool==='eraser'){
    wrap.innerHTML=`
      <label>Eraser <input type="range" id="eraser" min="1" max="128" value="${toolSettings.eraser.size}"> <span id="esize">${toolSettings.eraser.size}</span> px</label>
      <label>Feather <input type="range" id="eraserFeather" min="0" max="50" value="${toolSettings.eraser.feather}"> <span id="efeather">${toolSettings.eraser.feather}</span>%</label>`;
  } else if (tool==='move'){
    wrap.innerHTML=`<div><strong>Move Tool:</strong></div><div>• Drag to move selection</div><div>• Right/Middle drag to pan • Wheel to zoom</div>`;
  } else if (tool==='marquee'){
    wrap.innerHTML=`<div><strong>Marquee Selection:</strong></div><div>• Drag to select</div>`;
  } else if (tool==='dropper'){ wrap.innerHTML=`<div>Click a pixel to pick its color.</div>`; }
  else if (tool==='paint-bucket'){ wrap.innerHTML=`<div>Click to fill contiguous region.</div>`; }
  if (tool==='lasso'){
    wrap.innerHTML=`<div><strong>Lasso Selection:</strong></div><div>Click-drag to draw a freeform selection. Press Enter to close. Esc to cancel.</div>`;
  }
  settings.appendChild(wrap); if (open) settings.classList.remove('collapsed'); setupSettingsEventHandlers(wrap);
}
function setupSettingsEventHandlers(wrap){
  const brushEl=wrap.querySelector('#brush'), bsize=wrap.querySelector('#bsize');
  const bfe=wrap.querySelector('#brushFeather'), bfeLbl=wrap.querySelector('#bfeather');
  const er=wrap.querySelector('#eraser'), esize=wrap.querySelector('#esize');
  const efe=wrap.querySelector('#eraserFeather'), efeLbl=wrap.querySelector('#efeather');
  if (brushEl) brushEl.addEventListener('input',()=>{ const v=+brushEl.value; toolSettings.brush.size=v; bsize.textContent=v; editor.setBrush({ size:v }); });
  if (bfe) bfe.addEventListener('input',()=>{ const v=+bfe.value; toolSettings.brush.feather=v; bfeLbl.textContent=v; editor.setBrush({ feather:v }); });
  if (er) er.addEventListener('input',()=>{ const v=+er.value; toolSettings.eraser.size=v; esize.textContent=v; editor.setEraser({ size:v }); });
  if (efe) efe.addEventListener('input',()=>{ const v=+efe.value; toolSettings.eraser.feather=v; efeLbl.textContent=v; editor.setEraser({ feather:v }); });
}
function toggleSettings(){ settings.classList.toggle('collapsed'); }

// Initial tool
buildSettingsFor('brush', true);
editor.setBrush({ colorHex: toolSettings.brush.color, size: toolSettings.brush.size, feather: toolSettings.brush.feather });

// View controls
document.getElementById('fitBothBtn').addEventListener('click',()=>{ editor.fitAndCenter(); output.fitAndCenter(); });
document.getElementById('fitEditorBtn').addEventListener('click',()=>editor.fitAndCenter());
document.getElementById('fitOutputBtn').addEventListener('click',()=>output.fitAndCenter());
document.getElementById('swapBtn').addEventListener('click', swapPanes);
document.getElementById('downloadBtn').addEventListener('click', ()=>{
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  const ok = output.downloadPNG(`comfy_canvas_output_${ts}.png`);
  if (!ok) alert('No output available to download yet.');
});
function swapPanes(){
  const panes=document.querySelector('.panes'), left=document.getElementById('leftPane'), right=document.getElementById('rightPane'), divider=document.querySelector('.divider');
  if (left.nextElementSibling===divider){ panes.insertBefore(right,left); panes.insertBefore(divider,left); }
  else { panes.insertBefore(left,right); panes.insertBefore(divider,right); }
}

// ---------- Promptbar Options: Canvas size + Resize ----------
// Controls live in the prompt bar options panel (index.html)
(function setupCanvasResizeControls(){
  const optionsBtn = document.getElementById('options');
  const optionsPanel = document.getElementById('options-panel');
  const cwInput = document.getElementById('cw');
  const chInput = document.getElementById('ch');
  const resizeBtn = document.getElementById('resize');
  const strengthRange = document.getElementById('strength');
  const strengthNumber = document.getElementById('strengthNumber');
  const negativeEl = document.getElementById('negative');
  const seedEl = document.getElementById('seed');

  // Initialize inputs with current editor size
  try {
    const { width, height } = editor.getSize();
    if (cwInput) cwInput.value = String(width);
    if (chInput) chInput.value = String(height);
    // Initialize strength from localStorage or default 1.00
    const savedStrength = (() => { try { return localStorage.getItem('ld_strength'); } catch { return null; } })();
    const sVal = Math.max(0, Math.min(1, parseFloat(savedStrength ?? '1') || 1));
    if (strengthRange) strengthRange.value = String(sVal);
    if (strengthNumber) strengthNumber.value = String(sVal.toFixed(2));
    // Initialize negative and seed from localStorage
    try {
      const savedNeg = localStorage.getItem('ld_negative') ?? '';
      if (negativeEl) negativeEl.value = savedNeg;
    } catch {}
    try {
      const savedSeed = localStorage.getItem('ld_seed');
      if (seedEl && savedSeed !== null) seedEl.value = savedSeed;
    } catch {}
  } catch {}

  // Toggle options panel visibility
  if (optionsBtn && optionsPanel) {
    optionsBtn.addEventListener('click', () => {
      const isHidden = optionsPanel.hasAttribute('hidden');
      if (isHidden) {
        optionsPanel.removeAttribute('hidden');
        optionsBtn.setAttribute('aria-expanded', 'true');
      } else {
        optionsPanel.setAttribute('hidden', '');
        optionsBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function clampInt(v, min, max, fallback){
    const n = parseInt(String(v||''), 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  async function performResize(){
    if (!cwInput || !chInput) return;
    const min = 64, max = 4096;
    const current = editor.getSize();
    const newW = clampInt(cwInput.value, min, max, current.width);
    const newH = clampInt(chInput.value, min, max, current.height);
    if (newW === current.width && newH === current.height) return;

    try {
      // Clear any active selection to avoid odd transforms across resize
      if (typeof editor.clearSelection === 'function') editor.clearSelection();
      // Resize ONLY the editor artboard; output artboard resizes to incoming image size automatically
      editor.resizeArtboard(newW, newH);
      editor.fitAndCenter();
      output.fitAndCenter();
      // Normalize UI values to what the editor actually set
      const sz = editor.getSize();
      cwInput.value = String(sz.width);
      chInput.value = String(sz.height);
      // Capture undo snapshot label if available
      try { window.undoRedoManager?.captureSnapshot('Resize canvas'); } catch {}
      // Refresh thumbnails after resize
      try { setTimeout(refreshLayerThumbnails, 20); } catch {}
    } catch (e) {
      console.error('Canvas resize failed:', e);
      alert('Failed to resize canvas.');
    }
  }

  // Button click
  if (resizeBtn) resizeBtn.addEventListener('click', performResize);

  // Enter key in either input triggers resize
  function onKey(e){ if (e.key === 'Enter') { e.preventDefault(); performResize(); } }
  if (cwInput) cwInput.addEventListener('keydown', onKey);
  if (chInput) chInput.addEventListener('keydown', onKey);

  // Strength linking + persistence
  function clamp01(v){ const n = parseFloat(String(v||'')); return (Number.isNaN(n) ? 1 : Math.max(0, Math.min(1, n))); }
  function syncStrengthFromRange(){
    if (!strengthRange || !strengthNumber) return;
    const v = clamp01(strengthRange.value);
    strengthNumber.value = v.toFixed(2);
    try { localStorage.setItem('ld_strength', String(v)); } catch {}
  }
  function syncStrengthFromNumber(){
    if (!strengthRange || !strengthNumber) return;
    const v = clamp01(strengthNumber.value);
    strengthNumber.value = v.toFixed(2);
    strengthRange.value = String(v);
    try { localStorage.setItem('ld_strength', String(v)); } catch {}
  }
  strengthRange?.addEventListener('input', syncStrengthFromRange);
  strengthRange?.addEventListener('change', syncStrengthFromRange);
  strengthNumber?.addEventListener('input', syncStrengthFromNumber);
  strengthNumber?.addEventListener('change', syncStrengthFromNumber);
  // Persist negative and seed
  negativeEl?.addEventListener('input', () => { try { localStorage.setItem('ld_negative', negativeEl.value ?? ''); } catch {} });
  seedEl?.addEventListener('input', () => {
    try {
      let v = parseInt(seedEl.value || '0', 10);
      if (Number.isNaN(v) || v < 0) v = 0;
      const max = 999999999999999; if (v > max) v = max;
      seedEl.value = String(v);
      localStorage.setItem('ld_seed', String(v));
    } catch {}
  });
})();

// ---------- Minimal Loading Bar (pink) ----------
let _ldProgressTimer = null;
let _ldProgressActive = false;
let _ldProgressValue = 0; // 0..100
function _ldGetBar(){ return document.querySelector('#ld-progress .bar'); }
function ldProgressStart(){
  const bar = _ldGetBar(); if (!bar) return;
  _ldProgressActive = true; _ldProgressValue = 0;
  const wrap = bar.parentElement; if (wrap) wrap.style.opacity = '1';
  bar.style.transition = 'none'; bar.style.width = '0%';
  requestAnimationFrame(()=>{ bar.style.transition = 'width 200ms ease'; });
  if (_ldProgressTimer) clearInterval(_ldProgressTimer);
  _ldProgressTimer = setInterval(()=>{
    if (!_ldProgressActive) return;
    const target = 90; // stall near the end
    const step = Math.max(0.5, (target - _ldProgressValue) * 0.06);
    _ldProgressValue = Math.min(target, _ldProgressValue + step);
    const b = _ldGetBar(); if (b) b.style.width = `${_ldProgressValue}%`;
  }, 220);
}
function ldProgressDone(){
  const bar = _ldGetBar(); if (!bar) return;
  _ldProgressActive = false; _ldProgressValue = 100;
  if (_ldProgressTimer) clearInterval(_ldProgressTimer);
  bar.style.width = '100%';
  setTimeout(()=>{ if (bar.parentElement) bar.parentElement.style.opacity = '0'; bar.style.width = '0%'; }, 350);
}
function ldProgressFail(){
  const bar = _ldGetBar(); if (!bar) return;
  _ldProgressActive = false;
  if (_ldProgressTimer) clearInterval(_ldProgressTimer);
  bar.style.width = `${Math.max(20, _ldProgressValue)}%`;
  setTimeout(()=>{ if (bar.parentElement) bar.parentElement.style.opacity = '0'; bar.style.width = '0%'; }, 200);
}

// ---------- Bridge wiring ----------
  // Since this SPA is served by the bridge, same-origin is safe here
  const BRIDGE = location.origin;
  // Optional: preload auto-trigger payload from localStorage
  try {
    const stored = localStorage.getItem('ld_trigger_payload');
    if (stored) window.currentComfyPrompt = JSON.parse(stored);
  } catch (e) { /* ignore */ }
const genBtn = document.getElementById('generate');
const promptEl = document.getElementById('prompt');

// Helper to toggle generate icon to a spinner and back
function setGenerateLoadingState(isLoading) {
  try {
    const btn = document.getElementById('generate');
    if (!btn) return;
    const svg = btn.querySelector('svg.icon');
    const use = svg?.querySelector('use');
    if (!use) return;
    if (isLoading) {
      // store original icon href once
      const currentHref = use.getAttribute('href') || use.getAttribute('xlink:href') || '#sparkles';
      if (!btn.dataset.iconOriginal) btn.dataset.iconOriginal = currentHref;
      use.setAttribute('href', '#loading');
      try { use.setAttribute('xlink:href', '#loading'); } catch {}
      btn.classList.add('is-loading');
    } else {
      const original = btn.dataset.iconOriginal || '#sparkles';
      use.setAttribute('href', original);
      try { use.setAttribute('xlink:href', original); } catch {}
      btn.classList.remove('is-loading');
    }
  } catch (e) { /* noop */ }
}

async function getEditorPNGBlob() {
  // snapshotCanvas already returns an HTMLCanvasElement representing the composite
  const canvas = editor.snapshotCanvas();
  // Prefer toBlob when available
  const blob = await new Promise(resolve => {
    try {
      canvas.toBlob(b => resolve(b || null), 'image/png');
    } catch {
      resolve(null);
    }
  });
  if (blob) return blob;
  // Fallback via dataURL if toBlob returns null
  try {
    const dataUrl = canvas.toDataURL('image/png');
    const res = await fetch(dataUrl);
    return await res.blob();
  } catch (e) {
    console.error('Failed to create PNG blob from canvas:', e);
    throw e;
  }
}
async function dbg(type, payload={}) {
  try {
    await fetch(`${BRIDGE}/debug/event`, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ type, ...payload }) });
  } catch {}
}

async function pushInput() {
  const blob = await getEditorPNGBlob();
  const prompt = (promptEl?.value || "").trim();
  const negative = (document.getElementById('negative')?.value || "").trim();
  const seedRaw = (document.getElementById('seed')?.value || '').trim();
  let seed = parseInt(seedRaw || '0', 10);
  if (Number.isNaN(seed) || seed < 0) seed = 0; if (seed > 999999999999999) seed = 999999999999999;
  const strengthEl = document.getElementById('strength');
  const strengthVal = Math.max(0, Math.min(1, parseFloat(strengthEl?.value ?? '1') || 1));
  const fd = new FormData();
  if (blob) fd.append('file', blob, 'canvas.png');
  fd.append('prompt', prompt);
  fd.append('negative', negative);
  fd.append('seed', String(seed));
  fd.append('strength', String(strengthVal));
  const r = await fetch(`${BRIDGE}/push/input`, { method: 'POST', body: fd });
  try { await dbg('frontend_push_input', { ok: !!r?.ok, prompt_len: (prompt||'').length, negative_len: (negative||'').length, strength: strengthVal, seed }); } catch {}
  return r && r.ok;
}
async function triggerComfy() {
  // Optional: set window.currentComfyPrompt externally to call Comfy /prompt
  const payload = window.currentComfyPrompt;
  if (!payload) return; // You can trigger manually in Comfy if you prefer
  await fetch(`${BRIDGE}/trigger`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ prompt: payload }) });
}
document.getElementById("generate")?.addEventListener("click", async () => {
  // Close options panel if open
  try {
    const optionsPanel = document.getElementById('options-panel');
    const optionsBtn = document.getElementById('options');
    if (optionsPanel && !optionsPanel.hasAttribute('hidden')) {
      optionsPanel.setAttribute('hidden', '');
      optionsBtn?.setAttribute('aria-expanded', 'false');
    }
  } catch {}

  ldProgressStart();
  setGenerateLoadingState(true);
  genBtn.disabled = true;
  try {
    try { await dbg('frontend_generate_clicked'); } catch {}
    const ok = await pushInput(); // sends PNG + prompt to bridge
    if (!ok) {
      alert('Failed to send input to bridge.');
      ldProgressFail();
      setGenerateLoadingState(false);
      return;
    }
    try { await triggerComfy(); } catch (_) { /* optional */ }
  } catch (e) {
    console.error("Generate (bridge) failed:", e);
    try { await dbg('frontend_generate_error', { error: String(e) }); } catch {}
    alert('Failed to send input. Is the bridge running?');
    ldProgressFail();
    setGenerateLoadingState(false);
  } finally {
    genBtn.disabled = false;
  }
});

// Complete the progress bar when a new output image is detected
window.addEventListener('ld_output_image_updated', () => {
  if (_ldProgressActive) ldProgressDone();
  setGenerateLoadingState(false);
});

// Helpers the layers UI expects (stubbed or already present in your codebase)
function initializeLayersUI() {
  const layersList = document.getElementById('layersList');
  const addLayerBtn = document.getElementById('addLayerBtn');
  const deleteLayerBtn = document.getElementById('deleteLayerBtn');
  const duplicateLayerBtn = document.getElementById('duplicateLayerBtn');
  const mergeDownBtn = document.getElementById('mergeDownBtn');
  const blendModeSelect = document.getElementById('blendModeSelect');
  const layersPanel = document.getElementById('layersPanel');
  const minimizedLayersBtn = document.getElementById('minimizedLayersBtn');
  const opacityRange = document.getElementById('layerOpacityRange');
  const opacityNumber = document.getElementById('layerOpacityNumber');

  // Add layer
  addLayerBtn?.addEventListener('click', () => {
    const count = layersManager.getLayers().length;
    const layer = layersManager.addLayer({ name: `Layer ${count}` });
    updateLayersUI();
    setTimeout(() => window.undoRedoManager?.captureSnapshot(`Add layer: ${layer.name}`), 10);
  });

  // Delete layer
  deleteLayerBtn?.addEventListener('click', () => {
    const activeIndex = layersManager.getActiveLayerIndex();
    if (activeIndex >= 0) {
      const layer = layersManager.getActiveLayer();
      if (layersManager.removeLayer(activeIndex)) {
        updateLayersUI();
        setTimeout(() => window.undoRedoManager?.captureSnapshot(`Delete layer: ${layer.name}`), 10);
      }
    }
  });

  // Duplicate layer
  duplicateLayerBtn?.addEventListener('click', () => {
    const activeIndex = layersManager.getActiveLayerIndex();
    if (activeIndex >= 0) {
      const originalLayer = layersManager.getActiveLayer();
      const newLayer = layersManager.addLayer({
        name: `${originalLayer.name} Copy`,
        opacity: originalLayer.opacity,
        visible: originalLayer.visible,
        blendMode: originalLayer.blendMode
      });
      // Copy content
      const app = editor.getApp();
      const spr = new PIXI.Sprite(originalLayer.renderTexture);
      app.renderer.render(spr, { renderTexture: newLayer.renderTexture, clear: true });
      spr.destroy();
      updateLayersUI();
      setTimeout(() => window.undoRedoManager?.captureSnapshot(`Duplicate layer: ${originalLayer.name}`), 10);
    }
  });

  // Merge down
  mergeDownBtn?.addEventListener('click', () => {
    const idx = layersManager.getActiveLayerIndex();
    if (idx > 0) {
      if (layersManager.mergeDown(idx)) {
        updateLayersUI();
        setTimeout(() => window.undoRedoManager?.captureSnapshot('Merge down'), 10);
      }
    }
  });

  // Blend mode change
  blendModeSelect?.addEventListener('change', () => {
    const activeIndex = layersManager.getActiveLayerIndex();
    if (activeIndex >= 0) {
      layersManager.updateLayer(activeIndex, { blendMode: blendModeSelect.value });
      setTimeout(() => window.undoRedoManager?.captureSnapshot('Change blend mode'), 10);
    }
  });

  // Opacity change
  function syncOpacityUI() {
    const active = layersManager.getActiveLayer();
    if (!opacityRange || !opacityNumber || !active) return;
    const pct = Math.round((active.opacity ?? 1) * 100);
    opacityRange.value = String(pct);
    opacityNumber.value = String(pct);
  }
  opacityRange?.addEventListener('input', () => {
    const activeIndex = layersManager.getActiveLayerIndex();
    if (activeIndex >= 0) {
      const v = Math.max(0, Math.min(100, parseInt(opacityRange.value || '100', 10) || 100));
      layersManager.updateLayer(activeIndex, { opacity: v / 100 });
      if (opacityNumber) opacityNumber.value = String(v);
    }
  });
  opacityRange?.addEventListener('change', () => setTimeout(() => window.undoRedoManager?.captureSnapshot('Change opacity'), 10));

  // Number input events
  opacityNumber?.addEventListener('input', () => {
    const activeIndex = layersManager.getActiveLayerIndex();
    if (activeIndex >= 0) {
      let v = parseInt(opacityNumber.value || '100', 10);
      if (Number.isNaN(v)) v = 0;
      v = Math.max(0, Math.min(100, v));
      layersManager.updateLayer(activeIndex, { opacity: v / 100 });
      if (opacityRange) opacityRange.value = String(v);
    }
  });
  opacityNumber?.addEventListener('change', () => setTimeout(() => window.undoRedoManager?.captureSnapshot('Change opacity'), 10));

  // Toggle layers panel visibility
  minimizedLayersBtn?.addEventListener('click', () => {
    layersPanel.classList.toggle('minimized');
    minimizedLayersBtn.classList.toggle('active');
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    const idx = layersManager.getActiveLayerIndex();
    if (e.key === 'Delete' && idx >= 0 && layersManager.getLayers().length > 1) {
      e.preventDefault();
      const name = layersManager.getActiveLayer()?.name || '';
      if (layersManager.removeLayer(idx)) {
        updateLayersUI();
        setTimeout(() => window.undoRedoManager?.captureSnapshot(`Delete layer: ${name}`), 10);
      }
    }
    // Duplicate: Ctrl+J
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j' && idx >= 0) {
      e.preventDefault();
      duplicateLayerBtn?.click();
    }
    // Merge down: Ctrl+E
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e' && idx > 0) {
      e.preventDefault();
      mergeDownBtn?.click();
    }
  });

  // Initial render
  updateLayersUI();
  syncOpacityUI();

  // Keep UI in sync on changes
  layersManager.on('activeLayerChanged', () => { updateLayersUI(); syncOpacityUI(); });
  layersManager.on('layerUpdated', () => { updateLayersUI(); syncOpacityUI(); });
}

function refreshLayerThumbnails() {
  const layers = layersManager.getLayers();
  const layersList = document.getElementById('layersList');
  const layerItems = layersList.querySelectorAll('.layer-item');
  
  layerItems.forEach((item) => {
    const li = parseInt(item.dataset.index || '-1', 10);
    if (Number.isNaN(li) || li < 0 || li >= layers.length) return;
    const thumbnail = item.querySelector('.layer-thumbnail canvas');
    if (!thumbnail) return;
    try {
      const app = editor.getApp();
      const canvas = app.renderer.extract.canvas(layers[li].renderTexture);
      thumbnail.width = 40;
      thumbnail.height = 40;
      const ctx = thumbnail.getContext('2d');
      ctx.clearRect(0, 0, 40, 40);
      ctx.drawImage(canvas, 0, 0, 40, 40);
    } catch (e) {
      console.warn('Failed to update layer thumbnail:', e);
    }
  });
}

function updateLayersUI() {
  const layers = layersManager.getLayers();
  const activeIndex = layersManager.getActiveLayerIndex();
  const layersList = document.getElementById('layersList');
  const deleteLayerBtn = document.getElementById('deleteLayerBtn');
  const duplicateLayerBtn = document.getElementById('duplicateLayerBtn');
  const mergeDownBtn = document.getElementById('mergeDownBtn');
  const blendModeSelect = document.getElementById('blendModeSelect');
  const opacityRange = document.getElementById('layerOpacityRange');
  const opacityNumber = document.getElementById('layerOpacityNumber');
  
  // Clear existing layers
  layersList.innerHTML = '';
  
  // Add layers in reverse order (topmost first)
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const isActive = i === activeIndex;
    
    const layerItem = document.createElement('div');
    layerItem.className = `layer-item${isActive ? ' active' : ''}${layer.locked ? ' locked' : ''}`;
    layerItem.dataset.index = i;

    // Build item content
    const thumb = document.createElement('div');
    thumb.className = 'layer-thumbnail';
    const tcv = document.createElement('canvas'); tcv.width = 40; tcv.height = 40; thumb.appendChild(tcv);
    const info = document.createElement('div'); info.className = 'layer-info';
    const nameInput = document.createElement('input'); nameInput.type = 'text'; nameInput.className = 'layer-name'; nameInput.value = layer.name; nameInput.readOnly = true;
    const opDiv = document.createElement('div'); opDiv.className = 'layer-opacity'; opDiv.textContent = `${Math.round(layer.opacity * 100)}%`;
    info.appendChild(nameInput); info.appendChild(opDiv);
    const ctrls = document.createElement('div'); ctrls.className = 'layer-item-controls';
    const visBtn = document.createElement('button'); visBtn.type = 'button'; visBtn.className = 'layer-visibility-btn'; visBtn.title = (layer.visible ? 'Hide' : 'Show') + ' layer';
    visBtn.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${layer.visible ? 'eye-open' : 'eye-closed'}"></use></svg>`;
    const lockBtn = document.createElement('button'); lockBtn.type = 'button'; lockBtn.className = 'layer-lock-btn'; lockBtn.title = (layer.locked ? 'Unlock' : 'Lock') + ' layer';
    lockBtn.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${layer.locked ? 'lock' : 'unlocked'}"></use></svg>`;
    ctrls.appendChild(visBtn); ctrls.appendChild(lockBtn);
    layerItem.appendChild(thumb); layerItem.appendChild(info); layerItem.appendChild(ctrls);
    
    // Add click event to select layer
    layerItem.addEventListener('click', (e) => {
      if (!e.target.closest('.layer-visibility-btn') && !e.target.closest('.layer-lock-btn') && e.target !== nameInput) {
        layersManager.setActiveLayer(i);
        updateLayersUI();
      }
    });
    
    // Visibility toggle
    visBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      layersManager.updateLayer(i, { visible: !layer.visible });
      updateLayersUI();
      setTimeout(() => window.undoRedoManager?.captureSnapshot('Toggle layer visibility'), 10);
    });

    // Lock toggle
    lockBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      layersManager.updateLayer(i, { locked: !layer.locked });
      updateLayersUI();
      setTimeout(() => window.undoRedoManager?.captureSnapshot(layer.locked ? 'Unlock layer' : 'Lock layer'), 10);
    });

    // Rename: double-click to edit, enter/blur to commit
    nameInput.addEventListener('dblclick', (ev) => { ev.stopPropagation(); nameInput.readOnly = false; nameInput.focus(); nameInput.select(); });
    nameInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); nameInput.blur(); } });
    nameInput.addEventListener('blur', () => {
      nameInput.readOnly = true;
      const newName = (nameInput.value || '').trim();
      if (newName && newName !== layer.name) {
        layersManager.updateLayer(i, { name: newName });
        setTimeout(() => window.undoRedoManager?.captureSnapshot('Rename layer'), 10);
      } else {
        nameInput.value = layer.name; // reset
      }
    });

    // Drag & drop reorder
    layerItem.draggable = true;
    layerItem.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/plain', String(i));
      layerItem.classList.add('dragging');
    });
    layerItem.addEventListener('dragover', (ev) => { ev.preventDefault(); layerItem.classList.add('drag-over'); });
    layerItem.addEventListener('dragleave', () => { layerItem.classList.remove('drag-over'); });
    layerItem.addEventListener('drop', (ev) => {
      ev.preventDefault(); layerItem.classList.remove('drag-over');
      const fromIndex = parseInt(ev.dataTransfer.getData('text/plain') || '-1', 10);
      const toIndex = i;
      if (!Number.isNaN(fromIndex) && fromIndex !== toIndex) {
        layersManager.moveLayer(fromIndex, toIndex);
        updateLayersUI();
        setTimeout(() => window.undoRedoManager?.captureSnapshot('Reorder layers'), 10);
      }
    });
    layerItem.addEventListener('dragend', () => layerItem.classList.remove('dragging'));
    
    layersList.appendChild(layerItem);
  }
  
  // Update button states
  deleteLayerBtn.disabled = layers.length <= 1;
  duplicateLayerBtn.disabled = activeIndex < 0;
  mergeDownBtn && (mergeDownBtn.disabled = !(activeIndex > 0));
  
  // Update blend mode selector
  if (activeIndex >= 0) {
    blendModeSelect.value = layers[activeIndex].blendMode;
    if (opacityRange && opacityNumber) {
      const pct = Math.round((layers[activeIndex].opacity ?? 1) * 100);
      opacityRange.value = String(pct);
      opacityNumber.value = String(pct);
    }
  }
  
  // Update thumbnails
  setTimeout(refreshLayerThumbnails, 10);
}

// Add event listener for layer events (legacy hooks kept minimal; initializeLayersUI adds synced hooks)
layersManager.on('layerAdded', updateLayersUI);
