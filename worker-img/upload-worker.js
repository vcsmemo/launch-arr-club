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

function splitParas(text) {
  var t = String(text == null ? '' : text).trim();
  if (!t) return [];
  if (t.length <= 300) return [t];
  var parts = t.match(/[^.!?]+[.!?]+["\u201d']?\s*/g) || [t];
  return parts.map(function (s) { return s.trim(); }).filter(Boolean);
}

function weekArchivePath(now) {
  var d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  var dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  var firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  var week = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 24 * 3600 * 1000));
  return d.getUTCFullYear() + '/w' + week + '/index.html';
}

function archiveCard(d, slug, launchNo) {
  var cat = (d.categories && d.categories.length ? d.categories[0] : 'Product');
  var logo = d.logo
    ? '      <img class="lc-logo" src="' + esc(d.logo) + '" alt="' + esc(d.name) + '">'
    : '      <span class="lc-logo-ph">' + esc(String(d.name || '?').charAt(0)) + '</span>';
  return (
    '      <a class="launch-card" href="/launches/' + slug + '/">' + '\n' +
    logo + '\n' +
    '        <div class="lc-main">' + '\n' +
    '          <h3><span class="launch-no">#' + launchNo + '</span> ' + esc(d.name) + '</h3>' + '\n' +
    '          <p class="lc-tag">' + esc(d.tagline || '') + '</p>' + '\n' +
    '          <div class="lc-meta">' + '\n' +
    '            <div class="lc-m"><span>Category</span><b>' + esc(cat) + '</b></div>' + '\n' +
    '          </div>' + '\n' +
    '        </div>' + '\n' +
    '      </a>' + '\n'
  );
}

const STRIPE_BUTTON_HTML = `      <button class="stripe-verify-btn" data-stripe-connect>
        <span>Celebrate with Stripe</span>
        <svg width="53" height="22" viewBox="54 36 360.02 149.84" role="img" aria-label="Stripe"><g fill="#635BFF" fill-rule="evenodd" clip-rule="evenodd"><path d="M414,113.4c0-25.6-12.4-45.8-36.1-45.8c-23.8,0-38.2,20.2-38.2,45.6c0,30.1,17,45.3,41.4,45.3c11.9,0,20.9-2.7,27.7-6.5v-20c-6.8,3.4-14.6,5.5-24.5,5.5c-9.7,0-18.3-3.4-19.4-15.2h48.9C413.8,121,414,115.8,414,113.4z M364.6,103.9c0-11.3,6.9-16,13.2-16c6.1,0,12.6,4.7,12.6,16H364.6z"/><path d="M301.1,67.6c-9.8,0-16.1,4.6-19.6,7.8l-1.3-6.2h-22v116.6l25-5.3l0.1-28.3c3.6,2.6,8.9,6.3,17.7,6.3c17.9,0,34.2-14.4,34.2-46.1C335.1,83.4,318.6,67.6,301.1,67.6z M295.1,136.5c-5.9,0-9.4-2.1-11.8-4.7l-0.1-37.1c2.6-2.9,6.2-4.9,11.9-4.9c9.1,0,15.4,10.2,15.4,23.3C310.5,126.5,304.3,136.5,295.1,136.5z"/><polygon points="223.8,61.7 248.9,56.3 248.9,36 223.8,41.3"/><rect x="223.8" y="69.3" width="25.1" height="87.5"/><path d="M196.9,76.7l-1.6-7.4h-21.6v87.5h25V97.5c5.9-7.7,15.9-6.3,19-5.2v-23C214.5,68.1,202.8,65.9,196.9,76.7z"/><path d="M146.9,47.6l-24.4,5.2l-0.1,80.1c0,14.8,11.1,25.7,25.9,25.7c8.2,0,14.2-1.5,17.5-3.3V135c-3.2,1.3-19,5.9-19-8.9V90.6h19V69.3h-19L146.9,47.6z"/><path d="M79.3,94.7c0-3.9,3.2-5.4,8.5-5.4c7.6,0,17.2,2.3,24.8,6.4V72.2c-8.3-3.3-16.5-4.6-24.8-4.6C67.5,67.6,54,78.2,54,95.9c0,27.6,38,23.2,38,35.1c0,4.6-4,6.1-9.6,6.1c-8.3,0-18.9-3.4-27.3-8v23.8c9.3,4,18.7,5.7,27.3,5.7c20.8,0,35.1-10.3,35.1-28.2C117.4,100.6,79.3,105.9,79.3,94.7z"/></g></svg>
      </button>`;

