"""Synthesise test ads with known ground truth.

Every fixture is generated from code, so the position and timing of each
disclaimer, logo and claim is known exactly. That lets the content checks be
scored against the truth instead of eyeballed.

Usage: python3 tools/make_fixtures.py
"""
import json
import os
import subprocess
import tempfile

import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "fixtures")
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
W, H, FPS = 1920, 1080, 25

DISCLAIMER = "Please enjoy Northlight responsibly. drinkaware.ie"


def esc(text):
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’").replace("%", "\\%")


def text(t, start, end, x, y, size, font=FONT, color="white", box=False):
    opts = [
        f"fontfile='{font}'", f"text='{esc(t)}'", f"fontsize={size}", f"fontcolor={color}",
        f"x={x}", f"y={y}", f"enable='between(t,{start},{end})'",
    ]
    if box:
        opts += ["box=1", "boxcolor=black@0.55", "boxborderw=18"]
    return "drawtext=" + ":".join(opts)


def logo(start, end):
    # A wordmark logo: amber plate with the brand name, centred.
    return ",".join([
        f"drawbox=x={W//2-420}:y={H//2-110}:w=840:h=170:color=0xE8A33D@1:t=fill:enable='between(t,{start},{end})'",
        text("NORTHLIGHT", start, end, "(w-text_w)/2", f"{H//2-82}", 110, color="0x101820"),
    ])


def voiceover(script, path):
    aiff = path + ".aiff"
    subprocess.run(["say", "-v", "Daniel", "-o", aiff, script], check=True)
    return aiff


def render(name, duration, filters, vo_script, vo_start, truth):
    os.makedirs(OUT, exist_ok=True)
    out = os.path.join(OUT, name + ".mp4")
    with tempfile.TemporaryDirectory() as tmp:
        vo = voiceover(vo_script, os.path.join(tmp, "vo"))
        bg = (f"gradients=s={W}x{H}:c0=0x14233A:c1=0x7A3B1E:c2=0x1E4D5C:x0=0:y0=0:x1={W}:y1={H}"
              f":d={duration}:speed=0.008:r={FPS}")
        vf = ",".join([f for f in filters if f]) or "null"
        delay_ms = int(vo_start * 1000)
        cmd = [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", bg,
            "-i", vo,
            "-f", "lavfi", "-i", f"anoisesrc=color=pink:amplitude=0.3:sample_rate=48000:duration={duration}",
            "-filter_complex",
            f"[0:v]{vf},format=yuv420p[v];"
            f"[1:a]aresample=48000,adelay={delay_ms}|{delay_ms},apad[vo];"
            f"[2:a]volume=0.08[pad];"
            f"[vo][pad]amix=inputs=2:duration=longest:normalize=0,"
            f"loudnorm=I=-23:TP=-2:LRA=7,aresample=48000,atrim=0:{duration},"
            f"aformat=channel_layouts=stereo[a]",
            "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-profile:v", "high", "-preset", "fast",
            # CBR at 18 Mbps so the file looks like a real CTV deliverable, not a tiny proxy
            "-b:v", "18M", "-minrate", "18M", "-maxrate", "18M", "-bufsize", "9M",
            "-x264-params", "nal-hrd=cbr:force-cfr=1",
            "-r", str(FPS), "-c:a", "aac", "-b:a", "196k", "-ar", "48000",
            "-movflags", "+faststart", "-t", str(duration), out,
        ]
        subprocess.run(cmd, check=True)
    with open(os.path.join(OUT, name + ".truth.json"), "w") as f:
        json.dump({"file": name + ".mp4", "duration": duration, **truth}, f, indent=2)
    print("wrote", out)


# Shared creative beats for the 30-second spot. `o` offsets everything for the slate version.
def spot(o=0, disclaimer=(25, 30), disclaimer_y=900, with_logo=True, claim_card=None):
    f = [
        text("The long evenings are back.", 2 + o, 9 + o, "(w-text_w)/2", "(h-text_h)/2", 84),
        text("Brewed slow in Kilkenny since 1921.", 10 + o, 17 + o, "(w-text_w)/2", "(h-text_h)/2", 72),
        text("Made for the people you stay out with.", 18 + o, 24.5 + o, "(w-text_w)/2", "(h-text_h)/2", 72),
    ]
    if claim_card:
        f.append(text(claim_card, 10 + o, 17 + o, "(w-text_w)/2", "(h-text_h)/2+120", 64, color="0xE8A33D"))
    if with_logo:
        f.append(logo(25 + o, 30 + o))
    if disclaimer:
        f.append(text(DISCLAIMER, disclaimer[0] + o, disclaimer[1] + o, "(w-text_w)/2", str(disclaimer_y), 40,
                      font=FONT_REG, box=True))
    return f


