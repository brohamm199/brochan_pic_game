// TV screen: lobby with QR code -> live leaderboard during the game -> podium.
const socket = io();
const $ = (id) => document.getElementById(id);
// Small, stable tilt per player so the prints look hand-placed, not gridded.
const tilt = (id, range = 5) => {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 1000) / 1000 * 2 - 1) * range;
};
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const REORDER_DELAY = 1500; // ms after the reveal before scores count up and rows slide

let state = null;
let session = null;
try { session = JSON.parse(sessionStorage.getItem('wp-host') || 'null'); } catch {}

let lobbySeen = new Set();
const rows = new Map(); // playerId -> { el, shown }
let endsAt = 0;
let lastTick = null;
let reorderTimer = null;
let lastAnswered = 0;

// ---------- connection ----------

socket.on('connect', () => {
  if (!session) return;
  socket.emit('host:resume', session, (res) => {
    if (!res?.ok) {
      session = null;
      sessionStorage.removeItem('wp-host');
      show('splash');
    }
  });
});

socket.on('host:state', (s) => {
  const prev = state;
  state = s;
  render(prev);
});

socket.on('host:reaction', ({ emoji, avatar }) => spawnReaction(emoji, avatar));

$('createBtn').onclick = () => {
  Sfx.unlock();
  $('createBtn').disabled = true;
  socket.emit('host:create', { origin: location.origin }, (res) => {
    $('createBtn').disabled = false;
    if (!res?.ok) return toast('Could not create a room. Try again.');
    session = { code: res.code, hostToken: res.hostToken };
    sessionStorage.setItem('wp-host', JSON.stringify(session));
  });
};

$('startBtn').onclick = () => {
  Sfx.unlock();
  socket.emit('game:start', null, (res) => { if (!res?.ok) toast(res?.error || 'Could not start'); });
};
$('skipBtn').onclick = () => { socket.emit('host:skip'); toast('Skipped'); };
$('endBtn').onclick = () => { if (confirm('End the game now and show the results?')) socket.emit('host:end'); };
$('againBtn').onclick = () => socket.emit('game:again');

$('muteBtn').textContent = Sfx.muted ? 'Sound off' : 'Sound on';
$('muteBtn').onclick = () => { $('muteBtn').textContent = Sfx.toggle() ? 'Sound off' : 'Sound on'; };
$('fsBtn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
};
document.addEventListener('click', () => Sfx.unlock(), { once: true });

// ---------- rendering ----------

function show(id) {
  for (const s of ['splash', 'lobby', 'game', 'ended']) $(s).classList.toggle('hidden', s !== id);
}

function render(prev) {
  if (state.phase === 'lobby') {
    show('lobby');
    renderLobby(prev);
  } else if (state.phase === 'question' || state.phase === 'reveal') {
    show('game');
    renderGame(prev);
  } else if (state.phase === 'ended') {
    show('ended');
    if (prev?.phase !== 'ended') renderEnded();
  }
}

// ----- lobby -----

