"""
The 'AI coordinator' for a shared shopping room.

Signals it uses:
  1. Live swipe data (reactions, budget) -- as before.
  2. The trip/occasion date ("when"), mapped to an India-specific season
     via a plain month lookup -- no weather API, no key, nothing that can
     fail mid-demo. If you want *real* live weather later, Open-Meteo
     (open-meteo.com) is free and keyless, so it's a clean drop-in for v2
     -- good roadmap-slide line, not worth the live-demo risk tonight.

NEW: score_feed() -- a real multi-stage recommender, replacing the old
"just filter by occasion tag" ordering with something that actually adapts
to what the squad votes on, while staying a plain scoring function (no LLM
call in this loop -- see the module-level note above score_feed for why).
"""

import random
from collections import Counter
from datetime import datetime

# month -> (human label, tags this time of year favours in India)
INDIA_SEASON_TAGS = {
    1:  ("wedding season", ["ethnic", "office"]),
    2:  ("wedding season", ["ethnic", "office"]),
    3:  ("summer", ["western", "beach"]),
    4:  ("summer", ["western", "beach"]),
    5:  ("summer", ["western", "beach"]),
    6:  ("monsoon", ["monsoon", "solid"]),
    7:  ("monsoon", ["monsoon", "solid"]),
    8:  ("monsoon", ["monsoon", "solid"]),
    9:  ("festive lead-in", ["ethnic", "floral"]),
    10: ("festive season", ["ethnic", "floral"]),
    11: ("festive & wedding season", ["ethnic", "floral"]),
    12: ("wedding season", ["ethnic", "office"]),
}


def season_hint(when: str):
    if not when:
        return None
    try:
        dt = datetime.fromisoformat(when)
    except ValueError:
        return None
    label, tags = INDIA_SEASON_TAGS.get(dt.month, (None, []))
    if not label:
        return None
    return {"label": label, "tags": tags}


# Mirrors frontend/app.js's KEYWORD_TAG_RULES -- kept in sync manually. Used here
# specifically to auto-tag a cart item to the itinerary function it was found under,
# the moment it hits consensus, so checkout doesn't ask the squad to redo work
# they already did while shopping.
KEYWORD_TAG_RULES = [
    (["mehendi", "mehndi", "haldi", "sangeet"], ["floral", "ethnic"]),
    (["shaadi", "wedding", "vivah", "marriage"], ["ethnic"]),
    (["reception"], ["party", "ethnic"]),
    (["festive", "diwali", "puja", "navratri", "function"], ["ethnic", "floral"]),
    (["beach", "vacation", "trip", "holiday", "goa", "pool", "island"], ["beach", "western"]),
    (["office", "work", "meeting", "interview"], ["office", "solid"]),
    (["party", "club", "night out", "date night", "date", "clubbing"], ["party", "western"]),
    (["cafe", "brunch", "casual", "hangout", "coffee", "shopping"], ["western", "solid"]),
    (["monsoon", "rain", "rainy"], ["monsoon", "solid"]),
]

# Mirrors frontend/app.js's OCCASION_TAGS -- kept in sync manually, same reasoning
# as KEYWORD_TAG_RULES above. Used by score_feed() as the baseline preference for
# every member (see Stage 1 below), and by the roulette picker to bias toward tags
# the squad's occasion already favours, without hard-filtering to only those tags.
OCCASION_TAGS = {
    "Birthday": ["ethnic", "party", "floral", "beauty"],
    "Anniversary": ["ethnic", "party", "beauty"],
    "Wedding / Festive Function": ["ethnic", "floral"],
    "Farewell / Graduation": ["western", "office"],
    "Beach / Vacation Trip": ["beach", "western"],
    "Office / Work": ["office", "solid"],
    "Casual Everyday": ["western", "solid"],
    "Monsoon Errands": ["monsoon", "solid"],
}


def infer_tags_for_function(name: str):
    lower = name.lower()
    for keywords, tags in KEYWORD_TAG_RULES:
        if any(k in lower for k in keywords):
            return tags
    return None


