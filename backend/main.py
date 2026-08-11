import asyncio
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

from ai_coordinator import get_ai_suggestion, infer_function_for_item, reasoned_tie_break, pick_surprise_items, score_feed

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

# ---- persistent accounts (email -> {name, taste_profile}) --------------
# This is the one piece of state that survives a "Switch account" or a
# browser restart -- everything else in this app is scoped to a room or a
# tab. No passwords are stored here (or anywhere) -- see /api/login below
# for why that's a deliberate choice, not an oversight.
USERS_FILE = BASE_DIR / "users.json"


def load_users() -> Dict[str, dict]:
    if USERS_FILE.exists():
        try:
            return json.loads(USERS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_users():
    try:
        USERS_FILE.write_text(json.dumps(users), encoding="utf-8")
    except OSError:
        pass


users: Dict[str, dict] = load_users()


class LoginRequest(BaseModel):
    email: str


class SignupRequest(BaseModel):
    email: str
    name: str


@app.post("/api/login")
def login(req: LoginRequest):
    email = req.email.strip().lower()
    record = users.get(email)
    if not record:
        return {"known": False}
    return {"known": True, "name": record.get("name", "")}


@app.post("/api/signup")
def signup(req: SignupRequest):
    email = req.email.strip().lower()
    name = req.name.strip()
    if not email or not name:
        return {"ok": False, "error": "missing_fields"}
    if email in users:
        # Someone else grabbed this email between the login check and now --
        # don't silently overwrite an existing account's name/history.
        return {"ok": False, "error": "already_exists"}
    users[email] = {"name": name, "taste_profile": {}}
    save_users()
    return {"ok": True}


class CreateRoomRequest(BaseModel):
    occasion: str = "Just browsing"
    budget: int = 5000
    when: str = ""
    itinerary: list[str] = []
    # Split into two fields on purpose -- "Friend" alone can't tell two
    # different friends' birthdays apart a year later, and the old single
    # field let picking a chip silently overwrite whatever name someone had
    # already typed. Relationship is the chip (Mom/Friend/Boss/etc, or
    # "Myself"); name is optional free text, never overwritten by a chip tap.
    gift_recipient_relation: str = ""
    gift_recipient_name: str = ""
    # Whoever's actually creating the room -- needed so a reminder later can
    # tell "your Mom" from "your squadmate's Mom." Without this, everyone who
    # was ever in a gift squad would see the exact same reminder labelled the
    # exact same way, even if the relationship was never theirs to begin with.
    creator_email: str = ""


def make_room_code() -> str:
    safe_chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choices(safe_chars, k=5))


def gift_recipient_display(relation: str, name: str) -> str:
    """The human-readable label used everywhere a recipient needs to show up
    -- the room's gift note, checkout's split note, reminder headlines. Name
    wins when given (it's more specific); relation alone is still a
    perfectly good fallback for a quick "just Mom" gift with no name typed."""
    name = (name or "").strip()
    relation = (relation or "").strip()
    if name:
        return name
    return relation


def new_room_state(
    occasion: str, budget: int, when: str = "", itinerary: list | None = None,
    gift_recipient_relation: str = "", gift_recipient_name: str = "", creator_email: str = "",
) -> dict:
    return {
        "occasion": occasion,
        "budget": budget,
        "when": when,
        "itinerary": itinerary or [],
        "gift_recipient_relation": gift_recipient_relation,
        "gift_recipient_name": gift_recipient_name,
        "gift_owner_email": creator_email.strip().lower(),
        "members": {},
        "participants": {},
        "participant_emails": {},
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
        # Reservation window -- mirrors a real checkout's temporary inventory
        # hold. Starts the moment anyone pays; if the whole order isn't paid
        # up before it expires, everything releases and any payments made so
        # far refund automatically. See RESERVATION_WINDOW_SECONDS below for
        # why it's short here specifically.
        "checkout_started_at": None,
        "checkout_expires_at": None,
        # Gift-split mode: "even" (default, existing behaviour) or "custom".
        # gift_split_manual holds ONLY the people who've actually typed a
        # number -- everyone else auto-splits whatever's left, evenly, via
        # resolve_gift_split() below. This is what makes custom split behave
        # like Splitwise instead of demanding everyone do arithmetic.
        "gift_split_mode": "even",
        "gift_split_manual": {},
    }


