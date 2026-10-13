"""Run content detection on every fixture and score it against ground truth.

Results are written to the server cache, so the UI returns them instantly afterwards
(labelled as cached, with the analysis time).

Usage: python3 tools/eval_detection.py [--force]
"""
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

FIXTURES = os.path.join(server.ROOT, "fixtures")
NAMES = ["ad_pass", "ad_short_disclaimer", "ad_unsafe_area", "ad_small_disclaimer", "ad_claim_no_logo", "ad_broadcast_slate"]


def analyse(name, force):
    path = os.path.join(FIXTURES, name + ".mp4")
    data = open(path, "rb").read()
    digest = hashlib.sha256(data).hexdigest()
    cached = os.path.join(server.CACHE, digest + ".json")
    if os.path.exists(cached) and not force:
        return name, json.load(open(cached))
    result = {
        "sha256": digest, "filename": name + ".mp4",
        "analysed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "signal": server.measure_signal(path),
        "content": server.detect_content(path),
    }
    if not result["content"].get("error"):
        json.dump(result, open(cached, "w"), indent=2)
    return name, result


def overlap(a, b):
    return min(a["end"], b["end"]) - max(a["start"], b["start"])


def score(name, result):
    truth = json.load(open(os.path.join(FIXTURES, name + ".truth.json")))
    dets = result["content"].get("detections", [])
    print(f"\n=== {name}  ({result['content'].get('seconds')}s, {len(dets)} detections)")
    if result["content"].get("error"):
        print("  ERROR:", result["content"]["error"])
        return []
    rows = []
    for obj in truth["objects"]:
        cands = [d for d in dets if d["type"] == obj["type"] and d.get("source", "on_screen") == obj.get("source", d.get("source"))]
        cands = [d for d in cands if overlap(d, obj) > -1.0]
        if not cands:
            print(f"  MISSED  {obj['type']:<10} {obj['start']:>5}-{obj['end']:<5} {obj.get('text', '')[:40]}")
            rows.append(("missed", obj["type"]))
            continue
        d = max(cands, key=lambda c: overlap(c, obj))
        ds, de = d["start"] - obj["start"], d["end"] - obj["end"]
        extra = ""
        if "bbox_y_bottom" in obj and d.get("box"):
            extra = f"  box bottom {d['box']['bottom']:.3f} vs truth {obj['bbox_y_bottom']:.3f}"
        if "x_height_lines" in obj:
            extra += f"  x-height {d.get('x_height_lines')} vs truth {obj['x_height_lines']} lines"
        print(f"  found   {obj['type']:<10} truth {obj['start']:>5}-{obj['end']:<5} model {d['start']:>5}-{d['end']:<5}"
              f"  err {ds:+.2f}/{de:+.2f}s  conf {d['confidence']:.2f}{extra}")
        rows.append(("found", obj["type"], abs(ds), abs(de)))
    print("  all detections:")
    for d in dets:
        box = f" box b={d['box']['bottom']:.3f}" if d.get("box") else ""
        print(f"    {d['type']:<10} {d['source']:<9} {d['start']:>6}-{d['end']:<6} {d['text'][:55]!r}{box}")
    return rows


if __name__ == "__main__":
    force = "--force" in sys.argv
    # Sequential: one video uses most of a 30k tokens-per-minute budget.
    import time
    results = []
    for i, n in enumerate(NAMES):
        t = time.time()
        results.append(analyse(n, force))
        print(f"{n} done in {time.time() - t:.0f}s", flush=True)
        if i < len(NAMES) - 1 and time.time() - t > 5:
            time.sleep(35)
    all_rows = []
    for name, result in results:
        all_rows += score(name, result)
    found = [r for r in all_rows if r[0] == "found"]
    print(f"\nRecall: {len(found)}/{len(all_rows)} ground-truth objects found")
    if found:
        print(f"Mean timing error: start {sum(r[2] for r in found)/len(found):.2f}s, end {sum(r[3] for r in found)/len(found):.2f}s")
