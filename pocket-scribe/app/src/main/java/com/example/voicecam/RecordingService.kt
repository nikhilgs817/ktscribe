package com.example.voicecam

import android.Manifest
import android.annotation.SuppressLint
import android.app.*
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.*
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.*
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import java.io.File
import java.util.UUID
import android.media.ImageReader
import android.graphics.ImageFormat

class RecordingService : LifecycleService() {
    companion object {
        const val START = "voicecam.START"
        const val STOP = "voicecam.STOP"
        const val CHANNEL = "recording"
        const val NOTICE = 42
        const val SEGMENT_MS = 120_000L
        const val RESERVE_BYTES = 128L * 1024 * 1024
        @Volatile var active = false
            private set
        @Volatile var status = "Ready"
            private set
        @Volatile var phase = "idle"
            private set
        @Volatile var sessionStarted = 0L
            private set
        @Volatile var lastSessionDuration = 0L
            private set
        @Volatile var lastStartRequest = 0L
            private set
        @Volatile var isVideo = false
            private set
        @Volatile var audioLevel = 0
            private set
        @Volatile var previewAvailable = true
            private set
        private var instance: RecordingService? = null
        private var screenPreview: Preview.SurfaceProvider? = null
        fun attachPreview(surface: Preview.SurfaceProvider?) {
            screenPreview = surface
            instance?.connectPreview()
        }
    }
    private val main = Handler(Looper.getMainLooper())
    private lateinit var store: SegmentStore
    private var session = ""
    private var sequence = 0
    private var wanted = false
    private var ending = false
    private var wake: PowerManager.WakeLock? = null
    private var provider: ProcessCameraProvider? = null
    private var capture: VideoCapture<Recorder>? = null
    private var preview: Preview? = null
    private val fallbackReaders = mutableSetOf<ImageReader>()
    private var video: Recording? = null
    private var audio: MediaRecorder? = null
    private var current: File? = null
    private val meter = object : Runnable {
        override fun run() {
            if (!wanted) return
            audioLevel = runCatching { audio?.maxAmplitude ?: 0 }.getOrDefault(0)
            main.postDelayed(this, 150)
        }
    }
    private val backgroundPreview = Preview.SurfaceProvider { request ->
        // A drained camera surface keeps preview demand independent of Activity/screen lifetime.
        val reader = ImageReader.newInstance(request.resolution.width, request.resolution.height, ImageFormat.PRIVATE, 2)
        fallbackReaders.add(reader)
        reader.setOnImageAvailableListener({ value -> runCatching { value.acquireLatestImage()?.close() } }, main)
        request.provideSurface(reader.surface, ContextCompat.getMainExecutor(this)) {
            fallbackReaders.remove(reader); reader.close()
        }
    }
    private fun connectPreview() { preview?.setSurfaceProvider(screenPreview ?: backgroundPreview) }
    private val rotate = Runnable {
        if (isVideo) video?.stop() else finishAudio(continueRecording = wanted)
    }
    private val monitor = object : Runnable {
        override fun run() {
            if (!wanted) return
            val power = getSystemService(POWER_SERVICE) as PowerManager
            if (store.root.usableSpace < RESERVE_BYTES) {
                stopSession("Stopped: phone storage is low. Pending recordings are retained.")
            } else if (Build.VERSION.SDK_INT >= 29 && power.currentThermalStatus >= PowerManager.THERMAL_STATUS_SEVERE) {
                stopSession("Stopped: phone is too hot. Let it cool before restarting.")
            } else main.postDelayed(this, 5000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        store = SegmentStore(this)
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
            NotificationChannel(CHANNEL, "Active recording", NotificationManager.IMPORTANCE_LOW)
        )
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            START -> if (!active) startSession(intent.getBooleanExtra("video", false))
            STOP -> stopSession("Recording stopped")
            else -> if (!active) stopSelf()
        }
        return START_NOT_STICKY
    }
    @SuppressLint("WakelockTimeout")
    private fun startSession(withVideo: Boolean) {
        lastStartRequest = SystemClock.elapsedRealtime()
        phase = "preparing"; sessionStarted = 0L; lastSessionDuration = 0L
        isVideo = withVideo
        val permissions = mutableListOf(Manifest.permission.RECORD_AUDIO).apply {
            if (withVideo) add(Manifest.permission.CAMERA)
        }
        if (permissions.any { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }) {
            status = "Recording permission missing"; stopSelf(); return
        }
        try {
            val type = if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                (if (withVideo) ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA else 0) else 0
            ServiceCompat.startForeground(this, NOTICE, notice("Preparing recording"), type)
            if (store.root.usableSpace < RESERVE_BYTES) error("Phone storage is low")
            store.recoverAbandoned()
            session = UUID.randomUUID().toString()
            store.beginSession(session, withVideo)
            wanted = true; ending = false; active = true
            wake = (getSystemService(POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VoiceCam:Capture").apply { acquire() }
            status = "Preparing ${if (withVideo) "camera and microphone" else "microphone"}"
            main.post(monitor)
            main.post(meter)
            if (withVideo) initializeCamera() else startAudio()
        } catch (e: Exception) { fail("Cannot start: ${e.localizedMessage}") }
    }
    private fun initializeCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            if (!wanted) return@addListener
            try {
                provider = future.get()
                capture = VideoCapture.withOutput(Recorder.Builder().setQualitySelector(
                    QualitySelector.from(Quality.HD, FallbackStrategy.lowerQualityOrHigherThan(Quality.SD))
                ).build())
                preview = Preview.Builder().setTargetAspectRatio(androidx.camera.core.AspectRatio.RATIO_16_9).build()
                connectPreview()
                try {
                    provider!!.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview!!, capture!!)
                    previewAvailable = true
                } catch (_: Exception) {
                    provider!!.unbind(preview!!, capture!!)
                    preview = null; previewAvailable = false
                    provider!!.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, capture!!)
                }
                startVideo()
            } catch (e: Exception) { fail("Camera unavailable: ${e.localizedMessage}") }
        }, ContextCompat.getMainExecutor(this))
    }
    @SuppressLint("MissingPermission")
    private fun startVideo() {
        if (!wanted) return
        try {
            if (store.root.usableSpace < RESERVE_BYTES) error("Phone storage is low")
            val file = store.create(session, ++sequence, true)
            current = file
            video = capture!!.output.prepareRecording(this, FileOutputOptions.Builder(file).build())
                .withAudioEnabled().start(ContextCompat.getMainExecutor(this)) { event ->
                    when (event) {
                        is VideoRecordEvent.Start -> {
                            if (sessionStarted == 0L) sessionStarted = SystemClock.elapsedRealtime()
                            phase = if (wanted) "recording" else "stopping"
                            status = "Recording audio + video · segment $sequence"
                            updateNotice(); main.postDelayed(rotate, SEGMENT_MS)
                        }
                        is VideoRecordEvent.Finalize -> {
                            main.removeCallbacks(rotate)
                            video = null; current = null
                            store.finalize(file, if (event.hasError()) "Camera error ${event.error}" else null)
                            UploadWorker.kick(this)
                            if (event.hasError()) fail("Video stopped: ${event.cause?.localizedMessage ?: event.error}")
                            else if (wanted) startVideo() else stopSelf()
                        }
                        else -> Unit
                    }
                }
        } catch (e: Exception) { fail("Video recording failed: ${e.localizedMessage}") }
    }
    @Suppress("DEPRECATION")
    private fun startAudio() {
        if (!wanted) return
        try {
            if (store.root.usableSpace < RESERVE_BYTES) error("Phone storage is low")
            val file = store.create(session, ++sequence, false)
            current = file
            val recorder = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else MediaRecorder()
            audio = recorder
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setAudioChannels(1)
            recorder.setAudioSamplingRate(16000)
            recorder.setAudioEncodingBitRate(64000)
            recorder.setOutputFile(file.absolutePath)
            recorder.setOnErrorListener { _, what, extra -> fail("Audio recorder error $what/$extra") }
            recorder.prepare(); recorder.start()
            if (sessionStarted == 0L) sessionStarted = SystemClock.elapsedRealtime()
            phase = "recording"
            status = "Recording audio only · segment $sequence"
            updateNotice(); main.postDelayed(rotate, SEGMENT_MS)
        } catch (e: Exception) { fail("Audio recording failed: ${e.localizedMessage}") }
    }
    private fun finishAudio(continueRecording: Boolean) {
        main.removeCallbacks(rotate)
        val recorder = audio ?: return
        val file = current
        audio = null; current = null
        var failure: String? = null
        try { recorder.stop() } catch (e: Exception) { failure = "Audio could not finalize: ${e.localizedMessage}" }
        finally { recorder.release() }
        if (file != null) store.finalize(file, failure)
        UploadWorker.kick(this)
        if (failure != null) fail(failure)
        else if (continueRecording && wanted) startAudio()
    }
    private fun fail(message: String) { stopSession(message) }
    private fun stopSession(message: String) {
        if (ending) return
        ending = true; wanted = false; status = message; phase = "stopping"
        main.removeCallbacks(rotate); main.removeCallbacks(monitor); main.removeCallbacks(meter)
        updateNotice()
        if (video != null) video?.stop()
        else {
            if (audio != null) finishAudio(false)
            current?.let { store.finalize(it, message) }; current = null
            stopSelf()
        }
    }
    private fun notice(text: String): Notification {
        val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 2, Intent(this, RecordingService::class.java).setAction(STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Pocket Scribe is recording").setContentText(text).setContentIntent(open)
            .setOngoing(true).setOnlyAlertOnce(true)
            .addAction(android.R.drawable.ic_media_pause, "Stop recording", stop).build()
    }
    private fun updateNotice() {
        if (active) (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTICE, notice(status))
    }
    override fun onDestroy() {
        if (sessionStarted > 0L) lastSessionDuration = SystemClock.elapsedRealtime() - sessionStarted
        sessionStarted = 0L; phase = "idle"
        wanted = false; active = false
        main.removeCallbacksAndMessages(null)
        runCatching { video?.close() }; video = null
        if (audio != null) finishAudio(false)
        if (session.isNotBlank()) store.endSession(session)
        runCatching { provider?.unbindAll() }
        fallbackReaders.toList().forEach { runCatching { it.close() } }; fallbackReaders.clear()
        instance = null; audioLevel = 0
        if (wake?.isHeld == true) wake?.release()
        super.onDestroy()
    }
}
