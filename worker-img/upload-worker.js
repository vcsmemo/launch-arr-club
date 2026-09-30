/* launch.arr.club image upload + submissions inbox Worker
 * Routes:
 *   POST /upload   multipart form, field "file" -> stores in R2, returns {url}
 *   POST /submit   JSON submission -> stores in R2 under submissions/, returns {ok:true}
 *   GET  /img/<key> serves the stored image with long cache (submissions/ blocked)
 * R2 binding required: IMAGES (bucket: launch-images)
 */

const ALLOW_ORIGIN = 'https://launch.arr.club';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SUBMIT_BYTES = 24000;
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

function cors(headers) {
  headers.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return headers;
}

function json(data, status) {
  const headers = cors(new Headers({ 'content-type': 'application/json' }));
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(new Headers()) });
    }

    // ---- Image upload ----
    if (request.method === 'POST' && url.pathname === '/upload') {
      let form;
      try {
        form = await request.formData();
      } catch (e) {
        return json({ error: 'invalid form data' }, 400);
      }
      const file = form.get('file');
      if (!file || typeof file === 'string') {
        return json({ error: 'missing file field' }, 400);
      }
      if (!ALLOWED_TYPES.includes(file.type)) {
        return json({ error: 'only png/jpg/webp/gif/svg allowed' }, 400);
      }
      if (file.size > MAX_BYTES) {
        return json({ error: 'file too large (max 5MB)' }, 413);
      }
      if (file.size === 0) {
        return json({ error: 'empty file' }, 400);
      }
      const ext = EXT_BY_TYPE[file.type];
      const key =
        'uploads/' +
        new Date().toISOString().slice(0, 10) +
        '-' +
        crypto.randomUUID().slice(0, 8) +
        '.' +
        ext;
      await env.IMAGES.put(key, file.stream(), {
        httpMetadata: { contentType: file.type },
      });
      const publicUrl = url.origin + '/img/' + key;
      return json({ url: publicUrl, key: key });
    }

    // ---- Submissions inbox ----
    if (request.method === 'POST' && url.pathname === '/submit') {
      let data;
      try {
        data = await request.json();
      } catch (e) {
        return json({ error: 'invalid json' }, 400);
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return json({ error: 'invalid json' }, 400);
      }
      const str = JSON.stringify(data);
      if (str.length > MAX_SUBMIT_BYTES) {
        return json({ error: 'submission too large' }, 413);
      }
      if (!data.name || !data.url) {
        return json({ error: 'name and url required' }, 400);
      }
      const slug =
        String(data.name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'product';
      const key =
        'submissions/' +
        new Date().toISOString().slice(0, 10) +
        '-' +
        slug +
        '-' +
        crypto.randomUUID().slice(0, 6) +
        '.json';
      await env.IMAGES.put(key, str, {
        httpMetadata: { contentType: 'application/json' },
      });
      return json({ ok: true });
    }

    // ---- Serve ----
    if (request.method === 'GET' && url.pathname.startsWith('/img/')) {
      const key = url.pathname.slice(5);
      if (!key || key.includes('..') || key.startsWith('submissions/')) {
        return new Response('not found', { status: 404 });
      }
      const obj = await env.IMAGES.get(key);
      if (!obj) {
        return new Response('not found', { status: 404 });
      }
      const headers = new Headers();
      headers.set(
        'content-type',
        (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream'
      );
      headers.set('cache-control', 'public, max-age=31536000, immutable');
      cors(headers);
      return new Response(obj.body, { headers });
    }

    return new Response('not found', { status: 404 });
  },
};
