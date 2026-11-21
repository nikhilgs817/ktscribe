# Pocket Scribe

Pocket Scribe records audio or audio with video on Android. Named recordings sync to Google Drive and appear in [KT Scribe's Phone recordings inbox](../README.md#phone-recordings-from-pocket-scribe) for processing.

1. Open Pocket Scribe, select **Audio only** or **Audio + video**, then tap **Start recording**. The foreground notification gives you a Stop control while you use the phone.
2. Stop, name the recording and tap **Save**. Recordings are saved locally, then uploaded when Drive is connected and a network is available.
3. Sign into the same Google account in Google Drive for desktop, open **Phone recordings** in KT Scribe, and click **Process** beside a finished recording.

## Build from source

Open this folder in Android Studio with JDK 17 and Android SDK 35. The app supports Android 8 and later. From Windows PowerShell with Java and the SDK configured, run:

~~~powershell
.\gradlew.bat assembleDebug testDebugUnitTest lintDebug
~~~

The APK is written to `app/build/outputs/apk/debug/app-debug.apk`. To find its certificate fingerprint, run `apksigner verify --print-certs` from the Android SDK build tools with the APK path.

## Connect Drive

Enable the Drive API in a Google Cloud project. Create an Android OAuth client for the package `com.example.voicecam` and the signing certificate SHA-1 of the APK you install. Grant the `https://www.googleapis.com/auth/drive.file` scope and add your Google account as a test user if the OAuth app is in testing mode. In Pocket Scribe, open **Settings → Connect Google Drive** and select that account. Existing installations can reuse their earlier **VoiceCam** folder. [Google's Android authorization guide](https://developer.android.com/identity/authorization) covers client registration.

Finished MP4 or M4A files are accompanied by a JSON file that carries their identity, title, duration, type, and checksum. KT Scribe checks the complete media file when you click Process. Backup segments live in a separate **Live backups** folder.

The first local phone test should cover both modes, playback after locking the display, and a real Google Drive upload. Capture restarts between roughly two-minute parts, so short gaps can occur. The Android test suite exercises the Drive upload protocol with simulated responses.

The optional `desktop/import_recordings.py` can prepare verified recordings for other desktop tools. KT Scribe reads the synced Drive folder directly.
