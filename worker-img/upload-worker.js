/* launch.arr.club image upload + submissions inbox + review console Worker
 * Routes:
 *   POST /upload          multipart form, field "file" -> stores in R2, returns {url}
 *   POST /submit           JSON submission -> stores in R2 under submissions/, returns {ok:true}
 *   GET  /img/<key>        serves the stored image with long cache (submissions/ and reviewed/ blocked)
 *   GET  /review/list      token-gated: pending submissions with badge check results
 *   POST /review/approve   token-gated: {key} -> builds pages, commits to GitHub, publishes
 *   POST /review/reject    token-gated: {key} -> moves submission to reviewed/rejected/
 * R2 binding required: IMAGES (bucket: launch-images)
 * Secrets required for review: REVIEW_TOKEN, GITHUB_TOKEN (repo contents read+write)
 */

const ALLOW_ORIGIN = 'https://launch.arr.club';
const REPO = 'vcsmemo/launch-arr-club';
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
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];
const STORY_QS = ['Who is it for?','What problem does it solve?','What job does it do?','How does it solve it?','What makes it different?'];
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%230d9488'/%3E%3Cpath d='M32 12c8 6 12 14 12 22l-7 3-3 9h-4l-2-7-8 2 2-8-4-3c0-8 6-14 14-18z' fill='%23ffffff'/%3E%3Ccircle cx='32' cy='24' r='4' fill='%230d9488'/%3E%3C/svg%3E";

function cors(headers) {
  headers.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Review-Token');
  return headers;
}

function json(data, status) {
  const headers = cors(new Headers({ 'content-type': 'application/json' }));
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function slugify(name) {
  return (
    String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) ||
    'product'
  );
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------- review auth ---------- */
function reviewAuthed(request, url, env) {
  if (!env.REVIEW_TOKEN) return false;
  const t = url.searchParams.get('token') || request.headers.get('x-review-token') || '';
  return t !== '' && t === env.REVIEW_TOKEN;
}

/* ---------- real badge check: is our badge on the founder's site? ---------- */
async function checkBadge(siteUrl) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 8000);
    const r = await fetch(siteUrl, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; launch-arr-club badge check)' },
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const html = await r.text();
    return html.indexOf('launch.arr.club/badges/') !== -1;
  } catch (e) {
    return null;
  }
}

