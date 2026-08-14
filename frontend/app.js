// Your identity within a squad, stable across reloads.
//
// This used to generate a fresh UUID on EVERY page load despite its name --
// nothing ever read it back. On a deployed app that's serious: participants
// are keyed by client_id and are deliberately never pruned (so a wifi blip
// doesn't change the consensus bar), so one refresh registered you as an
// additional person who could never vote. In a 3-person squad, two refreshes
// pushes the majority bar from 2 to 3 while only 3 people can actually
// vote -- consensus becomes unreachable and nothing can ever reach the cart.
//
// sessionStorage, not localStorage, on purpose: it survives a refresh (the
// bug) but is per-tab, so opening a second tab still gives you a second
// identity -- which is exactly how the app gets demoed by one person.
function getOrCreateClientId(){
  try {
    const existing = sessionStorage.getItem('squadClientId');
    if(existing) return existing;
  } catch(e) {}

  let id;
  try {
    id = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2,10) + Date.now().toString(36);
  } catch(e) {
    id = Math.random().toString(36).slice(2,10) + Date.now().toString(36);
  }

  try { sessionStorage.setItem('squadClientId', id); } catch(e) {}
  return id;
}

const state = {
  clientId: getOrCreateClientId(), name: '', roomId: '', catalog: [], room: null, ws: null, aiNote: '', searchTerm: '',
  knownTiedIds: new Set(), chatOpen: false, lastChatCount: 0, hasInitializedTies: false, voiceMessages: [],
  rouletteItemIds: null, rouletteLanded: false, pendingTieItemId: null,
  knownCartIds: new Set(), hasInitializedCart: false,
  typingDebounceTimer: null, isCurrentlyTypingSignal: false,
  feedScores: {},
  relevantIds: null,
  autoShownTieIds: new Set(),
  tieModalItemId: null,
  tieModalView: 'choose',
  consideringOthers: [],
  returnToCheckoutAfterJump: false,
  roulettePulsedCartIds: new Set(),
  currentConsideringItemId: null,
  reconnectAttempts: 0,
  reconnectTimer: null,
};
const $ = s => document.querySelector(s);
const $all = s => document.querySelectorAll(s);

// Mirrors backend's main.py MAX_SQUAD_SIZE -- kept in sync manually, same
// reasoning as OCCASION_TAGS/KEYWORD_TAG_RULES below. The backend's
// websocket connect is the actually-authoritative cap (it closes the
// socket with code 4008 if a genuinely new participant tries to join a
// full squad); this copy is just so the join form can show a friendly
// error immediately, before ever opening a socket.
const MAX_SQUAD_SIZE = 6;

const backMap = { 'screen-profile':'screen-home', 'screen-landing':'screen-profile', 'screen-room':'screen-landing', 'screen-checkout':'screen-room' };

function showScreen(id){
  $all('.screen').forEach(s=>s.classList.remove('active'));
  $('#'+id).classList.add('active');
  $all('.nav-item').forEach(n=>n.classList.remove('active'));
  if(id === 'screen-home') $('#nav-home').classList.add('active');
  if(id === 'screen-landing') updateSquadResumeBanner();
  if(id !== 'screen-room'){
    state.returnToCheckoutAfterJump = false;
  }
  syncReturnToCheckoutBtn();

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
// Whether there's an active (unfinished) squad worth offering to resume --
// session_number only gets set once everyone's paid, so an unfinished squad
// still has real work left in it.
function hasActiveSquad(){
  return !!(state.roomId && state.room && !state.room.session_number);
}

// Updates (or hides) the "You've got a squad going" banner on the landing
// screen. Called from showScreen() itself rather than only from goToSquad(),
// so it stays correct regardless of how someone actually arrives at
// landing -- tapping the teaser, using the back button, or switching tabs.
function updateSquadResumeBanner(){
  const banner = $('#squad-resume-banner');
  if(!banner) return;
  if(!hasActiveSquad()){
    banner.style.display = 'none';
    return;
  }
  $('#squad-resume-detail').textContent = `${state.room.occasion} -- code ${state.roomId}`;
  banner.style.display = 'flex';
}

$('#squad-resume-continue-btn').addEventListener('click', () => {
  showScreen('screen-room');
});
$('#squad-resume-fresh-link').addEventListener('click', () => {
  leaveRoom();
  updateSquadResumeBanner();
});

// No longer force-reenters an active squad -- previously, tapping "Shop
// Together" while a squad was already open would silently drop you straight
// back into it with no way to start something new short of finishing
// checkout first. Now it always goes to landing; if there's an active squad,
// the resume banner above offers a clear choice instead of deciding for you.
function goToSquad(){
  if(state.roomId && state.room && state.room.session_number){
    leaveRoom(); // a finished squad has nothing left to resume -- clean slate
  }
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
function getStoredUserEmail(){
  try { return sessionStorage.getItem('squadUserEmail') || ''; }
  catch(e){ return ''; }
}
function setStoredUserEmail(email){
  try {
    sessionStorage.setItem('squadUserEmail', email);
  } catch(e){}
}
function clearStoredIdentity() {
  try { 
    sessionStorage.removeItem('squadUserEmail'); 
    sessionStorage.removeItem('squadUserName'); 
  } catch (e) { }
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

function showOnboardingLoginStep(){
  $('#onboarding-step-login').style.display = 'block';
  clearCollisionPrompt();
  $('#onboarding-modal').classList.add('show');
}

function closeOnboarding(){ $('#onboarding-modal').classList.remove('show'); }

(function initUserName(){
  const existingEmail = getStoredUserEmail();
  const existingName = getStoredUserName();
  if(existingEmail && existingName) applyUserNameToUI(existingName);
  else showOnboardingLoginStep();
})();

// "Login" only ever checks whether this email has an account -- it never
// checks the password field. There's no real backend auth in this build,
// so pretending to verify a password would be a false promise, not a real
// safeguard. The field stays visually (it's what makes this read as a real
// login rather than a magic-link gimmick).
// Actually performs the login call. Split out from the submit handler so
// the collision-confirmation buttons below can re-call it with
// confirm_existing/confirm_new set, without duplicating the fetch logic.
async function attemptLogin(name, extra = {}){
  const errorEl = $('#onboarding-login-error');
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ...extra })
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      setStoredUserEmail(data.user_id);
      setStoredUserName(data.name || name);
      applyUserNameToUI(data.name || name);
      closeOnboarding();
      return;
    }

    if (data.error === 'name_taken') {
      // A real person is already using this name -- don't guess. Ask once,
      // plainly, instead of silently merging into whoever that is. This is
      // the ONLY extra step in the whole flow, and only ever appears on an
      // actual collision -- a unique name still logs straight in.
      //
      // The LOGIN button is hidden while this is pending (see the
      // .collision-pending CSS): leaving it visible put three buttons in a
      // row with no breathing space, and tapping it would only have
      // re-asked the identical question. The two answers ARE the submit now.
      errorEl.classList.add('login-collision');
      errorEl.innerHTML = `
        <div class="login-collision-q">There's already a squad member named <b>${escapeHtml(data.existing_name)}</b>. Is that you?</div>
        <div class="login-collision-actions">
          <button type="button" class="login-collision-yes" data-collision-name="${escapeHtml(name)}">Yes, that's me</button>
          <button type="button" class="login-collision-no" data-collision-name="${escapeHtml(name)}">No, that's someone else</button>
        </div>`;
      $('#onboarding-login-form').classList.add('collision-pending');
      return;
    }

    clearCollisionPrompt();
    errorEl.textContent = data.error || 'Could not continue. Please try again.';
  } catch (err) {
    console.error(err);
    clearCollisionPrompt();
    errorEl.textContent = 'Unable to connect. Please try again.';
  }
}

// Puts the form back to its normal one-button state.
function clearCollisionPrompt(){
  const errorEl = $('#onboarding-login-error');
  errorEl.classList.remove('login-collision');
  errorEl.innerHTML = '';
  $('#onboarding-login-form').classList.remove('collision-pending');
}

// Editing the name makes the pending question stale -- it was about the old
// name. Clear it so LOGIN comes back rather than leaving them staring at a
// question that no longer matches what's in the box.
$('#onboarding-name').addEventListener('input', clearCollisionPrompt);

$('#onboarding-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = $('#onboarding-name').value.trim();
  const errorEl = $('#onboarding-login-error');
  errorEl.textContent = '';

  if(!name){
    errorEl.textContent = 'Please enter your name.';
    return;
  }

  await attemptLogin(name);
});

// Handles the two collision-confirmation buttons rendered above. Delegated
// onto the error slot itself since its content is replaced dynamically.
$('#onboarding-login-error').addEventListener('click', (e) => {
  const yesBtn = e.target.closest('.login-collision-yes');
  if(yesBtn){
    const name = yesBtn.dataset.collisionName;
    clearCollisionPrompt();
    attemptLogin(name, { confirm_existing: true });
    return;
  }
  const noBtn = e.target.closest('.login-collision-no');
  if(noBtn){
    const name = noBtn.dataset.collisionName;
    clearCollisionPrompt();
    attemptLogin(name, { confirm_new: true });
  }
});

// "Switch account" in Profile's Demo Tools -- clears local identity only
// (the account and its taste profile stay intact server-side) and re-shows
// login so a different email can sign in on this same tab.
$('#demo-switch-name-btn').addEventListener('click', () => {
  clearStoredIdentity();
  $('#onboarding-name').value = '';
  showOnboardingLoginStep();
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
  $('#create-recipient-relation').value = btn.dataset.recipient;
  $all('.recipient-chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
}));

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = getStoredUserName();
  const occasion = $('#create-occasion').value.trim() || 'Just browsing';
  const when = $('#create-when').value;
  const budget = parseInt($('#create-budget').value) || 0;
  const itinerary = $('#create-itinerary').value.split(',').map(s => s.trim()).filter(Boolean);
  const giftRecipientRelation = $('#create-recipient-relation').value.trim();
  const giftRecipientName = $('#create-recipient-name').value.trim();
  if(!name) return;
  const res = await fetch('/api/rooms', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      occasion, budget, when, itinerary,
      gift_recipient_relation: giftRecipientRelation,
      gift_recipient_name: giftRecipientName,
      creator_email: getStoredUserEmail(),
    })
  });
  const data = await res.json();
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
  // Friendly heads-up before ever opening a socket. The backend's websocket
  // connect is still the real, authoritative cap enforcement (see
  // main.py's MAX_SQUAD_SIZE) -- this is just so someone doesn't watch the
  // screen switch to the room and then bounce straight back out.
  const participantCount = Object.keys(data.participants || {}).length;
  if(data.at_capacity || participantCount >= MAX_SQUAD_SIZE){
    $('#join-error').textContent = `This squad's already got ${MAX_SQUAD_SIZE} people -- ask them to make room, or start your own squad instead.`;
    return;
  }
  $('#join-error').textContent = '';
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
  state.hasInitializedTies = false;
  state.knownCartIds = new Set();
  state.hasInitializedCart = false;
  state.lastChatCount = 0;
  state.voiceMessages = [];
  state.feedScores = {};
  state.relevantIds = null;
  const aiChip = $('#ai-filter-chip');
  if(aiChip) aiChip.classList.remove('show');
  state.autoShownTieIds = new Set();
  state.tieModalItemId = null;
  state.tieModalView = 'choose';
  const tieModal = $('#tie-modal');
  if(tieModal) tieModal.classList.remove('show');
  state.consideringOthers = [];
  state.returnToCheckoutAfterJump = false;
  const returnBtn = $('#return-to-checkout');
  if(returnBtn) returnBtn.classList.remove('show');
  if(reservationTickInterval){ clearInterval(reservationTickInterval); reservationTickInterval = null; }
  toastQueue = [];
  toastCurrentlyShowing = false;
  clearTimeout(toastTimer);
  $('#event-toast').classList.remove('show');
  state.rouletteItemIds = null;
  state.rouletteLanded = false;
  state.roulettePulsedCartIds = new Set();
  state.pendingTieItemId = null;
  state.currentConsideringItemId = null;
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

