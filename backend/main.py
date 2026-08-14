import asyncio
import json
import os
import random
import string
import time
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ai_coordinator import (
    get_ai_suggestion,
    relevant_category_ids,
    parse_ai_chat_intent,
    infer_function_for_item,
    tie_break_advice,
    pick_surprise_items,
    score_feed,
    vote_status,
)

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
CATALOG = json.loads((BASE_DIR / "catalog.json").read_text(encoding="utf-8"))
CATALOG_BY_ID = {item["id"]: item for item in CATALOG}

app = FastAPI(title="Shop Together (Myntra Hackathon MVP)")


@app.on_event("startup")
async def _start_maintenance():
    prune_rooms()  # clear out anything dead left over from the last run
    asyncio.create_task(_background_maintenance())


@app.on_event("shutdown")
async def _flush_on_shutdown():
    # A clean shutdown (redeploy, Ctrl-C) should never lose the last few
    # seconds of votes just because they were still sitting behind the
    # flush interval.
    _write_rooms_now()

# Hard cap on squad size. Nothing in the logic assumes a specific number --
# the majority formula, vote_status()'s deadlock/objection detection, the
# "who hasn't voted" nudge, least-misery scoring and the gift splits are all
# written generically over participant_count, so 6 is not a special case.
# The cap exists because demoing something *unbounded* live is asking for
# trouble, and the real constraint is UI density on a phone-width screen:
# checkout's per-item assign chips wrap to a second row at 4+ (three 28px
# chips per 96px row), so 6 means two rows per cart item -- busier, still
# perfectly readable. Mirrored in frontend/app.js's MAX_SQUAD_SIZE -- kept
# in sync manually, same reasoning as OCCASION_TAGS/KEYWORD_TAG_RULES there.
MAX_SQUAD_SIZE = 6

# ---- state persistence -------------------------------------------------
ROOMS_FILE = BASE_DIR / "rooms_state.json"


def load_rooms() -> Dict[str, dict]:
    if ROOMS_FILE.exists():
        try:
            return json.loads(ROOMS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _write_rooms_now():
    """Atomic write: full file to a temp path, then one rename.

    write_text() truncates the real file first and then streams into it, so a
    crash, redeploy, or container eviction partway through leaves a truncated
    file. load_rooms() can't parse that, swallows the JSONDecodeError, and
    returns {} -- silently destroying EVERY squad's state, not just the one
    being written. os.replace is atomic on the same filesystem, so readers
    only ever see a complete old file or a complete new one.
    """
    try:
        tmp = ROOMS_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(rooms), encoding="utf-8")
        os.replace(tmp, ROOMS_FILE)
    except OSError:
        pass


_rooms_dirty = False


def save_rooms():
    """Marks state as needing a flush, instead of writing immediately.

    This is called on every broadcast -- i.e. every single vote, from every
    squad. The old version serialised the ENTIRE rooms dict and did a full
    synchronous disk write each time, on the event loop. Since rooms are
    long-lived and (before prune_rooms below) were never deleted, that cost
    grew all day: measured at ~0.7ms with 10 squads but ~26ms with 400, and
    every one of those milliseconds blocks the single uvicorn worker for
    EVERYONE, not just the person who voted. A busy afternoon would have
    degraded into visible lag on every tap, with nothing in the logs to
    explain it.

    Durability cost is deliberate and small: at worst FLUSH_INTERVAL_SECONDS
    of votes are lost if the process is killed uncleanly. Everyone's browser
    still holds current state and reconnects, and a hard kill mid-demo is
    already a restart-and-rejoin situation.
    """
    global _rooms_dirty
    _rooms_dirty = True


MAX_ACTIVITY_LOG = 300
MAX_CHAT_MESSAGES = 200
MAX_FINISHED_SQUADS = 500
FLUSH_INTERVAL_SECONDS = 3
PRUNE_INTERVAL_SECONDS = 600
# An abandoned room is one created (usually by someone poking at the QR link)
# that nobody ever actually joined. Those pile up fastest and are worth
# nothing. A finished room has a completed order and is kept long enough to
# stay reachable right after checkout, but not forever.
ABANDONED_ROOM_SECONDS = 3600           # 1 hour, never joined
FINISHED_ROOM_SECONDS = 24 * 3600       # 24 hours after everyone paid


def room_last_activity(room: dict) -> float:
    """Best available "when was this touched" timestamp, newest wins."""
    stamps = [room.get("created_at") or 0]
    log = room.get("activity_log") or []
    if log:
        stamps.append(log[-1].get("ts", 0))
    seen = room.get("member_last_seen") or {}
    if seen:
        stamps.append(max(seen.values()))
    chat = room.get("chat") or []
    if chat:
        stamps.append(chat[-1].get("ts", 0))
    return max(stamps)


