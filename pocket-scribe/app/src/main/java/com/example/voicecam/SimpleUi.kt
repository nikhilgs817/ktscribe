package com.example.voicecam

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.view.View
import android.widget.*
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Small view kit shared by every screen. Colours follow the Pocket Scribe Desktop
 * tokens (static/app.css) so the phone and the PC look like one product, in light and dark.
 */
object SimpleUi {
    /** Set by [apply] from the activity's configuration (system setting or the in-app override). */
    var dark = false
        private set

    val PAPER get() = if (dark) Color.rgb(0x1c, 0x21, 0x29) else Color.rgb(0xe8, 0xec, 0xf2)
    val RAISE get() = if (dark) Color.rgb(0x26, 0x2d, 0x37) else Color.rgb(0xf3, 0xf5, 0xf9)
    val SUNK get() = if (dark) Color.rgb(0x19, 0x1d, 0x24) else Color.rgb(0xe1, 0xe6, 0xee)
    val INK get() = if (dark) Color.rgb(0xee, 0xf2, 0xf8) else Color.rgb(0x2a, 0x35, 0x49)
    val TEXT get() = if (dark) Color.rgb(0xc9, 0xd2, 0xe0) else Color.rgb(0x3d, 0x4b, 0x63)
    val MUTED get() = if (dark) Color.rgb(0x8b, 0x96, 0xa8) else Color.rgb(0x6b, 0x78, 0x90)
    val LINE get() = if (dark) Color.rgb(0x33, 0x3b, 0x47) else Color.rgb(0xcf, 0xd6, 0xe2)
    val RED get() = if (dark) Color.rgb(0xef, 0x6a, 0x5d) else Color.rgb(0xe8, 0x59, 0x4c)
    val RED_TEXT get() = if (dark) Color.rgb(0xff, 0x8b, 0x80) else Color.rgb(0xc6, 0x3a, 0x2f)
    val PASS get() = if (dark) Color.rgb(0x3c, 0xc4, 0x8a) else Color.rgb(0x16, 0x8a, 0x5a)
    val WARN get() = if (dark) Color.rgb(0xe2, 0xb0, 0x4a) else Color.rgb(0xa1, 0x6c, 0x00)
    val INFO get() = if (dark) Color.rgb(0x6e, 0xa2, 0xff) else Color.rgb(0x25, 0x63, 0xc8)

    fun dp(context: Context, value: Int) = (value * context.resources.displayMetrics.density).toInt()

    /** Applies the saved theme choice (system, light or dark). Call from attachBaseContext. */
    fun themed(base: Context): Context {
        val mode = base.getSharedPreferences("settings", 0).getString("theme", "system")
        if (mode != "light" && mode != "dark") return base
        val config = Configuration(base.resources.configuration)
        val night = if (mode == "dark") Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        config.uiMode = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or night
        return base.createConfigurationContext(config)
    }

    /** Reads dark/light for this screen and colours the system bars to match. */
    @Suppress("DEPRECATION")
    fun apply(activity: Activity) {
        dark = (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        activity.window.statusBarColor = PAPER
        activity.window.navigationBarColor = PAPER
        activity.window.decorView.systemUiVisibility =
            if (dark) 0 else View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
    }

    fun screen(activity: Activity): LinearLayout {
        apply(activity)
        val scroll = ScrollView(activity).apply { isFillViewport = true; setBackgroundColor(PAPER) }
        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val padding = dp(activity, 20); setPadding(padding, dp(activity, 8), padding, dp(activity, 24))
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
        text = label; textSize = size; setTextColor(if (bold) INK else TEXT)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        setLineSpacing(dp(context, 3).toFloat(), 1f)
    }

    fun muted(context: Context, label: String, size: Float = 13f) = text(context, label, size).apply { setTextColor(MUTED) }

    /** Small upper-case label above a group, like the desktop's section headings. */
    fun section(context: Context, label: String) = TextView(context).apply {
        text = label.uppercase(); textSize = 12f; letterSpacing = 0.08f; setTextColor(MUTED)
        setTypeface(typeface, Typeface.BOLD)
        setPadding(dp(context, 4), dp(context, 20), 0, dp(context, 8))
    }

    fun rounded(context: Context, color: Int, radius: Int = 18, stroke: Int = 0) = GradientDrawable().apply {
        setColor(color); cornerRadius = dp(context, radius).toFloat()
        if (stroke != 0) setStroke(dp(context, 1), stroke)
    }

    /** A raised panel that groups related rows. */
    fun card(context: Context) = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(context, RAISE, 20, LINE)
        val pad = dp(context, 16); setPadding(pad, dp(context, 12), pad, dp(context, 12))
        elevation = dp(context, if (dark) 0 else 2).toFloat()
    }

    fun buttonBackground(context: Context, color: Int, stroke: Int = 0, radius: Int = 18): RippleDrawable {
        val ripple = if (dark) 0x30FFFFFF else 0x22000000
        return RippleDrawable(ColorStateList.valueOf(ripple), rounded(context, color, radius, stroke), null)
    }

    fun primaryButton(context: Context, label: String, onClick: () -> Unit) = Button(context).apply {
        text = label; textSize = 19f; isAllCaps = false; setTextColor(Color.WHITE)
        setTypeface(typeface, Typeface.BOLD); background = buttonBackground(context, RED, radius = 22)
        stateListAnimator = null
        minHeight = dp(context, 64); setPadding(dp(context, 16), dp(context, 12), dp(context, 16), dp(context, 12))
        setOnClickListener { onClick() }
    }

