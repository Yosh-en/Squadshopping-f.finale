"""
Run this once before a demo to make a reminder appear immediately, without
waiting a year for a real one. Only seeds the input -- the date-checking
logic in GET /api/reminders is completely real and untouched.

Usage:
    cd backend
    python3 seed_demo_reminder.py
"""
import json
from datetime import date, timedelta
from pathlib import Path

FILE = Path(__file__).resolve().parent / "finished_squads.json"

fake_squad = {
    "occasion": "Birthday",
    "when": (date.today() - timedelta(days=365)).isoformat(),  # ~1 year ago
    "members": ["Yoshi", "Aishnaa"],
    "room_code": "DEMO01",
}

existing = json.loads(FILE.read_text(encoding="utf-8")) if FILE.exists() else []
existing.append(fake_squad)
FILE.write_text(json.dumps(existing), encoding="utf-8")

print(f"Seeded one fake finished squad dated {fake_squad['when']} -- reload the home screen to see the reminder card.")