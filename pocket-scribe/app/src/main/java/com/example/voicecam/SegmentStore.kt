package com.example.voicecam

import android.content.Context
import android.media.MediaMetadataRetriever
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

/** Each segment is journaled BEFORE capture. Only finalized media is eligible for upload. */
class SegmentStore(context: Context) {
    val root = File(context.filesDir, "recordings").apply { mkdirs() }
    companion object { private val lock = Any() }

    fun sessionFile(id: String): File {
        require(UUID.fromString(id).toString() == id)
        return File(root, "$id/session.json")
    }
    fun beginSession(id: String, video: Boolean) {
        sessionFile(id).parentFile!!.mkdirs()
        write(sessionFile(id), JSONObject().put("sessionId", id).put("video", video)
            .put("state", "recording").put("startedAt", Instant.now().toString()))
    }
    fun endSession(id: String) {
        val file = sessionFile(id)
        if (!file.exists()) return
        val session = read(file)
        if (session.optString("state") != "recording") return
        session.put("state", if (parts(id).isNotEmpty()) "awaiting_name" else "interrupted")
            .put("endedAt", Instant.now().toString())
        write(file, session)
    }
    fun sessions(): List<File> = root.listFiles()?.filter { it.isDirectory }?.map { File(it, "session.json") }
        ?.filter { it.exists() }?.sortedByDescending { it.lastModified() } ?: emptyList()
    fun parts(id: String): List<File> = entries().filter {
        val value = read(it)
        value.optString("sessionId") == id && !value.optBoolean("finalCopy") &&
            value.optString("state") in listOf("ready", "uploaded") && media(it, value).exists()
    }.sortedBy { read(it).getInt("sequence") }
    fun pendingNames(): List<File> = sessions().filter { read(it).optString("state") in listOf("awaiting_name", "save_failed") }

    fun create(session: String, sequence: Int, video: Boolean): File = synchronized(lock) {
        val directory = File(root, session).apply { mkdirs() }
        val id = "%06d_%s".format(sequence, UUID.randomUUID().toString().take(8))
        val media = File(directory, "$id.${if (video) "mp4" else "m4a"}")
        write(File(directory, "$id.queue.json"), JSONObject().apply {
            put("schemaVersion", 1)
            put("sessionId", session)
            put("sequence", sequence)
            put("mode", if (video) "audio_video" else "audio_only")
            put("mediaFile", media.name)
            put("startedAt", Instant.now().toString())
            put("state", "recording")
            put("backupPart", true)
        })
        media
    }

    fun journal(media: File) = File(media.parentFile, media.nameWithoutExtension + ".queue.json")
    fun read(file: File): JSONObject = synchronized(lock) {
        AtomicFile(file).openRead().bufferedReader().use { JSONObject(it.readText()) }
    }
    fun write(file: File, value: JSONObject) = synchronized(lock) {
        val atomic = AtomicFile(file)
        val stream = atomic.startWrite()
        try {
            stream.write(value.toString(2).toByteArray(Charsets.UTF_8))
            atomic.finishWrite(stream)
        } catch (e: Exception) { atomic.failWrite(stream); throw e }
    }
    fun media(file: File, item: JSONObject) = File(file.parentFile, item.getString("mediaFile"))
    fun entries(): List<File> = synchronized(lock) {
        root.walkTopDown().filter { it.isFile && it.name.endsWith(".queue.json") }.sortedBy { it.path }.toList()
    }
    fun finalize(media: File, failure: String? = null) {
        val file = journal(media)
        val item = read(file)
        val duration = try {
            val retriever = MediaMetadataRetriever()
            try {
                retriever.setDataSource(media.absolutePath)
                retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0
            } finally { retriever.release() }
        } catch (_: Exception) { 0L }
        if (!item.has("endedAt")) item.put("endedAt", Instant.now().toString())
        item.put("durationMs", duration)
        if (failure == null && duration > 0 && media.length() > 0) {
            item.put("sizeBytes", media.length())
            item.put("state", "ready")
        } else {
            item.put("state", "interrupted")
            item.put("error", failure ?: "No playable media found; retained locally for recovery.")
        }
        write(file, item)
    }
    fun recoverAbandoned() {
        // Upgrade v0.3 drafts in place; do not strand recordings made before sessions had names.
        root.listFiles()?.filter { it.isDirectory && !File(it, "session.json").exists() }?.forEach { directory ->
            runCatching {
                val old = directory.listFiles()?.firstOrNull { it.name.endsWith(".queue.json") } ?: return@runCatching
                val item = read(old)
                val id = item.getString("sessionId")
                write(sessionFile(id), JSONObject().put("sessionId", id).put("video", item.optString("mode") == "audio_video")
                    .put("state", "recording").put("startedAt", item.getString("startedAt")))
            }
        }
        entries().forEach { file ->
            val item = read(file)
            if (item.optString("state") == "recording") {
                // Never assume a file left open by a killed recorder is complete.
                item.put("state", "interrupted")
                item.put("error", "Recording process ended unexpectedly; retained for recovery.")
                write(file, item)
            }
        }
        sessions().forEach { file ->
            if (read(file).optString("state") == "recording") endSession(read(file).getString("sessionId"))
        }
    }
    fun summary(): String {
        val states = entries().map { runCatching { read(it).optString("state") }.getOrDefault("unreadable") }
        return "${states.count { it == "ready" }} waiting · ${states.count { it == "uploaded" }} backed up · " +
            "${states.count { it == "interrupted" || it == "unreadable" }} need recovery"
    }
    fun cleanupConfirmed() {
        entries().forEach { file ->
            val item = read(file)
            if (item.optString("state") == "uploaded") {
                // Keep every source part until a named, assembled final copy is also backed up.
                if (!item.optBoolean("finalCopy")) {
                    val session = sessionFile(item.getString("sessionId"))
                    if (!session.exists()) return@forEach
                    val finalPath = read(session).optString("finalJournal")
                    if (finalPath.isBlank()) return@forEach
                    val finalJournal = File(session.parentFile, finalPath)
                    if (!finalJournal.exists() || read(finalJournal).optString("state") != "uploaded") return@forEach
                }
                val media = media(file, item)
                if (media.exists() && !media.delete()) return@forEach
                // Keep a tiny receipt so sequence/history survives local media cleanup.
                if (!item.optBoolean("localMediaRemoved")) {
                    item.put("localMediaRemoved", true)
                    write(file, item)
                }
            }
        }
    }
    fun sidecar(item: JSONObject): JSONObject = JSONObject().apply {
        listOf("schemaVersion", "sessionId", "sequence", "mode", "mediaFile", "startedAt", "endedAt",
            "durationMs", "sizeBytes", "md5", "driveId").forEach { key -> put(key, item.get(key)) }
        put("segmentBoundaryNote", "Capture restarts between segments; short gaps are possible.")
        listOf("recordingName", "finalCopy", "backupPart").forEach { key -> if (item.has(key)) put(key, item.get(key)) }
    }
}

fun md5(file: File): String {
    val digest = MessageDigest.getInstance("MD5")
    file.inputStream().use { input ->
        val buffer = ByteArray(256 * 1024)
        while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
    }
    return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
}