    fun quietButton(context: Context, label: String, onClick: () -> Unit) = Button(context).apply {
        text = label; textSize = 15f; isAllCaps = false; setTextColor(INK)
        stateListAnimator = null
        minHeight = dp(context, 48); minimumHeight = dp(context, 48); minimumWidth = dp(context, 76)
        background = buttonBackground(context, RAISE, LINE)
        setPadding(dp(context, 16), dp(context, 8), dp(context, 16), dp(context, 8))
        setOnClickListener { onClick() }
    }

    /** Round icon-sized button for the header (info, settings, back). */
    fun roundButton(context: Context, glyph: String, description: String, onClick: () -> Unit) = TextView(context).apply {
        text = glyph; textSize = 18f; gravity = Gravity.CENTER; setTextColor(INK)
        setTypeface(Typeface.create("serif", Typeface.BOLD_ITALIC))
        contentDescription = description; isClickable = true; isFocusable = true
        background = RippleDrawable(ColorStateList.valueOf(if (dark) 0x30FFFFFF else 0x22000000),
            GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(RAISE); setStroke(dp(context, 1), LINE) }, null)
        setOnClickListener { onClick() }
    }

    /** Header row: back button (optional) and title. Add trailing views to the returned row. */
    fun header(activity: Activity, title: String, back: Boolean): LinearLayout {
        val row = LinearLayout(activity).apply {
            gravity = Gravity.CENTER_VERTICAL; minimumHeight = dp(activity, 56)
        }
        if (back) row.addView(roundButton(activity, "‹", "Back") { activity.finish() }.apply {
            typeface = Typeface.DEFAULT_BOLD; textSize = 24f
        }, LinearLayout.LayoutParams(dp(activity, 44), dp(activity, 44)).apply { marginEnd = dp(activity, 12) })
        row.addView(text(activity, title, 22f, true), LinearLayout.LayoutParams(0, -2, 1f))
        return row
    }

    /** Status badge in the desktop style: READY, RECORDING, SAVING, YOUR TURN. */
    fun badge(context: Context) = TextView(context).apply {
        textSize = 11f; letterSpacing = 0.1f; setTypeface(typeface, Typeface.BOLD); gravity = Gravity.CENTER
        setPadding(dp(context, 12), dp(context, 4), dp(context, 12), dp(context, 4))
    }

    fun setBadge(view: TextView, label: String, color: Int) {
        if (view.text.toString() != label) view.text = label
        view.setTextColor(color)
        view.background = rounded(view.context, (color and 0x00FFFFFF) or 0x24000000, 12)
    }

    /** Styles a RadioButton as one half of a segmented control: a raised pill when checked. */
    fun segment(context: Context, button: RadioButton) {
        button.buttonDrawable = null
        button.gravity = Gravity.CENTER
        button.setTypeface(button.typeface, Typeface.BOLD)
        button.background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_checked), rounded(context, RAISE, 14, LINE))
            addState(intArrayOf(), rounded(context, Color.TRANSPARENT, 14))
        }
        button.setTextColor(ColorStateList(
            arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf(android.R.attr.state_checked), intArrayOf()),
            intArrayOf(LINE, RED_TEXT, MUTED)))
    }

    fun segmentGroup(context: Context) = RadioGroup(context).apply {
        orientation = RadioGroup.HORIZONTAL
        background = rounded(context, SUNK, 18)
        val pad = dp(context, 4); setPadding(pad, pad, pad, pad)
    }

    fun switchTint(view: Switch) {
        view.setTextColor(INK)
        view.thumbTintList = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
            intArrayOf(RED, if (dark) Color.rgb(0x9a, 0xa7, 0xbd) else Color.WHITE))
        view.trackTintList = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
            intArrayOf((RED and 0x00FFFFFF) or 0x66000000, LINE))
    }

    /** The "i" sheet: how the phone and the desktop app work together. */
    fun showInfo(activity: Activity) {
        val pad = dp(activity, 24)
        val body = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, dp(activity, 8), pad, 0) }
        fun step(n: String, title: String, detail: String) {
            val row = LinearLayout(activity).apply { setPadding(0, dp(activity, 8), 0, dp(activity, 8)) }
            row.addView(TextView(activity).apply {
                text = n; textSize = 14f; gravity = Gravity.CENTER; setTextColor(Color.WHITE); setTypeface(typeface, Typeface.BOLD)
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(RED) }
            }, LinearLayout.LayoutParams(dp(activity, 28), dp(activity, 28)).apply { marginEnd = dp(activity, 14) })
            val col = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
            col.addView(text(activity, title, 16f, true)); col.addView(muted(activity, detail, 14f))
            row.addView(col, LinearLayout.LayoutParams(0, -2, 1f)); body.addView(row)
        }
        step("1", "Record here", "Point the camera at the shared screen, or pick Audio only. You can switch the screen off while it records.")
        step("2", "Name it", "Named recordings go to your Google Drive, in the Pocket Scribe folder.")
        step("3", "Open the PC app", "Pocket Scribe Desktop picks it up and makes the transcript, screenshots, KT document, invite and Claude bundle.")
        body.addView(muted(activity, "Recordings stay on this phone until Drive confirms the upload. Nothing is sent anywhere else.", 13f).apply {
            setPadding(0, dp(activity, 12), 0, 0)
        })
        val scroll = ScrollView(activity).apply { addView(body) }
        AlertDialog.Builder(activity).setTitle("How Pocket Scribe works").setView(scroll)
            .setPositiveButton("Got it", null).show()
    }
}
