import fs from 'node:fs';
import { AUDIO_MAX_BYTES, audioLibrary, audioError, validAudioChat, generateAudio, sendAudio } from './audio.js';

export function createAudioRoutes({ readBody, sender }) {
  const bodyOf = req => readBody(req);
  return [
    { method: 'GET', pattern: '/api/audio', handler: async ({ res, json }) => json(res, 200, { items: audioLibrary.list() }) },
    {
      method: 'POST', pattern: '/api/audio/import',
      handler: async ({ req, res, url, json }) => {
        const chatKey = validAudioChat(url.searchParams.get('chatKey'), { optional: true });
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > AUDIO_MAX_BYTES * 2) { req.destroy(); throw audioError('音频上传过大', 413); }
          if (size > AUDIO_MAX_BYTES) { chunks.length = 0; continue; }
          chunks.push(chunk);
        }
        if (size > AUDIO_MAX_BYTES) throw audioError('单个音频不能超过 20MB', 413);
        const item = audioLibrary.add(Buffer.concat(chunks), {
          name: url.searchParams.get('name'), chatKey, saved: url.searchParams.get('saved') === 'true'
        });
        return json(res, 200, { item });
      }
    },
    {
      method: 'POST', pattern: '/api/audio/generate',
      handler: async ({ req, res, json }) => json(res, 200, { item: await generateAudio(await bodyOf(req)) })
    },
    {
      method: 'GET', pattern: /^\/api\/audio\/([\w-]+)\/content$/,
      handler: async ({ res, match, url }) => audioLibrary.using(match[1], null, async item => {
        const data = fs.readFileSync(item.file);
        res.writeHead(200, {
          'content-type': item.mime, 'content-length': data.length, 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-disposition': `${url.searchParams.get('download') === 'true' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(item.name.toLowerCase().endsWith(`.${item.format}`) ? item.name : `${item.name}.${item.format}`)}`
        });
        res.end(data);
      })
    },
    {
      method: 'POST', pattern: /^\/api\/audio\/([\w-]+)\/save$/,
      handler: async ({ req, res, json, match }) => {
        const { saved } = await bodyOf(req);
        return json(res, 200, { item: audioLibrary.setSaved(match[1], saved) });
      }
    },
    {
      method: 'POST', pattern: /^\/api\/audio\/([\w-]+)\/send$/,
      handler: async ({ req, res, json, match }) => {
        const { chatKey, saved } = await bodyOf(req);
        try {
          const result = await sendAudio(sender, match[1], chatKey, { saved });
          return json(res, 200, { ok: true, messageId: result.message_id ?? null });
        } catch (error) {
          if (error.expose) throw error;
          throw audioError(`语音发送失败：${error.message || '协议端未完成发送'}。音频仍保留，可稍后重试。`, 502);
        }
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/audio\/([\w-]+)$/,
      handler: async ({ res, json, match }) => { audioLibrary.remove(match[1]); return json(res, 200, { ok: true }); }
    }
  ];
}
