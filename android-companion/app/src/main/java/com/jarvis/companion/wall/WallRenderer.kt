package com.jarvis.companion.wall

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.SurfaceTexture
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLES30
import android.opengl.GLSurfaceView
import android.opengl.GLUtils
import android.util.Log
import android.view.Surface
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.atomic.AtomicBoolean
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

/**
 * Pinta el stream con el warp, en la GPU (Mali-G31, GLES 3.2). Desde v3 todo
 * lo que se ve es stream, así que el mapping v2 entero (ángulos, zoom/shift,
 * malla) se aplica aquí; el keystone de hardware se descartó.
 *
 * Un solo shader para los dos modos: cada fragmento calcula su uv con una
 * matriz 3x3 panel→fuente (afín en modo pantalla, homografía inversa en modo
 * forma). Así el 1:1 es exacto por construcción: el centro del píxel X+i+0.5
 * cae en el centro del texel i, y con GL_NEAREST no hay remuestreo. El quad
 * es el `resolved` del server (perspectiva + zoom/shift ya aplicados).
 *
 * Modo forma con minificación fuerte: las texturas OES no admiten mipmaps, así
 * que se copia 1:1 a una textura 2D (FBO), se generan mipmaps y se muestrea
 * trilineal (+ anisótropo si hay). La copia es 1:1: sigue habiendo un solo
 * remuestreo.
 *
 * Malla (`mesh`): la inversa por fragmento ya no existe, así que se dibuja
 * una rejilla de triángulos en sentido directo, uv → H(uv) + residuo
 * bilineal. La posición sale con w = el denominador de H: el hardware
 * interpola uv con corrección de perspectiva y la parte proyectiva queda
 * exacta; el residuo se aproxima por tramos (rejilla fina).
 *
 * Encima del vídeo, con el MISMO warp: la calibración (grid|cross|text|edges)
 * y el cursor virtual del navegador de la pared (v3).
 */
class WallRenderer(private val onSurface: (Surface) -> Unit) : GLSurfaceView.Renderer, SurfaceTexture.OnFrameAvailableListener {

