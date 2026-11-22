"""Pocket Scribe Desktop launcher — becomes "Pocket Scribe Desktop.exe" (built by Setup Pocket Scribe Desktop.bat with PyInstaller).

Starts the local server in the background (no console window) if it isn't running, then opens the browser.
The exe must stay in the application folder, next to run.py and .venv.
"""
import os
import socket
import subprocess
import sys
import time
import webbrowser

PORT = int(os.environ.get("KTSCRIBE_PORT", "8765"))
URL = f"http://127.0.0.1:{PORT}"


def here() -> str:
    return os.path.dirname(os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__))


def is_up() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
            return True
    except OSError:
        return False


def alert(text: str):
    if os.name == "nt":
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, text, "Pocket Scribe Desktop", 0x10)
    else:
        print(text)


def venv_python(root: str):
    # python.exe (not pythonw) so the server has valid stdout/stderr; CREATE_NO_WINDOW hides the console.
    for rel in (os.path.join(".venv", "Scripts", "python.exe"), os.path.join(".venv", "bin", "python")):
        p = os.path.join(root, rel)
        if os.path.exists(p):
            return p
    return None


def main():
    root = here()
    if not is_up():
        py = venv_python(root)
        if not py or not os.path.exists(os.path.join(root, "run.py")):
            alert("Pocket Scribe Desktop isn't set up in this folder yet.\n\nRun “Setup Pocket Scribe Desktop.bat” in:\n" + root)
            return
        os.makedirs(os.path.join(root, "data"), exist_ok=True)
        log = open(os.path.join(root, "data", "server.log"), "ab")
        flags = (0x08000000 | 0x00000200) if os.name == "nt" else 0  # NO_WINDOW | NEW_PROCESS_GROUP
        subprocess.Popen([py, "run.py", "--no-browser"], cwd=root, stdin=subprocess.DEVNULL,
                         stdout=log, stderr=log, creationflags=flags, close_fds=True)
        for _ in range(120):
            if is_up():
                break
            time.sleep(0.5)
        else:
            alert("Pocket Scribe Desktop didn't start within a minute.\n\nDetails are in:\n" + os.path.join(root, "data", "server.log"))
            return
    webbrowser.open(URL)


if __name__ == "__main__":
    main()