// Detaching onmessage/onopen/onclose BEFORE closing is what actually
// matters here -- without it, a message already in flight from the OLD
// room's socket could still land and overwrite state.room with stale data
// even after close() has been called, which is exactly what was causing
// squad #2 to visually "snap back" to squad #1's content mid-demo.
function closeSocketIfOpen(){
  clearTimeout(state.reconnectTimer);
  state.reconnectAttempts = 0;
  showReconnectBanner(false);
  if(!state.ws) return;
  state.ws.onmessage = null;
  state.ws.onopen = null;
  state.ws.onclose = null;
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
  state.reconnectAttempts = 0;
  showScreen('screen-room');

  connectSocket(roomId, name);

  fetch('/api/rooms/' + roomId).then(r=>r.json()).then(d => {
    state.catalog = d.catalog;
    state.feedScores = d.feed_scores || {};
    if(d.relevant_ids) state.relevantIds = new Set(d.relevant_ids);
    render();
  });
}

// Opens the websocket for a room. Used both by enterRoom() (fresh entry --
// resets everything, switches screen) and by attemptReconnect() below (a
// dropped connection coming back -- must NOT reset local state or jump
// screens, since the whole point is that the person shouldn't notice they
// were disconnected beyond a brief banner).
function connectSocket(roomId, name){
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const email = getStoredUserEmail();
  const ws = new WebSocket(`${proto}://${location.host}/ws/${roomId}?name=${encodeURIComponent(name)}&client_id=${state.clientId}&email=${encodeURIComponent(email)}`);
  ws.onopen = () => {
    // A real reconnect, not the first connect -- confirm it landed and
    // reset the backoff so the NEXT drop starts retrying quickly again
    // rather than inheriting a long delay from this one.
    if(state.reconnectAttempts > 0) showReconnectBanner(false);
    state.reconnectAttempts = 0;
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
      state.feedScores = msg.feed_scores || {};
      if(msg.relevant_ids) state.relevantIds = new Set(msg.relevant_ids);
      render();
      if(msg.event){
        if(msg.event.roulette_item_ids !== undefined){
          showRouletteReveal(msg.event.roulette_item_ids, msg.event.name);
        } else if(msg.event.name !== state.name){
          enqueueEventToast(msg.event);
          if(msg.event.item_id) highlightCardIfVisible(msg.event.item_id);
        }
      }
    } else if (msg.type === 'catchup') {
      showCatchupBanner(msg.catchup);
    } else if (msg.type === 'typing') {
      renderTypingIndicator(msg.typers || [], msg.recorders || []);
      renderConsideringBanner(msg.considering || []);
    }
    else if (msg.type === 'voice_chat') {
      if (msg.message) {
        state.voiceMessages.push(msg.message);
        renderChat(state.room);

        if (!state.chatOpen) {
          $all('.unread-dot').forEach(d => d.classList.add('show'));
        }
      }
    }
  };
  // Code 4008 is the backend's squad-full rejection -- only ever fires for a
  // genuinely NEW participant, never a returning one, so it's never worth
  // retrying: bounce back to landing with an explanation, same as before.
  //
  // Every OTHER close -- a wifi blip, a phone backgrounding the tab and the
  // OS suspending the connection (both routine on a room full of people on
  // their own phones), a brief server hiccup -- used to just leave the
  // screen sitting there silently with a dead socket and stale data. On a
  // live judged walkthrough that reads as "the app broke," with no way to
  // tell whether it's actually broken or just needs a second to catch up.
  // Reconnect automatically instead, and say so on screen while it's
  // happening. closeSocketIfOpen() always nulls onclose BEFORE calling
  // close(), so if this handler fires at all, the drop was real -- never
  // triggered by the person's own "leave room" or "switch account" action.
  ws.onclose = (evt) => {
    if(evt.code === 4008 && state.roomId === roomId){
      state.ws = null;
      leaveRoom();
      showScreen('screen-landing');
      $('#join-error').textContent = `This squad's already got ${MAX_SQUAD_SIZE} people -- ask them to make room, or start your own squad instead.`;
      return;
    }
    if(state.roomId === roomId) attemptReconnect(roomId, name);
  };
  state.ws = ws;
}

const MAX_RECONNECT_ATTEMPTS = 8;

function attemptReconnect(roomId, name){
  state.reconnectAttempts++;
  showReconnectBanner(true, state.reconnectAttempts > 3);
  if(state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS){
    // Genuinely gone, not just a blip -- say so plainly rather than
    // retrying forever with no way out.
    showReconnectBanner(true, true, true);
    return;
  }
  // Backoff: 1s, 2s, 4s, 8s, capped at 8s. Fast enough that a two-second
  // wifi hiccup is invisible; capped so it isn't hammering the server if
  // the connection is down for longer.
  const delay = Math.min(1000 * (2 ** (state.reconnectAttempts - 1)), 8000);
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    if(state.roomId !== roomId) return; // left the room while waiting
    connectSocket(roomId, name);
  }, delay);
}

// A small, unmissable but non-blocking banner -- deliberately NOT a modal,
// since a dropped connection reconnecting in the background shouldn't stop
// someone from reading the card in front of them.
function showReconnectBanner(show, slow = false, failed = false){
  const el = $('#reconnect-banner');
  if(!el) return;
  if(!show){ el.classList.remove('show'); return; }
  if(failed){
    el.textContent = "Can't reconnect -- check your connection, then rejoin with the squad code.";
    el.classList.add('show', 'failed');
  } else {
    el.textContent = slow
      ? 'Still trying to reconnect...'
      : 'Connection dropped -- reconnecting...';
    el.classList.remove('failed');
    el.classList.add('show');
  }
}

// ---- Product media (image or emoji fallback) ------------------------------
function mediaHtml(item){
  if(!item || !item.image) return (item && item.emoji) || '';
  return `<img class="media-img" loading="lazy" decoding="async" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name || '')}" data-emoji-fallback="${item.emoji || ''}" onerror="this.outerHTML=this.dataset.emojiFallback">`;
}

// ---- Shared vote-status logic (majority / deadlock), aware of squads
// bigger than 2 people ------------------------------------------------------
// Mirrors backend's ai_coordinator.vote_status() -- kept in sync manually,
// same reasoning as OCCASION_TAGS/KEYWORD_TAG_RULES below.
//
// This replaces the old "any 2 conflicting votes = tied" check that used
// to live inline wherever a card needed to know its own vote state. That
// read was fine for a 2-person squad -- with nobody else who could ever
// vote, any disagreement really was a permanent deadlock. But for a 3-5
// person squad, 2 people disagreeing while the rest haven't voted yet is
// just an in-progress read, not a real stall -- flagging it as a "tie"
// would nag the squad into a coin-flip constantly instead of letting the
// remaining votes actually settle it.
//
// "deadlocked" now only fires once EVERY participant has voted and it's an
// exact 50/50 split -- which, by the math, is only even possible for an
// even-sized squad. Odd-sized squads can never truly deadlock once
// everyone's in: they either clear majority or they don't, cleanly.
function computeVoteStatus(votes, participantCount){
  const values = Object.values(votes || {});
  const likes = values.filter(v => v === 'like').length;
  const passes = values.filter(v => v === 'pass').length;
  const voted = likes + passes;
  const remaining = Math.max(0, participantCount - voted);
  const majority = participantCount <= 1 ? 1 : Math.max(2, Math.floor(participantCount / 2) + 1);

  if(likes >= majority) return likes >= majority && passes > 0 ? 'contested_consensus' : 'consensus_like';
  // ORDER MATTERS -- deadlock BEFORE rejected. An exact 50/50 split also
  // can't reach majority, so testing 'rejected' first swallows every real
  // tie (including the ordinary 1-1 in a 2-person squad) and the tie-breaker
  // silently never gets offered. Mirrors the same ordering note in
  // ai_coordinator.vote_status().
  if(remaining === 0 && likes === passes && likes > 0) return 'deadlocked';
  if(likes + remaining < majority) return 'rejected';
  if(voted > 0) return 'in_progress';
  return 'unvoted';
}

// participants (survives a disconnect), not members (live sockets only) --
// the bar for consensus, and what counts as a genuine deadlock, shouldn't
// shift just because someone's wifi blipped for a second. Mirrors the same
// fallback used server-side in ai_coordinator.get_ai_suggestion().
function participantCountOf(room){
  const participants = room.participants || room.members || {};
  return Object.keys(participants).length;
}

function rouletteSlotContent(item, room){
  const votes = room.reactions[item.id] || {};
  const likeCount = Object.values(votes).filter(v => v === 'like').length;
  const myVote = votes[state.clientId];
  const inCart = room.cart.includes(item.id);
  const participantCount = participantCountOf(room);
  const voteStatus = computeVoteStatus(votes, participantCount);
  const isTied = !inCart && voteStatus === 'deadlocked';

  const discount = item.mrp
    ? Math.round((1 - item.price / item.mrp) * 100)
    : 0;

  const rouletteVoteButtons = () => `
    <div class="roulette-slot-actions">
      <button
        class="roulette-slot-btn pass ${myVote === 'pass' ? 'active' : ''}"
        data-item="${item.id}"
        data-reaction="pass">
        ✕
      </button>

      <button
        class="roulette-slot-btn like ${myVote === 'like' ? 'active' : ''}"
        data-item="${item.id}"
        data-reaction="like">
        ♥
      </button>
    </div>`;

  // A slot is ~110px wide -- far too narrow for advice text, so it just gets
  // the same single entry point the shelf card uses. Tapping it closes the
  // roulette and opens the tie popup (see the #roulette-reel handler), rather
  // than stacking one overlay on another.
  const rouletteTieBtnHtml = () =>
    `<button class="roulette-slot-tie-btn" data-tie-open="${item.id}">Break the tie</button>`;

  let footer;

  if(inCart){
    // Still open to votes, same reasoning as the main shelf card below --
    // a majority got it here, but anyone who hasn't weighed in yet (or
    // wants to change their mind) still can. This used to be a dead-end
    // "✓ In cart" badge with no way for a late voter (the 3rd, 4th, 5th
    // person to open the roulette) to register an opinion at all -- now
    // it's exactly like every other undecided slot, just already carted.
    const passCount = Object.values(votes).filter(v => v === 'pass').length;
    if(passCount > 0){
      // Same objection mechanic as the main shelf card -- a late dissent on
      // a carted item stays in the cart on majority, but can be escalated
      // to the real tie-breaker rather than counting for nothing.
      footer = rouletteVoteButtons()
        + `<div class="roulette-slot-status objected">⚠ ${likeCount}-${passCount}, objected</div>`
        + rouletteTieBtnHtml();
    } else {
      const remainingVoters = Math.max(0, participantCount - likeCount);
      const waitNote = remainingVoters > 0
        ? ` · ${remainingVoters} more welcome`
        : '';
      footer = rouletteVoteButtons() + `<div class="roulette-slot-status added">✓ In cart${waitNote}</div>`;
    }
  } else if(isTied){
    footer = rouletteVoteButtons() + rouletteTieBtnHtml();
  } else {
    footer = rouletteVoteButtons() + (likeCount ? `<div class="roulette-slot-likes">${likeCount} liked</div>` : '');
  }

  return `
    <div class="roulette-slot-media">
      ${mediaHtml(item)}
    </div>

    <div class="roulette-slot-body">
      <div class="roulette-slot-brand">
        ${escapeHtml(item.brand)}
      </div>

      <div class="roulette-slot-name">
        ${escapeHtml(item.name)}
      </div>

      <div class="roulette-slot-price-row">
        <span class="roulette-slot-price">
          ₹${item.price}
        </span>

        <span class="roulette-slot-mrp">
          ₹${item.mrp}
        </span>

        <span class="roulette-slot-discount">
          ${discount}% OFF
        </span>
      </div>
    </div>

    ${footer}
  `;
}