def infer_function_for_item(item: dict, itinerary: list):
    """First itinerary function (in the order the squad typed them) whose
    inferred tags include this item's tag. A best-guess default, not a lock --
    the checkout screen's tag chips stay fully editable if the guess is wrong."""
    for fn in itinerary:
        tags = infer_tags_for_function(fn)
        if tags and item.get("tag") in tags:
            return fn
    return None


# ---------------------------------------------------------------------------
# Recommendation engine
# ---------------------------------------------------------------------------
# Deliberately a plain scoring function, not an LLM call -- an LLM call takes
# a few hundred ms on a GPU, and this function runs on every single vote (the
# feed re-ranks live as the squad swipes). At real scale that's hundreds of
# model calls per session: too slow to feel responsive on a swipe, and far
# more expensive than a normal ranking pass. A scoring function like this can
# rank the whole 40-item catalog in well under a millisecond, with no GPU.
# Any real LLM use belongs *outside* this loop -- e.g. tagging the catalog
# overnight in the background, or turning a one-off typed note like "too
# shiny" into a filter -- never sitting in the path of a live vote.
#
# Three stages, matching the actual answer given to the judges:
#   1. Hard filter   -- an item whose price alone blows the squad's whole
#                        budget can never outrank something affordable.
#   2. Per-member     -- each member's own likes/passes *this session* build
#      candidates        a personal tag preference. Never another member's
#                        votes -- nobody's taste feeds into anyone else's.
#   3. Least misery   -- the final score for an item is the MINIMUM across
#                        all members, not the average. Averaging blends
#                        different tastes into something nobody actually
#                        wants; least-misery favours items nobody strongly
#                        dislikes instead of erasing anyone's preference.
# Before anyone's voted on anything, every member's score collapses to the
# same occasion/season baseline -- so a brand new squad still gets a
# sensibly-ordered feed from the very first render, not a random one.

# Persistent (cross-session) taste counts toward a member's score at a much
# lower weight than what they've actually voted on THIS session. Reasoning:
# a squad's current occasion and this session's real votes are direct, fresh
# signal about what's wanted right now; a persistent profile is a prior built
# from past sessions that may have had a completely different occasion. It
# should nudge, not override -- e.g. someone who's historically liked
# 'western' shouldn't have that outrank a squad's actual live votes toward
# 'ethnic' for a wedding happening right now.
PERSISTENT_PROFILE_WEIGHT = 0.35


def score_feed(room: dict, catalog: list, persistent_profiles: dict | None = None) -> dict:
    """
    persistent_profiles: optional {client_id: {tag: score}} -- each member's
    cross-session taste profile (from backend/users.json, via whatever email
    they logged in with). Pass {} or None for a room with no logged-in
    members yet; every member's score then collapses to just the session-
    scoped signal, same as before this parameter existed.
    """
    persistent_profiles = persistent_profiles or {}
    catalog_by_id = {i["id"]: i for i in catalog}
    reactions = room.get("reactions", {})
    occasion = room.get("occasion")
    budget = room.get("budget", 0)
    season = season_hint(room.get("when", ""))

    baseline_tags = set(OCCASION_TAGS.get(occasion, []))
    if season:
        baseline_tags |= set(season["tags"])

    # Prefer "participants" (everyone who's ever joined, survives a
    # temporary disconnect) over "members" (only currently-connected
    # sockets) -- we don't want the ranking to shift just because someone's
    # wifi blipped for a second.
    member_ids = list(room.get("participants", {}).keys()) or list(room.get("members", {}).keys())

    # Stage 2: each member's own tag preference, built only from their own
    # votes on items seen so far this session.
    member_tag_pref: dict = {m: Counter() for m in member_ids}
    for item_id, votes in reactions.items():
        item = catalog_by_id.get(item_id)
        if not item:
            continue
        for member_id, vote in votes.items():
            if member_id not in member_tag_pref:
                continue
            member_tag_pref[member_id][item["tag"]] += 1.0 if vote == "like" else -0.5

    def base_score(item: dict) -> float:
        score = 1.0 if item["tag"] in baseline_tags else 0.0
        # Small tiebreak nudge so, among equally-relevant items, a better
        # rated one edges ahead -- never enough to override an actual tag match.
        score += (item.get("rating", 4.0) - 4.0) * 0.5
        return score

    scores: dict = {}
    for item in catalog:
        # Stage 1: hard filter -- can't ever be afforded solo, so it should
        # never outrank something the squad can genuinely buy.
        if budget and item["price"] > budget:
            scores[item["id"]] = -999.0
            continue

        if not member_ids:
            scores[item["id"]] = base_score(item)
            continue

        per_member_scores = []
        for m in member_ids:
            score = base_score(item) + member_tag_pref[m].get(item["tag"], 0.0)
            score += PERSISTENT_PROFILE_WEIGHT * persistent_profiles.get(m, {}).get(item["tag"], 0.0)
            per_member_scores.append(score)
        # Stage 3: least misery.
        scores[item["id"]] = min(per_member_scores)

    return scores