# How long a squad has to finish paying once the first person pays their
# share, before the reservation releases and refunds everyone. A real
# checkout hold is typically 15-30 minutes; this is deliberately much
# shorter so the release behaviour is actually demoable inside a pitch,
# not just claimed on a slide.
RESERVATION_WINDOW_SECONDS = 180


def even_split(total: int, ids: list) -> dict:
    """Splits `total` evenly across `ids`, correcting the last share so the
    sum is always exactly `total` even after rounding -- avoids the classic
    "everyone paid their share but the total's off by a rupee" bug."""
    n = len(ids)
    if n == 0:
        return {}
    shares, running = {}, 0
    for i, cid in enumerate(ids):
        if i == n - 1:
            shares[cid] = total - running
        else:
            amt = round(total / n)
            shares[cid] = amt
            running += amt
    return shares


def resolve_gift_split(total: int, participant_ids: list, manual: dict) -> tuple[dict, bool]:
    """The actual custom-split mechanic: anyone in `manual` pays exactly what
    they typed; everyone else splits whatever's left evenly among themselves,
    live, so typing one number redistributes the rest automatically instead
    of asking every person to do the math. If manual amounts alone already
    exceed the total, the remaining auto members get 0 rather than a negative
    share, and the resulting sum won't match `total` -- `balanced` catches
    that (and the ordinary case of manual-only entries not adding up) with
    one check rather than needing separate cases."""
    manual_ids = [pid for pid in participant_ids if pid in manual]
    manual_sum = sum(manual[pid] for pid in manual_ids)
    auto_ids = [pid for pid in participant_ids if pid not in manual]
    remaining = max(0, total - manual_sum)
    auto_shares = even_split(remaining, auto_ids) if auto_ids else {}
    resolved = {pid: (manual[pid] if pid in manual else auto_shares.get(pid, 0)) for pid in participant_ids}
    balanced = sum(resolved.values()) == total
    return resolved, balanced


def attach_gift_split_resolution(room: dict):
    """Computes the live custom-split numbers and writes them onto the room
    dict as gift_split_resolved / gift_split_balanced -- the frontend just
    displays these directly rather than re-deriving the same logic in JS,
    so the two can't drift out of sync with each other."""
    if is_gift_split_room(room) and room.get("gift_split_mode") == "custom":
        cart_total = sum(CATALOG_BY_ID[i]["price"] for i in room.get("cart", []) if i in CATALOG_BY_ID)
        participant_ids = list(room.get("participants", {}).keys())
        manual = room.get("gift_split_manual", {})
        resolved, balanced = resolve_gift_split(cart_total, participant_ids, manual)
        room["gift_split_resolved"] = resolved
        room["gift_split_balanced"] = balanced
    else:
        room["gift_split_resolved"] = {}
        room["gift_split_balanced"] = True


async def expire_checkout_reservation(room_id: str, expires_at: float):
    """Scheduled once, the moment a room's first payment comes in. If the
    order still isn't fully paid by `expires_at` -- and nothing has reset the
    window in the meantime (e.g. a completed order, or the room disappearing)
    -- releases the hold: clears every payment (refund) and the reservation
    fields, then broadcasts so everyone's "Pay my share" button reappears."""
    await asyncio.sleep(max(0, expires_at - time.time()))
    room = rooms.get(room_id)
    if not room:
        return
    if room.get("session_number") is not None:
        return  # already completed for real -- nothing to release
    if room.get("checkout_expires_at") != expires_at:
        return  # window was reset/renewed since this task was scheduled
    room["payments"] = {}
    room["checkout_started_at"] = None
    room["checkout_expires_at"] = None
    await broadcast_state(room_id, event={
        "name": "System",
        "verb": "released the reservation -- the window expired, so any payments made have been refunded and everyone can pay again",
    })


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
    relation = (room.get("gift_recipient_relation") or "").strip()
    if not relation or relation.lower() == "myself":
        return False
    return len(room.get("participants", {})) > 1


