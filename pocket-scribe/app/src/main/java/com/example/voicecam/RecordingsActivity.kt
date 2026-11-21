package com.example.voicecam

import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.core.content.FileProvider
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** One-tap access from Settings to the actual app-owned recordings folder. */
class RecordingsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState) }
    override fun onResume() { super.onResume(); showFiles() }
    private fun showFiles() {
        val root = SimpleUi.screen(this)
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(SimpleUi.quietButton(this, "Back") { finish() })
        header.addView(SimpleUi.text(this, "Local recordings", 23f, true)); root.addView(header)
        val store = SegmentStore(this)
        var found = false
        for (sessionFile in store.sessions()) {
            val session = store.read(sessionFile)
            val state = session.optString("state")
            if (state in listOf("awaiting_name", "save_failed", "finalizing")) {
                found = true
                root.addView(SimpleUi.text(this, session.optString("name").ifBlank { "Unnamed recording" }, 18f, true))
                root.addView(SimpleUi.text(this, if (state == "finalizing") "Saving final copy…" else "Original files are kept on this phone.", 14f))
                if (state != "finalizing") root.addView(SimpleUi.quietButton(this, "Name & save") {
                    startActivity(Intent(this, MainActivity::class.java).putExtra("nameSession", session.getString("sessionId")))
                })
                continue
            }
            val finalName = session.optString("finalJournal")
            if (finalName.isBlank()) continue
            val journal = java.io.File(sessionFile.parentFile, finalName)
            if (!journal.exists()) continue
            val item = store.read(journal)
            val media = store.media(journal, item)
            found = true
            root.addView(SimpleUi.text(this, item.optString("recordingName", media.name), 18f, true).apply {
                setPadding(0, SimpleUi.dp(this@RecordingsActivity, 20), 0, 0)
            })
            val date = runCatching { DateTimeFormatter.ofPattern("MMM d, h:mm a").withZone(ZoneId.systemDefault())
                .format(Instant.parse(item.getString("startedAt"))) }.getOrDefault("")
            root.addView(SimpleUi.text(this, "$date · ${if (item.optString("mode") == "audio_video") "Audio + video" else "Audio only"}", 14f))
            val syncLabel = when (item.optString("state")) {
                "uploaded" -> "Uploaded to Google Drive"
                "ready" -> "Waiting for Google Drive sync"
                else -> "Saved on this phone"
            }
            root.addView(SimpleUi.text(this, syncLabel, 13f))
            if (media.exists()) {
                val uri = FileProvider.getUriForFile(this, "$packageName.files", media)
                val mime = if (media.extension == "mp4") "video/mp4" else "audio/mp4"
                val actions = LinearLayout(this)
                actions.addView(SimpleUi.quietButton(this, "Play") {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)) }.onFailure { toast("No player is installed for this file.") }
                })
                actions.addView(SimpleUi.quietButton(this, "Share / save a copy") {
                    startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType(mime)
                        .putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Save or share recording"))
                })
                root.addView(actions)
            } else root.addView(SimpleUi.text(this, "Phone copy removed after backup. Available in Google Drive.", 14f))
        }
        if (!found) root.addView(SimpleUi.text(this, "Your named recordings will appear here.", 16f))
    }
    private fun toast(value: String) { Toast.makeText(this, value, Toast.LENGTH_LONG).show() }
}
