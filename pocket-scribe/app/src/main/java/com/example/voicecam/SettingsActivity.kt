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
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        accountCandidate = savedInstanceState?.getString("accountCandidate").orEmpty()
        val root = SimpleUi.screen(this)
        fun space(amount: Int = 20) { root.addView(View(this), LinearLayout.LayoutParams(1, SimpleUi.dp(this, amount))) }
        fun text(value: String, size: Float = 15f, bold: Boolean = false): TextView = SimpleUi.text(this, value, size, bold).also {
            root.addView(it); it.setPadding(0, 0, 0, SimpleUi.dp(this, 8))
        }
        fun button(value: String, action: () -> Unit) = SimpleUi.quietButton(this, value, action).also { root.addView(it) }
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(SimpleUi.quietButton(this, "Back") { finish() })
        header.addView(SimpleUi.text(this, "Settings", 24f, bold = true))
        root.addView(header); space()
        button("Local recordings") { startActivity(Intent(this, RecordingsActivity::class.java)) }
        text("Play recordings or share a copy from this phone.", 13f)
        space(12)
        text("Google Drive", 20f, true)
        account = text("")
        text("Finished recordings sync to Google Drive automatically. Open Phone recordings in KT Scribe on your PC to process them.")
        connect = SimpleUi.primaryButton(this, "Connect Google Drive") {
            accountCandidate = prefs.getString("account", "").orEmpty()
            if (accountCandidate.isNotBlank()) authorize()
            else chooseAccount.launch(AccountManager.newChooseAccountIntent(null, null, arrayOf("com.google"), null, null, null, null))
        }
        root.addView(connect, LinearLayout.LayoutParams(-1, SimpleUi.dp(this, 64)))
        backupStatus = text("")
        retryBackup = button("Try backup now") { UploadWorker.kick(this); showMessage("Checking for files to back up.") }
        space()
        text("Preferences", 20f, true)
        root.addView(Switch(this).apply {
            text = "Back up on Wi-Fi only"; textSize = 16f; minHeight = SimpleUi.dp(this@SettingsActivity, 56)
            isChecked = prefs.getBoolean("wifiOnly", true)
            setOnCheckedChangeListener { _, checked ->
                prefs.edit().putBoolean("wifiOnly", checked).apply()
                UploadWorker.schedulePeriodic(this@SettingsActivity)
                androidx.work.WorkManager.getInstance(this@SettingsActivity).cancelUniqueWork("upload-now")
                    .result.addListener({ UploadWorker.kick(this@SettingsActivity) }, ContextCompat.getMainExecutor(this@SettingsActivity))
            }
        })
        text("Uses unmetered networks. Turn off to allow mobile data.", 13f)
        root.addView(Switch(this).apply {
            text = "Keep phone copies"; textSize = 16f; minHeight = SimpleUi.dp(this@SettingsActivity, 56)
            isChecked = !prefs.getBoolean("deleteConfirmed", false)
            setOnCheckedChangeListener { _, keep ->
                prefs.edit().putBoolean("deleteConfirmed", !keep).apply()
                if (!keep) Thread { SegmentStore(this@SettingsActivity).cleanupConfirmed() }.start()
            }
        })
        text("Turn off to free phone space after each confirmed backup.", 13f)
        space()
        text("Using Pocket Scribe", 20f, true)
        text("Start recording, then use the power button to switch the screen off. Wake the phone to stop, or use the recording notification.")
        text("Files are saved about every two minutes. Brief gaps are possible between files. After a restart, open Pocket Scribe and start recording again.")
        button("Phone battery settings") {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
        text("If this phone stops recording with the screen off, allow unrestricted battery use for Pocket Scribe.", 13f)
        space(12)
        val details = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        button("Help & phone details") {
            details.visibility = if (details.visibility == View.GONE) View.VISIBLE else View.GONE
        }
        root.addView(details)
        details.addView(SimpleUi.text(this, "${Build.MANUFACTURER} ${Build.MODEL}\nAndroid ${Build.VERSION.RELEASE}\n" +
            "${SegmentStore(this).summary()}\n\nRecording: ${RecordingService.status}\n\n" +
            "${prefs.getString("uploadStatus", "Drive has not been set up.")}", 14f).apply { setTextIsSelectable(true) })
        details.addView(SimpleUi.quietButton(this, "Google connection help") { connectionHelp() })
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
