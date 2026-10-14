// Phone controller: join -> pick photos -> guess whose pic -> results.
const socket = io();
const $ = (id) => document.getElementById(id);
const tilt = (seed, range = 4) => {
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 1000) / 1000 * 2 - 1) * range;
};
// Phones only allow vibration after the person has tapped the page.
const buzz = (pattern) => {
  if (navigator.vibrate && navigator.userActivation?.hasBeenActive !== false) navigator.vibrate(pattern);
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const AVATARS = ['🦊', '🐸', '🐼', '🐯', '🦁', '🐵', '🐙', '🦄', '🐶', '🐱', '🐧', '🦖', '🐨', '🐷', '🐮', '🦉', '🐝', '🦋', '🐢', '🦈', '👽', '🤖', '👻', '🎃'];
const REACTIONS = ['😂', '😱', '🔥', '😍', '💀', '👏'];
const MAX_SIDE = 1280;
const JPEG_QUALITY = 0.72;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let saved = store.get('wp-player'); // { code, token }
let state = null;
let viewKey = '';
let avatar = store.get('wp-avatar') || AVATARS[Math.floor(Math.random() * AVATARS.length)];
const photo = { roundId: null, data: null };
const picks = { list: [], sent: false, busy: false }; // photos chosen on this phone
let endsAt = 0;

// ---------- join ----------

function show(id) {
  for (const s of ['join', 'lobby', 'round', 'ended', 'notice']) $(s).classList.toggle('hidden', s !== id);
}

function setupJoin() {
  const params = new URLSearchParams(location.search);
  $('codeInput').value = (params.get('code') || '').toUpperCase().slice(0, 4);
  $('nameInput').value = store.get('wp-name') || '';
  $('avatarGrid').innerHTML = AVATARS.map((a) => `<button type="button" class="${a === avatar ? 'on' : ''}">${a}</button>`).join('');
  $('avatarGrid').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      avatar = b.textContent;
      $('avatarGrid').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
  $('codeInput').oninput = () => { $('codeInput').value = $('codeInput').value.toUpperCase().replace(/[^A-Z]/g, ''); };
}

$('joinForm').onsubmit = (e) => {
  e.preventDefault();
  const code = $('codeInput').value.trim().toUpperCase();
  const name = $('nameInput').value.trim();
  if (code.length !== 4) return ($('joinError').textContent = 'The code is 4 letters. Check the TV.');
  if (!name) return ($('joinError').textContent = 'Add your name so people can guess you.');
  $('joinBtn').disabled = true;
  $('joinError').textContent = '';
  socket.emit('player:join', { code, name, avatar }, (res) => {
    $('joinBtn').disabled = false;
    if (!res?.ok) return ($('joinError').textContent = res?.error || 'Could not join');
    saved = { code: res.code, token: res.token };
    store.set('wp-player', saved);
    store.set('wp-name', name);
    store.set('wp-avatar', avatar);
    history.replaceState(null, '', '/');
  });
};

function goToJoin(message, detail = '') {
  saved = null;
  state = null;
  viewKey = '';
  store.del('wp-player');
  picks.list = [];
  picks.sent = false;
  if (message) {
    $('noticeText').textContent = message;
    $('noticeSub').textContent = detail;
    show('notice');
  } else {
    show('join');
  }
}
$('noticeBtn').onclick = () => { show('join'); };

// ---------- connection ----------

socket.on('connect', () => {
  $('offline').classList.add('hidden');
  if (!saved) return;
  socket.emit('player:resume', saved, (res) => {
    if (!res?.ok) goToJoin();
  });
});
socket.on('disconnect', () => { if (saved) $('offline').classList.remove('hidden'); });

socket.on('player:state', (s) => {
  state = s;
  render();
});

socket.on('round:photo', ({ roundId, data }) => {
  photo.roundId = roundId;
  photo.data = data;
  if (state?.round?.id === roundId) setPhoto();
});

socket.on('player:kicked', () => goToJoin("You're out.", 'The host removed you from this game.'));
socket.on('room:closed', () => goToJoin('Room closed.', 'The host shut this game down.'));

$('leaveBtn').onclick = () => {
  if (!confirm('Leave this game?')) return;
  socket.emit('player:leave');
  goToJoin();
};

// ---------- render ----------

function render() {
  if (!state) return;
  const r = state.round;
  let key;
  if (state.phase === 'lobby') key = 'lobby';
  else if (state.phase === 'question') key = `q:${r.id}:${r.myChoice ? 1 : 0}`;
  else if (state.phase === 'reveal') key = `r:${r.id}`;
  else key = 'ended';

  const changed = key !== viewKey;
  viewKey = key;

  if (state.phase === 'lobby') { show('lobby'); renderLobby(); }
  else if (state.phase === 'question') { show('round'); if (changed) renderQuestion(); }
  else if (state.phase === 'reveal') { show('round'); if (changed) renderReveal(); }
  else { show('ended'); renderEnded(changed); }
}

// ----- lobby / photo picking -----

function renderLobby() {
  const { me, settings } = state;
  const need = settings.photosPerPlayer;

  // Server cleared our photos (new game after "play again")
  if (me.photoCount === 0 && picks.sent) { picks.list = []; picks.sent = false; }

  $('meAvatar').textContent = me.avatar;
  $('meName').textContent = me.name;
  $('meRoom').textContent = state.code;

  const locked = me.ready && (picks.sent || picks.list.length === 0);
  const thumbs = $('thumbs');
  const actions = $('pickActions');

  if (locked) {
    $('pickStep').textContent = 'Your photos';
    $('pickTitle').textContent = "You're in the pile";
    $('pickSub').textContent = picks.list.length
      ? 'Keep a straight face when these come up.'
      : `Your ${me.photoCount} photos are in.`;
    thumbs.innerHTML = picks.list.map((src, i) => `<div class="thumb locked" style="--tilt:${tilt(i + src.length).toFixed(1)}deg"><img src="${src}" alt=""></div>`).join('');
    actions.innerHTML = '<button id="changeBtn" class="btn ghost wide">Swap my photos</button>';
    $('changeBtn').onclick = () => {
      picks.sent = false;
      socket.emit('player:photos', { photos: [] });
      renderLobby();
    };
  } else {
    const have = picks.list.length;
    $('pickStep').textContent = `${Math.min(have, need)} of ${need} chosen`;
    $('pickTitle').textContent = `Pick ${need} photo${need > 1 ? 's' : ''}`;
    $('pickSub').textContent = have > need
      ? `That's ${have - need} too many. Take some out.`
      : 'From your camera roll. The weirder, the better. The others have to guess they came from you.';
    let html = picks.list.map((src, i) => `<div class="thumb" style="--tilt:${tilt(i + src.length).toFixed(1)}deg"><img src="${src}" alt=""><button class="x" data-i="${i}" aria-label="Remove photo">×</button></div>`).join('');
    for (let i = have; i < need; i++) html += '<button class="thumb empty" data-add="1">+ add</button>';
    thumbs.innerHTML = html;
    thumbs.querySelectorAll('.x').forEach((b) => {
      b.onclick = () => { picks.list.splice(Number(b.dataset.i), 1); renderLobby(); };
    });
    thumbs.querySelectorAll('[data-add]').forEach((b) => { b.onclick = openPicker; });

    if (picks.busy) {
      actions.innerHTML = '<button class="btn wide" disabled>Getting photos ready…</button>';
    } else if (have === need) {
      actions.innerHTML = '<button id="lockBtn" class="btn go wide">Put these in the pile</button>';
      $('lockBtn').onclick = sendPhotos;
    } else if (have < need) {
      actions.innerHTML = `<button id="chooseBtn" class="btn primary wide">Choose ${have ? 'more ' : ''}photos</button>`;
      $('chooseBtn').onclick = openPicker;
    } else {
      actions.innerHTML = '';
    }
  }

  // Leader controls
  $('leaderCard').classList.toggle('hidden', !state.isLeader);
  if (state.isLeader) {
    $('startBtn').disabled = !state.canStart;
    $('startBtn').onclick = () => socket.emit('game:start', null, (res) => { if (!res?.ok) toast(res?.error || 'Could not start'); });
    const mins = Math.max(1, Math.round(state.estimate.seconds / 60));
    $('startHint').textContent = state.canStart
      ? `${state.readyCount} of ${state.playerCount} ready · ${state.estimate.rounds} photos · about ${mins} min`
      : `Needs ${state.minPlayers} people with photos in · ${state.readyCount} so far`;
  }

  $('waitCard').innerHTML = state.isLeader
    ? ''
    : `<b>${state.readyCount} of ${state.playerCount}</b> have picked their photos.<br>${esc(state.leaderName || 'The host')} starts the game when everyone's in<span class="dots"></span>`;
}

function openPicker() {
  if (picks.busy) return;
  $('fileInput').value = '';
  $('fileInput').click();
}

$('fileInput').onchange = async () => {
  const files = Array.from($('fileInput').files || []);
  if (!files.length) return;
  const need = state.settings.photosPerPlayer;
  const room = Math.max(0, need - picks.list.length);
  const chosen = files.slice(0, room);
  if (files.length > room) toast(`Kept the first ${room}. You only need ${need}.`);
  picks.busy = true;
  picks.sent = false;
  renderLobby();
  let failed = 0;
  for (const f of chosen) {
    try { picks.list.push(await shrink(f)); } catch { failed++; }
  }
  picks.busy = false;
  if (failed) toast(`Couldn't open ${failed} of those. Try another.`);
  if (state?.phase === 'lobby') renderLobby();
};

// Resize + compress on the phone so uploads are quick even on mobile data.
async function shrink(file) {
  let src;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    src = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  const w = src.width || src.naturalWidth;
  const h = src.height || src.naturalHeight;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  if (src.close) src.close();
  if (src.src?.startsWith('blob:')) URL.revokeObjectURL(src.src);
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

function sendPhotos() {
  const btn = $('lockBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  socket.emit('player:photos', { photos: picks.list }, (res) => {
    if (!res?.ok) {
      toast(res?.error || "Didn't send. Try again.");
      renderLobby();
      return;
    }
    picks.sent = true;
    buzz(40);
    renderLobby();
  });
}

// ----- round -----

function setPhoto() {
  const img = $('photo');
  if (photo.roundId === state?.round?.id && photo.data) {
    if (img.getAttribute('src') !== photo.data) {
      img.src = photo.data;
      img.classList.remove('dev');
      void img.offsetWidth;
      img.classList.add('dev');
    }
    $('photoLoading').classList.add('hidden');
  } else {
    img.removeAttribute('src');
    $('photoLoading').classList.remove('hidden');
  }
}

function roundHeader(r) {
  $('roundNo').textContent = `Frame ${String(r.no).padStart(2, '0')} of ${String(r.total).padStart(2, '0')}`;
  $('doubleTag').classList.toggle('hidden', !r.double);
}

function renderQuestion() {
  const r = state.round;
  roundHeader(r);
  $('round').classList.remove('revealing');
  setPhoto();
  $('stampSlot').innerHTML = '';
  $('caption').className = 'caption faint';
  $('caption').textContent = 'whose?';
  $('ownerBanner').classList.toggle('hidden', !r.isOwner);
  $('result').classList.add('hidden');
  $('reactBar').classList.add('hidden');
  $('choices').classList.remove('hidden');
  $('choices').classList.toggle('locked', !!r.myChoice);
  $('choices').innerHTML = r.choices.map((c, i) => `
    <button class="choice ${r.myChoice === c.id ? 'picked' : ''}" data-id="${c.id}">
      <span class="av">${esc(c.avatar)}</span><span class="nm">${esc(c.name)}</span><span class="key">${'ABCDEF'[i]}</span>
    </button>`).join('');
  $('choices').querySelectorAll('.choice').forEach((b) => {
    b.onclick = () => {
      if (state.round.myChoice) return;
      state.round.myChoice = b.dataset.id;
      socket.emit('player:answer', { roundId: r.id, choiceId: b.dataset.id });
      buzz(30);
      viewKey = `q:${r.id}:1`;
      renderQuestion();
    };
  });
  if (!r.myChoice || !endsAt) endsAt = Date.now() + r.timeLeft;
}

function renderReveal() {
  const r = state.round;
  const x = r.result;
  roundHeader(r);
  setPhoto();
  endsAt = 0;
  $('round').classList.add('revealing');
  $('ownerBanner').classList.add('hidden');
  $('choices').classList.add('hidden');
  $('timebarFill').style.transform = 'scaleX(0)';

  const ownerName = esc(x.owner?.name);
  $('caption').className = 'caption written';
  $('caption').textContent = `${x.owner?.name || '?'}'s`;

  let stamp;
  const lines = [];
  if (x.isOwner) {
    stamp = '<span class="stamp own">Yours</span>';
    lines.push(x.fooled
      ? `You fooled <b>${x.fooled}</b> ${x.fooled === 1 ? 'person' : 'people'}${x.gain ? ` for <b>+${x.gain}</b>` : ''}.`
      : 'Nobody was fooled. Too obvious?');
  } else if (x.correct) {
    stamp = `<span class="stamp good">+${x.gain}</span>`;
    lines.push(`Right — it was <b>${ownerName}</b>.`);
    if (x.streak >= 2) lines.push(`That's <b>${x.streak}</b> in a row.`);
  } else if (x.answered) {
    stamp = '<span class="stamp bad">Nope</span>';
    lines.push(`You said <b>${esc(x.guess?.name)}</b>. It was <b>${ownerName}</b>.`);
  } else {
    stamp = '<span class="stamp bad">Too slow</span>';
    lines.push(`It was <b>${ownerName}</b>.`);
  }
  $('stampSlot').innerHTML = stamp;

  $('result').className = 'result';
  $('result').innerHTML = `${lines.map((l) => `<div class="line">${l}</div>`).join('')}
    <div class="standing"><span class="pos">No. ${state.me.rank}</span><span class="pts">${state.me.score.toLocaleString()} pts</span></div>`;
  buzz(x.correct ? [30, 40, 30] : x.isOwner ? 30 : 120);

  $('reactBar').classList.remove('hidden');
  $('reactBar').innerHTML = REACTIONS.map((e) => `<button aria-label="React ${e}">${e}</button>`).join('');
  $('reactBar').querySelectorAll('button').forEach((b) => {
    b.onclick = () => socket.emit('player:react', { emoji: b.textContent });
  });
}

// Time bar
(function tick() {
  if (state?.phase === 'question' && endsAt) {
    const left = Math.max(0, endsAt - Date.now());
    const frac = left / state.round.duration;
    $('timebarFill').style.transform = `scaleX(${frac})`;
    $('timebarFill').parentElement.classList.toggle('low', left < 3000);
  }
  requestAnimationFrame(tick);
})();

// ----- end -----

function renderEnded(changed) {
  if (changed) {
    picks.list = [];
    picks.sent = false;
    const { me, end } = state;
    $('finalPlace').innerHTML = `${me.rank}<small>${['th', 'st', 'nd', 'rd'][me.rank % 10 > 3 || [11, 12, 13].includes(me.rank % 100) ? 0 : me.rank % 10]}</small>`;
    $('finalScore').textContent = `${me.score.toLocaleString()} points`;
    $('myAwards').innerHTML = end.awards.map((a, i) => `
      <div class="my-award" style="animation-delay:${0.4 + i * 0.2}s">
        <div class="code-label">You won</div><div class="tt">${esc(a.title)}</div><div class="sub">${esc(a.detail)}</div>
      </div>`).join('');
  }
  $('againBtn').classList.toggle('hidden', !state.isLeader);
  $('againWait').classList.toggle('hidden', state.isLeader);
  $('againBtn').onclick = () => socket.emit('game:again');
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}

setupJoin();
if (!saved) show('join');
