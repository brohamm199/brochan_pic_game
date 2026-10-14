// Fill a room with fake players for testing.
// Usage: npm run bots -- ABCD 12            (room code, number of bots)
//        npm run bots -- ABCD 12 http://localhost:3000
const { io } = require('socket.io-client');
const zlib = require('zlib');

const [code, countArg = '8', url = 'http://localhost:3000'] = process.argv.slice(2);
if (!code) {
  console.log('Usage: npm run bots -- <ROOM CODE> [count] [server url]');
  process.exit(1);
}

const NAMES = ['Ava', 'Ben', 'Chloe', 'Dev', 'Ella', 'Finn', 'Gia', 'Hugo', 'Isla', 'Jay', 'Kai', 'Luna', 'Max', 'Nia', 'Omar', 'Pia', 'Quinn', 'Rex', 'Sky', 'Theo'];
const AVATARS = ['🦊', '🐸', '🐼', '🐯', '🦁', '🐵', '🐙', '🦄', '🐶', '🐱', '🐧', '🦖', '🐨', '🐷', '🐮', '🦉', '🐝', '🦋', '🐢', '🦈'];
const REACTIONS = ['😂', '😱', '🔥', '😍', '💀', '👏'];

// Minimal PNG encoder so each bot gets its own colourful test "photo".
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function testPhoto(hue, variant) {
  const w = 320, h = 240;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      const stripe = Math.floor((x + y * variant) / 40) % 2;
      const t = (x / w + y / h) / 2;
      const [r, g, b] = hsl((hue + t * 60) % 360, 0.75, stripe ? 0.55 : 0.4);
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}
function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}

const count = Math.min(20, Number(countArg) || 8);
for (let b = 0; b < count; b++) {
  const socket = io(url, { transports: ['websocket'] });
  const name = `${NAMES[b % NAMES.length]}🤖`;
  let need = 0;
  let uploadedFor = 0;

  socket.on('connect', () => {
    socket.emit('player:join', { code, name, avatar: AVATARS[b % AVATARS.length] }, (res) => {
      if (!res.ok) console.log(`${name}: ${res.error}`);
      else console.log(`${name} joined`);
    });
  });

  socket.on('player:state', (s) => {
    if (s.phase === 'lobby' && s.settings.photosPerPlayer !== uploadedFor && !s.me.ready) {
      need = s.settings.photosPerPlayer;
      uploadedFor = need;
      const photos = Array.from({ length: need }, (_, i) => testPhoto((b * 47) % 360, i + 1));
      setTimeout(() => socket.emit('player:photos', { photos }), 500 + Math.random() * 3000);
    }
    if (s.phase === 'lobby' && s.me.photoCount === 0) uploadedFor = 0;
    if (s.phase === 'question' && s.round && !s.round.myChoice && !socket._answering) {
      socket._answering = s.round.id;
      const pick = s.round.choices[Math.floor(Math.random() * s.round.choices.length)];
      setTimeout(() => {
        socket.emit('player:answer', { roundId: s.round.id, choiceId: pick.id });
        socket._answering = null;
      }, 800 + Math.random() * s.settings.timer * 900);
    }
    if (s.phase === 'reveal' && Math.random() < 0.25) {
      setTimeout(() => socket.emit('player:react', { emoji: REACTIONS[Math.floor(Math.random() * REACTIONS.length)] }), Math.random() * 2500);
    }
  });

  socket.on('player:kicked', () => { console.log(`${name} was kicked`); socket.close(); });
  socket.on('room:closed', () => socket.close());
}