def pick_surprise_items(room: dict, catalog: list, n: int = 5) -> list:
    """"Surprise Us" roulette pick. Picks up to n items nobody's voted on yet,
    that fit within whatever's left of the budget -- biased toward the season/
    occasion tags already driving the rest of the shelf, but genuinely
    randomized (a weighted shuffle, not a ranked top-N) so it doesn't just
    hand back "the best 5 items" every single spin. That would defeat the
    point of a roulette.

    Deliberately excludes anything with an existing vote or already in the
    cart -- the feature is meant to surface fresh shelf items the squad
    hasn't looked at, not re-litigate ones they have."""
    reacted_ids = set(room.get("reactions", {}).keys())
    cart_ids = set(room.get("cart", []))
    catalog_by_id = {i["id"]: i for i in catalog}

    budget = room.get("budget", 0)
    cart_total = sum(catalog_by_id[i]["price"] for i in cart_ids if i in catalog_by_id)
    remaining = (budget - cart_total) if budget else None  # None = no budget constraint at all

    candidates = [i for i in catalog if i["id"] not in reacted_ids and i["id"] not in cart_ids]
    if not candidates or (remaining is not None and remaining <= 0):
        return []

    season = season_hint(room.get("when", ""))
    preferred_tags = set(season["tags"]) if season else set()
    preferred_tags |= set(OCCASION_TAGS.get(room.get("occasion"), []))

    # Weighted shuffle: on-tag items get a second entry in the draw pool, so
    # they're more likely to come up first without ever fully excluding an
    # off-tag surprise -- the whole point is that it's not just "top 5 best fit".
    weighted = []
    for item in candidates:
        weighted.append(item)
        if item["tag"] in preferred_tags:
            weighted.append(item)
    random.shuffle(weighted)

    picked, seen_ids, running_total = [], set(), 0.0
    for item in weighted:
        if item["id"] in seen_ids:
            continue
        if remaining is not None and (running_total + item["price"]) > remaining:
            continue
        picked.append(item)
        seen_ids.add(item["id"])
        running_total += item["price"]
        if len(picked) >= n:
            break

    return picked


