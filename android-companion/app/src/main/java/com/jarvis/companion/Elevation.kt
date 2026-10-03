package com.jarvis.companion

import android.app.Activity
import android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG
import android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Step-up authorisation for risky actions (backend lib/riskAuth.js).
 *
 * An EC P-256 key lives in the Android Keystore with "user authentication on
 * EVERY use": the private key never leaves secure hardware and can only sign
 * after the fingerprint or the device PIN/pattern. The backend sends a random
 * challenge; the signature over it is the proof. A check done only in the page
 * would be bypassable by anyone with the web token — this one is not.
 *
 * Needs API 30 (per-use auth that accepts BIOMETRIC_STRONG *or* the device
 * credential with a CryptoObject). Older devices report unsupported.
 */
object Elevation {
    private const val ALIAS = "jarvis_elevation"
    private const val KEYSTORE = "AndroidKeyStore"

    fun supported(): Boolean = Build.VERSION.SDK_INT >= 30

    /** Base64 SPKI of the public key, creating the key on first use; null if unsupported/failed. */
    fun publicKey(): String? {
        if (!supported()) return null
        return try {
            val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            val cert = ks.getCertificate(ALIAS) ?: run { generate(); ks.getCertificate(ALIAS) }
            Base64.encodeToString(cert.publicKey.encoded, Base64.NO_WRAP)
        } catch (e: Exception) {
            null
        }
    }

    private fun generate() {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            // 0 s = every single signature needs a fresh fingerprint or PIN.
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).apply {
            initialize(spec)
            generateKeyPair()
        }
    }

    private fun deleteKey() {
        try { KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(ALIAS) } catch (_: Exception) {}
    }

    /**
     * Show the system fingerprint/PIN prompt and sign [challengeB64].
     * [done] gets (signatureB64, null) or (null, spanishError). Main thread only.
     */
    fun sign(activity: Activity, challengeB64: String, done: (String?, String?) -> Unit) {
        if (!supported()) return done(null, "Este dispositivo no admite autorización con huella (requiere Android 11).")
        val signature = try {
            if (publicKey() == null) return done(null, "No pude crear la clave segura del dispositivo.")
            val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            val key = ks.getKey(ALIAS, null) as PrivateKey
            Signature.getInstance("SHA256withECDSA").apply { initSign(key) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            // Lock screen removed or changed: the old key is dead. A new one needs
            // re-enrolling (with the password) — the page handles "not_enrolled".
            deleteKey()
            return done(null, "La clave del dispositivo se invalidó (cambió el bloqueo). Vuelve a intentarlo para inscribirla de nuevo.")
        } catch (e: Exception) {
            return done(null, "No pude preparar la firma: ${e.message}")
        }

        val prompt = BiometricPrompt.Builder(activity)
            .setTitle("Autorizar acción de Jarvis")
            .setSubtitle("Huella o PIN de la tablet")
            .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
            .build()
        prompt.authenticate(
            BiometricPrompt.CryptoObject(signature),
            CancellationSignal(),
            activity.mainExecutor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    try {
                        val sig = result.cryptoObject?.signature ?: return done(null, "Sin firma.")
                        sig.update(Base64.decode(challengeB64, Base64.DEFAULT))
                        done(Base64.encodeToString(sig.sign(), Base64.NO_WRAP), null)
                    } catch (e: Exception) {
                        done(null, "No se pudo firmar: ${e.message}")
                    }
                }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    done(null, errString.toString().ifBlank { "Autorización cancelada." })
                }
                // onAuthenticationFailed = one bad finger; the prompt stays open, nothing to do.
            },
        )
    }
}
