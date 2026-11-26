package com.example.voicecam

import android.accounts.AccountManager
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.google.android.gms.auth.api.identity.Identity
import java.security.MessageDigest

class SettingsActivity : ComponentActivity() {
    private val prefs by lazy { getSharedPreferences("settings", 0) }
    private lateinit var account: TextView
    private lateinit var backupStatus: TextView
    private lateinit var connect: Button
    private lateinit var retryBackup: Button
    private var accountCandidate = ""
    private val chooseAccount = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            accountCandidate = result.data?.getStringExtra(AccountManager.KEY_ACCOUNT_NAME).orEmpty()
            if (accountCandidate.isNotBlank()) authorize()
        }
    }
    private val authorization = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) {
            showMessage("Drive wasn't connected. You can still record on the phone.")
        } else try {
            val response = Identity.getAuthorizationClient(this).getAuthorizationResultFromIntent(result.data)
            if (response.accessToken.isNullOrBlank()) error("Access not granted")
            connected()
        } catch (e: Exception) { failed(e) }
    }
    override fun attachBaseContext(newBase: android.content.Context) { super.attachBaseContext(SimpleUi.themed(newBase)) }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        accountCandidate = savedInstanceState?.getString("accountCandidate").orEmpty()
        val root = SimpleUi.screen(this)
        fun card(title: String): LinearLayout {
            root.addView(SimpleUi.section(this, title))
            return SimpleUi.card(this).also { root.addView(it) }
        }
        fun LinearLayout.line(value: String, size: Float = 15f, bold: Boolean = false): TextView =
            SimpleUi.text(this@SettingsActivity, value, size, bold).also { addView(it); it.setPadding(0, 0, 0, SimpleUi.dp(this@SettingsActivity, 8)) }
        fun LinearLayout.note(value: String): TextView =
            SimpleUi.muted(this@SettingsActivity, value).also { addView(it); it.setPadding(0, 0, 0, SimpleUi.dp(this@SettingsActivity, 10)) }
        fun LinearLayout.action(value: String, run: () -> Unit) = SimpleUi.quietButton(this@SettingsActivity, value, run).also {
            addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = SimpleUi.dp(this@SettingsActivity, 8) })
        }
        fun LinearLayout.toggle(label: String, checked: Boolean, change: (Boolean) -> Unit) = Switch(this@SettingsActivity).apply {
            text = label; textSize = 16f; minHeight = SimpleUi.dp(this@SettingsActivity, 52); isChecked = checked
            SimpleUi.switchTint(this); setOnCheckedChangeListener { _, value -> change(value) }
        }.also { addView(it) }

        root.addView(SimpleUi.header(this, "Settings", back = true).apply {
            addView(SimpleUi.roundButton(this@SettingsActivity, "i", "How it works") { SimpleUi.showInfo(this@SettingsActivity) },
                LinearLayout.LayoutParams(SimpleUi.dp(this@SettingsActivity, 40), SimpleUi.dp(this@SettingsActivity, 40)))
        })

        val drive = card("Google Drive")
        account = drive.line("", 16f, true)
        drive.note("Finished recordings go to the Pocket Scribe folder in your Drive. Pocket Scribe Desktop on your PC picks them up from there.")
        connect = SimpleUi.primaryButton(this, "Connect Google Drive") {
            accountCandidate = prefs.getString("account", "").orEmpty()
            if (accountCandidate.isNotBlank()) authorize()
            else chooseAccount.launch(AccountManager.newChooseAccountIntent(null, null, arrayOf("com.google"), null, null, null, null))
        }
        drive.addView(connect, LinearLayout.LayoutParams(-1, SimpleUi.dp(this, 60)).apply { bottomMargin = SimpleUi.dp(this@SettingsActivity, 10) })
        backupStatus = drive.note("")
        retryBackup = drive.action("Try backup now") { UploadWorker.kick(this); showMessage("Checking for files to back up.") }

        val recordings = card("Recordings")
        recordings.action("Local recordings") { startActivity(Intent(this, RecordingsActivity::class.java)) }
        recordings.note("Play a recording or share a copy from this phone.")
        recordings.toggle("Back up on Wi-Fi only", prefs.getBoolean("wifiOnly", true)) { checked ->
            prefs.edit().putBoolean("wifiOnly", checked).apply()
            UploadWorker.schedulePeriodic(this@SettingsActivity)
            androidx.work.WorkManager.getInstance(this@SettingsActivity).cancelUniqueWork("upload-now")
                .result.addListener({ UploadWorker.kick(this@SettingsActivity) }, ContextCompat.getMainExecutor(this@SettingsActivity))
        }
        recordings.note("Turn off to allow mobile data.")
        recordings.toggle("Keep phone copies", !prefs.getBoolean("deleteConfirmed", false)) { keep ->
            prefs.edit().putBoolean("deleteConfirmed", !keep).apply()
            if (!keep) Thread { SegmentStore(this@SettingsActivity).cleanupConfirmed() }.start()
        }
        recordings.note("Turn off to free phone space after each confirmed backup.")

        val look = card("Appearance")
        val themes = SimpleUi.segmentGroup(this)
        val current = prefs.getString("theme", "system")
        listOf("system" to "System", "light" to "Light", "dark" to "Dark").forEach { (key, label) ->
            val option = RadioButton(this).apply { id = View.generateViewId(); text = label; textSize = 15f; tag = key }
            SimpleUi.segment(this, option)
            themes.addView(option, RadioGroup.LayoutParams(0, SimpleUi.dp(this, 44), 1f))
            if (key == current) themes.check(option.id)
        }
        themes.setOnCheckedChangeListener { group, id ->
            val key = group.findViewById<RadioButton>(id)?.tag as? String ?: return@setOnCheckedChangeListener
            if (key != prefs.getString("theme", "system")) { prefs.edit().putString("theme", key).apply(); recreate() }
        }
        look.addView(themes, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = SimpleUi.dp(this@SettingsActivity, 6) })
        look.note("System follows your phone's dark mode.")

        val tips = card("Recording tips")
        tips.line("Start recording, then press the power button to switch the screen off. Wake the phone to stop, or use the recording notification.")
        tips.line("Files are saved about every two minutes. After a restart, open Pocket Scribe and start recording again.")
        tips.action("Phone battery settings") {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
        tips.note("If recording stops with the screen off, allow unrestricted battery use for Pocket Scribe.")

        val help = card("Help")
        val details = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        help.action("Phone details") {
            details.visibility = if (details.visibility == View.GONE) View.VISIBLE else View.GONE
        }
        help.addView(details)
        details.addView(SimpleUi.text(this, "${Build.MANUFACTURER} ${Build.MODEL}\nAndroid ${Build.VERSION.RELEASE}\n" +
            "${SegmentStore(this).summary()}\n\nRecording: ${RecordingService.status}\n\n" +
            "${prefs.getString("uploadStatus", "Drive has not been set up.")}", 14f).apply {
                setTextIsSelectable(true); setPadding(0, 0, 0, SimpleUi.dp(this@SettingsActivity, 8))
            })
        help.action("Google connection help") { connectionHelp() }
        refresh()
    }
    private fun refresh() {
        val name = prefs.getString("account", "").orEmpty()
        account.text = name.ifBlank { "Not connected yet" }
        connect.text = if (name.isBlank()) "Connect Google Drive" else "Reconnect Google Drive"
        connect.isEnabled = true
        retryBackup.visibility = if (name.isBlank()) View.GONE else View.VISIBLE
        backupStatus.text = if (name.isBlank()) "Connect once. Backups run automatically." else when (prefs.getString("backupState", "")) {
            "attention", "auth_needed" -> "Backup needs attention. Phone copies are kept."
            "uploading" -> "Backing up your files."
            "ok" -> "Last backup confirmed."
            else -> "Connect once. Backups run automatically."
        }
    }
    private fun authorize() {
        connect.isEnabled = false
        Identity.getAuthorizationClient(this).authorize(UploadWorker.request(accountCandidate))
            .addOnSuccessListener { result ->
                if (result.hasResolution()) {
                    authorization.launch(IntentSenderRequest.Builder(result.pendingIntent!!.intentSender).build())
                    connect.isEnabled = true
                } else if (!result.accessToken.isNullOrBlank()) connected()
                else failed(IllegalStateException("Drive access was not granted"))
            }.addOnFailureListener { failed(it) }
    }
    private fun connected() {
        prefs.edit().putString("account", accountCandidate).putString("backupState", "connected")
            .putString("uploadStatus", "Drive connected; backups queued.").apply()
        UploadWorker.kick(this); refresh(); showMessage("Google Drive connected.")
    }
    private fun failed(error: Exception) {
        prefs.edit().putString("uploadStatus", "Drive connection failed: ${error.localizedMessage}").putString("backupState", "attention").apply()
        refresh()
        AlertDialog.Builder(this).setTitle("Couldn't connect to Drive")
            .setMessage("Your recordings stay on this phone. Check your internet connection. If this is the first setup, open Google connection help.")
            .setPositiveButton("Connection help") { _, _ -> connectionHelp() }.setNegativeButton("Close", null).show()
    }
    @Suppress("DEPRECATION")
    private fun connectionHelp() {
        val info = packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNATURES)
        val sha = MessageDigest.getInstance("SHA-1").digest(info.signatures!![0].toByteArray())
            .joinToString(":") { "%02X".format(it.toInt() and 255) }
        val appDetails = "Package: $packageName\nSHA-1: $sha"
        AlertDialog.Builder(this).setTitle("One-time Google setup")
            .setMessage("In your own Google Cloud project, enable the Google Drive API, add your email as an OAuth test user, and register an Android client using these app details. Add the drive.file scope. Then return here and connect. No Play Store listing is needed.\n\n$appDetails")
            .setPositiveButton("Copy app details") { _, _ ->
                (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Pocket Scribe", appDetails))
                showMessage("App details copied.")
            }.setNeutralButton("Google Cloud") { _, _ -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://console.cloud.google.com/"))) }
            .setNegativeButton("Close", null).show()
    }
    private fun showMessage(message: String) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); refresh() }
    override fun onSaveInstanceState(outState: Bundle) { outState.putString("accountCandidate", accountCandidate); super.onSaveInstanceState(outState) }
}
