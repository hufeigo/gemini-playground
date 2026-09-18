// Test console for the OpenAI-compatible Gemini reverse proxy.
// Only exercises the REST endpoints served by the same origin
// (/v1/models and /v1/chat/completions) — no Live API code here.

const $ = (id) => document.getElementById(id);

const KEY_STORAGE = 'gemini_api_key';   // shared with the Live playground page
const MODEL_STORAGE = 'proxy_test_model';
const DEFAULT_MODEL = 'gemini-flash-lite-latest';
const FALLBACK_MODELS = [
    'gemini-flash-lite-latest',
    'gemini-3.6-flash',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.5-flash',
    'gemini-3-pro-preview',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
];
const MODELS_TIMEOUT_MS = 15000;
const CHAT_TIMEOUT_MS = 180000;

const keyInput = $('api-key-input');
const keyToggleBtn = $('key-visibility-toggle');
const testConnBtn = $('test-connection-btn');
const connDot = $('conn-dot');
const connText = $('conn-text');
const connResult = $('conn-result');
const connDetailWrap = $('conn-detail-wrap');
const connDetail = $('conn-detail');
const modelSelect = $('model-select');
const streamToggle = $('stream-toggle');
const msgInput = $('msg-input');
const sendBtn = $('send-btn');
const chatResult = $('chat-result');
const metaEl = $('result-meta');
const reasoningWrap = $('reasoning-wrap');
const reasoningPre = $('result-reasoning');
const contentPre = $('result-content');
const rawWrap = $('result-raw-wrap');
const rawPre = $('result-raw');
const curlPre = $('curl-pre');
const copyCurlBtn = $('copy-curl-btn');
const baseUrlCode = $('base-url-code');
const curlModelCode = $('curl-model-code');

const getApiKey = () => keyInput.value.trim();
const fmtElapsed = (t0) => ((performance.now() - t0) / 1000).toFixed(1);
const formatUsage = (u) => {
    if (!u) { return ''; }
    return ` · tokens: ${u.total_tokens ?? '?'} (prompt ${u.prompt_tokens ?? '?'}, completion ${u.completion_tokens ?? '?'})`;
};

/** Extract a short human-readable line from a non-2xx response body. */
function firstErrorLine(text) {
    try {
        const parsed = JSON.parse(text);
        return (parsed.error?.message || text).slice(0, 200);
    } catch {
        return (text || '').slice(0, 200);
    }
}

function setConnState(state, text) {
    connResult.classList.remove('hidden');
    connDot.className = `dot ${state}`;
    connText.textContent = text;
}

function showConnDetail(text) {
    connDetail.textContent = text;
    connDetailWrap.classList.remove('hidden');
    connDetailWrap.open = true;
}

/**
 * Fills the model dropdown, keeping the user's selection when possible.
 * @param {string[]} ids
 * @param {boolean} replace - clear existing options first (fresh API list)
 */
function fillModels(ids, replace = false) {
    if (!ids?.length) { return; }
    if (replace) { modelSelect.innerHTML = ''; }
    for (const id of ids) {
        if ([...modelSelect.options].some(o => o.value === id)) { continue; }
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        modelSelect.appendChild(opt);
    }
    const preferred = modelSelect.value
        || localStorage.getItem(MODEL_STORAGE)
        || DEFAULT_MODEL;
    if (![...modelSelect.options].some(o => o.value === preferred)) {
        const opt = document.createElement('option');
        opt.value = preferred;
        opt.textContent = preferred;
        modelSelect.appendChild(opt);
    }
    modelSelect.value = preferred;
}

/** GET /v1/models — verifies the proxy path and the API key in one shot. */
async function testConnection() {
    const key = getApiKey();
    if (!key) {
        alert('请先输入 API Key');
        return;
    }
    localStorage.setItem(KEY_STORAGE, key);
    connDetailWrap.classList.add('hidden');
    setConnState('pending', '测试中…');
    const t0 = performance.now();
    try {
        const resp = await fetch('/v1/models', {
            headers: { 'Authorization': `Bearer ${key}` },
            signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
        });
        const elapsed = fmtElapsed(t0);
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            setConnState('fail', `HTTP ${resp.status} · ${elapsed}s — ${firstErrorLine(text)}`);
            showConnDetail(text || '(空响应体)');
            return;
        }
        const data = await resp.json();
        const ids = (data.data || []).map(m => m.id).filter(Boolean);
        fillModels(ids, true);
        setConnState('ok', `连接正常 · HTTP 200 · ${elapsed}s · ${ids.length} 个模型可用`);
        connDetail.textContent = `模型列表: ${ids.join(', ')}`;
        connDetailWrap.classList.remove('hidden');
        connDetailWrap.open = false;
    } catch (err) {
        setConnState('fail', `请求失败 — ${err.message}`);
        showConnDetail(err.message);
    }
}

/**
 * POST /v1/chat/completions — non-streaming and streaming.
 * Renders the answer, the separated reasoning_content (Gemini 3.x
 * thinking models) and the raw response for debugging.
 */
