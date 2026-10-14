# 📸 Whose Pic?

A party game like Photo Roulette, for up to **20 players**. Everyone picks a few photos from their phone, a photo pops up on everyone's phone, and you guess whose it is. The TV shows a live leaderboard.

- **TV / laptop:** open `/host`
- **Phones:** scan the QR code on the TV (or open the site and type the 4-letter code)

---

## Play on your own Wi-Fi (quick test)

1. Install [Node.js](https://nodejs.org) (LTS).
2. In this folder, run:
   ```bash
   npm install
   npm start
   ```
3. On the TV/laptop open **http://localhost:3000/host** and click **Host a game**.
4. Phones on the **same Wi-Fi** scan the QR code.
   - If phones can't connect, Windows Firewall is probably blocking Node. Allow "Node.js" on **Private networks** when Windows asks, or in *Windows Security → Firewall → Allow an app*.

### Test with fake players
With a room open, run this in a second terminal (replace `ABCD` with the room code, `12` = number of bots):
```bash
npm run bots -- ABCD 12
```

---

## Put it online for free (Render.com)

You only need to do this once. After that the game lives at a link like `https://whose-pic.onrender.com`.

1. **Put the code on GitHub**
   - Make a free account at [github.com](https://github.com) and create a new **empty** repository (e.g. `whose-pic`).
   - In this folder run (use your repo's URL):
     ```bash
     git init
     git add .
     git commit -m "Whose Pic?"
     git branch -M main
     git remote add origin https://github.com/YOUR-NAME/whose-pic.git
     git push -u origin main
     ```
2. **Deploy on Render**
   - Make a free account at [render.com](https://render.com) (sign in with GitHub).
   - Click **New → Blueprint**, choose your `whose-pic` repo, and click **Apply**. (`render.yaml` already has all the settings: free plan, `npm install`, `npm start`.)
   - Wait for "Live" (a couple of minutes). Your link is shown at the top.
3. **Play:** open `https://YOUR-APP.onrender.com/host` on the TV.

Whenever you push new code to GitHub, Render updates the game automatically.

### Good to know about the free plan
- After **15 minutes with nobody playing, it falls asleep.** The first visit wakes it up but takes **about 30–60 seconds**. Just open the TV page a minute before class.
- Everything (rooms, photos) is in memory, so if the server restarts, start a new room.
- Some **school Wi-Fi networks block** sites like `onrender.com`. Test it once at school before the big game. If it's blocked, phones can play on mobile data.

---

## How it plays

| | |
|---|---|
| Players | 3 – 20 |
| Photos per person | 1–5 (default 3, ≈ 12 min for 15 players) |
| Time to guess | 5 / 10 / 15 s (default 10) |
| Name buttons per photo | max 6 (the real owner + 5 random others) |
| Correct guess | 500 – 1000 pts (faster = more) |
| Streak bonus | +100 per correct in a row (max +300) |
| Photo owner | +50 for every person who guessed wrong |
| Last photo | ⭐ double points |

- The first person to join is the 👑 **party leader** and can change settings / start from their phone.
- The host can **skip** any photo or **remove** a player in the lobby (click their name).
- Photo owners see "🤫 It's YOUR pic!" and tap any name so nobody can tell.
- Phones can close/reload and they rejoin automatically with their score.
- **Privacy:** photos are shrunk on the phone, kept only in server memory, and deleted when the game ends.

## Files

```
server.js          game server (rooms, rounds, scoring)
public/host.*      TV screen (lobby, live leaderboard, podium)
public/index.html  phone controller (+ play.js / play.css)
public/sound.js    sound effects
scripts/bots.js    fake players for testing
```
