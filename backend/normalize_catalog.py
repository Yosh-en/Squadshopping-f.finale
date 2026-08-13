"""
One-off catalog cleanup. Run once, from backend/:

    python normalize_catalog.py

Writes catalog.json.backup first, then rewrites catalog.json in place and
prints exactly what changed. Safe to re-run -- it's idempotent (a second run
reports zero changes).

WHY THIS EXISTS
---------------
Two kinds of drift crept in as the catalog grew past ~p70.

1. DUPLICATE CATEGORY SPELLINGS. "Co-ord" and "Coord" are the same thing, as
   are "Beauty" and "Makeup". Every occasion table then has to list both
   spellings or silently drop items -- which is why the weight tables ended
   up with defensive double entries. One spelling means one entry.

2. ORPHAN TAGS. The recommender only understands ten tags (ethnic, western,
   floral, solid, party, office, beach, monsoon, beauty, home). Nine more
   appeared in the catalog -- glam, boho, everyday, tools, formal, decor,
   winter, casual, bath -- and none of them appear in OCCASION_TAGS or in the
   season table. 23 of 91 items could therefore never match an occasion or a
   season, no matter what.

   Worse for the live-learning story: six of those tags are on exactly ONE
   item each. member_tag_pref learns per tag, so a like on the eyelash curler
   ('tools') taught the recommender nothing, because no other item shared the
   tag. That's the flagship "it learns as you swipe" feature quietly doing
   nothing on a quarter of the shelf.

Mapping is per-item where the right answer depends on the category -- e.g.
'everyday' means 'beauty' on a mascara and 'western' on a pair of flats.
"""
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