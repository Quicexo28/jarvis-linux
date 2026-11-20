package com.jarvis.companion.wall

import android.accessibilityservice.AccessibilityService
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.jarvis.companion.Config

/**
 * Las manos de la pared dentro de OTRAS apps (Netflix, Play…): D-pad, atrás,
 * texto en el campo con foco, y saber qué app está delante.
 *
 * Es la única vía sin root: `input keyevent` es de shell y la depuración
 * inalámbrica se apaga en cada arranque. GLOBAL_ACTION_DPAD_* existe desde
 * API 33 (el HA109 es 34). Inactivo fuera de wallMode aunque alguien lo active
 * en la tablet por error.
 */
class WallAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "WallA11y"

        @Volatile var instance: WallAccessibilityService? = null
            private set

        /** null = la propia pared delante (contrato `foreground`). */
        @Volatile var foreground: String? = null
            private set
    }

    override fun onServiceConnected() {
        instance = this
        Log.i(TAG, "accesibilidad conectada")
        updateForeground()
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onInterrupt() {}

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || !Config.wallMode(this)) return
        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            AccessibilityEvent.TYPE_WINDOWS_CHANGED -> updateForeground()
        }
    }

    /**
     * La app de la ventana de aplicación activa. Se mira la lista de ventanas
     * y no `event.packageName`: los toasts, el teclado y SystemUI también
     * disparan WINDOW_STATE_CHANGED y harían creer que cambió la app.
     */
    private fun updateForeground() {
        val pkg = try {
            val list = windows
            val app = list.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION && (it.isActive || it.isFocused) }
                ?: list.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
            app?.root?.packageName?.toString()
        } catch (e: Exception) {
            Log.w(TAG, "ventanas: ${e.message}")
            null
        } ?: return
        val mapped = if (pkg == packageName) null else pkg
        if (mapped != foreground) Log.i(TAG, "primer plano: ${mapped ?: "pared"}")
        if (mapped == foreground && WallService.reportedForeground) return
        foreground = mapped
        WallService.reportForeground(mapped)
    }

    /** Teclas de navegación del contrato → acción global. */
    fun key(key: String): Boolean {
        val action = when (key) {
            "UP" -> if (Build.VERSION.SDK_INT >= 33) GLOBAL_ACTION_DPAD_UP else return false
            "DOWN" -> if (Build.VERSION.SDK_INT >= 33) GLOBAL_ACTION_DPAD_DOWN else return false
            "LEFT" -> if (Build.VERSION.SDK_INT >= 33) GLOBAL_ACTION_DPAD_LEFT else return false
            "RIGHT" -> if (Build.VERSION.SDK_INT >= 33) GLOBAL_ACTION_DPAD_RIGHT else return false
            "OK" -> if (Build.VERSION.SDK_INT >= 33) GLOBAL_ACTION_DPAD_CENTER else return false
            "BACK" -> GLOBAL_ACTION_BACK
            else -> return false
        }
        return performGlobalAction(action)
    }

    /** Best-effort: escribe en el nodo con foco de entrada (contrato `/text`). */
    fun setText(text: String): Boolean {
        val node = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
        if (!node.isEditable) return false
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }
}