const STRIPE_MODAL_HTML = `<!-- Stripe Connect Modal -->
<div id="stripeModal" class="modal" hidden>
  <div class="modal-box">
    <h3>Celebrate your growth with live data</h3>
    <p class="modal-sub">Connect a Stripe <b>Restricted API key</b> (read-only). You share the numbers — we turn them into a celebration card: live MRR, growth and milestones, updated daily and ready to share. Your key is stored securely and never shown publicly.</p>
    <ol class="modal-steps">
      <li>Go to <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener">Stripe Dashboard → API keys</a></li>
      <li>Click "Create restricted key", give it a name like "MilestoneWins"</li>
      <li>Grant <b>read</b> access to: Subscriptions, Prices, Products</li>
      <li>Paste the key below (starts with <code>rk_</code>)</li>
    </ol>
    <input type="text" id="stripeKeyInput" placeholder="rk_live_..." autocomplete="off" spellcheck="false">
    <div class="modal-err" id="stripeErr" hidden></div>
    <div class="modal-actions">
      <button class="btn ghost" id="stripeCancel">Cancel</button>
      <button class="btn" id="stripeSubmit">Verify &amp; Connect</button>
    </div>
  </div>
</div>`;

const STRIPE_SCRIPT = `<script>
(function(){
  var modal = document.getElementById('stripeModal');
  var openBtns = document.querySelectorAll('[data-stripe-connect]');
  var cancel = document.getElementById('stripeCancel');
  var submit = document.getElementById('stripeSubmit');
  var input = document.getElementById('stripeKeyInput');
  var err = document.getElementById('stripeErr');
  var slug = (location.pathname.match(/\\/launches\\/([^/]+)\\//) || [])[1] || '';
  openBtns.forEach(function(b){
    b.addEventListener('click', function(){ modal.hidden = false; input.focus(); });
  });
  cancel.addEventListener('click', function(){ modal.hidden = true; err.hidden = true; });
  modal.addEventListener('click', function(e){ if(e.target === modal){ modal.hidden = true; } });
  submit.addEventListener('click', function(){
    var key = input.value.trim();
    if(!key.startsWith('rk_')){ err.textContent = 'Key must start with rk_ (Restricted key)'; err.hidden = false; return; }
    submit.disabled = true; submit.textContent = 'Verifying…'; err.hidden = true;
    fetch('https://launch-arr-club-img.johntian2015.workers.dev/stripe/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: slug, stripe_key: key })
    }).then(function(r){ return r.json(); }).then(function(d){
      if(d.ok){
        modal.innerHTML = '<div class="modal-box"><h3>✓ Connected</h3><p class="modal-sub">Your live MRR is now verified and will update daily.</p><div class="modal-actions"><button class="btn" onclick="location.reload()">Done</button></div></div>';
      } else {
        err.textContent = d.error || 'Verification failed'; err.hidden = false;
        submit.disabled = false; submit.textContent = 'Verify & Connect';
      }
    }).catch(function(){
      err.textContent = 'Network error, try again'; err.hidden = false;
      submit.disabled = false; submit.textContent = 'Verify & Connect';
    });
  });
  // Check if already verified, show live MRR
  fetch('https://launch-arr-club-img.johntian2015.workers.dev/stripe/mrr/' + slug)
    .then(function(r){ return r.json(); }).then(function(d){
      if(d.verified){
        document.querySelectorAll('[data-stripe-status]').forEach(function(el){
          var mrr = '$' + (d.mrr_cents / 100).toLocaleString(undefined, {maximumFractionDigits: 0});
          el.innerHTML = '<span class="verified-badge">✓ Stripe-verified</span> <b>' + mrr + '</b> <small>MRR · live</small>';
        });
        document.querySelectorAll('[data-stripe-connect]').forEach(function(b){ b.style.display = 'none'; });
      }
    }).catch(function(){});
})();
`;

