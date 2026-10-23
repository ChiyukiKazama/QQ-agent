// 专用语音页面。预听通过已鉴权请求取得 Blob，不在媒体 URL 中暴露管理令牌。
'use strict';
const audioDraft = { chatKey: '', scope: 'chat', name: '', text: '', saved: false };
const audioPreviewUrls = new Set();

function renderAudioSection(c) {
  const t = c.audio?.tts || {};
  const targets = new Map();
  for (const id of c.allow?.groups || []) targets.set(`group:${id}`, `群 ${id}`);
  for (const id of c.allow?.private || []) targets.set(`private:${id}`, `私聊 ${id}`);
  for (const chat of state.chats || []) {
    if (targets.has(chat.key) || c.allowAllWhenEmpty) targets.set(chat.key, `${chat.key.startsWith('group:') ? '群' : '私聊'} ${chat.chatName || chat.key.split(':')[1]}`);
  }
  return `<h2>语音</h2>
    <div class="hint">导入音频或调用本地模型生成，预听后可发送为 QQ 语音消息。未保存音频保留 24 小时；勾选保存后长期保留。单个音频上限 20MB。</div>
    <div class="field"><label>发送到</label><select id="audio-target"><option value="">请选择白名单中的群／私聊</option>${[...targets].map(([key, label]) => `<option value="${esc(key)}" ${audioDraft.chatKey === key ? 'selected' : ''}>${esc(label)} (${esc(key)})</option>`).join('')}</select></div>
    <div class="field"><label>新音频的使用范围</label><select id="audio-scope"><option value="chat" ${audioDraft.scope === 'chat' ? 'selected' : ''}>仅选中的会话</option><option value="shared" ${audioDraft.scope === 'shared' ? 'selected' : ''}>所有白名单会话可用</option></select></div>
    <div class="field"><label>音频名称（可选）</label><input id="audio-name" maxlength="100" value="${esc(audioDraft.name)}" placeholder="留空使用文件名或默认名称" /></div>
    <label class="checkbox-row"><input type="checkbox" id="audio-saved" ${audioDraft.saved ? 'checked' : ''} /> 长期保存本次导入／生成的音频</label>
    <div class="field"><label>导入音频</label><input id="audio-import-file" type="file" accept=".wav,.mp3,.m4a,.ogg,.flac,.amr,.silk,audio/*" /><button class="btn" id="audio-import" type="button">导入所选音频</button></div>
    <div class="field"><label>要生成的语音文本</label><textarea id="audio-text" maxlength="3000" rows="4" placeholder="输入需要朗读的文本">${esc(audioDraft.text)}</textarea><button class="btn" id="audio-generate" type="button">生成音频</button></div>
    <div id="audio-operation-status" class="hint" role="status"></div>
    <h3>音频列表 <button class="btn btn-small" id="audio-refresh" type="button">刷新</button></h3>
    <div id="audio-items">正在读取音频…</div>
    <h3>本地语音生成服务</h3>
    <div class="hint">仅调用你已经部署的本机服务。OpenAI 兼容表示接口格式；不会自动使用聊天模型的地址或密钥，也不会安装模型。</div>
    ${switchHtml('cfg-audio-enabled', t.enabled === true, '启用本地语音生成')}
    <div class="field"><label>服务类型</label><select id="cfg-audio-provider"><option value="openai" ${t.provider !== 'gpt-sovits' ? 'selected' : ''}>OpenAI 兼容本地 TTS</option><option value="gpt-sovits" ${t.provider === 'gpt-sovits' ? 'selected' : ''}>GPT-SoVITS API v2</option></select></div>
    <div class="field"><label>本机服务地址</label><input id="cfg-audio-url" value="${esc(t.baseUrl || '')}" placeholder="http://127.0.0.1:8880/v1 或 http://127.0.0.1:9880" /></div>
    <div class="field"><label>服务密钥（可选，留空保持已有密钥）</label><input id="cfg-audio-key" type="password" autocomplete="new-password" placeholder="${t.hasApiKey ? '已保存密钥；输入新值可替换' : '本地服务无需认证时留空'}" /><button id="audio-clear-key" class="btn btn-small" type="button">清除密钥</button></div>
    <div id="audio-openai-fields" ${t.provider === 'gpt-sovits' ? 'class="hidden"' : ''}>
      <div class="field"><label>模型名</label><input id="cfg-audio-model" value="${esc(t.model || '')}" placeholder="填写本地服务提供的模型名" /></div>
      <div class="field"><label>音色</label><input id="cfg-audio-voice" value="${esc(t.voice || '')}" placeholder="填写本地服务提供的音色 ID" /></div>
    </div>
    <div id="audio-sovits-fields" ${t.provider !== 'gpt-sovits' ? 'class="hidden"' : ''}>
      <div class="field"><label>参考音频路径（由 GPT-SoVITS 服务读取）</label><input id="cfg-audio-ref" value="${esc(t.refAudioPath || '')}" placeholder="本机参考音频的完整路径" /></div>
      <div class="field"><label>参考音频文本</label><textarea id="cfg-audio-prompt" rows="2">${esc(t.promptText || '')}</textarea></div>
      <div class="field"><label>生成文本语言</label><input id="cfg-audio-textlang" value="${esc(t.textLang || 'zh')}" placeholder="zh / en / ja 等服务支持的语言代码" /></div>
      <div class="field"><label>参考音频语言</label><input id="cfg-audio-promptlang" value="${esc(t.promptLang || 'zh')}" /></div>
    </div>
    <div class="field"><label>语速（0.25～4）</label><input type="number" id="cfg-audio-speed" min="0.25" max="4" step="0.05" value="${esc(t.speed ?? 1)}" /></div>
    <div class="hint">服务设置自动保存。音频发送受现有白名单与限频控制；浏览器无法预听的格式仍可尝试发送，由协议端处理格式转换。</div>`;
}