function renderLobby(prev) {
  if (prev?.phase !== 'lobby') {
    lobbySeen = new Set();
    clearBoard();
  }
  if ($('qr').getAttribute('src') !== state.qr) $('qr').src = state.qr;
  $('joinHost').textContent = new URL(state.joinUrl).host;
  $('roomCode').textContent = state.code;

  const { photosPerPlayer, timer } = state.settings;
  $('setPhotos').innerHTML = [1, 2, 3, 4, 5]
    .map((n) => `<button data-n="${n}" class="${n === photosPerPlayer ? 'on' : ''}">${n}</button>`).join('');
  $('setPhotos').querySelectorAll('button').forEach((b) => {
    b.onclick = () => socket.emit('game:settings', { photosPerPlayer: Number(b.dataset.n) });
  });
  $('setTimer').innerHTML = [5, 10, 15]
    .map((t) => `<button data-t="${t}" class="${t === timer ? 'on' : ''}">${t}s</button>`).join('');
  $('setTimer').querySelectorAll('button').forEach((b) => {
    b.onclick = () => socket.emit('game:settings', { timer: Number(b.dataset.t) });
  });

  const { rounds, seconds } = state.estimate;
  $('estimate').innerHTML = rounds
    ? `<b>${rounds}</b> photos in the pile · about <b>${Math.max(1, Math.round(seconds / 60))} min</b>`
    : 'No photos in the pile yet';

  const n = state.players.length;
  const ready = state.readyCount;
  const min = state.minPlayers;
  $('startBtn').disabled = !state.canStart;
  let hint;
  if (n < min) hint = `Needs ${min - n} more ${min - n === 1 ? 'person' : 'people'} to play.`;
  else if (ready < min) hint = `${ready} of ${n} have picked their photos.`;
  else if (ready < n) hint = `${n - ready} still choosing. Start now and they'll only guess.`;
  else hint = 'Everyone has picked. Good to go.';
  $('startHint').textContent = hint;

  $('playerCount').textContent = `${pad(n)} / ${state.maxPlayers}`;
  $('lobbyEmpty').classList.toggle('hidden', n > 0);

  let someoneNew = false;
  $('lobbyPlayers').innerHTML = state.players.map((p, i) => {
    const isNew = !lobbySeen.has(p.id);
    if (isNew) { lobbySeen.add(p.id); someoneNew = true; }
    const status = p.ready ? 'photos in' : `${p.photoCount} of ${state.settings.photosPerPlayer} photos`;
    const lead = p.id === state.leaderId ? ' · leader' : '';
    return `<button class="print pcard ${isNew ? 'new' : ''} ${p.ready ? 'ready' : ''} ${p.connected ? '' : 'offline'}" style="--tilt:${tilt(p.id).toFixed(1)}deg" data-id="${p.id}" data-name="${esc(p.name)}">
      <span class="img"><span class="frame-no">${pad(i + 1)}A</span>${esc(p.avatar)}</span>
      <span class="cap">${esc(p.name)}</span>
      <span class="state">${status}${lead}</span>
    </button>`;
  }).join('');
  $('lobbyPlayers').querySelectorAll('.pcard').forEach((b) => {
    b.onclick = () => { if (confirm(`Remove ${b.dataset.name} from the game?`)) socket.emit('host:kick', { playerId: b.dataset.id }); };
  });
  if (someoneNew && prev) Sfx.join();
}

// ----- game / live leaderboard -----

function clearBoard() {
  clearTimeout(reorderTimer);
  reorderTimer = null;
  rows.clear();
  $('board').innerHTML = '';
}

function makeRow(p) {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = '<span class="rank"></span><span class="av"></span><span class="nm"></span><span class="streak"></span><span class="status"></span><span class="score">0</span>';
  const row = { el, shown: p.score };
  el.querySelector('.score').textContent = p.score.toLocaleString();
  rows.set(p.id, row);
  $('board').appendChild(el);
  return row;
}

function syncRows() {
  const ids = new Set(state.players.map((p) => p.id));
  for (const [id, row] of rows) {
    if (!ids.has(id)) { row.el.remove(); rows.delete(id); }
  }
  for (const p of state.players) {
    const row = rows.get(p.id) || makeRow(p);
    row.el.querySelector('.av').textContent = p.avatar;
    row.el.querySelector('.nm').textContent = p.name;
    row.el.classList.toggle('offline', !p.connected);
  }
  const board = $('board');
  const n = state.players.length;
  const twoCol = n > 10;
  board.classList.toggle('two-col', twoCol);
  board.style.gridTemplateRows = twoCol ? `repeat(${Math.ceil(n / 2)}, auto)` : '';
  fitRows();
}

// Rows grow to fill the TV (but never get silly-tall with only a few players).
function fitRows() {
  const board = $('board');
  const n = state?.players?.length || 0;
  if (!n || board.offsetParent === null) return;
  const perCol = n > 10 ? Math.ceil(n / 2) : n;
  const h = Math.max(40, Math.min(110, Math.floor(board.clientHeight / perCol)));
  board.style.setProperty('--row-h', `${h}px`);
}
window.addEventListener('resize', fitRows);