const TRACK_SCRIPT = `<script>
(function(){
  var m = location.pathname.match(/\\/launches\\/([^/]+)\\//);
  if (!m) return;
  var slug = m[1];
  var W = 'https://launch-arr-club-img.johntian2015.workers.dev';
  try {
    fetch(W + '/track', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({type: 'view', slug: slug})
    });
  } catch(e) {}
  document.addEventListener('click', function(ev){
    var a = ev.target.closest('a[href^="http"]');
    if (a && a.hostname !== location.hostname) {
      try {
        fetch(W + '/track', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({type: 'click', slug: slug})
        });
      } catch(e) {}
    }
  });
})();
</script>`;

const TIMELINE_STYLE = `<style>
.growth-timeline { margin: 24px 0; }
.timeline-track { position: relative; padding-left: 32px; }
.timeline-track::before { content: ''; position: absolute; left: 12px; top: 8px; bottom: 8px; width: 2px; background: #e2e8f0; }
.timeline-item { position: relative; margin-bottom: 24px; }
.timeline-item::before { content: ''; position: absolute; left: -24px; top: 4px; width: 12px; height: 12px; border-radius: 50%; background: #0d9488; border: 3px solid #fff; box-shadow: 0 0 0 2px #0d9488; }
.timeline-item.milestone::before { background: #f59e0b; box-shadow: 0 0 0 2px #f59e0b; }
.timeline-date { font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
.timeline-rev { font-size: 20px; font-weight: 700; color: #0f172a; margin: 4px 0; }
.timeline-note { font-size: 14px; color: #475569; }
.timeline-growth { display: inline-block; font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
.timeline-growth.up { background: #dcfce7; color: #166534; }
.share-milestone { margin-top: 16px; padding: 16px; background: #f0fdfa; border-radius: 12px; text-align: center; }
.share-milestone p { font-size: 14px; color: #475569; margin-bottom: 12px; }
</style>`;

const TIMELINE_SCRIPT_A = `  <script>
  (function(){
    var slug = `;

const TIMELINE_SCRIPT_B = `
    fetch('/launches.json').then(function(r){ return r.json(); }).then(function(items){
      var product = items.find(function(p){ 
        return p.url && p.url.indexOf('/' + slug + '/') !== -1; 
      });
      if(!product || !product.revenue_history || !product.revenue_history.length){
        document.getElementById('timelineTrack').innerHTML = '<div class="timeline-item"><div class="timeline-note">No revenue shared yet.</div></div>';
        return;
      }
      var html = product.revenue_history.map(function(h){
        return '<div class="timeline-item">'
          + '<div class="timeline-date">' + h.date + '</div>'
          + '<div class="timeline-rev">' + h.revenue + '</div>'
          + (h.note ? '<div class="timeline-note">' + String(h.note).replace(/ \\u00b7 Founder-reported$/, '') + '</div>' : '')
          + '</div>';
      }).join('');
      document.getElementById('timelineTrack').innerHTML = html;
    }).catch(function(){
      document.getElementById('timelineTrack').innerHTML = '<div class="timeline-item"><div class="timeline-note">Could not load timeline.</div></div>';
    });
  })();
  </script>`;

const CANVAS_SCRIPT_A = `<script>
(function(){
  var slug = `;