    companion object {
        private const val TAG = "WallRenderer"
        private const val GL_TEXTURE_MAX_ANISOTROPY_EXT = 0x84FE
        private const val GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT = 0x84FF
        // Rejilla de la malla: 32×18 celdas (≈ 40 px a 1280x720).
        private const val GRID_X = 32
        private const val GRID_Y = 18

        private const val VERTEX = """
            attribute vec2 aPos;
            void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
        """

        // Exponente de gamma < 1: sube las sombras para distinguir oscuro sobre
        // negro en el proyector. 1.0 = sin cambio.
        private const val SHADOW_LIFT = "0.85"

        // gl_FragCoord tiene el origen abajo: se pasa a píxeles del panel con
        // origen arriba-izquierda, como el contrato.
        private const val FRAG_OES = """
            #extension GL_OES_EGL_image_external : require
            precision highp float;
            uniform samplerExternalOES uTex;
            uniform mat3 uInv;
            uniform mat4 uTexM;
            uniform float uViewH;
            void main() {
                vec2 p = vec2(gl_FragCoord.x, uViewH - gl_FragCoord.y);
                vec3 h = uInv * vec3(p, 1.0);
                vec2 uv = h.xy / h.z;
                vec4 c = texture2D(uTex, (uTexM * vec4(uv.x, 1.0 - uv.y, 0.0, 1.0)).xy);
                if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
                gl_FragColor = vec4(pow(c.rgb, vec3(${SHADOW_LIFT})), c.a);
            }
        """

        // Muestreo antes del discard: las derivadas (LOD de los mipmaps) no
        // están definidas dentro de control de flujo divergente.
        private const val FRAG_2D = """
            precision highp float;
            uniform sampler2D uTex;
            uniform mat3 uInv;
            uniform float uViewH;
            uniform float uFlip;
            void main() {
                vec2 p = vec2(gl_FragCoord.x, uViewH - gl_FragCoord.y);
                vec3 h = uInv * vec3(p, 1.0);
                vec2 uv = h.xy / h.z;
                vec4 c = texture2D(uTex, vec2(uv.x, mix(uv.y, 1.0 - uv.y, uFlip)));
                if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
                gl_FragColor = vec4(pow(c.rgb, vec3(${SHADOW_LIFT})), c.a);
            }
        """

        // Malla: posición ya en clip (con w), uv del stream interpolada.
        private const val VERTEX_MESH = """
            attribute vec4 aPos;
            attribute vec2 aUv;
            varying vec2 vUv;
            void main() { gl_Position = aPos; vUv = aUv; }
        """

        private const val FRAG_MESH_OES = """
            #extension GL_OES_EGL_image_external : require
            precision highp float;
            uniform samplerExternalOES uTex;
            uniform mat4 uTexM;
            varying vec2 vUv;
            void main() {
                vec4 c = texture2D(uTex, (uTexM * vec4(vUv.x, 1.0 - vUv.y, 0.0, 1.0)).xy);
                gl_FragColor = vec4(pow(c.rgb, vec3(${SHADOW_LIFT})), c.a);
            }
        """

        // uSub: uv del stream → uv de la textura (identidad para el vídeo y la
        // calibración; el rectángulo del cursor para el cursor).
        private const val FRAG_MESH_2D = """
            precision highp float;
            uniform sampler2D uTex;
            uniform mat3 uSub;
            uniform float uFlip;
            varying vec2 vUv;
            void main() {
                vec2 uv = (uSub * vec3(vUv, 1.0)).xy;
                vec4 c = texture2D(uTex, vec2(uv.x, mix(uv.y, 1.0 - uv.y, uFlip)));
                if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
                gl_FragColor = vec4(pow(c.rgb, vec3(${SHADOW_LIFT})), c.a);
            }
        """

        private val IDENTITY = floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f)
    }

    private val quad: FloatBuffer = ByteBuffer.allocateDirect(8 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply {
        put(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f)); position(0)
    }

    private var oesTex = 0
    private var surfaceTexture: SurfaceTexture? = null
    private var progOes = 0
    private var progTex = 0
    private var progMeshOes = 0
    private var progMeshTex = 0
    private val frameAvailable = AtomicBoolean(false)
    private val texM = FloatArray(16)
    private var haveFrame = false
    private var viewW = 1280
    private var viewH = 720
    private var maxAniso = 0f
    @Volatile var view: GLSurfaceView? = null

    // Estado que llega del hilo principal (siempre vía queueEvent).
    private var warp = WallHub.Warp.DEFAULT
    private var streamW = 0
    private var streamH = 0
    private var calibration = false
    private var pattern = "grid"
    private var cursor = WallHub.Cursor(0.5f, 0.5f, false)

    // Derivados del warp.
    private var inv = FloatArray(9)
    private var fwd = FloatArray(9)
    private var oesFilter = GLES20.GL_LINEAR
    private var useMips = false
    private var destW = 0
    private var destH = 0
    private var meshBuf: FloatBuffer? = null
    private var meshIdx: java.nio.ShortBuffer? = null
    private var meshCount = 0

    // FBO de mipmaps.
    private var fbo = 0
    private var fboTex = 0
    private var fboW = 0
    private var fboH = 0

    // Calibración y cursor.
    private var calTex = 0
    private var calKey = ""
    private var cursorTex = 0
    private var cursorTexW = 0
    private var cursorTexH = 0

    private var loggedMatrix = false

    fun setWarp(w: WallHub.Warp) { warp = w; recompute() }
    fun setStream(w: Int, h: Int) { streamW = w; streamH = h; haveFrame = false; loggedMatrix = false; recompute() }
    fun setCalibration(on: Boolean) { calibration = on }
    fun setPattern(p: String) { pattern = p }
    fun setCursor(c: WallHub.Cursor) { cursor = c }

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        progOes = program(VERTEX, FRAG_OES)
        progTex = program(VERTEX, FRAG_2D)
        progMeshOes = program(VERTEX_MESH, FRAG_MESH_OES)
        progMeshTex = program(VERTEX_MESH, FRAG_MESH_2D)
        val t = IntArray(1)
        GLES20.glGenTextures(1, t, 0)
        oesTex = t[0]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex)
        texParams(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_LINEAR, GLES20.GL_LINEAR)
        val ext = GLES20.glGetString(GLES20.GL_EXTENSIONS) ?: ""
        if (ext.contains("GL_EXT_texture_filter_anisotropic")) {
            val f = FloatArray(1)
            GLES20.glGetFloatv(GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT, f, 0)
            maxAniso = f[0]
        }
        fbo = 0; fboTex = 0; fboW = 0; fboH = 0; calTex = 0; calKey = ""; cursorTex = 0
        surfaceTexture?.release()
        val st = SurfaceTexture(oesTex)
        st.setOnFrameAvailableListener(this)
        surfaceTexture = st
        haveFrame = false
        Log.i(TAG, "GL listo: ${GLES20.glGetString(GLES20.GL_RENDERER)} ${GLES20.glGetString(GLES20.GL_VERSION)} aniso=$maxAniso")
        onSurface(Surface(st))
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        viewW = width
        viewH = height
        Log.i(TAG, "superficie ${width}x$height")
        recompute()
    }

    override fun onFrameAvailable(st: SurfaceTexture?) {
        frameAvailable.set(true)
        view?.requestRender()
    }

    private val meshActive get() = warp.mesh?.isZero == false

    private fun recompute() {
        val pw = viewW; val ph = viewH
        val sw = if (streamW > 0) streamW else pw
        val sh = if (streamH > 0) streamH else ph
        if (warp.shape || meshActive) {
            // El quad resuelto por el server (ángulos + zoom/shift); en modo
            // pantalla con malla, el rect resuelto como quad.
            val q = warp.quad()
            val d = FloatArray(8) { i -> q[i] * (if (i % 2 == 0) pw else ph) }
            fwd = Homography.squareToQuad(d)
            inv = Homography.invert(fwd)
            useMips = Homography.minEdgeScale(d, sw, sh) < 0.8f
            oesFilter = GLES20.GL_LINEAR
            var x0 = Float.MAX_VALUE; var x1 = -Float.MAX_VALUE; var y0 = Float.MAX_VALUE; var y1 = -Float.MAX_VALUE
            for (i in 0 until 4) {
                x0 = minOf(x0, d[i * 2]); x1 = maxOf(x1, d[i * 2]); y0 = minOf(y0, d[i * 2 + 1]); y1 = maxOf(y1, d[i * 2 + 1])
            }
            destW = Homography.par(Math.round(x1 - x0)); destH = Homography.par(Math.round(y1 - y0))
        } else {
            val sr = warp.screenRect()
            val r = Homography.rectPx(sr[0], sr[1], sr[2], sr[3], pw, ph)
            inv = Homography.rectInverse(r[0].toFloat(), r[1].toFloat(), r[2].toFloat(), r[3].toFloat())
            fwd = Homography.invert(inv)
            useMips = false
            destW = r[2]; destH = r[3]
            // 1:1 exacto solo si el stream mide lo mismo que el destino; si no
            // (transición entre tamaños), bilineal para no pixelar.
            oesFilter = if (streamW == r[2] && streamH == r[3]) GLES20.GL_NEAREST else GLES20.GL_LINEAR
        }
        buildMesh(pw, ph)
    }

    /** Rejilla directa uv → panel con el residuo de la malla (o nada si no hay malla). */
    private fun buildMesh(pw: Int, ph: Int) {
        val m = warp.mesh
        if (m == null || m.isZero) { meshBuf = null; meshCount = 0; return }
        val v = FloatArray((GRID_X + 1) * (GRID_Y + 1) * 6)
        var k = 0
        for (j in 0..GRID_Y) for (i in 0..GRID_X) {
            val u = i / GRID_X.toFloat(); val w = j / GRID_Y.toFloat()
            val hx = fwd[0] * u + fwd[1] * w + fwd[2]
            val hy = fwd[3] * u + fwd[4] * w + fwd[5]
            val hw = fwd[6] * u + fwd[7] * w + fwd[8]
            val off = Homography.meshOffset(m.cols, m.rows, m.offsets, u, w)
            val px = hx / hw + off[0] * pw
            val py = hy / hw + off[1] * ph
            // Clip con w = hw: interpolación de uv con corrección de perspectiva.
            v[k++] = (px / pw * 2f - 1f) * hw
            v[k++] = (1f - py / ph * 2f) * hw
            v[k++] = 0f
            v[k++] = hw
            v[k++] = u
            v[k++] = w
        }
        val idx = ShortArray(GRID_X * GRID_Y * 6)
        var n = 0
        for (j in 0 until GRID_Y) for (i in 0 until GRID_X) {
            val a = (j * (GRID_X + 1) + i).toShort(); val b = (a + 1).toShort()
            val c = (a + GRID_X + 1).toShort(); val d = (c + 1).toShort()
            idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d
        }
        meshBuf = ByteBuffer.allocateDirect(v.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply { put(v); position(0) }
        meshIdx = ByteBuffer.allocateDirect(idx.size * 2).order(ByteOrder.nativeOrder()).asShortBuffer().apply { put(idx); position(0) }
        meshCount = idx.size
    }

    override fun onDrawFrame(gl: GL10?) {
        val st = surfaceTexture ?: return
        if (frameAvailable.getAndSet(false)) {
            st.updateTexImage()
            st.getTransformMatrix(texM)
            if (!loggedMatrix) Log.i(TAG, "texM crudo ${texM.joinToString(",") { "%.5f".format(it) }}")
            val fixed = Homography.unshrinkTexMatrix(texM, streamW, streamH)
            if (!loggedMatrix) {
                Log.i(TAG, "stream ${streamW}x$streamH destino ${destW}x$destH filtro=${if (oesFilter == GLES20.GL_NEAREST) "nearest" else "linear"} mips=$useMips malla=${meshBuf != null} encogido-corregido=$fixed")
                loggedMatrix = true
            }
            haveFrame = true
        }
        GLES20.glViewport(0, 0, viewW, viewH)
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
        GLES20.glDisable(GLES20.GL_BLEND)

        if (haveFrame && streamW > 0) {
            when {
                meshBuf != null && useMips -> { copyToMips(); drawMeshTex(fboTex, IDENTITY, flip = true, mips = true) }
                meshBuf != null -> drawMeshOes()
                useMips -> { copyToMips(); drawTex(fboTex, inv, flip = true, mips = true, nearest = false) }
                else -> drawOes(inv, viewH.toFloat(), oesFilter)
            }
        }
        if (calibration) drawCalibration()
        if (cursor.visible && haveFrame && streamW > 0) drawCursor()
    }

    private fun drawOes(m: FloatArray, vh: Float, filter: Int) {
        GLES20.glUseProgram(progOes)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex)
        texParams(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, filter, filter)
        GLES20.glUniform1i(GLES20.glGetUniformLocation(progOes, "uTex"), 0)
        GLES20.glUniformMatrix3fv(GLES20.glGetUniformLocation(progOes, "uInv"), 1, false, Homography.toColumnMajor(m), 0)
        GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(progOes, "uTexM"), 1, false, texM, 0)
        GLES20.glUniform1f(GLES20.glGetUniformLocation(progOes, "uViewH"), vh)
        drawQuad(progOes)
    }

    private fun drawTex(tex: Int, m: FloatArray, flip: Boolean, mips: Boolean, nearest: Boolean) {
        GLES20.glUseProgram(progTex)
        bindTex2D(tex, mips, nearest)
        GLES20.glUniform1i(GLES20.glGetUniformLocation(progTex, "uTex"), 0)
        GLES20.glUniformMatrix3fv(GLES20.glGetUniformLocation(progTex, "uInv"), 1, false, Homography.toColumnMajor(m), 0)
        GLES20.glUniform1f(GLES20.glGetUniformLocation(progTex, "uViewH"), viewH.toFloat())
        GLES20.glUniform1f(GLES20.glGetUniformLocation(progTex, "uFlip"), if (flip) 1f else 0f)
        drawQuad(progTex)
    }

    private fun bindTex2D(tex: Int, mips: Boolean, nearest: Boolean) {
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, tex)
        val min = when {
            mips -> GLES20.GL_LINEAR_MIPMAP_LINEAR
            nearest -> GLES20.GL_NEAREST
            else -> GLES20.GL_LINEAR
        }
        texParams(GLES20.GL_TEXTURE_2D, min, if (nearest) GLES20.GL_NEAREST else GLES20.GL_LINEAR)
        if (mips && maxAniso > 1f) GLES20.glTexParameterf(GLES20.GL_TEXTURE_2D, GL_TEXTURE_MAX_ANISOTROPY_EXT, minOf(8f, maxAniso))
    }

    private fun drawMeshOes() {
        GLES20.glUseProgram(progMeshOes)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex)
        texParams(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_LINEAR, GLES20.GL_LINEAR)
        GLES20.glUniform1i(GLES20.glGetUniformLocation(progMeshOes, "uTex"), 0)
        GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(progMeshOes, "uTexM"), 1, false, texM, 0)
        drawMeshGeometry(progMeshOes)
    }

    private fun drawMeshTex(tex: Int, sub: FloatArray, flip: Boolean, mips: Boolean) {
        GLES20.glUseProgram(progMeshTex)
        bindTex2D(tex, mips, nearest = false)
        GLES20.glUniform1i(GLES20.glGetUniformLocation(progMeshTex, "uTex"), 0)
        GLES20.glUniformMatrix3fv(GLES20.glGetUniformLocation(progMeshTex, "uSub"), 1, false, Homography.toColumnMajor(sub), 0)
        GLES20.glUniform1f(GLES20.glGetUniformLocation(progMeshTex, "uFlip"), if (flip) 1f else 0f)
        drawMeshGeometry(progMeshTex)
    }

    private fun drawMeshGeometry(prog: Int) {
        val buf = meshBuf ?: return
        val idx = meshIdx ?: return
        val pos = GLES20.glGetAttribLocation(prog, "aPos")
        val uv = GLES20.glGetAttribLocation(prog, "aUv")
        buf.position(0)
        GLES20.glEnableVertexAttribArray(pos)
        GLES20.glVertexAttribPointer(pos, 4, GLES20.GL_FLOAT, false, 6 * 4, buf)
        buf.position(4)
        GLES20.glEnableVertexAttribArray(uv)
        GLES20.glVertexAttribPointer(uv, 2, GLES20.GL_FLOAT, false, 6 * 4, buf)
        idx.position(0)
        GLES20.glDrawElements(GLES20.GL_TRIANGLES, meshCount, GLES20.GL_UNSIGNED_SHORT, idx)
        GLES20.glDisableVertexAttribArray(pos)
        GLES20.glDisableVertexAttribArray(uv)
        buf.position(0)
    }

    /** Copia 1:1 del frame (NEAREST) a la textura 2D del FBO y sus mipmaps. */
    private fun copyToMips() {
        ensureFbo(streamW, streamH)
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo)
        GLES20.glViewport(0, 0, fboW, fboH)
        drawOes(Homography.rectInverse(0f, 0f, fboW.toFloat(), fboH.toFloat()), fboH.toFloat(), GLES20.GL_NEAREST)
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, fboTex)
        GLES20.glGenerateMipmap(GLES20.GL_TEXTURE_2D)
        GLES20.glViewport(0, 0, viewW, viewH)
    }

    private fun ensureFbo(w: Int, h: Int) {
        if (fbo != 0 && fboW == w && fboH == h) return
        if (fbo != 0) {
            GLES20.glDeleteFramebuffers(1, intArrayOf(fbo), 0)
            GLES20.glDeleteTextures(1, intArrayOf(fboTex), 0)
        }
        val t = IntArray(1)
        GLES20.glGenTextures(1, t, 0)
        fboTex = t[0]
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, fboTex)
        // Almacenamiento inmutable con todos los niveles: ES3 permite mipmaps
        // en texturas no potencia de dos.
        val levels = 1 + (Math.log(maxOf(w, h).toDouble()) / Math.log(2.0)).toInt()
        GLES30.glTexStorage2D(GLES20.GL_TEXTURE_2D, levels, GLES30.GL_RGBA8, w, h)
        val f = IntArray(1)
        GLES20.glGenFramebuffers(1, f, 0)
        fbo = f[0]
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo)
        GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, fboTex, 0)
        val status = GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER)
        if (status != GLES20.GL_FRAMEBUFFER_COMPLETE) Log.e(TAG, "FBO incompleto: $status")
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
        fboW = w; fboH = h
    }

    /**
     * Patrón de calibración dibujado a la medida del destino y pasado por el
     * MISMO warp que el vídeo (malla incluida): lo que se ve es exactamente la
     * superficie que ocupará el stream.
     */
    private fun drawCalibration() {
        val w = destW.coerceAtLeast(64); val h = destH.coerceAtLeast(64)
        // El fondo cambia con haveFrame (opaco sin stream, transparente encima del vídeo).
        val key = "${w}x$h/${warp.shape}/$haveFrame/$pattern/${warp.mesh?.let { "${it.cols}x${it.rows}" }}"
        if (calTex == 0 || key != calKey) {
            if (calTex != 0) GLES20.glDeleteTextures(1, intArrayOf(calTex), 0)
            val bmp = calibrationBitmap(w, h, if (warp.shape) "forma" else "pantalla")
            calTex = upload(bmp)
            bmp.recycle()
            calKey = key
        }
        GLES20.glEnable(GLES20.GL_BLEND)
        GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA)
        val mips = warp.shape || meshBuf != null
        if (meshBuf != null) drawMeshTex(calTex, IDENTITY, flip = false, mips = true)
        else drawTex(calTex, inv, flip = false, mips = mips, nearest = !mips)
        GLES20.glDisable(GLES20.GL_BLEND)
    }

    /**
     * Cursor virtual (v3) en coordenadas del stream: la flecha ocupa un
     * rectángulo de uv con la punta en (x,y) y se pinta con el warp del vídeo
     * (A·inv: panel → uv del stream → uv de la flecha).
     */
    private fun drawCursor() {
        if (cursorTex == 0) {
            val bmp = cursorBitmap()
            cursorTexW = bmp.width; cursorTexH = bmp.height
            cursorTex = upload(bmp)
            bmp.recycle()
        }
        // Alto ≈ 4,5 % del stream, mínimo 20 px del stream.
        val hPx = maxOf(20f, streamH * 0.045f)
        val ch = hPx / streamH
        val cw = hPx * cursorTexW / cursorTexH / streamW
        val a = floatArrayOf(1f / cw, 0f, -cursor.x / cw, 0f, 1f / ch, -cursor.y / ch, 0f, 0f, 1f)
        GLES20.glEnable(GLES20.GL_BLEND)
        GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA)
        if (meshBuf != null) drawMeshTex(cursorTex, a, flip = false, mips = false)
        else drawTex(cursorTex, Homography.mul(a, inv), flip = false, mips = false, nearest = false)
        GLES20.glDisable(GLES20.GL_BLEND)
    }

    private fun upload(bmp: Bitmap): Int {
        val t = IntArray(1)
        GLES20.glGenTextures(1, t, 0)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, t[0])
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bmp, 0)
        GLES20.glGenerateMipmap(GLES20.GL_TEXTURE_2D)
        return t[0]
    }

    /** Flecha blanca con borde negro, alfa premultiplicado (como espera el blend ONE, 1−SRC_ALPHA). */
    private fun cursorBitmap(): Bitmap {
        val bmp = Bitmap.createBitmap(48, 72, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val p = Path().apply {
            moveTo(3f, 3f); lineTo(3f, 57f); lineTo(16f, 45f); lineTo(25f, 66f)
            lineTo(34f, 62f); lineTo(25f, 42f); lineTo(43f, 42f); close()
        }
        c.drawPath(p, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.FILL })
        c.drawPath(p, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; style = Paint.Style.STROKE; strokeWidth = 3f; strokeJoin = Paint.Join.ROUND })
        return bmp
    }

    private fun calibrationBitmap(w: Int, h: Int, mode: String): Bitmap {
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.drawColor(if (haveFrame) Color.TRANSPARENT else Color.rgb(12, 16, 22))
        val l = minOf(w, h) / 8f
        val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = (h / 18f).coerceIn(14f, 36f) }
        when (pattern) {
            "cross" -> {
                // Centrado y aspecto: cruz a todo lo ancho/alto, diagonales y círculos.
                val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(255, 60, 60); strokeWidth = 2f }
                c.drawLine(0f, h / 2f, w.toFloat(), h / 2f, line)
                c.drawLine(w / 2f, 0f, w / 2f, h.toFloat(), line)
                val diag = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0, 190, 120); strokeWidth = 1.5f }
                c.drawLine(0f, 0f, w.toFloat(), h.toFloat(), diag)
                c.drawLine(w.toFloat(), 0f, 0f, h.toFloat(), diag)
                val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; strokeWidth = 2f; style = Paint.Style.STROKE }
                for (k in 1..3) c.drawCircle(w / 2f, h / 2f, h * k / 6.5f, ring)
                c.drawRect(1f, 1f, w - 1f, h - 1f, ring)
            }
            "text" -> {
                // Nitidez: texto de varios tamaños y pares de líneas de 1 px.
                var y = 8f
                for (size in floatArrayOf(10f, 12f, 14f, 16f, 20f, 24f, 32f, 44f)) {
                    val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = size }
                    y += size * 1.25f
                    if (y > h - 40) break
                    c.drawText("${size.toInt()} px · Pared ABCDEFG abcdefg 0123456789", 12f, y, p)
                }
                val thin = Paint().apply { color = Color.WHITE; strokeWidth = 1f }
                for (i in 0 until 24) {
                    val x = w - 12f - i * 2f
                    c.drawLine(x + 0.5f, h - 60f, x + 0.5f, h - 12f, thin)
                }
            }
            "edges" -> {
                // Bordes: 1 px blanco en el límite exacto, marcas cada 10 % y las esquinas rotuladas.
                val edge = Paint().apply { color = Color.WHITE; strokeWidth = 1f; style = Paint.Style.STROKE }
                c.drawRect(0.5f, 0.5f, w - 0.5f, h - 0.5f, edge)
                val inner = Paint().apply { color = Color.rgb(255, 60, 60); strokeWidth = 2f; style = Paint.Style.STROKE }
                c.drawRect(w * 0.02f, h * 0.02f, w * 0.98f, h * 0.98f, inner)
                val tick = Paint().apply { color = Color.rgb(255, 200, 0); strokeWidth = 2f }
                for (k in 1..9) {
                    val x = w * k / 10f; val y = h * k / 10f
                    c.drawLine(x, 0f, x, l / 3, tick); c.drawLine(x, h.toFloat(), x, h - l / 3, tick)
                    c.drawLine(0f, y, l / 3, y, tick); c.drawLine(w.toFloat(), y, w - l / 3, y, tick)
                }
                val t = Paint(label).apply { textSize = (h / 14f).coerceIn(14f, 40f) }
                c.drawText("TL", l / 2, l / 2 + t.textSize, t)
                c.drawText("TR", w - l / 2 - t.measureText("TR"), l / 2 + t.textSize, t)
                c.drawText("BR", w - l / 2 - t.measureText("BR"), h - l / 2, t)
                c.drawText("BL", l / 2, h - l / 2, t)
            }
            else -> {
                // grid: 16x9 + borde + esquinas + cruz central (+ puntos de la malla).
                val grid = Paint().apply { color = Color.rgb(0, 190, 120); strokeWidth = 1f }
                for (i in 0..16) { val x = i * (w - 1) / 16f; c.drawLine(x, 0f, x, h.toFloat(), grid) }
                for (j in 0..9) { val y = j * (h - 1) / 9f; c.drawLine(0f, y, w.toFloat(), y, grid) }
                val edge = Paint().apply { color = Color.WHITE; strokeWidth = 3f; style = Paint.Style.STROKE }
                c.drawRect(1.5f, 1.5f, w - 1.5f, h - 1.5f, edge)
                val corner = Paint().apply { color = Color.rgb(255, 200, 0); strokeWidth = 6f }
                for ((cx, cy, sx, sy) in listOf(
                    floatArrayOf(0f, 0f, 1f, 1f), floatArrayOf(w.toFloat(), 0f, -1f, 1f),
                    floatArrayOf(w.toFloat(), h.toFloat(), -1f, -1f), floatArrayOf(0f, h.toFloat(), 1f, -1f),
                ).map { arrayOf(it[0], it[1], it[2], it[3]) }) {
                    c.drawLine(cx, cy + sy * 3f, cx + sx * l, cy + sy * 3f, corner)
                    c.drawLine(cx + sx * 3f, cy, cx + sx * 3f, cy + sy * l, corner)
                }
                val cross = Paint().apply { color = Color.rgb(255, 60, 60); strokeWidth = 2f }
                c.drawLine(w / 2f - l / 2, h / 2f, w / 2f + l / 2, h / 2f, cross)
                c.drawLine(w / 2f, h / 2f - l / 2, w / 2f, h / 2f + l / 2, cross)
                warp.mesh?.let { m ->
                    val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(80, 170, 255) }
                    for (j in 0 until m.rows) for (i in 0 until m.cols) {
                        c.drawCircle(i * (w - 1f) / (m.cols - 1), j * (h - 1f) / (m.rows - 1), 6f, dot)
                    }
                }
            }
        }
        c.drawText("$w×$h · $mode · $pattern", 12f, h - 16f, label)
        return bmp
    }

    private fun drawQuad(prog: Int) {
        val loc = GLES20.glGetAttribLocation(prog, "aPos")
        GLES20.glEnableVertexAttribArray(loc)
        GLES20.glVertexAttribPointer(loc, 2, GLES20.GL_FLOAT, false, 0, quad)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glDisableVertexAttribArray(loc)
    }

    private fun texParams(target: Int, min: Int, mag: Int) {
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MIN_FILTER, min)
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MAG_FILTER, mag)
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    }

    private fun program(vs: String, fs: String): Int {
        fun shader(type: Int, src: String): Int {
            val s = GLES20.glCreateShader(type)
            GLES20.glShaderSource(s, src.trimIndent())
            GLES20.glCompileShader(s)
            val ok = IntArray(1)
            GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0)
            if (ok[0] == 0) Log.e(TAG, "shader: ${GLES20.glGetShaderInfoLog(s)}")
            return s
        }
        val p = GLES20.glCreateProgram()
        GLES20.glAttachShader(p, shader(GLES20.GL_VERTEX_SHADER, vs))
        GLES20.glAttachShader(p, shader(GLES20.GL_FRAGMENT_SHADER, fs))
        GLES20.glLinkProgram(p)
        val ok = IntArray(1)
        GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, ok, 0)
        if (ok[0] == 0) Log.e(TAG, "link: ${GLES20.glGetProgramInfoLog(p)}")
        return p
    }

    fun release() {
        surfaceTexture?.release()
        surfaceTexture = null
    }
}
