package com.example.voicecam

import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class DriveHttpError(val code: Int, val detail: String) : IOException("Drive returned $code: $detail")
data class DriveReply(val code: Int, val body: String, val location: String?, val range: String?)

/** HTTPS only. Session URL is private journal data, never part of desktop sidecars/logging. */
class DriveApi(
    private val token: String,
    private val stopped: () -> Boolean,
    private val transport: ((String, String, Map<String, String>, ByteArray?) -> DriveReply)? = null
) {
    companion object {
        const val BASE = "https://www.googleapis.com/drive/v3"
        fun receivedOffset(range: String?): Long = range?.substringAfterLast('-')?.toLongOrNull()?.plus(1) ?: 0L
    }
    private fun call(method: String, address: String, headers: Map<String, String> = emptyMap(), bytes: ByteArray? = null): DriveReply {
        if (stopped()) throw IOException("Upload stopped; will resume later")
        val url = URL(address)
        require(url.protocol == "https" && url.host == "www.googleapis.com") { "Unexpected upload endpoint" }
        transport?.let { return it(method, address, headers, bytes) }
        val connection = url.openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = method
            connection.connectTimeout = 30_000; connection.readTimeout = 60_000
            connection.setRequestProperty("Authorization", "Bearer $token")
            headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            if (bytes != null) {
                connection.doOutput = true; connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val code = connection.responseCode
            val body = (if (code >= 400) connection.errorStream else connection.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
            return DriveReply(code, body, connection.getHeaderField("Location"), connection.getHeaderField("Range"))
        } finally { connection.disconnect() }
    }
    private fun checked(reply: DriveReply): JSONObject {
        if (reply.code !in 200..299) throw DriveHttpError(reply.code, safeDetail(reply.body))
        return JSONObject(reply.body.ifBlank { "{}" })
    }
    private fun safeDetail(body: String): String = runCatching {
        val error = JSONObject(body).getJSONObject("error")
        val reason = error.optJSONArray("errors")?.optJSONObject(0)?.optString("reason")
        reason?.takeIf { it.isNotBlank() } ?: error.optString("status", "request failed")
    }.getOrDefault("request failed")

    fun generateId(): String = checked(call("GET", "$BASE/files/generateIds?count=1&space=drive&type=files"))
        .getJSONArray("ids").getString(0)
    fun get(id: String): JSONObject? {
        val reply = call("GET", "$BASE/files/$id?fields=id,size,md5Checksum,trashed")
        if (reply.code == 404) return null
        return checked(reply)
    }
    fun folder(marker: String = "v1", name: String = "Pocket Scribe", parent: String? = null): String {
        val query = "trashed = false and mimeType = 'application/vnd.google-apps.folder' and " +
            "appProperties has { key='voicecamRoot' and value='$marker' }" +
            (if (parent != null) " and '$parent' in parents" else "")
        val result = checked(call("GET", "$BASE/files?q=${URLEncoder.encode(query, "UTF-8")}&fields=files(id)&pageSize=100"))
        val folders = result.getJSONArray("files")
        if (folders.length() > 0) return folders.getJSONObject(0).getString("id")
        val metadata = JSONObject().put("name", name).put("mimeType", "application/vnd.google-apps.folder")
            .put("appProperties", JSONObject().put("voicecamRoot", marker))
        if (parent != null) metadata.put("parents", org.json.JSONArray().put(parent))
        return checked(call("POST", "$BASE/files?fields=id", mapOf("Content-Type" to "application/json"),
            metadata.toString().toByteArray())).getString("id")
    }
    fun ensureUploaded(
        file: File, id: String, name: String, mime: String, folder: String,
        sessionUrl: String, properties: JSONObject,
        saveUrl: (String) -> Unit
    ) {
        val existing = get(id)
        if (existing != null) { verify(file, existing); return }
        var url = sessionUrl
        var offset = 0L
        if (url.isNotBlank()) {
            val probe = call("PUT", url, mapOf("Content-Range" to "bytes */${file.length()}"), byteArrayOf())
            when {
                probe.code in 200..299 -> { verify(file, checked(probe)); return }
                probe.code == 308 -> offset = receivedOffset(probe.range)
                probe.code == 404 || probe.code == 410 -> { url = ""; saveUrl("") }
                else -> throw DriveHttpError(probe.code, safeDetail(probe.body))
            }
        }
        if (url.isBlank()) {
            val metadata = JSONObject().put("id", id).put("name", name).put("mimeType", mime)
                .put("parents", org.json.JSONArray().put(folder)).put("appProperties", properties)
            val reply = call("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,md5Checksum,trashed",
                mapOf("Content-Type" to "application/json; charset=UTF-8", "X-Upload-Content-Type" to mime,
                    "X-Upload-Content-Length" to file.length().toString()), metadata.toString().toByteArray())
            if (reply.code == 409) {
                val remote = get(id) ?: throw IOException("Waiting for prior upload confirmation")
                verify(file, remote); return
            }
            checked(reply)
            url = reply.location ?: throw IOException("Missing resumable upload location")
            saveUrl(url)
        }
        RandomAccessFile(file, "r").use { input ->
            while (offset < input.length()) {
                if (stopped()) throw IOException("Upload stopped; will resume later")
                input.seek(offset)
                val count = minOf(1024L * 1024, input.length() - offset).toInt()
                val bytes = ByteArray(count); input.readFully(bytes)
                val reply = call("PUT", url, mapOf("Content-Type" to mime,
                    "Content-Range" to "bytes $offset-${offset + count - 1}/${input.length()}"), bytes)
                when {
                    reply.code in 200..299 -> { verify(file, checked(reply)); return }
                    reply.code == 308 -> {
                        val next = receivedOffset(reply.range)
                        if (next <= offset || next > input.length()) throw IOException("Invalid upload progress")
                        offset = next
                    }
                    reply.code == 404 || reply.code == 410 -> { saveUrl(""); throw IOException("Upload session expired; retry queued") }
                    else -> throw DriveHttpError(reply.code, safeDetail(reply.body))
                }
            }
        }
        verify(file, get(id) ?: throw IOException("Waiting for upload confirmation"))
    }
    private fun verify(file: File, remote: JSONObject) {
        if (remote.optBoolean("trashed")) throw IOException("Drive copy is in Trash; restore it before retrying")
        if (remote.optString("size").toLongOrNull() != file.length() || remote.optString("md5Checksum") != md5(file)) {
            throw IOException("Drive verification mismatch; phone copy retained")
        }
    }
}
