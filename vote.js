/* MilestoneWins shared vote component (Phase 2).
 * Used by /board/ and by SSR detail pages (injected by renderDetailFromTemplate).
 *
 * Flow per product: 1st click (not yet visited) opens the product site in a
 * new tab AND records the visit (POST /track with id_token) -> button becomes
 * "Confirm upvote" -> 2nd click casts the vote (POST /vote).
 * Sign-in is Google (same client id as submit.html); the id_token lives in
 * sessionStorage (tab lifetime) and the worker re-validates it via Google
 * tokeninfo on every call, so a stale token just 401s and we ask again.
 * Buttons are wired via MWVote.wire() so pages that render rows dynamically
 * (the board) can wire after each render.
 */
(function(){
  var WORKER = 'https://launch-arr-club-img.johntian2015.workers.dev';
  var CLIENT_ID = '659455206571-e0rd1e7iq8os25s4441elss3960bkfjs.apps.googleusercontent.com';
  var TOKEN_KEY = 'mw_id_token_v1';
  var VISIT_KEY = 'mw_visited_v1';

  function getToken(){ try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch(e){ return ''; } }
  function setToken(t){ try { if(t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch(e){} }
  function parseJwt(t){
    try {
      var p = t.split('.')[1];
      var b = p.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(b))));
    } catch(e){ return null; }
  }
  function mySub(){
    var t = getToken();
    if(!t) return '';
    var p = parseJwt(t);
    return (p && p.sub) ? String(p.sub) : '';
  }
  function getVisited(){ try { return JSON.parse(localStorage.getItem(VISIT_KEY) || '{}'); } catch(e){ return {}; } }
  function setVisited(slug){
    try { var v = getVisited(); v[slug] = 1; localStorage.setItem(VISIT_KEY, JSON.stringify(v)); } catch(e){}
  }
  function hasVisited(slug){ return !!getVisited()[slug]; }

  var mineCache = {}; // week -> /votes/mine json (or null when signed out)

  function api(path, opts){
    return fetch(WORKER + path, opts).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){
        j._status = r.status;
        return j;
      });
    });
  }
  function getMine(week){
    var t = getToken();
    if(!t) return Promise.resolve(null);
    if(mineCache[week]) return Promise.resolve(mineCache[week]);
    return api('/votes/mine?id_token=' + encodeURIComponent(t) + '&week=' + encodeURIComponent(week))
      .then(function(j){
        if(j._status === 401){ setToken(''); mineCache = {}; return null; }
        if(j.ok){ mineCache[week] = j; return j; }
        return null;
      }).catch(function(){ return null; });
  }
  function getBoardCounts(week){
    return api('/board/' + encodeURIComponent(week)).then(function(j){
      if(!j.ok || !j.entries) return {};
      var m = {};
      j.entries.forEach(function(e){ m[e.slug] = e; });
      return m;
    }).catch(function(){ return {}; });
  }

  function setCount(btn, n){
    var c = btn.querySelector('.vote-count');
    if(c) c.textContent = (typeof n === 'number') ? String(n) : '';
  }
  function setLabel(btn, html){ btn.innerHTML = html; }
  function markVoted(btn, votes){
    btn.disabled = true;
    btn.classList.add('voted');
    setLabel(btn, '✓ Voted' + (typeof votes === 'number' ? ' · ' + votes : ''));
  }
  function markOwn(btn){
    btn.disabled = true;
    setLabel(btn, 'Your launch');
    btn.title = "You can't vote for your own launch";
  }

  var pendingBtn = null;
  function loadGsi(cb){
    if(window.google && google.accounts && google.accounts.id){ cb(true); return; }
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = function(){ cb(true); };
    s.onerror = function(){ cb(false); };
    document.head.appendChild(s);
  }
  function onGoogleSignIn(resp){
    var profile = parseJwt(resp.credential);
    if(!profile || !profile.email) return;
    setToken(resp.credential);
    mineCache = {};
    if(window.LAC) LAC.setUser({ name: profile.name || '', email: profile.email, picture: profile.picture || '' });
    var slot = document.querySelector('.mw-gsi-slot');
    if(slot) slot.remove();
    var btn = pendingBtn;
    pendingBtn = null;
    refreshAll();
    try { document.dispatchEvent(new CustomEvent('mw:signin', { detail: { name: profile.name || '', email: profile.email } })); } catch(e){}
    if(btn) handleVoteClick(btn);
  }
  function showSignIn(btn){
    pendingBtn = btn;
    var existing = btn.parentNode.querySelector('.mw-gsi-slot');
    if(existing){ existing.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }
    var slot = document.createElement('div');
    slot.className = 'mw-gsi-slot';
    slot.style.marginTop = '8px';
    btn.parentNode.insertBefore(slot, btn.nextSibling);
    loadGsi(function(ok){
      if(!ok){
        slot.innerHTML = '<span style="font-size:0.85rem;color:#b91c1c;">Google sign-in did not load (ad blocker?). Disable it and retry.</span>';
        return;
      }
      try {
        google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onGoogleSignIn });
        google.accounts.id.renderButton(slot, { theme: 'outline', size: 'large', text: 'signin_with' });
      } catch(e){
        slot.innerHTML = '<span style="font-size:0.85rem;color:#b91c1c;">Could not start Google sign-in — try again.</span>';
      }
    });
  }

  function recordVisit(btn, slug){
    var t = getToken();
    return api('/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'click', slug: slug, id_token: t })
    }).then(function(j){
      if(j.visit_recorded){ setVisited(slug); return true; }
      return false;
    }).catch(function(){ return false; });
  }

  function castVote(btn, slug, week){
    var t = getToken();
    btn.disabled = true;
    var prev = btn.innerHTML;
    setLabel(btn, 'Voting…');
    api('/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: t, slug: slug, week: week })
    }).then(function(j){
      if(j.ok){
        mineCache = {};
        if(j.duplicate){ markVoted(btn, j.votes); }
        else {
          markVoted(btn, j.votes);
          refreshAll();
        }
        return;
      }
      btn.disabled = false;
      if(j._status === 401 || (j.error && j.error === 'sign_in_required')){
        setToken(''); mineCache = {};
        setLabel(btn, prev);
        showSignIn(btn);
      } else if(j.error === 'visit_required'){
        // Visit proof missing server-side (other device, expired) — redo the visit step.
        setLabel(btn, '▲ Upvote' + (btn.querySelector('.vote-count') ? ' · ' + btn.querySelector('.vote-count').textContent : ''));
        handleVisitStep(btn, slug);
      } else if(j.error === 'cannot_vote_own'){
        markOwn(btn);
      } else if(j.error === 'voting_closed'){
        btn.disabled = true;
        setLabel(btn, 'Voting closed');
      } else if(j.error === 'not_found'){
        btn.disabled = true;
        setLabel(btn, 'Not on this board');
      } else {
        setLabel(btn, prev);
        alert('Vote failed — try again.');
      }
    }).catch(function(){
      btn.disabled = false;
      setLabel(btn, prev);
      alert('Vote failed — check your connection and try again.');
    });
  }

  function handleVisitStep(btn, slug){
    var site = btn.getAttribute('data-website') || '';
    if(site) window.open(site, '_blank', 'noopener');
    var countEl = btn.querySelector('.vote-count');
    var countTxt = countEl ? countEl.textContent : '';
    setLabel(btn, 'Opening site…');
    btn.disabled = true;
    recordVisit(btn, slug).then(function(ok){
      btn.disabled = false;
      if(ok){
        setLabel(btn, '▲ Confirm upvote' + (countTxt ? ' · ' + countTxt : ''));
      } else {
        setLabel(btn, '▲ Upvote' + (countTxt ? ' · ' + countTxt : ''));
        alert('Could not record the visit — try clicking again.');
      }
    });
  }

  function handleVoteClick(btn){
    var slug = btn.getAttribute('data-slug') || '';
    var week = btn.getAttribute('data-week') || '';
    if(!slug || !week || btn.disabled) return;
    if(!getToken()){ showSignIn(btn); return; }
    if(hasVisited(slug)){ castVote(btn, slug, week); return; }
    handleVisitStep(btn, slug);
  }

  function wireButton(btn){
    if(btn._mwWired) return;
    btn._mwWired = true;
    btn.addEventListener('click', function(){ handleVoteClick(btn); });
    // Own product: disable immediately when the maker is known (board sets data-maker).
    var maker = btn.getAttribute('data-maker') || '';
    if(maker && mySub() && maker === mySub()) markOwn(btn);
  }

  /* Refresh counts + voted states for every [data-vote] button on the page.
     Returns a promise resolving to the /votes/mine payload (or null). */
  function refreshAll(){
    var btns = document.querySelectorAll('[data-vote]');
    if(!btns.length) return Promise.resolve(null);
    var weeks = {};
    btns.forEach(function(b){ weeks[b.getAttribute('data-week') || ''] = true; });
    var weekList = Object.keys(weeks).filter(Boolean);
    return Promise.all(weekList.map(function(w){
      return Promise.all([getBoardCounts(w), getMine(w)]).then(function(res){
        var counts = res[0], mine = res[1];
        var voted = (mine && mine.voted) || [];
        btns.forEach(function(b){
          if(b.getAttribute('data-week') !== w) return;
          var slug = b.getAttribute('data-slug') || '';
          var entry = counts[slug];
          if(b.disabled && b.classList.contains('voted')) return;
          var maker = b.getAttribute('data-maker') || '';
          if(maker && mySub() && maker === mySub()){ markOwn(b); return; }
          if(voted.indexOf(slug) !== -1){ markVoted(b, entry ? entry.votes : undefined); return; }
          if(entry) setCount(b, entry.votes);
          if(hasVisited(slug) && !b.disabled){
            var c = b.querySelector('.vote-count');
            setLabel(b, '▲ Confirm upvote' + (c && c.textContent ? ' · ' + c.textContent : ''));
          }
        });
        return mine;
      });
    })).then(function(mines){ return mines[0] || null; });
  }

  function wire(root){
    var scope = root || document;
    scope.querySelectorAll('[data-vote]').forEach(function(b){ wireButton(b); });
  }

  function renderHeaderSlot(){
    // Board pages provide a persistent sign-in slot in the header.
    var slot = document.getElementById('mwSigninSlot');
    if(!slot || getToken()) return;
    loadGsi(function(ok){
      if(!ok){ slot.innerHTML = '<a class="nav-signin" href="/submit.html">Sign in</a>'; return; }
      try {
        google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onGoogleSignIn });
        google.accounts.id.renderButton(slot, { theme: 'outline', size: 'medium', text: 'signin' });
      } catch(e){
        slot.innerHTML = '<a class="nav-signin" href="/submit.html">Sign in</a>';
      }
    });
  }

  function init(){
    wire(document);
    refreshAll();
    renderHeaderSlot();
  }

  window.MWVote = {
    init: init,
    wire: wire,
    refresh: refreshAll,
    getMine: getMine,
    mySub: mySub,
    hasToken: function(){ return !!getToken(); },
    signOut: function(){
      setToken(''); mineCache = {};
      if(window.LAC) LAC.setUser(null);
      try { document.dispatchEvent(new CustomEvent('mw:signout')); } catch(e){}
      refreshAll();
      renderHeaderSlot();
    }
  };
  if(document.readyState === 'complete' || document.readyState === 'interactive'){ init(); }
  else { document.addEventListener('DOMContentLoaded', init); }
})();