function collectAudioSettings() {
  const value = id => document.getElementById(id)?.value || '';
  const tts = {
    enabled: document.getElementById('cfg-audio-enabled')?.checked === true,
    provider: value('cfg-audio-provider'), baseUrl: value('cfg-audio-url').trim(),
    model: value('cfg-audio-model').trim(), voice: value('cfg-audio-voice').trim(),
    speed: Number(value('cfg-audio-speed')), refAudioPath: value('cfg-audio-ref').trim(),
    promptText: value('cfg-audio-prompt'), textLang: value('cfg-audio-textlang').trim(),
    promptLang: value('cfg-audio-promptlang').trim()
  };
  if (value('cfg-audio-key').trim()) tts.apiKey = value('cfg-audio-key').trim();
  return { tts };
}

async function fetchAudioContent(id) {
  const response = await fetch(`/api/audio/${encodeURIComponent(id)}/content`, { headers: { 'x-console-token': CONSOLE_MARKER } });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return response.blob();
}

async function refreshAudioList() {
  const box = $('#audio-items');
  if (!box) return;
  try {
    const { items } = await api('/api/audio');
    if ($('#audio-items') !== box) return;
    for (const url of audioPreviewUrls) URL.revokeObjectURL(url);
    audioPreviewUrls.clear();
    box.innerHTML = items.length ? items.map(item => `<div class="field" data-audio-id="${esc(item.id)}">
      <strong>${esc(item.name)}</strong> <span class="muted">${esc(item.format.toUpperCase())} · ${(item.sizeBytes / 1024).toFixed(0)}KB · ${item.saved ? '已保存' : `临时，${esc(fmtTime(item.expiresAt))} 过期`} · ${esc(item.chatKey || '共享素材')}</span>
      <div><button class="btn btn-small" data-audio-action="preview">预听</button> <button class="btn btn-small" data-audio-action="send">发送语音</button> <button class="btn btn-small" data-audio-action="save" data-saved="${item.saved}">${item.saved ? '取消长期保存' : '长期保存'}</button> <button class="btn btn-small" data-audio-action="download">下载</button> <button class="btn btn-small btn-danger" data-audio-action="delete">删除</button></div>
      <audio controls preload="none" class="hidden" style="max-width:100%"></audio>
    </div>`).join('') : '<div class="hint">尚无音频。可先导入文件，或配置本地服务后生成。</div>';
    box.querySelectorAll('[data-audio-action]').forEach(button => button.addEventListener('click', async () => {
      const row = button.closest('[data-audio-id]');
      const id = row.dataset.audioId;
      const action = button.dataset.audioAction;
      button.disabled = true;
      const status = $('#audio-operation-status');
      try {
        if (action === 'preview' || action === 'download') {
          const blob = await fetchAudioContent(id);
          const url = URL.createObjectURL(blob);
          if (action === 'preview') {
            const audio = row.querySelector('audio');
            if (audio.src) { URL.revokeObjectURL(audio.src); audioPreviewUrls.delete(audio.src); }
            audioPreviewUrls.add(url);
            audio.src = url;
            audio.classList.remove('hidden');
            audio.onerror = () => { if (status) status.textContent = '浏览器无法预听此音频；可以下载检查，或交给协议端发送。'; };
            await audio.play();
          } else {
            const item = items.find(a => a.id === id);
            const a = document.createElement('a');
            a.href = url;
            a.download = item.name.toLowerCase().endsWith(`.${item.format}`) ? item.name : `${item.name}.${item.format}`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }
        } else if (action === 'send') {
          if (!audioDraft.chatKey) throw new Error('请先选择发送到哪个群／私聊');
          const result = await api(`/api/audio/${id}/send`, { method: 'POST', body: JSON.stringify({ chatKey: audioDraft.chatKey }) });
          if (status) status.textContent = `语音发送成功${result.messageId != null ? `（消息 ${result.messageId}）` : ''}`;
        } else if (action === 'save') {
          await api(`/api/audio/${id}/save`, { method: 'POST', body: JSON.stringify({ saved: button.dataset.saved !== 'true' }) });
          await refreshAudioList();
        } else if (action === 'delete') {
          if (!(await uiConfirm('删除这份托管音频？导入时的原始文件不会被删除。'))) return;
          await api(`/api/audio/${id}`, { method: 'DELETE' });
          await refreshAudioList();
        }
      } catch (error) { if (status) status.textContent = error.message; }
      finally { button.disabled = false; }
    }));
  } catch (error) { box.textContent = `音频读取失败：${error.message}`; }
}

