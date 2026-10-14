// Whose Pic? - game server
// Phones are controllers (they see the photo + name buttons), the TV shows the live leaderboard.
// Photos live in memory only and are wiped when the game ends or the room closes.

const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;

const MAX_PLAYERS = 20;
const MIN_PLAYERS = 3;
const MAX_CHOICES = 6;          // name buttons shown per photo
const MAX_PHOTOS = 5;           // most photos a player can be asked for
const REVEAL_MS = 6000;         // how long the answer + leaderboard shows between photos
const GRACE_MS = 400;           // network slack after the timer hits zero
const MAX_PHOTO_CHARS = 1_600_000;
const ROOM_IDLE_MS = 20 * 60 * 1000;
const TIMER_OPTIONS = [5, 10, 15];
const AVATARS = ['🦊', '🐸', '🐼', '🐯', '🦁', '🐵', '🐙', '🦄', '🐶', '🐱', '🐧', '🦖', '🐨', '🐷', '🐮', '🦉', '🐝', '🦋', '🐢', '🦈', '👽', '🤖', '👻', '🎃'];

const app = express();
app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/health', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10e6,   // photo uploads
  pingTimeout: 30000,
});

/** @type {Map<string, any>} */
const rooms = new Map();

// ---------- helpers ----------

const rid = (n = 8) => crypto.randomBytes(n).toString('hex');

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

// When the TV is opened on localhost, phones can't reach "localhost", so point the QR at the LAN IP instead.
function phoneJoinBase(origin) {
  try {
    const u = new URL(origin);
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
      const ip = lanAddress();
      if (ip) u.hostname = ip;
    }
    return u.origin;
  } catch {
    return origin;
  }
}

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
}

const playerList = (room) => room.order.map((id) => room.players.get(id)).filter(Boolean);
const isReady = (room, p) => p.photos.length >= room.settings.photosPerPlayer;
const readyCount = (room) => playerList(room).filter((p) => isReady(room, p)).length;
const canStart = (room) => room.phase === 'lobby' && room.players.size >= MIN_PLAYERS && readyCount(room) >= MIN_PLAYERS;

function estimate(room) {
  const rounds = readyCount(room) * room.settings.photosPerPlayer;
  return { rounds, seconds: rounds * (room.settings.timer + REVEAL_MS / 1000 + 0.5) };
}

// Standard competition ranking: equal scores share a rank.
function ranks(room) {
  const sorted = playerList(room).sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
  const map = new Map();
  sorted.forEach((p, i) => {
    const prev = sorted[i - 1];
    map.set(p.id, prev && prev.score === p.score ? map.get(prev.id) : i + 1);
  });
  return { sorted, map };
}

const brief = (p) => (p ? { id: p.id, name: p.name, avatar: p.avatar } : null);

// ---------- state snapshots ----------

function hostState(room) {
  const { sorted, map } = ranks(room);
  const r = room.round;
  const inRound = room.phase === 'question' || room.phase === 'reveal';
  const list = room.phase === 'lobby' ? playerList(room) : sorted;

  const state = {
    code: room.code,
    joinUrl: room.joinUrl,
    qr: room.qr,
    phase: room.phase,
    settings: room.settings,
    leaderId: room.leaderId,
    maxPlayers: MAX_PLAYERS,
    minPlayers: MIN_PLAYERS,
    canStart: canStart(room),
    readyCount: readyCount(room),
    estimate: estimate(room),
    players: list.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      connected: p.connected,
      ready: isReady(room, p),
      photoCount: p.photos.length,
      score: p.score,
      streak: p.streak,
      rank: map.get(p.id),
      answered: inRound && r ? r.answers.has(p.id) : false,
      result: room.phase === 'reveal' && r?.results ? r.results.perPlayer[p.id] || null : null,
    })),
    round: null,
    awards: room.phase === 'ended' ? room.awards : null,
  };

  if (inRound && r) {
    state.round = {
      id: r.id,
      no: room.roundIndex + 1,
      total: room.rounds.length,
      double: r.double,
      duration: r.duration,
      timeLeft: Math.max(0, r.startedAt + r.duration - Date.now()),
      answeredCount: r.answers.size,
      expected: playerList(room).filter((p) => p.connected).length,
      result: r.results ? {
        owner: brief(room.players.get(r.ownerId)),
        correctCount: r.results.correctCount,
        guessers: r.results.guessers,
        fooled: r.results.fooled,
        ownerGain: r.results.ownerGain,
        fastest: r.results.fastest,
      } : null,
    };
  }
  return state;
}