function refreshRouletteSlots(){
  if(!state.rouletteLanded || !state.rouletteItemIds || !state.room) return;
  if(!$('#roulette-modal').classList.contains('show')) return;
  const items = state.rouletteItemIds.map(id => state.catalog.find(c => c.id === id)).filter(Boolean);
  const slots = $('#roulette-reel').querySelectorAll('.roulette-slot');
  items.forEach((item, i) => {
    if(slots[i]) slots[i].innerHTML = rouletteSlotContent(item, state.room);
  });

  // A brief pulse on whichever slot just reached consensus -- acknowledges
  // it without touching the modal or any other still-undecided slot. The
  // squad might still be deciding on the rest, so nothing here closes
  // anything; that stays a manual "Done" tap.
  state.rouletteItemIds.forEach((id, i) => {
    if(!state.room.cart.includes(id) || state.roulettePulsedCartIds.has(id)) return;
    state.roulettePulsedCartIds.add(id);
    const slot = slots[i];
    if(!slot) return;
    slot.classList.remove('just-added');
    requestAnimationFrame(() => slot.classList.add('just-added'));
    setTimeout(() => slot.classList.remove('just-added'), 700);
  });
}

function send(action, payload={}){
  if(state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({action, ...payload}));
}
function react(itemId, reaction){
  send('react', {item_id: itemId, reaction});
  // Voting IS the decision, so you're no longer "looking at" it -- clear the
  // signal rather than leaving the squad waiting on you for 60s of timeout.
  if(state.currentConsideringItemId === itemId) updateConsideringSignal(null);
}
// Asks the AI for its read. Deliberately named for what it does -- it
// requests advice and cannot change the cart. See tie_break_advice() in
// ai_coordinator.py for why the AI no longer decides ties itself.
function requestAdvice(itemId){ send('request_advice', {item_id: itemId}); }
function toggleFinalize(){ send('finalize'); }

let toastTimer = null;
let toastQueue = [];
let toastCurrentlyShowing = false;
const TOAST_QUEUE_CAP = 5;

function highlightCardIfVisible(itemId){
  const card = document.querySelector(`[data-card="${itemId}"]`);
  if(!card) return;
  const grid = $('#product-grid');
  if(!grid) return;
  const cardRect = card.getBoundingClientRect();
  const gridRect = grid.getBoundingClientRect();
  const isVisible = cardRect.bottom > gridRect.top && cardRect.top < gridRect.bottom;
  if(!isVisible) return;
  card.classList.remove('just-highlighted');
  requestAnimationFrame(() => card.classList.add('just-highlighted'));
  setTimeout(() => card.classList.remove('just-highlighted'), 1600);
}

function enqueueEventToast(event){
  toastQueue.push(event);
  if(toastQueue.length > TOAST_QUEUE_CAP) toastQueue.shift();
  advanceToastQueue();
}

function advanceToastQueue(){
  if(toastCurrentlyShowing || !toastQueue.length) return;
  toastCurrentlyShowing = true;
  const event = toastQueue.shift();
  showEventToast(event, () => {
    toastCurrentlyShowing = false;
    advanceToastQueue();
  });
}

function showEventToast(event, onDone){
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
  el._toastDone = onDone || null;
  toastTimer = setTimeout(() => dismissCurrentToast(), toastDurationFor(event));
}

// A toast you're meant to ACT on needs long enough to notice it, read whose
// name it is, and reach up and tap it -- 6.5s was routinely gone before that
// happened, especially mid-scroll. Non-tappable toasts are pure information
// and can stay brief.
//
// The exception is a burst: with 6 people voting at once, several toasts can
// queue up, and holding each one for 11s would put the last one ~a minute
// behind the thing it's describing. So when others are already waiting, they
// go quick -- a stale toast is worse than a missed one, and the card itself
// still shows the vote either way.
function toastDurationFor(event){
  const backedUp = toastQueue.length > 0;
  if(!event.item_id) return backedUp ? 2600 : 4000;
  return backedUp ? 4500 : 11000;
}

function dismissCurrentToast(){
  const el = $('#event-toast');
  el.classList.remove('show');
  clearTimeout(toastTimer);
  const done = el._toastDone;
  el._toastDone = null;
  if(done) setTimeout(done, 260);
}

