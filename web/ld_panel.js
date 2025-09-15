// ComfyUI/custom_nodes/ComfyCanvasBridge/web/ld_panel.js
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// Bridge origin: default to local bridge; allow override via localStorage
const BRIDGE = (() => {
  try {
    return (
      localStorage.getItem('cc_bridge_origin') ||
      localStorage.getItem('ld_bridge_origin') ||
      'http://127.0.0.1:8765'
    );
  } catch {
    return 'http://127.0.0.1:8765';
  }
})();

async function dbg(type, payload={}) {
  try {
    await fetch(`${BRIDGE}/debug/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...payload })
    });
  } catch {}
}

async function req(path, opts) { try { return await fetch(`${BRIDGE}${path}`, opts); } catch { return null; } }
async function status() { const r = await req("/status"); return r && r.ok ? r.json() : { ok:false }; }
async function lastInputDataURL() {
  const r = await req("/get/input", { cache:"no-store" }); if (!r || r.status !== 200) return null;
  const blob = await r.blob();
  return await new Promise(res => { const fr = new FileReader(); fr.onload=()=>res(fr.result); fr.readAsDataURL(blob); });
}

console.log('[ComfyCanvas] registering extension');
dbg('panel_register');
app.registerExtension({
  name: "ComfyCanvas.LD_Edit_UI",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "LD_Edit") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

      const statusW = this.addWidget("text", "Server", "checking..."); statusW.serialize = false;
      this.addWidget("button", "Open Frontend", null, async () => {
        const s = await status();
        statusW.value = s.ok ? `online - ${s.url}` : "offline";
        try { if (s.ok && s.url) window.open(s.url, '_blank'); } catch {}
        this.setDirtyCanvas(true, true);
      });
      this.addWidget("button", "Refresh", null, async () => {
        const s = await status();
        statusW.value = s.ok ? `online - ${s.url}` : "offline";
        this.setDirtyCanvas(true, true);
      });

      const imgW = this.addWidget("image", "Last Input", null); imgW.serialize = false;

      console.log('[ComfyCanvas] LD_Edit panel init'); dbg('panel_init');
      // Push current graph payload to bridge so it can autorun without this tab being active
      async function pushPromptPayloadOnce() {
        try {
          if (typeof app?.graphToPrompt !== 'function') return;
          const prompt = app.graphToPrompt();
          if (!prompt) return;
          const client_id = (app && app.clientId) || (api && api.clientId) || undefined;
          await fetch(`${BRIDGE}/store/trigger`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(client_id ? { prompt: { prompt, client_id } } : { prompt: { prompt } })
          });
          await dbg('stored_trigger_payload', { nodes: Object.keys(prompt || {}).length });
        } catch (e) { await dbg('store_trigger_fail', { error: String(e) }); }
      }
      pushPromptPayloadOnce();
      // Periodically refresh stored payload (in case graph changes)
      let _ccPayloadInt = setInterval(pushPromptPayloadOnce, 5000);
      // Try very hard to queue the current graph in ComfyUI
      async function queueCurrentGraph() {
        // 1) Use built-ins if present
        try { if (typeof app?.queueGraph === 'function') { await dbg('queue_attempt',{method:'app.queueGraph'}); await app.queueGraph(); await dbg('queue_done',{method:'app.queueGraph'}); return true; } } catch (e) { await dbg('queue_fail',{method:'app.queueGraph', error: String(e)}); }
        try { if (typeof app?.queuePrompt === 'function') { await dbg('queue_attempt',{method:'app.queuePrompt'}); await app.queuePrompt(); await dbg('queue_done',{method:'app.queuePrompt'}); return true; } } catch (e) { await dbg('queue_fail',{method:'app.queuePrompt', error: String(e)}); }
        try { if (typeof app?.ui?.queueGraph === 'function') { await dbg('queue_attempt',{method:'app.ui.queueGraph'}); await app.ui.queueGraph(); await dbg('queue_done',{method:'app.ui.queueGraph'}); return true; } } catch (e) { await dbg('queue_fail',{method:'app.ui.queueGraph', error: String(e)}); }
        try { if (typeof app?.ui?.queuePrompt === 'function') { await dbg('queue_attempt',{method:'app.ui.queuePrompt'}); await app.ui.queuePrompt(); await dbg('queue_done',{method:'app.ui.queuePrompt'}); return true; } } catch (e) { await dbg('queue_fail',{method:'app.ui.queuePrompt', error: String(e)}); }
        // Some builds expose queuePrompt on api
        try { if (typeof api?.queuePrompt === 'function') { await dbg('queue_attempt',{method:'api.queuePrompt'}); await api.queuePrompt(); await dbg('queue_done',{method:'api.queuePrompt'}); return true; } } catch (e) { await dbg('queue_fail',{method:'api.queuePrompt', error: String(e)}); }

        // 2) Direct POST to /prompt using current graph
        try {
          if (typeof app?.graphToPrompt === 'function') {
            const prompt = app.graphToPrompt();
            if (prompt) {
              const client_id = (app && app.clientId) || (api && api.clientId) || (window?._app && window._app.clientId) || undefined;
              await dbg('queue_attempt',{method:'api.fetchApi', prompt_nodes: Object.keys(prompt||{}).length, has_client: !!client_id});
              const body = client_id ? { prompt, client_id } : { prompt };
              const res = await api.fetchApi('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
              await dbg('queue_done',{method:'api.fetchApi', response: res });
              return true;
            }
          }
        } catch (e) { console.warn('[ComfyCanvas] direct /prompt failed', e); await dbg('queue_fail',{method:'api.fetchApi', error: String(e)}); }

        // 3) Fallback: click button (cover more UI variants)
        try {
          const selectors = [
            'button.queue-prompt',
            'button[data-action="queue"]',
            'button[data-action="queue-prompt"]',
            'button[data-action="queue_prompt"]',
            'button[data-action="queuePrompt"]',
            'button[data-hotkey="queue_prompt"]',
            'button[title="Queue prompt"]',
            'button[aria-label="Queue Prompt"]',
            'button[title*="Queue" i]',
            'button[aria-label*="Queue" i]',
            'button[title="Run"]',
            'button[aria-label="Run"]',
            'button[title*="Run" i]',
            'button[aria-label*="Run" i]'
          ];
          let btn = document.querySelector(selectors.join(','));
          if (!btn) {
            const candidates = Array.from(document.querySelectorAll('button'));
            btn = candidates.find(b => {
              const t = (b.textContent||'').trim().toLowerCase();
              return t === 'run' || t.includes('queue prompt') || (t.includes('queue') && t.includes('prompt'));
            });
          }
          if (btn) { await dbg('queue_attempt',{method:'click_button'}); btn.click(); await dbg('queue_done',{method:'click_button'}); return true; }
        } catch (e) { await dbg('queue_fail',{method:'click_button', error:String(e)}); }

        // 4) Last resort: Ctrl+Enter
        try { await dbg('queue_attempt',{method:'ctrl_enter'}); const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true }); document.dispatchEvent(ev); await dbg('queue_done',{method:'ctrl_enter'}); return true; } catch (e) { await dbg('queue_fail',{method:'ctrl_enter', error:String(e)}); }
        return false;
      }

      let lastCounter = null; // unknown initial state
      let lastStatus = undefined;
      const update = async () => {
        const s = await status();
        statusW.value = s.ok ? `online - ${s.url}` : "offline";
        const durl = await lastInputDataURL();
        if (durl) imgW.value = durl;
        // If frontend pushed a new input, auto-queue current prompt in Comfy UI
        try {
          if (s && s.ok && typeof s.generate_counter === 'number') {
            const cur = s.generate_counter;
            const shouldQueue = (lastCounter === null && cur > 0) || (lastCounter !== null && cur > lastCounter);
            if (shouldQueue) {
              console.log('[ComfyCanvas] detected generate event', { cur, lastCounter }); await dbg('detected_generate', {cur, lastCounter});
              try { if (!(await queueCurrentGraph())) { console.warn('Failed to locate a queue method/button'); await dbg('queue_fail',{reason:'no_method'}); } }
              catch (e) { console.warn('Queue attempt failed', e); }
            }
            lastCounter = cur;
          }
          const snapshot = { ok: s?.ok, gc: s?.generate_counter };
          if (JSON.stringify(lastStatus) !== JSON.stringify(snapshot)) {
            console.log('[ComfyCanvas] bridge status', { ok: s?.ok, generate_counter: s?.generate_counter });
            await dbg('bridge_status', snapshot);
            lastStatus = snapshot;
          }
        } catch {}
        this.setDirtyCanvas(true, true);
      };
      this._ldInt = setInterval(update, 700);
      this.onRemoved = () => { if (this._ldInt) clearInterval(this._ldInt); if (_ccPayloadInt) clearInterval(_ccPayloadInt); };

      return r;
    };
  },
});