function playerState(room, p) {
  const { map } = ranks(room);
  const r = room.round;
  const state = {
    phase: room.phase,
    code: room.code,
    settings: room.settings,
    maxPhotos: MAX_PHOTOS,
    isLeader: room.leaderId === p.id,
    leaderName: room.players.get(room.leaderId)?.name || null,
    playerCount: room.players.size,
    readyCount: readyCount(room),
    minPlayers: MIN_PLAYERS,
    canStart: canStart(room),
    estimate: estimate(room),
    me: {
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      streak: p.streak,
      rank: map.get(p.id),
      photoCount: p.photos.length,
      ready: isReady(room, p),
    },
    round: null,
    end: null,
  };

  if ((room.phase === 'question' || room.phase === 'reveal') && r) {
    const mine = r.answers.get(p.id);
    state.round = {
      id: r.id,
      no: room.roundIndex + 1,
      total: room.rounds.length,
      double: r.double,
      duration: r.duration,
      timeLeft: Math.max(0, r.startedAt + r.duration - Date.now()),
      isOwner: r.ownerId === p.id,
      choices: (r.choices.get(p.id) || []).map((id) => brief(room.players.get(id))).filter(Boolean),
      myChoice: mine ? mine.choiceId : null,
      result: null,
    };
    if (room.phase === 'reveal' && r.results) {
      state.round.result = {
        owner: brief(room.players.get(r.ownerId)),
        ...(r.results.perPlayer[p.id] || { correct: false, gain: 0 }),
        fooled: r.results.fooled,
        ownerGain: r.results.ownerGain,
      };
    }
  }

  if (room.phase === 'ended') {
    state.end = {
      podium: ranks(room).sorted.slice(0, 3).map((x) => ({ ...brief(x), score: x.score })),
      awards: (room.awards || []).filter((a) => a.player.id === p.id),
    };
  }
  return state;
}

function sendHost(room) {
  if (room.hostSocketId) io.to(room.hostSocketId).emit('host:state', hostState(room));
}

function sendPlayer(room, p) {
  if (p.socketId && p.connected) io.to(p.socketId).emit('player:state', playerState(room, p));
}

function sendPhoto(room, p) {
  const r = room.round;
  if (r && p.socketId && p.connected) io.to(p.socketId).emit('round:photo', { roundId: r.id, data: r.photo });
}

function broadcast(room) {
  room.lastActive = Date.now();
  sendHost(room);
  for (const p of room.players.values()) sendPlayer(room, p);
}

// ---------- game flow ----------

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function resetScores(room) {
  for (const p of room.players.values()) {
    Object.assign(p, { score: 0, streak: 0, bestStreak: 0, correct: 0, fooled: 0, fastSum: 0, fastCount: 0 });
  }
}

function startGame(room) {
  const n = room.settings.photosPerPlayer;
  const owners = shuffle(playerList(room).filter((p) => isReady(room, p)));
  const picks = new Map(owners.map((p) => [p.id, shuffle(p.photos).slice(0, n)]));

  // Pass k plays everyone's k-th photo (in a fresh random order) so photos are spread out evenly,
  // and nobody gets two in a row across a pass boundary.
  const rounds = [];
  for (let k = 0; k < n; k++) {
    const pass = shuffle(owners);
    if (rounds.length && pass.length > 1 && pass[0].id === rounds[rounds.length - 1].ownerId) {
      [pass[0], pass[1]] = [pass[1], pass[0]];
    }
    for (const p of pass) rounds.push({ ownerId: p.id, photo: picks.get(p.id)[k] });
  }

  resetScores(room);
  room.rounds = rounds;
  room.roundIndex = -1;
  room.awards = null;
  nextRound(room);
}

function buildChoices(room, viewerId, ownerId) {
  const everyone = playerList(room).map((p) => p.id);
  if (viewerId === ownerId) {
    // The owner gets a believable-looking set of names to tap so nobody can tell it's theirs.
    return shuffle(everyone.filter((id) => id !== viewerId)).slice(0, MAX_CHOICES);
  }
  const decoys = shuffle(everyone.filter((id) => id !== viewerId && id !== ownerId)).slice(0, MAX_CHOICES - 1);
  return shuffle([ownerId, ...decoys]);
}

