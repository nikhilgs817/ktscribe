package com.example.voicecam

import android.app.Application

class VoiceCamApp : Application() {
    override fun onCreate() {
        super.onCreate()
        UploadWorker.schedulePeriodic(this)
    }
}
