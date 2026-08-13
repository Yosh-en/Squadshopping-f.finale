"""
Run this before a demo to make a gift reminder appear immediately, instead
of waiting a full year for a real one to naturally trigger.

WHY THE OLD VERSION NEVER WORKED:
get_reminders() in main.py only ever surfaces a reminder for a squad if
BOTH of these are true:
  1. squad["gift_recipient_relation"] is non-empty (a squad with nobody set
     as a gift target isn't a gift reminder at all -- see the `if not
     squad.get("gift_recipient_relation"): continue` check).
  2. the email/user_id calling GET /api/reminders?email=... appears in
     squad["participant_emails"] (a reminder only ever shows to someone who
     was actually IN that squad -- see get_reminders()'s comment on why).
The old script's fake_squad had neither field at all, so it was silently
filtered out on the very first check, every time -- there was no error,
just nothing ever showing up, which is exactly the confusing "I don't
understand what's wrong" experience this caused.

There's a second wrinkle since the login rewrite: "participant_emails"
doesn't actually hold an email anymore -- it holds the internal user_id
that /api/login assigns the first time you log in as a given name (see
main.py's persistent_profiles_for_room() comment). A hardcoded fake id in
this script would never match the real id your browser is using, so this
script now looks YOUR real user_id up from users.json by name, rather than
guessing one.

USAGE:
    cd backend
    python seed_demo_reminder.py "Yoshi"

The argument must be the EXACT name you are currently logged in as (or have
logged in as before) in the app -- capitalization doesn't matter, but you
do need an existing account for that name in users.json. If you haven't
logged in as that name yet, open the app, log in, then run this.
"""
import json
import sys
from datetime import date, timedelta
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
USERS_FILE = BASE_DIR / "users.json"
SQUADS_FILE = BASE_DIR / "finished_squads.json"


def find_user_id(name: str) -> str | None:
    if not USERS_FILE.exists():
        return None
    users = json.loads(USERS_FILE.read_text(encoding="utf-8"))
    target = name.strip().lower()
    for user_id, record in users.items():
        if record.get("name", "").strip().lower() == target:
            return user_id
    return None


def main():
    if len(sys.argv) < 2:
        print('Usage: python seed_demo_reminder.py "YourExactLoginName"')
        sys.exit(1)

    name = sys.argv[1]
    user_id = find_user_id(name)
    if not user_id:
        print(f"No account found for '{name}'.")
        print("Log in as that exact name in the app first (so users.json has a record for it), then re-run this.")
        sys.exit(1)

    fake_squad = {
        "occasion": "Birthday",
        "when": (date.today() - timedelta(days=365)).isoformat(),  # ~1 year ago
        "members": [name],
        # This is the field get_reminders() actually checks the requesting
        # user against -- without it, the reminder is invisible to everyone,
        # including you. It holds a user_id now, not a real email.
        "participant_emails": [user_id],
        "room_code": "DEMO01",
        # Required -- a squad with no relation set isn't treated as a gift
        # squad at all, and get_reminders() filters it out before it ever
        # looks at the date.
        "gift_recipient_relation": "Friend",
        "gift_recipient_name": "Rhea",
        "gift_owner_email": user_id,
        "bought_items": [
            {"id": "p3", "name": "Anarkali Kurta Set", "tag": "ethnic"},
        ],
        "had_itinerary": False,
        "archived": False,
        "reminded": False,
    }

    existing = json.loads(SQUADS_FILE.read_text(encoding="utf-8")) if SQUADS_FILE.exists() else []
    existing.append(fake_squad)
    SQUADS_FILE.write_text(json.dumps(existing), encoding="utf-8")

    print(f"Seeded a fake finished squad for '{name}' (user_id={user_id}), dated {fake_squad['when']}.")
    print("Reload the home screen while logged in as that name to see the reminder.")


if __name__ == "__main__":
    main()