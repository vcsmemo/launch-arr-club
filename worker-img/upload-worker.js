/* milestonewins.com image upload + submissions inbox + review console Worker
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

const ALLOW_ORIGIN = 'https://milestonewins.com';
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

/* Founder names with X links. handles: array of X handles parallel to names
   split on + / & / ,  — names without a handle render as plain text. */
function founderLinks(founderStr, handles) {
  if (!founderStr) return esc('–');
  handles = handles || [];
  var tokens = String(founderStr).split(/(\s*\+\s*|\s*&\s*|,\s*)/);
  var hi = 0, out = [];
  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i];
    if (/^\s*\+\s*$|^\s*&\s*$|^,\s*$/.test(tok)) { out.push(esc(tok)); continue; }
    var name = tok.trim(), h = hi < handles.length ? handles[hi] : null;
    hi++;
    if (h && name) out.push('<a class="x-link" href="https://x.com/' + esc(h) + '" target="_blank" rel="noopener">' + esc(name) + '</a>');
    else out.push(esc(name));
  }
  return out.join('');
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

/* Verify a Google ID token via Google's tokeninfo endpoint and return the
   user's stable `sub`, or null. Volume is tiny (a few submits/day), so the
   extra round-trip beats vendoring JWKS verification into the worker. */
var GOOGLE_CLIENT_ID = '659455206571-e0rd1e7iq8os25s4441elss3960bkfjs.apps.googleusercontent.com';
async function googleSubFromToken(idToken) {
  if (!idToken || typeof idToken !== 'string' || idToken.length > 8192) return null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (!r.ok) return null;
    const d = await r.json();
    if (d.aud !== GOOGLE_CLIENT_ID || !d.sub) return null;
    if (d.exp && Number(d.exp) * 1000 < Date.now() - 60000) return null;
    return String(d.sub);
  } catch (e) {
    return null;
  }
}

/* Transactional email via Resend. Returns {ok:true,id} or {ok:false,error}.
   Never throws — email failures must not break submit/approve flows. */
var RESEND_FROM = 'MilestoneWins <hello@milestonewins.com>';
var RESEND_REPLY_TO = 'hello@milestonewins.com';
async function sendEmail(env, to, subject, html) {
  try {
    if (!env.RESEND_API_KEY) return { ok: false, error: 'resend not configured' };
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, error: 'bad recipient' };
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        reply_to: RESEND_REPLY_TO,
        subject: subject,
        html: html,
      }),
    });
    const j = await r.json().catch(function(){ return {}; });
    if (!r.ok) return { ok: false, error: (j && j.message) || ('resend ' + r.status) };
    return { ok: true, id: j.id };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* Stripe webhook: verify signature, promote paid submissions.
   POST /stripe-webhook — Stripe sends checkout.session.completed.
   Payment Link passes ?client_reference_id=<pending_key> which lands in the session. */
async function verifyStripeWebhook(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  var parts = {};
  sigHeader.split(',').forEach(function(p){
    var kv = p.split('=');
    if (kv.length === 2) parts[kv[0].trim()] = kv[1].trim();
  });
  var t = parts.t, sig = parts.v1;
  if (!t || !sig) return false;
  // Reject stale (>5 min) to prevent replay
  if (Math.abs(Date.now()/1000 - parseInt(t,10)) > 300) return false;
  var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  var mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + rawBody));
  var hex = Array.from(new Uint8Array(mac)).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
  return hex === sig;
}

