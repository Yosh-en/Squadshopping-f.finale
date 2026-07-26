function getOrCreateClientId(){
  try {
    let id = sessionStorage.getItem('squadClientId');
    if(!id){
      id = Math.random().toString(36).slice(2,10);
      sessionStorage.setItem('squadClientId', id);
    }
    return id;
  } catch(e){
    return Math.random().toString(36).slice(2,10);
  }
}

const state = {
  clientId: getOrCreateClientId(), name:'', roomId:'', catalog:[], room:null, ws:null, aiNote:'', searchTerm:'',
  knownTiedIds: new Set(), tieExplainerShown: false, chatOpen: false, lastChatCount: 0, hasInitializedTies: false,
  rouletteItemIds: null, rouletteLanded: false, pendingTieItemId: null, demoFabMsgTimer: null,
  knownCartIds: new Set(), hasInitializedCart: false,
  typingDebounceTimer: null, isCurrentlyTypingSignal: false,
};
const $ = s => document.querySelector(s);
const $all = s => document.querySelectorAll(s);

const backMap = { 'screen-profile':'screen-home', 'screen-landing':'screen-profile', 'screen-room':'screen-landing', 'screen-checkout':'screen-room' };

function showScreen(id){
  $all('.screen').forEach(s=>s.classList.remove('active'));
  $('#'+id).classList.add('active');
  $all('.nav-item').forEach(n=>n.classList.remove('active'));
  if(id === 'screen-home') $('#nav-home').classList.add('active');

  if(id !== 'screen-room' && id !== 'screen-checkout' && state.chatOpen){
    closeChatDrawer();
  }

  const left = $('#topbar-left');
  if(id === 'screen-home'){
    left.innerHTML = '<div class="m-logo">M</div>';
  } else {
    const back = backMap[id] || 'screen-home';
    left.innerHTML = `<button class="back-btn">←</button>`;
    left.querySelector('.back-btn').addEventListener('click', () => showScreen(back));
  }
}

// A room only counts as "still worth returning to" if it exists AND hasn't
// finished checkout yet (session_number only gets set once everyone's paid).
// Once a squad's order is placed, there's nothing left to do in it -- tapping
// "Shop Together" again should offer a fresh start, not reopen a done order.
function goToSquad(){
  const roomStillActive = state.roomId && state.room && !state.room.session_number;
  if(roomStillActive){
    showScreen('screen-room');
    return;
  }
  if(state.roomId) leaveRoom(); // clean up a finished room before showing a blank slate
  showScreen('screen-landing');
}

// ---- Who's using this tab? -----------------------------------------------
function getStoredUserName(){
  try { return sessionStorage.getItem('squadUserName') || ''; }
  catch(e){ return ''; }
}
function setStoredUserName(name){
  try { sessionStorage.setItem('squadUserName', name); } catch(e){}
}

function applyUserNameToUI(name){
  const initial = (name || '?').slice(0, 1).toUpperCase();
  const setText = (id, text) => { const el = $('#'+id); if(el) el.textContent = text; };
  setText('home-user-name', name);
  setText('profile-user-name', name);
  setText('profile-section-name', name);
  setText('profile-avatar-initial', initial);
  setText('profile-avatar-label', name);
  setText('create-starting-as-name', name);
  setText('join-starting-as-name', name);
}

function showOnboardingMobileStep(){
  $('#onboarding-step-mobile').style.display = 'block';
  $('#onboarding-step-name').style.display = 'none';
  $('#onboarding-modal').classList.add('show');
}
function showOnboardingNameStep(){
  $('#onboarding-step-mobile').style.display = 'none';
  $('#onboarding-step-name').style.display = 'block';
  $('#onboarding-modal').classList.add('show');
}
function closeOnboarding(){ $('#onboarding-modal').classList.remove('show'); }

(function initUserName(){
  const existing = getStoredUserName();
  if(existing) applyUserNameToUI(existing);
  else showOnboardingMobileStep();
})();

$('#onboarding-mobile-continue').addEventListener('click', () => {
  const mobile = $('#onboarding-mobile').value.trim();
  if(!mobile) return;
  showOnboardingNameStep();
});

$('#onboarding-name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#onboarding-name').value.trim();
  if(!name) return;
  setStoredUserName(name);
  applyUserNameToUI(name);
  closeOnboarding();
});

$('#demo-switch-name-btn').addEventListener('click', () => {
  $('#onboarding-name').value = getStoredUserName();
  showOnboardingNameStep();
});

$all('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
  $all('.tab-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  $all('.tab-panel').forEach(p=>p.classList.remove('active'));
  $('#panel-' + btn.dataset.tab).classList.add('active');
}));

function expandOptionalSection(sectionId, toggleId){
  $('#'+sectionId).style.display = 'block';
  $('#'+toggleId).style.display = 'none';
}
function setupOptionalToggle(toggleId, sectionId){
  $('#'+toggleId).addEventListener('click', () => expandOptionalSection(sectionId, toggleId));
}
setupOptionalToggle('toggle-recipient', 'recipient-section');
setupOptionalToggle('toggle-itinerary', 'itinerary-section');

$all('.preset-chip').forEach(btn => btn.addEventListener('click', () => {
  $('#create-itinerary').value = btn.dataset.preset;
}));

$all('.recipient-chip').forEach(btn => btn.addEventListener('click', () => {
  $('#create-recipient').value = btn.dataset.recipient;
  $all('.recipient-chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
}));
$('#create-recipient').addEventListener('input', () => {
  const val = $('#create-recipient').value;
  $all('.recipient-chip').forEach(c => c.classList.toggle('active', c.dataset.recipient === val));
});

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = getStoredUserName();
  const occasion = $('#create-occasion').value.trim() || 'Just browsing';
  const when = $('#create-when').value;
  const budget = parseInt($('#create-budget').value) || 0;
  const itinerary = $('#create-itinerary').value.split(',').map(s => s.trim()).filter(Boolean);
  const giftRecipient = $('#create-recipient').value.trim() || document.getElementById('screen-landing').dataset.giftRecipient || '';
  if(!name) return;
  const res = await fetch('/api/rooms', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({occasion, budget, when, itinerary, gift_recipient: giftRecipient})});
  const data = await res.json();
  delete document.getElementById('screen-landing').dataset.giftRecipient;
  enterRoom(data.room_id, name);
});

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = getStoredUserName();
  const code = $('#join-code').value.trim().toUpperCase();
  if(!name || !code) return;
  const res = await fetch('/api/rooms/' + code);
  const data = await res.json();
  if(data.error){
    $('#join-error').textContent = "Can't find that squad code -- double-check it.";
    return;
  }
  enterRoom(code, name);
});

