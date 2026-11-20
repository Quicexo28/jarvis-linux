package com.jarvis.companion.wall

import kotlin.math.abs
import kotlin.math.hypot

/**
 * Matemática del warp (pura). Misma homografía que `homography()` de
 * proyector-simple/main.c: cuadrado unitario (0,0)(1,0)(1,1)(0,1) → TL,TR,BR,BL.
 * Las matrices son 3x3 en orden de filas.
 */
object Homography {

    /** [d] = 8 floats en píxeles del panel (TL,TR,BR,BL). Devuelve uv → px. */
    fun squareToQuad(d: FloatArray): FloatArray {
        val x0 = d[0]; val y0 = d[1]; val x1 = d[2]; val y1 = d[3]
        val x2 = d[4]; val y2 = d[5]; val x3 = d[6]; val y3 = d[7]
        val sx = x0 - x1 + x2 - x3
        val sy = y0 - y1 + y2 - y3
        val dx1 = x1 - x2; val dx2 = x3 - x2; val dy1 = y1 - y2; val dy2 = y3 - y2
        val den = dx1 * dy2 - dx2 * dy1
        var g = 0f; var h = 0f
        if ((abs(sx) > 1e-4f || abs(sy) > 1e-4f) && abs(den) > 1e-6f) {
            g = (sx * dy2 - dx2 * sy) / den
            h = (dx1 * sy - sx * dy1) / den
        }
        return floatArrayOf(
            x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
            y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
            g, h, 1f,
        )
    }

    fun invert(m: FloatArray): FloatArray {
        val a = m[0]; val b = m[1]; val c = m[2]
        val d = m[3]; val e = m[4]; val f = m[5]
        val g = m[6]; val h = m[7]; val i = m[8]
        val A = e * i - f * h; val B = -(d * i - f * g); val C = d * h - e * g
        val det = a * A + b * B + c * C
        if (abs(det) < 1e-12f) return floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f)
        val inv = 1f / det
        return floatArrayOf(
            A * inv, -(b * i - c * h) * inv, (b * f - c * e) * inv,
            B * inv, (a * i - c * g) * inv, -(a * f - c * d) * inv,
            C * inv, -(a * h - b * g) * inv, (a * e - b * d) * inv,
        )
    }

    /** a·b, 3x3 en filas. */
    fun mul(a: FloatArray, b: FloatArray) = FloatArray(9) { k ->
        val r = k / 3; val c = k % 3
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }

    /**
     * Residuo de la malla (Mapping v2) en (u,v) ∈ [0,1]², interpolación
     * bilineal entre los puntos de control. [off] = cols·rows pares (dx,dy)
     * normalizados al panel, fila a fila desde arriba-izquierda.
     */
    fun meshOffset(cols: Int, rows: Int, off: FloatArray, u: Float, v: Float): FloatArray {
        val fx = u.coerceIn(0f, 1f) * (cols - 1)
        val fy = v.coerceIn(0f, 1f) * (rows - 1)
        val i = minOf(fx.toInt(), cols - 2); val j = minOf(fy.toInt(), rows - 2)
        val tx = fx - i; val ty = fy - j
        fun at(c: Int, r: Int, k: Int) = off[(r * cols + c) * 2 + k]
        return FloatArray(2) { k ->
            val top = at(i, j, k) * (1 - tx) + at(i + 1, j, k) * tx
            val bottom = at(i, j + 1, k) * (1 - tx) + at(i + 1, j + 1, k) * tx
            top * (1 - ty) + bottom * ty
        }
    }

    /** px del panel (origen arriba-izquierda) → uv, para un rect: afín. */
    fun rectInverse(x: Float, y: Float, w: Float, h: Float) =
        floatArrayOf(1f / w, 0f, -x / w, 0f, 1f / h, -y / h, 0f, 0f, 1f)

    /**
     * Peor escala (px del panel por px de la fuente) a lo largo de los bordes
     * del quad. < 1 = minificación: el filtro bilineal directo empieza a
     * parpadear en el texto y hacen falta mipmaps.
     */
    fun minEdgeScale(d: FloatArray, srcW: Int, srcH: Int): Float {
        fun len(i: Int, j: Int) = hypot(d[j * 2] - d[i * 2], d[j * 2 + 1] - d[i * 2 + 1])
        val top = len(0, 1) / srcW
        val bottom = len(3, 2) / srcW
        val left = len(0, 3) / srcH
        val right = len(1, 2) / srcH
        return minOf(minOf(top, bottom), minOf(left, right))
    }

    /** Filas → columnas, para glUniformMatrix3fv (ES 2 no admite transpose). */
    fun toColumnMajor(m: FloatArray) = floatArrayOf(m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8])

    /** par(n) = n - n % 2: la misma fórmula que el server (PROTOCOL.md). */
    fun par(n: Int) = n - n % 2

    /** Destino en píxeles del panel de un rect normalizado (contrato). */
    fun rectPx(rx: Float, ry: Float, rw: Float, rh: Float, pw: Int, ph: Int): IntArray {
        var w = par(Math.round(rw * pw)).coerceIn(64, par(pw))
        var h = par(Math.round(rh * ph)).coerceIn(64, par(ph))
        val x = Math.round(rx * pw).coerceIn(0, pw - w)
        val y = Math.round(ry * ph).coerceIn(0, ph - h)
        return intArrayOf(x, y, w, h)
    }

    /**
     * El SurfaceTexture encoge el recorte 1 texel por lado cuando el buffer del
     * decoder es más grande que la imagen (alineación a 16/32): con eso el 1:1
     * deja de ser 1:1 (filas duplicadas). Se reconstruye el tamaño real del
     * buffer a partir de la matriz y se quita el encogido.
     * Ver GLConsumer::computeTransformMatrix (flipV * crop).
     */
    fun unshrinkTexMatrix(m: FloatArray, w: Int, h: Int): Boolean {
        if (abs(m[1]) > 1e-6f || abs(m[4]) > 1e-6f || m[0] <= 0f || m[5] >= 0f) return false
        var changed = false
        val sx = m[0]; val tx = m[12]
        if (abs(sx - 1f) > 1e-6f) {
            fit(w, sx, tx, cropFromTop = false)?.let { (buf, _) ->
                m[0] = w / buf; m[12] = 0f; changed = true
            }
        }
        val sy = -m[5]; val ty = 1f - m[13]
        if (abs(sy - 1f) > 1e-6f) {
            fit(h, sy, ty, cropFromTop = true)?.let { (buf, _) ->
                m[5] = -(h / buf); m[13] = 1f - (buf - h) / buf; changed = true
            }
        }
        return changed
    }

    /** Busca el (tamaño de buffer, encogido) que explica la escala y el offset. */
    private fun fit(size: Int, s: Float, t: Float, cropFromTop: Boolean): Pair<Float, Float>? {
        var best: Pair<Float, Float>? = null
        var bestErr = Float.MAX_VALUE
        for (shrink in floatArrayOf(0f, 0.5f, 1f)) {
            val buf = (size - 2 * shrink) / s
            if (buf < size - 0.01f) continue
            val expectT = if (cropFromTop) (buf - size + shrink) / buf else shrink / buf
            val err = abs(expectT - t) * buf
            if (err < bestErr) { bestErr = err; best = Pair(buf, shrink) }
        }
        return if (bestErr < 0.05f) best else null
    }
}