async function handleStripeWebhook(request, env) {
  var rawBody = await request.text();
  var sig = request.headers.get('stripe-signature') || '';
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'webhook not configured' }, 500);
  var ok = await verifyStripeWebhook(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return json({ error: 'bad signature' }, 400);
  var evt;
  try { evt = JSON.parse(rawBody); } catch (e) { return json({ error: 'bad json' }, 400); }
  if (evt.type === 'checkout.session.completed') {
    var session = evt.data && evt.data.object || {};
    // Only honor our $5 payment link
    var ref = session.client_reference_id || '';
    if (ref && /^pending_payment\//.test(ref)) {
      var obj = await env.IMAGES.get(ref);
      if (obj) {
        var data = await obj.text();
        var d;
        try { d = JSON.parse(data); } catch (e) { d = null; }
        if (d) {
          d.tier = 'paid';
          d.paid_at = new Date().toISOString();
          d.stripe_session = session.id || '';
          d.stripe_payment_intent = session.payment_intent || '';
          var destKey = ref.replace(/^pending_payment\//, 'submissions/');
          await env.IMAGES.put(destKey, JSON.stringify(d), {
            httpMetadata: { contentType: 'application/json' },
          });
          await env.IMAGES.delete(ref);
          // Notify submitter
          if (d.founder_email) {
            sendEmail(env, d.founder_email,
              'Payment received — your launch is in review 🎉',
              emailShell('Payment received 🎉',
                '<p>Hi ' + esc(d.founder || 'there') + ',</p>'
                + '<p>We received your $5 payment for <strong>' + esc(d.name || 'your product') + '</strong>.</p>'
                + '<p>Your launch is now in our review queue and will go live shortly.</p>'
                + '<p>— The MilestoneWins team</p>'));
          }
          return json({ ok: true, promoted: destKey });
        }
      }
      return json({ ok: false, error: 'pending submission not found' });
    }
    return json({ ok: true, ignored: true });
  }
  if (evt.type === 'charge.refunded') {
    // A $5 payment was refunded — pull the submission back out of the review queue.
    var charge = evt.data && evt.data.object || {};
    var pi = charge.payment_intent || '';
    if (!pi) return json({ ok: true, ignored: true });
    var listed = await env.IMAGES.list({ prefix: 'submissions/' });
    for (var i = 0; i < listed.objects.length; i++) {
      var o = listed.objects[i];
      var obj = await env.IMAGES.get(o.key);
      if (!obj) continue;
      var d = null;
      try { d = await obj.json(); } catch (e) {}
      if (d && d.stripe_payment_intent === pi) {
        d.refunded_at = new Date().toISOString();
        delete d.paid_at;
        var refundKey = o.key.replace(/^submissions\//, 'pending_payment/');
        await env.IMAGES.put(refundKey, JSON.stringify(d), {
          httpMetadata: { contentType: 'application/json' },
        });
        await env.IMAGES.delete(o.key);
        if (d.founder_email) {
          sendEmail(env, d.founder_email,
            'Payment refunded — submission on hold',
            emailShell('Payment refunded',
              '<p>Hi ' + esc(d.founder || 'there') + ',</p>'
              + '<p>The $5 payment for <strong>' + esc(d.name || 'your product') + '</strong> was refunded, so the submission has been moved back out of our review queue.</p>'
              + '<p>If you\'d like to proceed, you can submit again via the $5 paid tier.</p>'
              + '<p>— The MilestoneWins team</p>'));
        }
        return json({ ok: true, demoted: refundKey });
      }
    }
    return json({ ok: true, ignored: true });
  }
  return json({ ok: true, ignored: true });
}

function emailShell(title, bodyHtml) {
  return '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;">'
    + '<div style="font-size:20px;font-weight:700;margin-bottom:16px;">' + title + '</div>'
    + bodyHtml
    + '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#999;">MilestoneWins — celebrating founder milestones<br><a href="https://milestonewins.com" style="color:#0d9488;">milestonewins.com</a></div>'
    + '</div>';
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
    return html.indexOf('milestonewins.com/badges/') !== -1;
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
  // Handle both formats: string "$3M ARR" + revenue_metric, or object {amount, metric}
  if (typeof d.revenue === 'string' && d.revenue.trim()) {
    const amount = d.revenue.trim();
    const metric = (d.revenue_metric || '').trim();
    return { amount: amount, metric: metric };
  }
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
      ctx.fillText('milestonewins.com', W - 60, H - 46); ctx.textAlign = 'left';
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
  /* Ranking card: dark teal, big rank number. No slogan — celebration only. */
  function downloadRankingCard(){
    var card = document.getElementById('celebrateCard');
    if(!card) return;
    var slug = card.dataset.slug || '';
    var name = card.dataset.name || 'Product';
    var revenue = card.dataset.revenue || '';
    var metric = card.dataset.metric || '';
    var logo = card.dataset.logo || '';
    function annualized(s){
      s = String(s || '');
      var m = s.match(/\$([\d,.]+)\s*([kKmMbB]?)(?![a-zA-Z])/);
      if(!m) return -1;
      var v = parseFloat(m[1].replace(/,/g, ''));
      var u = (m[2] || '').toLowerCase();
      if(u === 'k') v *= 1e3; else if(u === 'm') v *= 1e6; else if(u === 'b') v *= 1e9;
      if(/MRR|\/ ?mo/i.test(s)) v *= 12;
      else if(/\/\s*30d/i.test(s)) v *= 12;
      return v;
    }
    function doDraw(rank){
      var W = 1200, H = 630;
      var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      function rr(c, x, y, w, h, r){
        c.beginPath(); c.moveTo(x+r, y);
        c.arcTo(x+w, y, x+w, y+h, r); c.arcTo(x+w, y+h, x, y+h, r);
        c.arcTo(x, y+h, x, y, r); c.arcTo(x, y, x+w, y, r); c.closePath();
      }
      var g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#0f172a'); g.addColorStop(1, '#134e4a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      // Rank
      ctx.fillStyle = '#5eead4'; ctx.font = '800 190px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.shadowColor = 'rgba(94,234,212,0.35)'; ctx.shadowBlur = 42;
      ctx.fillText('#' + rank, W / 2, 268);
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.font = '600 30px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillText('on MilestoneWins Revenue Leaderboard', W / 2, 322);
      // Product name + revenue
      var nm = name.length > 30 ? name.slice(0, 29) + '…' : name;
      ctx.fillStyle = '#ffffff'; ctx.font = '800 64px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillText(nm, W / 2, 430);
      var revLabel = revenue ? (revenue + (metric ? ' ' + metric : '')) : '';
      if(revLabel){
        ctx.fillStyle = '#5eead4'; ctx.font = '700 52px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.fillText(revLabel, W / 2, 502);
      }
      // Logo (small, top-left)
      function finish(logoImg){
        if(logoImg){
          ctx.save(); rr(ctx, 60, 48, 72, 72, 16); ctx.clip();
          ctx.drawImage(logoImg, 60, 48, 72, 72); ctx.restore();
        }
        ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '600 26px system-ui, sans-serif';
        ctx.fillText('milestonewins.com', W - 60, H - 46);
        cv.toBlob(function(blob){
          if(!blob) return;
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = slug + '-ranking.png';
          document.body.appendChild(a); a.click();
          setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500);
        }, 'image/png');
      }
      if(logo){
        var im = new Image(); im.crossOrigin = 'anonymous';
        var to = setTimeout(function(){ finish(null); }, 3000);
        im.onload = function(){ clearTimeout(to); finish(im); };
        im.onerror = function(){ clearTimeout(to); finish(null); };
        im.src = logo;
      } else { finish(null); }
    }
    // Compute rank from launches.json
    fetch('/launches.json').then(function(r){ return r.json(); }).then(function(d){
      var items = (d.launches || d).filter(function(it){ return annualized(it.revenue) > 0; });
      items.sort(function(a, b){ return annualized(b.revenue) - annualized(a.revenue); });
      var rank = 0;
      for(var i = 0; i < items.length; i++){
        if(items[i].slug === slug){ rank = i + 1; break; }
      }
      if(!rank) rank = '–';
      doDraw(rank);
    }).catch(function(){ doDraw('–'); });
  }

  document.getElementById('dlCardBtn').addEventListener('click', downloadCelebration);
  var dlRankBtn = document.getElementById('dlRankBtn');
  if(dlRankBtn) dlRankBtn.addEventListener('click', downloadRankingCard);
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

/* Render a detail page from the canonical vibe3d template (same layout the
   daily pipeline generates via ops/gen_launch_page.py). Fetches the template
   from GitHub main so /review/approve always uses the latest layout. */
var DETAIL_TEMPLATE_URL = 'https://raw.githubusercontent.com/vcsmemo/launch-arr-club/main/launches/vibe3d/index.html';
var MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

async function renderDetailFromTemplate(env, d, slug, launchNo, others) {
  const res = await fetch(DETAIL_TEMPLATE_URL);
  if (!res.ok) throw new Error('template fetch failed: ' + res.status);
  let t = await res.text();

  const name = d.name || 'Untitled';
  const tagline = d.tagline || '';
  const taglineLong = tagline || (d.description || '').slice(0, 160);
  const website = d.website || d.url || '';
  const logo = d.logo || '';
  const no = parseInt(launchNo, 10) || 0;
  const noPad = String(no).padStart(3, '0');
  const rev = revenueOf(d);
  const revShort = rev ? rev.amount : '';
  const metric = rev ? rev.metric : '';
  const founder = d.founder || '';
  const founderHtml = esc(founder);
  const category = d.category || (d.categories && d.categories[0]) || 'Product';
  const pricing = d.pricing || '—';
  // Use product's actual launch date, not today
  const launchedDate = d.launched || '';
  const launchedPretty = (function(){
    const mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(launchedDate);
    if (mm) return parseInt(mm[3], 10) + ' ' + MONTHS_FULL[parseInt(mm[2], 10) - 1] + ' ' + mm[1];
    return launchedDate || '';
  })();
  const metaDesc = tagline || (d.description || '').slice(0, 160);
  // description is a string in launches.json; split into paragraphs for story
  const story = (d.description || '').split(/\n\n+/).filter(function (s) { return s && String(s).trim(); });
  const hasRevenue = !!revShort;

  function rep(oldStr, newStr) {
    if (t.indexOf(oldStr) === -1) return; // tolerate template drift
    t = t.split(oldStr).join(newStr);
  }

  // --- head ---
  rep('<title>Vibe3D — 3D Render AI for Architecture & Interior Design | MilestoneWins</title>',
      '<title>' + esc(name) + ' — ' + esc(tagline) + ' | MilestoneWins</title>');
  t = t.replace(/<meta name="description" content="[^"]*">/,
      '<meta name="description" content="' + esc(metaDesc) + '">\n'
      + '<meta property="og:title" content="' + esc(name) + ' — ' + esc(tagline) + ' | MilestoneWins">\n'
      + '<meta property="og:description" content="' + esc(metaDesc) + '">\n'
      + '<meta property="og:url" content="https://milestonewins.com/launches/' + slug + '/">\n'
      + '<meta property="og:type" content="website">\n'
      + (logo ? '<meta property="og:image" content="' + esc(logo) + '">\n' : '')
      + '<meta name="twitter:card" content="summary">');
  rep('https://milestonewins.com/launches/vibe3d/',
      'https://milestonewins.com/launches/' + slug + '/');
  // JSON-LD
  rep('"name":"Vibe3D"', '"name":"' + esc(name) + '"');
  rep('"description":"AI 3D rendering for architecture and interior design: photorealistic renders and walkthrough videos in seconds"',
      '"description":"' + esc(taglineLong) + '"');
  rep('"offers":{"@type":"Offer","price":"19","priceCurrency":"USD"},', '');
  rep('<strong>Vibe3D</strong>', '<strong>' + esc(name) + '</strong>');

  // --- hero ---
  if (logo) {
    rep('<img class="d-logo" src="/logos/vibe3d.png" alt="Vibe3D logo">',
        '<img class="d-logo" src="' + esc(logo) + '" alt="' + esc(name) + ' logo">');
  } else {
    rep('<img class="d-logo" src="/logos/vibe3d.png" alt="Vibe3D logo">',
        '<span class="d-logo-ph">' + esc(name.charAt(0)) + '</span>');
  }
  rep('<div class="d-title-row"><h1>Vibe3D</h1><span class="launch-no">#057</span></div>',
      '<div class="d-title-row"><h1>' + esc(name) + '</h1><span class="launch-no">#' + noPad + '</span></div>');
  rep('<p class="d-tagline">3D Render AI for Architecture & Interior Design</p>',
      '<p class="d-tagline">' + esc(tagline) + '</p>');
  // Free plan links are nofollow (pipeline hard rule)
  var visitRel = (d.plan === 'free') ? 'noopener nofollow' : 'noopener';
  rep('<a class="btn dark" href="https://vibe3d.ai" target="_blank" rel="noopener">Visit &#8599;</a>',
      '<a class="btn dark" href="' + esc(website) + '" target="_blank" rel="' + visitRel + '">Visit &#8599;</a>');

  // --- revenue hero ---
  if (hasRevenue) {
    rep('<div class="rh-value">$10k <span class="verified-badge" id="verifiedBadge" hidden>✓ Verified</span></div>',
        '<div class="rh-value">' + esc(revShort) + ' <span class="verified-badge" id="verifiedBadge" hidden>✓ Verified</span></div>');
    rep('<span class="rh-sub">MRR · Founder-reported · <a href="https://instalker.org/erione_" target="_blank" rel="noopener">source ↗</a></span>',
        '<span class="rh-sub">' + esc(metric) + ' · Founder-reported · <a href="' + esc(website) + '" target="_blank" rel="noopener">source ↗</a></span>');
  } else {
    rep('<div class="rh-value">$10k <span class="verified-badge" id="verifiedBadge" hidden>✓ Verified</span></div>',
        '<div class="rh-value rh-empty">Not disclosed</div>');
    rep('<span class="rh-sub">MRR · Founder-reported · <a href="https://instalker.org/erione_" target="_blank" rel="noopener">source ↗</a></span>',
        '<span class="rh-sub">Revenue not shared yet</span>');
  }

  // --- celebrate card ---
  rep('<div class="celebrate-card" id="celebrateCard" data-slug="vibe3d" data-name="Vibe3D" data-revenue="$10k" data-metric="MRR" data-logo="/logos/vibe3d.png" data-founder="Brijesh Patel">',
      '<div class="celebrate-card" id="celebrateCard" data-slug="' + esc(slug) + '" data-name="' + esc(name) + '" data-revenue="' + esc(revShort) + '" data-metric="' + esc(metric) + '" data-logo="' + esc(logo) + '" data-founder="' + esc(founder) + '">');
  rep('<div class="cc-amount">$10k</div>',
      '<div class="cc-amount">' + esc(hasRevenue ? revShort : name) + '</div>');
  rep('<div class="cc-metric">MRR milestone</div>',
      '<div class="cc-metric">' + esc(hasRevenue ? (metric + ' milestone') : 'First milestone coming soon') + '</div>');
  if (logo) {
    rep('<img class="cc-logo" src="/logos/vibe3d.png" alt="Vibe3D logo" loading="lazy" onerror="this.style.display=\'none\'">',
        '<img class="cc-logo" src="' + esc(logo) + '" alt="' + esc(name) + ' logo" loading="lazy" onerror="this.style.display=\'none\'">');
  } else {
    rep('<img class="cc-logo" src="/logos/vibe3d.png" alt="Vibe3D logo" loading="lazy" onerror="this.style.display=\'none\'">', '');
  }
  rep('<div class="cc-name">Vibe3D</div>',
      '<div class="cc-name">' + esc(name) + '</div>');
  rep('<div class="cc-founder">by Brijesh Patel</div>',
      '<div class="cc-founder">by ' + founderHtml + '</div>');

  // --- story ---
  rep('<h2 class="section-title caps"><span class="dot"></span>What Vibe3D is about</h2>',
      '<h2 class="section-title caps"><span class="dot"></span>What ' + esc(name) + ' is about</h2>');
  var storyOpen = '<div class="story-card wide"><h4>What makes it different</h4>';
  var si = t.indexOf(storyOpen);
  if (si !== -1) {
    var pEnd = t.indexOf('</p>', si);
    var sClose = t.indexOf('</div>', pEnd) + '</div>'.length;
    var paras = story.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    t = t.slice(0, si) + storyOpen + paras + '</div>' + t.slice(sClose);
  }

  // --- stat grid ---
  rep('<div class="stat-card"><span>Pricing</span><b>From $19/mo</b><small>Subscription plans</small></div>',
      '<div class="stat-card"><span>Pricing</span><b>' + esc(pricing) + '</b><small>Subscription plans</small></div>');
  rep('<div class="stat-card"><span>Launched</span><b>7 October 2026</b><small>L+0 &middot; Live on MilestoneWins</small></div>',
      '<div class="stat-card"><span>Launched</span><b>' + esc(launchedPretty) + '</b><small>L+0 &middot; Live on MilestoneWins</small></div>');
  rep('<div class="stat-card"><span>Category</span><div class="pills"><span class="tag cat">Design Tools</span></div></div>',
      '<div class="stat-card"><span>Category</span><div class="pills"><span class="tag cat">' + esc(category) + '</span></div></div>');
  // --- maker card (rich) ---
  var founderInitial = esc(String(founder || name || '?').charAt(0));
  rep('<div class="maker-avatar">B</div>',
      '<div class="maker-avatar">' + founderInitial + '</div>');
  rep('<b class="maker-name">Brijesh Patel</b>',
      '<b class="maker-name">' + founderHtml + '</b>');

  // --- more-list (revenue proximity) ---
  var rows = (others || []).map(function (o) {
    var r = o.revenue || '';
    var m = String(r).match(/(\$[\d.]+\s*[kKmM]?)\s*(.*)/);
    var revHtml = '';
    if (m) {
      var amt = m[1].trim(), met = (m[2] || '').trim();
      revHtml = '<span class="more-rev">' + esc(amt) + (met ? '<small>' + esc(met) + '</small>' : '') + '</span>';
    } else if (r) {
      revHtml = '<span class="more-rev">' + esc(r) + '</span>';
    }
    var logoHtml = o.logo
      ? '<img src="' + esc(o.logo) + '" alt="' + esc(o.name) + ' logo" loading="lazy">'
      : '<span class="lc-logo-ph">' + esc(String(o.name || '?').charAt(0)) + '</span>';
    return '    <a class="more-row" href="' + esc(o.url) + '"><span class="more-rank">#' + esc(o.no) + '</span>' +
      logoHtml +
      '<span class="more-main"><strong>' + esc(o.name) + '</strong><p>' + esc(o.tagline) + '</p>' +
      '<small>' + esc((o.categories && o.categories[0]) || 'Product') + '</small></span>' + revHtml + '</a>';
  });
  var mi = t.indexOf('<div class="more-list">');
  if (mi !== -1) {
    var aEnd = t.indexOf('</a>', mi);
    var mClose = t.indexOf('</div>', aEnd) + '</div>'.length;
    t = t.slice(0, mi) + '<div class="more-list">\n' + rows.join('\n') + '\n  </div>' + t.slice(mClose);
  }

  // --- js slug refs ---
  rep('var slug = "vibe3d";', 'var slug = "' + slug + '";');
  rep("var slug = 'vibe3d';", "var slug = '" + slug + "';");

  return t;
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
  const selfUrl = 'https://milestonewins.com/launches/' + slug + '/';
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
  const detail = await renderDetailFromTemplate(env, d, slug, launchNo, others);

  // 2. launches.json (matches the pipeline schema)
  const rev = revenueOf(d);
  const today = todayISO();
  const revStr = rev ? rev.amount + (rev.metric ? ' ' + rev.metric : '') : null;
  // Stripe-verified submissions get the Verified badge automatically
  let stripeVerified = null;
  try { stripeVerified = d.stripe_verified ? JSON.parse(d.stripe_verified) : null; } catch (e) {}
  idx.unshift({
    launch_no: parseInt(launchNo, 10),
    name: d.name,
    slug: slug,
    tagline: d.tagline || '',
    url: 'https://milestonewins.com/launches/' + slug + '/',
    website: d.url,
    logo: d.logo || null,
    revenue: revStr,
    revenue_metric: rev && rev.metric ? rev.metric : null,
    revenue_verified: stripeVerified && stripeVerified.mrr_cents > 0 ? true : undefined,
    revenue_verified_at: stripeVerified && stripeVerified.mrr_cents > 0 ? stripeVerified.at : undefined,
    revenue_verified_via: stripeVerified && stripeVerified.mrr_cents > 0 ? 'stripe' : undefined,
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
    /(<loc>https:\/\/milestonewins\.com\/<\/loc><lastmod>)\d{4}-\d{2}-\d{2}/,
    '$1' + today
  );
  sitemap = sitemap.replace(
    '</urlset>',
    '  <url><loc>https://milestonewins.com/launches/' + slug + '/</loc><lastmod>' + today + '</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>\n</urlset>'
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

  // Transactional email 3: you're live (fire-and-forget)
  const liveUrl = 'https://milestonewins.com/launches/' + slug + '/';
  if (d.founder_email) {
    const lname = esc(d.name || 'your product');
    sendEmail(env, d.founder_email,
      'You\u2019re live on MilestoneWins 🚀',
      emailShell('You\u2019re live on MilestoneWins 🚀',
        '<p>Hi ' + esc(d.founder || 'there') + ',</p>'
        + '<p>Your <strong>' + lname + '</strong> is live:</p>'
        + '<p><a href="' + liveUrl + '" style="color:#0d9488;font-weight:600;">' + liveUrl + '</a></p>'
        + '<p>Your page includes a celebration card — open the page, hit \u201cDownload celebration image\u201d, and share it anywhere.</p>'
        + '<p>Hit your first revenue milestone? Come back and submit it — we\u2019ll make you a revenue celebration card.</p>'
        + '<p>Have a good founding story? We\u2019d love to feature it — just reply to this email and tell us how it all started.</p>'
        + '<p>— The MilestoneWins team</p>'));
  }

  return json({ ok: true, url: liveUrl, slug: slug, launch_no: launchNo });
}

/* Needs-info: email the submitter about missing fields, park the submission.
   Body: {key, missing: ["field1", "field2", ...]} */
async function handleNeedsInfo(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
  const key = body && body.key;
  const missing = Array.isArray(body && body.missing) ? body.missing.filter(function(x){ return typeof x === 'string'; }).slice(0, 10) : [];
  if (!key || !key.startsWith('submissions/')) return json({ error: 'bad key' }, 400);
  if (!missing.length) return json({ error: 'missing fields required' }, 400);
  const obj = await env.IMAGES.get(key);
  if (!obj) return json({ error: 'submission not found' }, 404);
  const raw = await obj.text();
  let d;
  try { d = JSON.parse(raw); } catch (e) { return json({ error: 'submission is not valid json' }, 400); }

  // Transactional email 2: needs info (fire-and-forget, but report status)
  let emailStatus = { ok: false, error: 'no recipient' };
  if (d.founder_email) {
    const items = missing.map(function(m){ return '<li>' + esc(m) + '</li>'; }).join('');
    emailStatus = await sendEmail(env, d.founder_email,
      'One quick thing about your MilestoneWins submission',
      emailShell('One quick thing about your MilestoneWins submission',
        '<p>Hi ' + esc(d.founder || 'there') + ',</p>'
        + '<p>Almost there — we\u2019re missing:</p>'
        + '<ul>' + items + '</ul>'
        + '<p>Just reply to this email with the details and we\u2019ll get <strong>' + esc(d.name || 'your product') + '</strong> published.</p>'
        + '<p>— The MilestoneWins team</p>'));
  }

  const base = key.split('/').pop();
  await env.IMAGES.put('reviewed/needs-info/' + base, raw, {
    httpMetadata: { contentType: 'application/json' },
  });
  await env.IMAGES.delete(key);
  return json({ ok: true, email: emailStatus });
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
      + '<text x="' + (42 + revWidth + 8) + '" y="22.5" font-family="Inter,-apple-system,\'Segoe UI\',Roboto,sans-serif" font-size="12.5" font-weight="600" fill="' + textColor + '">tracked on <tspan fill="' + accent + '">milestonewins.com</tspan></text>'
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
      + '<text x="' + (42 + numWidth + 8) + '" y="22.5" font-family="Inter,-apple-system,\'Segoe UI\',Roboto,sans-serif" font-size="12.5" font-weight="600" fill="' + textColor + '">on <tspan fill="' + accent + '">milestonewins.com</tspan></text>'
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

    // ---- Dynamic product pages (milestonewins.com/launches/*) ----
    // Renders product detail HTML from R2 products/<slug>.json — no deploy needed.
    // Falls through to origin (static) if product not in R2.
    if (request.method === 'GET'
        && url.hostname === 'milestonewins.com'
        && url.pathname.startsWith('/launches/')
        && url.pathname !== '/launches/') {
      const m = url.pathname.match(/^\/launches\/([^\/]+)\/?$/);
      if (m) {
        const slug = m[1].toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);
        try {
          const obj = await env.IMAGES.get('products/' + slug + '.json');
          if (obj) {
            const product = JSON.parse(await obj.text());
            const launchNo = parseInt(product.launch_no, 10) || 0;
            const html = await renderDetailFromTemplate(env, product, slug, launchNo, []);
            return new Response(html, {
              headers: {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'public, max-age=300', // 5 min cache, instant updates
              },
            });
          }
        } catch (e) {
          // fall through to origin on error
        }
      }
      // Not in R2 — let the static origin handle it
      return fetch(request);
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

    // ---- Claim page ----
    // POST /claim-interest {slug, name, email, x_handle} -> saves founder claim to KV + R2
    // First 10 claimants get free Featured. Returns {ok:true, free_featured:boolean, claim_number:number}
    if (request.method === 'POST' && url.pathname === '/claim-interest') {
      let data;
      try { data = await request.json(); }
      catch (e) { return json({ error: 'invalid JSON' }, 400); }
      const slug = String(data.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);
      const name = String(data.name || '').trim().slice(0, 120);
      const email = String(data.email || '').trim().toLowerCase().slice(0, 120);
      const xHandle = String(data.x_handle || '').trim().replace(/^@/, '').slice(0, 50);
      if (!slug) return json({ error: 'missing slug' }, 400);
      if (!name) return json({ error: 'missing name' }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'invalid email' }, 400);
      if (!env.STRIPE_KV) return json({ error: 'KV not configured' }, 500);
      const key = 'claim:' + slug + ':' + md5(email);
      const existing = await env.STRIPE_KV.get(key);
      if (existing) return json({ ok: true, duplicate: true });
      // Count total claims for the free-featured offer (first 10)
      const countKey = 'claim:count';
      const count = (parseInt(await env.STRIPE_KV.get(countKey) || '0', 10) || 0) + 1;
      await env.STRIPE_KV.put(countKey, String(count));
      const freeFeatured = count <= 10;
      const claim = {
        slug: slug, name: name, email: email, x_handle: xHandle,
        claim_number: count, free_featured: freeFeatured,
        created_at: new Date().toISOString(), status: 'pending'
      };
      await env.STRIPE_KV.put(key, JSON.stringify(claim));
      // Also save full record to R2 for review
      const r2key = 'claims/' + new Date().toISOString().slice(0, 10) + '-' + slug + '-' + crypto.randomUUID().slice(0, 6) + '.json';
      await env.IMAGES.put(r2key, JSON.stringify(claim), {
        httpMetadata: { contentType: 'application/json' },
      });
      // Confirmation email to claimant
      const productUrl = 'https://milestonewins.com/launches/' + slug + '/';
      sendEmail(env, email,
        freeFeatured ? 'Your page is claimed 🎉 + FREE Featured!' : 'Your claim is received 🎉',
        emailShell(freeFeatured ? 'Your page is claimed 🎉' : 'Claim received 🎉',
          '<p>Hi ' + esc(name) + ',</p>'
          + '<p>Thanks for claiming <strong><a href="' + productUrl + '">' + esc(slug) + '</a></strong> on MilestoneWins.</p>'
          + (freeFeatured
            ? '<p>🎁 <strong>You\'re one of our first 10 founders — Featured placement is FREE for you</strong> (normally $19). We\'ll upgrade your page within 24 hours after a quick verification.</p>'
            : '<p>We\'ll verify your claim within 24 hours. Want extra visibility? <a href="https://milestonewins.com/submit.html">Upgrade to Featured ($19)</a>.</p>')
          + '<p>— The MilestoneWins team</p>'));
      return json({ ok: true, free_featured: freeFeatured, claim_number: count });
    }

    // GET /claim-count -> returns {count, free_spots_left} for the claim page
    if (request.method === 'GET' && url.pathname === '/claim-count') {
      const count = parseInt(await env.STRIPE_KV.get('claim:count') || '0', 10) || 0;
      return json({ ok: true, count: count, free_spots_left: Math.max(0, 10 - count) });
    }

    // POST /claim-approve (token-gated) {slug, email} -> approve claim, send founder welcome email
    // Called by Amani after manual verification. Marks product claimed, sends links for
    // milestone updates + info changes.
    if (request.method === 'POST' && url.pathname === '/claim-approve') {      if (!reviewAuthed(request, url, env)) return json({ error: 'unauthorized' }, 401);
      let data;
      try { data = await request.json(); }
      catch (e) { return json({ error: 'invalid JSON' }, 400); }
      const slug = String(data.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);
      const email = String(data.email || '').trim().toLowerCase().slice(0, 120);
      if (!slug || !email) return json({ error: 'slug and email required' }, 400);
      const key = 'claim:' + slug + ':' + md5(email);
      const raw = await env.STRIPE_KV.get(key);
      if (!raw) return json({ error: 'claim not found' }, 404);
      const claim = JSON.parse(raw);
      claim.status = 'approved';
      claim.approved_at = new Date().toISOString();
      await env.STRIPE_KV.put(key, JSON.stringify(claim));
      // Welcome email with action links
      const productUrl = 'https://milestonewins.com/launches/' + slug + '/';
      const updateUrl = 'https://milestonewins.com/submit.html?update=' + slug;
      sendEmail(env, email,
        'Your page is verified ✅ — here\'s what you can do now',
        emailShell('You\'re verified ✅',
          '<p>Hi ' + esc(claim.name || 'there') + ',</p>'
          + '<p>Your claim for <strong><a href="' + productUrl + '">' + esc(slug) + '</a></strong> is verified. Here\'s what you can do now:</p>'
          + '<p>📈 <strong><a href="' + updateUrl + '">Share a new revenue milestone →</a></strong><br>'
          + 'Every milestone gets a celebration card + a spot on the leaderboard. Takes 1 minute.</p>'
          + '<p>✏️ <strong>Update product info</strong><br>'
          + 'Reply to this email with any changes (description, logo, pricing, links) and we\'ll update your page within 24 hours.</p>'
          + (claim.free_featured
            ? '<p>🎁 <strong>Your FREE Featured placement is active!</strong> Your page now appears in the Featured section.</p>'
            : '<p>💡 Want more visibility? <a href="https://milestonewins.com/submit.html">Upgrade to Featured ($19)</a>.</p>')
          + '<p>— The MilestoneWins team</p>'));
      return json({ ok: true, slug: slug, free_featured: claim.free_featured });
    }

    // POST /publish-product (token-gated) -> write product JSON to R2, instantly live
    // Body: full product object (name, slug, tagline, description, website, logo, founder,
    //   category, pricing, revenue, revenue_metric, launched, etc.)
    // Validates required fields before publishing (no thin pages).
    if (request.method === 'POST' && url.pathname === '/publish-product') {
      if (!reviewAuthed(request, url, env)) return json({ error: 'unauthorized' }, 401);
      let d;
      try { d = await request.json(); }
      catch (e) { return json({ error: 'invalid JSON' }, 400); }
      const slug = String(d.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);
      if (!slug) return json({ error: 'slug required' }, 400);
      // Completeness gate: block thin pages
      const required = ['name', 'tagline', 'description', 'website', 'founder', 'category', 'launched'];
      const missing = required.filter(function(k){ return !d[k] || !String(d[k]).trim(); });
      if (missing.length) return json({ error: 'incomplete product', missing: missing }, 400);
      if (!d.logo) return json({ error: 'incomplete product', missing: ['logo'] }, 400);
      d.slug = slug;
      d.url = 'https://milestonewins.com/launches/' + slug + '/';
      // Auto-assign launch_no (max existing + 1)
      try {
        const idxObj = await env.IMAGES.get('products/_index.json');
        if (idxObj) {
          const idx = JSON.parse(await idxObj.text());
          let maxNo = 0;
          for (const k in idx) {
            const n = parseInt((idx[k] && idx[k].launch_no) || '0', 10);
            if (n > maxNo) maxNo = n;
          }
          if (!d.launch_no) d.launch_no = maxNo + 1;
        }
      } catch (e) {}
      await env.IMAGES.put('products/' + slug + '.json', JSON.stringify(d), {
        httpMetadata: { contentType: 'application/json' },
      });
      // Update index
      try {
        const idxObj = await env.IMAGES.get('products/_index.json');
        const idx = idxObj ? JSON.parse(await idxObj.text()) : {};
        idx[slug] = { name: d.name, slug: slug, url: d.url, revenue: d.revenue || null,
                      launched: d.launched, logo: d.logo, category: d.category,
                      launch_no: d.launch_no };
        await env.IMAGES.put('products/_index.json', JSON.stringify(idx), {
          httpMetadata: { contentType: 'application/json' },
        });
      } catch (e) {}
      return json({ ok: true, slug: slug, url: d.url, launch_no: d.launch_no });
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
      // Free-plan quota: 2 free nofollow launches per Google account, then $5 each.
      // Badge and paid plans are unlimited / verified separately.
      // Milestone updates (update_for set) never consume quota.
      let quotaSub = null, freeLeft = null;
      if (data.plan === 'free' && !data.update_for) {
        quotaSub = await googleSubFromToken(data.id_token);
        if (!quotaSub) {
          return json({ error: 'sign_in_required' }, 401);
        }
        const qkey = 'freeq:' + quotaSub;
        const used = parseInt((await env.STRIPE_KV.get(qkey)) || '0', 10) || 0;
        if (used >= 2) {
          return json({ error: 'free_quota_exhausted', free_left: 0 }, 402);
        }
        freeLeft = 2 - used - 1;
      }
      const isPaid = data.plan === 'paid';
      const key =
        (isPaid ? 'pending_payment/' : 'submissions/') +
        todayISO() +
        '-' +
        slugify(data.name) +
        '-' +
        crypto.randomUUID().slice(0, 6) +
        '.json';
      // Don't persist the raw ID token; keep the verified sub for review visibility.
      if (data.id_token) delete data.id_token;
      if (quotaSub) data.quota_sub = quotaSub;
      await env.IMAGES.put(key, JSON.stringify(data), {
        httpMetadata: { contentType: 'application/json' },
      });
      if (quotaSub) {
        await env.STRIPE_KV.put('freeq:' + quotaSub, String(2 - freeLeft));
      }
      // Transactional email 1: submission received (fire-and-forget)
      // Paid tier: don't send yet — webhook sends "payment received" after $5 confirms.
      if (data.founder_email && !isPaid) {
        const cname = esc(data.name || 'your product');
        sendEmail(env, data.founder_email,
          'We got your submission 🎉',
          emailShell('We got your submission 🎉',
            '<p>Hi ' + esc(data.founder || 'there') + ',</p>'
            + '<p>Your <strong>' + cname + '</strong> is in our review queue. We personally review every launch and publish within 24 hours.</p>'
            + '<p>We\u2019ll email you the moment you\u2019re live.</p>'
            + '<p>— The MilestoneWins team</p>'));
      }
      return json({ ok: true, free_left: freeLeft, pending_key: isPaid ? key : undefined });
    }

    // Quota lookup for the submit form: GET /quota?id_token=...
    if (request.method === 'GET' && url.pathname === '/quota') {
      const sub = await googleSubFromToken(url.searchParams.get('id_token'));
      if (!sub) return json({ error: 'sign_in_required' }, 401);
      const used = parseInt((await env.STRIPE_KV.get('freeq:' + sub)) || '0', 10) || 0;
      return json({ ok: true, free_left: Math.max(0, 2 - used) });
    }

    // ---- Review console (token-gated) ----
    if (request.method === 'POST' && url.pathname === '/stripe-webhook') {
      try {
        return await handleStripeWebhook(request, env);
      } catch (e) {
        return json({ error: 'webhook failed: ' + (e && e.message ? e.message : String(e)) }, 500);
      }
    }
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

      // Needs-info -> email the submitter, park the submission
      if (request.method === 'POST' && url.pathname === '/review/needs-info') {
        try {
          return await handleNeedsInfo(request, env);
        } catch (e) {
          return json({ error: 'needs-info failed: ' + (e && e.message ? e.message : String(e)) }, 500);
        }
      }
      // Manual resend of the "you're live" email for an already-published slug
      if (request.method === 'POST' && url.pathname === '/review/resend-live-email') {
        if (!reviewAuthed(request, url, env)) return json({ error: 'unauthorized' }, 401);
        let body;
        try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
        const slug = String(body.slug || '').replace(/[^a-z0-9-]/g, '').slice(0, 60);
        const to = String(body.to || '').trim();
        if (!slug || !to || !to.includes('@')) return json({ error: 'slug and to required' }, 400);
        // Find product name from launches.json on GitHub
        let pname = slug;
        try {
          const lf = await ghFileSha(env, 'launches.json');
          const idx = JSON.parse(lf.text);
          const found = (Array.isArray(idx) ? idx : idx.launches || []).find(function(e){ return e.slug === slug; });
          if (found && found.name) pname = found.name;
        } catch (e) {}
        const liveUrl = 'https://milestonewins.com/launches/' + slug + '/';
        const r = await sendEmail(env, to,
          'You\u2019re live on MilestoneWins 🚀',
          emailShell('You\u2019re live on MilestoneWins 🚀',
            '<p>Hi there,</p>'
            + '<p>Your <strong>' + esc(pname) + '</strong> is live:</p>'
            + '<p><a href="' + liveUrl + '" style="color:#0d9488;font-weight:600;">' + liveUrl + '</a></p>'
            + '<p>Your page includes a celebration card — open the page, hit \u201cDownload celebration image\u201d, and share it anywhere.</p>'
            + '<p>Hit your first revenue milestone? Come back and submit it — we\u2019ll make you a revenue celebration card.</p>'
            + '<p>Have a good founding story? We\u2019d love to feature it — just reply to this email and tell us how it all started.</p>'
            + '<p>— The MilestoneWins team</p>'));
        return json({ ok: r.ok, error: r.error || null });
      }

      return json({ error: 'unknown review action' }, 404);
    }

    // URL metadata fetch for submit auto-fill: GET /fetch-url?url=https://...
    // ---- Stripe revenue verification ----
    // POST /verify-stripe {stripe_key} -> {verified, mrr_cents, mrr_display}
    // The key is used once in-memory to query Stripe and NEVER stored.
    if (request.method === 'POST' && url.pathname === '/verify-stripe') {
      let data;
      try { data = await request.json(); }
      catch (e) { return json({ error: 'invalid json' }, 400); }
      const key = String(data.stripe_key || '').trim();
      if (!/^(rk|sk)_(live|test)_/.test(key)) {
        return json({ verified: false, error: 'invalid_key_format' }, 400);
      }
      try {
        let mrrCents = 0, subCount = 0, url_subs = 'https://api.stripe.com/v1/subscriptions?status=active&limit=100';
        // paginate through active subscriptions (cap 500)
        for (let page = 0; page < 5; page++) {
          const r = await fetch(url_subs, {
            headers: { 'Authorization': 'Basic ' + btoa(key + ':') },
          });
          if (r.status === 401) return json({ verified: false, error: 'invalid_key' }, 200);
          if (!r.ok) return json({ verified: false, error: 'stripe_error' }, 200);
          const j = await r.json();
          for (const sub of (j.data || [])) {
            if (sub.status !== 'active' && sub.status !== 'trialing') continue;
            subCount++;
            for (const item of ((sub.items || {}).data || [])) {
              const price = item.price || {};
              const amt = price.unit_amount || 0;
              const qty = item.quantity || 1;
              const interval = (price.recurring || {}).interval || 'month';
              const perMonth = interval === 'year' ? amt / 12
                : interval === 'week' ? amt * 52 / 12
                : interval === 'day' ? amt * 365 / 12 : amt;
              mrrCents += Math.round(perMonth * qty);
            }
          }
          if (!j.has_more) break;
          const last = j.data[j.data.length - 1];
          url_subs = 'https://api.stripe.com/v1/subscriptions?status=active&limit=100&starting_after=' + last.id;
        }
        const mrrDisplay = mrrCents >= 100000
          ? '$' + (mrrCents / 100000).toFixed(mrrCents % 100000 === 0 ? 0 : 1) + 'k'
          : '$' + (mrrCents / 100).toFixed(0);
        return json({ verified: true, mrr_cents: mrrCents, mrr_display: mrrDisplay + ' MRR', subscriptions: subCount });
      } catch (e) {
        return json({ verified: false, error: 'request_failed' }, 200);
      }
    }

    if (request.method === 'GET' && url.pathname === '/fetch-url') {
      const target = url.searchParams.get('url') || '';
      if (!/^https?:\/\/[^/]+\.[^/]+/.test(target) || target.length > 500) {
        return json({ error: 'bad url' }, 400);
      }
      try {
        const r = await fetch(target, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MilestoneWins/1.0; +https://milestonewins.com)' },
          redirect: 'follow',
        });
        if (!r.ok) return json({ error: 'fetch failed' }, 502);
        const html = await r.text();
        const head = html.slice(0, 60000);
        const meta = function (prop) {
          const m = head.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*>', 'i'));
          if (!m) return '';
          const c = m[0].match(/content=["']([^"']*)["']/i);
          return c ? c[1].trim().slice(0, 300) : '';
        };
        const title = meta('og:title') || (head.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || [])[1] || '';
        const desc = meta('og:description') || meta('description');
        let icon = meta('og:image');
        if (!icon) {
          const l = head.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*>/i);
          if (l) {
            const h = l[0].match(/href=["']([^"']+)["']/i);
            if (h) { try { icon = new URL(h[1], r.url).toString(); } catch (e) { icon = ''; } }
          }
        }
        if (!icon) { try { icon = new URL('/favicon.ico', r.url).toString(); } catch (e) {} }
        return json({ ok: true, title: title.trim(), description: desc.trim(), icon: icon || '' });
      } catch (e) {
        return json({ error: 'fetch failed' }, 502);
      }
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