// ---- Leaving / switching rooms cleanly ------------------------------------
// Clears every piece of per-room UI state and empties out the containers
// that render() would otherwise leave showing stale content from whichever
// room was open before. Shared by enterRoom() (switching into a fresh room)
// and leaveRoom() (going back to Home/landing with nothing active).
function resetPerRoomState(){
  state.room = null;
  state.aiNote = '';
  state.searchTerm = '';
  const searchInput = $('#product-search');
  if(searchInput) searchInput.value = '';

  state.knownTiedIds = new Set();
  state.tieExplainerShown = false;
  state.hasInitializedTies = false;
  state.knownCartIds = new Set();
  state.hasInitializedCart = false;
  state.lastChatCount = 0;
  state.rouletteItemIds = null;
  state.rouletteLanded = false;
  state.pendingTieItemId = null;
  cardSignatures = {};
  lastFilteredKey = null;

  $('#product-grid').innerHTML = '';
  $('#chat-messages').innerHTML = '';
  $('#chat-context-note').style.display = 'none';
  $('#catchup-banner').classList.remove('show');
  $('#checkout-items').innerHTML = '';
  $('#checkout-people').innerHTML = '';
  $('#checkout-status').innerHTML = '';
  const oldGiftNote = document.getElementById('gift-split-note');
  if(oldGiftNote) oldGiftNote.remove();
  const oldTripProgress = document.getElementById('trip-progress');
  if(oldTripProgress) oldTripProgress.remove();
  $('#validated-banner').style.display = 'none';
  $('#outfit-gap-nudge').style.display = 'none';
  closeChatDrawer();
  renderTypingIndicator([]);
}

// Detaching onmessage/onopen BEFORE closing is what actually matters here --
// without it, a message already in flight from the OLD room's socket could
// still land and overwrite state.room with stale data even after close()
// has been called, which is exactly what was causing squad #2 to visually
// "snap back" to squad #1's content mid-demo.
function closeSocketIfOpen(){
  if(!state.ws) return;
  state.ws.onmessage = null;
  state.ws.onopen = null;
  try { state.ws.close(); } catch(e){}
  state.ws = null;
}

function leaveRoom(){
  closeSocketIfOpen();
  state.roomId = '';
  resetPerRoomState();
}

function enterRoom(roomId, name){
  closeSocketIfOpen();
  resetPerRoomState();

  state.roomId = roomId;
  state.name = name;
  showScreen('screen-room');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/${roomId}?name=${encodeURIComponent(name)}&client_id=${state.clientId}`);
  ws.onopen = () => {
    if(state.preLikeItemId){
      ws.send(JSON.stringify({ action: 'react', item_id: state.preLikeItemId, reaction: 'like' }));
      state.preLikeItemId = null;
    }
  };
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if(msg.type === 'state'){
      state.room = msg.room;
      state.aiNote = msg.ai_note;
      render();
      if(msg.event){
        if(msg.event.roulette_item_ids !== undefined){
          showRouletteReveal(msg.event.roulette_item_ids, msg.event.name);
        } else if(msg.event.name !== state.name){
          showEventToast(msg.event);
        }
      }
    } else if(msg.type === 'catchup'){
      showCatchupBanner(msg.catchup);
    } else if(msg.type === 'typing'){
      renderTypingIndicator(msg.typers || []);
    }
  };
  state.ws = ws;

  fetch('/api/rooms/' + roomId).then(r=>r.json()).then(d => { state.catalog = d.catalog; render(); });
}

// ---- Product media (image or emoji fallback) ------------------------------
function mediaHtml(item){
  if(!item || !item.image) return (item && item.emoji) || '';
  return `<img class="media-img" loading="lazy" decoding="async" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name || '')}" data-emoji-fallback="${item.emoji || ''}" onerror="this.outerHTML=this.dataset.emojiFallback">`;
}

function rouletteSlotContent(item, room){
  const votes = room.reactions[item.id] || {};
  const likeCount = Object.values(votes).filter(v => v === 'like').length;
  const myVote = votes[state.clientId];
  const inCart = room.cart.includes(item.id);
  const tieOutcome = (room.tie_breaks || {})[item.id];
  const isTied = !inCart && !tieOutcome && Object.values(votes).length >= 2 && new Set(Object.values(votes)).size > 1;

  let footer;
  if(inCart){
    footer = `<div class="roulette-slot-status added">✓ In cart</div>`;
  } else if(tieOutcome){
    footer = `<div class="roulette-slot-status">${tieOutcome === 'added' ? '✓ Added' : '✕ Skipped'}</div>`;
  } else if(isTied){
    footer = `<button class="roulette-slot-tie-btn" data-tie-item="${item.id}">🎲 Tie</button>`;
  } else {
    footer = `
      <div class="roulette-slot-actions">
        <button class="roulette-slot-btn pass ${myVote === 'pass' ? 'active' : ''}" data-item="${item.id}" data-reaction="pass">✕</button>
        <button class="roulette-slot-btn like ${myVote === 'like' ? 'active' : ''}" data-item="${item.id}" data-reaction="like">♥</button>
      </div>
      ${likeCount ? `<div class="roulette-slot-likes">${likeCount} liked</div>` : ''}`;
  }

  return `
    <span class="roulette-slot-emoji">${item.emoji}</span>
    <span class="roulette-slot-name">${escapeHtml(item.name)}</span>
    <span class="roulette-slot-price">₹${item.price}</span>
    ${footer}`;
}

function refreshRouletteSlots(){
  if(!state.rouletteLanded || !state.rouletteItemIds || !state.room) return;
  if(!$('#roulette-modal').classList.contains('show')) return;
  const items = state.rouletteItemIds.map(id => state.catalog.find(c => c.id === id)).filter(Boolean);
  const slots = $('#roulette-reel').querySelectorAll('.roulette-slot');
  items.forEach((item, i) => {
    if(slots[i]) slots[i].innerHTML = rouletteSlotContent(item, state.room);
  });
}

function send(action, payload={}){
  if(state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({action, ...payload}));
}
function react(itemId, reaction){ send('react', {item_id: itemId, reaction}); }
function breakTie(itemId){ send('break_tie', {item_id: itemId}); }
function toggleFinalize(){ send('finalize'); }

let toastTimer = null;
function showEventToast(event){
  const el = $('#event-toast');
  let text;
  if(event.verb === 'broke the tie on'){
    text = `🎲 ${event.name} broke the tie on ${event.item} -- ${event.reason || (event.outcome === 'added' ? 'added' : 'skipped')}`;
  } else if(event.verb === 'paid their share'){
    text = `💳 ${event.name} paid their share -- ${event.item}`;
  } else if(event.verb.startsWith('assigned to') || event.verb === 'unassigned'){
    text = `${event.name} ${event.verb === 'unassigned' ? 'unassigned' : event.verb} -- ${event.item}`;
  } else if(event.item){
    text = `${event.name} ${event.verb} ${event.item}`;
  } else {
    text = `${event.name} ${event.verb}`;
  }

  if(event.item_id){
    text += ' -- tap to view';
    el.dataset.jumpItem = event.item_id;
    el.classList.add('clickable');
  } else {
    delete el.dataset.jumpItem;
    el.classList.remove('clickable');
  }

  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), event.item_id ? 7000 : 3200);
}

