# Pocket Scribe

Pocket Scribe records audio or audio with video on Android. Named recordings sync to Google Drive and appear in [Pocket Scribe Desktop](../README.md#how-it-works) for processing.

1. Open Pocket Scribe, select **Audio only** or **Audio + video**, then tap **Start recording**. You can switch the screen off; the notification has a Stop control.
2. Stop, name the recording and tap **Save**. Recordings are saved locally, then uploaded when Drive is connected and a network is available.
3. Sign in to the same Google account in Google Drive for desktop. Pocket Scribe Desktop picks the recording up by itself, or click **Process** on its card.

The app follows the phone's light or dark mode, or the choice in **Settings › Appearance**, with the same colours as the desktop app.

See the [install guide](../docs/INSTALL.md#5-pocket-scribe-on-the-phone) and the [user guide](../docs/user-guide.md#on-the-phone).

## Build from source

Open this folder in Android Studio with JDK 17 and Android SDK 35. The app supports Android 8 and later. From Windows PowerShell with Java and the SDK configured, run:

~~~powershell
.\gradlew.bat assembleDebug testDebugUnitTest lintDebug
~~~

The APK is written to `app/build/outputs/apk/debug/app-debug.apk`. To find its certificate fingerprint, run `apksigner verify --print-certs` from the Android SDK build tools with the APK path.

## Connect Drive

Enable the Drive API in a Google Cloud project. Create an Android OAuth client for the package `com.example.voicecam` and the signing certificate SHA-1 of the APK you install. Grant the `https://www.googleapis.com/auth/drive.file` scope and add your Google account as a test user if the OAuth app is in testing mode. In Pocket Scribe, open **Settings › Connect Google Drive** and select that account. **Settings › Help › Google connection help** shows the package name and SHA-1 to copy. Existing installations can reuse their earlier **VoiceCam** folder. [Google's Android authorization guide](https://developer.android.com/identity/authorization) covers client registration.

Finished MP4 or M4A files are accompanied by a JSON file that carries their identity, title, duration, type, and checksum. Pocket Scribe Desktop checks the complete media file when you click Process. Backup segments live in a separate **Live backups** folder.

The first local phone test should cover both modes, playback after locking the display, and a real Google Drive upload. Capture restarts between roughly two-minute parts, so short gaps can occur. The Android test suite exercises the Drive upload protocol with simulated responses.

The optional `desktop/import_recordings.py` can prepare verified recordings for other desktop tools. Pocket Scribe Desktop reads the synced Drive folder directly.
