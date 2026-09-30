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

function logoHtml(d) {
  if (d.logo) return '<img class="lc-logo" src="' + esc(d.logo) + '" alt="' + esc(d.name) + '">';
  return '<span class="lc-logo-ph">' + esc(String(d.name || '?').charAt(0)) + '</span>';
}

function drText(dr) {
  return dr === null || dr === undefined || dr === '' ? '–' : String(dr);
}

function validDr(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  if (isNaN(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function homeCard(d, slug, launchNo, dr) {
  const rev = revenueOf(d);
  const revLine = rev
    ? '          <div class="lc-rev tracked">💰 ' + esc(rev.amount) + (rev.metric ? ' ' + esc(rev.metric) : '') + '</div>\n'
    : '';
  const cats = d.categories && d.categories.length ? d.categories : ['Product'];
  return (
    '      <a class="launch-card" href="/launches/' + slug + '/">\n' +
    '        <span class="ribbon">NEW</span>\n' +
    '        ' + logoHtml(d) + '\n' +
    '        <div class="lc-main">\n' +
    '          <h3><span class="launch-no">#' + launchNo + '</span> ' + esc(d.name) + '</h3>\n' +
    '          <p class="lc-tag">' + esc(d.tagline || '') + '</p>\n' +
    revLine +
    '          <div class="lc-meta">\n' +
    '            <div class="lc-m"><span>DR</span><b>' + drText(dr) + '</b></div>\n' +
    '            <div class="lc-m"><span>Price</span><b>' + esc(priceLabelOf(d)) + '</b></div>\n' +
    '            <div class="lc-m"><span>Category</span><b>' + esc(cats[0]) + '</b></div>\n' +
    '            <span class="lc-lp" title="Launched today">L+0</span>\n' +
    '          </div>\n' +
    '        </div>\n' +
    '      </a>\n'
  );
}

function archiveCard(d, slug, launchNo, dr) {
  return homeCard(d, slug, launchNo, dr).replace(/^      /gm, '    ');
}

const DETAIL_SHARED_JS = `<script>
(function(){
  document.querySelectorAll('[data-copy]').forEach(function(b){
    b.addEventListener('click', function(){
      var label = b.getAttribute('data-label') || b.textContent;
      navigator.clipboard.writeText(location.href).then(function(){
        b.textContent = 'Copied \\u2713';
        setTimeout(function(){ b.textContent = label; }, 1500);
      });
    });
  });
  var wrap = document.getElementById('drChart');
  if (wrap) {
    var myDr = wrap.getAttribute('data-dr');
    myDr = (myDr === null || myDr === '') ? null : parseInt(myDr, 10);
    fetch('/launches.json').then(function(r){ return r.json(); }).then(function(items){
      var drs = items.map(function(i){ return i.dr; }).filter(function(d){ return d != null; });
      if (!drs.length) return;
      var buckets = [0,0,0,0,0,0,0,0,0,0];
      drs.forEach(function(d){ buckets[Math.min(9, Math.floor(d / 10))]++; });
      var max = Math.max.apply(null, buckets.concat([1]));
      var avg = Math.round(drs.reduce(function(a,b){ return a + b; }, 0) / drs.length);
      document.getElementById('drBars').innerHTML = buckets.map(function(c, i){
        var h = Math.max(3, Math.round(c / max * 64));
        var mine = (myDr != null && Math.min(9, Math.floor(myDr / 10)) === i);
        return '<div class="bar' + (mine ? ' mine' : '') + '" style="height:' + h + 'px" title="' + (i*10) + '-' + (i*10+9) + ': ' + c + '"></div>';
      }).join('');
      document.getElementById('drCap').textContent = 'vs. average DR of ' + avg + ' across ' + drs.length + ' rated launches';
      wrap.hidden = false;
    }).catch(function(){});
  }
})();
</script>
`;

function detailPage(d, slug, launchNo, badgeVerified, dr, others, makerCount) {
  const now = new Date();
  const dateLong = now.getDate() + ' ' + MONTHS[now.getMonth()] + ' ' + now.getFullYear();
  const dateShort = now.getDate() + ' ' + MONTHS[now.getMonth()].toUpperCase();
  const rev = revenueOf(d);
  const cats = d.categories && d.categories.length ? d.categories : ['Product'];
  const catPills = cats.map(function (c) { return '<span class="tag cat">' + esc(c) + '</span>'; }).join('');
  const logoImg = d.logo
    ? '<img class="d-logo" src="' + esc(d.logo) + '" alt="' + esc(d.name) + ' logo">'
    : '<span class="d-logo-ph">' + esc(String(d.name || '?').charAt(0)) + '</span>';
  const shots = (d.screenshots || [])
    .map(function (s) { return '    <img src="' + esc(s) + '" alt="' + esc(d.name) + ' screenshot" loading="lazy">'; })
    .join('\n');
  const shotSection = shots
    ? '  <h2 class="section-title caps"><span class="dot"></span>Screenshots</h2>\n' +
      '  <div class="card shot-card">\n' + shots + '\n  </div>\n' +
      '  <p class="shot-cap">' + esc(d.tagline || '') + '</p>\n\n'
    : '';
  const storyLabels = ['Who it is for', 'The problem', 'Job to be done', 'How it solves it', 'What makes it different'];
  const storyCards = (d.story || [])
    .map(function (a, i) {
      a = a != null ? String(a).trim() : '';
      if (!a) return '';
      const cls = i === 4 ? 'story-card wide' : 'story-card';
      return '    <div class="' + cls + '"><h4>' + storyLabels[i] + '</h4><p>' + esc(a) + '</p></div>';
    })
    .join('\n');
  let host = '';
  try { host = new URL(d.url).hostname.replace(/^www\./, ''); } catch (e) {}
  const badgeLine =
    d.plan === 'badge'
      ? '      <p class="rev-note">🏅 Launch badge' +
        (badgeVerified ? ' verified on <a href="' + esc(d.url) + '">' + esc(host) + '</a>' : ' · founder: ' + esc(d.founder || '')) +
        '</p>\n'
      : '';
  const revBig = rev ? '<b class="rev">' + esc(rev.amount) + (rev.metric ? ' ' + esc(rev.metric) : '') + '</b>' : '<b>–</b>';
  const revSub = rev
    ? '<small>Self-reported · tracked on <a href="https://arr.club">ARR.Club</a></small>'
    : '<small>Not shared yet</small>';
  const drBig = dr !== null && dr !== undefined ? '<b>' + dr + '<i>/100</i></b>' : '<b>–<i>/100</i></b>';
  const drSub = dr !== null && dr !== undefined ? '<small>Checked manually at review</small>' : '<small>Not checked yet</small>';
  const makerBig = d.founder ? '<b>' + esc(d.founder) + '</b>' : '<b>–</b>';
  const makerSub = makerCount === 1 ? '<small>1 product launched</small>'
    : makerCount > 1 ? '<small>' + makerCount + ' products launched</small>' : '<small>–</small>';
  const links = ['<a href="' + esc(d.url) + '">Website</a>'];
  if (d.x) links.push('<a href="' + esc(d.x) + '">X / Twitter</a>');
  if (d.demo) links.push('<a href="' + esc(d.demo) + '">Demo</a>');
  const about = (d.description || d.tagline || '').trim();
  const moreRows = (others || []).map(function (o, i) {
    const logo = o.logo
      ? '<img src="' + esc(o.logo) + '" alt="">'
      : '<span class="lc-logo-ph">' + esc(String(o.name || '?').charAt(0)) + '</span>';
    return '    <a class="more-row" href="' + esc(o.url) + '"><span class="more-rank">#' + (i + 1) + '</span>' + logo +
      '<span class="more-main"><strong>' + esc(o.name) + '</strong><p>' + esc(o.tagline || '') + '</p>' +
      '<small>' + esc((o.categories || []).join(' · ')) + '</small></span>' +
      '<span class="more-dr"><span>DR</span><b>' + (o.dr === null || o.dr === undefined ? '–' : o.dr) + '</b></span></a>';
  }).join('\n');
  const priceNum = (function () {
    const m = /([\d,.]+)/.exec(priceLabelOf(d));
    return m ? m[1].replace(/,/g, '') : '0';
  })();
  const drAttr = dr === null || dr === undefined ? '' : String(dr);
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
'<link rel="stylesheet" href="/style.css?v=20260930k">\n' +
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
'    <div class="nav-auth" id="authSlot"></div>\n' +
'  </nav>\n' +
'</header>\n' +
'<main>\n' +
'  <nav class="crumbs"><a href="/">launch.arr.club</a> <span>&rsaquo;</span> <a href="/#recently">Launches</a> <span>&rsaquo;</span> <strong>' + esc(d.name) + '</strong><button class="copy-link" data-copy data-label="&#10697; copy link">&#10697; copy link</button></nav>\n' +
'\n' +
'  <div class="d-hero">\n' +
'    ' + logoImg + '\n' +
'    <div class="d-hero-main">\n' +
'      <div class="d-title-row"><h1>' + esc(d.name) + '</h1><span class="launch-no">#' + launchNo + '</span></div>\n' +
'      <p class="d-tagline">' + esc(d.tagline || '') + '</p>\n' +
badgeLine +
'    </div>\n' +
'    <div class="d-hero-actions">\n' +
'      <button class="btn ghost" data-copy data-label="Share">Share</button>\n' +
'      <a class="btn dark" href="' + esc(d.url) + '" target="_blank" rel="noopener">Visit &#8599;</a>\n' +
'    </div>\n' +
'  </div>\n' +
'\n' +
'  <div class="mission">\n' +
'    <span class="m-step"><span class="m-dot"></span>Submitted</span><span class="m-line"></span>\n' +
'    <span class="m-step"><span class="m-dot"></span>Launched <span class="tnum">' + dateShort + '</span></span><span class="m-line"></span>\n' +
'    <span class="m-step' + (rev ? '' : ' dim') + '"><span class="m-dot"></span>' + (rev ? 'Revenue tracked' : 'Awaiting revenue') + '</span>\n' +
'  </div>\n' +
'\n' +
'  <h2 class="section-title caps"><span class="dot"></span>What ' + esc(d.name) + ' is about</h2>\n' +
'  <div class="story-wrap">\n' +
'    <div class="story-grid">\n' +
storyCards + '\n' +
'    </div>\n' +
'  </div>\n' +
'\n' +
'  <div class="stat-grid">\n' +
'    <div class="stat-card"><span>Revenue</span>' + revBig + revSub + '</div>\n' +
'    <div class="stat-card"><span>Domain Rating</span>' + drBig + drSub + '</div>\n' +
'    <div class="stat-card"><span>Pricing</span><b>' + esc(priceLabelOf(d)) + '</b><small>' + esc(d.pricing && /free/i.test(d.pricing) ? 'No cost to start' : priceLabelOf(d)) + '</small></div>\n' +
'    <div class="stat-card"><span>Launched</span><b>' + dateLong + '</b><small>L+0 &middot; Live on launch.arr.club</small></div>\n' +
'    <div class="stat-card"><span>Category</span><div class="pills">' + catPills + '</div></div>\n' +
'    <div class="stat-card"><span>Maker</span>' + makerBig + makerSub + '</div>\n' +
'  </div>\n' +
'\n' +
'  <div class="card chart-card" id="drChart" data-dr="' + drAttr + '" hidden>\n' +
'    <h4>Products by Domain Rating</h4>\n' +
'    <div class="bars" id="drBars"></div>\n' +
'    <p class="chart-cap" id="drCap"></p>\n' +
'  </div>\n' +
'\n' +
shotSection +
'  <h2 class="section-title caps"><span class="dot"></span>Product insights</h2>\n' +
'  <div class="insights-2col">\n' +
'    <div class="card" style="padding:1.3rem">\n' +
'      <div class="ins-block"><h4>About</h4><p>' + esc(about) + '</p></div>\n' +
'      <div class="ins-block"><h4>Categories</h4><div class="pills">' + catPills + '</div></div>\n' +
'      <div class="ins-block"><h4>Pricing</h4><p>' + esc(priceLabelOf(d)) + '</p></div>\n' +
'      <div class="ins-block"><h4>Links</h4><p>' + links.join(' &middot; ') + '</p></div>\n' +
'    </div>\n' +
'    <aside class="card track-box" style="padding:1.3rem">\n' +
'      <h4>Get tracked forever</h4>\n' +
'      <p>Revenue growing? Announce your milestone on <a href="https://arr.club">ARR.Club</a> and join long-term revenue tracking.</p>\n' +
'      <a class="btn" href="https://arr.club" target="_blank" rel="noopener">Announce on ARR.Club &#8599;</a>\n' +
'    </aside>\n' +
'  </div>\n' +
'\n' +
'  <h2 class="section-title caps"><span class="dot"></span>More launches <a class="view-all" href="/2026/w40/">View all &rsaquo;</a></h2>\n' +
'  <div class="more-list">\n' +
moreRows + '\n' +
'  </div>\n' +
DETAIL_SHARED_JS +
'</main>\n' +
'<footer class="site-footer">\n' +
'  <div class="footer-inner">\n' +
'    <span>© 2026 launch.arr.club · A part of <a href="https://arr.club">ARR.Club</a></span>\n' +
'    <span><a href="/">Home</a> · <a href="/submit">Submit</a> · <a href="/privacy">Privacy</a> · <a href="/sponsor.html">Sponsor · $29/mo</a></span>\n' +
'  </div>\n' +
'</footer>\n' +
'<script src="/auth.js"></script>\n' +
'</body>\n' +
'</html>\n'
  );
}


function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function ghFileSha(env, path) {
  const d = await gh(env, '/contents/' + path + '?ref=main');
  return { text: b64decode(d.content), sha: d.sha };
}

async function handleApprove(request, env) {
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

  // current files (with shas for update)
  const [indexF, launchesF, sitemapF, archiveF] = await Promise.all([
    ghFileSha(env, 'index.html'),
    ghFileSha(env, 'launches.json'),
    ghFileSha(env, 'sitemap.xml'),
    ghFileSha(env, '2026/w40/index.html'),
  ]);
  const indexHtml0 = indexF.text, launchesJson0 = launchesF.text, sitemap0 = sitemapF.text, archive0 = archiveF.text;

  // next launch number
  let maxNo = 0;
  const noRe = /#(\d{3})/g;
  let m;
  while ((m = noRe.exec(indexHtml0)) !== null) maxNo = Math.max(maxNo, parseInt(m[1], 10));
  const launchNo = String(maxNo + 1).padStart(3, '0');

  const badgeVerified = d.plan === 'badge' && d.url ? await checkBadge(d.url) : false;
  const dr = validDr(body.dr);

  // launch index + numbers (feed order == launches.json order, newest first)
  const idx = JSON.parse(launchesJson0);
  const nos = [];
  const noRe2 = /<span class="launch-no">#(\d{3})<\/span>/g;
  let mm2;
  while ((mm2 = noRe2.exec(indexHtml0)) !== null) nos.push(mm2[1]);
  const others = idx.slice(0, 8).map(function (e, i) {
    return { name: e.name, tagline: e.tagline, url: e.url, logo: e.logo,
             categories: [e.category || 'Product'], dr: e.dr, no: nos[i] || '–––' };
  });
  const makerCount = d.founder
    ? idx.filter(function (e) { return (e.founder || '') === d.founder; }).length + 1
    : null;

  // 1. detail page
  const detail = detailPage(d, slug, launchNo, badgeVerified === true, dr, others, makerCount);

  // 2. homepage: insert card (board stats are computed client-side from launches.json)
  let indexHtml = indexHtml0.replace('<div class="feed" id="launchRail">', '<div class="feed" id="launchRail">\n' + homeCard(d, slug, launchNo, dr).replace(/\n$/, ''));

  // 3. launches.json (idx parsed above)
  const rev = revenueOf(d);
  idx.unshift({
    category: (d.categories && d.categories[0]) || 'Product',
    name: d.name,
    tagline: d.tagline || '',
    url: '/launches/' + slug + '/',
    logo: d.logo || null,
    founder: d.founder || null,
    dr: dr,
    revenue: rev ? rev.amount + (rev.metric ? ' ' + rev.metric : '') : null,
    revenue_verified: false,
    launched: todayISO(),
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
  let archive = archive0.replace('<div class="feed">', '<div class="feed">\n' + archiveCard(d, slug, launchNo, dr).replace(/\n$/, ''));
  archive = archive.replace(/(\d+) launches<\/strong>/, function (full, n) {
    return parseInt(n, 10) + 1 + ' launches</strong>';
  });

  // publish via Contents API (one PUT per file; fine-grained tokens handle this reliably)
  const msg = 'Publish ' + d.name + ' (#' + launchNo + ') via review console';
  const updates = [
    { path: 'launches/' + slug + '/index.html', content: detail, sha: null },
    { path: 'index.html', content: indexHtml, sha: indexF.sha },
    { path: 'launches.json', content: launchesJson, sha: launchesF.sha },
    { path: 'sitemap.xml', content: sitemap, sha: sitemapF.sha },
    { path: '2026/w40/index.html', content: archive, sha: archiveF.sha },
  ];
  for (const u of updates) {
    const payload = { message: msg, content: b64encode(u.content), branch: 'main' };
    if (u.sha) payload.sha = u.sha;
    await gh(env, '/contents/' + u.path, 'PUT', payload);
  }

  // move submission to reviewed/approved/
  const base = key.split('/').pop();
  await env.IMAGES.put('reviewed/approved/' + base, raw, {
    httpMetadata: { contentType: 'application/json' },
  });
  await env.IMAGES.delete(key);

  return json({ ok: true, url: 'https://launch.arr.club/launches/' + slug + '/', slug: slug, launch_no: launchNo });
}

async function handleReject(request, env) {
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
        try {
          return await handleApprove(request, env);
        } catch (e) {
          return json({ error: 'approve failed: ' + (e && e.message ? e.message : String(e)) }, 500);
        }
      }

      // Reject -> archive the submission
      if (request.method === 'POST' && url.pathname === '/review/reject') {
        try {
          return await handleReject(request, env);
        } catch (e) {
          return json({ error: 'reject failed: ' + (e && e.message ? e.message : String(e)) }, 500);
        }
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