$('#event-toast').addEventListener('click', (e) => {
  const itemId = e.currentTarget.dataset.jumpItem;
  if(!itemId) return;
  const card = document.querySelector(`[data-card="${itemId}"]`);
  if(!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('just-highlighted');
  setTimeout(() => card.classList.remove('just-highlighted'), 1600);
  e.currentTarget.classList.remove('show');
});

function showCatchupBanner(catchup){
  const el = $('#catchup-banner');
  const voterList = catchup.voters.join(' and ');
  const plural = catchup.items_touched === 1 ? 'item' : 'items';
  let text = `👋 Welcome back! ${voterList} voted on ${catchup.items_touched} ${plural} while you were away`;
  text += catchup.needs_call > 0
    ? ` -- ${catchup.needs_call} need${catchup.needs_call === 1 ? 's' : ''} your call.`
    : `.`;
  if(catchup.tied_count > 0){
    text += ` ${catchup.tied_count} of those is a split vote -- look for the "Split vote" tag below.`;
  }
  el.innerHTML = `<span>${escapeHtml(text)}</span><button id="catchup-dismiss" type="button">✕</button>`;
  el.classList.add('show');
}

$('#catchup-banner').addEventListener('click', (e) => {
  if(e.target.closest('#catchup-dismiss')) $('#catchup-banner').classList.remove('show');
});

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const AVATAR_COLORS = ['#FF3F6C','#2E7DD6','#14A76C','#F5A623','#9B59B6','#E67E22','#1ABC9C','#E74C3C'];
function colorForClientId(clientId){
  let hash = 0;
  for(let i = 0; i < clientId.length; i++) hash = (hash * 31 + clientId.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
function avatarLabel(name){
  return (name || '?').slice(0, 2).toUpperCase();
}
function avatarHtml(clientId, name, extraClass = ''){
  return `<span class="avatar ${extraClass}" style="background:${colorForClientId(clientId)};" title="${escapeHtml(name)}">${escapeHtml(avatarLabel(name))}</span>`;
}

function formatWhen(iso){
  if(!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if(isNaN(d)) return '';
  return d.toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'});
}

function cardHtml(item, room){
  const votes = room.reactions[item.id] || {};
  const likeCount = Object.values(votes).filter(v=>v==='like').length;
  const myVote = votes[state.clientId];
  const inCart = room.cart.includes(item.id);
  const discount = Math.round((1 - item.price / item.mrp) * 100);
  const justLaunched = ['p1','p4','p9','p13'].includes(item.id);
  const tieOutcome = (room.tie_breaks || {})[item.id];
  const tieReason = (room.tie_break_reasons || {})[item.id];
  const isTied = !inCart && !tieOutcome && Object.values(votes).length >= 2 && new Set(Object.values(votes)).size > 1;
  const needsMyVote = !isTied && !inCart && !tieOutcome && Object.keys(votes).length > 0 && myVote === undefined;
  const iLikedIt = !isTied && !inCart && !tieOutcome && !needsMyVote && myVote === 'like';

  let footer;
  if(tieOutcome){
    footer = `<div class="tie-outcome">🎲 ${escapeHtml(tieReason || (tieOutcome === 'added' ? 'Added to cart.' : 'Skipped.'))}</div>`;
  } else if(isTied){
    footer = `<button class="tie-btn" data-tie-item="${item.id}">🎲 Break the tie</button>`;
  } else {
    footer = `
      <div class="card-actions">
        <button class="react-btn pass ${myVote==='pass' ? 'active' : ''}" data-item="${item.id}" data-reaction="pass">✕</button>
        <span class="like-count">${likeCount ? likeCount + ' liked' : ''}</span>
        <button class="react-btn like ${myVote==='like' ? 'active' : ''}" data-item="${item.id}" data-reaction="like">♥</button>
      </div>`;
  }

  return `
    <div class="card ${inCart ? 'in-cart' : ''} ${isTied ? 'tied' : ''} ${needsMyVote ? 'needs-vote' : ''} ${iLikedIt ? 'my-like' : ''}" data-card="${item.id}">
      ${inCart ? '<span class="cart-badge">In squad cart</span>' : ''}
      ${!inCart && justLaunched ? '<span class="launched-badge">Just Launched</span>' : ''}
      ${isTied ? '<span class="split-badge">Split vote</span>' : ''}
      ${needsMyVote ? '<span class="needs-vote-badge">Needs your vote</span>' : ''}
      ${iLikedIt ? '<span class="my-like-badge">♥ You liked this</span>' : ''}
      <div class="card-media">${mediaHtml(item)}</div>
      <div class="card-body">
        <div class="card-brand">${escapeHtml(item.brand)}</div>
        <div class="card-name">${escapeHtml(item.name)}</div>
        <div class="card-price-row">
          <span class="price">₹${item.price}</span>
          <span class="mrp">₹${item.mrp}</span>
          <span class="discount">${discount}% OFF</span>
        </div>
        <div class="card-rating">★ ${item.rating}</div>
      </div>
      ${footer}
    </div>
  `;
}

function matchesSearch(item, term){
  if(!term) return true;
  const hay = `${item.name} ${item.brand} ${item.tag} ${item.category||''}`.toLowerCase();
  return hay.includes(term.toLowerCase());
}

$('#product-search').addEventListener('input', (e) => {
  state.searchTerm = e.target.value;
  render();
});

$('#product-grid').addEventListener('click', (e) => {
  const reactBtn = e.target.closest('.react-btn');
  if(reactBtn){ react(reactBtn.dataset.item, reactBtn.dataset.reaction); return; }
  const tieBtn = e.target.closest('.tie-btn');
  if(tieBtn){ breakTie(tieBtn.dataset.tieItem); return; }
});

const OCCASION_TAGS = {
  'Birthday': ['ethnic', 'party', 'floral', 'beauty'],
  'Anniversary': ['ethnic', 'party', 'beauty'],
  'Wedding / Festive Function': ['ethnic', 'floral'],
  'Farewell / Graduation': ['western', 'office'],
  'Beach / Vacation Trip': ['beach', 'western'],
  'Office / Work': ['office', 'solid'],
  'Casual Everyday': ['western', 'solid'],
  'Monsoon Errands': ['monsoon', 'solid'],
};

function splitByOccasion(items, occasion){
  const tags = OCCASION_TAGS[occasion];
  if(!tags) return { matching: [], rest: items, hasSplit: false };
  const matching = items.filter(i => tags.includes(i.tag));
  const rest = items.filter(i => !tags.includes(i.tag));
  return { matching, rest, hasSplit: matching.length > 0 && rest.length > 0 };
}

const KEYWORD_TAG_RULES = [
  { keywords: ['mehendi','mehndi','haldi','sangeet'], tags: ['floral','ethnic'] },
  { keywords: ['shaadi','wedding','vivah','marriage'], tags: ['ethnic'] },
  { keywords: ['reception'], tags: ['party','ethnic'] },
  { keywords: ['festive','diwali','puja','navratri','function'], tags: ['ethnic','floral'] },
  { keywords: ['beach','vacation','trip','holiday','goa','pool','island'], tags: ['beach','western'] },
  { keywords: ['office','work','meeting','interview'], tags: ['office','solid'] },
  { keywords: ['party','club','night out','date night','date','clubbing'], tags: ['party','western'] },
  { keywords: ['cafe','brunch','casual','hangout','coffee','shopping'], tags: ['western','solid'] },
  { keywords: ['monsoon','rain','rainy'], tags: ['monsoon','solid'] },
];

function inferTagsForFunction(name){
  const lower = name.toLowerCase();
  const rule = KEYWORD_TAG_RULES.find(r => r.keywords.some(k => lower.includes(k)));
  return rule ? rule.tags : null;
}

const INDIA_SEASON_TAGS = {
  1:['ethnic','office'], 2:['ethnic','office'], 3:['western','beach'], 4:['western','beach'],
  5:['western','beach'], 6:['monsoon','solid'], 7:['monsoon','solid'], 8:['monsoon','solid'],
  9:['ethnic','floral'], 10:['ethnic','floral'], 11:['ethnic','floral'], 12:['ethnic','office'],
};
function seasonTagsFor(whenIso){
  if(!whenIso) return [];
  const d = new Date(whenIso + 'T00:00:00');
  if(isNaN(d)) return [];
  return INDIA_SEASON_TAGS[d.getMonth() + 1] || [];
}

function buildItinerarySections(items, itinerary, whenIso){
  const seasonTags = seasonTagsFor(whenIso);
  const usedIds = new Set();
  const MIN_SECTION_SIZE = 2;
  const sections = itinerary.map(fn => {
    const tags = inferTagsForFunction(fn);
    if(!tags) return { label: fn, items: [] };
    let matches = items.filter(i => !usedIds.has(i.id) && tags.includes(i.tag));
    if(matches.length < MIN_SECTION_SIZE){
      matches = items.filter(i => tags.includes(i.tag));
    }
    matches.sort((a, b) => (seasonTags.includes(a.tag) ? 0 : 1) - (seasonTags.includes(b.tag) ? 0 : 1));
    matches.forEach(m => usedIds.add(m.id));
    return { label: fn, items: matches };
  });
  const rest = items.filter(i => !usedIds.has(i.id));
  return { sections, rest };
}

let cardSignatures = {};
let lastFilteredKey = null;

function cardSignature(item, room){
  return JSON.stringify([
    room.reactions[item.id] || {},
    room.cart.includes(item.id),
    (room.tie_breaks || {})[item.id] || null,
  ]);
}

function renderGrid(filtered, room){
  const grid = $('#product-grid');
  const itinerary = room.itinerary || [];

  let ordered, filteredKey, buildHtml;

  if(itinerary.length){
    const { sections, rest } = buildItinerarySections(filtered, itinerary, room.when);
    ordered = [...sections.flatMap(s => s.items), ...rest];
    filteredKey = ordered.map(i => i.id).join(',') + '|itin:' + itinerary.join('>');
    buildHtml = () => {
      let html = '';
      sections.forEach(sec => {
        html += `<div class="occasion-divider">✦ Recs for ${escapeHtml(sec.label)}</div>`;
        html += sec.items.length
          ? sec.items.map(item => cardHtml(item, room)).join('')
          : `<div class="empty-note">Nothing tagged for "${escapeHtml(sec.label)}" in this catalog yet.</div>`;
      });
      if(rest.length){
        html += `<div class="occasion-divider muted">More to explore</div>`;
        html += rest.map(item => cardHtml(item, room)).join('');
      }
      return html;
    };
  } else {
    const { matching, rest, hasSplit } = splitByOccasion(filtered, room.occasion);
    ordered = hasSplit ? [...matching, ...rest] : filtered;
    filteredKey = ordered.map(i => i.id).join(',') + (hasSplit ? '|split' : '');
    buildHtml = () => {
      if(!hasSplit) return ordered.map(item => cardHtml(item, room)).join('');
      let html = `<div class="occasion-divider">✦ Picked for ${escapeHtml(room.occasion)}</div>`;
      html += matching.map(item => cardHtml(item, room)).join('');
      html += `<div class="occasion-divider muted">More to explore</div>`;
      html += rest.map(item => cardHtml(item, room)).join('');
      return html;
    };
  }

  if(!ordered.length){
    grid.innerHTML = `<div class="empty-note">No pieces match "${escapeHtml(state.searchTerm)}" -- try another word.</div>`;
    lastFilteredKey = filteredKey;
    cardSignatures = {};
    return;
  }

  if(filteredKey !== lastFilteredKey || !grid.children.length){
    grid.innerHTML = buildHtml();
    cardSignatures = {};
    ordered.forEach(item => { cardSignatures[item.id] = cardSignature(item, room); });
    lastFilteredKey = filteredKey;
    return;
  }

  ordered.forEach(item => {
    const sig = cardSignature(item, room);
    if(cardSignatures[item.id] === sig) return;
    const existing = grid.querySelector(`[data-card="${item.id}"]`);
    if(existing){
      const wrapper = document.createElement('div');
      wrapper.innerHTML = cardHtml(item, room).trim();
      existing.replaceWith(wrapper.firstElementChild);
    }
    cardSignatures[item.id] = sig;
  });
}

function fireConsensusCelebration(cardEl){
  cardEl.classList.remove('consensus-glow');
  const oldBurst = cardEl.querySelector('.confetti-burst');
  if(oldBurst) oldBurst.remove();

  requestAnimationFrame(() => {
    cardEl.classList.add('consensus-glow');
  });

  const burst = document.createElement('div');
  burst.className = 'confetti-burst';
  const emojis = ['🎉','✨','🎊','💫'];
  const pieceCount = 8;
  for(let i = 0; i < pieceCount; i++){
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    piece.textContent = emojis[i % emojis.length];
    const angle = (360 / pieceCount) * i + (Math.random() * 18 - 9);
    const dist = 42 + Math.random() * 18;
    const dx = Math.cos(angle * Math.PI / 180) * dist;
    const dy = Math.sin(angle * Math.PI / 180) * dist;
    piece.style.setProperty('--dx', dx + 'px');
    piece.style.setProperty('--dy', dy + 'px');
    piece.style.animationDelay = (Math.random() * 0.06) + 's';
    burst.appendChild(piece);
  }
  cardEl.appendChild(burst);

  setTimeout(() => {
    burst.remove();
    cardEl.classList.remove('consensus-glow');
  }, 850);
}

function detectConsensusCelebrations(room){
  const currentCartIds = new Set(room.cart);

  if(!state.hasInitializedCart){
    state.knownCartIds = new Set(currentCartIds);
    state.hasInitializedCart = true;
    return;
  }

  const freshIds = [...currentCartIds].filter(id => !state.knownCartIds.has(id));
  state.knownCartIds = currentCartIds;

  if(!freshIds.length) return;

  freshIds.forEach(id => {
    const card = document.querySelector(`[data-card="${id}"]`);
    if(card) fireConsensusCelebration(card);
  });
}

function render(){
  if(!state.room || !state.catalog.length) return;
  const room = state.room;

  $('#room-code-chip').textContent = state.roomId;
  $('#room-occasion').textContent = room.occasion;
  $('#room-when').textContent = room.when ? ('📅 ' + formatWhen(room.when)) : '';
  const giftNote = $('#room-gift-note');
  if(room.gift_recipient && room.gift_recipient.toLowerCase() !== 'myself'){
    giftNote.textContent = `🎁 Surprise for ${room.gift_recipient} -- keep this one on the down-low`;
    giftNote.style.display = 'block';
  } else {
    giftNote.style.display = 'none';
  }

  const participants = room.participants || room.members;
  $('#member-avatars').innerHTML = Object.entries(participants).map(([cid, n]) =>
    avatarHtml(cid, n)
  ).join('');
  const totalCount = Object.keys(participants).length;
  $('#member-count').textContent = totalCount === 1 ? '1 in squad' : `${totalCount} in squad`;

  $('#ai-note').textContent = state.aiNote || '';

  const filtered = state.catalog.filter(item => matchesSearch(item, state.searchTerm));
  renderGrid(filtered, room);

  const cartItems = room.cart.map(id => state.catalog.find(c => c.id === id)).filter(Boolean);
  const total = cartItems.reduce((s,i)=> s + i.price, 0);
  $('#cart-count').textContent = cartItems.length;
  $('#cart-total').textContent = '₹' + total;
  const budget = room.budget || 0;
  document.querySelector('.budget-track').style.display = budget ? 'block' : 'none';
  if(budget){
    const pct = Math.min(100, Math.round((total/budget)*100));
    $('#budget-fill').style.width = pct + '%';
    $('#budget-fill').classList.toggle('over', total > budget);
  }
  $('#budget-label').textContent = budget ? `₹${total} / ₹${budget}` : `₹${total} spent`;

  const finalizeBtn = $('#finalize-btn');
  finalizeBtn.textContent = room.finalized ? '✓ Go to checkout' : `Finalize Squad Cart (${cartItems.length})`;
  finalizeBtn.classList.toggle('locked', room.finalized);
  finalizeBtn.disabled = cartItems.length === 0 && !room.finalized;

  renderCheckout(cartItems, room);
  detectNewTies(room);
  detectConsensusCelebrations(room);
  renderChat(room);
  refreshRouletteSlots();
}

function getTiedIds(room){
  const majority = Math.max(2, Math.floor(Object.keys(room.members).length / 2) + 1);
  return state.catalog
    .filter(item => {
      if(room.cart.includes(item.id)) return false;
      if((room.tie_breaks || {})[item.id]) return false;
      const votes = Object.values(room.reactions[item.id] || {});
      return votes.length >= 2 && new Set(votes).size > 1;
    })
    .map(item => item.id);
}

function needsMyAttention(item, room){
  if(room.cart.includes(item.id)) return false;
  if((room.tie_breaks || {})[item.id]) return false;
  const votes = room.reactions[item.id] || {};
  if(!Object.keys(votes).length) return false;
  const isTied = Object.keys(votes).length >= 2 && new Set(Object.values(votes)).size > 1;
  if(isTied) return true;
  return !(state.clientId in votes);
}

function announceTie(itemId){
  state.pendingTieItemId = itemId;

  if($('#roulette-modal').classList.contains('show')){
    closeRouletteModal();
  }

  if(!state.tieExplainerShown){
    $('#tie-explainer').classList.add('show');
    state.tieExplainerShown = true;
  }

  const item = state.catalog.find(i => i.id === itemId);
  const note = $('#chat-context-note');
  note.innerHTML = `⚖️ Squad split on "${escapeHtml(item ? item.name : 'an item')}" -- talk it through here. <button type="button" id="chat-jump-to-tie" class="chat-jump-btn">Jump to item</button>`;
  note.style.display = 'block';
  openChatDrawer();
}

$('#chat-context-note').addEventListener('click', (e) => {
  if(!e.target.closest('#chat-jump-to-tie')) return;
  const itemId = state.pendingTieItemId;
  closeChatDrawer();
  if(!itemId) return;
  showScreen('screen-room');
  const card = document.querySelector(`[data-card="${itemId}"]`);
  if(!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('just-highlighted');
  setTimeout(() => card.classList.remove('just-highlighted'), 1600);
});

function detectNewTies(room){
  const currentTied = getTiedIds(room);

  if(!state.hasInitializedTies){
    currentTied.forEach(id => state.knownTiedIds.add(id));
    state.hasInitializedTies = true;
    return;
  }

  const freshIds = currentTied.filter(id => !state.knownTiedIds.has(id));
  currentTied.forEach(id => state.knownTiedIds.add(id));
  if(!freshIds.length) return;

  announceTie(freshIds[0]);
}

function openChatDrawer(){
  state.chatOpen = true;
  $('#chat-drawer').classList.add('open');
  $all('.unread-dot').forEach(d => d.classList.remove('show'));
  state.lastChatCount = (state.room.chat || []).length;
}
function closeChatDrawer(){
  state.chatOpen = false;
  $('#chat-drawer').classList.remove('open');
}

function renderChat(room){
  const messages = room.chat || [];
  const list = $('#chat-messages');
  list.innerHTML = messages.map(m => `
    <div class="chat-msg ${m.name === state.name ? 'me' : 'them'}">
      <div class="who">${escapeHtml(m.name)}</div>
      <div>${escapeHtml(m.text)}</div>
    </div>`).join('') || `<div class="empty-note" style="padding:20px 8px;">No messages yet -- say hi 👋</div>`;

  if(state.chatOpen){
    list.scrollTop = list.scrollHeight;
    state.lastChatCount = messages.length;
  } else if(messages.length > state.lastChatCount){
    $all('.unread-dot').forEach(d => d.classList.add('show'));
  }
}

$('#chat-input').addEventListener('input', () => {
  if(!state.isCurrentlyTypingSignal){
    state.isCurrentlyTypingSignal = true;
    send('typing_start');
  }
  clearTimeout(state.typingDebounceTimer);
  state.typingDebounceTimer = setTimeout(() => {
    state.isCurrentlyTypingSignal = false;
    send('typing_stop');
  }, 2500);
});

function renderTypingIndicator(typers){
  const others = typers.filter(n => n !== state.name);
  const wrap = $('#typing-indicator');
  const textEl = $('#typing-indicator-text');
  if(!others.length){ wrap.style.display = 'none'; return; }
  let text;
  if(others.length === 1) text = `${others[0]} is typing`;
  else if(others.length === 2) text = `${others[0]} and ${others[1]} are typing`;
  else text = `${others.length} people are typing`;
  textEl.textContent = text;
  wrap.style.display = 'flex';
}

function assignItem(itemId, buyerId){ send('assign', {item_id: itemId, buyer_id: buyerId}); }
function tagOccasion(itemId, tag){ send('tag_occasion', {item_id: itemId, tag}); }
function removeItem(itemId){ send('remove_item', {item_id: itemId}); }
function payShare(){ send('pay_share'); }

function renderCheckout(cartItems, room){
  const itemsEl = $('#checkout-items');
  const peopleEl = $('#checkout-people');
  const statusEl = $('#checkout-status');
  if(!itemsEl) return;

  $('#checkout-occasion').textContent = room.occasion;

  if(!cartItems.length){
    itemsEl.innerHTML = `<div class="empty-note">No items in the squad cart yet -- go back and swipe a few into consensus first.</div>`;
    peopleEl.innerHTML = '';
    statusEl.innerHTML = '';
    const oldNote = document.getElementById('gift-split-note');
    if(oldNote) oldNote.remove();
    return;
  }

  const members = room.participants || room.members;
  const assignments = room.assignments || {};
  const payments = room.payments || {};
  const occasionTags = room.occasion_tags || {};
  const itinerary = room.itinerary || [];
  $('#checkout-tag-hint').style.display = itinerary.length ? 'block' : 'none';

  const memberIds = Object.keys(members);
  const total = cartItems.reduce((s,i)=> s + i.price, 0);

  const recipient = (room.gift_recipient || '').trim();
  const isGiftSplit = recipient && recipient.toLowerCase() !== 'myself' && memberIds.length > 1;
  const equalShare = isGiftSplit ? Math.round(total / memberIds.length) : 0;

  const buyerIds = isGiftSplit ? memberIds : [...new Set(Object.values(assignments))];
  const allPaid = buyerIds.length > 0 && buyerIds.every(id => payments[id]);

  itemsEl.innerHTML = cartItems.map(item => {
    const assignedTo = assignments[item.id];
    const chips = Object.entries(members).map(([cid, n]) => `
      <button class="assign-chip ${assignedTo === cid ? 'active' : ''}" data-assign-item="${item.id}" data-assign-buyer="${cid}" style="${assignedTo === cid ? `background:${colorForClientId(cid)};border-color:${colorForClientId(cid)};` : ''}" title="${escapeHtml(n)}">
        ${escapeHtml(avatarLabel(n))}
      </button>`).join('');

    const tagRow = itinerary.length ? `
      <div class="tag-chip-row">
        ${itinerary.map(fn => `
          <button class="tag-chip ${occasionTags[item.id] === fn ? 'active' : ''}" data-tag-item="${item.id}" data-tag-fn="${escapeHtml(fn)}">
            ${escapeHtml(fn)}
          </button>`).join('')}
      </div>` : '';

    return `
      <div class="checkout-item">
        <div class="checkout-item-media">${mediaHtml(item)}</div>
        <div class="checkout-item-info">
          <div class="checkout-item-name">${escapeHtml(item.brand)} -- ${escapeHtml(item.name)}</div>
          <div class="checkout-item-price">₹${item.price}</div>
          ${tagRow}
        </div>
        <div class="assign-chips">${chips}</div>
        ${!allPaid ? `<div class="checkout-item-remove"><button class="remove-item-btn" data-remove-item="${item.id}" title="Remove from cart">🗑</button></div>` : ''}
      </div>`;
  }).join('');

  let progressEl = document.getElementById('trip-progress');
  if(itinerary.length){
    const tripProgress = itinerary.map(fn => {
      const itemsForFn = cartItems.filter(i => occasionTags[i.id] === fn);
      const boughtCount = itemsForFn.filter(i => payments[assignments[i.id]]).length;
      const done = itemsForFn.length > 0 && boughtCount === itemsForFn.length;
      return `<div class="trip-progress-row ${done ? 'done' : ''}">${escapeHtml(fn)}: ${boughtCount}/${itemsForFn.length} bought${done ? ' ✓' : ''}</div>`;
    }).join('');
    if(!progressEl){
      itemsEl.insertAdjacentHTML('beforebegin', `<div id="trip-progress" class="trip-progress"></div>`);
      progressEl = document.getElementById('trip-progress');
    }
    progressEl.innerHTML = tripProgress;
  } else if(progressEl){
    progressEl.remove();
  }

  const unassignedCount = cartItems.filter(i => !assignments[i.id]).length;

  let giftNoteEl = document.getElementById('gift-split-note');
  if(isGiftSplit){
    if(!giftNoteEl){
      peopleEl.insertAdjacentHTML('beforebegin', `<div id="gift-split-note" class="gift-split-note"></div>`);
      giftNoteEl = document.getElementById('gift-split-note');
    }
    giftNoteEl.textContent = `🎁 Splitting this gift ${memberIds.length} ways -- ₹${equalShare} each, no matter who's assigned what.`;
  } else if(giftNoteEl){
    giftNoteEl.remove();
  }

  peopleEl.innerHTML = Object.entries(members).map(([cid, n]) => {
    const hasPaid = !!payments[cid];
    const isMe = cid === state.clientId;

    let myTotal, hasStake;
    if(isGiftSplit){
      myTotal = equalShare;
      hasStake = true;
    } else {
      const myItems = cartItems.filter(i => assignments[i.id] === cid);
      myTotal = myItems.reduce((s,i) => s + i.price, 0);
      hasStake = myItems.length > 0;
    }

    let action;
    if(!hasStake){
      action = `<span class="pay-status muted">No items assigned</span>`;
    } else if(hasPaid){
      action = `<span class="pay-status paid">✓ Paid ₹${myTotal}</span>`;
    } else if(isMe){
      action = `<button class="pay-btn" data-pay="1">Pay my share -- ₹${myTotal}</button>`;
    } else {
      action = `<span class="pay-status muted">Waiting for payment (₹${myTotal})</span>`;
    }
    return `
      <div class="checkout-person">
        <div class="checkout-person-name">${avatarHtml(cid, n, 'inline-avatar')}${escapeHtml(n)}${isMe ? ' (you)' : ''}</div>
        ${action}
      </div>`;
  }).join('');

  if(!isGiftSplit && unassignedCount > 0){
    statusEl.className = 'checkout-status warn';
    statusEl.textContent = `${unassignedCount} item(s) still need an owner before payment.`;
  } else if(allPaid){
    statusEl.className = 'checkout-status done';
    statusEl.innerHTML = `
      🎉 Order placed! Everyone's paid their share.
      <div class="squad-score-badge">🏆 Squad Session #${room.session_number ?? '?'} with this crew</div>
      <button type="button" id="start-new-squad-btn" class="start-new-squad-btn">+ Start a new squad</button>
    `;
  } else {
    statusEl.className = 'checkout-status';
    statusEl.textContent = isGiftSplit
      ? `Splitting this gift ${memberIds.length} ways -- once everyone's paid their equal share, the order's complete.`
      : `Once everyone above has paid their own share, the order's complete -- no one has to front money for anyone else.`;
  }

  renderValidatedBanner(cartItems, room);
  renderOutfitGapNudge(cartItems, room);
}

// Delegated onto #checkout-status itself, not the button -- the container
// element persists across renders (only its innerHTML gets swapped), so this
// only needs to be bound once, same pattern as the validated-banner listener below.
$('#checkout-status').addEventListener('click', (e) => {
  if(!e.target.closest('#start-new-squad-btn')) return;
  leaveRoom();
  showScreen('screen-landing');
});

function renderValidatedBanner(cartItems, room){
  const el = $('#validated-banner');
  if(!cartItems.length){ el.style.display = 'none'; return; }
  const validatorCount = new Set(
    cartItems.flatMap(item => Object.keys(room.reactions[item.id] || {}).filter(cid => room.reactions[item.id][cid] === 'like'))
  ).size;
  if(validatorCount < 2){ el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = `
    <div class="validated-row">
      <span class="validated-short">🎯 ${validatorCount} people already said yes -- before a single rupee was spent.</span>
      <button type="button" class="validated-why-btn" id="validated-why-btn">Why?</button>
    </div>
    <div class="validated-body" id="validated-why-body" style="display:none;">
      Clothing returns in India run 25–40% -- the highest of any e-commerce category (Unicommerce India Ecommerce Index Report, 2023) --
      largely from items that don't match the occasion once they arrive. Peer-approved picks are a lever worth piloting against that number.
      <div class="validated-fine-print">*Hypothesis for a pilot to measure, not a claimed result.</div>
    </div>
  `;
}

function renderOutfitGapNudge(cartItems, room){
  const el = $('#outfit-gap-nudge');
  if(!cartItems.length){ el.style.display = 'none'; return; }
  const FOOTWEAR = 'Footwear', ACCESSORY = 'Accessory';
  const hasGarment = cartItems.some(i => i.category !== FOOTWEAR && i.category !== ACCESSORY);
  const hasFootwear = cartItems.some(i => i.category === FOOTWEAR);
  const hasAccessory = cartItems.some(i => i.category === ACCESSORY);
  if(!hasGarment){ el.style.display = 'none'; return; }
  const missing = [];
  if(!hasFootwear) missing.push('footwear');
  if(!hasAccessory) missing.push('accessories');
  if(!missing.length){ el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = `👟 Your ${escapeHtml(room.occasion)} look is missing ${missing.join(' and ')} -- want to browse those next?`;
}

$('#finalize-btn').addEventListener('click', () => {
  if(!state.room.finalized) toggleFinalize();
  showScreen('screen-checkout');

  const checkoutScreen = $('#screen-checkout');
  checkoutScreen.classList.remove('checkout-enter-active');
  checkoutScreen.classList.add('checkout-enter');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      checkoutScreen.classList.add('checkout-enter-active');
    });
  });
});

$('#copy-code-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(state.roomId);
  $('#copy-code-btn').textContent = 'Copied!';
  setTimeout(()=> $('#copy-code-btn').textContent = 'Copy code', 1200);
});

$all('.chat-toggle-btn').forEach(btn => btn.addEventListener('click', () => {
  state.chatOpen ? closeChatDrawer() : openChatDrawer();
}));
$('#chat-close-btn').addEventListener('click', closeChatDrawer);
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if(!text) return;
  send('chat', {text});
  input.value = '';
  clearTimeout(state.typingDebounceTimer);
  if(state.isCurrentlyTypingSignal){
    state.isCurrentlyTypingSignal = false;
    send('typing_stop');
  }
});
$('#tie-explainer-close').addEventListener('click', () => {
  $('#tie-explainer').classList.remove('show');
});

