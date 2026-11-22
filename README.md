# Pocket Scribe Desktop

Turn a recorded knowledge-transfer (KT) call into a **timestamped transcript**, an **editable runbook with screenshots**, and a **Q&A chat**, all running locally on your PC.

[Read the full user guide](docs/user-guide.md) for setup, recording, processing, exporting, and troubleshooting.

## Quick start (Windows)

1. Make sure **Ollama** is running with your models (`ollama list`).
2. Double-click **`Setup Pocket Scribe Desktop.bat`** once (5–10 minutes, needs internet). It installs Python 3.12 if needed, creates the environment, builds **`Pocket Scribe Desktop.exe`** and puts a **Pocket Scribe Desktop** shortcut on your Desktop and Start menu.
3. From then on, just use the Desktop icon. It starts the server in the background (no console window) and opens **http://127.0.0.1:8765**. The ⏻ button at the bottom-left of the app stops the server.
4. Click **New session** and drop in a video, or choose **Use file on this PC** and paste the path (avoids copying multi-GB recordings).

`Pocket Scribe Desktop.exe` is a small launcher. The app and its Python environment stay in this folder, so **don't move or delete the folder** (if you move it, run the setup file again). `start.bat` is a fallback that shows a console with logs. Server logs are in `data\server.log`.

The first transcription downloads the Whisper *large-v3-turbo* model (about 1.6 GB, one time only) into `data\models`. Windows SmartScreen may warn about the unsigned exe the first time: choose *More info → Run anyway*.

## Phone recordings from Pocket Scribe

The [Pocket Scribe Android source and build instructions](pocket-scribe/) are included in this repository.

1. Connect Google Drive once in Pocket Scribe on your phone. On the PC, sign into the same account in Google Drive for desktop.
2. Stop and save a recording on the phone. Pocket Scribe uploads the finished MP4 or M4A and its recording details automatically.
3. In Pocket Scribe Desktop, open **Phone recordings**. The inbox looks for the **Pocket Scribe** folder in **My Drive**. You can also click **Drive folder** and paste its path from File Explorer, for example G:\My Drive\Pocket Scribe. The earlier **VoiceCam** folder is also supported.
4. Click **Process**. Pocket Scribe Desktop verifies the complete file, copies it to the local session, and starts its transcript and summary workflow. You can generate a runbook from the resulting session.

The inbox refreshes while Pocket Scribe Desktop is open and shows the recording's name, date, duration and mode. Live backup parts are kept separately in Drive.

## What each model does

| Job | Model | Why |
|---|---|---|
| Speech → transcript | **Whisper large-v3-turbo** (faster-whisper) | LLMs can't hear audio; Whisper is the standard for this |
| Runbook writing | **gpt-oss:120b** ("Writer") | Highest quality writing; 128k context; reasoning effort is configurable |
| Summary, chapters, Q&A | **Qwen3.6-35B-A3B** ("Assistant") | MoE with ~3B active parameters, so it's fast enough for interactive chat |
| Screenshot descriptions | **Qwen3.6-35B-A3B** ("Vision") | Multimodal; reads console pages, configs and errors in frames |
| — | qwen3:8b | Not needed. You can use it as a fallback Assistant if memory gets tight |

You can change any role in **Settings**. Models are auto-assigned on first launch.

## How it works

```
video ─► ffmpeg (16 kHz audio) ─► Whisper ─► transcript.json  (shown live while transcribing)
      └► screen-change detection (1 fps thumbnails) ─► screenshots ─► vision model descriptions
transcript + screenshots ─► Assistant: summary, key points, chapters, systems, open questions
                        └► Writer: runbook (Markdown, [mm:ss] citations, ![](frame:F0012) images)
                        └► Assistant: Q&A chat (answers cite timestamps; click to jump)
```

- **Screenshots** are captured when the shared screen settles on new content. They aren't taken at fixed intervals. Use *Screenshot sensitivity* (Low/Medium/High) to tune this. Frames that only show the webcam are tagged automatically and kept out of the runbook. **📸 Capture frame** under the player adds any moment by hand.
- **Transcript fixes:** double-click any sentence to correct it, or use **Find & replace** (for example *cloud watch → CloudWatch*). Add product names to *Vocabulary hints* so Whisper gets them right first time.
- **Runbook:** you can edit, split or preview it. Use 🖼 *Insert screenshot* to add images. It autosaves, and *Regenerate* keeps the previous version so you can swap back. You can change the section structure in Settings → Runbook template.
- **Exports:** the runbook goes to DOCX, PDF or MD, with screenshots embedded. The transcript goes to DOCX/PDF (with summary and chapters), TXT, SRT or MD.
- **Long sessions:** if a transcript is longer than *Max context*, it's condensed into dense timestamped notes first (map-reduce), so 2–3 hour KTs work too.

## Speed on a Ryzen AI Max (128 GB)

- faster-whisper runs on the **CPU**, because its GPU path is NVIDIA-only. With 16 Zen 5 cores, a 1-hour call should take very roughly 5–15 minutes with large-v3-turbo. You can follow progress live.
- **Optional AMD GPU transcription:** use a **Vulkan build of whisper.cpp**, either built with `-DGGML_VULKAN=1` or a prebuilt Vulkan Windows binary. Download `ggml-large-v3-turbo.bin`, then in Settings → Speech to text choose **whisper.cpp** and set both paths.
- The LLM steps run on your GPU through Ollama. gpt-oss:120b (~65 GB) and Qwen3.6-35B (~24 GB) both fit. If your BIOS/Adrenalin *Variable Graphics Memory* is set lower, Ollama swaps models between steps, which is slower but still works.

## Data & privacy

Everything lives in `data\` next to the app: `data\sessions\<id>\` holds the transcript, screenshots, runbook and chat, and `data\settings.json` holds your settings. The server only listens on 127.0.0.1. Nothing is sent anywhere except to your local Ollama.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Ollama not reachable" (bottom-left) | Start Ollama; check the URL in Settings |
| Video won't play in the browser | Transcript, runbook and chat still work. MP4 (H.264) and WebM play everywhere |
| Words like product names are wrong | Add them to Vocabulary hints, then use Find & replace on this session |
| Too many / too few screenshots | Screenshots tab → pick a sensitivity → ↻ *Re-detect* |
| Runbook step is slow to start | First load of gpt-oss:120b takes about a minute; the status line shows *Thinking* |
| Reset everything | Close the app and delete the `data` folder |

Run on another port: `set KTSCRIBE_PORT=8800` before `start.bat`.
