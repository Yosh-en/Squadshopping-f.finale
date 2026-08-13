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

NEW: vote_status() -- a single shared definition of what an item's vote
state actually means once a squad might be 3-5 people, not just 2. See its
docstring for the reasoning; get_ai_suggestion() and main.py's
compute_catchup()/react handler all defer to this instead of each
reimplementing (and, previously, mis-implementing) their own tie check.
"""

import random
import time
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

# Mirrors frontend/app.js's OCCASION_TAGS -- kept in sync manually, same
# reasoning as KEYWORD_TAG_RULES above. Used by score_feed() as the baseline preference for
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
#
# NOTE on squad size: least-misery aggregation (a strict min() across every
# member) scales correctly to 5 people, but the more people in the room, the
# more likely one picky member's low score alone suppresses an item for
# everyone -- that's an inherent tradeoff of least-misery, not a bug. If a
# judge asks "does this get worse with bigger squads," the honest answer is
# "somewhat, yes" -- a percentile-based floor (e.g. 20th-percentile-worst
# instead of strict min) would soften that for squads above some size. Not
# built here on purpose -- flagging it as a known, explainable tradeoff is
# the right amount of engineering for a hackathon demo, not the fix itself.

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


def tie_break_advice(item: dict, room: dict, catalog: list) -> dict:
    """A clear recommendation -- yes or no -- with the single strongest reason
    behind it. Advice, still not a verdict: it never touches the cart.

    Shape history, because it's been through two rounds of feedback:
      1. Originally reasoned_tie_break(), which DECIDED (added/removed the
         item itself). Killed by feedback: an AI overriding a deadlocked human
         vote is the one thing this product otherwise promises not to do.
      2. Then a for/against panel listing every signal both ways. Also killed
         by feedback, for the opposite reason -- a two-column pros-and-cons
         table on a phone-sized card is homework, not help. Nobody wants to
         adjudicate a list; they want a straight answer.
    So: keep the decisive SHAPE of (1) -- a plain yes or no, like the old
    added/skipped -- with the non-binding AUTHORITY of (2). The AI says what
    it would do and why in one line; the squad's votes remain the only thing
    that can actually move the item.

    Returns {"verdict": "yes"|"no", "headline": str, "reason": str}.
    """
    reasons_for, reasons_against = [], []

    # The squad's own votes lead -- they're the most relevant evidence there
    # is, and citing them is what makes this read as "here's your situation"
    # rather than a generic product blurb.
    votes = room.get("reactions", {}).get(item["id"], {})
    likes = sum(1 for v in votes.values() if v == "like")
    passes = sum(1 for v in votes.values() if v == "pass")
    if likes or passes:
        if passes == 0:
            reasons_for.append(f"every vote on it so far was a like ({likes})")
        elif likes > passes * 2:
            reasons_for.append(f"most of the squad's behind it ({likes} liked vs {passes} passed)")
        elif passes > likes * 2:
            reasons_against.append(f"most of the squad isn't behind it ({passes} passed vs {likes} liked)")
        elif likes > passes:
            reasons_for.append(f"slightly more of you liked it ({likes}-{passes})")
        elif passes > likes:
            reasons_against.append(f"slightly more of you passed on it ({passes}-{likes})")
        # An exact even split is deliberately NOT added as a reason either
        # way -- "you're evenly split" is the thing they already know and the
        # reason they're asking. Saying it back is what made the old panel
        # feel like it was dodging the question.

    season = season_hint(room.get("when", ""))
    if season:
        if item["tag"] in season["tags"]:
            reasons_for.append(f"it fits {season['label']} well")
        else:
            reasons_against.append(f"{season['label']} usually favours {'/'.join(season['tags'])}")

    if item.get("rating", 0) >= 4.4:
        reasons_for.append(f"it's one of the better-rated pieces here ({item['rating']}\u2605)")

    discount = round((1 - item["price"] / item["mrp"]) * 100) if item.get("mrp") else 0
    if discount >= 40:
        reasons_for.append(f"it's {discount}% off right now")

    budget = room.get("budget", 0)
    catalog_by_id = {i["id"]: i for i in catalog}
    cart_total = sum(catalog_by_id[i]["price"] for i in room.get("cart", []) if i in catalog_by_id)
    already_in_cart = item["id"] in room.get("cart", [])
    over_budget = False
    if budget and not already_in_cart:
        projected = cart_total + item["price"]
        if projected > budget:
            over_budget = True
            reasons_against.append(f"it'd put you \u20b9{projected - budget} over budget")
        else:
            reasons_for.append(f"it still leaves \u20b9{budget - projected} in the budget")

    # Always lands on yes or no -- same as the original added/skipped
    # behaviour.
    #
    # Budget is a VETO, not just one signal among many. score_feed()'s Stage 1
    # already treats the squad's budget as a hard filter, so it would be
    # incoherent for the advisor to recommend adding something that breaks it
    # just because three softer signals (rating, discount, season) happened to
    # outnumber it. The squad set that number; the AI doesn't get to outvote
    # it either.
    if over_budget:
        verdict = "no"
    elif len(reasons_for) > len(reasons_against):
        verdict = "yes"
    elif len(reasons_against) > len(reasons_for):
        verdict = "no"
    else:
        # Genuine tie on reason count -- let a strong rating carry it.
        verdict = "yes" if item.get("rating", 0) >= 4.2 else "no"

    if verdict == "yes":
        reason = reasons_for[0] if reasons_for else "nothing about it stands out as a problem"
        headline = "Yeah, I'd keep it."
    else:
        # Lead with the budget when that's what settled it -- burying the
        # actual deciding factor behind a softer one would be misleading.
        if over_budget:
            reason = next((r for r in reasons_against if "over budget" in r), reasons_against[0])
        else:
            reason = reasons_against[0] if reasons_against else "nothing about it stands out as a must-have"
        headline = "I'd let this one go."

    return {
        "verdict": verdict,
        "headline": headline,
        "reason": reason,
        "ts": time.time(),
    }


def vote_status(votes: dict, participant_count: int) -> str:
    """Classifies a single item's vote state relative to majority, aware of
    how many participants COULD still vote -- not just how many already
    have. Returns one of: "consensus_like", "contested_consensus",
    "rejected", "deadlocked", "in_progress", "unvoted".

    Mirrors frontend/app.js's computeVoteStatus() -- kept in sync manually,
    same reasoning as KEYWORD_TAG_RULES/OCCASION_TAGS above.

    This replaces the old "any 2 conflicting votes = tied" check that used
    to live inline in get_ai_suggestion() and main.py's compute_catchup().
    That read was fine for a 2-person squad -- with nobody else who could
    ever vote, any disagreement really was a permanent deadlock. But for a
    3-5 person squad, 2 people disagreeing while the rest haven't voted yet
    is just an in-progress read, not a real stall -- flagging it as a "tie"
    would nag the squad into a coin-flip constantly instead of letting the
    remaining votes actually settle it.

    "deadlocked" now only fires once EVERY participant has voted and it's an
    exact 50/50 split -- which, by the math, is only even possible for an
    even-sized squad. Odd-sized squads can never truly deadlock once
    everyone's in: they either clear majority or they don't, cleanly.

    "contested_consensus" vs "consensus_like": once majority is reached, no
    further single vote can arithmetically undo it (4 likes of 6 stays 4
    likes of 6 no matter what the last two do). Recording a late dissent and
    then doing nothing with it would make that person's vote decorative --
    they'd be asked for input that provably cannot matter. So a carted item
    carrying any pass at all is reported as CONTESTED rather than settled:
    the item stays in the cart (majority rules -- one late objector should
    never get a unilateral veto over four other people), but the squad gets
    an explicit "settle the objection" path that re-runs the real
    tie-breaker, which genuinely can remove it. That makes a late vote
    consequential without making it dictatorial. Deliberately not
    auto-resolved -- same reasoning as the quiet-member nudge below: surface
    it, let the squad decide.
    """
    likes = sum(1 for v in votes.values() if v == "like")
    passes = sum(1 for v in votes.values() if v == "pass")
    voted = likes + passes
    remaining = max(0, participant_count - voted)
    majority = 1 if participant_count <= 1 else max(2, (participant_count // 2) + 1)

    if likes >= majority:
        return "contested_consensus" if passes > 0 else "consensus_like"
    # ORDER MATTERS: the deadlock check MUST come before the "rejected"
    # check below. An exact 50/50 split also, by definition, cannot reach
    # majority -- so if "rejected" is tested first it swallows every real
    # tie, including the ordinary 1-1 split in a 2-person squad, and the
    # tie-breaker silently never gets offered to anyone. (Learned the hard
    # way: reversing these two lines breaks the flagship tie-break feature
    # for the most common squad size, with no error message anywhere.)
    if remaining == 0 and likes == passes and likes > 0:
        return "deadlocked"
    if likes + remaining < majority:
        # Even if every remaining participant liked it, it still couldn't
        # reach majority -- effectively rejected, not a stall.
        return "rejected"
    if voted > 0:
        return "in_progress"
    return "unvoted"


def get_ai_suggestion(room: dict, catalog: list, viewer_client_id: str | None = None) -> str:
    """Returns the coordinator's one-line note for a SPECIFIC viewer.

    viewer_client_id matters because several of these notes are about a
    person, and a single shared string can only ever talk about people in the
    third person. That produced a real bug: the "hasn't voted in a bit" nudge
    was computed once and broadcast to everyone, so Aishnaa's own screen told
    her "Aishnaa hasn't voted" -- informing her of something she already knew
    while nobody's screen actually told THEM to act. Notes about the viewer
    are now addressed to them directly, and the viewer is checked first, so
    your own screen nags you before it points at anyone else.

    Returns "" when there's genuinely nothing worth saying. The bar hides
    itself on an empty string rather than filling space with an observation
    the person can already read off the screen -- the occasion is in the
    header, the squad size is in the members row, so restating either is
    noise competing with the shelf for attention.
    """
    reactions = room.get("reactions", {})
    members = room.get("members", {})
    occasion = room.get("occasion") or "your plan"
    budget = room.get("budget", 0)
    season = season_hint(room.get("when", ""))

    if not members:
        return ""

    itinerary = room.get("itinerary") or []

    if not reactions:
        # Nothing's been voted on yet, so there is no squad signal to report.
        # The one thing here that ISN'T already visible on screen is why the
        # shelf is ordered the way it is -- worth a line only when the
        # ordering is actually non-obvious (a multi-day itinerary split, or a
        # season skew). Otherwise: silence.
        if itinerary:
            plan_str = ", ".join(itinerary)
            base = f"Shelf's split into {plan_str} -- each section leads with what's relevant to that day."
            if season:
                base += f" {season['label'].capitalize()}-friendly picks are bumped up within each section."
            return base
        if season:
            tag_str = " / ".join(season["tags"])
            return f"{occasion} lands in {season['label']} -- '{tag_str}' pieces are bumped up."
        return ""

    catalog_by_id = {item["id"]: item for item in catalog}
    # participants (survives a disconnect), not members (live sockets only)
    # -- the bar for consensus, and what counts as a genuine deadlock,
    # shouldn't shift just because someone's wifi blipped for a second.
    participants = room.get("participants") or members
    participant_count = max(len(participants), 1)
    majority = 1 if participant_count <= 1 else max(2, (participant_count // 2) + 1)

    tag_votes = Counter()
    liked_items = []
    contested = []  # (name, item_id) pairs, not just names -- need the id to check staleness
    # Carted-on-majority items that someone has since voted against. Kept
    # separate from `contested` (a true 50/50 deadlock) because the two need
    # different wording and a different urgency -- see vote_status().
    objected = []
    # Advice already given on an item, keyed by item id. Note this never
    # RESOLVES anything (unlike the old tie_breaks lock it replaced), so an
    # advised item stays contested until the squad actually changes a vote --
    # the note copy below just stops nagging them to ask twice.
    tie_advice = room.get("tie_advice", {})

    for item_id, votes in reactions.items():
        item = catalog_by_id.get(item_id)
        if not item:
            continue
        likes = [v for v in votes.values() if v == "like"]
        for _ in likes:
            tag_votes[item["tag"]] += 1
        status = vote_status(votes, participant_count)
        if len(likes) >= majority:
            liked_items.append(item)
            if status == "contested_consensus":
                passes = sum(1 for v in votes.values() if v == "pass")
                objected.append((item["name"], item_id, len(likes), passes))
        elif status == "deadlocked":
            contested.append((item["name"], item_id))

    activity_log = room.get("activity_log", [])
    now = time.time()

    def last_vote_ts(item_id=None, client_id=None):
        """Most recent react timestamp matching the given filters, or 0 if
        there's no matching activity at all -- reuses activity_log (already
        recorded for catch-up banners) instead of needing new state just for
        this."""
        matches = [
            e["ts"] for e in activity_log
            if e["type"] == "react"
            and (item_id is None or e["item_id"] == item_id)
            and (client_id is None or e["client_id"] == client_id)
        ]
        return max(matches) if matches else 0

    # Priority order: an unresolved split vote is the most urgent thing to
    # surface. Only ever return ONE sentence -- piling on multiple
    # observations is why it was getting hard to notice anything new.
    if contested:
        name, item_id = contested[0]
        # Kept to one short line. The popup carries the full explanation and
        # the AI's read; this bar only needs to still be true after the popup
        # has been closed, and to point at the way back in.
        return f"Split on {name} -- tap 'Break the tie' on that card."

    # Someone voted against something already in the cart. It stays there
    # (majority rules), but saying so plainly is the whole point -- otherwise
    # that person's vote is invisible to everyone else and they'd have no
    # reason to believe it registered at all.
    if objected:
        name, item_id, likes_n, passes_n = objected[0]
        return f"{name}'s in on a {likes_n}-{passes_n} majority -- not everyone agrees."

    # Nobody's stuck on a tie -- but is anyone stuck on *nothing*? Checked
    # in two passes, viewer first: telling you that YOU are the holdup is
    # actionable, whereas being told someone else is the holdup is at best
    # a prompt to go nudge them. Previously only the second pass existed and
    # its result went to everyone, so the one person who could actually fix
    # it was the only one not being asked to.
    MEMBER_QUIET_SECONDS = 45

    def pending_for(client_id: str) -> int:
        count = 0
        for item_id, votes in reactions.items():
            if item_id in room.get("cart", []) or item_id in tie_advice:
                continue
            if votes and client_id not in votes:
                count += 1
        return count

    if viewer_client_id and viewer_client_id in participants:
        my_pending = pending_for(viewer_client_id)
        if my_pending:
            if my_pending == 1:
                return "1 item still needs your call."
            return f"{my_pending} items still need your call."

    if len(participants) > 1:
        for client_id, member_name in participants.items():
            if client_id == viewer_client_id:
                continue
            pending = pending_for(client_id)
            if pending and (now - last_vote_ts(client_id=client_id)) > MEMBER_QUIET_SECONDS:
                plural = "item" if pending == 1 else "items"
                return f"{member_name} has gone quiet -- {pending} {plural} waiting on them."

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

    return ""