def reasoned_tie_break(item: dict, room: dict, catalog: list) -> tuple:
    """Replaces a coin-flip with an actual, data-grounded verdict -- rule-based
    by design, so it never depends on an external API mid-demo. If you want a
    real LLM call layered on top later, this function's return shape (decision,
    verdict text) is exactly what that call should also produce, with this as
    the fallback if the call times out or errors."""
    reasons_for, reasons_against = [], []

    season = season_hint(room.get("when", ""))
    if season:
        if item["tag"] in season["tags"]:
            reasons_for.append(f"it fits {season['label']} well")
        else:
            reasons_against.append(f"{season['label']} usually favours {'/'.join(season['tags'])}, not '{item['tag']}'")

    if item.get("rating", 0) >= 4.4:
        reasons_for.append(f"it's rated {item['rating']}★, one of the stronger picks in the feed")

    discount = round((1 - item["price"] / item["mrp"]) * 100) if item.get("mrp") else 0
    if discount >= 40:
        reasons_for.append(f"it's {discount}% off right now")

    budget = room.get("budget", 0)
    catalog_by_id = {i["id"]: i for i in catalog}
    cart_total = sum(catalog_by_id[i]["price"] for i in room.get("cart", []) if i in catalog_by_id)
    if budget and (cart_total + item["price"]) > budget:
        over = (cart_total + item["price"]) - budget
        reasons_against.append(f"adding it would push the squad ₹{over} over budget")

    add_it = len(reasons_for) >= len(reasons_against) if (reasons_for or reasons_against) else True

    if add_it:
        reason = reasons_for[0] if reasons_for else "no strong reason to skip it came up"
        verdict = f"Added to the cart -- {reason}."
    else:
        reason = reasons_against[0] if reasons_against else "the case against outweighed the case for"
        verdict = f"Left out -- {reason}."

    return add_it, verdict


def get_ai_suggestion(room: dict, catalog: list) -> str:
    reactions = room.get("reactions", {})
    members = room.get("members", {})
    occasion = room.get("occasion") or "your plan"
    budget = room.get("budget", 0)
    season = season_hint(room.get("when", ""))

    if not members:
        return "Waiting for the squad to join..."

    itinerary = room.get("itinerary") or []

    if not reactions:
        if itinerary:
            plan_str = ", ".join(itinerary)
            base = f"Shelf's split into {plan_str} -- each section leads with what's actually relevant to that day."
            if season:
                base += f" {season['label'].capitalize()}-friendly picks are bumped up within each section too."
            return base
        base = f"Planning for {occasion}? Start swiping and I'll spot the pattern as votes come in."
        if season:
            tag_str = " / ".join(season["tags"])
            base = f"{occasion} lands in {season['label']} -- keep an eye out for '{tag_str}' pieces. Start swiping and I'll track where the squad actually lands."
        return base

    catalog_by_id = {item["id"]: item for item in catalog}
    member_count = max(len(members), 1)
    majority = max(2, (member_count // 2) + 1)

    tag_votes = Counter()
    liked_items = []
    contested_names = []
    tie_breaks = room.get("tie_breaks", {})

    for item_id, votes in reactions.items():
        item = catalog_by_id.get(item_id)
        if not item:
            continue
        likes = [v for v in votes.values() if v == "like"]
        for _ in likes:
            tag_votes[item["tag"]] += 1
        if len(likes) >= majority:
            liked_items.append(item)
        elif len(votes) >= 2 and len(set(votes.values())) > 1 and item_id not in tie_breaks:
            contested_names.append(item["name"])

    # Priority order: an unresolved split vote is the most urgent thing to surface.
    # Only ever return ONE sentence -- piling on multiple observations is why it
    # was getting hard to notice anything new.
    if contested_names:
        return f"Split vote on {contested_names[0]} -- tap 'Break the tie' on that card."

    if liked_items:
        total = sum(i["price"] for i in liked_items)
        if budget and total > budget:
            return f"{len(liked_items)} item(s) picked, totalling ₹{total} -- that's ₹{total - budget} over the ₹{budget} budget."
        note = f"{len(liked_items)} item(s) have squad consensus, totalling ₹{total}."
        if budget:
            note += f" ₹{budget - total} left in the budget."
        return note

    if tag_votes:
        top_tag, count = tag_votes.most_common(1)[0]
        if season:
            if top_tag in season["tags"]:
                return f"The squad's leaning '{top_tag}' ({count} votes) -- that fits {season['label']} well."
            return f"The squad's leaning '{top_tag}' ({count} votes), though {season['label']} usually favours {'/'.join(season['tags'])}."
        return f"The squad's leaning '{top_tag}' ({count} votes so far)."

    return "Keep swiping -- I'll flag it the moment a couple of you land on the same item."