@app.post("/api/rooms")
def create_room(req: CreateRoomRequest):
    code = make_room_code()
    rooms[code] = new_room_state(
        req.occasion, req.budget, req.when, req.itinerary,
        req.gift_recipient_relation, req.gift_recipient_name, req.creator_email,
    )
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


def persistent_profiles_for_room(room: dict) -> Dict[str, dict]:
    """client_id -> that person's persistent taste_profile from users.json,
    via the email they logged in with (room["participant_emails"], set on
    websocket connect). Anyone without a stored email (shouldn't normally
    happen, but the emails query param is optional) just gets an empty
    profile -- score_feed() already treats that as "no persistent signal yet",
    not an error."""
    emails = room.get("participant_emails", {})
    return {
        cid: users.get(email, {}).get("taste_profile", {})
        for cid, email in emails.items()
        if email
    }


@app.get("/api/rooms/{room_id}")
def get_room(room_id: str):
    room = rooms.get(room_id.upper())
    if not room:
        return {"error": "not_found"}
    attach_gift_split_resolution(room)
    feed_scores = score_feed(room, CATALOG, persistent_profiles=persistent_profiles_for_room(room))
    return {"catalog": CATALOG, "feed_scores": feed_scores, **room}


@app.get("/api/reminders")
def get_reminders(email: str = ""):
    email = email.strip().lower()
    today = date.today()
    window_days = 5
    reminders = []

    for squad in finished_squads:
        if squad.get("archived"):
            continue
        if not squad.get("gift_recipient_relation"):
            continue
        if squad.get("had_itinerary"):
            continue
        if squad.get("reminded"):
            continue

        # Only ever surface a reminder to someone who was actually part of
        # this squad -- without this, ANY logged-in person would see every
        # gift reminder ever created by anyone, including gifts that have
        # nothing to do with them. A squad saved before this field existed
        # has no participant_emails at all, so it's excluded entirely rather
        # than guessed at -- unverifiable identity defaults to hidden, not shown.
        participant_emails = [e.strip().lower() for e in squad.get("participant_emails", [])]
        if not email or email not in participant_emails:
            continue

        try:
            occasion_date = datetime.fromisoformat(squad["when"]).date()
        except (ValueError, TypeError, KeyError):
            continue

        next_occurrence = occasion_date.replace(year=occasion_date.year + 1)
        if abs((next_occurrence - today).days) > window_days:
            continue

        bought = squad.get("bought_items") or []
        relation = squad.get("gift_recipient_relation", "")
        recipient_name = squad.get("gift_recipient_name", "")
        recipient_display = gift_recipient_display(relation, recipient_name)

        # A relationship belongs to whoever set it, not to everyone who
        # happened to co-shop it -- Aishnaa helping buy for Yoshita's mom
        # doesn't make it Aishnaa's mom too. If the viewer is the owner, the
        # label stays exactly as before ("Mom"); if not, it's attributed to
        # whoever it actually belongs to ("Yoshita's Mom") so the reminder
        # never implies a relationship the viewer doesn't have.
        owner_email = (squad.get("gift_owner_email") or "").strip().lower()
        is_owner = bool(owner_email) and email == owner_email
        is_myself_relation = relation.strip().lower() == "myself"
        if is_owner or not owner_email:
            person_label = recipient_display
        elif is_myself_relation:
            # "Myself" needs its own case: "Yoshita's Myself" reads as
            # nonsense. What the non-owner actually needs to know is whose
            # purchase this was, plain and simple.
            person_label = users.get(owner_email, {}).get("name") or next(iter(squad.get("members", [])), "a squadmate")
        else:
            owner_name = users.get(owner_email, {}).get("name") or next(iter(squad.get("members", [])), "a squadmate")
            person_label = f"{owner_name}'s {recipient_display}" if recipient_display else f"{owner_name}'s"

        bought_ids = {b["id"] for b in bought}
        bought_tags = {b["tag"] for b in bought}
        recs = [item for item in CATALOG if item["id"] not in bought_ids and item["tag"] in bought_tags][:3]

        bought_first = CATALOG_BY_ID.get(bought[0]["id"]) if bought else None

        squad["reminded"] = True
        reminders.append({
            "occasion": squad["occasion"],
            "person": person_label,
            "recipient_relation": relation,
            "recipient_name": recipient_name,
            "is_owner": is_owner or not owner_email,
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


class ArchiveReminderRequest(BaseModel):
    room_code: str


@app.post("/api/reminders/archive")
def archive_reminder(req: ArchiveReminderRequest):
    """"Don't remind me about this again" -- e.g. a falling-out with the
    friend a gift was for. Permanent: once archived, this specific squad's
    reminder never resurfaces, for anyone who was in it."""
    for squad in finished_squads:
        if squad.get("room_code") == req.room_code:
            squad["archived"] = True
            save_finished_squads()
            return {"ok": True}
    return {"ok": False, "error": "not_found"}


@app.post("/api/demo/time-travel")
def demo_time_travel():
    gift_squads = [s for s in finished_squads if s.get("gift_recipient_relation")]
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
    attach_gift_split_resolution(room)
    ai_note = get_ai_suggestion(room, CATALOG)
    # Recomputed on every broadcast -- it's a plain scoring pass over the
    # catalog (no GPU, sub-millisecond), so re-running it on every vote is
    # cheap. This is exactly the "ranking stays with cheap, fast models"
    # answer given to the judges, made real: nothing here waits on an LLM.
    feed_scores = score_feed(room, CATALOG, persistent_profiles=persistent_profiles_for_room(room))
    payload = {"type": "state", "room": room, "ai_note": ai_note, "feed_scores": feed_scores}
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
    email = (ws.query_params.get("email") or "").strip().lower()

    await manager.connect(room_id, client_id, ws)
    room = rooms[room_id]

    catchup = compute_catchup(room, client_id)
    if catchup:
        await ws.send_json({"type": "catchup", "catchup": catchup})

    room["members"][client_id] = name
    room.setdefault("participants", {})[client_id] = name
    if email:
        room.setdefault("participant_emails", {})[client_id] = email
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

                # Persist this vote into the voter's account, if they're
                # logged in -- this is the one line that makes taste carry
                # across sessions rather than resetting every time a squad
                # closes. Kept as a small, same-shaped nudge to the session-
                # scoped version in ai_coordinator.score_feed(); score_feed
                # itself is what keeps this from ever dominating a fresh
                # squad's own occasion/season baseline.
                voter_email = room.get("participant_emails", {}).get(client_id)
                if voter_email and item and voter_email in users:
                    profile = users[voter_email].setdefault("taste_profile", {})
                    profile[item["tag"]] = profile.get(item["tag"], 0.0) + (1.0 if reaction == "like" else -0.5)
                    save_users()

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

            elif action == "set_split_mode":
                mode = data.get("mode")
                if mode not in ("even", "custom"):
                    continue
                room["gift_split_mode"] = mode
                # No seeding needed -- an empty gift_split_manual means
                # everyone's on auto, which resolve_gift_split() already
                # turns into a valid even split. The squad starts from a
                # correct state and only deviates from it once someone
                # actually types a number.
                event = {"name": name, "verb": f"switched to {'custom split' if mode == 'custom' else 'even split'}"}

            elif action == "set_custom_amount":
                # Deliberately only ever writes the CALLER's own entry -- a
                # person can adjust their own contribution, never anyone
                # else's. Everyone NOT in this dict auto-splits whatever's
                # left, live -- see resolve_gift_split().
                try:
                    amount = max(0, round(float(data.get("amount", 0))))
                except (TypeError, ValueError):
                    continue
                room.setdefault("gift_split_manual", {})[client_id] = amount
                event = {"name": name, "verb": "adjusted their share"}

            elif action == "clear_custom_amount":
                # Lets someone go back to "auto" for themselves -- their
                # share reverts to an even split of whatever's left among
                # the other still-auto members, instead of being stuck at
                # whatever they last typed.
                if room.get("gift_split_manual", {}).pop(client_id, None) is not None:
                    event = {"name": name, "verb": "reset their share to auto"}
                else:
                    continue

            elif action == "pay_share":
                cart_total = sum(CATALOG_BY_ID[i]["price"] for i in room.get("cart", []) if i in CATALOG_BY_ID)

                if is_gift_split_room(room):
                    participant_ids = list(room.get("participants", {}).keys())
                    if room.get("gift_split_mode") == "custom":
                        manual = room.get("gift_split_manual", {})
                        resolved, balanced = resolve_gift_split(cart_total, participant_ids, manual)
                        if not balanced:
                            # Split doesn't add up yet -- reject the payment
                            # rather than accepting a number nobody agreed to.
                            # No `continue` here since we still want to notify
                            # the squad via the toast, just without registering
                            # a payment.
                            allocated_total = sum(resolved.values())
                            event = {
                                "name": name,
                                "verb": f"tried to pay, but the split only adds up to ₹{allocated_total} of ₹{cart_total} so far",
                            }
                            await broadcast_state(room_id, event=event)
                            continue
                        my_total = resolved.get(client_id, 0)
                    else:
                        my_total = round(cart_total / max(len(participant_ids), 1))
                    buyer_ids = set(participant_ids)
                else:
                    my_total = sum(
                        CATALOG_BY_ID[i]["price"]
                        for i, buyer in room["assignments"].items()
                        if buyer == client_id and i in CATALOG_BY_ID
                    )
                    buyer_ids = set(room["assignments"].values())

                room["payments"][client_id] = True
                event = {"name": name, "verb": "paid their share", "item": f"₹{my_total}"}

                # An order with any unassigned item is never "done," no matter
                # who's paid what -- otherwise a squad where only some items
                # have a buyer yet can look fully paid the moment that subset
                # settles up, which both marks the order complete too early
                # and skips the reservation window entirely (this was the bug:
                # the very first payment silently short-circuited straight to
                # "complete" instead of ever starting the countdown).
                fully_assigned = is_gift_split_room(room) or all(
                    i in room["assignments"] for i in room.get("cart", [])
                )
                everyone_paid = fully_assigned and buyer_ids and all(room["payments"].get(b) for b in buyer_ids)
                if everyone_paid and room.get("session_number") is None:
                    global completed_sessions_count
                    completed_sessions_count += 1
                    room["session_number"] = completed_sessions_count
                    room["checkout_started_at"] = None
                    room["checkout_expires_at"] = None

                    bought_items = [
                        {"id": i, "name": CATALOG_BY_ID[i]["name"], "tag": CATALOG_BY_ID[i]["tag"]}
                        for i in room["cart"] if i in CATALOG_BY_ID
                    ]
                    finished_squads.append({
                        "occasion": room["occasion"],
                        "when": room["when"],
                        "members": list(room["participants"].values()),
                        # Emails of everyone who was actually in this squad --
                        # this is what lets a reminder later be shown ONLY to
                        # people who were genuinely part of it, instead of to
                        # anyone who happens to open the app. See get_reminders().
                        "participant_emails": list(room.get("participant_emails", {}).values()),
                        "room_code": room_id,
                        "gift_recipient_relation": room.get("gift_recipient_relation", ""),
                        "gift_recipient_name": room.get("gift_recipient_name", ""),
                        "gift_owner_email": room.get("gift_owner_email", ""),
                        "bought_items": bought_items,
                        "had_itinerary": bool(room.get("itinerary")),
                        "archived": False,
                    })
                    save_finished_squads()
                elif room.get("checkout_expires_at") is None:
                    # First payment in on an order that isn't already
                    # complete -- start (or restart, if a previous window
                    # already expired and released) the reservation clock.
                    now = time.time()
                    room["checkout_started_at"] = now
                    room["checkout_expires_at"] = now + RESERVATION_WINDOW_SECONDS
                    asyncio.create_task(expire_checkout_reservation(room_id, room["checkout_expires_at"]))

            elif action == "chat":
                text = (data.get("text") or "").strip()
                if text:
                    room["chat"].append({"name": name, "text": text})
                # Sending a message implies the person's done typing -- clear
                # their typing flag and let the others know immediately rather
                # than waiting for the 4s server-side timeout to expire.
                if typing_status.get(room_id, {}).pop(client_id, None) is not None:
                    await broadcast_typing(room_id)

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