/* ---------- GitHub API ---------- */
async function gh(env, path, method, body) {
  const r = await fetch('https://api.github.com/repos/' + REPO + path, {
    method: method || 'GET',
    headers: {
      Authorization: 'Bearer ' + env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'launch-arr-club-review',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  if (!r.ok) throw new Error('GitHub ' + r.status + ' ' + path + ': ' + text.slice(0, 200));
  return data;
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function ghFile(env, path) {
  const d = await gh(env, '/contents/' + path + '?ref=main');
  return b64decode(d.content);
}

/* ---------- page builders ---------- */
function priceLabelOf(d) {
  return d.pricing && String(d.pricing).trim() ? String(d.pricing).trim() : 'Free';
}

function revenueOf(d) {
  const rev = d.revenue || {};
  const amount = rev.amount != null ? String(rev.amount).trim() : '';
  if (!amount) return null;
  return { amount: amount, metric: (rev.metric || '').trim() };
}

function homeCard(d, slug, launchNo) {
  const rev = revenueOf(d);
  const revBig = rev
    ? '<span class="rev-big tracked">💰 ' + esc(rev.amount) + (rev.metric ? ' ' + esc(rev.metric) : '') + '</span>'
    : '';
  const cats = d.categories && d.categories.length ? d.categories : ['Product'];
  return (
    '      <a class="launch-card" href="/launches/' + slug + '/">\n' +
    '        <span class="ribbon">NEW</span>\n' +
    '        <div class="lc-top"><span class="launch-no">#' + launchNo + '</span>' + revBig + '</div>\n' +
    '        <h3>' + esc(d.name) + '</h3>\n' +
    '        <p>' + esc(d.tagline || '') + '</p>\n' +
    '        <div class="tag-row">\n' +
    '          <span class="tag lp" title="Launched today">L+0</span>\n' +
    '          <span class="tag price">' + esc(priceLabelOf(d)) + '</span>\n' +
    '          <span class="tag cat">' + esc(cats[0]) + '</span>\n' +
    '        </div>\n' +
    '      </a>\n'
  );
}

function archiveCard(d, slug) {
  const rev = revenueOf(d);
  const badge = rev ? '<span class="rev-badge tracked">💰 Revenue Tracked</span>' : '';
  const note = rev ? '<p class="rev-note">Self-reported: ' + esc(rev.amount) + (rev.metric ? ' ' + esc(rev.metric) : '') + '</p>' : '';
  const cats = d.categories && d.categories.length ? d.categories : ['Product'];
  return (
    '    <a class="launch-card" href="/launches/' + slug + '/"><span class="ribbon">NEW</span>' + badge +
    '<h3>' + esc(d.name) + '</h3><p>' + esc(d.tagline || '') + '</p>' +
    '<div class="tag-row"><span class="tag price">' + esc(priceLabelOf(d)) + '</span>' +
    '<span class="tag cat">' + esc(cats[0]) + '</span></div>' + note + '</a>\n'
  );
}

function detailPage(d, slug, launchNo, badgeVerified) {
  const now = new Date();
  const dateLong = now.getDate() + ' ' + MONTHS[now.getMonth()] + ' ' + now.getFullYear();
  const dateShort = now.getDate() + ' ' + MONTHS[now.getMonth()].toUpperCase();
  const rev = revenueOf(d);
  const cats = d.categories && d.categories.length ? d.categories : ['Product'];
  const catTags = cats.map(function (c) { return '<span class="tag cat">' + esc(c) + '</span>'; }).join('');
  const logoImg = d.logo
    ? '<img class="logo-img" src="' + esc(d.logo) + '" alt="' + esc(d.name) + ' logo">'
    : '<div class="logo-ph" style="background:var(--mint)">🚀</div>';
  const shot = d.screenshots && d.screenshots[0]
    ? '\n  <img class="detail-shot" src="' + esc(d.screenshots[0]) + '" alt="' + esc(d.name) + ' screenshot">\n'
    : '';
  const story = (d.story || [])
    .map(function (a, i) {
      a = a != null ? String(a).trim() : '';
      if (!a) return '';
      return '<div class="qa"><h3>' + STORY_QS[i] + '</h3><p>' + esc(a) + '</p></div>';
    })
    .join('');
  let host = '';
  try { host = new URL(d.url).hostname.replace(/^www\./, ''); } catch (e) {}
  const badgeLine =
    d.plan === 'badge'
      ? '\n  <p class="rev-note">🏅 Launch badge' +
        (badgeVerified ? ' verified on <a href="' + esc(d.url) + '">' + esc(host) + '</a>' : ' · founder: ' + esc(d.founder || '')) +
        '</p>\n'
      : '';
  const revInsight = rev
    ? esc(rev.amount) + (rev.metric ? ' ' + esc(rev.metric) : '') + ' (self-reported)'
    : 'Not shared yet';
  const links = ['<a href="' + esc(d.url) + '">Website</a>'];
  if (d.x) links.push('<a href="' + esc(d.x) + '">X / Twitter</a>');
  if (d.demo) links.push('<a href="' + esc(d.demo) + '">Demo</a>');
  const priceNum = (function () {
    const m = /([\d,.]+)/.exec(priceLabelOf(d));
    return m ? m[1].replace(/,/g, '') : '0';
  })();
  return (
'<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>' + esc(d.name) + ' — ' + esc(d.tagline || '') + ' | launch.arr.club</title>\n' +
'<meta name="description" content="' + esc((d.description || d.tagline || '').slice(0, 155)) + '">\n' +
'<link rel="canonical" href="https://launch.arr.club/launches/' + slug + '/">\n' +
'<link rel="icon" href="' + FAVICON + '">\n' +
'<link rel="stylesheet" href="/style.css?v=20260930h">\n' +
'<script type="application/ld+json">\n' +
'{"@context":"https://schema.org","@type":"SoftwareApplication",\n' +
'"name":' + JSON.stringify(d.name) + ',"applicationCategory":"WebApplication","operatingSystem":"Web",\n' +
'"description":' + JSON.stringify(d.tagline || '') + ',\n' +
'"offers":{"@type":"Offer","price":' + JSON.stringify(priceNum) + ',"priceCurrency":"USD"},\n' +
'"url":"https://launch.arr.club/launches/' + slug + '/"}\n' +
'</script>\n' +
'</head>\n' +
'<body>\n' +
'<header class="site-header">\n' +
'  <nav class="nav">\n' +
'    <a class="brand" href="/">launch<span>.arr.club</span></a>\n' +
'    <div class="nav-links"><a href="/#recently">Launches</a><a class="cta" href="/submit.html">Launch yours →</a></div>\n' +
'  </nav>\n' +
'</header>\n' +
'<main>\n' +
'  <div class="detail-head">\n' +
'    ' + logoImg + '\n' +
'    <div>\n' +
'      <span class="launch-no">#' + launchNo + '</span>\n' +
'      <h1>' + esc(d.name) + '</h1>\n' +
'      <p class="detail-tagline">' + esc(d.tagline || '') + '</p>\n' +
'      <div class="tag-row">\n' +
'        <span class="tag price">' + esc(priceLabelOf(d)) + '</span>\n' +
'        ' + catTags + '\n' +
'      </div>\n' +
'    </div>\n' +
'  </div>\n' +
badgeLine +
'\n' +
'  <p class="meta-line">Launched ' + dateLong + ' · Live on launch.arr.club · Category: ' + esc(cats.join(', ')) + ' · Website: ' + esc(host) + '</p>\n' +
'\n' +
'  <div class="mission">\n' +
'    <span class="m-step"><span class="m-dot"></span>Submitted</span><span class="m-line"></span>\n' +
'    <span class="m-step"><span class="m-dot"></span>Launched <span class="tnum">' + dateShort + '</span></span><span class="m-line"></span>\n' +
'    <span class="m-step' + (rev ? '' : ' dim') + '"><span class="m-dot"></span>' + (rev ? 'Revenue tracked' : 'Awaiting revenue') + '</span>\n' +
'  </div>\n' +
shot +
'\n' +
'  <section class="story card">\n' +
'    <h2>What ' + esc(d.name) + ' is about</h2>\n' +
'    ' + story + '\n' +
'  </section>\n' +
'\n' +
'  <h2 class="section-title"><span class="dot"></span>Product insights</h2>\n' +
'  <div class="insights">\n' +
'    <div class="insight"><h4>Pricing</h4><p>' + esc(priceLabelOf(d)) + '</p></div>\n' +
'    <div class="insight"><h4>Revenue</h4><p>' + revInsight + '</p></div>\n' +
'    <div class="insight"><h4>Categories</h4><p>' + esc(cats.join(', ')) + '</p></div>\n' +
'    <div class="insight"><h4>Links</h4><p>' + links.join(' · ') + '</p></div>\n' +
'  </div>\n' +
'\n' +
'  <p class="center mt2"><a class="btn" href="/submit.html">🚀 Launch your product</a></p>\n' +
'</main>\n' +
'<footer class="site-footer">\n' +
'  <div class="footer-inner">\n' +
'    <span>© 2026 launch.arr.club · A part of <a href="https://arr.club">ARR.Club</a></span>\n' +
'    <span><a href="/">Home</a> · <a href="/submit">Submit</a> · <a href="/privacy">Privacy</a> · <a href="/sponsor.html">Sponsor · $29/mo</a></span>\n' +
'  </div>\n' +
'</footer>\n' +
'</body>\n' +
'</html>\n'
  );
}

/* parse "$48k MRR" / "$500 MRR" / "$1.2M ARR" into $k of MRR */
function mrrK(rev) {
  if (!rev) return 0;
  const m = /\$?\s*([\d,.]+)\s*([kKmM])?/.exec(rev.amount);
  if (!m) return 0;
  let v = parseFloat(m[1].replace(/,/g, ''));
  if (m[2]) { v *= m[2].toLowerCase() === 'm' ? 1000 : 1; }
  if (/ARR/i.test(rev.metric || '')) v = v / 12;
  else if (!/MRR/i.test(rev.metric || '')) return 0;
  return v;
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
      const key =
        'submissions/' +
        todayISO() +
        '-' +
        slugify(data.name) +
        '-' +
        crypto.randomUUID().slice(0, 6) +
        '.json';
      await env.IMAGES.put(key, str, {
        httpMetadata: { contentType: 'application/json' },
      });
      return json({ ok: true });
    }

    // ---- Review console (token-gated) ----
    if (url.pathname.startsWith('/review/')) {
      if (!env.REVIEW_TOKEN || !env.GITHUB_TOKEN) {
        return json({ error: 'review console not configured' }, 503);
      }
      if (!reviewAuthed(request, url, env)) {
        return json({ error: 'unauthorized' }, 401);
      }

      // List pending submissions
      if (request.method === 'GET' && url.pathname === '/review/list') {
        const listed = await env.IMAGES.list({ prefix: 'submissions/' });
        const items = await Promise.all(
          listed.objects.map(async function (o) {
            const obj = await env.IMAGES.get(o.key);
            let d = null;
            try { d = await obj.json(); } catch (e) {}
            if (!d) return null;
            const badgeCheck = d.plan === 'badge' && d.url ? await checkBadge(d.url) : null;
            return {
              key: o.key,
              uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : null,
              badge_check: badgeCheck,
              data: d,
            };
          })
        );
        return json({ ok: true, items: items.filter(Boolean) });
      }

      // Approve -> build pages, commit to GitHub, publish
      if (request.method === 'POST' && url.pathname === '/review/approve') {
        let body;
        try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
        const key = body && body.key;
        if (!key || !key.startsWith('submissions/')) return json({ error: 'bad key' }, 400);
        const obj = await env.IMAGES.get(key);
        if (!obj) return json({ error: 'submission not found' }, 404);
        const raw = await obj.text();
        let d;
        try { d = JSON.parse(raw); } catch (e) { return json({ error: 'submission is not valid json' }, 400); }
        if (!d.name || !d.url) return json({ error: 'submission missing name/url' }, 400);

        // unique slug
        let slug = slugify(d.name);
        for (let i = 2; i < 20; i++) {
          try {
            await gh(env, '/contents/launches/' + slug + '/index.html?ref=main');
            slug = slugify(d.name) + '-' + i;
          } catch (e) { break; }
        }

        // current files
        const [indexHtml0, launchesJson0, sitemap0, archive0] = await Promise.all([
          ghFile(env, 'index.html'),
          ghFile(env, 'launches.json'),
          ghFile(env, 'sitemap.xml'),
          ghFile(env, '2026/w40/index.html'),
        ]);

        // next launch number
        let maxNo = 0;
        const noRe = /#(\d{3})/g;
        let m;
        while ((m = noRe.exec(indexHtml0)) !== null) maxNo = Math.max(maxNo, parseInt(m[1], 10));
        const launchNo = String(maxNo + 1).padStart(3, '0');

        const badgeVerified = d.plan === 'badge' && d.url ? await checkBadge(d.url) : false;

        // 1. detail page
        const detail = detailPage(d, slug, launchNo, badgeVerified === true);

        // 2. homepage: insert card + bump counts
        let indexHtml = indexHtml0.replace('<div class="feed">', '<div class="feed">\n' + homeCard(d, slug, launchNo).replace(/\n$/, ''));
        indexHtml = indexHtml.replace(
          /(<span class="bs-num" data-count=")(\d+)(">)\d+(<\/span><span class="bs-label">launches<\/span>)/,
          function (full, a, n, b, c) {
            const v = parseInt(n, 10) + 1;
            return a + v + b + v + c;
          }
        );
        const addK = mrrK(revenueOf(d));
        if (addK > 0) {
          indexHtml = indexHtml.replace(
            /(<span class="bs-num teal" data-count=")(\d+)(" data-prefix="\$" data-suffix="k">\$)\d+k(<\/span>)/,
            function (full, a, n, b, c) {
              const v = Math.round(parseFloat(n) + addK);
              return a + v + b + v + 'k' + c;
            }
          );
        }

        // 3. launches.json
        const idx = JSON.parse(launchesJson0);
        idx.unshift({
          category: (d.categories && d.categories[0]) || 'Product',
          name: d.name,
          tagline: d.tagline || '',
          url: '/launches/' + slug + '/',
        });
        const launchesJson = JSON.stringify(idx);

        // 4. sitemap
        const today = todayISO();
        let sitemap = sitemap0.replace(
          /(<loc>https:\/\/launch\.arr\.club\/<\/loc><lastmod>)\d{4}-\d{2}-\d{2}/,
          '$1' + today
        );
        sitemap = sitemap.replace(
          '</urlset>',
          '  <url><loc>https://launch.arr.club/launches/' + slug + '/</loc><lastmod>' + today + '</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>\n</urlset>'
        );

        // 5. weekly archive
        let archive = archive0.replace('<div class="feed">', '<div class="feed">\n' + archiveCard(d, slug).replace(/\n$/, ''));
        archive = archive.replace(/(\d+) launches<\/strong>/, function (full, n) {
          return parseInt(n, 10) + 1 + ' launches</strong>';
        });

        // commit via GitHub API
        const ref = await gh(env, '/git/ref/heads/main');
        const commitSha = ref.object.sha;
        const baseCommit = await gh(env, '/git/commits/' + commitSha);
        const files = {
          ['launches/' + slug + '/index.html']: detail,
          'index.html': indexHtml,
          'launches.json': launchesJson,
          'sitemap.xml': sitemap,
          '2026/w40/index.html': archive,
        };
        const tree = await gh(env, '/git/trees', 'POST', {
          base_tree: baseCommit.tree.sha,
          tree: await Promise.all(
            Object.keys(files).map(async function (p) {
              const b = await gh(env, '/git/blobs', 'POST', { content: files[p], encoding: 'utf-8' });
              return { path: p, mode: '100644', type: 'blob', sha: b.sha };
            })
          ),
        });
        const newCommit = await gh(env, '/git/commits', 'POST', {
          message: 'Publish ' + d.name + ' (#' + launchNo + ') via review console',
          tree: tree.sha,
          parents: [commitSha],
        });
        await gh(env, '/git/ref/heads/main', 'PATCH', { sha: newCommit.sha });

        // move submission to reviewed/approved/
        const base = key.split('/').pop();
        await env.IMAGES.put('reviewed/approved/' + base, raw, {
          httpMetadata: { contentType: 'application/json' },
        });
        await env.IMAGES.delete(key);

        return json({ ok: true, url: 'https://launch.arr.club/launches/' + slug + '/', slug: slug, launch_no: launchNo });
      }

      // Reject -> archive the submission
      if (request.method === 'POST' && url.pathname === '/review/reject') {
        let body;
        try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
        const key = body && body.key;
        if (!key || !key.startsWith('submissions/')) return json({ error: 'bad key' }, 400);
        const obj = await env.IMAGES.get(key);
        if (!obj) return json({ error: 'submission not found' }, 404);
        const raw = await obj.text();
        const base = key.split('/').pop();
        await env.IMAGES.put('reviewed/rejected/' + base, raw, {
          httpMetadata: { contentType: 'application/json' },
        });
        await env.IMAGES.delete(key);
        return json({ ok: true });
      }

      return json({ error: 'unknown review action' }, 404);
    }

    // ---- Serve ----
    if (request.method === 'GET' && url.pathname.startsWith('/img/')) {
      const key = url.pathname.slice(5);
      if (!key || key.includes('..') || key.startsWith('submissions/') || key.startsWith('reviewed/')) {
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
