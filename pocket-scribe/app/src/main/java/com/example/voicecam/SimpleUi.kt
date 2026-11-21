package com.example.voicecam

import android.app.Activity
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.view.View
import android.widget.*
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

object SimpleUi {
    val INK = Color.rgb(30, 45, 52)
    val MUTED = Color.rgb(76, 89, 95)
    val LINE = Color.rgb(213, 221, 223)
    val RED = Color.rgb(173, 42, 45)
    val PAPER = Color.rgb(249, 250, 248)
    fun dp(context: Context, value: Int) = (value * context.resources.displayMetrics.density).toInt()
    @Suppress("DEPRECATION")
    fun screen(activity: Activity): LinearLayout {
        activity.window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        val scroll = ScrollView(activity).apply { isFillViewport = true; setBackgroundColor(PAPER) }
        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val padding = dp(activity, 24); setPadding(padding, dp(activity, 12), padding, dp(activity, 16))
        }
        scroll.addView(root, FrameLayout.LayoutParams(-1, -1))
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); insets
        }
        activity.setContentView(scroll); ViewCompat.requestApplyInsets(scroll)
        return root
    }
    fun text(context: Context, label: String, size: Float = 16f, bold: Boolean = false) = TextView(context).apply {
        text = label; textSize = size; setTextColor(if (bold) INK else MUTED)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        setLineSpacing(dp(context, 3).toFloat(), 1f)
    }
    fun buttonBackground(context: Context, color: Int): RippleDrawable {
        val shape = GradientDrawable().apply { setColor(color); cornerRadius = dp(context, 16).toFloat() }
        return RippleDrawable(ColorStateList.valueOf(0x25FFFFFF), shape, null)
    }
    fun primaryButton(context: Context, label: String, onClick: () -> Unit) = Button(context).apply {
        text = label; textSize = 20f; isAllCaps = false; setTextColor(Color.WHITE)
        setTypeface(typeface, Typeface.BOLD); background = buttonBackground(context, INK)
        minHeight = dp(context, 64); setPadding(dp(context, 16), dp(context, 12), dp(context, 16), dp(context, 12))
        setOnClickListener { onClick() }
    }
    fun quietButton(context: Context, label: String, onClick: () -> Unit) = Button(context).apply {
        text = label; textSize = 15f; isAllCaps = false; setTextColor(INK)
        minHeight = dp(context, 52); minimumWidth = dp(context, 76)
        background = buttonBackground(context, Color.TRANSPARENT)
        setPadding(dp(context, 12), dp(context, 8), dp(context, 12), dp(context, 8))
        setOnClickListener { onClick() }
    }
}
