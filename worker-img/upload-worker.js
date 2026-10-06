/* launch.arr.club image upload + submissions inbox + review console Worker
 * Routes:
 *   POST /upload          multipart form, field "file" -> stores in R2, returns {url}
 *   POST /submit           JSON submission -> stores in R2 under submissions/, returns {ok:true}
 *   GET  /img/<key>        serves the stored image with long cache (submissions/ and reviewed/ blocked)
 *   GET  /review/list      token-gated: pending submissions with badge check results
 *   POST /review/approve   token-gated: {key} -> builds pages, commits to GitHub, publishes
 *   POST /review/reject    token-gated: {key} -> moves submission to reviewed/rejected/
 *   POST /claim-interest   {slug, email} -> saves founder claim intent to KV (claim:<slug>:<md5(email)>)
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

/* Compact MD5 (for claim-interest dedupe keys). Not for security use. */
function md5(str) {
  var s = unescape(encodeURIComponent(str));
  var bytes = [];
  for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  var bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (var i = 0; i < 4; i++) bytes.push((bitLen >>> (i * 8)) & 0xff);
  for (var i = 0; i < 4; i++) bytes.push(0);
  var sft = [7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
             5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
             4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
             6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21];
  var K = [];
  for (var i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
  var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (var off = 0; off < bytes.length; off += 64) {
    var M = [];
    for (var j = 0; j < 16; j++)
      M.push(bytes[off + j * 4] | (bytes[off + j * 4 + 1] << 8) | (bytes[off + j * 4 + 2] << 16) | (bytes[off + j * 4 + 3] << 24));
    var A = a0, B = b0, C = c0, D = d0;
    for (var i = 0; i < 64; i++) {
      var F, g;
      if (i < 16)      { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else             { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = F + A + K[i] + M[g];
      A = D; D = C; C = B;
      B = B + (((F << sft[i]) | (F >>> (32 - sft[i]))) | 0);
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  function hexLE(n) {
    var hex = '0123456789abcdef', s = '';
    for (var i = 0; i < 4; i++) {
      var b = (n >>> (i * 8)) & 0xff;
      s += hex[(b >> 4) & 15] + hex[b & 15];
    }
    return s;
  }
  return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
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

function revDollars(r) {
  if (!r) return null;
  const m = String(r).match(/\$([\d.]+)\s*([kKmM]?)/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (m[2].toLowerCase() === 'k') v *= 1000;
  if (m[2].toLowerCase() === 'm') v *= 1000000;
  return v;
}

function logoHtml(d) {
  if (d.logo) return '<img class="lc-logo" src="' + esc(d.logo) + '" alt="' + esc(d.name) + '">';
  return '<span class="lc-logo-ph">' + esc(String(d.name || '?').charAt(0)) + '</span>';
}



function homeCard(d, slug, launchNo) {
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

    '            <div class="lc-m"><span>Price</span><b>' + esc(priceLabelOf(d)) + '</b></div>\n' +
    '            <div class="lc-m"><span>Category</span><b>' + esc(cats[0]) + '</b></div>\n' +
    '            <span class="lc-lp" title="Launched today">L+0</span>\n' +
    '          </div>\n' +
    '        </div>\n' +
    '      </a>\n'
  );
}

function archiveCard(d, slug, launchNo) {
  return homeCard(d, slug, launchNo).replace(/^      /gm, '    ');
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
})();
</script>
`;

function detailPage(d, slug, launchNo, badgeVerified, others, makerCount, rank) {
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
    ? '<small>Founder-reported</small>'
    : '<small>Not shared yet</small>';
  const makerBig = d.founder ? '<b>' + esc(d.founder) + '</b>' : '<b>–</b>';
  const makerSub = makerCount === 1 ? '<small>1 product launched</small>'
    : makerCount > 1 ? '<small>' + makerCount + ' products launched</small>' : '<small>–</small>';
  const links = ['<a href="' + esc(d.url) + '">Website</a>'];
  if (d.x) links.push('<a href="' + esc(d.x) + '">X / Twitter</a>');
  if (d.demo) links.push('<a href="' + esc(d.demo) + '">Demo</a>');
  const about = (d.description || d.tagline || '').trim();
  const gw = d.growth || {};
  const gwRows = [];
  if (gw.first_user_source) gwRows.push(['First user came from', esc(gw.first_user_source) + (gw.first_user_detail ? ' — ' + esc(gw.first_user_detail) : '')]);
  if (gw.best_channel) gwRows.push(['Best channel so far', esc(gw.best_channel)]);
  if (gw.days_to_first_dollar) gwRows.push(['Days to first dollar', esc(String(gw.days_to_first_dollar))]);
  const growthSection = gwRows.length
    ? '  <h2 class="section-title caps"><span class="dot"></span>How they got there</h2>\n' +
      '  <div class="story-wrap">\n' +
      '    <div class="story-grid">\n' +
      gwRows.map(function (r) { return '    <div class="story-card"><h4>' + r[0] + '</h4><p>' + r[1] + '</p></div>'; }).join('\n') +
      '\n    </div>\n' +
      '  </div>\n\n'
    : '';
  const moreRows = (others || []).map(function (o, i) {
    const logo = o.logo
      ? '<img src="' + esc(o.logo) + '" alt="">'
      : '<span class="lc-logo-ph">' + esc(String(o.name || '?').charAt(0)) + '</span>';
    return '    <a class="more-row" href="' + esc(o.url) + '"><span class="more-rank">#' + esc(o.no) + '</span>' + logo +
      '<span class="more-main"><strong>' + esc(o.name) + '</strong><p>' + esc(o.tagline || '') + '</p>' +
      '<small>' + esc((o.categories || []).join(' · ') + (o.revenue ? ' · ' + o.revenue : '')) + '</small></span>' +
      '</a>';
  }).join('\n');
  const priceNum = (function () {
    const m = /([\d,.]+)/.exec(priceLabelOf(d));
    return m ? m[1].replace(/,/g, '') : '0';
  })();
  const rankCard = rank
    ? '  <div class="card rank-card">\n' +
      '    <h4>Board position</h4>\n' +
      '    <div class="rank-rows">\n' +
      '      <div class="rank-row"><span>Overall</span><b>#' + rank.no + ' of ' + rank.total + '</b></div>\n' +
      '      <div class="rank-row"><span>In ' + esc(rank.cat) + '</span><b>#' + rank.catNo + ' of ' + rank.catTotal + '</b></div>\n' +
      '    </div>\n' +
      '    <p class="rank-cap">Earlier launches rank first · updates as the board grows</p>\n' +
      '  </div>\n'
    : '';
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
'<link rel="stylesheet" href="/style.css?v=20260930v">\n' +
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
'    <a class="brand" href="/">Milestone<span>Wins</span></a>\n' +
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
growthSection +
'  <div class="stat-grid">\n' +
'    <div class="stat-card"><span>Revenue</span>' + revBig + revSub + '</div>\n' +
'    <div class="stat-card"><span>Pricing</span><b>' + esc(priceLabelOf(d)) + '</b><small>' + esc(d.pricing && /free/i.test(d.pricing) ? 'No cost to start' : priceLabelOf(d)) + '</small></div>\n' +
'    <div class="stat-card"><span>Launched</span><b>' + dateLong + '</b><small>L+0 &middot; Live on launch.arr.club</small></div>\n' +
'    <div class="stat-card"><span>Category</span><div class="pills">' + catPills + '</div></div>\n' +
'    <div class="stat-card"><span>Maker</span>' + makerBig + makerSub + '</div>\n' +
'  </div>\n' +
'\n' +
rankCard +

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
'  </div>\n' +
'\n' +
'  <h2 class="section-title caps"><span class="dot"></span>More launches <a class="view-all" href="/2026/w40/">View all &rsaquo;</a></h2>\n' +
'  <div class="more-list">\n' +
moreRows + '\n' +
'  </div>\n' +
DETAIL_SHARED_JS +
'</main>\n' +
'<footer class="site-footer">\n' +
'  <div class="footer-cols">\n' +
'    <div class="fcol"><h5>Discover</h5><a href="/#recently">Launches</a><a href="/2026/w40/">Weekly archive</a><a href="/#leaderboard">Leaderboard</a></div>\n' +
'    <div class="fcol"><h5>Alternatives</h5><a href="/alternatives/product-hunt/">Product Hunt alternative</a><a href="/alternatives/faslaunch/">FasLaunch alternative</a></div>\n' +
'    <div class="fcol"><h5>Launch</h5><a href="/launch-your-startup/">Launch your startup</a><a href="/launch-your-ai-tool/">Launch your AI tool</a><a href="/launch-your-saas/">Launch your SaaS</a></div>\n' +
'    <div class="fcol"><h5>For agents</h5><a href="/llms.txt">llms.txt</a><a href="/submit.html">Submit</a><a href="/privacy.html">Privacy</a></div>\n' +
'  </div>\n' +
'  <div class="footer-inner">\n' +
'    <span>© 2026 MilestoneWins</span>\n' +
'    <span class="sample-note">Curated listings: a mix of founder submissions and our editors\u2019 picks of public launches.</span>\n' +
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

  // launch index + numbers (feed order == launches.json order, newest first)
  const idx = JSON.parse(launchesJson0);
  const selfUrl = '/launches/' + slug + '/';
  const selfRev = revDollars(typeof d.revenue === 'string' ? d.revenue : (d.revenue && d.revenue.amount));
  const others = idx
    .filter(function (e) { return e.url !== selfUrl; })
    .map(function (e) {
      const v = revDollars(e.revenue);
      const proximity = (selfRev && v) ? Math.abs(Math.log(v / selfRev)) : Infinity;
      return { e: e, proximity: proximity };
    })
    .sort(function (a, b) { return a.proximity - b.proximity; })
    .slice(0, 8)
    .map(function (x) {
      const e = x.e;
      return {
        name: e.name, tagline: e.tagline, url: e.url, logo: e.logo,
        categories: [e.category || 'Product'],
        no: e.launch_no ? String(e.launch_no).padStart(3, '0') : '–––',
        revenue: e.revenue || ''
      };
    });
  const makerCount = d.founder
    ? idx.filter(function (e) { return (e.founder || '') === d.founder; }).length + 1
    : null;
  const rankCatName = (d.categories && d.categories[0]) || 'Product';
  const rankCatN = idx.filter(function (e) { return (e.category || 'Product') === rankCatName; }).length;
  const rank = { no: launchNo, total: idx.length + 1, cat: rankCatName, catNo: rankCatN + 1, catTotal: rankCatN + 1 };

  // 1. detail page
  const detail = detailPage(d, slug, launchNo, badgeVerified === true, others, makerCount, rank);

  // 2. homepage: insert card (board stats are computed client-side from launches.json)
  let indexHtml = indexHtml0.replace('<div class="feed" id="launchRail">', '<div class="feed" id="launchRail">\n' + homeCard(d, slug, launchNo).replace(/\n$/, ''));

  // 3. launches.json (idx parsed above)
  const rev = revenueOf(d);
  idx.unshift({
    category: (d.categories && d.categories[0]) || 'Product',
    name: d.name,
    tagline: d.tagline || '',
    url: '/launches/' + slug + '/',
    logo: d.logo || null,
    founder: d.founder || null,
    revenue: rev ? rev.amount + (rev.metric ? ' ' + rev.metric : '') : null,
    revenue_verified: false,
    growth: (d.growth && (d.growth.first_user_source || d.growth.best_channel || d.growth.days_to_first_dollar)) ? {
      first_user_source: d.growth.first_user_source || null,
      first_user_detail: d.growth.first_user_detail || null,
      best_channel: d.growth.best_channel || null,
      days_to_first_dollar: d.growth.days_to_first_dollar || null
    } : null,
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
  let archive = archive0.replace('<div class="feed">', '<div class="feed">\n' + archiveCard(d, slug, launchNo).replace(/\n$/, ''));
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

/* ---------- dynamic badge SVG generation ---------- */
async function badgeSvg(slug, style, theme, env) {
  // Fetch product data from GitHub (launches.json)
  let product = null;
  try {
    const r = await fetch('https://raw.githubusercontent.com/' + REPO + '/main/launches.json');
    if (r.ok) {
      const launches = await r.json();
      product = launches.find(function (p) {
        const url = p.url || '';
        const m = url.match(/\/launches\/([^/]+)\//);
        return m && m[1] === slug;
      });
    }
  } catch (e) {}

  const isDark = theme === 'dark';
  const bg = isDark ? '#0f172a' : '#ffffff';
  const border = isDark ? '' : ' stroke="#e2e8f0" stroke-width="1"';
  const textColor = isDark ? '#f1f5f9' : '#0f172a';
  const accent = isDark ? '#5eead4' : '#0d9488';
  const pillBg = isDark ? '#134e4a' : '#f0fdfa';
  const pillBorder = isDark ? '' : ' stroke="#99f6e4"';
  const pillText = isDark ? '#5eead4' : '#0f766e';

  const rocket = '<g transform="translate(12,7)">'
    + '<path d="M2 20 C 2 12, 8 4, 18 2" stroke="#0d9488" stroke-width="1.8" fill="none" stroke-linecap="round" opacity="0.7"/>'
    + '<g transform="translate(4,2) rotate(40 8 8)">'
    + '<ellipse cx="8" cy="7" rx="4" ry="6.5" fill="#0d9488"/>'
    + '<path d="M4.5 10.5 L2.5 14 L5 13.2 L4.2 15.8 L6.8 12.5 Z" fill="#0d9488"/>'
    + '<path d="M11.5 10.5 L13.5 14 L11 13.2 L11.8 15.8 L9.2 12.5 Z" fill="#0d9488"/>'
    + '<path d="M6.8 13.5 L8 16.5 L9.2 13.5 Z" fill="#0f766e"/>'
    + '</g></g>';

  function escXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  let svg = '';
  if (style === 'revenue' && product && product.revenue) {
    const rev = product.revenue;
    const revWidth = Math.max(62, rev.length * 7 + 16);
    const width = 42 + revWidth + 8 + 130;
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="36" viewBox="0 0 ' + width + ' 36">'
      + '<rect width="' + width + '" height="36" rx="18" fill="' + bg + '"' + border + '/>'
      + rocket
      + '<rect x="42" y="9" width="' + revWidth + '" height="18" rx="9" fill="' + pillBg + '"' + pillBorder + '/>'
      + '<text x="' + (42 + revWidth / 2) + '" y="22" text-anchor="middle" font-family="Inter,-apple-system,\'Segoe UI\',Roboto,sans-serif" font-size="11" font-weight="700" fill="' + pillText + '">' + escXml(rev) + '</text>'
      + '<text x="' + (42 + revWidth + 8) + '" y="22.5" font-family="Inter,-apple-system,\'Segoe UI\',Roboto,sans-serif" font-size="12.5" font-weight="600" fill="' + textColor + '">tracked on <tspan fill="' + accent + '">launch.arr.club</tspan></text>'
      + '</svg>';
  } else {
    // numbered (default) — use launch number from product or #025 fallback
    let num = '#025';
    if (product) {
      // Try to extract number from URL or use index
      const m = (product.url || '').match(/#(\d+)/);
      if (m) num = '#' + m[1].padStart(3, '0');
      // Fallback: use the launch_no field if present
      if (product.launch_no) num = '#' + String(product.launch_no).padStart(3, '0');
    }
    const numWidth = Math.max(38, num.length * 8 + 16);
    const width = 42 + numWidth + 8 + 100;
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="36" viewBox="0 0 ' + width + ' 36">'
      + '<rect width="' + width + '" height="36" rx="18" fill="' + bg + '"' + border + '/>'
      + rocket
      + '<rect x="42" y="9" width="' + numWidth + '" height="18" rx="9" fill="' + pillBg + '"' + pillBorder + '/>'
      + '<text x="' + (42 + numWidth / 2) + '" y="22" text-anchor="middle" font-family="Inter,-apple-system,\'Segoe UI\',Roboto,sans-serif" font-size="11" font-weight="700" fill="' + pillText + '">' + escXml(num) + '</text>'
      + '<text x="' + (42 + numWidth + 8) + '" y="22.5" font-family="Inter,-apple-system,\'Segoe UI\',Roboto,sans-serif" font-size="12.5" font-weight="600" fill="' + textColor + '">on <tspan fill="' + accent + '">launch.arr.club</tspan></text>'
      + '</svg>';
  }

  const headers = cors(new Headers({
    'content-type': 'image/svg+xml',
    'cache-control': 'public, max-age=3600',
  }));
  return new Response(svg, { headers });
}

/* ---------- analytics: view/click tracking ---------- */
async function trackEvent(env, type, slug) {
  const key = 'stats/' + slug + '.json';
  let stats = { views: 0, clicks: 0 };
  try {
    const obj = await env.IMAGES.get(key);
    if (obj) stats = await obj.json();
  } catch (e) {}
  if (type === 'view') stats.views = (stats.views || 0) + 1;
  if (type === 'click') stats.clicks = (stats.clicks || 0) + 1;
  stats.updated = new Date().toISOString().slice(0, 10);
  await env.IMAGES.put(key, JSON.stringify(stats), {
    httpMetadata: { contentType: 'application/json' },
  });
}

async function getStats(env, slug) {
  const key = 'stats/' + slug + '.json';
  try {
    const obj = await env.IMAGES.get(key);
    if (obj) return await obj.json();
  } catch (e) {}
  return { views: 0, clicks: 0 };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(new Headers()) });
    }

    // ---- Dynamic badge SVG ----
    // GET /badge/:slug.svg?style=numbered|revenue&theme=light|dark
    // Generates a personalized badge with the product's launch number and revenue
    if (request.method === 'GET' && url.pathname.startsWith('/badge/') && url.pathname.endsWith('.svg')) {
      const slug = url.pathname.slice(7, -4); // remove /badge/ and .svg
      const style = url.searchParams.get('style') || 'numbered';
      const theme = url.searchParams.get('theme') || 'light';
      return await badgeSvg(slug, style, theme, env);
    }

    // ---- Analytics: track page views and outbound clicks ----
    // POST /track {type: 'view'|'click', slug: 'product-slug'}
    if (request.method === 'POST' && url.pathname === '/track') {
      try {
        const body = await request.json();
        const type = body.type;
        const slug = String(body.slug || '').replace(/[^a-z0-9-]/g, '').slice(0, 50);
        if ((type === 'view' || type === 'click') && slug) {
          await trackEvent(env, type, slug);
        }
      } catch (e) {}
      const headers = cors(new Headers({ 'content-type': 'application/json' }));
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    // GET /stats/:slug - get view/click counts (public, for founder dashboard)
    if (request.method === 'GET' && url.pathname.startsWith('/stats/')) {
      const slug = url.pathname.slice(7).replace(/[^a-z0-9-]/g, '').slice(0, 50);
      const stats = await getStats(env, slug);
      return json(stats);
    }

    // ---- Stripe-verified MRR ----
    // POST /stripe/connect {slug, stripe_key}
    if (request.method === 'POST' && url.pathname === '/stripe/connect') {
      return await handleStripeConnect(request, env);
    }
    // GET /stripe/mrr/:slug
    if (request.method === 'GET' && url.pathname.startsWith('/stripe/mrr/')) {
      const slug = url.pathname.slice(12).replace(/[^a-z0-9-]/g, '').slice(0, 50);
      return await handleStripeMrr(slug, env);
    }
    // GET /stripe/milestones/:slug - milestone crossings, newest first
    if (request.method === 'GET' && url.pathname.startsWith('/stripe/milestones/')) {
      const slug = url.pathname.slice(19).replace(/[^a-z0-9-]/g, '').slice(0, 50);
      return await handleStripeMilestones(slug, env);
    }
    // GET /stripe/refresh (cron or manual, token-gated)
    if (request.method === 'GET' && url.pathname === '/stripe/refresh') {
      if (!reviewAuthed(request, url, env)) return json({ error: 'unauthorized' }, 401);
      const result = await refreshAllStripeMrr(env);
      return json(result);
    }

    // ---- Claim interest ----
    // POST /claim-interest {slug, email} -> saves founder claim intent to KV
    if (request.method === 'POST' && url.pathname === '/claim-interest') {
      let data;
      try { data = await request.json(); }
      catch (e) { return json({ error: 'invalid JSON' }, 400); }
      const slug = String(data.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);
      const email = String(data.email || '').trim().toLowerCase().slice(0, 120);
      if (!slug) return json({ error: 'missing slug' }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'invalid email' }, 400);
      if (!env.STRIPE_KV) return json({ error: 'KV not configured' }, 500);
      const key = 'claim:' + slug + ':' + md5(email);
      await env.STRIPE_KV.put(key, JSON.stringify({ email: email, slug: slug, created_at: new Date().toISOString() }));
      return json({ ok: true });
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

  async scheduled(event, env, ctx) {
    // Daily cron: refresh all Stripe-verified MRR
    ctx.waitUntil(refreshAllStripeMrr(env));
  },
};

/* ---------- Stripe-verified MRR ---------- */
// POST /stripe/connect {slug, stripe_key} -> validates key, computes MRR, stores in KV
// GET  /stripe/mrr/:slug -> returns cached {mrr_cents, currency, updated_at, verified}
// KV binding required: STRIPE_KV

async function stripeApi(key, path) {
  const r = await fetch('https://api.stripe.com' + path, {
    headers: { 'Authorization': 'Bearer ' + key },
  });
  if (!r.ok) {
    const t = await r.text().catch(function(){ return ''; });
    throw new Error('Stripe API ' + r.status + ': ' + t.slice(0, 200));
  }
  return await r.json();
}

function calcMrrCents(subscriptions) {
  let total = 0;
  const subs = subscriptions.data || [];
  for (const sub of subs) {
    if (sub.status !== 'active' && sub.status !== 'trialing') continue;
    const items = (sub.items && sub.items.data) || [];
    for (const item of items) {
      const price = item.price || {};
      const unit = price.unit_amount || 0;
      const qty = item.quantity || 1;
      const interval = (price.recurring && price.recurring.interval) || 'month';
      const count = price.recurring && price.recurring.interval_count ? price.recurring.interval_count : 1;
      let monthly = 0;
      if (interval === 'month') monthly = (unit * qty) / count;
      else if (interval === 'year') monthly = (unit * qty) / (12 * count);
      else if (interval === 'week') monthly = (unit * qty * 52) / (12 * count);
      else if (interval === 'day') monthly = (unit * qty * 365) / (12 * count);
      total += monthly;
    }
  }
  return Math.round(total);
}

async function handleStripeConnect(request, env) {
  if (!env.STRIPE_KV) return json({ error: 'stripe KV not configured' }, 500);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON' }, 400); }
  const slug = String(body.slug || '').replace(/[^a-z0-9-]/g, '').slice(0, 50);
  const key = String(body.stripe_key || '').trim();
  if (!slug || !key) return json({ error: 'slug and stripe_key required' }, 400);
  if (!key.startsWith('rk_')) return json({ error: 'must be a Restricted API key (starts with rk_)' }, 400);

  // Validate key by fetching subscriptions
  let mrrCents, currency;
  try {
    const subs = await stripeApi(key, '/v1/subscriptions?status=active&limit=100');
    mrrCents = calcMrrCents(subs);
    // Get currency from first subscription or default USD
    currency = 'usd';
    const firstSub = (subs.data || [])[0];
    if (firstSub && firstSub.currency) currency = firstSub.currency;
  } catch (e) {
    return json({ error: 'could not validate Stripe key: ' + e.message }, 400);
  }

  const record = {
    slug: slug,
    stripe_key: key, // restricted key, stored in KV (not in git)
    mrr_cents: mrrCents,
    currency: currency,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    verified: true,
  };
  await env.STRIPE_KV.put('stripe:' + slug, JSON.stringify(record));
  return json({ ok: true, slug: slug, mrr_cents: mrrCents, currency: currency, verified: true });
}

async function handleStripeMrr(slug, env) {
  if (!env.STRIPE_KV) return json({ error: 'not configured' }, 500);
  const raw = await env.STRIPE_KV.get('stripe:' + slug);
  if (!raw) return json({ verified: false });
  const rec = JSON.parse(raw);
  return json({
    verified: true,
    slug: rec.slug,
    mrr_cents: rec.mrr_cents,
    currency: rec.currency,
    updated_at: rec.updated_at,
  });
}

const MILESTONE_THRESHOLDS = [100000, 500000, 1000000, 2500000, 5000000, 10000000, 25000000, 50000000, 100000000]; // cents: $1k, $5k, $10k, $25k, $50k, $100k, $250k, $500k, $1M

async function checkMilestones(env, slug, oldCents, newCents) {
  if (!Number.isFinite(oldCents) || !Number.isFinite(newCents) || newCents <= oldCents) return [];
  const crossed = [];
  const ts = Math.floor(Date.now() / 1000);
  for (const t of MILESTONE_THRESHOLDS) {
    if (oldCents < t && t <= newCents) {
      const rec = { slug: slug, threshold_cents: t, mrr_cents: newCents, crossed_at: new Date().toISOString() };
      await env.STRIPE_KV.put('milestone:' + slug + ':' + t + ':' + ts, JSON.stringify(rec));
      crossed.push(t);
    }
  }
  return crossed;
}

async function handleStripeMilestones(slug, env) {
  if (!env.STRIPE_KV) return json({ error: 'stripe KV not configured' }, 500);
  const list = await env.STRIPE_KV.list({ prefix: 'milestone:' + slug + ':' });
  const out = [];
  for (const k of list.keys) {
    try { out.push(JSON.parse(await env.STRIPE_KV.get(k.name))); } catch (e) {}
  }
  out.sort(function(a, b){ return a.crossed_at < b.crossed_at ? 1 : -1; });
  return json({ slug: slug, milestones: out });
}

async function refreshAllStripeMrr(env) {
  if (!env.STRIPE_KV) return { error: 'no KV' };
  const list = await env.STRIPE_KV.list({ prefix: 'stripe:' });
  let ok = 0, fail = 0, milestones = 0;
  for (const k of list.keys) {
    try {
      const raw = await env.STRIPE_KV.get(k.name);
      const rec = JSON.parse(raw);
      const slug = k.name.slice('stripe:'.length);
      const oldCents = rec.mrr_cents;
      const subs = await stripeApi(rec.stripe_key, '/v1/subscriptions?status=active&limit=100');
      rec.mrr_cents = calcMrrCents(subs);
      rec.updated_at = new Date().toISOString();
      await env.STRIPE_KV.put(k.name, JSON.stringify(rec));
      milestones += (await checkMilestones(env, slug, oldCents, rec.mrr_cents)).length;
      ok++;
    } catch (e) { fail++; }
  }
  return { ok: ok, fail: fail, total: list.keys.length, milestones: milestones };
}
