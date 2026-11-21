"""ffmpeg helpers: duration probe, audio extraction, screen-change detection, frame grabs."""
import os
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np

_NO_WINDOW = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW on Windows


def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        exe = shutil.which("ffmpeg")
        if exe:
            return exe
    raise RuntimeError("ffmpeg not found. Run start.bat again or install ffmpeg.")


def _run(args, **kw):
    return subprocess.run([ffmpeg_exe(), *args], capture_output=True, creationflags=_NO_WINDOW, **kw)


def probe(path: str) -> dict:
    """Return {'duration': seconds, 'has_video': bool, 'width': int, 'height': int}."""
    r = _run(["-hide_banner", "-i", path])
    err = r.stderr.decode("utf-8", "replace")
    info = {"duration": 0.0, "has_video": False, "has_audio": False, "width": 0, "height": 0}
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", err)
    if m:
        h, mi, s = m.groups()
        info["duration"] = int(h) * 3600 + int(mi) * 60 + float(s)
    for line in err.splitlines():
        if "Stream #" in line and "Video:" in line and "attached pic" not in line and not info["has_video"]:
            info["has_video"] = True
            m2 = re.search(r"(\d{2,5})x(\d{2,5})", line)
            if m2:
                info["width"], info["height"] = int(m2.group(1)), int(m2.group(2))
        if "Stream #" in line and "Audio:" in line:
            info["has_audio"] = True
    if "No such file" in err or "Invalid data found" in err:
        raise RuntimeError("ffmpeg could not read this file: " + err.strip().splitlines()[-1])
    return info


def _progress_pipe(args, duration, on_progress, cancel=None):
    """Run ffmpeg with -progress pipe:1 and report 0..1 progress."""
    p = subprocess.Popen([ffmpeg_exe(), *args, "-progress", "pipe:1", "-nostats"],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=_NO_WINDOW)
    import threading
    err_chunks = []
    threading.Thread(target=lambda: err_chunks.append(p.stderr.read()), daemon=True).start()
    for raw in p.stdout:
        line = raw.decode("ascii", "ignore").strip()
        if line.startswith("out_time_ms=") and duration:
            try:
                us = int(line.split("=", 1)[1])
                on_progress(min(1.0, us / 1e6 / duration))
            except ValueError:
                pass
        if cancel and cancel():
            p.kill()
            raise InterruptedError()
    p.wait()
    if p.returncode != 0:
        msg = b"".join(err_chunks).decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError("ffmpeg failed: " + (msg[-1] if msg else f"code {p.returncode}"))


def extract_audio(src: str, out_wav: Path, duration: float, on_progress, cancel=None):
    tmp = out_wav.with_suffix(".part.wav")
    _progress_pipe(["-y", "-hide_banner", "-i", src, "-vn", "-ac", "1", "-ar", "16000",
                    "-c:a", "pcm_s16le", str(tmp)], duration, on_progress, cancel)
    tmp.replace(out_wav)


SENSITIVITY = {  # fraction of thumbnail pixels that must change vs. the last kept frame
    "low": 0.06,      # page/window switches only
    "medium": 0.02,   # also catches text-only changes (new console page, scrolled config)
    "high": 0.008,    # small edits, dialogs, single lines
}


def detect_screen_changes(src: str, duration: float, sensitivity: str, max_frames: int,
                          on_progress, cancel=None) -> list[dict]:
    """Sample 1 fps thumbnails and keep a frame each time the screen settles on new content.

    A change is accepted when two consecutive samples both differ from the last kept frame but are
    similar to each other (the screen has settled), which ignores transitions, scrolling and small
    moving webcam tiles. Screens identical to one of the recent captures (switching back and forth
    between two windows) are skipped. Returns [{'t': seconds, 'score': change_fraction}].
    """
    W, H = 192, 108
    size = W * H
    thr = SENSITIVITY.get(sensitivity, SENSITIVITY["medium"])
    delta = 22             # grey-level difference counted as a changed pixel
    min_gap = 4.0          # seconds between captures

    def diff(a, b):
        return float(np.mean(np.abs(a - b) > delta))

    p = subprocess.Popen(
        [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-i", src, "-an", "-sn",
         "-vf", f"fps=1,scale={W}:{H}:flags=area,format=gray", "-f", "rawvideo", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=_NO_WINDOW)
    kept, recent, prev, last_kept, last_t = [], [], None, None, -1e9
    i = 0
    try:
        while True:
            buf = p.stdout.read(size)
            if len(buf) < size:
                break
            f = np.frombuffer(buf, dtype=np.uint8).astype(np.int16)
            t = float(i)
            i += 1
            if prev is not None:
                motion = diff(f, prev)
                if last_kept is None:
                    if motion < 0.01:
                        kept.append({"t": t, "score": 1.0})
                        last_kept, last_t = f, t
                        recent.append(f)
                else:
                    change = diff(prev, last_kept)
                    settled = motion < max(0.004, change * 0.3)
                    if change > thr and settled and (t - last_t) >= min_gap:
                        seen = min((diff(f, r) for r in recent), default=1.0)
                        if seen > thr:
                            kept.append({"t": t, "score": change})
                            recent.append(f)
                            recent[:] = recent[-8:]
                        last_kept, last_t = f, t
            prev = f
            if i % 15 == 0:
                if duration:
                    on_progress(min(1.0, t / duration))
                if cancel and cancel():
                    raise InterruptedError()
    finally:
        p.kill() if p.poll() is None else None
        p.wait()
    if not kept and i > 0:
        kept.append({"t": min(5.0, i - 1), "score": 1.0})
    if len(kept) > max_frames:
        first = kept[0]
        rest = sorted(kept[1:], key=lambda k: k["score"], reverse=True)[: max_frames - 1]
        kept = [first] + sorted(rest, key=lambda k: k["t"])
    return kept


def grab_frame(src: str, t: float, out_jpg: Path, max_width: int = 1920):
    r = _run(["-y", "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.0, t):.3f}", "-i", src,
              "-frames:v", "1", "-vf", f"scale='min({max_width},iw)':-2", "-q:v", "3", str(out_jpg)])
    if r.returncode != 0 or not out_jpg.exists():
        raise RuntimeError("Could not capture frame at %.1fs" % t)