def prune_rooms():
    """Drops rooms that can't matter to anyone anymore.

    Deliberately conservative: a room with ANY participant and no completed
    order is never touched, however old, because someone may genuinely come
    back to it. Only clearly-dead rooms go -- created-but-never-joined, or
    fully paid and a day old. Without this, rooms_state.json grows for the
    lifetime of the process and every save gets slower for everyone.
    """
    now = time.time()
    doomed = []
    for code, room in rooms.items():
        # Never prune a room someone is connected to RIGHT NOW, regardless of
        # what the timestamps say -- this is the one mistake here that would
        # be catastrophic and invisible.
        if manager.active.get(code):
            continue
        age = now - room_last_activity(room)
        never_joined = not room.get("participants")
        finished = room.get("session_number") is not None
        if never_joined and age > ABANDONED_ROOM_SECONDS:
            doomed.append(code)
        elif finished and age > FINISHED_ROOM_SECONDS:
            doomed.append(code)
    for code in doomed:
        rooms.pop(code, None)
    if doomed:
        print(f"[prune] removed {len(doomed)} dead room(s), {len(rooms)} remain")
        save_rooms()


async def _background_maintenance():
    """Single loop for the two periodic jobs. Flushing here rather than on
    every vote is what keeps a busy day from getting progressively slower."""
    global _rooms_dirty
    last_prune = time.time()
    while True:
        await asyncio.sleep(FLUSH_INTERVAL_SECONDS)
        try:
            if _rooms_dirty:
                _rooms_dirty = False
                _write_rooms_now()
            if time.time() - last_prune > PRUNE_INTERVAL_SECONDS:
                last_prune = time.time()
                prune_rooms()
        except Exception as e:
            # A failure here must never kill the loop -- if it dies, state
            # silently stops being written for the rest of the process's life.
            print(f"[maintenance] {e!r}")


rooms: Dict[str, dict] = load_rooms()
completed_sessions_count = 0

# In-memory only, deliberately never written to rooms_state.json -- "who's
# currently typing" is inherently transient and would be stale the instant
# it's read back after any restart. Structure: {room_id: {client_id: last_ts}}
typing_status: Dict[str, Dict[str, float]] = {}
TYPING_TIMEOUT_SECONDS = 4  # server-side safety net if a "stop" signal is ever missed (tab killed mid-keystroke, etc.)

# Same idea as typing_status, tracked separately -- recording a voice message
# isn't "typing," and the two need distinct UI text ("recording a voice
# message" vs "is typing"), so they're kept as two parallel maps rather than
# overloading one signal to mean either.
voice_recording_status: Dict[str, Dict[str, float]] = {}
RECORDING_TIMEOUT_SECONDS = 35  # slightly above the client's own 30s recording cap, as a safety net if "stop" is ever missed

# A third parallel signal, same shape again -- someone looking at the
# checkout recommendation card needs the rest of the squad to know, so
# nobody pays mid-decision without realizing a possible add-on is being
# considered. Stores {room_id: {client_id: (timestamp, item_name)}}.
considering_status: Dict[str, Dict[str, tuple]] = {}
CONSIDERING_TIMEOUT_SECONDS = 60  # generous -- this is a deliberate look, not a keystroke; a missed "stop" shouldn't clear it too eagerly

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

# ---- persistent accounts (user_id -> {name, taste_profile}) ------------
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
    """Atomic, same reasoning as save_rooms() above -- a truncated users.json
    would log everyone out and orphan every saved taste profile and gift
    reminder at once."""
    try:
        tmp = USERS_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(users), encoding="utf-8")
        os.replace(tmp, USERS_FILE)
    except OSError:
        pass


users: Dict[str, dict] = load_users()


class LoginRequest(BaseModel):
    name: str
    # Set by the frontend ONLY after the person has already been asked
    # "there's already a X -- is that you?" and answered. Absent (False) on
    # every normal first attempt. See the collision handling below for why
    # this two-step exists instead of matching by name outright.
    confirm_existing: bool = False
    confirm_new: bool = False

class SignupRequest(BaseModel):
    email: str
    name: str


