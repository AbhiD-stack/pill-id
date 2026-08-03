"""Live DailyMed name search -- a supplement to the local catalog, used only
by the text-based endpoints (/api/search, /api/ocr-label). Never used for
photo-based identification: that's retrieval against a precomputed
embedding gallery (see classifier.py and notebooks/...), and there is no
way to make that live per-request without running DINOv2 over fresh
DailyMed images inside every scan, which would turn a sub-second request
into a multi-minute one.

Calls dailymed.nlm.nih.gov synchronously inside a request, so this is
deliberately kept cheap: a short timeout, a small in-memory TTL cache, and
any failure (timeout, network error, malformed response) just returns an
empty list rather than raising -- a live-search miss should never break the
local catalog's own results.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, List, Optional, Tuple, TypedDict

DAILYMED_API_BASE = "https://dailymed.nlm.nih.gov/dailymed/services/v2"
REQUEST_TIMEOUT_SECONDS = 4.0
CACHE_TTL_SECONDS = 6 * 60 * 60  # 6h -- plenty fresh for a search suggestion, not treated as a clinical fact

_cache: Dict[str, Tuple[float, List["DailyMedLiveMatch"]]] = {}


class DailyMedLiveMatch(TypedDict):
    label: str
    ndc: Optional[str]
    name: Optional[str]
    imprint: Optional[str]
    color: Optional[str]
    shape: Optional[str]
    score_marks: Optional[str]
    status: Optional[str]
    reference_image_url: Optional[str]
    source: str


def _get_json(url: str) -> Optional[dict]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "pill-id-app/1.0 (live search)"})
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            return json.load(resp)
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None


def search_dailymed_live(query: str, limit: int = 10) -> List[DailyMedLiveMatch]:
    """Best-effort live name search against DailyMed's public SPL index.

    Returns [] on any network failure, timeout, or empty query -- callers
    should treat this purely as a supplement to the local catalog, never a
    hard dependency."""
    q = query.strip()
    if not q or limit <= 0:
        return []

    cache_key = f"{q.lower()}::{limit}"
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached[0]) < CACHE_TTL_SECONDS:
        return cached[1]

    params = urllib.parse.urlencode({"drug_name": q, "pagesize": limit})
    payload = _get_json(f"{DAILYMED_API_BASE}/spls.json?{params}")
    if not payload:
        return []
    data = payload.get("data", payload)
    entries = data if isinstance(data, list) else []

    results: List[DailyMedLiveMatch] = []
    for entry in entries[:limit]:
        setid = entry.get("setid")
        title = (entry.get("title") or "").strip()
        if not setid or not title:
            continue
        results.append(
            DailyMedLiveMatch(
                label=f"dailymed_live:{setid}",
                ndc=None,
                name=title,
                imprint=None,
                color=None,
                shape=None,
                score_marks=None,
                status="Live DailyMed result -- not yet in this app's local reference photos",
                reference_image_url=None,
                source="dailymed_live",
            )
        )

    _cache[cache_key] = (time.time(), results)
    return results