function bindAudioEvents() {
  if (state.settingsSection !== 'audio') return;
  for (const [id, key] of [['audio-target', 'chatKey'], ['audio-scope', 'scope'], ['audio-name', 'name'], ['audio-text', 'text'], ['audio-saved', 'saved']]) {
    document.getElementById(id)?.addEventListener('input', event => { audioDraft[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value; });
  }
  $('#cfg-audio-provider')?.addEventListener('change', event => {
    const sovits = event.target.value === 'gpt-sovits';
    $('#audio-openai-fields')?.classList.toggle('hidden', sovits);
    $('#audio-sovits-fields')?.classList.toggle('hidden', !sovits);
    const url = $('#cfg-audio-url');
    if (url && ['', 'http://127.0.0.1:8880/v1', 'http://127.0.0.1:9880'].includes(url.value)) url.value = sovits ? 'http://127.0.0.1:9880' : 'http://127.0.0.1:8880/v1';
  });
  $('#audio-refresh')?.addEventListener('click', refreshAudioList);
  $('#audio-clear-key')?.addEventListener('click', async () => {
    try {
      const result = await api('/api/config', { method: 'POST', body: JSON.stringify({ audio: { tts: { apiKey: '' } } }) });
      state.config = result.config;
      $('#cfg-audio-key').value = '';
      $('#cfg-audio-key').placeholder = '密钥已清除';
    } catch (error) { $('#audio-operation-status').textContent = error.message; }
  });
  for (const action of ['import', 'generate']) {
    $(`#audio-${action}`)?.addEventListener('click', async event => {
      const button = event.currentTarget;
      const status = $('#audio-operation-status');
      button.disabled = true;
      try {
        const chatKey = audioDraft.scope === 'shared' ? '' : audioDraft.chatKey;
        if (audioDraft.scope !== 'shared' && !chatKey) throw new Error('请先选择会话，或将使用范围改为共享素材');
        let result;
        if (action === 'import') {
          const file = $('#audio-import-file')?.files?.[0];
          if (!file) throw new Error('请先选择音频文件');
          if (file.size > 20 * 1024 * 1024) throw new Error('单个音频不能超过 20MB');
          status.textContent = '正在导入…';
          const query = new URLSearchParams({ name: audioDraft.name || file.name, chatKey, saved: String(audioDraft.saved) });
          const response = await fetch(`/api/audio/import?${query}`, { method: 'POST', body: file,
            headers: { 'content-type': 'application/octet-stream', 'x-console-token': CONSOLE_MARKER } });
          result = await response.json();
          if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        } else {
          if (!audioDraft.text.trim()) throw new Error('请输入需要朗读的文本');
          await saveConfig({ quiet: true });
          status.textContent = '正在调用本地模型生成（最多等待 120 秒）…';
          result = await api('/api/audio/generate', { method: 'POST', body: JSON.stringify({ text: audioDraft.text, name: audioDraft.name, saved: audioDraft.saved, chatKey }) });
        }
        status.textContent = `${action === 'import' ? '已导入' : '已生成'}：${result.item.name}。尚未发送，可先预听。`;
        await refreshAudioList();
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
  refreshAudioList();
}