@app.post("/api/login")
def login(req: LoginRequest):
    name = req.name.strip()

    if not name:
        return {"ok": False, "error": "missing_name"}

    # Look for an existing user by name -- but DON'T act on a match yet.
    # Matching-by-name is genuinely needed (it's what makes "Switch account"
    # on a shared device return you to your own saved taste profile instead
    # of a blank one), so it can't just be removed. The bug was auto-logging
    # into whatever account matched: two different physical people who
    # happen to type the same name (two "Yoshi"s, two people both typing a
    # generic test name at a demo) would silently merge into one account,
    # each seeing the other's taste profile and gift reminders. Neither of
    # those people asked for that, and neither would notice until something
    # looked wrong.
    match = None
    for user_id, record in users.items():
        if record.get("name", "").strip().lower() == name.lower():
            match = (user_id, record.get("name", "").strip())
            break

    if match and not req.confirm_new:
        user_id, existing_name = match
        if req.confirm_existing:
            # The person already said "yes, that's me" on a prior submit --
            # NOW it's safe to log them into the existing account.
            return {"ok": True, "user_id": user_id, "name": existing_name}
        # First time we've seen this name collide -- don't decide for them.
        # Ask once. Costs nothing on the common case (a unique name never
        # reaches this branch at all).
        return {"ok": False, "error": "name_taken", "existing_name": existing_name}

    # No collision, OR the person explicitly said "that's not me" -- create
    # a fresh, separate account. Deliberately still stored under the SAME
    # display name if confirm_new was set: two different people are allowed
    # to share a first name; giving one of them a silently-different label
    # would be more confusing than two accounts that happen to look the same.
    user_id = f"user_{uuid.uuid4().hex[:12]}"

    users[user_id] = {
        "name": name,
        "taste_profile": {}
    }
    save_users()

    return {
        "ok": True,
        "user_id": user_id,
        "name": name
    }
    

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
    """A code that isn't already in use.

    The unguarded version could return a code an ACTIVE squad was already
    using, and `rooms[code] = new_room_state(...)` would silently wipe them
    mid-session -- their cart, votes and members gone with no error anywhere.
    At 32^5 that's rare with a handful of squads, but it scales with the
    square of concurrent rooms, and it's the kind of failure that's
    impossible to diagnose from a bug report. Bounded retry, then a longer
    code rather than an infinite loop.
    """
    safe_chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    for _ in range(50):
        code = "".join(random.choices(safe_chars, k=5))
        if code not in rooms:
            return code
    return "".join(random.choices(safe_chars, k=8))


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
        # Lets prune_rooms() age out rooms that were created and then never
        # joined -- the commonest kind of junk once a QR code is public, and
        # the only timestamp available before any activity has happened.
        "created_at": time.time(),
        "itinerary": itinerary or [],
        "gift_recipient_relation": gift_recipient_relation,
        "gift_recipient_name": gift_recipient_name,
        "gift_owner_email": creator_email.strip().lower(),
        "members": {},
        "participants": {},
        "participant_emails": {},
        "reactions": {},
        "cart": [],
        # Set by the "Hey AI, ..." chat command -- see parse_ai_chat_intent()
        # in ai_coordinator.py. None means no filter is active.
        "ai_chat_filter": None,
        # AI advice on contested items, keyed by item id: {item_id: advice}.
        # Replaces the old tie_breaks/tie_break_reasons pair, which STORED A
        # DECISION and mutated the cart. This only ever stores a read the
        # squad asked for -- see ai_coordinator.tie_break_advice() for why
        # the AI no longer decides ties at all.
        "tie_advice": {},
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
        # Checkout recommendation card ("complete the look") -- dismissing an
        # item here has to be squad-wide, not per-browser. Otherwise each
        # person's "Not now" only hides it on their own screen, and the two
        # of them end up looking at two different cards without realizing
        # it -- which is exactly what made liking/dismissing feel like it
        # went nowhere: it wasn't affecting what the other person was even
        # looking at.
        "dismissed_recommendations": [],
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

    # participants, not a raw len(votes)>=2 check -- see vote_status()'s
    # docstring in ai_coordinator.py for why "any 2 conflicting votes" was
    # never a correct definition of "tied" once a squad can be 3-5 people.
    participant_count = max(len(room.get("participants", {})), 1)

    needs_call = 0
    tied_count = 0
    for item_id in touched_items:
        if item_id in room["cart"] or item_id in room.get("tie_advice", {}):
            continue
        votes = room["reactions"].get(item_id, {})
        if client_id not in votes:
            needs_call += 1
        if vote_status(votes, participant_count) == "deadlocked":
            tied_count += 1

    return {
        "voters": voters,
        "items_touched": len(touched_items),
        "needs_call": needs_call,
        "tied_count": tied_count,
    }


