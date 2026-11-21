package com.example.voicecam

import android.content.Context
import android.media.*
import androidx.work.*
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.time.Instant
import java.util.concurrent.TimeUnit

/** Copies encoded samples without re-encoding. Source parts survive failures and process death. */
class FinalizeWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    companion object {
        fun save(context: Context, id: String, title: String) {
            val store = SegmentStore(context)
            val file = store.sessionFile(id)
            val session = store.read(file)
            session.put("name", title.trim()).put("state", "finalizing").remove("saveError")
            store.write(file, session)
            WorkManager.getInstance(context).enqueueUniqueWork("finalize-$id", ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<FinalizeWorker>().setInputData(workDataOf("session" to id))
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
        }
    }
    override fun doWork(): Result {
        val store = SegmentStore(applicationContext)
        val id = inputData.getString("session") ?: return Result.failure()
        val sessionFile = store.sessionFile(id)
        val session = store.read(sessionFile)
        val title = session.getString("name")
        var temporary: File? = null
        try {
            val parts = store.parts(id)
            require(parts.isNotEmpty()) { "No complete recording files are available yet." }
            val source = parts.map { store.media(it, store.read(it)) }
            val stem = title.replace(Regex("[^A-Za-z0-9._-]+"), "_").trim('.', '_').take(70).ifBlank { "Recording" }
            val media = File(sessionFile.parentFile, "${stem}_${id.take(8)}.${if (session.getBoolean("video")) "mp4" else "m4a"}")
            val journal = store.journal(media)
            if (journal.exists() && store.read(journal).optString("state") in listOf("ready", "uploaded") && media.exists()) {
                session.put("state", "saved").put("finalJournal", journal.name)
                store.write(sessionFile, session); UploadWorker.kick(applicationContext); return Result.success()
            }
            val required = source.sumOf { it.length() } + RecordingService.RESERVE_BYTES
            check(store.root.usableSpace > required) { "Free up phone storage before saving the final copy." }
            temporary = File(media.parentFile, media.name + ".partial")
            temporary.delete()
            if (source.size == 1) source.first().inputStream().use { input -> temporary.outputStream().use { output ->
                val buffer = ByteArray(1024 * 1024)
                while (true) {
                    check(!isStopped) { "Save paused. The original files are kept." }
                    val count = input.read(buffer); if (count < 0) break
                    output.write(buffer, 0, count)
                }
            } } else combine(source, temporary)
            check(temporary.renameTo(media)) { "Couldn't finish saving the recording." }
            val first = store.read(parts.first())
            val last = store.read(parts.last())
            val item = JSONObject().put("schemaVersion", 1).put("sessionId", id)
                .put("sequence", last.getInt("sequence") + 1).put("mode", first.getString("mode"))
                .put("mediaFile", media.name).put("startedAt", first.getString("startedAt"))
                .put("endedAt", last.getString("endedAt")).put("recordingName", title)
                .put("finalCopy", true).put("backupPart", false).put("state", "finalizing")
            store.write(journal, item)
            store.finalize(media)
            check(store.read(journal).optString("state") == "ready") { "The final file could not be verified. Original files are kept." }
            session.put("state", "saved").put("finalJournal", journal.name).put("savedAt", Instant.now().toString())
            store.write(sessionFile, session)
            UploadWorker.kick(applicationContext)
            return Result.success()
        } catch (error: Exception) {
            temporary?.delete()
            if (isStopped) return Result.retry()
            session.put("state", "save_failed").put("saveError", error.localizedMessage ?: "Couldn't save. Original files are kept.")
            store.write(sessionFile, session)
            return Result.failure()
        }
    }
    private fun key(format: MediaFormat): String = format.getString(MediaFormat.KEY_MIME)!!.substringBefore('/')
    private fun compatible(a: MediaFormat, b: MediaFormat): Boolean {
        val values = listOf(MediaFormat.KEY_MIME, MediaFormat.KEY_WIDTH, MediaFormat.KEY_HEIGHT,
            MediaFormat.KEY_SAMPLE_RATE, MediaFormat.KEY_CHANNEL_COUNT)
        for (key in values) {
            if (a.containsKey(key) != b.containsKey(key)) return false
            if (a.containsKey(key)) {
                if (key == MediaFormat.KEY_MIME) { if (a.getString(key) != b.getString(key)) return false }
                else if (a.getInteger(key) != b.getInteger(key)) return false
            }
        }
        for (key in listOf("csd-0", "csd-1", "csd-2")) {
            val x = a.getByteBuffer(key)?.duplicate()
            val y = b.getByteBuffer(key)?.duplicate()
            if (x != y) return false
        }
        return true
    }
    private fun combine(files: List<File>, target: File) {
        val formats = linkedMapOf<String, MediaFormat>()
        val first = MediaExtractor()
        try {
            first.setDataSource(files.first().absolutePath)
            for (i in 0 until first.trackCount) {
                val format = first.getTrackFormat(i)
                if (key(format) in listOf("audio", "video")) formats[key(format)] = format
            }
        } finally { first.release() }
        check(formats.containsKey("audio")) { "The recording has no audio track." }
        val muxer = MediaMuxer(target.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var started = false
        try {
            val rotation = MediaMetadataRetriever()
            try {
                rotation.setDataSource(files.first().absolutePath)
                rotation.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull()?.let { muxer.setOrientationHint(it) }
            } finally { rotation.release() }
            val tracks = formats.mapValues { muxer.addTrack(it.value) }
            muxer.start(); started = true
            var offset = 0L
            val lastTimes = mutableMapOf<String, Long>()
            val buffer = ByteBuffer.allocateDirect(8 * 1024 * 1024)
            val info = MediaCodec.BufferInfo()
            for (file in files) {
                val extractor = MediaExtractor()
                try {
                    extractor.setDataSource(file.absolutePath)
                    val selected = mutableMapOf<Int, String>()
                    for (i in 0 until extractor.trackCount) {
                        val format = extractor.getTrackFormat(i)
                        val kind = key(format)
                        if (kind in formats) {
                            check(compatible(formats.getValue(kind), format)) { "Recording formats changed. Original files are kept." }
                            selected[i] = kind; extractor.selectTrack(i)
                        }
                    }
                    check(selected.values.toSet() == formats.keys) { "A recording part is missing an audio or video track." }
                    val origin = extractor.sampleTime.coerceAtLeast(0)
                    var end = offset
                    while (extractor.sampleTrackIndex >= 0) {
                        check(!isStopped) { "Save paused. Original files are kept." }
                        buffer.clear()
                        val size = extractor.readSampleData(buffer, 0)
                        if (size < 0) break
                        val kind = selected.getValue(extractor.sampleTrackIndex)
                        val time = (offset + extractor.sampleTime - origin).coerceAtLeast((lastTimes[kind] ?: -1) + 1)
                        val flags = if ((extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
                        info.set(0, size, time, flags)
                        muxer.writeSampleData(tracks.getValue(kind), buffer, info)
                        lastTimes[kind] = time
                        val frameDuration = if (kind == "audio") 1_024_000_000L / formats.getValue(kind).getInteger(MediaFormat.KEY_SAMPLE_RATE)
                            else 1_000_000L / (formats.getValue(kind).let { if (it.containsKey(MediaFormat.KEY_FRAME_RATE)) it.getInteger(MediaFormat.KEY_FRAME_RATE) else 30 }).coerceAtLeast(1)
                        end = maxOf(end, time + frameDuration)
                        extractor.advance()
                    }
                    offset = end
                } finally { extractor.release() }
            }
            muxer.stop(); started = false
        } finally { if (started) runCatching { muxer.stop() }; muxer.release() }
    }
}