async function sendChat() {
    const key = getApiKey();
    if (!key) {
        alert('请先输入 API Key');
        return;
    }
    const model = modelSelect.value || DEFAULT_MODEL;
    const content = msgInput.value.trim();
    if (!content) {
        alert('请输入测试消息');
        return;
    }
    localStorage.setItem(KEY_STORAGE, key);
    localStorage.setItem(MODEL_STORAGE, model);

    const stream = streamToggle.checked;
    const body = { model, messages: [{ role: 'user', content }], stream };
    if (stream) {
        // The proxy only emits a usage chunk when the client opts in.
        body.stream_options = { include_usage: true };
    }

    chatResult.classList.remove('hidden');
    metaEl.textContent = '请求中…';
    contentPre.textContent = '';
    reasoningPre.textContent = '';
    reasoningWrap.classList.add('hidden');
    rawPre.textContent = '';
    rawWrap.open = false;
    sendBtn.disabled = true;
    sendBtn.textContent = '请求中…';

    const t0 = performance.now();
    try {
        const resp = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
        });
        const elapsed = fmtElapsed(t0);
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            metaEl.textContent = `❌ HTTP ${resp.status} · ${elapsed}s`;
            contentPre.textContent = '(无回复)';
            rawPre.textContent = text.slice(0, 2000) || '(空响应体)';
            rawWrap.open = true;
            return;
        }
        if (stream) {
            await consumeStream(resp, elapsed);
        } else {
            const data = await resp.json();
            const choice = data.choices?.[0];
            const message = choice?.message || {};
            contentPre.textContent = typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message, null, 2);
            if (message.reasoning_content) {
                reasoningPre.textContent = message.reasoning_content;
                reasoningWrap.classList.remove('hidden');
            }
            metaEl.textContent = `✅ HTTP 200 · ${elapsed}s · finish: ${choice?.finish_reason ?? '-'}${formatUsage(data.usage)}`;
            rawPre.textContent = JSON.stringify(data, null, 2);
        }
    } catch (err) {
        metaEl.textContent = `❌ 请求失败 · ${fmtElapsed(t0)}s`;
        contentPre.textContent = '(无回复)';
        rawPre.textContent = err.message;
        rawWrap.open = true;
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = '发送请求';
    }
}

/**
 * Reads an SSE stream (data: {...}\n\n ... data: [DONE]) and renders
 * delta.content / delta.reasoning_content incrementally.
 * @param {Response} resp
 * @param {string} elapsed - seconds until response headers arrived
 */
async function consumeStream(resp, elapsed) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let textOut = '';
    let reasoningOut = '';
    let usage = null;
    let finish = null;
    let chunkCount = 0;
    let lastChunk = null;
    metaEl.textContent = `✅ HTTP 200 · ${elapsed}s · 流式接收中…`;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const raw = buffer.slice(0, sep).trim();
            buffer = buffer.slice(sep + 2);
            if (!raw.startsWith('data:')) { continue; }
            const payload = raw.slice(5).trim();
            if (payload === '[DONE]') { continue; }
            let evt;
            try {
                evt = JSON.parse(payload);
            } catch {
                continue;
            }
            chunkCount++;
            lastChunk = evt;
            const choice = evt.choices?.[0];
            const delta = choice?.delta;
            if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
                reasoningOut += delta.reasoning_content;
                reasoningPre.textContent = reasoningOut;
                reasoningWrap.classList.remove('hidden');
            }
            if (typeof delta?.content === 'string' && delta.content) {
                textOut += delta.content;
                contentPre.textContent = textOut;
            }
            if (choice?.finish_reason) { finish = choice.finish_reason; }
            if (evt.usage) { usage = evt.usage; }
        }
    }
    if (!textOut && !reasoningOut) {
        contentPre.textContent = '(流结束,无内容)';
    }
    metaEl.textContent = `✅ HTTP 200 · 流式完成 · finish: ${finish ?? '-'}${formatUsage(usage)}`;
    rawPre.textContent = lastChunk
        ? `// ${chunkCount} 个数据块,最后一块:\n${JSON.stringify(lastChunk, null, 2)}`
        : '(无数据块)';
}

/** Renders a copy-pasteable curl command for the current settings. */
function updateCurl() {
    const model = modelSelect.value || DEFAULT_MODEL;
    const msg = (msgInput.value.trim() || 'Testing. Just say hi and nothing else.')
        .slice(0, 200)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
    curlPre.textContent =
        `curl ${window.location.origin}/v1/chat/completions \\\n` +
        `  -H "Authorization: Bearer YOUR-GEMINI-API-KEY" \\\n` +
        `  -H "Content-Type: application/json" \\\n` +
        `  -d '{"model":"${model}","messages":[{"role":"user","content":"${msg}"}]}'`;
    curlModelCode.textContent = model;
}

// ---- wire up ----
keyToggleBtn.addEventListener('click', () => {
    const hidden = keyInput.type === 'password';
    keyInput.type = hidden ? 'text' : 'password';
    keyToggleBtn.textContent = hidden ? '隐藏' : '显示';
});
keyInput.addEventListener('change', () => {
    localStorage.setItem(KEY_STORAGE, getApiKey());
});
testConnBtn.addEventListener('click', testConnection);
sendBtn.addEventListener('click', sendChat);
modelSelect.addEventListener('change', () => {
    localStorage.setItem(MODEL_STORAGE, modelSelect.value);
    updateCurl();
});
msgInput.addEventListener('input', updateCurl);
copyCurlBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(curlPre.textContent);
        copyCurlBtn.textContent = '已复制 ✓';
        setTimeout(() => { copyCurlBtn.textContent = '复制 curl 命令'; }, 1500);
    } catch (err) {
        alert('复制失败:' + err.message);
    }
});

// ---- init ----
keyInput.value = localStorage.getItem(KEY_STORAGE) || '';
fillModels(FALLBACK_MODELS, true);
baseUrlCode.textContent = `${window.location.origin}/v1`;
updateCurl();