$('#event-toast').addEventListener('click', (e) => {
  const itemId = e.currentTarget.dataset.jumpItem;
  if(!itemId){ dismissCurrentToast(); return; }
  jumpToItemCard(itemId);
  dismissCurrentToast();
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

// A short-lived nudge for anything in the shell that ISN'T built for this
// demo (category tiles, the hero banner, fwd/now/LUXE/Bag). Distinct from
// showEventToast()/toastQueue: those are squad-vote events with their own
// ordering and duration logic, and this has nothing to do with a room. A tap
// on a decorative element should feel acknowledged, not silent -- silence is
// what makes a UI read as broken during a walkthrough, whereas the SAME
// unbuilt element with a clear "this demo's about Shop Together" response
// reads as an intentional scope choice.
let homeNudgeTimer = null;
function showHomeNudge(text, durationMs = 2600){
  const el = $('#event-toast');
  delete el.dataset.jumpItem;
  el.classList.remove('clickable');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(homeNudgeTimer);
  homeNudgeTimer = setTimeout(() => el.classList.remove('show'), durationMs);
}

// Delegated once on #screen-home rather than per-element, so it also covers
// anything added to the home screen later without needing a matching
// listener. home-squad-teaser and .home-demo-btn are real, wired features --
// explicitly excluded so this never intercepts a click meant for them.
$('#screen-home').addEventListener('click', (e) => {
  if(e.target.closest('.home-squad-teaser') || e.target.closest('.home-demo-btn')) return;
  const target = e.target.closest('.shortcut, .trending-chip, .hero-banner, .offer-strip, .cat-grid-item');
  if(!target) return;
  showHomeNudge('This demo is focused on Shop Together -- tap below to try it 👇');
});

// Same idea for the three nav items that aren't wired (fwd/now/LUXE). Bag
// isn't built either but reads least like a dead end if it nudges toward the
// one place items actually end up: the squad checkout.
$('#nav-fwd').addEventListener('click', () => showHomeNudge('Not part of this demo -- Shop Together is the feature to try 👇'));
$('#nav-now').addEventListener('click', () => showHomeNudge('Not part of this demo -- Shop Together is the feature to try 👇'));
$('#nav-luxe').addEventListener('click', () => showHomeNudge('Not part of this demo -- Shop Together is the feature to try 👇'));
$('#nav-bag').addEventListener('click', () => showHomeNudge('Nothing here yet -- items land in a squad\'s cart during Shop Together.'));

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

function cardHtml(item, room, isTopPick=false, matchesAi=false){
  const votes = room.reactions[item.id] || {};
  const likeCount = Object.values(votes).filter(v=>v==='like').length;
  const passCount = Object.values(votes).filter(v=>v==='pass').length;
  const myVote = votes[state.clientId];
  const inCart = room.cart.includes(item.id);
  const discount = Math.round((1 - item.price / item.mrp) * 100);
  const justLaunched = ['p1','p4','p9','p13'].includes(item.id);
  const participantCount = participantCountOf(room);
  const voteStatus = computeVoteStatus(votes, participantCount);
  // A real deadlock now only means "everyone's voted, exact 50/50" -- see
  // computeVoteStatus()'s comment above. Two people disagreeing while a
  // 3rd/4th/5th person hasn't voted yet no longer trips this.
  const isTied = !inCart && voteStatus === 'deadlocked';
  const needsMyVote = !isTied && !inCart && Object.keys(votes).length > 0 && myVote === undefined;
  const iLikedIt = !isTied && !inCart && !needsMyVote && myVote === 'like';
  // Mixed votes that AREN'T a real deadlock yet -- just waiting on more
  // people. Worth a quiet status line so the squad knows it's in-progress,
  // not stuck, and can jump straight to a tie-break if they'd rather not wait.
  const showProgress = !inCart && !isTied && voteStatus === 'in_progress' && likeCount > 0 && passCount > 0;
  const stillWaitingOn = Math.max(0, participantCount - likeCount - passCount);

  // Shared row of vote buttons -- used both for the normal undecided state
  // AND, now, for an item that's already reached the cart. Previously the
  // buttons vanished entirely the instant an item hit consensus, which
  // meant anyone who hadn't voted yet (the 3rd, 4th, 5th person in a bigger
  // squad) had no way to ever register an opinion, and their taste never
  // reached the recommender. Voting after the fact can still pull an item
  // back OUT of the cart if enough existing likes flip -- the backend
  // recomputes majority on every vote regardless of current cart state.
  const voteButtons = (extraClass = '') => `
    <div class="card-actions ${extraClass}">
      <button class="react-btn pass ${myVote==='pass' ? 'active' : ''}" data-item="${item.id}" data-reaction="pass">✕</button>
      <span class="like-count">${likeCount ? likeCount + ' liked' : ''}</span>
      <button class="react-btn like ${myVote==='like' ? 'active' : ''}" data-item="${item.id}" data-reaction="like">♥</button>
    </div>`;

  // How many participants haven't cast any vote at all yet on this item.
  // An item can hit the cart on majority (e.g. 3 of 4) before the last
  // person has voted -- their vote still counts (it's saved, and can still
  // pull the item back out if an existing liker flips), it just can't be
  // the deciding vote on its own once majority's mathematically locked in.
  // This line is purely so that remaining voter can SEE their vote is still
  // wanted, instead of the card silently reading as "already decided."
  const votedCount = likeCount + passCount;
  const remainingVoters = Math.max(0, participantCount - votedCount);
  // A carted item somebody has voted AGAINST. Majority still rules (it stays
  // in the cart -- one late objector shouldn't get a unilateral veto over
  // four other people), but the objection is surfaced and can be escalated
  // to the real tie-breaker, which genuinely can remove it. Without this, a
  // late vote is arithmetically incapable of changing anything, which makes
  // asking for it dishonest. See vote_status() in ai_coordinator.py.
  const isContestedInCart = inCart && passCount > 0;

  // One entry point, one button, whether or not advice has been asked for
  // yet. Everything the tie needs -- the split, the options, the AI's read --
  // lives in the popup instead of being crammed into a grid card, which is
  // what forced 8px type and stacked buttons before.
  const tieBreakRow = `
    <div class="tie-break-row">
      <button class="tie-break-btn" data-tie-open="${item.id}">Break the tie</button>
    </div>`;

  let footer;
  if(isContestedInCart){
    footer = voteButtons('cart-actions')
      + `<div class="cart-objection-note">⚠ In on a ${likeCount}-${passCount} majority</div>`
      + tieBreakRow;
  } else if(inCart){
    const waitNote = remainingVoters > 0
      ? ` · waiting on ${remainingVoters} more vote${remainingVoters === 1 ? '' : 's'}`
      : '';
    footer = voteButtons('cart-actions') + `<div class="cart-locked-note">✓ In squad cart${waitNote}</div>`;
  } else if(isTied){
    // Vote row stays exactly where it is on every other card -- changing your
    // own vote is still the natural resolution. The tie-break button is an
    // extra option below it, not a replacement for voting.
    footer = voteButtons() + tieBreakRow;
  } else {
    footer = voteButtons() + (showProgress
      ? `<div class="mixed-progress-note">${likeCount} liked, ${passCount} passed -- waiting on ${stillWaitingOn} more</div>`
      : '');
  }

  return `
    <div class="card ${inCart ? 'in-cart' : ''} ${isContestedInCart ? 'contested' : ''} ${isTied ? 'tied' : ''} ${needsMyVote ? 'needs-vote' : ''} ${iLikedIt ? 'my-like' : ''}" data-card="${item.id}">
      ${inCart ? '<span class="cart-badge">In squad cart</span>' : ''}
      ${!inCart && !isTied && !needsMyVote && !iLikedIt && matchesAi ? '<span class="ai-match-badge">✦ You asked for this</span>' : (!inCart && !isTied && !needsMyVote && !iLikedIt && isTopPick ? '<span class="top-pick-badge">✦ Top pick for you</span>' : '')}
      ${!inCart && justLaunched ? '<span class="launched-badge">Just Launched</span>' : ''}
      ${isContestedInCart ? '<span class="objection-badge">⚠ Objected</span>' : ''}
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

// ---- The tie popup -------------------------------------------------------
// Everything about a split vote happens here now, instead of being split
// across a top banner, the AI note bar, and a cramped grid card all saying
// versions of the same thing. The card keeps one button; this is what it
// opens.
//
// SIX-PERSON BEHAVIOUR -- the things that only bite once a squad is big:
//   * Only an exact even split counts as a deadlock (3-3 of 6). Odd squads
//     can't deadlock at all once everyone's voted -- see computeVoteStatus().
//   * With 6 people voting, several items can deadlock within seconds of
//     each other. A popup per tie would be a barrage, so it auto-opens for
//     at most ONE item, once (tracked in state.autoShownTieIds), and never
//     for a second tie while it's already open. Every other tie stays
//     reachable from its own card's Tie-break button, on the user's terms.
//   * It never auto-opens over the chat drawer or the roulette -- someone
//     mid-conversation or mid-spin shouldn't get hijacked.
//   * Advice is shared room state, so if one person taps "Get my read",
//     everyone with the popup open on that item sees it appear (render()
//     calls refreshTieModal on every broadcast).
//   * If the squad resolves the tie while you're reading, the popup says so
//     rather than silently sitting there with stale options.
function openTieModal(itemId, opts = {}){
  if(!itemId || !state.room) return;
  state.tieModalItemId = itemId;
  // If advice already exists, go straight to it -- re-tapping Tie-break
  // after someone's already asked should show the read, not ask again.
  const hasAdvice = !!(state.room.tie_advice || {})[itemId];
  state.tieModalView = opts.view || (hasAdvice ? 'advice' : 'choose');
  renderTieModal();
}

function closeTieModal(){
  state.tieModalItemId = null;
  state.tieModalView = 'choose';
  const overlay = $('#tie-modal');
  if(overlay) overlay.classList.remove('show');
}

// Called both on open and from render(), so an open popup stays truthful as
// votes and advice arrive from the rest of the squad.
function refreshTieModal(){
  if(state.tieModalItemId) renderTieModal();
}

function renderTieModal(){
  const overlay = $('#tie-modal');
  const body = $('#tie-modal-body');
  if(!overlay || !body) return;
  const itemId = state.tieModalItemId;
  if(!itemId || !state.room){ overlay.classList.remove('show'); return; }

  const item = state.catalog.find(i => i.id === itemId);
  const itemName = item ? item.name : 'this item';
  const votes = state.room.reactions[itemId] || {};
  const likes = Object.values(votes).filter(v => v === 'like').length;
  const passes = Object.values(votes).filter(v => v === 'pass').length;
  const participantCount = participantCountOf(state.room);
  const notVoted = Math.max(0, participantCount - likes - passes);
  const inCart = state.room.cart.includes(itemId);
  const voteStatus = computeVoteStatus(votes, participantCount);
  const advice = (state.room.tie_advice || {})[itemId];

  const stillContested = inCart ? passes > 0 : voteStatus === 'deadlocked';

  // Spelling out the actual numbers matters much more at 6 people than at 2:
  // "3-3" is instantly legible, "the squad is split" is not.
  const tallyLine = `<div class="tie-modal-tally">${likes} liked · ${passes} passed${notVoted > 0 ? ` · ${notVoted} yet to vote` : ' · everyone’s voted'}</div>`;

  if(!stillContested){
    body.innerHTML = `
      <div class="tie-modal-title">✓ Settled</div>
      <div class="tie-modal-sub">The squad moved on from ${escapeHtml(itemName)} -- ${inCart ? "it's in the cart" : 'no split left to break'}.</div>
      ${tallyLine}
      <button type="button" class="tie-modal-primary" data-tie-modal-close="1">Close</button>`;
    overlay.classList.add('show');
    return;
  }

  if(state.tieModalView === 'advice'){
    if(advice){
      const yes = advice.verdict === 'yes';
      body.innerHTML = `
        <div class="tie-modal-title">✦ My read on ${escapeHtml(itemName)}</div>
        ${tallyLine}
        <div class="tie-modal-advice ${yes ? 'verdict-yes' : 'verdict-no'}">
          <div class="tie-modal-verdict">${yes ? '👍' : '👎'} ${escapeHtml(advice.headline || '')}</div>
          <div class="tie-modal-reason">${escapeHtml(advice.reason || '')}</div>
        </div>
        <div class="tie-modal-footnote">Advice only -- the item moves when someone changes their vote.</div>
        <button type="button" class="tie-modal-secondary" data-tie-discuss="1">💬 Discuss in chat</button>
        <button type="button" class="tie-modal-primary" data-tie-modal-close="1">Got it</button>`;
    } else {
      body.innerHTML = `
        <div class="tie-modal-title">✦ Reading the room...</div>
        <div class="tie-modal-sub">One moment.</div>`;
    }
    overlay.classList.add('show');
    return;
  }

  body.innerHTML = `
    <div class="tie-modal-title">Split vote on ${escapeHtml(itemName)}</div>
    <div class="tie-modal-sub">${inCart
      ? "It's in the cart on a majority, but not everyone agrees."
      : "Nothing gets decided for you -- the item only moves when someone changes their vote."}</div>
    ${tallyLine}
    <button type="button" class="tie-modal-primary" data-tie-discuss="1">💬 Discuss in chat</button>
    <button type="button" class="tie-modal-secondary" data-tie-advice="1">✦ Get my read</button>`;
  overlay.classList.add('show');
}

$('#tie-modal').addEventListener('click', (e) => {
  // Tapping the dimmed backdrop closes it, same as every other modal here.
  if(e.target.id === 'tie-modal' || e.target.closest('[data-tie-modal-close]') || e.target.closest('#tie-modal-close')){
    closeTieModal();
    return;
  }
  if(e.target.closest('[data-tie-discuss]')){
    const itemId = state.tieModalItemId;
    closeTieModal();
    if(itemId) openChatForItem(itemId);
    return;
  }
  if(e.target.closest('[data-tie-advice]')){
    state.tieModalView = 'advice';
    requestAdvice(state.tieModalItemId);
    renderTieModal();
  }
});

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
  const tieBtn = e.target.closest('[data-tie-open]');
  if(tieBtn){ openTieModal(tieBtn.dataset.tieOpen); return; }
  const discussBtn = e.target.closest('[data-discuss-item]');
  if(discussBtn){ openChatForItem(discussBtn.dataset.discussItem); return; }
});

// (OCCASION_TAGS used to be duplicated here purely to decide the shelf's
// section split. That's now answered by the backend via relevant_ids -- see
// splitByOccasion() -- so this copy is gone. One table, one source of truth.)

function byFeedScore(a, b){
  return (state.feedScores[b.id] ?? 0) - (state.feedScores[a.id] ?? 0);
}

// Which items sit under "Picked for <occasion>" vs "More to explore".
// The decision comes from the backend (relevant_ids), which owns the single
// occasion->category relevance table. This used to be a second copy of that
// logic living here in the frontend, which had already drifted out of sync
// with the backend's -- items scoring well in the ranker were being filed
// under "More to explore".
function splitByOccasion(items){
  const sorted = [...items].sort(byFeedScore);
  const relevant = state.relevantIds;
  // No relevance data yet (first paint, before the socket's first message):
  // show one ranked list rather than inventing a split.
  if(!relevant) return { matching: sorted, rest: [], hasSplit: false };
  const matching = sorted.filter(i => relevant.has(i.id));
  const rest = sorted.filter(i => !relevant.has(i.id));
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

function buildItinerarySections(items, itinerary){
  const usedIds = new Set();
  const MIN_SECTION_SIZE = 2;
  const sections = itinerary.map(fn => {
    const tags = inferTagsForFunction(fn);
    if(!tags) return { label: fn, items: [] };
    let matches = items.filter(i => !usedIds.has(i.id) && tags.includes(i.tag));
    if(matches.length < MIN_SECTION_SIZE){
      matches = items.filter(i => tags.includes(i.tag));
    }
    matches.sort(byFeedScore);
    matches.forEach(m => usedIds.add(m.id));
    return { label: fn, items: matches };
  });
  const rest = items.filter(i => !usedIds.has(i.id)).sort(byFeedScore);
  return { sections, rest };
}

let cardSignatures = {};
let lastFilteredKey = null;

function cardSignature(item, room, isTopPick=false, matchesAi=false){
  return JSON.stringify([
    room.reactions[item.id] || {},
    room.cart.includes(item.id),
    !!(room.tie_advice || {})[item.id],
    isTopPick,
    matchesAi,
  ]);
}

// The single highest-scoring item nobody's voted on yet -- makes the
// recommendation engine's effect visible the moment the shelf loads,
// instead of only showing up as a subtle reorder nobody notices. Only ever
// one badge at a time, and never on something already decided (voted,
// carted, tied) -- the point is to flag what's worth looking at next, not
// to relitigate something already settled.
function topPickId(items, room){
  let bestId = null, bestScore = -Infinity;
  for(const item of items){
    if(room.cart.includes(item.id)) continue;

    if((room.reactions[item.id] || {})[state.clientId] !== undefined) continue;
    const score = state.feedScores[item.id] ?? -Infinity;
    if(score > bestScore){ bestScore = score; bestId = item.id; }
  }
  return bestId;
}

function renderGrid(filtered, room){
  const grid = $('#product-grid');
  const itinerary = room.itinerary || [];
  const topPick = topPickId(filtered, room);
  const aiFilter = room.ai_chat_filter || null;

  let ordered, filteredKey, buildHtml;

  if(itinerary.length){
    const { sections, rest } = buildItinerarySections(filtered, itinerary);
    ordered = [...sections.flatMap(s => s.items), ...rest];
    filteredKey = ordered.map(i => i.id).join(',') + '|itin:' + itinerary.join('>') + '|top:' + topPick + '|ai:' + (aiFilter ? aiFilter.summary : '');
    buildHtml = () => {
      let html = '';
      sections.forEach(sec => {
        html += `<div class="occasion-divider">✦ Recs for ${escapeHtml(sec.label)}</div>`;
        html += sec.items.length
          ? sec.items.map(item => cardHtml(item, room, item.id === topPick, matchesAiFilter(item, aiFilter))).join('')
          : `<div class="empty-note">Nothing tagged for "${escapeHtml(sec.label)}" in this catalog yet.</div>`;
      });
      if(rest.length){
        html += `<div class="occasion-divider muted">More to explore</div>`;
        html += rest.map(item => cardHtml(item, room, item.id === topPick, matchesAiFilter(item, aiFilter))).join('');
      }
      return html;
    };
  } else {
    const { matching, rest, hasSplit } = splitByOccasion(filtered);
    // BUG FIX: this used to fall back to `filtered` -- i.e. RAW CATALOG ORDER
    // -- whenever hasSplit was false. splitByOccasion sorts by score and then
    // that sort was silently discarded, so on the commonest path of all
    // ("Just Browsing", the default in the dropdown) the recommender's output
    // never reached the screen at all. Always use the sorted lists.
    ordered = [...matching, ...rest];
    filteredKey = ordered.map(i => i.id).join(',') + (hasSplit ? '|split' : '') + '|top:' + topPick + '|ai:' + (aiFilter ? aiFilter.summary : '');
    buildHtml = () => {
      if(!hasSplit) return ordered.map(item => cardHtml(item, room, item.id === topPick, matchesAiFilter(item, aiFilter))).join('');
      let html = `<div class="occasion-divider">✦ Picked for ${escapeHtml(room.occasion)}</div>`;
      html += matching.map(item => cardHtml(item, room, item.id === topPick, matchesAiFilter(item, aiFilter))).join('');
      html += `<div class="occasion-divider muted">More to explore</div>`;
      html += rest.map(item => cardHtml(item, room, item.id === topPick, matchesAiFilter(item, aiFilter))).join('');
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
    ordered.forEach(item => { cardSignatures[item.id] = cardSignature(item, room, item.id === topPick, matchesAiFilter(item, aiFilter)); });
    lastFilteredKey = filteredKey;
    return;
  }

  ordered.forEach(item => {
    const sig = cardSignature(item, room, item.id === topPick, matchesAiFilter(item, aiFilter));
    if(cardSignatures[item.id] === sig) return;
    const existing = grid.querySelector(`[data-card="${item.id}"]`);
    if(existing){
      const wrapper = document.createElement('div');
      wrapper.innerHTML = cardHtml(item, room, item.id === topPick, matchesAiFilter(item, aiFilter)).trim();
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

// Mirrors backend's gift_recipient_display() -- name wins when given (more
// specific), relation is the fallback for a quick gift with no name typed.
function giftRecipientDisplay(room){
  const name = (room.gift_recipient_name || '').trim();
  const relation = (room.gift_recipient_relation || '').trim();
  return name || relation;
}
// Mirrors backend's is_gift_recipient_set() -- kept in sync manually, same
// reasoning as MAX_SQUAD_SIZE. Satisfied by EITHER field: typing just a name
// ("Rhea") with no chip picked used to produce a room that looked like a gift
// room to the person who made it but wasn't one to any of the code -- no even
// split, no secrecy note, and no reminder a year later. A name is strictly
// more specific than a relation, so requiring the vaguer one was backwards.
function isGiftRoom(room){
  const relation = (room.gift_recipient_relation || '').trim().toLowerCase();
  const name = (room.gift_recipient_name || '').trim();
  // 'myself' only appears in legacy rooms -- the chip has been removed, since
  // shopping for yourself is the default, not a recipient.
  if(relation === 'myself') return false;
  return !!(relation || name);
}

// Applies room.ai_chat_filter (set by "Hey AI, ..." in chat -- see
// parse_ai_chat_intent() in ai_coordinator.py) to what's about to render.
//
// Exclusion (color) genuinely removes matching items from the shelf -- safe
// to do outright because it only ever affects the ~20 items with a
// confidently-known color (see add_color_tags.py); it can never empty the
// whole shelf. Everything else (include colors/tags/categories, rating,
// price direction) is applied as a SCORE BOOST rather than a hard filter, so
// asking for "more festive" surfaces festive items first without hiding
// everything else -- the squad can still see and vote on the rest.
//
// The boost is folded directly into state.feedScores for the duration of
// this one render() call, then restored. That's deliberate: every other
// function that orders the shelf (byFeedScore, topPickId, the itinerary
// section split) already reads from state.feedScores, so boosting it here
// means the AI's request flows through all of that existing machinery for
// free, instead of needing every sort site updated to know about a second,
// separate scoring system.
function applyAiChatFilter(items, filter){
  if(!filter) return { items, scoreOverrides: null };

  const excluded = new Set(filter.exclude_colors || []);
  const keep = excluded.size ? items.filter(i => !excluded.has(i.color)) : items;

  const includeColors = new Set(filter.include_colors || []);
  const includeTags = new Set(filter.include_tags || []);
  const includeCats = new Set(filter.include_categories || []);
  const minRating = filter.min_rating || null;
  const priceDir = filter.price_direction || null;

  const hasBoostSignal = includeColors.size || includeTags.size || includeCats.size || minRating || priceDir;
  if(!hasBoostSignal) return { items: keep, scoreOverrides: null };

  const overrides = {};
  keep.forEach(item => {
    let boost = 0;
    if(includeColors.has(item.color)) boost += 5;
    if(includeTags.has(item.tag)) boost += 5;
    if(includeCats.has(item.category)) boost += 5;
    if(minRating && item.rating >= minRating) boost += 3;
    // Small enough to only break ties within a group that's already
    // matched above -- a price ask alone still gently reorders everything,
    // it just never lets a cheap item leapfrog a genuinely better-matched
    // expensive one.
    if(priceDir === 'cheaper') boost += (5000 - item.price) / 2000;
    if(priceDir === 'pricier') boost += item.price / 2000;
    if(boost > 0) overrides[item.id] = (state.feedScores[item.id] ?? 0) + boost;
  });
  return { items: keep, scoreOverrides: overrides };
}

function renderAiFilterChip(room){
  const chip = $('#ai-filter-chip');
  if(!chip) return;
  const filter = room.ai_chat_filter;
  if(!filter){
    chip.classList.remove('show');
    return;
  }
  chip.innerHTML = `<span>✦ AI filter: ${escapeHtml(filter.summary)}</span><button type="button" id="ai-filter-clear" aria-label="Clear">✕</button>`;
  chip.classList.add('show');
}

$('#ai-filter-chip')?.addEventListener('click', (e) => {
  if(e.target.closest('#ai-filter-clear')) send('clear_ai_filter');
});

// Whether this specific item is what the active AI filter asked for --
// used to badge it explicitly on the card. Requires EVERY dimension the
// person actually specified to match, not just one: "white top" asks for
// white AND a top, so badging every Shirt regardless of color (or every
// white item regardless of category) looked unfocused -- half the shelf
// lighting up doesn't read as a real recommendation, it reads as the AI
// not really understanding the request. The ranking boost in
// applyAiChatFilter() stays additive/generous (a partial match still climbs
// the shelf a bit); only this explicit on-card claim needs to be strict.
function matchesAiFilter(item, filter){
  if(!filter) return false;
  const checks = [];
  if((filter.include_colors || []).length) checks.push((filter.include_colors || []).includes(item.color));
  if((filter.include_tags || []).length) checks.push((filter.include_tags || []).includes(item.tag));
  if((filter.include_categories || []).length) checks.push((filter.include_categories || []).includes(item.category));
  if(filter.min_rating) checks.push(item.rating >= filter.min_rating);
  if(!checks.length) return false;
  return checks.every(Boolean);
}

function render(){
  if(!state.room || !state.catalog.length) return;
  const room = state.room;

  $('#room-code-chip').textContent = state.roomId;
  $('#room-occasion').textContent = room.occasion;
  $('#room-when').textContent = room.when ? ('📅 ' + formatWhen(room.when)) : '';
  const giftNote = $('#room-gift-note');
  if(isGiftRoom(room)){
    giftNote.textContent = `🎁 Surprise for ${giftRecipientDisplay(room)} -- keep this one on the down-low`;
    giftNote.style.display = 'block';
  } else {
    giftNote.style.display = 'none';
  }

  const participants = room.participants || room.members;
  $('#member-avatars').innerHTML = Object.entries(participants).map(([cid, n]) =>
    avatarHtml(cid, n)
  ).join('');
  const totalCount = Object.keys(participants).length;
  // Deliberately NOT "4/6 in squad" -- a bare fraction reads like a target to
  // fill and puts a limit in your face for no reason. Plain count, and the cap
  // only ever mentioned as remaining room (or once it's actually reached,
  // which is the one moment it genuinely matters).
  const spotsLeft = MAX_SQUAD_SIZE - totalCount;
  const countLabel = totalCount === 1 ? '1 in squad' : `${totalCount} in squad`;
  $('#member-count').textContent = spotsLeft > 0
    ? `${countLabel} · room for ${spotsLeft} more`
    : `${countLabel} · squad's full`;

  // Shown only when there's something actionable to say. An always-present
  // bar restating the occasion (already in the header above it) trained
  // people to ignore it, which meant the notes that DO matter -- a split
  // vote, a budget overrun -- got ignored too.
  const aiBar = $('#ai-bar');
  const note = state.aiNote || '';
  $('#ai-note').textContent = note;
  if(aiBar) aiBar.style.display = note ? 'flex' : 'none';

  const filtered = state.catalog.filter(item => matchesSearch(item, state.searchTerm));
  const { items: aiFiltered, scoreOverrides } = applyAiChatFilter(filtered, room.ai_chat_filter);
  renderAiFilterChip(room);

  // Swap in boosted scores only for this synchronous render pass -- render()
  // never awaits anything mid-function, so there's no risk of another caller
  // seeing the temporarily-overridden scores. Restored immediately after,
  // so the NEXT state broadcast (which recomputes real feedScores from
  // scratch server-side) is never fighting a stale local override.
  const realFeedScores = state.feedScores;
  if(scoreOverrides) state.feedScores = { ...realFeedScores, ...scoreOverrides };
  renderGrid(aiFiltered, room);
  state.feedScores = realFeedScores;

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
  refreshTieModal();
}

function getTiedIds(room){
  const participantCount = participantCountOf(room);
  return state.catalog
    .filter(item => {
      if(room.cart.includes(item.id)) return false;
      const votes = room.reactions[item.id] || {};
      // Real deadlock only -- see computeVoteStatus()'s comment above for
      // why "any 2 conflicting votes" stopped being a correct definition
      // once a squad can be 3-5 people, not just 2.
      return computeVoteStatus(votes, participantCount) === 'deadlocked';
    })
    .map(item => item.id);
}

function needsMyAttention(item, room){
  if(room.cart.includes(item.id)) return false;
  const votes = room.reactions[item.id] || {};
  if(!Object.keys(votes).length) return false;
  const participantCount = participantCountOf(room);
  const isTied = computeVoteStatus(votes, participantCount) === 'deadlocked';
  if(isTied) return true;
  return !(state.clientId in votes);
}

// Takes you straight to a card, reliably. Two things used to make this fail
// silently: an active search filter meaning the card simply wasn't in the DOM,
// and scrolling before the freshly-switched screen had laid out. Both are
// handled here, so "tap to view" always actually lands you on the item.
function jumpToItemCard(itemId, opts = {}){
  if(!itemId) return;

  // A search filter can hide the very card we're jumping to. Clear it and
  // re-render first, or the querySelector below finds nothing and the tap
  // appears to do nothing at all.
  const stillFiltered = !document.querySelector(`[data-card="${itemId}"]`);
  if(stillFiltered && state.searchTerm){
    state.searchTerm = '';
    const searchInput = $('#product-search');
    if(searchInput) searchInput.value = '';
    if(state.room && state.catalog.length) render();
  }

  if(opts.fromCheckout){
    state.returnToCheckoutAfterJump = true;
  }
  showScreen('screen-room');
  syncReturnToCheckoutBtn();

  // Two frames: one for the screen swap to apply, one for layout to settle,
  // so scrollIntoView measures against the real position rather than a
  // display:none-to-flex transition mid-flight.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const card = document.querySelector(`[data-card="${itemId}"]`);
    if(!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('just-highlighted');
    requestAnimationFrame(() => card.classList.add('just-highlighted'));
    setTimeout(() => card.classList.remove('just-highlighted'), 1600);
  }));
}

