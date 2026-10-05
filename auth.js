/* launch.arr.club shared Google sign-in state.
 * Display-only: stores name/email/picture in localStorage so the profile
 * chip + dropdown show on every page. No backend auth decisions from this.
 * NOTE 2026-10-05: header sign-in hidden via CSS (.nav-auth) — nothing in the
 * current growth-card flow requires login; submit.html keeps its own button.
 * LAC_NO_GSI skips loading Google's GSI script on every page. */
window.LAC_NO_GSI = true;
(function(){
  var KEY = 'lac_user_v1';
  var CLIENT_ID = '659455206571-e0rd1e7iq8os25s4441elss3960bkfjs.apps.googleusercontent.com';
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function getUser(){
    try { var u = JSON.parse(localStorage.getItem(KEY)); return (u && u.email) ? u : null; }
    catch(e){ return null; }
  }
  function setUser(u){
    if(u && u.email){
      localStorage.setItem(KEY, JSON.stringify({ name: u.name || '', email: u.email, picture: u.picture || '' }));
    } else {
      localStorage.removeItem(KEY);
    }
    renderAuth();
  }
  function parseJwt(t){
    try{
      var p = t.split('.')[1];
      var b = p.replace(/-/g,'+').replace(/_/g,'/');
      return JSON.parse(decodeURIComponent(escape(atob(b))));
    }catch(e){ return null; }
  }
  function onNavSignIn(resp){
    var profile = parseJwt(resp.credential);
    if(!profile || !profile.email) return;
    setUser({ name: profile.name || '', email: profile.email, picture: profile.picture || '' });
    if(window.__launchUser !== undefined){
      window.__launchUser = { name: profile.name || '', email: profile.email, picture: profile.picture || '', sub: profile.sub || '' };
    }
  }
  function initGsiButton(){
    var el = document.getElementById('gsiNavSlot');
    if(!el) return;
    if(!(window.google && google.accounts && google.accounts.id)){
      el.innerHTML = '<a class="nav-signin" href="/submit.html">Sign in</a>';
      return;
    }
    try {
      google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onNavSignIn });
      google.accounts.id.renderButton(el, { theme: 'outline', size: 'medium', text: 'signin', width: 110 });
    } catch(e){
      el.innerHTML = '<a class="nav-signin" href="/submit.html">Sign in</a>';
    }
  }
  function renderAuth(){
    var slot = document.getElementById('authSlot');
    if(!slot) return;
    var u = getUser();
    if(u){
      var first = (u.name || '').split(' ')[0] || 'Account';
      slot.innerHTML =
        '<div class="profile-wrap">'
        + '<button type="button" class="profile-chip" id="profileChip" aria-haspopup="true" aria-expanded="false" title="Account">'
        + (u.picture ? '<img src="' + esc(u.picture) + '" alt="">' : '')
        + '<span>' + esc(first) + '</span></button>'
        + '<div class="profile-menu" id="profileMenu" hidden>'
        + '<div class="pm-head"><strong>' + esc((u.name || 'Account').toUpperCase()) + '</strong><span>' + esc(u.email) + '</span></div>'
        + '<a href="/submit.html">Launch now</a>'
        + '<button type="button" id="logoutBtn">Logout</button>'
        + '</div></div>';
      var chip = document.getElementById('profileChip'), menu = document.getElementById('profileMenu');
      chip.addEventListener('click', function(e){
        e.stopPropagation();
        var open = menu.hidden;
        menu.hidden = !open;
        chip.setAttribute('aria-expanded', String(open));
      });
      document.getElementById('logoutBtn').addEventListener('click', function(){ setUser(null); });
    } else if(window.LAC_NO_GSI){
      slot.innerHTML = '';
    } else {
      slot.innerHTML = '<div id="gsiNavSlot"></div>';
      initGsiButton();
    }
  }
  window.LAC = { getUser: getUser, setUser: setUser, clientId: CLIENT_ID, renderAuth: renderAuth };
  function boot(){
    renderAuth();
    if(!getUser() && !window.LAC_NO_GSI){
      if(window.google && window.google.accounts && window.google.accounts.id){
        initGsiButton();
      } else {
        var s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true; s.defer = true;
        s.onload = initGsiButton;
        s.onerror = initGsiButton;
        document.head.appendChild(s);
      }
    }
    document.addEventListener('click', function(e){
      var wrap = document.querySelector('.profile-wrap');
      var menu = document.getElementById('profileMenu');
      if(wrap && menu && !menu.hidden && !wrap.contains(e.target)){
        menu.hidden = true;
        var chip = document.getElementById('profileChip');
        if(chip) chip.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape'){
        var menu = document.getElementById('profileMenu');
        if(menu && !menu.hidden) menu.hidden = true;
      }
    });
  }
  if(document.readyState === 'complete' || document.readyState === 'interactive'){ boot(); }
  else { document.addEventListener('DOMContentLoaded', boot); }
})();