const CANVAS_SCRIPT_B = `
  function roundRect(c, x, y, w, h, r){
    c.beginPath(); c.moveTo(x+r, y);
    c.arcTo(x+w, y, x+w, y+h, r); c.arcTo(x+w, y+h, x, y+h, r);
    c.arcTo(x, y+h, x, y, r); c.arcTo(x, y, x+w, y, r); c.closePath();
  }
  function hashStr(s){ var h = 2166136261; for(var i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function mulberry(seed){ return function(){ seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function downloadCelebration(){
    var card = document.getElementById('celebrateCard');
    if(!card) return;
    var name = card.dataset.name || 'Product';
    var revenue = card.dataset.revenue || '';
    var metric = card.dataset.metric || '';
    var founder = card.dataset.founder || '';
    var logo = card.dataset.logo || '';
    var W = 1200, H = 630;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    function draw(logoImg){
      var g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#1e1b4b'); g.addColorStop(0.58, '#3b0764'); g.addColorStop(1, '#701a3a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      var rnd = mulberry(hashStr(slug || name));
      var colors = ['#fbbf24', '#f472b6', '#5eead4', '#fdba74', '#fcd34d'];
      for(var i = 0; i < 80; i++){
        ctx.fillStyle = colors[Math.floor(rnd() * colors.length)];
        ctx.globalAlpha = 0.22 + rnd() * 0.5;
        ctx.beginPath(); ctx.arc(rnd() * W, rnd() * H, 3 + rnd() * 7, 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fcd34d'; ctx.font = '800 30px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillText('\\u2726 MILESTONEWINS CELEBRATES', 60, 86);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fbbf24'; ctx.font = '800 160px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.shadowColor = 'rgba(251,191,36,0.35)'; ctx.shadowBlur = 42;
      ctx.fillText(revenue || '\\u2013', W / 2, 352);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#e9d5ff'; ctx.font = '600 40px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillText((metric ? metric + ' ' : '') + 'milestone', W / 2, 418);
      var nm = name.length > 26 ? name.slice(0, 25) + '\\u2026' : name;
      ctx.font = '800 56px system-ui, -apple-system, "Segoe UI", sans-serif';
      var nw = ctx.measureText(nm).width;
      var fn = founder ? 'by ' + founder : '';
      ctx.font = '400 30px system-ui, -apple-system, "Segoe UI", sans-serif';
      var fw = fn ? ctx.measureText(fn).width : 0;
      var sx = (W - (108 + Math.max(nw, fw))) / 2;
      var ly = 468;
      ctx.textAlign = 'left';
      if(logoImg){
        ctx.save(); roundRect(ctx, sx, ly, 84, 84, 18); ctx.clip();
        ctx.drawImage(logoImg, sx, ly, 84, 84); ctx.restore();
      } else {
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath(); ctx.arc(sx + 42, ly + 42, 42, 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#1e1b4b'; ctx.font = '800 46px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(name.charAt(0).toUpperCase(), sx + 42, ly + 59); ctx.textAlign = 'left';
      }
      sx += 108;
      ctx.fillStyle = '#ffffff'; ctx.font = '800 56px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillText(nm, sx, ly + 54);
      if(fn){
        ctx.fillStyle = '#d8b4fe'; ctx.font = '400 30px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.fillText(fn, sx, ly + 96);
      }
      ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '600 26px system-ui, sans-serif';
      ctx.fillText('launch.arr.club', W - 60, H - 46); ctx.textAlign = 'left';
      cv.toBlob(function(blob){
        if(!blob) return;
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = slug + '-celebration.png';
        document.body.appendChild(a); a.click();
        setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500);
      }, 'image/png');
    }
    var finished = false;
    function finish(img){ if(finished) return; finished = true; draw(img); }
    if(logo){
      var im = new Image(); im.crossOrigin = 'anonymous';
      var to = setTimeout(function(){ finish(null); }, 3000);
      im.onload = function(){ clearTimeout(to); finish(im); };
      im.onerror = function(){ clearTimeout(to); finish(null); };
      im.src = logo;
    } else { finish(null); }
  }
  document.getElementById('dlCardBtn').addEventListener('click', downloadCelebration);
})();
`;


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