// Put rows in the server's (score) order, sliding each one from where it was.
function applyOrder({ animate }) {
  const first = new Map();
  if (animate) for (const [id, row] of rows) first.set(id, row.el.getBoundingClientRect());
  for (const p of state.players) {
    const row = rows.get(p.id);
    $('board').appendChild(row.el);
    row.el.querySelector('.rank').textContent = pad(p.rank);
    row.el.classList.remove('rank-1', 'rank-2', 'rank-3');
    if (p.score > 0 && p.rank <= 3) row.el.classList.add(`rank-${p.rank}`);
    row.el.querySelector('.streak').textContent = p.streak >= 2 ? `×${p.streak}` : '';
  }
  if (!animate) return;
  for (const [id, row] of rows) {
    const a = first.get(id);
    if (!a) continue;
    const b = row.el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (!dx && !dy) continue;
    row.el.style.transition = 'none';
    row.el.style.transform = `translate(${dx}px, ${dy}px)`;
    row.el.getBoundingClientRect();
    requestAnimationFrame(() => {
      row.el.style.transition = 'transform 0.9s cubic-bezier(.2,.85,.25,1)';
      row.el.style.transform = '';
    });
  }
}

function countUp(row, to) {
  const el = row.el.querySelector('.score');
  const from = row.shown;
  row.shown = to;
  if (from === to) { el.textContent = to.toLocaleString(); return; }
  const t0 = performance.now();
  const dur = 900;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(from + (to - from) * eased).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  row.el.classList.remove('bump');
  void row.el.offsetWidth;
  row.el.classList.add('bump');
}

function finishReveal() {
  clearTimeout(reorderTimer);
  reorderTimer = null;
  if (!state || state.phase === 'lobby' || state.phase === 'ended') return;
  for (const p of state.players) {
    const row = rows.get(p.id);
    if (row && row.shown !== p.score) countUp(row, p.score);
  }
  applyOrder({ animate: true });
  Sfx.whoosh();
}

function renderGame(prev) {
  const fresh = !prev || prev.phase === 'lobby' || prev.phase === 'ended';
  if (fresh) {
    clearBoard();
    Sfx.start();
  }
  syncRows();

  const r = state.round;
  $('roundLabel').innerHTML = `Frame <b>${pad(r.no)}</b> of ${pad(r.total)}${r.double ? '<span class="double">Last one · double points</span>' : ''}`;

  const newRound = fresh || prev.round?.id !== r.id;
  const enteringReveal = state.phase === 'reveal' && (newRound || prev.phase !== 'reveal');

  if (state.phase === 'question') {
    if (newRound) {
      // A skip during the reveal jumps straight here, so settle the board first.
      if (reorderTimer) finishReveal();
      else applyOrder({ animate: !fresh });
      for (const p of state.players) {
        const row = rows.get(p.id);
        if (row.shown !== p.score) countUp(row, p.score);
        row.el.classList.remove('is-owner');
      }
      endsAt = Date.now() + r.timeLeft;
      lastTick = null;
      lastAnswered = 0;
      $('timerWrap').classList.remove('gone');
      Sfx.newPhoto();
    }
    if (newRound || !$('lockedCount')) {
      $('banner').innerHTML = `
        <div>
          <div class="big-line">Whose pic<em>?</em></div>
          <div class="sub-line">It's on your phone<span class="sep">/</span><b id="lockedCount"></b> of <span id="expectedCount"></span> locked in</div>
        </div>`;
    }
    $('lockedCount').textContent = r.answeredCount;
    $('expectedCount').textContent = r.expected;
    if (r.answeredCount > lastAnswered && !newRound) Sfx.lock();
    lastAnswered = r.answeredCount;
    for (const p of state.players) {
      const st = rows.get(p.id).el.querySelector('.status');
      const want = p.answered ? 'locked' : 'waiting';
      if (st.dataset.s === want) continue;
      st.dataset.s = want;
      st.innerHTML = p.answered ? '<span class="locked">Locked</span>' : '<span class="waiting">· · ·</span>';
    }
  }

  if (enteringReveal) {
    endsAt = 0;
    $('timerWrap').classList.add('gone');
    const res = r.result;
    const owner = res.owner;
    const lines = [];
    lines.push(`<b>${res.correctCount}</b> of ${res.guessers} got it`);
    if (res.fooled) lines.push(`fooled <b>${res.fooled}</b>`);
    if (res.fastest) lines.push(`quickest: <b>${esc(res.fastest.name)}</b> ${(res.fastest.ms / 1000).toFixed(1)}s`);
    $('banner').innerHTML = `
      <div class="print reveal-print" style="--tilt:${tilt(r.id, 7).toFixed(1)}deg">
        <div class="img">${esc(owner?.avatar)}</div>
        <span class="cap">${esc(owner?.name)}'s</span>
      </div>
      <div>
        <div class="big-line">It was ${esc(owner?.name)}<em>.</em></div>
        <div class="sub-line">${lines.join('<span class="sep">/</span>')}</div>
      </div>`;

    if (newRound) applyOrder({ animate: false });
    for (const p of state.players) {
      const row = rows.get(p.id);
      const st = row.el.querySelector('.status');
      st.dataset.s = 'result';
      const x = p.result;
      row.el.classList.toggle('is-owner', !!x?.isOwner);
      if (!x) st.innerHTML = '';
      else if (x.isOwner) st.innerHTML = `<span class="own">Theirs${x.gain ? ' +' + x.gain : ''}</span>`;
      else if (x.correct) st.innerHTML = `<span class="gain">+${x.gain}</span>`;
      else st.innerHTML = x.answered ? '<span class="miss">Miss</span>' : '<span class="late">No answer</span>';
    }
    Sfx.reveal();
    clearTimeout(reorderTimer);
    reorderTimer = setTimeout(finishReveal, REORDER_DELAY);
  }
}

