import json
import random
import string
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ai_coordinator import get_ai_suggestion, infer_function_for_item, reasoned_tie_break, pick_surprise_items

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
CATALOG = json.loads((BASE_DIR / "catalog.json").read_text(encoding="utf-8"))
CATALOG_BY_ID = {item["id"]: item for item in CATALOG}

app = FastAPI(title="Shop Together (Myntra Hackathon MVP)")

# ---- state persistence -------------------------------------------------
ROOMS_FILE = BASE_DIR / "rooms_state.json"


def load_rooms() -> Dict[str, dict]:
    if ROOMS_FILE.exists():
        try:
            return json.loads(ROOMS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_rooms():
    try:
        ROOMS_FILE.write_text(json.dumps(rooms), encoding="utf-8")
    except OSError:
        pass


rooms: Dict[str, dict] = load_rooms()
completed_sessions_count = 0

# In-memory only, deliberately never written to rooms_state.json -- "who's
# currently typing" is inherently transient and would be stale the instant
# it's read back after any restart. Structure: {room_id: {client_id: last_ts}}
typing_status: Dict[str, Dict[str, float]] = {}
TYPING_TIMEOUT_SECONDS = 4  # server-side safety net if a "stop" signal is ever missed (tab killed mid-keystroke, etc.)

FINISHED_SQUADS_FILE = BASE_DIR / "finished_squads.json"


def load_finished_squads() -> list:
    if FINISHED_SQUADS_FILE.exists():
        try:
            return json.loads(FINISHED_SQUADS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []
    return []


def save_finished_squads():
    try:
        FINISHED_SQUADS_FILE.write_text(json.dumps(finished_squads), encoding="utf-8")
    except OSError:
        pass


finished_squads: list = load_finished_squads()


class CreateRoomRequest(BaseModel):
    occasion: str = "Just browsing"
    budget: int = 5000
    when: str = ""
    itinerary: list[str] = []
    gift_recipient: str = ""


def make_room_code() -> str:
    safe_chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choices(safe_chars, k=5))


def new_room_state(occasion: str, budget: int, when: str = "", itinerary: list | None = None, gift_recipient: str = "") -> dict:
    return {
        "occasion": occasion,
        "budget": budget,
        "when": when,
        "itinerary": itinerary or [],
        "gift_recipient": gift_recipient,
        "members": {},
        "participants": {},
        "reactions": {},
        "cart": [],
        "tie_breaks": {},
        "tie_break_reasons": {},
        "assignments": {},
        "occasion_tags": {},
        "payments": {},
        "chat": [],
        "finalized": False,
        "session_number": None,
        "activity_log": [],
        "member_last_seen": {},
    }


def compute_catchup(room: dict, client_id: str) -> dict | None:
    since_ts = room.get("member_last_seen", {}).get(client_id)
    if since_ts is None:
        if client_id not in room.get("participants", {}):
            return None
        since_ts = 0

    new_votes = [
        e for e in room.get("activity_log", [])
        if e["ts"] > since_ts and e["type"] == "react" and e["client_id"] != client_id
    ]
    if not new_votes:
        return None

    voters = sorted(set(e["actor"] for e in new_votes))
    touched_items = set(e["item_id"] for e in new_votes)

    needs_call = 0
    tied_count = 0
    for item_id in touched_items:
        if item_id in room["cart"] or item_id in room["tie_breaks"]:
            continue
        votes = room["reactions"].get(item_id, {})
        if client_id not in votes:
            needs_call += 1
        if len(votes) >= 2 and len(set(votes.values())) > 1:
            tied_count += 1

    return {
        "voters": voters,
        "items_touched": len(touched_items),
        "needs_call": needs_call,
        "tied_count": tied_count,
    }


def is_gift_split_room(room: dict) -> bool:
    recipient = (room.get("gift_recipient") or "").strip()
    if not recipient or recipient.lower() == "myself":
        return False
    return len(room.get("participants", {})) > 1


@app.post("/api/rooms")
def create_room(req: CreateRoomRequest):
    code = make_room_code()
    rooms[code] = new_room_state(req.occasion, req.budget, req.when, req.itinerary, req.gift_recipient)
    save_rooms()
    return {"room_id": code}


@app.post("/api/demo")
def create_demo_room():
    code = make_room_code()
    room = new_room_state("Wedding / Festive Function", 8000, "2026-08-15", ["Mehendi", "Shaadi", "Reception"])
    room["participants"] = {"demo-yoshi": "Yoshi", "demo-aishnaa": "Aishnaa"}
    room["reactions"] = {
        "p3": {"demo-yoshi": "like", "demo-aishnaa": "like"},
        "p6": {"demo-yoshi": "like", "demo-aishnaa": "pass"},
        "p12": {"demo-yoshi": "like"},
    }
    room["cart"] = ["p3"]
    room["occasion_tags"] = {"p3": "Mehendi"}
    room["chat"] = [
        {"name": "Aishnaa", "text": "omg the block print saree though 😍"},
        {"name": "Yoshi", "text": "right?? but should we get footwear too"},
        {"name": "Aishnaa", "text": "yes -- let's not repeat the reception mistake lol"},
    ]
    rooms[code] = room
    save_rooms()
    return {"room_id": code}


@app.get("/api/rooms/{room_id}")
def get_room(room_id: str):
    room = rooms.get(room_id.upper())
    if not room:
        return {"error": "not_found"}
    return {"catalog": CATALOG, **room}


@app.get("/api/reminders")
def get_reminders():
    today = date.today()
    window_days = 5
    reminders = []

    for squad in finished_squads:
        if not squad.get("gift_recipient"):
            continue
        if squad.get("had_itinerary"):
            continue
        if squad.get("reminded"):
            continue

        try:
            occasion_date = datetime.fromisoformat(squad["when"]).date()
        except (ValueError, TypeError, KeyError):
            continue

        next_occurrence = occasion_date.replace(year=occasion_date.year + 1)
        if abs((next_occurrence - today).days) > window_days:
            continue

        bought = squad.get("bought_items") or []
        recipient = squad["gift_recipient"]

        bought_ids = {b["id"] for b in bought}
        bought_tags = {b["tag"] for b in bought}
        recs = [item for item in CATALOG if item["id"] not in bought_ids and item["tag"] in bought_tags][:3]

        bought_first = CATALOG_BY_ID.get(bought[0]["id"]) if bought else None

        squad["reminded"] = True
        reminders.append({
            "occasion": squad["occasion"],
            "person": recipient,
            "room_code": squad["room_code"],
            "bought_item_name": bought[0]["name"] if bought else None,
            "bought_item_emoji": bought_first["emoji"] if bought_first else None,
            "bought_item_image": bought_first.get("image", "") if bought_first else "",
            "recommendations": [
                {"id": r["id"], "name": r["name"], "emoji": r["emoji"], "price": r["price"], "image": r.get("image", "")}
                for r in recs
            ],
        })

    if reminders:
        save_finished_squads()
    return {"reminders": reminders}


@app.post("/api/demo/time-travel")
def demo_time_travel():
    gift_squads = [s for s in finished_squads if s.get("gift_recipient")]
    if not gift_squads:
        return {"error": "no_history", "message": "Finish a checkout with a gift recipient set first, then time-travel."}
    latest = gift_squads[-1]
    latest["when"] = (date.today() - timedelta(days=365)).isoformat()
    latest["reminded"] = False
    save_finished_squads()
    return {"ok": True}


class ConnectionManager:
    def __init__(self):
        self.active: Dict[str, Dict[str, WebSocket]] = {}

    async def connect(self, room_id: str, client_id: str, ws: WebSocket):
        await ws.accept()
        self.active.setdefault(room_id, {})[client_id] = ws

    def disconnect(self, room_id: str, client_id: str):
        self.active.get(room_id, {}).pop(client_id, None)

    async def broadcast(self, room_id: str, message: dict):
        for ws in list(self.active.get(room_id, {}).values()):
            try:
                await ws.send_json(message)
            except Exception:
                pass


manager = ConnectionManager()


async def broadcast_state(room_id: str, event: dict | None = None):
    room = rooms[room_id]
    ai_note = get_ai_suggestion(room, CATALOG)
    payload = {"type": "state", "room": room, "ai_note": ai_note}
    if event:
        payload["event"] = event
    await manager.broadcast(room_id, payload)
    save_rooms()


async def broadcast_typing(room_id: str):
    """Deliberately separate from broadcast_state -- this fires on every
    keystroke, so it must never trigger a full room save or re-run the AI
    suggestion logic. It only ever sends the current list of typer names."""
    room = rooms[room_id]
    now = time.time()
    active = {
        cid: ts for cid, ts in typing_status.get(room_id, {}).items()
        if now - ts < TYPING_TIMEOUT_SECONDS
    }
    typing_status[room_id] = active
    names = [room["participants"][cid] for cid in active if cid in room["participants"]]
    await manager.broadcast(room_id, {"type": "typing", "typers": names})


@app.websocket("/ws/{room_id}")
async def websocket_endpoint(ws: WebSocket, room_id: str):
    room_id = room_id.upper()
    if room_id not in rooms:
        await ws.close(code=4004)
        return

    name = ws.query_params.get("name", "Guest")
    client_id = ws.query_params.get("client_id") or name

    await manager.connect(room_id, client_id, ws)
    room = rooms[room_id]

    catchup = compute_catchup(room, client_id)
    if catchup:
        await ws.send_json({"type": "catchup", "catchup": catchup})

    room["members"][client_id] = name
    room.setdefault("participants", {})[client_id] = name
    await broadcast_state(room_id)

    try:
        while True:
            data = await ws.receive_json()
            action = data.get("action")
            room = rooms[room_id]

            event = None

            if action == "react":
                item_id = data["item_id"]
                reaction = data["reaction"]
                room["reactions"].setdefault(item_id, {})[client_id] = reaction
                room["activity_log"].append({
                    "type": "react", "actor": name, "client_id": client_id,
                    "item_id": item_id, "reaction": reaction, "ts": time.time(),
                })

                likes = sum(1 for r in room["reactions"][item_id].values() if r == "like")
                member_count = max(len(room["members"]), 1)
                majority = 1 if member_count == 1 else max(2, (member_count // 2) + 1)
                if item_id not in room["cart"] and likes >= majority:
                    room["cart"].append(item_id)
                    if room.get("itinerary") and item_id not in room["occasion_tags"]:
                        cart_item = CATALOG_BY_ID.get(item_id)
                        if cart_item:
                            inferred = infer_function_for_item(cart_item, room["itinerary"])
                            if inferred:
                                room["occasion_tags"][item_id] = inferred
                if item_id in room["cart"] and likes < majority:
                    room["cart"].remove(item_id)

                item = CATALOG_BY_ID.get(item_id)
                event = {
                    "name": name,
                    "verb": "liked" if reaction == "like" else "passed on",
                    "item": item["name"] if item else item_id,
                    "item_id": item_id,
                }

            elif action == "break_tie":
                item_id = data["item_id"]
                item = CATALOG_BY_ID.get(item_id)
                if item:
                    decision, verdict = reasoned_tie_break(item, room, CATALOG)
                else:
                    decision, verdict = random.random() < 0.5, "Coin flip -- item not found in catalog."
                room["tie_breaks"][item_id] = "added" if decision else "skipped"
                room.setdefault("tie_break_reasons", {})[item_id] = verdict
                if decision and item_id not in room["cart"]:
                    room["cart"].append(item_id)
                    if room.get("itinerary") and item_id not in room["occasion_tags"] and item:
                        inferred = infer_function_for_item(item, room["itinerary"])
                        if inferred:
                            room["occasion_tags"][item_id] = inferred
                elif not decision and item_id in room["cart"]:
                    room["cart"].remove(item_id)
                event = {
                    "name": name,
                    "verb": "broke the tie on",
                    "item": item["name"] if item else item_id,
                    "outcome": room["tie_breaks"][item_id],
                    "reason": verdict,
                }

            elif action == "assign":
                item_id = data["item_id"]
                buyer_id = data.get("buyer_id") or None
                if buyer_id and buyer_id not in room["participants"]:
                    buyer_id = None
                if buyer_id:
                    room["assignments"][item_id] = buyer_id
                else:
                    room["assignments"].pop(item_id, None)
                item = CATALOG_BY_ID.get(item_id)
                buyer_name = room["participants"].get(buyer_id) if buyer_id else None
                event = {
                    "name": name,
                    "verb": f"assigned to {buyer_name}" if buyer_name else "unassigned",
                    "item": item["name"] if item else item_id,
                }

            elif action == "tag_occasion":
                item_id = data["item_id"]
                tag = data.get("tag") or None
                if tag and tag not in room.get("itinerary", []):
                    tag = None
                if tag:
                    room["occasion_tags"][item_id] = tag
                else:
                    room["occasion_tags"].pop(item_id, None)
                item = CATALOG_BY_ID.get(item_id)
                event = {
                    "name": name,
                    "verb": f"tagged for {tag}" if tag else "untagged",
                    "item": item["name"] if item else item_id,
                }

            elif action == "remove_item":
                item_id = data["item_id"]
                item = CATALOG_BY_ID.get(item_id)
                if item_id in room["cart"]:
                    room["cart"].remove(item_id)
                room["assignments"].pop(item_id, None)
                room["occasion_tags"].pop(item_id, None)
                room["reactions"].pop(item_id, None)
                room["tie_breaks"].pop(item_id, None)
                room.get("tie_break_reasons", {}).pop(item_id, None)
                event = {
                    "name": name,
                    "verb": "removed",
                    "item": item["name"] if item else item_id,
                }

            elif action == "pay_share":
                room["payments"][client_id] = True

                if is_gift_split_room(room):
                    cart_total = sum(
                        CATALOG_BY_ID[i]["price"] for i in room.get("cart", []) if i in CATALOG_BY_ID
                    )
                    participant_count = max(len(room.get("participants", {})), 1)
                    my_total = round(cart_total / participant_count)
                    buyer_ids = set(room.get("participants", {}).keys())
                else:
                    my_total = sum(
                        CATALOG_BY_ID[i]["price"]
                        for i, buyer in room["assignments"].items()
                        if buyer == client_id and i in CATALOG_BY_ID
                    )
                    buyer_ids = set(room["assignments"].values())

                event = {"name": name, "verb": "paid their share", "item": f"₹{my_total}"}

                everyone_paid = buyer_ids and all(room["payments"].get(b) for b in buyer_ids)
                if everyone_paid and room.get("session_number") is None:
                    global completed_sessions_count
                    completed_sessions_count += 1
                    room["session_number"] = completed_sessions_count

                    bought_items = [
                        {"id": i, "name": CATALOG_BY_ID[i]["name"], "tag": CATALOG_BY_ID[i]["tag"]}
                        for i in room["cart"] if i in CATALOG_BY_ID
                    ]
                    finished_squads.append({
                        "occasion": room["occasion"],
                        "when": room["when"],
                        "members": list(room["participants"].values()),
                        "room_code": room_id,
                        "gift_recipient": room.get("gift_recipient", ""),
                        "bought_items": bought_items,
                        "had_itinerary": bool(room.get("itinerary")),
                    })
                    save_finished_squads()

            elif action == "chat":
                text = (data.get("text") or "").strip()
                if text:
                    room["chat"].append({"name": name, "text": text})
                # Sending a message implies the person's done typing -- clear
                # their typing flag and let the others know immediately rather
                # than waiting for the 4s server-side timeout to expire.
                if typing_status.get(room_id, {}).pop(client_id, None) is not None:
                    await broadcast_typing(room_id)

            elif action == "voice_chat":
                audio = data.get("audio") or ""
                mime = data.get("mime") or "audio/webm"
                # Basic validation.
                if (
                    isinstance(audio, str)
                    and audio.startswith("data:audio/")
                    and len(audio) <= 2_000_000
                ):
                    await manager.broadcast(
                        room_id,
                        {
                            "type": "voice_chat",
                            "message": {
                                "name": name,
                                "audio": audio,
                                "mime": mime,
                            },
                        },
                    )
                # Voice messages are intentionally transient.
                # Do not save them into rooms_state.json.
                continue

            elif action == "surprise_roulette":
                picks = pick_surprise_items(room, CATALOG)
                event = {
                    "name": name,
                    "verb": "spun the Surprise Us roulette" if picks else "spun the roulette -- nothing fit the remaining budget",
                    "roulette_item_ids": [p["id"] for p in picks],
                }

            elif action == "finalize":
                room["finalized"] = not room["finalized"]

            elif action == "typing_start":
                # Skips broadcast_state entirely (via continue below) -- a
                # full state rebroadcast + disk save on every keystroke would
                # be wasteful and would make typing feel laggy under load.
                typing_status.setdefault(room_id, {})[client_id] = time.time()
                await broadcast_typing(room_id)
                continue

            elif action == "typing_stop":
                typing_status.get(room_id, {}).pop(client_id, None)
                await broadcast_typing(room_id)
                continue

            await broadcast_state(room_id, event=event)

    except (WebSocketDisconnect, RuntimeError):
        manager.disconnect(room_id, client_id)
        rooms[room_id]["members"].pop(client_id, None)
        rooms[room_id]["member_last_seen"][client_id] = time.time()
        # A disconnecting client can't send "typing_stop" -- clear their flag
        # here too, or their "is typing" indicator would linger for everyone
        # else until the 4s timeout quietly expires it.
        if typing_status.get(room_id, {}).pop(client_id, None) is not None:
            await broadcast_typing(room_id)
        await broadcast_state(room_id)


app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(str(FRONTEND_DIR / "index.html"))