def is_gift_recipient_set(room: dict) -> bool:
    """Whether this room is shopping for someone other than the squad.

    Deliberately satisfied by EITHER field. This used to require a relation,
    which meant typing just a name ("Rhea") and picking no chip produced a
    room that looked like a gift room to the person who made it but wasn't
    one to any of the code: no even-split checkout, no "keep it on the
    down-low" note, and -- worst, because it fails silently a year later --
    no reminder, since get_reminders() filtered on relation too. A name is
    strictly MORE specific than a relation, so requiring the vaguer of the
    two was exactly backwards.
    """
    relation = (room.get("gift_recipient_relation") or "").strip()
    name = (room.get("gift_recipient_name") or "").strip()
    if relation.lower() == "myself":
        # Legacy rooms only -- the "Myself" chip has been removed, since
        # "shopping for myself" is just the default, not a recipient.
        return False
    return bool(relation or name)


def is_gift_split_room(room: dict) -> bool:
    return is_gift_recipient_set(room) and len(room.get("participants", {})) > 1


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
    via the identifier they logged in with (room["participant_emails"], set
    on websocket connect -- named "emails" from the earlier email-based login,
    now actually holding the name-login's user_id, but the lookup below still
    works correctly since it's just a key into `users`). Anyone without a
    stored identifier (shouldn't normally happen, but the query param is
    optional) just gets an empty profile -- score_feed() already treats that
    as "no persistent signal yet", not an error."""
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
    # So the frontend's pre-join check (join-form submit handler) can warn
    # "this squad's full" before ever opening a socket, instead of only
    # finding out via a websocket rejection after the screen's already
    # switched. The websocket connect below is still the real, authoritative
    # cap enforcement -- this is just a friendlier heads-up.
    at_capacity = len(room.get("participants", {})) >= MAX_SQUAD_SIZE
    # Which items belong under "Picked for <occasion>". Computed here, not in
    # the frontend, so there's exactly one table of occasion->category
    # relevance in the codebase instead of two that silently drift apart.
    return {"catalog": CATALOG, "feed_scores": feed_scores,
            "relevant_ids": relevant_category_ids(CATALOG, room),
            "max_squad_size": MAX_SQUAD_SIZE, "at_capacity": at_capacity, **room}


@app.get("/api/reminders")
def get_reminders(email: str = ""):
    email = email.strip().lower()
    today = date.today()
    window_days = 5
    reminders = []

    for squad in finished_squads:
        if squad.get("archived"):
            continue
        if not is_gift_recipient_set(squad):
            continue
        if squad.get("had_itinerary"):
            continue
        if squad.get("reminded"):
            continue
        # "Just Browsing" isn't an occasion that recurs annually -- it's the
        # absence of one. "Rhea's Just Browsing is coming up again!" is
        # nonsense: there's no calendar date for "not having a specific
        # plan." Only real occasions (Birthday, Anniversary, etc.) get a
        # reminder a year later.
        if squad.get("occasion") == "Just Browsing":
            continue

        # Show the reminder to anyone who was in this squad. Simple and
        # robust -- this is the version that reliably worked. Owner-only
        # scoping was too fragile for a real two-device demo (whoever
        # CREATED a squad owns it, but the other person, or the same person
        # on another tab, would then match nobody and see nothing). A squad
        # with no participant list recorded is skipped rather than shown to
        # everyone.
        participant_emails = [
            (e or "").strip().lower()
            for e in (squad.get("participant_emails") or [])
        ]
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
        is_self_gift = relation.strip().lower() == "myself"

        # Same label for EVERY participant, regardless of who created the
        # squad. This used to branch on "are you the owner" and, for anyone
        # who wasn't, prefixed the creator's own name onto the recipient
        # ("Aishnaa's Parnika") -- the frontend then wrapped THAT in its own
        # possessive on top ("Aishnaa's Parnika's Birthday"). Two layers of
        # attribution stacking is the whole bug. There's no ownership here
        # to attribute in the first place: Aishnaa helping shop for Yoshi's
        # mom doesn't make the reminder about Aishnaa at all -- it's about
        # the recipient and the occasion, full stop, and that's identical no
        # matter who's looking at it.
        person_label = recipient_display

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
            "is_self_gift": is_self_gift,
            "room_code": squad["room_code"],
            "bought_item_name": bought[0]["name"] if bought else None,
            "bought_item_emoji": bought_first["emoji"] if bought_first else None,
            "bought_item_image": bought_first.get("image", "") if bought_first else "",
            "recommendations": [
                {"id": r["id"], "name": r["name"], "emoji": r["emoji"], "price": r["price"], "image": r.get("image", "")}
                for r in recs
            ],
        })
        # checkReminders() in app.js only ever shows reminders[0] -- a single
        # modal, once. Without this break, the loop kept going and marked
        # EVERY other qualifying squad as "reminded" too in the same pass,
        # even though only the first one would ever actually be shown. That
        # silently and permanently consumed the rest: if a second gift squad
        # became eligible in the same window (exactly what happened here --
        # Parnika's squad was still within its window when Rhea's squad also
        # qualified), Parnika's reminder got marked seen and discarded
        # without the person ever laying eyes on it. One reminder shown,
        # one reminder marked -- never more than what's actually displayed.
        break

    if reminders:
        save_finished_squads()
    return {"reminders": reminders}


class ArchiveReminderRequest(BaseModel):
    room_code: str


class DemoTimeTravelRequest(BaseModel):
    # The caller's email, so time-travel only ages that user's own gift
    # squads -- see demo_time_travel() for why this matters.
    email: str = ""


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
def demo_time_travel(req: DemoTimeTravelRequest):
    # Ages only the CURRENT user's own gift squads -- the ones they created,
    # matched by gift_owner_email. Previously this aged every gift squad in
    # the whole system regardless of who owned it, so one person's demo click
    # resurrected strangers' and old sessions' squads, and reminders fired
    # for gifts the clicker never shopped for. Scoping to the caller makes
    # the demo predictable: click it, see reminders for YOUR gifts, nothing
    # else.
    email = (req.email or "").strip().lower()
    if not email:
        return {"error": "no_user", "message": "Log in first, then time-travel."}

    # Age every gift squad the caller was a PARTICIPANT in -- not just ones
    # they "own." In a real two-device demo, whoever created the squad owns
    # it, but either person needs to be able to hit "jump a year" and see
    # the reminders for the gifts they were part of. Owner-only scoping kept
    # failing exactly this case.
    my_gift_squads = [
        s for s in finished_squads
        if is_gift_recipient_set(s)
        and s.get("occasion") != "Just Browsing"
        and not s.get("archived")
        and email in [(e or "").strip().lower() for e in (s.get("participant_emails") or [])]
    ]
    if not my_gift_squads:
        return {"error": "no_history", "message": "No completed gift checkout yet -- finish one (with a recipient set) first, then come back here."}

    # Re-age EVERY one of your gift squads, every click -- no one-shot flag.
    # A demo button has to be repeatable: previously each squad could only
    # ever be time-travelled once, so after the first click the button was
    # dead for those squads and later runs showed either nothing or only
    # whichever squad happened to still be un-aged. Re-arming all of them
    # on every click makes it predictable -- click it, every gift you've
    # shopped for comes due, in order.
    for squad in my_gift_squads:
        squad["when"] = (date.today() - timedelta(days=365)).isoformat()
        squad["reminded"] = False
    save_finished_squads()
    return {"ok": True, "aged_count": len(my_gift_squads)}


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
    # Recomputed on every broadcast -- it's a plain scoring pass over the
    # catalog (no GPU, sub-millisecond), so re-running it on every vote is
    # cheap. This is exactly the "ranking stays with cheap, fast models"
    # answer given to the judges, made real: nothing here waits on an LLM.
    feed_scores = score_feed(room, CATALOG, persistent_profiles=persistent_profiles_for_room(room))
    relevant_ids = relevant_category_ids(CATALOG, room)

    # The AI note is PER VIEWER, everything else is shared. Some notes are
    # about a specific person ("2 items still need your call"), and a single
    # broadcast string can only phrase those in the third person -- which
    # meant the one person who could act on it was the only one not being
    # addressed. get_ai_suggestion() is a cheap pass over existing room
    # state, so running it once per connected socket (max 6) costs nothing
    # measurable; the genuinely expensive part, score_feed, still runs once
    # above and is shared by everyone.
    sockets = list(manager.active.get(room_id, {}).items())
    for client_id, ws in sockets:
        payload = {
            "type": "state",
            "room": room,
            "ai_note": get_ai_suggestion(room, CATALOG, viewer_client_id=client_id),
            "feed_scores": feed_scores,
            "relevant_ids": relevant_ids,
        }
        if event:
            payload["event"] = event
        try:
            await ws.send_json(payload)
        except Exception:
            pass
    save_rooms()


async def broadcast_typing(room_id: str):
    """Deliberately separate from broadcast_state -- this fires on every
    keystroke, so it must never trigger a full room save or re-run the AI
    suggestion logic. Sends both who's typing and who's recording a voice
    message right now -- kept in the same payload (still called "typing" for
    the message type, to avoid touching every call site) since both are
    small, frequent, ephemeral signals that never touch disk."""
    room = rooms[room_id]
    now = time.time()

    active_typers = {
        cid: ts for cid, ts in typing_status.get(room_id, {}).items()
        if now - ts < TYPING_TIMEOUT_SECONDS
    }
    typing_status[room_id] = active_typers
    typer_names = [room["participants"][cid] for cid in active_typers if cid in room["participants"]]

    active_recorders = {
        cid: ts for cid, ts in voice_recording_status.get(room_id, {}).items()
        if now - ts < RECORDING_TIMEOUT_SECONDS
    }
    voice_recording_status[room_id] = active_recorders
    recorder_names = [room["participants"][cid] for cid in active_recorders if cid in room["participants"]]

    active_considering = {
        cid: entry for cid, entry in considering_status.get(room_id, {}).items()
        if now - entry[0] < CONSIDERING_TIMEOUT_SECONDS
    }
    considering_status[room_id] = active_considering
    considering_list = [
        {"name": room["participants"][cid], "item_name": entry[1], "item_id": entry[2] if len(entry) > 2 else None}
        for cid, entry in active_considering.items() if cid in room["participants"]
    ]

    await manager.broadcast(room_id, {
        "type": "typing", "typers": typer_names, "recorders": recorder_names, "considering": considering_list,
    })


@app.websocket("/ws/{room_id}")
async def websocket_endpoint(ws: WebSocket, room_id: str):
    room_id = room_id.upper()
    if room_id not in rooms:
        await ws.close(code=4004)
        return

    name = ws.query_params.get("name", "Guest")
    client_id = ws.query_params.get("client_id") or name
    email = (ws.query_params.get("email") or "").strip().lower()

    room = rooms[room_id]
    # Squad-size cap, enforced here (not just in the frontend's pre-join
    # check) since this is the one place that's actually authoritative --
    # two people tapping "Join" at the exact same moment on a squad sitting
    # at MAX_SQUAD_SIZE-1 is a real race the REST pre-check alone can't
    # close. Reconnecting is always allowed regardless of the cap: this is
    # about turning away genuinely NEW participants, not punishing someone
    # whose socket dropped and is coming back.
    if client_id not in room.get("participants", {}) and len(room.get("participants", {})) >= MAX_SQUAD_SIZE:
        await ws.close(code=4008)
        return

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
            # This is the boundary that matters most once a QR code puts the
            # app in front of strangers on unknown browsers: ONE malformed
            # frame -- a stray non-JSON message, a payload missing a field,
            # devtools poking at the socket -- used to raise uncaught (the
            # only guard was WebSocketDisconnect/RuntimeError below), which
            # silently killed this person's connection loop and skipped every
            # cleanup step. They'd stay listed in room["participants"]
            # forever with no way to leave: manager.disconnect() never ran,
            # so the majority math for the whole squad was permanently
            # inflated by a phantom voter, for everyone else, until the
            # server restarted. A per-message try/except means the WORST
            # case for a bad frame is "that one action was ignored" --
            # the connection, and the room, stay healthy.
            try:
                data = await ws.receive_json()
            except WebSocketDisconnect:
                raise  # a real disconnect -- let the outer handler run cleanup
            except Exception:
                continue  # not valid JSON at all -- ignore the frame, keep listening

            try:
                action = data.get("action")
                room = rooms[room_id]

                event = None

                if action == "react":
                    item_id = data.get("item_id")
                    reaction = data.get("reaction")
                    if not item_id or reaction not in ("like", "pass"):
                        continue
                    room["reactions"].setdefault(item_id, {})[client_id] = reaction
                    room["activity_log"].append({
                        "type": "react", "actor": name, "client_id": client_id,
                        "item_id": item_id, "reaction": reaction, "ts": time.time(),
                    })
                    # Bounded. This list only feeds the catch-up banner and
                    # last-vote-timestamp checks, both of which look at recent
                    # activity only -- but it was appended to on EVERY vote
                    # and never trimmed, so a long session grew it without
                    # limit, and every entry was re-serialised to disk on
                    # every subsequent save.
                    if len(room["activity_log"]) > MAX_ACTIVITY_LOG:
                        del room["activity_log"][:-MAX_ACTIVITY_LOG]

                    likes = sum(1 for r in room["reactions"][item_id].values() if r == "like")
                    # participants, not members -- a dropped socket shouldn't
                    # change what the squad already agreed the bar for
                    # consensus was. See vote_status() in ai_coordinator.py for
                    # the fuller reasoning; this majority formula matches its
                    # internal one so "in cart" and "deadlocked" never disagree
                    # with each other on the same votes.
                    participant_count = max(len(room.get("participants", {})), 1)
                    majority = 1 if participant_count == 1 else max(2, (participant_count // 2) + 1)
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

                elif action == "request_advice":
                    # Deliberately has NO effect on the cart. It stores a read and
                    # nothing else -- no add, no remove, no lock. The squad's votes
                    # remain the only thing that can actually move an item, which
                    # is the entire point of replacing the old "break_tie" action
                    # (see ai_coordinator.tie_break_advice()).
                    item_id = data.get("item_id")
                    item = CATALOG_BY_ID.get(item_id)
                    if not item:
                        continue
                    advice = tie_break_advice(item, room, CATALOG)
                    room.setdefault("tie_advice", {})[item_id] = advice
                    event = {
                        "name": name,
                        "verb": "asked for a read on",
                        "item": item["name"],
                        "item_id": item_id,
                    }

                elif action == "assign":
                    item_id = data.get("item_id")
                    buyer_id = data.get("buyer_id")
                    claim = bool(data.get("claim"))
                    if not item_id or not buyer_id or buyer_id not in room["participants"]:
                        continue

                    # assignments[item_id] is a LIST of buyers, not a single
                    # one -- this is the actual fix for "everyone logged on
                    # to buy the same shirt for friendship day and couldn't."
                    # A single-buyer-per-item model meant the moment ONE
                    # person claimed an item, nobody else could claim their
                    # own unit of it at all, even though the item reaching
                    # the cart was a squad-wide style decision, not a claim
                    # on one physical piece. Each person who claims it pays
                    # for -- and is understood to be buying -- their own
                    # separate unit, same as it would work if four friends
                    # walked into a store and each picked up their own shirt
                    # off the same rack.
                    buyers = room["assignments"].setdefault(item_id, [])
                    if claim:
                        if buyer_id not in buyers:
                            buyers.append(buyer_id)
                    else:
                        if buyer_id in buyers:
                            buyers.remove(buyer_id)
                        if not buyers:
                            room["assignments"].pop(item_id, None)

                    item = CATALOG_BY_ID.get(item_id)
                    buyer_name = room["participants"].get(buyer_id)
                    event = {
                        "name": name,
                        "verb": f"claimed a unit for {buyer_name}" if claim else f"removed {buyer_name}'s claim",
                        "item": item["name"] if item else item_id,
                    }

                elif action == "tag_occasion":
                    item_id = data.get("item_id")
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
                    item_id = data.get("item_id")
                    item = CATALOG_BY_ID.get(item_id)
                    if item_id in room["cart"]:
                        room["cart"].remove(item_id)
                    room["assignments"].pop(item_id, None)
                    room["occasion_tags"].pop(item_id, None)
                    room["reactions"].pop(item_id, None)
                    room.get("tie_advice", {}).pop(item_id, None)
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
                        # assignments[item_id] is now a LIST of buyers (see
                        # the "assign" action above) -- each person who
                        # claimed a unit of an item pays full price for
                        # THEIR OWN unit, not a shared split of one. Someone
                        # claiming two different items pays for both.
                        my_total = sum(
                            CATALOG_BY_ID[i]["price"]
                            for i, buyers in room["assignments"].items()
                            if client_id in buyers and i in CATALOG_BY_ID
                        )
                        # Flattened union of every buyer across every item --
                        # was `set(room["assignments"].values())` when values
                        # were single ids; now each value is itself a list,
                        # so this needs one more level of unpacking or it
                        # would silently produce a set of LISTS (unhashable,
                        # would crash) instead of a set of buyer ids.
                        buyer_ids = {b for buyers in room["assignments"].values() for b in buyers}

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
                        # Bound the history. Reminders only ever look ~a year
                        # back and the list is re-serialised whole on every
                        # checkout, so an unbounded finished_squads is both a
                        # slowly-growing file and a slowly-growing write cost
                        # over a busy day. Keeping the most recent
                        # MAX_FINISHED_SQUADS is plenty for the reminder
                        # feature and caps both.
                        if len(finished_squads) > MAX_FINISHED_SQUADS:
                            del finished_squads[:-MAX_FINISHED_SQUADS]
                        save_finished_squads()
                    elif room.get("checkout_expires_at") is None:
                        # First payment in on an order that isn't already
                        # complete -- start (or restart, if a previous window
                        # already expired and released) the reservation clock.
                        now = time.time()
                        room["checkout_started_at"] = now
                        room["checkout_expires_at"] = now + RESERVATION_WINDOW_SECONDS
                        asyncio.create_task(expire_checkout_reservation(room_id, room["checkout_expires_at"]))

                elif action == "clear_ai_filter":
                    if room.get("ai_chat_filter"):
                        room["ai_chat_filter"] = None
                        room["chat"].append({
                            "name": "AI Stylist", "text": "Filter cleared -- showing everything again.",
                            "ts": time.time(), "is_ai": True,
                        })
                        if len(room["chat"]) > MAX_CHAT_MESSAGES:
                            del room["chat"][:-MAX_CHAT_MESSAGES]

                elif action == "chat":
                    text = (data.get("text") or "").strip()
                    if text:
                        room["chat"].append({"name": name, "text": text, "ts": time.time()})
                        # Same reasoning as activity_log above -- keep the
                        # recent conversation, not an unbounded transcript.
                        if len(room["chat"]) > MAX_CHAT_MESSAGES:
                            del room["chat"][:-MAX_CHAT_MESSAGES]

                        # "Hey AI, ..." -- see parse_ai_chat_intent()'s docstring
                        # for why this is a keyword parser, not an LLM call.
                        # Always posts a reply if the trigger fired at all, even
                        # when nothing was recognised -- a silent non-response
                        # to something clearly addressed at "AI" would read as
                        # broken, not as "didn't match anything."
                        intent = parse_ai_chat_intent(text)
                        if intent is not None:
                            if intent == "clear":
                                room["ai_chat_filter"] = None
                                reply = "Filter cleared -- showing everything again."
                            elif intent == {}:
                                reply = "Didn't catch a specific ask there -- try \"something cheaper\", \"more festive\", or a color like \"less black\"."
                            else:
                                intent["requested_by"] = name
                                room["ai_chat_filter"] = intent
                                reply = f"Got it -- {intent['summary']}."
                            room["chat"].append({
                                "name": "AI Stylist", "text": reply, "ts": time.time(),
                                "is_ai": True,
                            })
                            if len(room["chat"]) > MAX_CHAT_MESSAGES:
                                del room["chat"][:-MAX_CHAT_MESSAGES]
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
                                    "ts": time.time(),
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

                elif action == "voice_recording_start":
                    voice_recording_status.setdefault(room_id, {})[client_id] = time.time()
                    await broadcast_typing(room_id)
                    continue

                elif action == "voice_recording_stop":
                    voice_recording_status.get(room_id, {}).pop(client_id, None)
                    await broadcast_typing(room_id)
                    continue

                elif action == "considering_item_start":
                    item_name = (data.get("item_name") or "an item").strip()
                    item_id = data.get("item_id")
                    considering_status.setdefault(room_id, {})[client_id] = (time.time(), item_name, item_id)
                    await broadcast_typing(room_id)
                    continue

                elif action == "considering_item_stop":
                    considering_status.get(room_id, {}).pop(client_id, None)
                    await broadcast_typing(room_id)
                    continue

                elif action == "dismiss_recommendation":
                    item_id = data.get("item_id")
                    if item_id and item_id not in room.setdefault("dismissed_recommendations", []):
                        room["dismissed_recommendations"].append(item_id)
                    event = {"name": name, "verb": "dismissed a suggested add-on"}

                await broadcast_state(room_id, event=event)

            except Exception as e:
                # Anything else -- a KeyError from an unexpected payload
                # shape, a bad value in an otherwise-valid JSON message,
                # whatever a stranger's browser or a stray extension sends.
                # Logged so a real bug is still visible in the server logs,
                # but it costs this one connection nothing: the loop just
                # goes back to waiting for the next message.
                print(f"[ws] ignored bad message from {client_id} in {room_id}: {e!r}")
                continue

    except (WebSocketDisconnect, RuntimeError):
        manager.disconnect(room_id, client_id)
        rooms[room_id]["members"].pop(client_id, None)
        rooms[room_id]["member_last_seen"][client_id] = time.time()
        # A disconnecting client can't send "typing_stop" or
        # "voice_recording_stop" -- clear both here too, or their indicator
        # would linger for everyone else until the timeout quietly expires it.
        typing_cleared = typing_status.get(room_id, {}).pop(client_id, None) is not None
        recording_cleared = voice_recording_status.get(room_id, {}).pop(client_id, None) is not None
        considering_cleared = considering_status.get(room_id, {}).pop(client_id, None) is not None
        if typing_cleared or recording_cleared or considering_cleared:
            await broadcast_typing(room_id)
        await broadcast_state(room_id)


app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(str(FRONTEND_DIR / "index.html"))