// A one-tap way back to checkout for anyone who jumped out of it to look at a
// recommendation -- particularly someone mid-payment, who shouldn't have to
// navigate back through the landing screen. Nothing is lost either way:
// payment state lives on the server, not in this screen.
function syncReturnToCheckoutBtn(){
  const btn = $('#return-to-checkout');
  if(!btn) return;
  const roomActive = $('#screen-room').classList.contains('active');
  btn.classList.toggle('show', !!state.returnToCheckoutAfterJump && roomActive);
}

$('#return-to-checkout').addEventListener('click', () => {
  state.returnToCheckoutAfterJump = false;
  // Leaving the item behind means you're no longer looking at it, so stop
  // telling the squad that you are.
  updateConsideringSignal(null);
  showScreen('screen-checkout');
  syncReturnToCheckoutBtn();
});

// A tie used to force the chat drawer open (and a modal on top of it, the
// first time). Direct user feedback: that landed "like a slap in the face" --
// it hijacked the screen mid-swipe and made a disagreement feel like a
// reprimand. So nothing opens itself anymore. Instead an inline, dismissible
// banner appears at the top of the room, chat is offered as a clearly-labelled
// button (on the banner AND on the card itself), and the chat button gets its
// unread dot so it's visibly the place to go. The squad chooses to open it.
// Fires when a brand-new tie appears. Opens the popup, but only under
// conditions that keep it from becoming a nuisance in a 6-person squad --
// see the big comment on openTieModal() for the full reasoning.
function announceTie(itemId){
  state.pendingTieItemId = itemId;

  // Already popped for this item once -- don't nag again. The card's
  // Tie-break button is always there if they want it back.
  if(state.autoShownTieIds.has(itemId)) return;
  // Something else already has the screen. Auto-opening on top of a
  // conversation or a spin is exactly the hijacking this replaced.
  if(state.chatOpen) return;
  if($('#roulette-modal').classList.contains('show')) return;
  // A popup is already up for a different tie (very possible at 6 people --
  // two items can deadlock seconds apart). One at a time; the rest wait on
  // their cards.
  if(state.tieModalItemId) return;

  state.autoShownTieIds.add(itemId);
  openTieModal(itemId, { view: 'choose' });
}

