"""
Audio fingerprint identification via AcoustID/Chromaprint.
Usage: python identify.py <audio_file> [fpcalc_path]
Returns JSON with top matches including artist, title, album, confidence.
"""
import sys
import os
import json

# Allow overriding fpcalc path via env or argument
FPCALC_PATH = os.environ.get("FPCALC_PATH", "fpcalc")
if len(sys.argv) >= 3:
    FPCALC_PATH = sys.argv[2]

# Resolve to absolute path so subprocess can find it
os.environ["FPCALC"] = os.path.abspath(FPCALC_PATH)

import acoustid

# AcoustID API key — register free at https://acoustid.org/new-application
API_KEY = os.environ.get("ACOUSTID_API_KEY", "")

def identify_track(filepath):
    """Fingerprint a file and look up matches via AcoustID."""
    duration, fingerprint = acoustid.fingerprint_file(filepath)

    try:
        response = acoustid.lookup(API_KEY, fingerprint, duration,
                                   meta="recordings releasegroups")
    except acoustid.WebServiceError as e:
        return {"error": f"AcoustID API error: {e}", "matches": []}

    # Check for API-level errors (e.g. invalid key)
    if response.get("status") == "error":
        err = response.get("error", {})
        return {"error": f"AcoustID error: {err.get('message', 'unknown')}", "matches": []}

    matches = []
    for result in response.get("results", []):
        score = result.get("score", 0)
        for recording in result.get("recordings", []):
            title = recording.get("title", "Unknown")
            artists = ", ".join(a.get("name", "") for a in recording.get("artists", []))
            recording_id = recording.get("id", "")
            albums = []
            for rg in recording.get("releasegroups", []):
                albums.append(rg.get("title", "Unknown"))
            matches.append({
                "confidence": round(score, 4),
                "artist": artists,
                "title": title,
                "albums": albums,
                "recording_id": recording_id,
            })

    # Sort by confidence descending, deduplicate by artist+title
    matches.sort(key=lambda m: m["confidence"], reverse=True)
    seen = set()
    unique = []
    for m in matches:
        key = f"{m['artist']}|||{m['title']}".lower()
        if key not in seen:
            seen.add(key)
            unique.append(m)

    return {"error": None, "matches": unique[:5]}  # top 5


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python identify.py <audio_file> [fpcalc_path]", "matches": []}))
        sys.exit(1)

    if not API_KEY:
        print(json.dumps({"error": "Set ACOUSTID_API_KEY environment variable. Register free at https://acoustid.org/new-application", "matches": []}))
        sys.exit(1)

    filepath = sys.argv[1]
    if not os.path.exists(filepath):
        print(json.dumps({"error": f"File not found: {filepath}", "matches": []}))
        sys.exit(1)

    result = identify_track(filepath)
    print(json.dumps(result, indent=2))