// Timer ring
const CIRC = 2 * Math.PI * 44;
setInterval(() => {
  if (!state || state.phase !== 'question' || !endsAt) return;
  const r = state.round;
  const left = Math.max(0, endsAt - Date.now());
  const secs = Math.ceil(left / 1000);
  $('timerNum').textContent = secs;
  $('timerArc').style.strokeDashoffset = String(CIRC * (1 - left / r.duration));
  $('timerWrap').classList.toggle('low', secs <= 3);
  if (secs <= 3 && secs > 0 && secs !== lastTick) {
    lastTick = secs;
    Sfx.tick(secs === 1);
  }
}, 100);
$('timerArc').style.strokeDasharray = String(CIRC);

// ----- end -----

function renderEnded() {
  clearBoard();
  const top = state.players.slice(0, 3);
  const slots = [top[1], top[0], top[2]];
  const cls = ['p2', 'p1', 'p3'];
  const place = ['2nd', '1st', '3rd'];
  $('podium').innerHTML = slots.map((p, i) => (p ? `
    <div class="place ${cls[i]}">
      <div class="print">
        <div class="img">${esc(p.avatar)}</div>
        <span class="cap">${esc(p.name)}</span>
        <span class="stamp">${place[i]}</span>
      </div>
      <div class="pts">${p.score.toLocaleString()} pts</div>
    </div>` : '')).join('');

  $('awards').innerHTML = (state.awards || []).map((a, i) => `
    <div class="award" style="animation-delay:${2.2 + i * 0.3}s">
      <div class="code-label">${esc(a.title)}</div>
      <div class="who">${esc(a.player.avatar)} ${esc(a.player.name)}</div>
      <div class="dt">${esc(a.detail)}</div>
    </div>`).join('');

  Sfx.fanfare();
  setTimeout(confetti, 1300);
}

function confetti() {
  const colors = ['#f1ebdf', '#ff3b2f', '#ffb100', '#dcd3c2'];
  const box = $('confetti');
  for (let i = 0; i < 110; i++) {
    const c = document.createElement('i');
    c.style.left = `${Math.random() * 100}vw`;
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = `${2.5 + Math.random() * 2.5}s`;
    c.style.animationDelay = `${Math.random() * 1.2}s`;
    c.style.transform = `rotate(${Math.random() * 360}deg)`;
    box.appendChild(c);
  }
  setTimeout(() => { box.innerHTML = ''; }, 7000);
}

// ----- reactions -----

function spawnReaction(emoji, avatar) {
  const box = $('reactions');
  if (box.childElementCount > 40) return;
  const el = document.createElement('div');
  el.className = 'reaction';
  el.innerHTML = `${esc(emoji)}<small>${esc(avatar)}</small>`;
  el.style.left = `${5 + Math.random() * 88}vw`;
  el.style.setProperty('--drift', `${(Math.random() - 0.5) * 160}px`);
  box.appendChild(el);
  setTimeout(() => el.remove(), 3300);
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2500);
}