VO_CLEAN = "The long evenings are back. Northlight. Brewed slow, for the people you stay out with."
VO_CLAIM = ("The long evenings are back. Northlight is the best lager in Ireland, guaranteed. "
            "Brewed slow, for the people you stay out with.")

title_safe_bottom = 0.95  # title-safe area: 5% margin on each edge


def disclaimer_truth(start, end, y):
    return {"type": "disclaimer", "text": DISCLAIMER, "start": start, "end": end,
            "bbox_y_bottom": round((y + 40 + 18) / H, 3)}


if __name__ == "__main__":
    render("ad_pass", 30, spot(), VO_CLEAN, 1.5, {
        "expected": {"technical": "pass", "brand": "pass", "editorial": "pass"},
        "objects": [disclaimer_truth(25, 30, 900), {"type": "logo", "text": "NORTHLIGHT", "start": 25, "end": 30}],
    })
    render("ad_short_disclaimer", 30, spot(disclaimer=(28.8, 30)), VO_CLEAN, 1.5, {
        "expected": {"technical": "pass", "brand": "pass", "editorial": "fix: disclaimer on screen 1.2s"},
        "objects": [disclaimer_truth(28.8, 30, 900), {"type": "logo", "text": "NORTHLIGHT", "start": 25, "end": 30}],
    })
    render("ad_unsafe_area", 30, spot(disclaimer_y=H - 50), VO_CLEAN, 1.5, {
        "expected": {"technical": "pass", "brand": "pass", "editorial": "fix: disclaimer outside title-safe area"},
        "objects": [disclaimer_truth(25, 30, H - 50), {"type": "logo", "text": "NORTHLIGHT", "start": 25, "end": 30}],
    })
    render("ad_claim_no_logo", 30, spot(with_logo=False, claim_card="No.1 lager in Ireland"), VO_CLAIM, 1.5, {
        "expected": {"technical": "pass", "brand": "fix: no end-card logo",
                     "editorial": "review: superlative claims need substantiation"},
        "objects": [disclaimer_truth(25, 30, 900),
                    {"type": "claim", "text": "No.1 lager in Ireland", "start": 10, "end": 17, "source": "on_screen"},
                    {"type": "claim", "text": "the best lager in Ireland, guaranteed", "start": 4, "end": 8,
                     "source": "spoken"}],
    })
    # Broadcast-style packaging: 7s clock slate + 3s black, then the 30s spot (content starts at 10s).
    # The disclaimer appears only on the slate, never in the spot itself.
    slate = [
        f"drawbox=x=0:y=0:w={W}:h={H}:color=0x202020@1:t=fill:enable='between(t,0,7)'",
        text("NORTHLIGHT  -  The Long Evenings", 0, 7, "(w-text_w)/2", "300", 72),
        text("Clock No. NLB/LONG001/030    Duration 30s", 0, 7, "(w-text_w)/2", "420", 56, font=FONT_REG),
        text("Agency: Halfmoon    Advertiser: Northlight Brewing", 0, 7, "(w-text_w)/2", "520", 48, font=FONT_REG),
        text(DISCLAIMER, 0, 7, "(w-text_w)/2", "760", 40, font=FONT_REG, box=True),
        f"drawbox=x=0:y=0:w={W}:h={H}:color=black@1:t=fill:enable='between(t,7,10)'",
    ]
    render("ad_broadcast_slate", 40, slate + spot(o=10, disclaimer=None), VO_CLEAN, 11.5, {
        "expected": {"technical": "packaging offset 10s", "brand": "pass",
                     "editorial": "fix: disclaimer only on slate, not in active content"},
        "content_start": 10,
        "objects": [{"type": "slate", "start": 0, "end": 7},
                    {"type": "disclaimer", "text": DISCLAIMER, "start": 0, "end": 7, "note": "on slate"},
                    {"type": "logo", "text": "NORTHLIGHT", "start": 35, "end": 40}],
    })