function nextRound(room) {
  clearTimer(room);
  room.roundIndex++;
  if (room.roundIndex >= room.rounds.length) return endGame(room);

  const { ownerId, photo } = room.rounds[room.roundIndex];
  const duration = room.settings.timer * 1000;
  room.round = {
    id: rid(4),
    ownerId,
    photo,
    startedAt: Date.now(),
    duration,
    double: room.rounds.length >= 3 && room.roundIndex === room.rounds.length - 1,
    answers: new Map(),
    choices: new Map(),
    results: null,
  };
  for (const p of room.players.values()) room.round.choices.set(p.id, buildChoices(room, p.id, ownerId));
  room.phase = 'question';
  room.timer = setTimeout(() => reveal(room), duration + GRACE_MS);

  for (const p of room.players.values()) sendPhoto(room, p);
  broadcast(room);
}

function everyoneAnswered(room) {
  const r = room.round;
  const active = playerList(room).filter((p) => p.connected);
  return active.length > 0 && active.every((p) => r.answers.has(p.id));
}

function reveal(room) {
  if (room.phase !== 'question') return;
  clearTimer(room);
  const r = room.round;
  const mult = r.double ? 2 : 1;
  const perPlayer = {};
  let correctCount = 0;
  let guessers = 0;
  let fooled = 0;
  let fastest = null;

  for (const p of room.players.values()) {
    if (p.id === r.ownerId) continue;
    guessers++;
    const a = r.answers.get(p.id);
    const elapsed = a ? Math.max(0, a.at - r.startedAt) : null;
    if (a && a.choiceId === r.ownerId) {
      const speed = Math.max(0, 1 - elapsed / r.duration);
      p.streak++;
      p.bestStreak = Math.max(p.bestStreak, p.streak);
      const base = Math.round(500 + 500 * speed);
      const streakBonus = Math.min(p.streak - 1, 3) * 100;
      const gain = (base + streakBonus) * mult;
      p.score += gain;
      p.correct++;
      p.fastSum += elapsed;
      p.fastCount++;
      correctCount++;
      if (!fastest || elapsed < fastest.ms) fastest = { ...brief(p), ms: elapsed };
      perPlayer[p.id] = { correct: true, gain, streak: p.streak, streakBonus: streakBonus * mult, answered: true };
    } else {
      p.streak = 0;
      if (a) fooled++;
      perPlayer[p.id] = { correct: false, gain: 0, streak: 0, answered: !!a, guess: a ? brief(room.players.get(a.choiceId)) : null };
    }
  }

  const owner = room.players.get(r.ownerId);
  const ownerGain = fooled * 50 * mult;
  if (owner) {
    owner.score += ownerGain;
    owner.fooled += fooled;
    perPlayer[owner.id] = { isOwner: true, gain: ownerGain, answered: true };
  }

  r.results = { perPlayer, correctCount, guessers, fooled, ownerGain, fastest };
  room.phase = 'reveal';
  room.timer = setTimeout(() => nextRound(room), REVEAL_MS);
  broadcast(room);
}

function endGame(room) {
  clearTimer(room);
  room.phase = 'ended';
  room.round = null;
  const players = playerList(room);
  const awards = [];
  const top = (fn, filter) => players.filter(filter).sort((a, b) => fn(b) - fn(a))[0];

  const detective = top((p) => p.correct, (p) => p.correct > 0);
  if (detective) awards.push({ emoji: '🕵️', title: 'Sharpest eye', detail: `${detective.correct} right`, player: brief(detective) });

  const ninja = top((p) => p.fooled, (p) => p.fooled > 0);
  if (ninja) awards.push({ emoji: '🥷', title: 'Hardest to read', detail: `fooled people ${ninja.fooled} times`, player: brief(ninja) });

  const quick = top((p) => -p.fastSum / p.fastCount, (p) => p.fastCount >= 2);
  if (quick) awards.push({ emoji: '⚡', title: 'Quickest draw', detail: `${(quick.fastSum / quick.fastCount / 1000).toFixed(1)}s average on right answers`, player: brief(quick) });

  const hot = top((p) => p.bestStreak, (p) => p.bestStreak >= 3);
  if (hot) awards.push({ emoji: '🔥', title: 'Longest streak', detail: `${hot.bestStreak} right in a row`, player: brief(hot) });

  room.awards = awards;
  // Privacy: photos are gone as soon as the game is over.
  for (const p of players) p.photos = [];
  room.rounds = [];
  broadcast(room);
}

