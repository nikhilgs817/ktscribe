package com.example.voicecam

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
import java.io.File
import java.io.IOException

class UploadProtocolTest {
    @Test fun driveRangeIsInclusive() {
        assertEquals(1_048_576L, DriveApi.receivedOffset("bytes=0-1048575"))
    }
    @Test fun emptyProbeMeansNoAcknowledgedBytes() {
        assertEquals(0L, DriveApi.receivedOffset(null))
    }
    private fun media() = File.createTempFile("voicecam", ".mp4").apply {
        deleteOnExit(); writeBytes(ByteArray(1_300_000) { (it % 251).toByte() })
    }
    private fun remote(file: File, checksum: String = md5(file)) = JSONObject().put("id", "file1")
        .put("size", file.length().toString()).put("md5Checksum", checksum).toString()
    private fun reply(code: Int, body: String = "", location: String? = null, range: String? = null) =
        DriveReply(code, body, location, range)
    private val session = "https://www.googleapis.com/upload/drive/v3/files?upload_id=one"
    private fun upload(api: DriveApi, file: File, url: String = "", save: (String) -> Unit = {}) =
        api.ensureUploaded(file, "file1", "recording.mp4", "video/mp4", "folder1", url, JSONObject(), save)

    @Test fun largeUploadUsesAcknowledgedOffsetsAndVerifiesCompletion() {
        val file = media()
        val ranges = mutableListOf<String>()
        var posts = 0
        val api = DriveApi("test", { false }) { method, _, headers, _ ->
            when (method) {
                "GET" -> reply(404)
                "POST" -> { posts++; reply(200, location = session) }
                else -> {
                    ranges.add(headers.getValue("Content-Range"))
                    if (ranges.size == 1) reply(308, range = "bytes=0-1048575") else reply(200, remote(file))
                }
            }
        }
        var saved = ""
        upload(api, file, save = { saved = it })
        assertEquals(1, posts)
        assertEquals(session, saved)
        assertEquals(listOf("bytes 0-1048575/1300000", "bytes 1048576-1299999/1300000"), ranges)
    }
    @Test fun interruptedUploadProbesServerAndResumesWithoutNewFile() {
        val file = media()
        var puts = 0
        val api = DriveApi("test", { false }) { method, _, headers, bytes ->
            when (method) {
                "GET" -> reply(404)
                "POST" -> error("Must not create a duplicate upload")
                else -> {
                    puts++
                    if (puts == 1) {
                        assertEquals("bytes */1300000", headers["Content-Range"])
                        assertEquals(0, bytes!!.size)
                        reply(308, range = "bytes=0-1048575")
                    } else {
                        assertEquals("bytes 1048576-1299999/1300000", headers["Content-Range"])
                        reply(200, remote(file))
                    }
                }
            }
        }
        upload(api, file, session)
        assertEquals(2, puts)
    }
    @Test fun existingVerifiedFileAvoidsDuplicateAfterLostFinalResponse() {
        val file = media()
        var calls = 0
        val api = DriveApi("test", { false }) { method, _, _, _ ->
            calls++; assertEquals("GET", method); reply(200, remote(file))
        }
        upload(api, file, session)
        assertEquals(1, calls)
    }
    @Test fun wrongRemoteChecksumPreventsConfirmation() {
        val file = media()
        val api = DriveApi("test", { false }) { _, _, _, _ -> reply(200, remote(file, "0".repeat(32))) }
        try { upload(api, file); fail("Mismatch must not be confirmed") } catch (_: IOException) { }
        assertTrue(file.exists())
    }
    @Test fun expiredSessionIsReplacedUsingSamePreallocatedId() {
        val file = media()
        val saved = mutableListOf<String>()
        var puts = 0
        val api = DriveApi("test", { false }) { method, _, _, bytes ->
            when (method) {
                "GET" -> reply(404)
                "POST" -> {
                    assertEquals("file1", JSONObject(String(bytes!!)).getString("id"))
                    reply(200, location = session)
                }
                else -> {
                    puts++
                    when (puts) {
                        1 -> reply(404)
                        2 -> reply(308, range = "bytes=0-1048575")
                        else -> reply(200, remote(file))
                    }
                }
            }
        }
        upload(api, file, session, saved::add)
        assertEquals(listOf("", session), saved)
    }
    @Test fun stoppedWorkerSendsNoMoreNetworkRequests() {
        val api = DriveApi("test", { true }) { _, _, _, _ -> error("Network should not be called") }
        try { upload(api, media()); fail("Stopped upload must defer") } catch (_: IOException) { }
    }
}
