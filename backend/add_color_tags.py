"""
Adds a 'color' field to catalog.json, but ONLY where the item's own name or
emoji actually states a color -- not a guess dressed up as data.

Run once, from backend/:
    python add_color_tags.py

Backs up to catalog.json.backup2 first (normalize_catalog.py already used
catalog.json.backup, so this uses a different name and won't clobber it).

WHY THIS EXISTS
---------------
Judge feedback: if two people disagree in chat ("I don't like this, it's too
red"), could the AI take a request like "show me something less red"? The
honest answer required checking one thing first: nothing in this catalog
records color at all. Category, tag, price, rating -- no color. Building a
color filter on top of that would mean inventing a color for 91 items sight
unseen, which is worse than not having the feature.

What IS true: a good chunk of item names already state a color outright
("Dusty Pink Embroidered Sharara Suit", "Burgundy Patent Slingback Pumps"),
and a few emoji are unambiguous color signals (🖤 black, 🤍 white, 💛 yellow).
This script tags exactly those -- nothing else. An item with no color cue in
its own name stays untagged, on purpose: the chat filter below treats
"untagged" as neutral (never wrongly excluded, never wrongly included),
which is the only honest way to handle partial data.

Compound phrases are matched before single words ("rose gold" -> gold, not
"rose" -> pink) so a phrase never gets split into the wrong color.
"""
import json
import shutil
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CATALOG = BASE_DIR / "catalog.json"
BACKUP = BASE_DIR / "catalog.json.backup2"

# Longest/most specific phrases first -- checked in order, first match wins.
# Every one of these was verified against the actual catalog item names
# below, not guessed abstractly.
NAME_COLOR_PHRASES = [
    ("dusty pink", "pink"),
    ("antique gold", "gold"),
    ("gold-plated", "gold"),
    ("gold plated", "gold"),
    ("rose gold", "gold"),
    ("oxidised silver", "silver"),
    ("smoky nude", "nude"),
    ("classic white", "white"),
    ("vintage wash", None),   # explicitly NOT a color claim -- wash varies
    ("burgundy", "burgundy"),
    ("mauve", "mauve"),
    ("rust", "rust"),
    ("nude", "nude"),
    ("steel", "silver"),
    ("brown", "brown"),
    ("white", "white"),
    ("black", "black"),
    ("gold", "gold"),
    ("silver", "silver"),
    ("pink", "pink"),
]

# Emoji -> color, used only when the name itself gave no cue above. Kept
# short and conservative -- only emoji that are unambiguous color signals,
# not ones that merely evoke a mood (💫✨ etc. are excluded on purpose).
# Emoji -> color, used only when the name itself gave no cue above. Kept to
# genuinely unambiguous cases: a "colored heart" emoji (🖤🤍💛🤎💜) IS a color
# statement, nothing else. Flower emoji (🌸🌹) were deliberately excluded --
# they signal FLORAL as a theme, not a specific color; a "Floral Maxi Skirt"
# with a cherry-blossom emoji could just as easily be blue florals, and
# calling it pink on that basis is a guess dressed up as data, exactly what
# this script exists to avoid.
EMOJI_COLOR = {
    "🖤": "black",
    "🤍": "white",
    "💛": "yellow",
    "🤎": "brown",
    "💜": "mauve",
}

# Fabrics/materials that reliably imply a color in casual speech, even
# though the word itself isn't a color name. Kept to genuinely reliable
# cases only -- "denim" is blue the overwhelming majority of the time;
# something like "leather" was deliberately left out (leather comes in too
# many colors to assume).
MATERIAL_COLOR_HINTS = [
    ("denim", "blue"),
]


# Corrections from someone who's actually looked at the product, overriding
# whatever the name/emoji inference below guessed. These exist because the
# emoji signal is genuinely weaker evidence than a color word in the name --
# confirmed here: p51's 🖤 read as "black," but the item is actually a WHITE
# top with thin black pinstripes (black is the accent, not the base color);
# p49's 🤎 read as "brown," but it's actually charcoal/grey-black. Kept as an
# explicit override dict, deliberately NOT folded into the general rules --
# "pinstripe" isn't reliably white in general (navy-with-white-stripe exists
# too), so this is a correction to these two specific items, not a new rule.
MANUAL_OVERRIDES = {
    "p51": "white",     # Pinstripe Puff Sleeve Shrug Top -- white base, black pinstripes
    "p49": "charcoal",  # Pearl Embellished Cutout Top -- charcoal/grey-black, not brown
}


def infer_color(item: dict) -> str | None:
    name_lower = item["name"].lower()

    for phrase, color in NAME_COLOR_PHRASES:
        if phrase in name_lower:
            return color  # may be None (e.g. "vintage wash") -- deliberate no-match

    for phrase, color in MATERIAL_COLOR_HINTS:
        if phrase in name_lower:
            return color

    emoji = item.get("emoji", "")
    if emoji in EMOJI_COLOR:
        return EMOJI_COLOR[emoji]

    return None


def main():
    if not CATALOG.exists():
        print(f"Can't find {CATALOG} -- run this from inside backend/.")
        return

    items = json.loads(CATALOG.read_text(encoding="utf-8"))
    shutil.copy(CATALOG, BACKUP)
    print(f"Backed up {len(items)} items to {BACKUP.name}\n")

    tagged, untagged = [], []
    for item in items:
        color = MANUAL_OVERRIDES.get(item["id"]) or infer_color(item)
        if color:
            item["color"] = color
            tag_source = "manual correction" if item["id"] in MANUAL_OVERRIDES else "inferred"
            tagged.append((item["id"], item["name"], color, tag_source))
        else:
            untagged.append((item["id"], item["name"]))

    print(f"=== TAGGED ({len(tagged)} items) -- review these ===")
    for pid, name, color, source in tagged:
        marker = " *" if source == "manual correction" else "  "
        print(f"  {pid:5} {color:8}{marker}{name}")
    print("  (* = manual correction from someone who's seen the real product)")

    print(f"\n=== LEFT UNTAGGED ({len(untagged)} items, no color stated) ===")
    print("  (these are never wrongly matched OR wrongly excluded by a color filter)")
    for pid, name in untagged[:10]:
        print(f"  {pid:5} {name}")
    if len(untagged) > 10:
        print(f"  ... and {len(untagged) - 10} more")

    CATALOG.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {len(items)} items back to {CATALOG.name}.")
    print("Restart uvicorn to pick it up.")


if __name__ == "__main__":
    main()