function backToLobby(room) {
  clearTimer(room);
  room.phase = 'lobby';
  room.round = null;
  room.rounds = [];
  room.awards = null;
  resetScores(room);
  for (const p of room.players.values()) p.photos = [];
  broadcast(room);
}

function removePlayer(room, playerId) {
  const p = room.players.get(playerId);
  if (!p) return;
  room.players.delete(playerId);
  room.order = room.order.filter((id) => id !== playerId);
  if (room.leaderId === playerId) room.leaderId = room.order[0] || null;
  return p;
}

function closeRoom(room) {
  clearTimer(room);
  io.to(room.code).emit('room:closed');
  rooms.delete(room.code);
}

// ---------- sockets ----------

io.on('connection', (socket) => {
  let room = null;
  let player = null;
  let isHost = false;

  const fail = (ack, error) => typeof ack === 'function' && ack({ ok: false, error });
  const ok = (ack, data = {}) => typeof ack === 'function' && ack({ ok: true, ...data });
  const hostOrLeader = () => room && (isHost || (player && room.leaderId === player.id));

  // ----- TV / host -----

  socket.on('host:create', async ({ origin } = {}, ack) => {
    const code = makeCode();
    const joinUrl = `${phoneJoinBase(String(origin || ''))}/?code=${code}`;
    room = {
      code,
      hostToken: rid(16),
      hostSocketId: socket.id,
      players: new Map(),
      order: [],
      leaderId: null,
      settings: { photosPerPlayer: 3, timer: 10 },
      phase: 'lobby',
      rounds: [],
      roundIndex: -1,
      round: null,
      timer: null,
      awards: null,
      joinUrl,
      qr: await QRCode.toDataURL(joinUrl, { margin: 1, width: 480, color: { dark: '#1a0b3b', light: '#ffffff' } }),
      lastActive: Date.now(),
    };
    rooms.set(code, room);
    isHost = true;
    socket.join(code);
    ok(ack, { code, hostToken: room.hostToken });
    sendHost(room);
  });

  socket.on('host:resume', ({ code, hostToken } = {}, ack) => {
    const r = rooms.get(String(code || '').toUpperCase());
    if (!r || r.hostToken !== hostToken) return fail(ack, 'Room not found');
    room = r;
    isHost = true;
    room.hostSocketId = socket.id;
    socket.join(room.code);
    ok(ack, { code: room.code });
    sendHost(room);
  });

  socket.on('host:kick', ({ playerId } = {}) => {
    if (!isHost || !room || room.phase !== 'lobby') return;
    const p = removePlayer(room, playerId);
    if (p?.socketId) io.to(p.socketId).emit('player:kicked');
    broadcast(room);
  });

  socket.on('host:skip', () => {
    if (!isHost || !room) return;
    if (room.phase === 'question' || room.phase === 'reveal') nextRound(room);
  });

  socket.on('host:end', () => {
    if (!isHost || !room) return;
    if (room.phase === 'question' || room.phase === 'reveal') endGame(room);
  });

  socket.on('host:close', () => {
    if (isHost && room) closeRoom(room);
  });

  // ----- host or party leader -----

  socket.on('game:settings', (s = {}) => {
    if (!hostOrLeader() || room.phase !== 'lobby') return;
    const n = Number(s.photosPerPlayer);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_PHOTOS) room.settings.photosPerPlayer = n;
    const t = Number(s.timer);
    if (TIMER_OPTIONS.includes(t)) room.settings.timer = t;
    broadcast(room);
  });

  socket.on('game:start', (_d, ack) => {
    if (!hostOrLeader()) return fail(ack, 'Only the host can start');
    if (!canStart(room)) return fail(ack, `Need at least ${MIN_PLAYERS} players with photos`);
    startGame(room);
    ok(ack);
  });

  socket.on('game:again', () => {
    if (hostOrLeader() && room.phase === 'ended') backToLobby(room);
  });

  // ----- phones -----

  socket.on('player:join', ({ code, name, avatar } = {}, ack) => {
    const r = rooms.get(String(code || '').trim().toUpperCase());
    if (!r) return fail(ack, "Can't find that room. Check the code on the TV.");
    if (r.phase !== 'lobby') return fail(ack, 'That game already started. Catch the next one.');
    if (r.players.size >= MAX_PLAYERS) return fail(ack, `Room is full (${MAX_PLAYERS} players max)`);
    const nm = cleanName(name);
    if (!nm) return fail(ack, 'Type your name first');
    if (playerList(r).some((p) => p.name.toLowerCase() === nm.toLowerCase())) return fail(ack, 'Someone already has that name');

    room = r;
    player = {
      id: rid(6),
      token: rid(16),
      name: nm,
      avatar: AVATARS.includes(avatar) ? avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)],
      socketId: socket.id,
      connected: true,
      joinedAt: Date.now(),
      photos: [],
      lastReaction: 0,
    };
    resetScores({ players: new Map([[player.id, player]]) });
    room.players.set(player.id, player);
    room.order.push(player.id);
    if (!room.leaderId) room.leaderId = player.id;
    socket.join(room.code);
    ok(ack, { code: room.code, token: player.token });
    broadcast(room);
  });

  socket.on('player:resume', ({ code, token } = {}, ack) => {
    const r = rooms.get(String(code || '').toUpperCase());
    const p = r && playerList(r).find((x) => x.token === token);
    if (!p) return fail(ack, 'gone');
    room = r;
    player = p;
    p.socketId = socket.id;
    p.connected = true;
    socket.join(room.code);
    ok(ack, { code: room.code });
    if (room.phase === 'question' || room.phase === 'reveal') sendPhoto(room, p);
    broadcast(room);
  });

  socket.on('player:leave', () => {
    if (!room || !player) return;
    if (room.phase === 'lobby' || room.phase === 'ended') {
      removePlayer(room, player.id);
      broadcast(room);
    }
    player = null;
  });

  socket.on('player:photos', ({ photos } = {}, ack) => {
    if (!room || !player || !room.players.has(player.id)) return fail(ack, 'Not in a room');
    if (room.phase !== 'lobby') return fail(ack, 'Game already started');
    if (!Array.isArray(photos) || photos.length > MAX_PHOTOS) return fail(ack, 'Too many photos');
    for (const ph of photos) {
      if (typeof ph !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(ph) || ph.length > MAX_PHOTO_CHARS) {
        return fail(ack, 'One of the photos could not be used');
      }
    }
    player.photos = photos;
    ok(ack, { count: photos.length });
    broadcast(room);
  });

  socket.on('player:answer', ({ roundId, choiceId } = {}) => {
    if (!room || !player || room.phase !== 'question') return;
    const r = room.round;
    if (r.id !== roundId || r.answers.has(player.id)) return;
    if (!(r.choices.get(player.id) || []).includes(choiceId)) return;
    r.answers.set(player.id, { choiceId, at: Date.now() });
    if (everyoneAnswered(room)) {
      clearTimer(room);
      room.timer = setTimeout(() => reveal(room), 700);
    }
    broadcast(room);
  });

  socket.on('player:react', ({ emoji } = {}) => {
    if (!room || !player || !['😂', '😱', '🔥', '😍', '💀', '👏'].includes(emoji)) return;
    const now = Date.now();
    if (now - player.lastReaction < 600) return;
    player.lastReaction = now;
    if (room.hostSocketId) io.to(room.hostSocketId).emit('host:reaction', { emoji, avatar: player.avatar });
  });

  socket.on('disconnect', () => {
    if (!room) return;
    if (isHost && room.hostSocketId === socket.id) room.hostSocketId = null;
    if (player && player.socketId === socket.id) {
      player.connected = false;
      if (room.phase === 'question' && everyoneAnswered(room)) {
        clearTimer(room);
        room.timer = setTimeout(() => reveal(room), 700);
      }
      broadcast(room);
    }
  });
});

// Clean up rooms nobody is using anymore.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyoneHere = room.hostSocketId || playerList(room).some((p) => p.connected);
    if (!anyoneHere && now - room.lastActive > ROOM_IDLE_MS) closeRoom(room);
  }
}, 60 * 1000);

server.listen(PORT, () => {
  const ip = lanAddress();
  console.log(`Whose Pic? running on http://localhost:${PORT}`);
  if (ip) console.log(`Phones on the same Wi-Fi can join at http://${ip}:${PORT}`);
  console.log(`Open http://localhost:${PORT}/host on the TV/laptop to host a game.`);
});
