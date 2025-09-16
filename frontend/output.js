/**
 * Comfy Canvas - Output Module (Comfy bridge edition)
 */
import * as PIXI from 'https://unpkg.com/pixi.js@7.4.0/dist/pixi.min.mjs';

export function createOutput(selector, { width = 1024, height = 1024 } = {}) {
  const host = document.querySelector(selector);
  if (!host) throw new Error(`Output host element not found: ${selector}`);
  
  // Ensure host has proper styling for canvas
  host.style.width = '100%';
  host.style.height = '100%';
  host.style.position = 'relative';

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
    // Ensure canvas fills the container
    app.view.style.width = '100%';
    app.view.style.height = '100%';
    app.view.style.display = 'block';
    // Ensure the PIXI render loop is running so the canvas displays
    try { app.ticker.start(); } catch {}
  } catch (error) {
    console.error('Failed to initialize output canvas:', error);
    throw error;
  }

  let W = width, H = height;
  let rt = PIXI.RenderTexture.create({ width: W, height: H, resolution: 1 });

  // white background
  { const g = new PIXI.Graphics(); g.beginFill(0xffffff).drawRect(0,0,W,H).endFill();
    app.renderer.render(g, { renderTexture: rt, clear: true }); g.destroy(); }

  const sprite = new PIXI.Sprite(rt);
  const border = new PIXI.Graphics().lineStyle(1, 0x333333, 1).drawRect(-0.5, -0.5, W+1, H+1);
  const viewport = new PIXI.Container();
  const board = new PIXI.Container(); board.addChild(sprite, border);
  viewport.addChild(board); app.stage.addChild(viewport);

  function fitAndCenter(){
    if (!app || !app.screen) return;
    const s=app.screen; const zoom=Math.min(s.width/W, s.height/H, 1);
    viewport.scale.set(zoom);
    viewport.position.set(Math.round((s.width - W*zoom)*0.5), Math.round((s.height - H*zoom)*0.5));
  }
  
  // Initial fit after a short delay to ensure proper sizing
  setTimeout(() => {
    try { if (app && app.ticker) app.ticker.addOnce(fitAndCenter); else fitAndCenter(); } catch {}
  }, 100);
  
  let autoFitOnResize=false;
  new ResizeObserver(()=>{ if(autoFitOnResize && app) requestAnimationFrame(fitAndCenter); }).observe(host);

  let panning=false, panStart={x:0,y:0}, viewStart={x:0,y:0};
  app.view.addEventListener('wheel', (ev)=>{
    ev.preventDefault();
    if (!app || !viewport) return;
    const oldScale=viewport.scale.x;
    const zoomFactor=ev.deltaY>0? 1/1.1 : 1.1;
    const newScale=Math.max(0.1, Math.min(8, oldScale*zoomFactor));
    const rect=app.view.getBoundingClientRect();
    const mousePos=new PIXI.Point(ev.clientX-rect.left, ev.clientY-rect.top);
    const before=viewport.toLocal(mousePos);
    viewport.scale.set(newScale);
    const after=viewport.toLocal(mousePos);
    viewport.position.set(viewport.position.x + (after.x-before.x)*newScale, viewport.position.y + (after.y-before.y)*newScale);
  }, { passive:false });

  app.stage.eventMode='static'; app.stage.hitArea=app.screen;
  app.stage.on('pointerdown',(e)=>{ panning=true; panStart.x=e.globalX; panStart.y=e.globalY; viewStart.x=viewport.position.x; viewStart.y=viewport.position.y; app.stage.cursor='grab'; });
  app.stage.on('pointermove',(e)=>{ if(!panning || !app || !viewport) return; const dx=e.globalX-panStart.x, dy=e.globalY-panStart.y; viewport.position.set(viewStart.x+dx, viewStart.y+dy); });
  function endPan(){ if(panning){ panning=false; if (app) app.stage.cursor='default'; } }
  app.stage.on('pointerup',endPan); app.stage.on('pointerupoutside',endPan);
  app.view.addEventListener('contextmenu',(e)=>e.preventDefault());

  // ---- Resize helpers ----
  function resizeArtboard(newW, newH) {
    const w = Math.max(1, Math.floor(newW || 0));
    const h = Math.max(1, Math.floor(newH || 0));
    if (w === W && h === H) return;
    const oldRT = rt;
    W = w; H = h;
    rt = PIXI.RenderTexture.create({ width: W, height: H, resolution: 1 });
    // Fill background to white
    try {
      const g = new PIXI.Graphics();
      g.beginFill(0xffffff).drawRect(0, 0, W, H).endFill();
      app.renderer.render(g, { renderTexture: rt, clear: true });
      g.destroy();
    } catch {}
    // Swap sprite texture
    sprite.texture = rt;
    // Redraw border
    try { border.clear().lineStyle(1, 0x333333, 1).drawRect(-0.5, -0.5, W + 1, H + 1); } catch {}
    // Dispose old texture
    try { oldRT?.destroy(true); } catch {}
    // Recentering
    try { fitAndCenter(); } catch {}
  }

  // ---- Comfy bridge polling ----
  let _lastOutputSig = null;
  const BRIDGE = location.origin;
  async function loadTextureFromBlob(blob){
    // Robust decode: try ImageBitmap first, then HTMLImageElement, then canvas copy
    try {
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'default', premultiplyAlpha: 'default' });
      return { img: bmp, width: bmp.width, height: bmp.height, type: 'bitmap' };
    } catch (_) {
      // Fallback to HTMLImageElement
      try {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.decoding = 'sync';
        img.src = url;
        await img.decode();
        URL.revokeObjectURL(url);
        return { img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height, type: 'image' };
      } catch (e) {
        console.warn('[ComfyCanvas] Failed to decode output image', e);
        throw e;
      }
    }
  }

  async function pollOutput(){
    while(true){
      try{
        const r = await fetch(`${BRIDGE}/get/output`, { cache:'no-store' });
        if (r.status===200 && r.headers.get('content-type')?.startsWith('image/')){
          const blob = await r.blob();
          const decoded = await loadTextureFromBlob(blob);
          // Draw through an offscreen canvas to normalize pixel data
          let srcCanvas = document.createElement('canvas');
          srcCanvas.width = decoded.width; srcCanvas.height = decoded.height;
          try {
            const ctx = srcCanvas.getContext('2d');
            ctx.drawImage(decoded.img, 0, 0);
          } catch {}
          const tex  = PIXI.Texture.from(srcCanvas);
          try {
            tex.baseTexture.wrapMode = PIXI.WRAP_MODES.CLAMP;
            tex.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
            tex.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
          } catch {}
          const spr  = new PIXI.Sprite(tex);
          // Auto-resize output artboard to match incoming image
          try { if ((decoded.width && decoded.height) && (decoded.width !== W || decoded.height !== H)) resizeArtboard(decoded.width, decoded.height); } catch {}
          if (app && app.renderer && rt) {
            app.renderer.render(spr, { renderTexture: rt, clear: true });
          }
          spr.destroy(); tex.destroy(true);
          // Emit update event if content changed (lightweight signature: size + first bytes)
          try {
            const ab = await blob.slice(0, 64).arrayBuffer();
            let hash = blob.size >>> 0;
            const view = new Uint8Array(ab);
            for (let i = 0; i < view.length; i++) hash = ((hash << 5) - hash + view[i]) >>> 0;
            const sig = hash;
            if (sig !== _lastOutputSig) {
              _lastOutputSig = sig;
              window.dispatchEvent(new CustomEvent('ld_output_image_updated', { detail: { sig, ts: Date.now() } }));
            }
          } catch (_) {}
        }
      }catch(_){}
      await new Promise(res=>setTimeout(res, 500));
    }
  }
  pollOutput();

  return {
    fitAndCenter,
    getSize(){ return { width: W, height: H }; },
    setAutoFitOnResize(v){ autoFitOnResize=!!v; },
    getApp(){ return app; },
    resizeArtboard,
    // Extract current output as a Canvas
    getSnapshotCanvas(){
      try{
        if (!app || !rt) return null;
        return app.renderer.extract.canvas(rt);
      }catch(e){ console.warn('Output snapshot failed:', e); return null; }
    },
    // Trigger a download of the current output as PNG
    downloadPNG(filename='live_diffusion_output.png'){
      try{
        const canvas = this.getSnapshotCanvas();
        if (!canvas) return false;
        const url = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return true;
      }catch(e){ console.error('Download PNG failed:', e); return false; }
    },
  };
}