// Opens chat WITH context about which item is being discussed -- always
// user-initiated (a tapped button), never automatic.
function openChatForItem(itemId){
  const item = state.catalog.find(i => i.id === itemId);
  const note = $('#chat-context-note');
  note.innerHTML = `Talking through "${escapeHtml(item ? item.name : 'an item')}" -- whatever you land on, change your votes on the card to make it stick. <button type="button" id="chat-jump-to-tie" class="chat-jump-btn">Jump to item</button>`;
  note.style.display = 'block';
  note.dataset.tieItem = itemId;
  openChatDrawer();
}

$('#chat-context-note').addEventListener('click', (e) => {
  if(!e.target.closest('#chat-jump-to-tie')) return;
  const itemId = $('#chat-context-note').dataset.tieItem;
  closeChatDrawer();
  if(itemId) jumpToItemCard(itemId);
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
// No longer performs surprise navigation on close. It used to auto-jump to
// the tied card (or reopen the roulette), which meant closing chat could
// teleport you somewhere you didn't ask to go -- part of the same "stop
// hijacking the screen" fix as announceTie() above. Jumping is now only ever
// an explicit tap on "Jump to item".
function closeChatDrawer(){
  state.chatOpen = false;
  $('#chat-drawer').classList.remove('open');
}
$('#chat-drawer').addEventListener('click', (e) => {
  if(e.target.id === 'chat-drawer') closeChatDrawer();
});

function renderChat(room) {
  const textMessages = (room.chat || []).map((m, i) => ({ ...m, kind: 'text', ts: m.ts ?? 0, order: i }));
  const voiceMessages = state.voiceMessages.map((m, i) => ({ ...m, kind: 'voice', ts: m.ts ?? 0, order: 1e9 + i }));
  // Merged and sorted by actual send time -- previously voice messages were
  // always appended after every text message regardless of when they were
  // actually sent, which is exactly what caused a reply to visually land
  // above the voice note it was replying to. `order` is just a stable
  // tiebreak for messages sent before this fix existed (no real timestamp
  // yet), so they don't get shuffled relative to each other.
  const merged = [...textMessages, ...voiceMessages].sort((a, b) => (a.ts - b.ts) || (a.order - b.order));

  const list = $('#chat-messages');
  list.innerHTML = '';

  merged.forEach(m => {
    const isMe = m.name === state.name;
    if(m.kind === 'text'){
      const div = document.createElement('div');
      // AI replies get their own look -- neither "me" nor "them", since it's
      // not another squad member. Centered so it visually breaks the left/
      // right conversation rhythm, the same way a system message would in
      // any chat app.
      div.className = m.is_ai ? 'chat-msg ai' : `chat-msg ${isMe ? 'me' : 'them'}`;
      div.innerHTML = m.is_ai
        ? `<div class="who">✦ AI Stylist</div><div>${escapeHtml(m.text)}</div>`
        : `<div class="who">${escapeHtml(m.name)}</div><div>${escapeHtml(m.text)}</div>`;
      list.appendChild(div);
    } else {
      const wrapper = document.createElement('div');
      wrapper.className = `chat-msg chat-audio-msg ${isMe ? 'me' : 'them'}`;
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = m.name;
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = m.audio;
      wrapper.appendChild(who);
      wrapper.appendChild(audio);
      list.appendChild(wrapper);
    }
  });

  if (!merged.length) {
    list.innerHTML = `
      <div class="empty-note" style="padding:20px 8px;">
        No messages yet -- say hi 👋
      </div>
    `;
  }

  if (state.chatOpen) {
    list.scrollTop = list.scrollHeight;
    state.lastChatCount = (room.chat || []).length;
  } else if ((room.chat || []).length > state.lastChatCount) {
    $all('.unread-dot').forEach(d => d.classList.add('show'));
  }
}

$('#chat-input').addEventListener('input', () => {
  if (!state.isCurrentlyTypingSignal) {
    state.isCurrentlyTypingSignal = true;
    send('typing_start');
  }
  clearTimeout(state.typingDebounceTimer);
  state.typingDebounceTimer = setTimeout(() => {
    state.isCurrentlyTypingSignal = false;
    send('typing_stop');
  }, 2500);
});

// Who else is actively LOOKING at the recommended add-on right now. Stored in
// state and rendered inside the recommendation card itself rather than as its
// own separate banner -- two stacked banners saying related things crowded the
// checkout screen, and the standalone one couldn't say WHICH item or offer to
// take you there.
function renderConsideringBanner(considering){
  state.consideringOthers = (considering || []).filter(c => c.name !== state.name);
  // Re-render just the reco card, not the whole screen: this arrives on a
  // typing-channel broadcast, which is high-frequency and must never trigger
  // a full render or a disk save.
  if(state.room && state.catalog.length){
    const cartItems = state.room.cart.map(id => state.catalog.find(c => c.id === id)).filter(Boolean);
    renderOutfitGapNudge(cartItems, state.room);
  }
}

function renderTypingIndicator(typers, recorders=[]) {
  const otherTypers = typers.filter(n => n !== state.name);
  const otherRecorders = recorders.filter(n => n !== state.name);
  const wrap = $('#typing-indicator');
  const textEl = $('#typing-indicator-text');

  // Recording takes priority when both are happening -- it's the rarer,
  // more notable signal, and in a small squad the two are unlikely to
  // overlap anyway (hard to record and type in the same input at once).
  if(otherRecorders.length){
    let text;
    if(otherRecorders.length === 1) text = `${otherRecorders[0]} is recording a voice message`;
    else if(otherRecorders.length === 2) text = `${otherRecorders[0]} and ${otherRecorders[1]} are recording voice messages`;
    else text = `${otherRecorders.length} people are recording voice messages`;
    textEl.textContent = text;
    wrap.style.display = 'flex';
    return;
  }

  if (!otherTypers.length) { wrap.style.display = 'none'; return; }
  let text;
  if (otherTypers.length === 1) text = `${otherTypers[0]} is typing`;
  else if (otherTypers.length === 2) text = `${otherTypers[0]} and ${otherTypers[1]} are typing`;
  else text = `${otherTypers.length} people are typing`;
  textEl.textContent = text;
  wrap.style.display = 'flex';
}

// Explicit claim/unclaim rather than "set the one buyer" -- multiple people
// can each independently claim their own unit of the same item now, so
// there's no single "the buyer" to toggle between anymore.
function assignItem(itemId, buyerId, claim) { send('assign', { item_id: itemId, buyer_id: buyerId, claim }); }
function tagOccasion(itemId, tag) { send('tag_occasion', { item_id: itemId, tag }); }
function removeItem(itemId) { send('remove_item', { item_id: itemId }); }
function payShare() { send('pay_share'); }
function setSplitMode(mode){ send('set_split_mode', {mode}); }
function setCustomAmount(amount){ send('set_custom_amount', {amount}); }
function resetCustomAmount(){ send('clear_custom_amount'); }

let reservationTickInterval = null;
function updateReservationBanner(room){
  const el = $('#checkout-reservation-banner');
  if(!el) return;

  const stillPending = room.checkout_expires_at && room.session_number == null;
  if(!stillPending){
    el.style.display = 'none';
    if(reservationTickInterval){ clearInterval(reservationTickInterval); reservationTickInterval = null; }
    return;
  }

  el.style.display = 'block';
  const tick = () => {
    const secsLeft = Math.max(0, Math.round(room.checkout_expires_at - (Date.now() / 1000)));
    const mm = Math.floor(secsLeft / 60), ss = secsLeft % 60;
    el.textContent = secsLeft > 0
      ? `⏳ ${mm}:${String(ss).padStart(2,'0')} left to finish paying -- after that, unpaid items release and any payments made so far refund automatically.`
      : `⏳ Wrapping up...`;
  };
  tick();
  if(!reservationTickInterval){
    reservationTickInterval = setInterval(tick, 1000);
  }
}

function renderCheckout(cartItems, room) {
  const itemsEl = $('#checkout-items');
  const peopleEl = $('#checkout-people');
  const statusEl = $('#checkout-status');
  if (!itemsEl) return;

  updateReservationBanner(room);

  $('#checkout-occasion').textContent = room.occasion;

  if (!cartItems.length) {
    itemsEl.innerHTML = `<div class="empty-note">No items in the squad cart yet -- go back and swipe a few into consensus first.</div>`;
    peopleEl.innerHTML = '';
    statusEl.innerHTML = '';
    const oldNote = document.getElementById('gift-split-note');
    if (oldNote) oldNote.remove();
    const oldControls = document.getElementById('gift-split-controls');
    if (oldControls) oldControls.remove();
    return;
  }

  const members = room.participants || room.members;
  const assignments = room.assignments || {};
  const payments = room.payments || {};
  const occasionTags = room.occasion_tags || {};
  const itinerary = room.itinerary || [];
  $('#checkout-tag-hint').style.display = itinerary.length ? 'block' : 'none';

  const memberIds = Object.keys(members);
  const total = cartItems.reduce((s, i) => s + i.price, 0);

  const isGiftSplit = isGiftRoom(room) && memberIds.length > 1;
  const splitMode = room.gift_split_mode || 'even';
  const manualSplit = room.gift_split_manual || {};
  const resolvedSplit = room.gift_split_resolved || {};
  const equalShare = isGiftSplit ? Math.round(total / memberIds.length) : 0;

  const personAmount = (cid) => isGiftSplit
    ? (splitMode === 'custom' ? (resolvedSplit[cid] ?? 0) : equalShare)
    : 0;
  const isManualAmount = (cid) => Object.prototype.hasOwnProperty.call(manualSplit, cid);
  const allocatedTotal = isGiftSplit ? memberIds.reduce((s, cid) => s + personAmount(cid), 0) : 0;
  const splitIsBalanced = splitMode === 'even' || !!room.gift_split_balanced;

  // assignments[item.id] is now a LIST of buyers per item -- each person who
  // claimed a unit, not one single assignee. This is the actual fix for
  // "everyone logged on to buy the same shirt for friendship day and
  // couldn't add it again in a different size": each of them can now claim
  // their own separate unit of the same catalog item.
  const buyerIds = isGiftSplit ? memberIds : [...new Set(Object.values(assignments).flat())];
  const allPaid = buyerIds.length > 0 && buyerIds.every(id => payments[id]);

  itemsEl.innerHTML = cartItems.map(item => {
    const claimedBy = assignments[item.id] || [];
    const chips = Object.entries(members).map(([cid, n]) => {
      const isClaimed = claimedBy.includes(cid);
      return `
      <button class="assign-chip ${isClaimed ? 'active' : ''}" data-assign-item="${item.id}" data-assign-buyer="${cid}" style="${isClaimed ? `background:${colorForClientId(cid)};border-color:${colorForClientId(cid)};` : ''}" title="${escapeHtml(n)}">
        ${escapeHtml(avatarLabel(n))}
      </button>`;
    }).join('');

    const tagRow = itinerary.length ? `
      <div class="tag-chip-row">
        ${itinerary.map(fn => `
          <button class="tag-chip ${occasionTags[item.id] === fn ? 'active' : ''}" data-tag-item="${item.id}" data-tag-fn="${escapeHtml(fn)}">
            ${escapeHtml(fn)}
          </button>`).join('')}
      </div>` : '';

    // Size lived here previously, next to each buyer's name -- removed. We
    // capture no real stock-per-size data (see catalog.json), so a size
    // label here implied a check that never actually happened. Better to
    // show nothing than to look like something was verified that wasn't.
    // In production, size would live where Myntra already puts it: on the
    // product card itself, checked against live inventory before the item
    // is added to cart at all -- not bolted onto checkout after the fact.
    const claimLine = claimedBy.length
      ? `<div class="checkout-claim-line">${claimedBy.map(cid => escapeHtml(members[cid] || 'Someone')).join(' · ')}</div>`
      : `<div class="checkout-claim-hint">Tap an avatar to claim your own unit</div>`;

    return `
      <div class="checkout-item">
        <div class="checkout-item-media">${mediaHtml(item)}</div>
        <div class="checkout-item-info">
          <div class="checkout-item-name">${escapeHtml(item.brand)} -- ${escapeHtml(item.name)}</div>
          <div class="checkout-item-price">₹${item.price}</div>
          ${claimLine}
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
      const boughtCount = itemsForFn.filter(i => (assignments[i.id] || []).some(b => payments[b])).length;
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

  const unassignedCount = cartItems.filter(i => !(assignments[i.id] || []).length).length;

  const oldGiftNote = document.getElementById('gift-split-note');
  if (oldGiftNote) oldGiftNote.remove();
  let controlsEl = document.getElementById('gift-split-controls');
  if(isGiftSplit){
    if(!controlsEl){
      peopleEl.insertAdjacentHTML('beforebegin', `<div id="gift-split-controls"></div>`);
      controlsEl = document.getElementById('gift-split-controls');
    }

    const focusedInput = document.activeElement && document.activeElement.matches('[data-custom-amount-input]')
      ? document.activeElement : null;

    if(!focusedInput){
      const toggleHtml = `
        <div class="split-mode-toggle">
          <button type="button" class="split-mode-btn ${splitMode === 'even' ? 'active' : ''}" data-split-mode="even">Split evenly</button>
          <button type="button" class="split-mode-btn ${splitMode === 'custom' ? 'active' : ''}" data-split-mode="custom">Custom split</button>
        </div>`;

      let bodyHtml;
      if(splitMode === 'custom'){
        const rows = Object.entries(members).map(([cid, n]) => {
          const isMe = cid === state.clientId;
          const amount = personAmount(cid);
          const isManual = isManualAmount(cid);
          let amountHtml;
          if(isMe){
            amountHtml = `
              <div class="custom-split-amount-cell">
                <input type="number" min="0" step="1" class="custom-split-amount-input" data-custom-amount-input value="${amount}" />
                ${isManual ? `<span class="custom-split-reset-link" data-reset-custom-amount>auto</span>` : ''}
              </div>`;
          } else {
            amountHtml = `<span class="custom-split-amount-readonly" data-readonly-amount-for="${cid}">₹${amount}${isManual ? '' : ' <span class="custom-split-auto-tag">(auto)</span>'}</span>`;
          }
          return `
            <div class="custom-split-row">
              <div class="custom-split-row-name">${avatarHtml(cid, n, 'inline-avatar')}${escapeHtml(n)}${isMe ? ' (you)' : ''}</div>
              ${amountHtml}
            </div>`;
        }).join('');
        bodyHtml = `
          <div class="custom-split-rows">${rows}</div>
          <div class="split-allocation-row ${splitIsBalanced ? 'balanced' : 'unbalanced'}">
            <span>${splitIsBalanced ? '✓ Allocated' : '⚠ Allocated'}</span>
            <span>₹${allocatedTotal} of ₹${total}</span>
          </div>`;
      } else {
        bodyHtml = `<div class="gift-split-note" id="gift-split-note">🎁 Splitting this gift ${memberIds.length} ways -- ₹${equalShare} each, no matter who's assigned what.</div>`;
      }
      controlsEl.innerHTML = toggleHtml + bodyHtml;
    } else {
      const allocRow = controlsEl.querySelector('.split-allocation-row');
      if(allocRow){
        allocRow.className = `split-allocation-row ${splitIsBalanced ? 'balanced' : 'unbalanced'}`;
        allocRow.innerHTML = `
          <span>${splitIsBalanced ? '✓ Allocated' : '⚠ Allocated'}</span>
          <span>₹${allocatedTotal} of ₹${total}</span>`;
      }
      controlsEl.querySelectorAll('[data-readonly-amount-for]').forEach(span => {
        const cid = span.dataset.readonlyAmountFor;
        const isManual = isManualAmount(cid);
        span.innerHTML = `₹${personAmount(cid)}${isManual ? '' : ' <span class="custom-split-auto-tag">(auto)</span>'}`;
      });
    }
  } else if(controlsEl){
    controlsEl.remove();
  }

  peopleEl.innerHTML = Object.entries(members).map(([cid, n]) => {
    const hasPaid = !!payments[cid];
    const isMe = cid === state.clientId;

    let myTotal, hasStake;
    if(isGiftSplit){
      myTotal = personAmount(cid);
      hasStake = true;
    } else {
      const myItems = cartItems.filter(i => (assignments[i.id] || []).includes(cid));
      myTotal = myItems.reduce((s,i) => s + i.price, 0);
      hasStake = myItems.length > 0;
    }

    let action;
    if(!hasStake){
      action = `<span class="pay-status muted">No items assigned</span>`;
    } else if(hasPaid){
      action = `<span class="pay-status paid">✓ Paid ₹${myTotal}</span>`;
    } else if(isGiftSplit && !splitIsBalanced){
      action = isMe
        ? `<span class="pay-status muted">Split doesn't add up yet</span>`
        : `<span class="pay-status muted">Waiting on the split</span>`;
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
  } else if(isGiftSplit && !splitIsBalanced){
    statusEl.className = 'checkout-status warn';
    statusEl.textContent = `The custom split needs to add up to ₹${total} before anyone can pay -- currently at ₹${allocatedTotal}.`;
  } else {
    statusEl.className = 'checkout-status';
    statusEl.textContent = isGiftSplit
      ? `Splitting this gift ${memberIds.length} ways -- once everyone's paid their share, the order's complete.`
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

// Picks the actual best-scoring candidate for a missing category, using the
// same live feedScores the shelf itself is ranked by -- so the number this
// card shows is never invented, it's whatever the recommender genuinely
// ranks highest right now.
function bestCandidateForCategory(category){
  const dismissed = new Set(state.room.dismissed_recommendations || []);
  let best = null, bestScore = -Infinity;
  for(const item of state.catalog){
    if(item.category !== category) continue;
    if(state.room.cart.includes(item.id)) continue;
    if(dismissed.has(item.id)) continue;
    const score = state.feedScores[item.id] ?? -Infinity;
    if(score > bestScore){ bestScore = score; best = item; }
  }
  return best;
}

// Tells the rest of the squad what you're currently looking at, same
// lifecycle as the typing/recording indicators -- so nobody pays mid-
// decision without knowing an add-on is actively being considered. Only
// sends start/stop on an actual change, not on every render.
function updateConsideringSignal(candidateId, itemName){
  if(candidateId === state.currentConsideringItemId) return;
  if(state.currentConsideringItemId) send('considering_item_stop');
  state.currentConsideringItemId = candidateId;
  if(candidateId) send('considering_item_start', { item_id: candidateId, item_name: itemName });
}

function renderOutfitGapNudge(cartItems, room){
  const el = $('#outfit-gap-nudge');
  if(!cartItems.length){ el.style.display = 'none'; return; }
  const FOOTWEAR = 'Footwear', ACCESSORY = 'Accessory';
  const hasGarment = cartItems.some(i => i.category !== FOOTWEAR && i.category !== ACCESSORY);
  const hasFootwear = cartItems.some(i => i.category === FOOTWEAR);
  const hasAccessory = cartItems.some(i => i.category === ACCESSORY);
  if(!hasGarment){ el.style.display = 'none'; return; }

  const missingCategory = !hasFootwear ? FOOTWEAR : (!hasAccessory ? ACCESSORY : null);
  if(!missingCategory){ el.style.display = 'none'; return; }

  const candidate = bestCandidateForCategory(missingCategory);
  if(!candidate){ el.style.display = 'none'; return; }

  const cartTotal = cartItems.reduce((s, i) => s + i.price, 0);
  const budget = room.budget || 0;
  const remainingAfter = budget - (cartTotal + candidate.price);
  const budgetLine = budget
    ? (remainingAfter >= 0
        ? `Adding this keeps the squad ₹${remainingAfter} under budget.`
        : `Adding this would put the squad ₹${Math.abs(remainingAfter)} over budget.`)
    : '';

  // The decision itself only ever happens once, on the real shelf card (via
  // "View item"), never duplicated here -- that duplication is what made
  // liking from this card feel like it did nothing.
  const myVote = (room.reactions[candidate.id] || {})[state.clientId];
  let statusHtml = '';
  if(myVote === 'like'){
    statusHtml = `<div class="reco-card-status">✓ You liked this -- waiting on the rest of the squad.</div>`;
  } else if(myVote === 'pass'){
    statusHtml = `<div class="reco-card-status">You passed on this.</div>`;
  }

  // Who else is looking at THIS item right now, folded into the same card
  // instead of a second banner. Only ever populated by someone actually
  // tapping "View item" (see updateConsideringSignal) -- it used to fire for
  // anyone merely sitting on the checkout screen, which is why three people
  // saw "3 members are considering add-ons" when nobody had tapped anything.
  const lookers = (state.consideringOthers || []).filter(c => c.item_id === candidate.id);
  let lookerHtml = '';
  if(lookers.length){
    const names = lookers.length === 1
      ? `${lookers[0].name}'s`
      : `${lookers.length} of the squad are`;
    lookerHtml = `
      <div class="reco-card-looker">
        <span>👀 ${escapeHtml(names)} looking at this${lookers.length === 1 ? '' : ''}</span>
        <button type="button" class="reco-looker-jump" data-view-reco="${candidate.id}">Jump there</button>
      </div>`;
  }

  el.style.display = 'block';
  el.innerHTML = `
    <div class="reco-card-header">👟 Your ${escapeHtml(room.occasion)} look is missing ${missingCategory.toLowerCase()}</div>
    <div class="reco-card-info">
      <div class="reco-card-name">${escapeHtml(candidate.brand)} -- ${escapeHtml(candidate.name)} · ₹${candidate.price}</div>
      ${budgetLine ? `<div class="reco-card-budget-line">${escapeHtml(budgetLine)}</div>` : ''}
      ${lookerHtml}
      <div class="reco-card-actions">
        <button type="button" class="reco-card-view-btn" data-view-reco="${candidate.id}">View item →</button>
        <button type="button" class="reco-card-dismiss-link" data-dismiss-reco="${candidate.id}">Not interested</button>
      </div>
      ${statusHtml}
    </div>`;
}

$('#outfit-gap-nudge').addEventListener('click', (e) => {
  const viewId = e.target.closest('[data-view-reco]')?.dataset.viewReco;
  if(viewId){
    // THIS is the only thing that tells the squad you're looking -- an
    // explicit tap, not the mere act of being on this screen.
    const item = state.catalog.find(i => i.id === viewId);
    updateConsideringSignal(viewId, item ? `${item.brand} ${item.name}` : 'an item');
    // Remember where they came from so they can get back to checkout in one
    // tap -- someone part-way through paying shouldn't have to hunt for it.
    jumpToItemCard(viewId, { fromCheckout: true });
    return;
  }
  const dismissId = e.target.closest('[data-dismiss-reco]')?.dataset.dismissReco;
  if(dismissId){
    // Shared, not local -- a dismissal has to be visible to the whole
    // squad, or the two of you end up looking at two different cards
    // without realizing it.
    send('dismiss_recommendation', { item_id: dismissId });
    updateConsideringSignal(null);
  }
});

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

// ---------- Voice chat ---------------------------------------------------

let mediaRecorder = null;
let audioChunks = [];
let audioMimeType = '';
let recordingTimer = null;
let recordingStartedAt = 0;

const chatAudioBtn = $('#chat-audio-btn');

chatAudioBtn.addEventListener('click', async () => {
  console.log('[voice] mic button clicked. current recorder state:', mediaRecorder ? mediaRecorder.state : 'no recorder yet');

  // Stop the current recording.
  if(mediaRecorder && mediaRecorder.state === 'recording'){
    console.log('[voice] calling mediaRecorder.stop()');
    mediaRecorder.stop();
    return;
  }

  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    console.error('[voice] navigator.mediaDevices.getUserMedia is unavailable in this browser/context');
    alert('Your browser does not support microphone recording.');
    return;
  }

  if(!window.MediaRecorder){
    console.error('[voice] window.MediaRecorder is unavailable in this browser');
    alert('Voice recording is not supported in this browser.');
    return;
  }

  try {
    console.log('[voice] requesting microphone access...');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio:true
    });
    console.log('[voice] microphone access granted, stream tracks:', stream.getTracks().length);

    const mimeCandidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4'
    ];

    audioMimeType = mimeCandidates.find(type =>
      MediaRecorder.isTypeSupported(type)
    ) || '';
    console.log('[voice] chosen mime type:', audioMimeType || '(none supported, using browser default)');

    mediaRecorder = audioMimeType
      ? new MediaRecorder(stream, { mimeType: audioMimeType })
      : new MediaRecorder(stream);

    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      console.log('[voice] ondataavailable fired, chunk size:', event.data ? event.data.size : 0);
      if(event.data && event.data.size > 0){
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstart = () => {
      console.log('[voice] recording started');
      chatAudioBtn.classList.add('recording');
      chatAudioBtn.textContent = '⏹️';
      send('voice_recording_start');

      recordingStartedAt = Date.now();

      recordingTimer = setInterval(() => {
        const seconds = Math.floor(
          (Date.now() - recordingStartedAt) / 1000
        );

        chatAudioBtn.title = `Recording ${seconds}s — click to stop`;

        // Maximum 30 seconds.
        if(seconds >= 30){
          console.log('[voice] hit 30s cap, auto-stopping');
          mediaRecorder.stop();
        }
      }, 500);
    };

    mediaRecorder.onstop = async () => {
      console.log('[voice] onstop fired. total chunks collected:', audioChunks.length);
      send('voice_recording_stop');

      clearInterval(recordingTimer);

      chatAudioBtn.classList.remove('recording');
      chatAudioBtn.textContent = '🎙️';
      chatAudioBtn.title = 'Record voice message';

      stream.getTracks().forEach(track => track.stop());

      const blob = new Blob(audioChunks, {
        type: audioMimeType || 'audio/webm'
      });
      console.log('[voice] blob created, size:', blob.size, 'bytes, type:', blob.type);

      if(blob.size === 0){
        console.error('[voice] blob is EMPTY -- no audio data was actually captured. This usually means the mic stream had no audio (muted input device, or permission granted but no real mic).');
        alert('No audio was captured -- check your microphone is actually working and not muted.');
        return;
      }

      // Keep voice messages reasonably small for the MVP.
      if(blob.size > 1500000){
        console.warn('[voice] blob too large:', blob.size);
        alert('Voice message is too large. Please keep it shorter.');
        return;
      }

      const reader = new FileReader();

      reader.onloadend = () => {
        console.log('[voice] FileReader done, data URL length:', reader.result ? reader.result.length : 0);
        console.log('[voice] websocket state before sending:', state.ws ? state.ws.readyState : 'no websocket at all', '(1 = OPEN, anything else means it will NOT send)');
        send('voice_chat', {
          audio: reader.result,
          mime: blob.type
        });
        console.log('[voice] send() called for voice_chat');
      };
      reader.onerror = (e) => {
        console.error('[voice] FileReader failed:', e);
      };

      reader.readAsDataURL(blob);
    };

    mediaRecorder.onerror = (e) => {
      console.error('[voice] mediaRecorder.onerror fired:', e);
      clearInterval(recordingTimer);
      send('voice_recording_stop');

      chatAudioBtn.classList.remove('recording');
      chatAudioBtn.textContent = '🎙️';

      stream.getTracks().forEach(track => track.stop());

      alert('Something went wrong while recording.');
    };

    mediaRecorder.start();

  } catch(error) {

    console.error('Microphone error:', error);

    alert(
      'Microphone access was denied. Please allow microphone access in your browser.'
    );
  }
});

$('#demo-tools-toggle').addEventListener('click', () => {
  const panel = $('#demo-tools-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
});

function triggerDemoTimeTravel(){
  fetch('/api/demo/time-travel', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ email: getStoredUserEmail() })
  })
    .then(r => r.json())
    .then(d => {
      if(d.error){
        // Floating toast, not an inline banner -- an inline message either
        // clashed with whatever background sat behind it, or (with no
        // background at all) looked like unstyled, broken text with no
        // visual weight of its own. The toast is the same floating-card
        // pattern used for every other transient message in the app
        // (votes, roulette, the home-screen nudges), so this reads as an
        // intentional response instead of a stray leftover element.
        showHomeNudge('⚠️ ' + (d.message || 'Nothing to time-travel yet.'), 4500);
        return;
      }
      checkReminders();
    });
}
$('#demo-time-travel-fab').addEventListener('click', () => {
  triggerDemoTimeTravel();
});
$('#demo-time-travel-fab-home').addEventListener('click', () => {
  triggerDemoTimeTravel();
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
  state.roulettePulsedCartIds = new Set();

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
  state.roulettePulsedCartIds = new Set();
}
$('#roulette-close-btn').addEventListener('click', closeRouletteModal);
$('#roulette-modal').addEventListener('click', (e) => {
  if(e.target.id === 'roulette-modal') closeRouletteModal();
});
$('#roulette-done-btn').addEventListener('click', closeRouletteModal);
$('#roulette-reel').addEventListener('click', (e) => {
  const reactBtn = e.target.closest('.roulette-slot-btn');
  if(reactBtn){ react(reactBtn.dataset.item, reactBtn.dataset.reaction); return; }
  const tieBtn = e.target.closest('[data-tie-open]');
  if(tieBtn){
    // Close the roulette first -- the tie popup on top of it would stack two
    // overlays. Reopening afterwards is deliberately NOT automatic; the
    // roulette button is right there if they want another spin.
    const itemId = tieBtn.dataset.tieOpen;
    closeRouletteModal();
    openTieModal(itemId);
    return;
  }
  const discussBtn = e.target.closest('[data-discuss-item]');
  if(discussBtn){
    closeRouletteModal();
    openChatForItem(discussBtn.dataset.discussItem);
    return;
  }
});

$('#checkout-items').addEventListener('click', (e) => {
  const chip = e.target.closest('.assign-chip');
  if(chip){
    const itemId = chip.dataset.assignItem;
    const buyerId = chip.dataset.assignBuyer;
    const alreadyClaimed = chip.classList.contains('active');
    assignItem(itemId, buyerId, !alreadyClaimed);
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

$('#screen-checkout').addEventListener('click', (e) => {
  const modeBtn = e.target.closest('[data-split-mode]');
  if(modeBtn){ setSplitMode(modeBtn.dataset.splitMode); return; }
  const resetBtn = e.target.closest('[data-reset-custom-amount]');
  if(resetBtn){ resetCustomAmount(); return; }
});

let customAmountDebounceTimer = null;
$('#screen-checkout').addEventListener('input', (e) => {
  const input = e.target.closest('[data-custom-amount-input]');
  if(!input) return;
  clearTimeout(customAmountDebounceTimer);
  customAmountDebounceTimer = setTimeout(() => setCustomAmount(input.value), 400);
});
$('#screen-checkout').addEventListener('change', (e) => {
  const input = e.target.closest('[data-custom-amount-input]');
  if(!input) return;
  clearTimeout(customAmountDebounceTimer);
  setCustomAmount(input.value);
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
  const email = getStoredUserEmail();
  if(!email) return;
  fetch('/api/reminders?email=' + encodeURIComponent(email))
    .then(r => r.json())
    .then(d => {
      const reminder = (d.reminders || [])[0];
      if(!reminder) return;
      activeReminder = reminder;

      const icon = OCCASION_EMOJI[reminder.occasion] || '🎁';
      $('#reminder-modal-sub').textContent = `It's around ${new Date().toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' })}`;
      // reminder.person is already the complete, correct label from the
      // backend (recipient name/relation, same for every viewer -- see
      // get_reminders() in main.py). This used to wrap it in ANOTHER
      // possessive here ("${reminder.person}'s"), which is exactly how
      // "Aishnaa's Parnika" became "Aishnaa's Parnika's Birthday" -- two
      // layers of possessive stacking on top of each other. Only the
      // genuinely different case (a gift for yourself) gets special
      // handling; everything else is used as-is.
      const isSelf = reminder.is_self_gift;
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

function openLandingForReminder(occasion, relation, recipientName){
  showScreen('screen-profile');
  showScreen('screen-landing');
  $('#create-occasion').value = occasion;
  $('#create-itinerary').value = '';
  $('#create-recipient-relation').value = relation || '';
  $('#create-recipient-name').value = recipientName || '';
  $all('.recipient-chip').forEach(c => c.classList.toggle('active', c.dataset.recipient === relation));
  if(relation) expandOptionalSection('recipient-section', 'toggle-recipient');
}

$('#reminder-shop-btn').addEventListener('click', () => {
  if(!activeReminder) return;
  $('#reminder-modal').classList.remove('show');
  openLandingForReminder(activeReminder.occasion, activeReminder.recipient_relation, activeReminder.recipient_name);
});

$('#reminder-recs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rec-item]');
  if(!btn || !activeReminder) return;
  $('#reminder-modal').classList.remove('show');
  state.preLikeItemId = btn.dataset.recItem;
  openLandingForReminder(activeReminder.occasion, activeReminder.recipient_relation, activeReminder.recipient_name);
});
$('#reminder-close-btn').addEventListener('click', () => {
  closeReminderAndCheckNext();
});
$('#reminder-archive-btn').addEventListener('click', () => {
  if(!activeReminder) return;
  fetch('/api/reminders/archive', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ room_code: activeReminder.room_code })
  }).catch(() => {});
  closeReminderAndCheckNext();
});

// Closes the modal, then checks whether ANOTHER reminder is waiting.
// checkReminders() previously only ever ran once, at page load -- so if two
// gift squads both became eligible (e.g. Parnika's and Palak's birthdays in
// the same window), dismissing the first one never surfaced the second.
// It would only ever appear on a full page reload, which looked exactly
// like it had silently vanished. A short delay lets the close animation
// finish before a new modal could appear, so it doesn't look like the same
// modal just snapped back open.
function closeReminderAndCheckNext(){
  $('#reminder-modal').classList.remove('show');
  activeReminder = null;
  setTimeout(checkReminders, 350);
}