function detailPage(d, slug, launchNo, others, weekPath) {
  const now = new Date();
  const dateLong = now.getDate() + ' ' + MONTHS[now.getMonth()] + ' ' + now.getFullYear();
  const weekUrl = '/' + weekPath.replace(/\/index\.html$/, '/');
  const rev = revenueOf(d);
  const metricTxt = rev && rev.metric ? rev.metric : '';
  const cats = d.categories && d.categories.length ? d.categories : ['Product'];
  const catPills = cats.map(function (c) { return '<span class="tag cat">' + esc(c) + '</span>'; }).join('');
  const logoImg = d.logo
    ? '<img class="d-logo" src="' + esc(d.logo) + '" alt="' + esc(d.name) + ' logo">'
    : '<span class="d-logo-ph">' + esc(String(d.name || '?').charAt(0)) + '</span>';

  // story cards (submit flow: 5 structured answers; long ones split by sentence)
  const storyItems = [];
  (d.story || []).forEach(function (a, i) {
    a = a != null ? String(a).trim() : '';
    if (!a) return;
    storyItems.push({ label: STORY_QS[i] || ('Note ' + (i + 1)), paras: splitParas(a) });
  });
  const storyCards = storyItems.map(function (it, i) {
    const cls = i === storyItems.length - 1 ? 'story-card wide' : 'story-card';
    return '    <div class="' + cls + '"><h4>' + esc(it.label) + '</h4>' +
      it.paras.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') + '</div>';
  }).join('\n');
  const storySection = storyCards
    ? '  <h2 class="section-title caps"><span class="dot"></span>What ' + esc(d.name) + ' is about</h2>\n' +
      '  <div class="story-wrap">\n' +
      '    <div class="story-grid">\n' + storyCards + '\n    </div>\n  </div>\n\n'
    : '';

  // growth: "How they got there" (only when the founder shared it)
  const gw = d.growth || {};
  const gwRows = [];
  if (gw.first_user_source) gwRows.push(['First user came from', gw.first_user_source + (gw.first_user_detail ? ' — ' + gw.first_user_detail : '')]);
  if (gw.best_channel) gwRows.push(['Best channel so far', gw.best_channel]);
  if (gw.days_to_first_dollar) gwRows.push(['Days to first dollar', String(gw.days_to_first_dollar)]);
  const growthSection = gwRows.length
    ? '  <h2 class="section-title caps"><span class="dot"></span>How they got there</h2>\n' +
      '  <div class="story-wrap">\n' +
      '    <div class="story-grid">\n' +
      gwRows.map(function (r) { return '    <div class="story-card"><h4>' + esc(r[0]) + '</h4><p>' + esc(r[1]) + '</p></div>'; }).join('\n') +
      '\n    </div>\n  </div>\n\n'
    : '';

  // revenue hero + celebration card (only when revenue was shared)
  const sourceLink = d.source
    ? ' · <a href="' + esc(d.source) + '" target="_blank" rel="noopener">source ↗</a>'
    : '';
  const revenueHero = rev
    ? '  <div class="revenue-hero">\n' +
      '    <div class="rh-main">\n' +
      '      <span class="rh-label">Revenue</span>\n' +
      '      <div class="rh-value">' + esc(rev.amount) + '</div>\n' +
      '      <span class="rh-sub">' + (metricTxt ? esc(metricTxt) + ' · ' : '') + 'Founder-reported' + sourceLink + '</span>\n' +
      '    </div>\n' +
      '    <div class="rh-verify">\n' +
      '      <div class="stripe-verify-row" data-stripe-connect-v2>\n' +
      STRIPE_BUTTON_HTML + '\n' +
      '      <span data-stripe-status></span>\n' +
      '    </div>\n' +
      '    </div>\n' +
      '  </div>\n'
    : '';
  const ccLogo = d.logo
    ? '<img class="cc-logo" src="' + esc(d.logo) + '" alt="' + esc(d.name) + ' logo" loading="lazy" onerror="this.style.display=\'none\'">'
    : '<span class="cc-logo-ph">' + esc(String(d.name || '?').charAt(0)) + '</span>';
  const ccFounder = d.founder ? '\n        <div class="cc-founder">by ' + esc(d.founder) + '</div>' : '';
  const celebrateCard = rev
    ? '  <div class="celebrate-card" id="celebrateCard" data-slug="' + esc(slug) + '" data-name="' + esc(d.name) +
      '" data-revenue="' + esc(rev.amount) + '" data-metric="' + esc(metricTxt) + '" data-logo="' + esc(d.logo || '') +
      '" data-founder="' + esc(d.founder || '') + '">\n' +
      '    <div class="cc-confetti" aria-hidden="true"></div>\n' +
      '    <div class="cc-top">\n' +
      '      <span class="cc-brand">🎉 MILESTONEWINS CELEBRATES</span>\n' +
      '    </div>\n' +
      '    <div class="cc-hero">\n' +
      '      <div class="cc-amount">' + esc(rev.amount) + '</div>\n' +
      '      <div class="cc-metric">' + (metricTxt ? esc(metricTxt) + ' ' : '') + 'milestone</div>\n' +
      '    </div>\n' +
      '    <div class="cc-product">\n' +
      '      ' + ccLogo + '\n' +
      '      <div>\n' +
      '        <div class="cc-name">' + esc(d.name) + '</div>' + ccFounder + '\n' +
      '      </div>\n' +
      '    </div>\n' +
      '    <div class="cc-cta">\n' +
      '      <span>Built this? Share your next milestone.</span>\n' +
      '      <a class="cc-cta-btn" href="/submit.html">Share your milestone &rarr;</a>\n' +
      '    </div>\n' +
      '  </div>\n' +
      '  <div class="cc-dl-row">\n' +
      '    <button class="btn ghost" id="dlCardBtn">&#8681; Download celebration image</button>\n' +
      '  </div>\n\n'
    : '';

  const pricingLabel = priceLabelOf(d);
  const pricingSub = /free/i.test(pricingLabel) ? 'No cost to start' : 'Subscription plans';
  const makerSub = d.founder && /[,;&]| and /i.test(d.founder) ? 'Co-founders' : 'Co-founder';
  const statGrid =
    '  <div class="stat-grid">\n\n' +
    '    <div class="stat-card"><span>Pricing</span><b>' + esc(pricingLabel) + '</b><small>' + esc(pricingSub) + '</small></div>\n' +
    '    <div class="stat-card"><span>Launched</span><b>' + esc(dateLong) + '</b><small>L+0 &middot; Live on MilestoneWins</small></div>\n' +
    '    <div class="stat-card"><span>Category</span><div class="pills">' + catPills + '</div></div>\n' +
    '    <div class="stat-card"><span>Maker</span><b>' + esc(d.founder || '–') + '</b><small>' + makerSub + '</small></div>\n' +
    '  </div>\n\n';

  const timelineSection =
    TIMELINE_STYLE + '\n' +
    '  <h2 class="section-title caps"><span class="dot"></span>Growth timeline</h2>\n' +
    '  <div class="card growth-timeline">\n' +
    '    <div class="timeline-track" id="timelineTrack">\n' +
    '      <!-- Rendered from launches.json -->\n' +
    '    </div>\n' +
    '  </div>\n' +
    TIMELINE_SCRIPT_A + JSON.stringify(slug) + ';' + TIMELINE_SCRIPT_B + '\n\n';

  const moreRows = (others || []).map(function (o) {
    const logo = o.logo
      ? '<img src="' + esc(o.logo) + '" alt="' + esc(o.name) + ' logo" loading="lazy">'
      : '<span class="lc-logo-ph">' + esc(String(o.name || '?').charAt(0)) + '</span>';
    const revParts = (function (r) {
      if (!r) return null;
      const m = String(r).match(/(\$[\d.]+\s*[kKmM]?)\s*(.*)/);
      if (!m) return { amount: r, metric: '' };
      let metric = (m[2] || '').replace(/^\//, '').trim();
      const low = metric.toLowerCase();
      if (/mrr/.test(low) || low === 'mo') metric = 'MRR';
      else if (/30d/.test(low)) metric = '30-day';
      else if (/all-time/.test(low)) metric = 'all-time';
      else if (/total/.test(low)) metric = 'total';
      return { amount: m[1].trim(), metric: metric };
    })(o.revenue);
    const revHtml = revParts
      ? '<span class="more-rev">' + esc(revParts.amount) + (revParts.metric ? '<small>' + esc(revParts.metric) + '</small>' : '') + '</span>'
      : '';
    return '    <a class="more-row" href="' + esc(o.url) + '"><span class="more-rank">#' + esc(o.no) + '</span>' + logo +
      '<span class="more-main"><strong>' + esc(o.name) + '</strong><p>' + esc(o.tagline || '') + '</p>' +
      '<small>' + esc((o.categories || []).join(' · ')) + '</small></span>' + revHtml +
      '</a>';
  }).join('\n');

  const descBase = (d.description || d.tagline || '').trim();
  const metaDesc = (descBase + (rev ? ' ' + rev.amount + (rev.metric ? ' ' + rev.metric : '') + ', founder-reported.' : '')).slice(0, 160);
  const priceNum = (function () {
    const m = /([\d,.]+)/.exec(pricingLabel);
    return m ? m[1].replace(/,/g, '') : '0';
  })();

  return (
'<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>' + esc(d.name) + ' — ' + esc(d.tagline || '') + ' | MilestoneWins</title>\n' +
'<meta name="description" content="' + esc(metaDesc) + '">\n' +
'<link rel="canonical" href="https://launch.arr.club/launches/' + slug + '/">\n' +
'<link rel="icon" type="image/png" href="/favicon-64.png">\n' +
'<link rel="stylesheet" href="/style.css?v=20261006d">\n' +
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
'    <div class="nav-links"></div>\n' +
'    <div class="nav-auth" id="authSlot"></div>\n' +
'  </nav>\n' +
'</header>\n' +
'<main>\n' +
'  <nav class="crumbs"><a href="/">MilestoneWins</a> <span>&rsaquo;</span> <a href="/#recently">Launches</a> <span>&rsaquo;</span> <strong>' + esc(d.name) + '</strong><button class="copy-link" data-copy data-label="&#10697; copy link">&#10697; copy link</button></nav>\n' +
'\n' +
'  <div class="d-hero">\n' +
'    ' + logoImg + '\n' +
'    <div class="d-hero-main">\n' +
'      <div class="d-title-row"><h1>' + esc(d.name) + '</h1><span class="launch-no">#' + launchNo + '</span></div>\n' +
'      <p class="d-tagline">' + esc(d.tagline || '') + '</p>\n' +
'    </div>\n' +
'    <div class="d-hero-actions">\n' +
'      <button class="btn ghost" data-copy data-label="Share">Share</button>\n' +
'      <a class="btn dark" href="' + esc(d.url) + '" target="_blank" rel="noopener">Visit &#8599;</a>\n' +
'    </div>\n' +
'  </div>\n' +
revenueHero +
celebrateCard +
storySection +
growthSection +
statGrid +
timelineSection +
'  <h2 class="section-title caps"><span class="dot"></span>More launches <a class="view-all" href="' + weekUrl + '">View all &rsaquo;</a></h2>\n' +
'  <div class="more-list">\n' +
moreRows + '\n' +
'  </div>\n' +
DETAIL_SHARED_JS +
'</main>\n' +
'<footer class="site-footer">\n' +
'  <div class="footer-cols">\n' +
'    <div class="fcol"><h5>Discover</h5><a href="/#recently">Launches</a><a href="' + weekUrl + '">Weekly archive</a><a href="/#leaderboard">Leaderboard</a></div>\n' +
'    <div class="fcol"><h5>Alternatives</h5><a href="/alternatives/product-hunt/">Product Hunt alternative</a><a href="/alternatives/faslaunch/">FasLaunch alternative</a></div>\n' +
'    <div class="fcol"><h5>Launch</h5><a href="/launch-your-startup/">Launch your startup</a><a href="/launch-your-ai-tool/">Launch your AI tool</a><a href="/launch-your-saas/">Launch your SaaS</a></div>\n' +
'    <div class="fcol"><h5>For agents</h5><a href="/llms.txt">llms.txt</a><a href="/submit.html">Submit</a><a href="/privacy.html">Privacy</a></div>\n' +
'  </div>\n' +
'  <div class="footer-inner">\n' +
'    <span>© 2026 MilestoneWins · <a href="https://www.toolpilot.ai">Listed on ToolPilot</a> · <a target="_blank" href="https://goodaitools.com/ai/launch-arr"><img src="https://goodaitools.com/assets/images/badge.png" alt="Good AI Tools" style="height:20px;vertical-align:middle"></a></span>\n' +
'  </div>\n' +
'</footer>\n' +
'<script src="/auth.js"></script>\n' +
TRACK_SCRIPT + '\n' +
STRIPE_MODAL_HTML + '\n' +
STRIPE_SCRIPT + '\n' +
CANVAS_SCRIPT_A + JSON.stringify(slug) + ';' + CANVAS_SCRIPT_B + '\n' +
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

  // current files (with shas for update). Homepage renders client-side from
  // launches.json, so index.html needs no edit. Archive path follows the ISO week.
  const weekPath = weekArchivePath(new Date());
  const [launchesF, sitemapF] = await Promise.all([
    ghFileSha(env, 'launches.json'),
    ghFileSha(env, 'sitemap.xml'),
  ]);
  let archiveF = null;
  try { archiveF = await ghFileSha(env, weekPath); } catch (e) { archiveF = null; }
  const launchesJson0 = launchesF.text, sitemap0 = sitemapF.text;

  // next launch number (from launches.json; index.html is client-rendered)
  const idx0 = JSON.parse(launchesJson0);
  let maxNo = 0;
  idx0.forEach(function (e) {
    const n = parseInt(e.launch_no, 10);
    if (n > maxNo) maxNo = n;
  });
  const launchNo = String(maxNo + 1).padStart(3, '0');

  // launch index + numbers (feed order == launches.json order, newest first)
  const idx = idx0;
  const selfUrl = 'https://launch.arr.club/launches/' + slug + '/';
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
        name: e.name, tagline: e.tagline,
        url: (function (u) { var mm = String(u || '').match(/(\/launches\/[^/]+\/)/); return mm ? mm[1] : u; })(e.url),
        logo: e.logo,
        categories: [e.category || 'Product'],
        no: e.launch_no ? String(e.launch_no).padStart(3, '0') : '–––',
        revenue: e.revenue || ''
      };
    });
  // 1. detail page (current template)
  const detail = detailPage(d, slug, launchNo, others, weekPath);

  // 2. launches.json (matches the pipeline schema)
  const rev = revenueOf(d);
  const today = todayISO();
  const revStr = rev ? rev.amount + (rev.metric ? ' ' + rev.metric : '') : null;
  idx.unshift({
    launch_no: parseInt(launchNo, 10),
    name: d.name,
    slug: slug,
    tagline: d.tagline || '',
    url: 'https://launch.arr.club/launches/' + slug + '/',
    website: d.url,
    logo: d.logo || null,
    revenue: revStr,
    revenue_metric: rev && rev.metric ? rev.metric : null,
    founder: d.founder || null,
    category: (d.categories && d.categories[0]) || 'Product',
    pricing: d.pricing || null,
    launched: today,
    source: d.source || null,
    source_label: d.source_label || null,
    revenue_history: revStr ? [{ date: today, revenue: revStr, note: 'Launch · Founder-reported' }] : [],
    growth: (d.growth && (d.growth.first_user_source || d.growth.best_channel || d.growth.days_to_first_dollar)) ? {
      first_user_source: d.growth.first_user_source || null,
      first_user_detail: d.growth.first_user_detail || null,
      best_channel: d.growth.best_channel || null,
      days_to_first_dollar: d.growth.days_to_first_dollar || null
    } : null,
  });
  const launchesJson = JSON.stringify(idx);

  // 3. sitemap
  let sitemap = sitemap0.replace(
    /(<loc>https:\/\/launch\.arr\.club\/<\/loc><lastmod>)\d{4}-\d{2}-\d{2}/,
    '$1' + today
  );
  sitemap = sitemap.replace(
    '</urlset>',
    '  <url><loc>https://launch.arr.club/launches/' + slug + '/</loc><lastmod>' + today + '</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>\n</urlset>'
  );

  // 4. weekly archive (only when this week's page already exists)
  const msg = 'Publish ' + d.name + ' (#' + launchNo + ') via review console';
  const updates = [
    { path: 'launches/' + slug + '/index.html', content: detail, sha: null },
    { path: 'launches.json', content: launchesJson, sha: launchesF.sha },
    { path: 'sitemap.xml', content: sitemap, sha: sitemapF.sha },
  ];
  if (archiveF) {
    let archive = archiveF.text.replace('<div class="feed">', '<div class="feed">\n' + archiveCard(d, slug, launchNo).replace(/\n$/, ''));
    archive = archive.replace(/(\d+) launches<\/strong>/, function (full, n) {
      return parseInt(n, 10) + 1 + ' launches</strong>';
    });
    if (revStr) {
      archive = archive.replace(/(\d+) with shared revenue/, function (full, n) {
        return parseInt(n, 10) + 1 + ' with shared revenue';
      });
    }
    updates.push({ path: weekPath, content: archive, sha: archiveF.sha });
  }
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
