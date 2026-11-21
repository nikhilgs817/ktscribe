package com.example.voicecam

import android.accounts.Account
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.work.*
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Tasks
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock

class UploadWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    companion object {
        const val SCOPE = "https://www.googleapis.com/auth/drive.file"
        private val uploadLock = ReentrantLock()
        fun request(account: String) = AuthorizationRequest.builder()
            .setAccount(Account(account, "com.google")).setRequestedScopes(listOf(Scope(SCOPE))).build()
        private fun constraints(context: Context): Constraints = Constraints.Builder()
            .setRequiredNetworkType(if (context.getSharedPreferences("settings", 0).getBoolean("wifiOnly", true))
                NetworkType.UNMETERED else NetworkType.CONNECTED).build()
        fun kick(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork("upload-now", ExistingWorkPolicy.APPEND_OR_REPLACE,
                OneTimeWorkRequestBuilder<UploadWorker>().setConstraints(constraints(context))
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
        }
        fun schedulePeriodic(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("upload-periodic", ExistingPeriodicWorkPolicy.UPDATE,
                PeriodicWorkRequestBuilder<UploadWorker>(15, TimeUnit.MINUTES).setConstraints(constraints(context)).build())
        }
    }
    override fun doWork(): Result {
        if (!uploadLock.tryLock()) return Result.retry()
        try { return upload() } finally { uploadLock.unlock() }
    }
    private fun upload(): Result {
        val prefs = applicationContext.getSharedPreferences("settings", 0)
        val store = SegmentStore(applicationContext)
        val pending = store.entries().filter { store.read(it).optString("state") == "ready" }
        if (pending.isEmpty()) return Result.success()
        val account = prefs.getString("account", "").orEmpty()
        if (account.isBlank()) { report("Connect Google Drive in Pocket Scribe. Recordings are safe on the phone."); return Result.success() }
        var token = ""
        try {
            val auth = Tasks.await(Identity.getAuthorizationClient(applicationContext).authorize(request(account)), 60, TimeUnit.SECONDS)
            if (auth.hasResolution() || auth.accessToken.isNullOrBlank()) {
                report("Google Drive needs your approval. Open Pocket Scribe and tap Connect Google Drive.")
                return Result.success()
            }
            token = auth.accessToken!!
            prefs.edit().putString("backupState", "uploading").apply()
            val api = DriveApi(token, { isStopped })
            var folder = prefs.getString("folderId", "").orEmpty()
            if (folder.isBlank() || api.get(folder)?.optBoolean("trashed") != false) {
                folder = api.folder(); prefs.edit().putString("folderId", folder).apply()
            }
            var backupFolder = prefs.getString("backupFolderId", "").orEmpty()
            if (pending.any { store.read(it).optBoolean("backupPart") } &&
                (backupFolder.isBlank() || prefs.getString("backupParent", "") != folder || api.get(backupFolder)?.optBoolean("trashed") != false)) {
                backupFolder = api.folder("backup-parts-v1", "Live backups", folder)
                prefs.edit().putString("backupFolderId", backupFolder).putString("backupParent", folder).apply()
            }
            val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(7)
            for (file in pending) {
                if (isStopped) return Result.retry()
                if (System.nanoTime() > deadline) { kick(applicationContext); return Result.success() }
                val item = store.read(file)
                val media = store.media(file, item)
                if (!media.isFile) { report("A queued phone file is missing. Restore it before retrying."); return Result.failure() }
                if (item.optString("uploadAccount").isNotBlank() && item.getString("uploadAccount") != account) {
                    report("Reconnect the original Google account to resume this recording."); return Result.success()
                }
                item.put("uploadAccount", account)
                if (!item.has("md5")) item.put("md5", md5(media))
                if (!item.has("driveId")) item.put("driveId", api.generateId())
                if (!item.has("sidecarDriveId")) item.put("sidecarDriveId", api.generateId())
                store.write(file, item)
                val properties = JSONObject().put("sessionId", item.getString("sessionId"))
                    .put("sequence", item.getInt("sequence").toString()).put("mode", item.getString("mode"))
                val cloudName = if (item.optBoolean("finalCopy")) media.name else item.getString("sessionId") + "_" + media.name
                val destination = if (item.optBoolean("backupPart")) backupFolder else folder
                api.ensureUploaded(media, item.getString("driveId"), cloudName,
                    if (media.extension == "mp4") "video/mp4" else "audio/mp4", destination,
                    item.optString("uploadUrl"), properties) { url -> item.put("uploadUrl", url); store.write(file, item) }
                // Upload the sidecar last: the Windows importer treats it as the commit marker.
                val sidecar = File(file.parentFile, media.nameWithoutExtension + ".json")
                val publicMetadata = store.sidecar(item).put("mediaFile", cloudName)
                sidecar.writeText(publicMetadata.toString(2), Charsets.UTF_8)
                api.ensureUploaded(sidecar, item.getString("sidecarDriveId"), cloudName.substringBeforeLast('.') + ".json",
                    "application/json", destination, item.optString("sidecarUploadUrl"), properties) { url ->
                    item.put("sidecarUploadUrl", url); store.write(file, item)
                }
                item.put("state", "uploaded").put("uploadedAt", Instant.now().toString())
                item.remove("uploadUrl"); item.remove("sidecarUploadUrl")
                store.write(file, item)
                sidecar.delete()
                prefs.edit().putString("uploadStatus", "Backed up segment ${item.getInt("sequence")} at ${Instant.now()}")
                    .putString("backupState", "ok").apply()
                if (prefs.getBoolean("deleteConfirmed", false)) store.cleanupConfirmed()
            }
            (applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(43)
            return Result.success()
        } catch (e: Exception) {
            if (e is DriveHttpError && e.code == 401 && token.isNotBlank()) {
                runCatching { Tasks.await(Identity.getAuthorizationClient(applicationContext)
                    .clearToken(ClearTokenRequest.builder().setToken(token).build()), 30, TimeUnit.SECONDS) }
            }
            report(if (e is DriveHttpError && e.code == 403) "Drive refused upload (${e.detail}). Check Drive space and account setup. Phone copies retained."
                else "Upload paused: ${e.localizedMessage?.take(140)}. Phone copies retained; retry queued.")
            return Result.retry()
        }
    }
    private fun report(message: String) {
        applicationContext.getSharedPreferences("settings", 0).edit().putString("uploadStatus", message)
            .putString("backupState", "attention").apply()
        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(NotificationChannel("uploads", "Upload attention", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(applicationContext, 3, Intent(applicationContext, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        runCatching {
            manager.notify(43, NotificationCompat.Builder(applicationContext, "uploads")
                .setSmallIcon(android.R.drawable.stat_sys_upload).setContentTitle("Pocket Scribe sync needs attention")
                .setContentText(message).setStyle(NotificationCompat.BigTextStyle().bigText(message))
                .setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(true).build())
        }
    }
}
