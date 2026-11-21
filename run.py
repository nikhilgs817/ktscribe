"""Start KT Scribe and open it in the browser."""
import os
import sys
import threading
import time
import webbrowser

import uvicorn

HOST = os.environ.get("KTSCRIBE_HOST", "127.0.0.1")
PORT = int(os.environ.get("KTSCRIBE_PORT", "8765"))

if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    if "--no-browser" not in sys.argv:
        threading.Thread(target=lambda: (time.sleep(1.5), webbrowser.open(f"http://{HOST}:{PORT}")),
                         daemon=True).start()
    print(f"\n  KT Scribe running at http://{HOST}:{PORT}  (close this window to stop)\n")
    uvicorn.run("app.main:app", host=HOST, port=PORT, log_level="warning")
