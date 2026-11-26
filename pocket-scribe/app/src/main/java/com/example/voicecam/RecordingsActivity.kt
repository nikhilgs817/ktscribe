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
    override fun attachBaseContext(newBase: android.content.Context) { super.attachBaseContext(SimpleUi.themed(newBase)) }
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState) }
    override fun onResume() { super.onResume(); showFiles() }
    private fun showFiles() {
        val root = SimpleUi.screen(this)
        root.addView(SimpleUi.header(this, "Recordings", back = true))
        val store = SegmentStore(this)
        var found = false
        fun card(): LinearLayout = SimpleUi.card(this).also {
            root.addView(it, LinearLayout.LayoutParams(-1, -2).apply { topMargin = SimpleUi.dp(this@RecordingsActivity, 12) })
        }
        fun LinearLayout.badgeRow(title: String, label: String, color: Int) {
            val row = LinearLayout(this@RecordingsActivity).apply { gravity = Gravity.CENTER_VERTICAL }
            row.addView(SimpleUi.text(this@RecordingsActivity, title, 17f, true), LinearLayout.LayoutParams(0, -2, 1f))
            row.addView(SimpleUi.badge(this@RecordingsActivity).also { SimpleUi.setBadge(it, label, color) })
            addView(row)
        }
        for (sessionFile in store.sessions()) {
            val session = store.read(sessionFile)
            val state = session.optString("state")
            if (state in listOf("awaiting_name", "save_failed", "finalizing")) {
                found = true
                val box = card()
                if (state == "finalizing") box.badgeRow(session.optString("name").ifBlank { "Unnamed recording" }, "WORKING", SimpleUi.INFO)
                else box.badgeRow(session.optString("name").ifBlank { "Unnamed recording" }, "YOUR TURN", SimpleUi.WARN)
                box.addView(SimpleUi.muted(this, if (state == "finalizing") "Saving final copy…" else "Original files are kept on this phone.", 14f))
                if (state != "finalizing") box.addView(SimpleUi.quietButton(this, "Name & save") {
                    startActivity(Intent(this, MainActivity::class.java).putExtra("nameSession", session.getString("sessionId")))
                }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = SimpleUi.dp(this@RecordingsActivity, 10) })
                continue
            }
            val finalName = session.optString("finalJournal")
            if (finalName.isBlank()) continue
            val journal = java.io.File(sessionFile.parentFile, finalName)
            if (!journal.exists()) continue
            val item = store.read(journal)
            val media = store.media(journal, item)
            found = true
            val box = card()
            when (item.optString("state")) {
                "uploaded" -> box.badgeRow(item.optString("recordingName", media.name), "ON DRIVE", SimpleUi.PASS)
                "ready" -> box.badgeRow(item.optString("recordingName", media.name), "SYNCING", SimpleUi.INFO)
                else -> box.badgeRow(item.optString("recordingName", media.name), "ON PHONE", SimpleUi.MUTED)
            }
            val date = runCatching { DateTimeFormatter.ofPattern("MMM d, h:mm a").withZone(ZoneId.systemDefault())
                .format(Instant.parse(item.getString("startedAt"))) }.getOrDefault("")
            box.addView(SimpleUi.muted(this, "$date · ${if (item.optString("mode") == "audio_video") "Audio + video" else "Audio only"}", 14f))
            if (media.exists()) {
                val uri = FileProvider.getUriForFile(this, "$packageName.files", media)
                val mime = if (media.extension == "mp4") "video/mp4" else "audio/mp4"
                val actions = LinearLayout(this).apply { setPadding(0, SimpleUi.dp(this@RecordingsActivity, 10), 0, 0) }
                actions.addView(SimpleUi.quietButton(this, "Play") {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)) }.onFailure { toast("No player is installed for this file.") }
                }, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = SimpleUi.dp(this@RecordingsActivity, 8) })
                actions.addView(SimpleUi.quietButton(this, "Share a copy") {
                    startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType(mime)
                        .putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Save or share recording"))
                })
                box.addView(actions)
            } else box.addView(SimpleUi.muted(this, "Phone copy removed after backup. It's in Google Drive.", 14f))
        }
        if (!found) root.addView(SimpleUi.muted(this, "Your named recordings will appear here.", 16f).apply {
            gravity = Gravity.CENTER; setPadding(0, SimpleUi.dp(this@RecordingsActivity, 48), 0, 0)
        })
    }
    private fun toast(value: String) { Toast.makeText(this, value, Toast.LENGTH_LONG).show() }
}
