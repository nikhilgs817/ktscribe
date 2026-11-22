package com.example.voicecam

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.*
import android.os.*
import android.view.*
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {
    private val prefs by lazy { getSharedPreferences("settings", 0) }
    private val main = Handler(Looper.getMainLooper())
    private val reader = Executors.newSingleThreadExecutor()
    private lateinit var previewView: PreviewView
    private lateinit var audioPanel: AudioPanel
    private lateinit var previewMessage: TextView
    private lateinit var timer: TextView
    private lateinit var recordingState: TextView
    private lateinit var backup: TextView
    private lateinit var action: Button
    private lateinit var audio: RadioButton
    private lateinit var video: RadioButton
    private var provider: ProcessCameraProvider? = null
    private var idlePreview: Preview? = null
    private var previewLoading = false
    private var previewGeneration = 0
    private var servicePreviewAttached = false
    private var pendingCommand = ""
    private var pendingSince = 0L
    private var selectedVideo = true
    private var visible = false
    private var pendingRead = false
    private var lastRead = 0L
    private var finalSyncState = ""
    private var pendingName = ""
    private var saving = false
    private var lastPrompted = ""
    private var nameDialog: AlertDialog? = null
    private var nameInput: EditText? = null
    private var namingSession = ""
    private var restoredName = ""
    private var restoredSession = ""
    private fun TextView.show(value: String) { if (text.toString() != value) text = value }
    private val refresh = object : Runnable {
        override fun run() {
            render()
            if (!pendingRead && SystemClock.elapsedRealtime() - lastRead > 1000) {
                pendingRead = true
                reader.execute {
                    val store = SegmentStore(this@MainActivity)
                    val sessions = store.sessions().mapNotNull { file ->
                        runCatching { file to store.read(file) }.getOrNull()
                    }
                    val latestSaved = sessions.firstOrNull { (_, session) -> session.optString("state") == "saved" }
                    val syncState = latestSaved?.let { (file, session) ->
                        runCatching { store.read(java.io.File(file.parentFile, session.getString("finalJournal"))).optString("state") }
                            .getOrDefault("")
                    }.orEmpty()
                    val unnamed = store.pendingNames().firstOrNull()?.let { store.read(it).getString("sessionId") }.orEmpty()
                    val inProgress = sessions.any { (_, session) -> session.optString("state") == "finalizing" }
                    main.post {
                        pendingRead = false; lastRead = SystemClock.elapsedRealtime()
                        finalSyncState = syncState; pendingName = unnamed; saving = inProgress
                        if (visible) {
                            render()
                            if (!RecordingService.active && unnamed.isNotBlank() && unnamed != lastPrompted) promptName(unnamed)
                        }
                    }
                }
            }
            main.postDelayed(this, 250)
        }
    }
    private val previewPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { configurePreview() }
    private val recordingPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (canRecord()) begin() else toast("Allow microphone${if (selectedVideo) " and camera" else ""} access to record.")
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!RecordingService.active) SegmentStore(this).recoverAbandoned()
        restoredName = savedInstanceState?.getString("nameText").orEmpty()
        restoredSession = savedInstanceState?.getString("nameSession").orEmpty()
        selectedVideo = if (RecordingService.active) RecordingService.isVideo else prefs.getBoolean("videoMode", true)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(SimpleUi.PAPER) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); insets
        }
        val top = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        root.addView(top, LinearLayout.LayoutParams(-1, 0, 1f))
        previewView = PreviewView(this).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FIT_CENTER
        }
        top.addView(previewView, FrameLayout.LayoutParams(-1, -1))
        audioPanel = AudioPanel(this)
        top.addView(audioPanel, FrameLayout.LayoutParams(-1, -1))
        previewMessage = SimpleUi.text(this, "Enable camera preview", 17f).apply {
            gravity = Gravity.CENTER; setTextColor(Color.WHITE); minHeight = SimpleUi.dp(this@MainActivity, 64)
            isClickable = true; isFocusable = true
            setOnClickListener {
                if (!hasCamera()) previewPermission.launch(Manifest.permission.CAMERA) else configurePreview()
            }
        }
        top.addView(previewMessage, FrameLayout.LayoutParams(-1, -1))
        val scroll = ScrollView(this).apply { isFillViewport = true }
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(SimpleUi.dp(this@MainActivity, 24), SimpleUi.dp(this@MainActivity, 12), SimpleUi.dp(this@MainActivity, 24), SimpleUi.dp(this@MainActivity, 12))
        }
        scroll.addView(bottom, FrameLayout.LayoutParams(-1, -1))
        val modes = RadioGroup(this).apply { orientation = RadioGroup.HORIZONTAL }
        audio = RadioButton(this).apply { id = View.generateViewId(); text = "Audio only" }
        video = RadioButton(this).apply { id = View.generateViewId(); text = "Audio + video" }
        listOf(audio, video).forEach {
            it.textSize = 16f; it.setTextColor(SimpleUi.INK); it.minHeight = SimpleUi.dp(this, 48)
            it.buttonTintList = android.content.res.ColorStateList.valueOf(SimpleUi.INK)
            modes.addView(it, RadioGroup.LayoutParams(0, -2, 1f))
        }
        bottom.addView(modes)
        modes.check(if (selectedVideo) video.id else audio.id)
        modes.setOnCheckedChangeListener { _, id ->
            selectedVideo = id == video.id; prefs.edit().putBoolean("videoMode", selectedVideo).apply()
            stopIdlePreview(); configurePreview(); render()
        }
        timer = SimpleUi.text(this, "00:00", 38f).apply {
            gravity = Gravity.CENTER; typeface = Typeface.create("monospace", Typeface.NORMAL)
        }
        bottom.addView(timer)
        recordingState = SimpleUi.text(this, "", 13f).apply { gravity = Gravity.CENTER; minHeight = SimpleUi.dp(this@MainActivity, 24) }
        bottom.addView(recordingState)
        action = SimpleUi.primaryButton(this, "Start recording") {
            when {
                RecordingService.active -> stop()
                pendingName.isNotBlank() -> promptName(pendingName)
                else -> requestStart()
            }
        }.apply { background = SimpleUi.buttonBackground(this@MainActivity, SimpleUi.RED) }
        bottom.addView(action, LinearLayout.LayoutParams(-1, SimpleUi.dp(this, 72)))
        val links = LinearLayout(this).apply { gravity = Gravity.CENTER }
        links.addView(SimpleUi.quietButton(this, "Google Drive") {
            openSettings()
        }, LinearLayout.LayoutParams(0, SimpleUi.dp(this, 56), 1.8f))
        links.addView(SimpleUi.quietButton(this, "Settings") { openSettings() }, LinearLayout.LayoutParams(0, SimpleUi.dp(this, 56), 1f))
        bottom.addView(links)
        backup = SimpleUi.text(this, "", 13f).apply { gravity = Gravity.CENTER; minHeight = SimpleUi.dp(this@MainActivity, 20) }
        bottom.addView(backup)
        setContentView(root); ViewCompat.requestApplyInsets(root)
    }
    private fun render() {
        val active = RecordingService.active
        if ((pendingCommand == "start" && (active || RecordingService.lastStartRequest >= pendingSince)) ||
            (pendingCommand == "stop" && !active)) pendingCommand = ""
        if (pendingCommand.isNotEmpty() && SystemClock.elapsedRealtime() - pendingSince > 15_000) pendingCommand = ""
        val stopping = pendingCommand == "stop" || RecordingService.phase == "stopping"
        val preparing = pendingCommand == "start" || RecordingService.phase == "preparing"
        val elapsed = if (active && RecordingService.sessionStarted > 0) SystemClock.elapsedRealtime() - RecordingService.sessionStarted else RecordingService.lastSessionDuration
        val sec = elapsed.coerceAtLeast(0) / 1000
        timer.show(if (sec >= 3600) String.format(Locale.US, "%d:%02d:%02d", sec / 3600, sec / 60 % 60, sec % 60) else String.format(Locale.US, "%02d:%02d", sec / 60, sec % 60))
        action.show(when { stopping -> "Finishing…"; preparing -> "Starting…"; active -> "Stop recording"; saving -> "Saving…"; pendingName.isNotBlank() -> "Name & save"; else -> "Start recording" })
        action.isEnabled = !stopping && !preparing && !saving
        audio.isEnabled = !active && pendingCommand.isEmpty(); video.isEnabled = audio.isEnabled
        recordingState.show(when { stopping -> "Finishing recording"; preparing -> "Getting ready"; active -> "● Recording"; saving -> "Saving final copy"; pendingName.isNotBlank() -> "Recording needs a name"; else -> "" })
        recordingState.setTextColor(if (active) SimpleUi.RED else SimpleUi.MUTED)
        val connected = !prefs.getString("account", "").isNullOrBlank()
        backup.show(when {
            !connected -> "Connect Drive to send recordings to Pocket Scribe Desktop"
            prefs.getString("backupState", "") == "attention" -> "Drive sync needs attention"
            finalSyncState == "uploaded" -> "Uploaded to Drive · Open Pocket Scribe Desktop on your PC"
            finalSyncState == "ready" -> "Saved on phone · Waiting for Drive sync"
            else -> "Finished recordings sync automatically"
        })
        audioPanel.visibility = if (selectedVideo) View.GONE else View.VISIBLE
        previewView.visibility = if (selectedVideo) View.VISIBLE else View.GONE
        if (selectedVideo && active && !RecordingService.previewAvailable) {
            previewMessage.show("Preview unavailable on this phone"); previewMessage.visibility = View.VISIBLE
        }
        audioPanel.invalidate()
        configurePreview()
    }
    private fun configurePreview() {
        if (!::previewView.isInitialized || !visible) return
        if (!selectedVideo) { stopIdlePreview(); previewMessage.visibility = View.GONE; return }
        if (!hasCamera()) { previewMessage.show("Enable camera preview"); previewMessage.visibility = View.VISIBLE; return }
        if (RecordingService.active || pendingCommand == "start") {
            stopIdlePreview()
            if (!servicePreviewAttached) { RecordingService.attachPreview(previewView.surfaceProvider); servicePreviewAttached = true }
            previewMessage.visibility = if (RecordingService.previewAvailable) View.GONE else View.VISIBLE
            return
        }
        if (servicePreviewAttached) { RecordingService.attachPreview(null); servicePreviewAttached = false }
        if (idlePreview != null || previewLoading) return
        previewLoading = true; val generation = ++previewGeneration
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            if (generation != previewGeneration) return@addListener
            previewLoading = false
            if (!visible || !selectedVideo || RecordingService.active || pendingCommand.isNotEmpty()) return@addListener
            try {
                provider = future.get()
                idlePreview = Preview.Builder().setTargetAspectRatio(androidx.camera.core.AspectRatio.RATIO_16_9)
                    .build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                provider!!.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, idlePreview!!)
                previewMessage.visibility = View.GONE
            } catch (_: Exception) {
                idlePreview = null; previewMessage.show("Camera unavailable"); previewMessage.visibility = View.VISIBLE
            }
        }, ContextCompat.getMainExecutor(this))
    }
    private fun stopIdlePreview() {
        previewGeneration++; previewLoading = false
        idlePreview?.let { provider?.unbind(it) }; idlePreview = null
    }
    private fun hasCamera() = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    private fun canRecord() = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED && (!selectedVideo || hasCamera())
    private fun requestStart() {
        val request = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (selectedVideo) request.add(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= 33) request.add(Manifest.permission.POST_NOTIFICATIONS)
        val missing = request.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) begin() else recordingPermissions.launch(missing.toTypedArray())
    }
    private fun begin() {
        if (RecordingService.active) return
        stopIdlePreview(); lastPrompted = ""
        if (selectedVideo) { RecordingService.attachPreview(previewView.surfaceProvider); servicePreviewAttached = true }
        try {
            pendingCommand = "start"; pendingSince = SystemClock.elapsedRealtime()
            ContextCompat.startForegroundService(this, Intent(this, RecordingService::class.java).setAction(RecordingService.START).putExtra("video", selectedVideo))
        } catch (_: Exception) { pendingCommand = ""; toast("Couldn't start recording. Please try again.") }
        render()
    }
    private fun stop() {
        pendingCommand = "stop"; pendingSince = SystemClock.elapsedRealtime(); lastRead = 0; lastPrompted = ""
        startService(Intent(this, RecordingService::class.java).setAction(RecordingService.STOP)); render()
    }
    private fun promptName(id: String) {
        if (!visible || nameDialog?.isShowing == true || RecordingService.active) return
        val session = SegmentStore(this).read(SegmentStore(this).sessionFile(id))
        if (session.optString("state") !in listOf("awaiting_name", "save_failed")) return
        lastPrompted = id; namingSession = id
        val initial = if (restoredSession == id && restoredName.isNotBlank()) restoredName else session.optString("name").ifBlank {
            "Recording " + LocalDateTime.now().format(DateTimeFormatter.ofPattern("MMM d, HH.mm"))
        }
        val input = EditText(this).apply {
            setSingleLine(); hint = "Recording name"; setText(initial); selectAll()
            filters = arrayOf(android.text.InputFilter.LengthFilter(100))
            setPadding(SimpleUi.dp(this@MainActivity, 24), SimpleUi.dp(this@MainActivity, 16), SimpleUi.dp(this@MainActivity, 24), SimpleUi.dp(this@MainActivity, 16))
        }
        nameInput = input
        val dialog = AlertDialog.Builder(this).setTitle("Name recording").setView(input)
            .setMessage(when {
                session.optString("state") == "save_failed" -> session.optString("saveError")
                prefs.getString("account", "").isNullOrBlank() -> "Connect Google Drive to send this recording to Pocket Scribe Desktop."
                else -> "Saved recordings sync to Pocket Scribe Desktop through Google Drive."
            })
            .setPositiveButton("Save", null).setNegativeButton("Later") { _, _ -> namingSession = "" }
            .setCancelable(false).create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val name = input.text.toString().trim()
                if (name.isBlank()) { input.error = "Enter a name"; return@setOnClickListener }
                FinalizeWorker.save(this, id, name)
                saving = true; pendingName = ""; namingSession = ""; restoredSession = ""; restoredName = ""
                dialog.dismiss(); nameDialog = null; lastRead = 0; render()
            }
        }
        nameDialog = dialog; dialog.show()
    }
    private fun openSettings() { startActivity(Intent(this, SettingsActivity::class.java)) }
    private fun toast(value: String) { Toast.makeText(this, value, Toast.LENGTH_LONG).show() }
    override fun onResume() {
        super.onResume(); visible = true
        intent.getStringExtra("nameSession")?.let { lastPrompted = ""; intent.removeExtra("nameSession"); promptName(it) }
        main.removeCallbacks(refresh); refresh.run()
    }
    override fun onPause() {
        visible = false; main.removeCallbacks(refresh); stopIdlePreview()
        RecordingService.attachPreview(null); servicePreviewAttached = false
        super.onPause()
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("nameSession", namingSession); outState.putString("nameText", nameInput?.text?.toString())
        super.onSaveInstanceState(outState)
    }
    override fun onDestroy() { reader.shutdown(); main.removeCallbacksAndMessages(null); nameDialog?.dismiss(); super.onDestroy() }
}

private class AudioPanel(context: android.content.Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    init { contentDescription = "Audio level"; setBackgroundColor(Color.rgb(24, 31, 35)) }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val density = resources.displayMetrics.density
        val active = RecordingService.active && !RecordingService.isVideo
        val level = if (active) (RecordingService.audioLevel / 32767f).coerceIn(0f, 1f) else 0f
        paint.color = if (active) Color.rgb(233, 89, 90) else Color.rgb(127, 141, 148)
        val bar = 8 * density; val gap = 8 * density
        for (i in 0..6) {
            val height = (12 + level * (1f - kotlin.math.abs(i - 3) / 5f) * 100) * density
            val x = width / 2f + (i - 3) * (bar + gap) - bar / 2
            canvas.drawRoundRect(x, this.height / 2f - height / 2, x + bar, this.height / 2f + height / 2, bar / 2, bar / 2, paint)
        }
        paint.color = Color.WHITE; paint.textSize = 18 * resources.displayMetrics.scaledDensity; paint.textAlign = Paint.Align.CENTER
        canvas.drawText(if (active) "Recording audio" else "Audio only", width / 2f, height / 2f + 100 * density, paint)
    }
}