$('#demo-tools-toggle').addEventListener('click', () => {
  const panel = $('#demo-tools-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
});

$('#demo-time-travel-fab').addEventListener('click', () => {
  const msgEl = $('#demo-time-travel-fab-msg');
  fetch('/api/demo/time-travel', { method: 'POST' })
    .then(r => r.json())
    .then(d => {
      clearTimeout(state.demoFabMsgTimer);
      if(d.error){
        msgEl.textContent = '⚠️ No completed gift checkout yet -- finish one (with a recipient set) first, then come back here.';
        msgEl.style.display = 'block';
        state.demoFabMsgTimer = setTimeout(() => { msgEl.style.display = 'none'; }, 4500);
        return;
      }
      msgEl.style.display = 'none';
      checkReminders();
    });
});

$('#roulette-btn').addEventListener('click', () => {
  send('surprise_roulette');
});

function showRouletteReveal(itemIds, triggeredBy){
  const modal = $('#roulette-modal');
  const card = modal.querySelector('.roulette-modal-card');
  const reel = $('#roulette-reel');
  const doneBtn = $('#roulette-done-btn');
  const note = $('#roulette-modal-note');

  card.classList.remove('celebrate');
  doneBtn.style.display = 'none';
  state.rouletteLanded = false;
  const spunByOther = triggeredBy && triggeredBy !== state.name;

  if(!itemIds || !itemIds.length){
    note.textContent = spunByOther ? `${triggeredBy} gave it a spin --` : '';
    reel.innerHTML = `<div class="roulette-empty-note">Nothing fits what's left of the budget right now. Vote a couple of items out, or bump the budget, then spin again.</div>`;
    modal.classList.add('show');
    doneBtn.textContent = 'Got it';
    doneBtn.style.display = 'block';
    state.rouletteItemIds = null;
    return;
  }

  const items = itemIds.map(id => state.catalog.find(c => c.id === id)).filter(Boolean);
  note.textContent = spunByOther ? `${triggeredBy} spun it -- vote right here` : "Vote right here";
  reel.innerHTML = items.map(() => `<div class="roulette-slot spinning"><span class="roulette-slot-inner">🎲</span></div>`).join('');
  doneBtn.textContent = 'Done';
  modal.classList.add('show');
  state.rouletteItemIds = itemIds;

  const slots = reel.querySelectorAll('.roulette-slot');
  const LAND_STEP_MS = 180, FIRST_LAND_MS = 480;
  items.forEach((item, i) => {
    setTimeout(() => {
      const slot = slots[i];
      if(!slot) return;
      slot.classList.remove('spinning');
      slot.classList.add('landed');
      slot.innerHTML = rouletteSlotContent(item, state.room);
    }, FIRST_LAND_MS + i * LAND_STEP_MS);
  });
  setTimeout(() => {
    doneBtn.style.display = 'block';
    card.classList.add('celebrate');
    state.rouletteLanded = true;
  }, FIRST_LAND_MS + items.length * LAND_STEP_MS + 150);
}

function closeRouletteModal(){
  $('#roulette-modal').classList.remove('show');
  state.rouletteItemIds = null;
  state.rouletteLanded = false;
}
$('#roulette-close-btn').addEventListener('click', closeRouletteModal);
$('#roulette-modal').addEventListener('click', (e) => {
  if(e.target.id === 'roulette-modal') closeRouletteModal();
});
$('#roulette-done-btn').addEventListener('click', closeRouletteModal);
$('#roulette-reel').addEventListener('click', (e) => {
  const reactBtn = e.target.closest('.roulette-slot-btn');
  if(reactBtn){ react(reactBtn.dataset.item, reactBtn.dataset.reaction); return; }
  const tieBtn = e.target.closest('.roulette-slot-tie-btn');
  if(tieBtn){ breakTie(tieBtn.dataset.tieItem); return; }
});

$('#checkout-items').addEventListener('click', (e) => {
  const chip = e.target.closest('.assign-chip');
  if(chip){
    const itemId = chip.dataset.assignItem;
    const buyerId = chip.dataset.assignBuyer;
    const alreadyAssignedToThem = chip.classList.contains('active');
    assignItem(itemId, alreadyAssignedToThem ? null : buyerId);
    return;
  }
  const tagChip = e.target.closest('.tag-chip');
  if(tagChip){
    const itemId = tagChip.dataset.tagItem;
    const fn = tagChip.dataset.tagFn;
    const alreadyTagged = tagChip.classList.contains('active');
    tagOccasion(itemId, alreadyTagged ? null : fn);
    return;
  }
  const removeBtn = e.target.closest('.remove-item-btn');
  if(removeBtn){ removeItem(removeBtn.dataset.removeItem); return; }
});

$('#validated-banner').addEventListener('click', (e) => {
  if(!e.target.closest('#validated-why-btn')) return;
  const body = $('#validated-why-body');
  body.style.display = body.style.display === 'none' ? 'block' : 'none';
});

$('#checkout-people').addEventListener('click', (e) => {
  if(e.target.closest('[data-pay]')) payShare();
});

(function checkDemoMode(){
  const params = new URLSearchParams(location.search);
  if(params.get('demo') !== '1') return;
  fetch('/api/demo', { method: 'POST' })
    .then(r => r.json())
    .then(d => enterRoom(d.room_id, 'Judge'));
})();

let activeReminder = null;

const OCCASION_EMOJI = {
  'Birthday': '🎂', 'Anniversary': '💕', 'Wedding / Festive Function': '💍',
  'Farewell / Graduation': '🎓',
};

const REC_CARD_GRADIENTS = [
  'linear-gradient(135deg,#F4D58D,#B8860B)',
  'linear-gradient(135deg,#FFD6E8,#D8447C)',
  'linear-gradient(135deg,#C9F2D8,#3F9E6B)',
  'linear-gradient(135deg,#CFE8F3,#7FB3D5)',
  'linear-gradient(135deg,#F3D1FF,#9A4FC4)',
];

function checkReminders(){
  fetch('/api/reminders')
    .then(r => r.json())
    .then(d => {
      const reminder = (d.reminders || [])[0];
      if(!reminder) return;
      activeReminder = reminder;

      const icon = OCCASION_EMOJI[reminder.occasion] || '🎁';
      $('#reminder-modal-sub').textContent = `It's around ${new Date().toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' })}`;
      const isSelf = reminder.person.toLowerCase() === 'myself';
      const possessive = isSelf ? 'Your' : `${reminder.person}'s`;
      const forWhom = isSelf ? 'yourself' : reminder.person;

      $('#reminder-headline').innerHTML = `${icon} <b>${possessive} ${escapeHtml(reminder.occasion)}</b> is coming up again!`;
      $('#reminder-subnote').textContent = `Last year you bought this for ${forWhom} -- ${reminder.occasion}.`;

      const boughtMedia = mediaHtml({
        image: reminder.bought_item_image,
        emoji: reminder.bought_item_emoji || '🛍️',
        name: reminder.bought_item_name || 'that item',
      });
      $('#reminder-orig').innerHTML = reminder.bought_item_name
        ? `<span class="memory-orig-thumb">${boughtMedia}</span><span>${escapeHtml(reminder.bought_item_name)}</span>`
        : '';
      $('#reminder-orig').style.display = reminder.bought_item_name ? 'flex' : 'none';

      $('#reminder-suggest-intro').textContent = `We thought ${isSelf ? 'you' : reminder.person} might like these this year:`;

      $('#reminder-recs').innerHTML = (reminder.recommendations || []).map((r, i) => `
        <div class="reminder-rec-card">
          <div class="reminder-rec-thumb" style="background:${REC_CARD_GRADIENTS[i % REC_CARD_GRADIENTS.length]};">${mediaHtml(r)}</div>
          <div class="rec-name">${escapeHtml(r.name)}</div>
          <div class="rec-price">₹${r.price}</div>
          <button type="button" class="rec-add-btn" data-rec-item="${r.id}">Add to Bag</button>
        </div>
      `).join('') || '<div class="reminder-rec muted">No close matches in the catalog this time.</div>';

      $('#reminder-modal').classList.add('show');
    })
    .catch(() => {});
}
checkReminders();

function openLandingForReminder(occasion, recipient){
  showScreen('screen-profile');
  showScreen('screen-landing');
  $('#create-occasion').value = occasion;
  $('#create-itinerary').value = '';
  $('#create-recipient').value = recipient;
  $all('.recipient-chip').forEach(c => c.classList.toggle('active', c.dataset.recipient === recipient));
  if(recipient) expandOptionalSection('recipient-section', 'toggle-recipient');
}

$('#reminder-shop-btn').addEventListener('click', () => {
  if(!activeReminder) return;
  $('#reminder-modal').classList.remove('show');
  openLandingForReminder(activeReminder.occasion, activeReminder.person);
});

$('#reminder-recs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rec-item]');
  if(!btn || !activeReminder) return;
  $('#reminder-modal').classList.remove('show');
  state.preLikeItemId = btn.dataset.recItem;
  openLandingForReminder(activeReminder.occasion, activeReminder.person);
});
$('#reminder-close-btn').addEventListener('click', () => {
  $('#reminder-modal').classList.remove('show');
});