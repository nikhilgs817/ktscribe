# Pocket Scribe user guide

**Pocket Scribe** records on Android. **Pocket Scribe Desktop** turns audio and video into a transcript, a summary, screenshots, and an editable runbook on your Windows PC. Use both apps with Google Drive, or start with a recording already on the PC.

## Set up Pocket Scribe Desktop

1. Get the complete repository. If you downloaded a ZIP, extract it to a permanent folder first.
2. Install and start Ollama if you want the app to write summaries, runbooks, or answer questions. Check its installed models with `ollama list`. [Ollama for Windows](https://docs.ollama.com/windows)
3. Double-click **Setup Pocket Scribe Desktop.bat**. Setup uses or installs Python, sets up the dependencies, builds the launcher, and creates Desktop and Start menu shortcuts. The first setup needs an internet connection.
4. Open **Pocket Scribe Desktop** from the shortcut. It opens the local app at `http://127.0.0.1:8765`. Keep the launcher beside the application files and its Python environment.
5. Open **Settings**. Pick an **Assistant** for summaries, chapters, and questions, a **Writer** for runbooks, and optionally a **Vision** model to describe screenshots. Use **Test** beside a role to check its connection. Speech recognition uses Whisper. The first transcription may download the selected model.

If you already use the app under its old name, update the files in the existing installation and run the renamed setup there. The app continues to use its existing `data` folder. If the old server is running, let active work finish, use the power button at the bottom of the sidebar to quit, and reopen the app.

### Try a recording already on your PC

Click **New session** and drop a short MP4 or M4A into the dialog. **Upload file** copies the recording into the session. **Use file on this PC** links to the original file, which saves disk space for large recordings. Keep the file at that path if you use the second option. Add a title if desired, then click **Start processing**. Open **Transcript** to watch the text appear.

For a recording with unusual names or acronyms, add them under **Vocabulary hints** before processing. If the spoken language is known, choose it explicitly. Screenshots come from video recordings. For an audio-only file, use the transcript and summary.

## Record and upload from Android

Use an Android 8 or later device. Install the Pocket Scribe APK **you built or received from the project owner**. If you need to build it, see [Android build instructions](../pocket-scribe/README.md#build-from-source).

### Connect Google Drive once

1. In Google Cloud, enable the **Google Drive API** in your project. Configure Google Auth Platform and use the `https://www.googleapis.com/auth/drive.file` scope. If the app is in testing mode, add the Google account you will use as a test user.
2. Create an **Android** OAuth client for package `com.example.voicecam` and the **SHA-1 of the signing certificate for the exact APK installed on the phone**. See the phone's **Settings → Help & phone details → Google connection help**, or use Android SDK `apksigner verify --print-certs`. The fingerprint can change when another key signs a build. [Google's Android authorization guide](https://developer.android.com/identity/authorization)
3. In Pocket Scribe on the phone, tap **Settings → Connect Google Drive**. Choose your Google account and approve access.
4. On the PC, open Google Drive for desktop and sign into the same account. File Explorer should show **My Drive**. [Google Drive for desktop setup](https://support.google.com/drive/answer/13401938)

### Make a recording

1. Select **Audio only** for a voice recording or **Audio + video** to use the rear camera. In video mode, use the preview to position the phone.
2. Tap **Start recording** and allow the required permissions. To record with the display off, start while the app is visible, then use the phone's power button. Test this on your phone before relying on it for a long session.
3. Wake the phone and tap **Stop recording**, or use **Stop recording** in the recording notification. Enter a name, then tap **Save**. If you defer naming, go to **Settings → Local recordings** to finish later.
4. The app saves locally and syncs automatically when the chosen network is available. With the default Wi-Fi preference, uploads wait for an unmetered connection. Check **Local recordings** for the upload status or to play or share a phone copy.

A new Drive setup creates **My Drive → Pocket Scribe**. Existing setups may still use **VoiceCam**. Each finished recording has an MP4 or M4A and a matching JSON file. Keep them together. Ongoing backup segments go into **Live backups**. Long recordings can have brief gaps when recording rolls to the next segment.

## Find and process the recording on Windows

1. Open **Phone recordings** in Pocket Scribe Desktop. It looks for the Pocket Scribe or VoiceCam folder in **My Drive**. If needed, click **Drive folder** and paste the full folder path from File Explorer, such as `G:\My Drive\Pocket Scribe`.
2. Find the recording by its saved name, date, duration, and type. **Waiting for Drive sync** means the app is still waiting for the complete file. The inbox refreshes automatically and has a **Refresh** button.
3. Click **Process** when you are ready. The app verifies the complete file, copies it to a local session, and queues transcription and the other configured steps. Use **Open session** to return to an imported recording. Backup clips do not create sessions.

For a first end-to-end check, record 30 to 60 seconds with speech. Confirm it plays on the phone, appears in Drive with its JSON file, and produces a transcript after you click **Process**.

## Review and export the results

| Where | What you can do |
|---|---|
| **Overview** | Review the summary and chapters. Use timestamps to jump into the source. |
| **Transcript** | Search, double-click a segment to correct it, or use **Find & replace**. |
| **Screenshots** | Review the captured frames, hide unwanted ones, or use **Capture frame** under the player to save a specific moment. |
| **Runbook** | Click **Generate**, optionally add instructions, then edit or preview the result. Use **Insert screenshot** to add a frame. |
| **Ask** | Ask a question about the recording and follow timestamps to check the answer. |

Choose **Export** from the session header. Runbooks export to Word, PDF, or Markdown. Transcripts also support plain text and SRT subtitles. Summaries can be exported to Word or PDF. Review names, steps, and timestamps before sharing.

## Troubleshoot common issues

| What you see | What to check |
|---|---|
| No recording in the inbox | Save and name the recording on the phone, check its upload status, then confirm both files are in the same Drive folder on the PC. Use **Drive folder** if discovery chose a different folder. |
| Waiting for Drive sync or a copy error | Wait for Drive for desktop to finish syncing. Make the recording folder available offline if needed, and check that the PC has room for a local copy. |
| Drive connection needs attention | Reconnect in Pocket Scribe. If authorization fails, check the Google account, enabled Drive API, OAuth test user, package name, and APK signing SHA-1. |
| No summary, runbook, or answer | Check the Ollama connection and assigned model under **Settings**, then use **Test**. |
| Processing stopped | Open the session and click **Resume**. If it failed to find speech, play the source and check that it has an audible audio track. |
| The desktop app will not open | Run `start.bat` to see startup errors. Check `data\server.log` if the launcher started the server in the background. |
| Screen-off recording stops early | Test the phone's battery settings and try a short session in each recording mode. Check temperature and available storage before longer sessions. |

Desktop sessions and settings are stored in `data\` by default. The phone sends recordings to your Google Drive only when connected. Transcription and document processing run on the PC with the default local model setup. Back up the desktop data and any linked source files separately. Verify the Drive and desktop copies before deleting your phone copy.
