"""Screenshot a verify page after running a local test ad through it, using headless Chrome.

Used to record evidence: what a version of the page shows for a given file. The page must be
served by server.py, and the video must be in fixtures/ (it is fetched by the page, not uploaded
from disk).

Usage:
  python3 tools/capture.py --page http://localhost:8787/v2/verify.html --video real_afn_2026 \
      --active 60 --dest clearcast-uk --shot "#results .card:first-child=out/timeline.png" ...

Each --shot is CSS-selector=output.png. The selector's first match is captured. --summary prints
each destination's layer statuses instead of (or as well as) screenshots. --field id=value sets a
page control before running, e.g. --field brand=northlight on the v3 page.
Needs Google Chrome and the websockets package (installed with uvicorn).
"""
import argparse
import asyncio
import base64
import json
import os
import subprocess
import tempfile
import time
import urllib.request

import websockets

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

LOAD_AND_RUN = """
(async () => {
  const id = %(video)s;
  const blob = await (await fetch(`/fixtures/${id}.mp4`)).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], `${id}.mp4`, { type: "video/mp4" }));
  const input = document.getElementById("file");
  input.files = dt.files;
  input.dispatchEvent(new Event("change"));
  document.getElementById("active").value = %(active)s;
  for (const [k, v] of Object.entries(%(fields)s)) { const el = document.getElementById(k); el.value = v; el.dispatchEvent(new Event("change")); }
  document.getElementById("run").click();
  await new Promise((r) => setTimeout(r, 300));
  while (document.getElementById("run").disabled) await new Promise((r) => setTimeout(r, 500));
  const err = document.getElementById("error");
  if (!err.hidden) return "error: " + err.textContent;
  const row = document.querySelector(`tr.row[data-id="%(dest)s"]`);
  if (row) row.click();
  return "ok";
})()
"""


async def call(ws, state, method, params=None):
    state["id"] += 1
    msg_id = state["id"]
    await ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(await ws.recv())
        if msg.get("id") == msg_id:
            if "error" in msg:
                raise RuntimeError(f"{method}: {msg['error']}")
            return msg["result"]


async def capture(args):
    port = 9333
    with tempfile.TemporaryDirectory() as profile:
        chrome = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
                                   "--hide-scrollbars", "--no-first-run", f"--window-size={args.width},1000", "about:blank"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(50):
                try:
                    tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
                    page = next(t for t in tabs if t["type"] == "page")
                    break
                except Exception:
                    time.sleep(0.2)
            async with websockets.connect(page["webSocketDebuggerUrl"], max_size=None) as ws:
                state = {"id": 0}
                await call(ws, state, "Emulation.setDeviceMetricsOverride",
                           {"width": args.width, "height": 1000, "deviceScaleFactor": 2, "mobile": False})
                await call(ws, state, "Page.enable")
                await call(ws, state, "Page.navigate", {"url": args.page})
                time.sleep(3)
                script = LOAD_AND_RUN % {"video": json.dumps(args.video), "active": args.active,
                                         "dest": args.dest, "fields": json.dumps(dict(f.split("=", 1) for f in args.field))}
                res = await call(ws, state, "Runtime.evaluate", {"expression": script, "awaitPromise": True, "returnByValue": True})
                status = res["result"].get("value")
                if status != "ok":
                    raise SystemExit(f"{args.video}: {status}")
                time.sleep(0.5)
                if args.summary:
                    rows = await call(ws, state, "Runtime.evaluate", {"returnByValue": True, "expression":
                        "[...document.querySelectorAll('tr.row')].map(tr => [tr.dataset.id, ...[...tr.querySelectorAll('td')].slice(1).map(td => td.textContent.trim())].join(' '))"})
                    for line in rows["result"]["value"]:
                        print(f"{args.video}: {line}")
                for shot in args.shot:
                    selector, out = shot.rsplit("=", 1)
                    rect = await call(ws, state, "Runtime.evaluate", {"returnByValue": True, "expression":
                        f"(() => {{ const e = document.querySelector({json.dumps(selector)}); if (!e) return null;"
                        " const r = e.getBoundingClientRect(); return {x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height}; })()"})
                    r = rect["result"].get("value")
                    if not r:
                        raise SystemExit(f"no element for {selector}")
                    img = await call(ws, state, "Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True,
                        "clip": {"x": r["x"], "y": r["y"], "width": r["w"], "height": r["h"], "scale": 1}})
                    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
                    open(out, "wb").write(base64.b64decode(img["data"]))
                    print("wrote", out)
        finally:
            chrome.terminate()
            chrome.wait()  # Chrome must be gone before its profile directory is removed


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--page", required=True)
    p.add_argument("--video", required=True)
    p.add_argument("--active", default="30")
    p.add_argument("--dest", default="clearcast-uk")
    p.add_argument("--width", type=int, default=1120)
    p.add_argument("--field", action="append", default=[], help="id=value to set before running (v3 declarations)")
    p.add_argument("--shot", action="append", default=[])
    p.add_argument("--summary", action="store_true", help="print each destination's layer statuses")
    asyncio.run(capture(p.parse_args()))
