import json
import shutil
from collections import Counter
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CATALOG = BASE_DIR / "catalog.json"
BACKUP = BASE_DIR / "catalog.json.backup"

# The only tags the recommender understands. Anything outside this set gets
# no occasion match and no season match, ever.
KNOWN_TAGS = {
    "ethnic", "western", "floral", "solid", "party",
    "office", "beach", "monsoon", "beauty", "home",
}

# Same item, two spellings. Keep the hyphenated form (majority) and fold
# Makeup into Beauty -- nothing in the app ever distinguishes them.
CATEGORY_MERGES = {
    "Coord": "Co-ord",
    "Makeup": "Beauty",
}

# Straight tag renames, where the category doesn't change the answer.
TAG_MERGES = {
    "glam": "beauty",     # eyeshadow palette
    "tools": "beauty",    # eyelash curler
    "boho": "floral",     # tiered boho maxi skirt -- reads floral/festive
    "decor": "home",      # table lamp, hand towels
    "bath": "home",       # bath towel
    "formal": "office",   # vest+trouser co-ord, slingback heels, pumps
    "casual": "western",  # canvas high-tops
    "winter": "western",  # thick-sole ankle boots
}

# Tags whose correct mapping depends on what the item actually is.
def contextual_tag(item):
    tag = item.get("tag")
    category = item.get("category")
    if tag == "everyday":
        # Mascara/gloss/blush are beauty; flats and sandals are everyday
        # western wear. Same word, two different meanings.
        return "beauty" if category in ("Beauty", "Makeup") else "western"
    return None


def main():
    if not CATALOG.exists():
        print(f"Can't find {CATALOG} -- run this from inside backend/.")
        return

    items = json.loads(CATALOG.read_text(encoding="utf-8"))
    shutil.copy(CATALOG, BACKUP)
    print(f"Backed up {len(items)} items to {BACKUP.name}\n")

    cat_changes, tag_changes = [], []

    for item in items:
        old_cat = item.get("category")
        if old_cat in CATEGORY_MERGES:
            item["category"] = CATEGORY_MERGES[old_cat]
            cat_changes.append((item["id"], old_cat, item["category"]))

        old_tag = item.get("tag")
        new_tag = contextual_tag(item) or TAG_MERGES.get(old_tag)
        if new_tag and new_tag != old_tag:
            item["tag"] = new_tag
            tag_changes.append((item["id"], old_tag, new_tag, item["category"]))

    print(f"=== CATEGORY MERGES ({len(cat_changes)}) ===")
    for pid, a, b in cat_changes:
        print(f"  {pid:5} {a:8} -> {b}")
    if not cat_changes:
        print("  (none -- already normalised)")

    print(f"\n=== TAG REMAPS ({len(tag_changes)}) ===")
    for pid, a, b, cat in tag_changes:
        print(f"  {pid:5} {a:9} -> {b:8}  ({cat})")
    if not tag_changes:
        print("  (none -- already normalised)")

    leftover = sorted({i["tag"] for i in items} - KNOWN_TAGS)
    print("\n=== VERIFY ===")
    print(f"  categories now: {', '.join(sorted({i['category'] for i in items}))}")
    print(f"  tags now:       {', '.join(sorted({i['tag'] for i in items}))}")
    if leftover:
        print(f"  !! STILL UNKNOWN: {', '.join(leftover)} -- these won't match any occasion or season")
    else:
        print("  ✓ every tag is one the recommender understands")

    counts = Counter(i["tag"] for i in items)
    singletons = [t for t, n in counts.items() if n == 1]
    if singletons:
        print(f"  !! singleton tags (a vote on these teaches nothing): {', '.join(singletons)}")
    else:
        print("  ✓ no singleton tags -- every vote transfers to at least one other item")

    CATALOG.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {len(items)} items back to {CATALOG.name}.")
    print("Restart uvicorn to pick it up (the catalog is read once at startup).")


if __name__ == "__main__":
    main()