# Squad Shopping — Myntra HackerRamp

Real-time group decision-making for shopping together, plus a memory layer
that remembers what you bought someone last year.

## What it does

**Squad Shopping** — start a live session, share a 5-letter code, and swipe
through a shared shelf with friends. Items land in a shared cart the moment
the squad hits consensus, with:
- Reasoned tie-breaking when the squad splits on an item (not a coin flip —
  it explains its call using season fit, rating, discount, and budget)
- Occasion- and itinerary-aware recommendations (e.g. a multi-day wedding
  trip gets separate "Mehendi / Shaadi / Reception" sections)
- A "Surprise Us" roulette that surfaces fresh picks weighted toward the
  squad's occasion and remaining budget
- Live chat with a real typing indicator
- Checkout with per-item assignment, individual payment, and automatic
  even-split billing when the squad is buying a gift for someone outside
  the room
- Consensus celebrations (confetti + glow) when the squad agrees on something

**Gift Reminders** — if a session was shopping for someone else, the app
resurfaces a reminder around the one-year mark with fresh recommendations
based on what was actually bought last time.

## Tech stack
- **Backend:** FastAPI + native WebSockets, state persisted to local JSON
  (no database needed for the MVP)
- **AI coordinator:** rule-based (`backend/ai_coordinator.py`) — reads live
  reactions, budget, occasion, and season to drive recommendations and
  tie-breaking, with no external API key required. Deliberate choice for
  demo reliability; written so a real LLM call can drop in for v2.
- **Frontend:** vanilla HTML/CSS/JS, no build step, styled as a phone-frame
  mockup in Myntra's own colour language (`#FF3F6C` pink accent, dark ink
  text, card-based grid) so it reads as a feature of the app.
- **Product photos:** royalty-free stock images (Pexels), not real Myntra
  catalog photography — see Honest Scope below.

## Run it locally
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```
Then open **http://127.0.0.1:8000** in a browser.

**Fastest way to see it working:** open `http://127.0.0.1:8000/?demo=1` —
this drops you straight into a pre-populated squad (two members, a mid-session
vote, a ready-to-break tie, and existing chat) with no setup needed.

## Demoing "multiple people"

Two browser windows on one laptop is a completely normal way to demo
real-time multiplayer:
1. Open the app in two windows side by side.
2. Window 1: **Start a squad** → get a 5-letter code.
3. Window 2: **Join with code**, using a different name.
4. Vote in either window — the other updates instantly over the WebSocket.

For a second physical device on the same WiFi instead:
```bash
uvicorn main:app --host 0.0.0.0 --reload
```
then open `http://<your-laptop-IP>:8000` on the other device.

## Honest scope
- The "AI coordinator" is rule-based, not a live LLM call — a deliberate
  choice so the demo never depends on an external API being up.
- Payments are simulated (a boolean toggle), not a real payment gateway.
- Product photos are stock images, standing in for real catalog photography.
- Squad Score / session numbering is scoped to this running instance, not
  persisted analytics.

## Natural next steps
- Swap the rule-based coordinator for a real LLM call on the same room-state shape
- Persist rooms in Redis/SQLite instead of local JSON
- Real catalog integration instead of the curated 40-item set
- Real payment gateway integration

## Demo video
[link once uploaded]