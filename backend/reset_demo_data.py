"""Wipe demo/test data so the app starts clean. Run from backend/:  python reset.py"""
import json, shutil
from pathlib import Path
BASE = Path(__file__).resolve().parent
for name in ["finished_squads.json", "rooms_state.json"]:
    p = BASE / name
    if p.exists():
        shutil.copy(p, p.with_suffix(p.suffix + ".bak"))
        p.write_text("[]" if name == "finished_squads.json" else "{}", encoding="utf-8")
        print(f"cleared {name} (backup: {name}.bak)")
    else:
        print(f"(skip) {name} not found")
print("Done. Now RESTART uvicorn, then hard-refresh the browser.")