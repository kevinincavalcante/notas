package com.kevinincavalcante.notas.sharereceiver

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import com.facebook.react.bridge.ReactApplicationContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream

/**
 * Recebe compartilhamentos de outros apps ("Compartilhar → Notas").
 *
 * - ACTION_SEND / ACTION_SEND_MULTIPLE chegam no MainActivity (intent filters
 *   no AndroidManifest). Aqui extraímos EXTRA_TEXT e EXTRA_STREAM/ClipData,
 *   copiamos os arquivos de content:// pro cache do app e devolvemos ao JS.
 * - Cold start: JS chama getShared() no mount.
 * - App já aberto (launchMode singleTask): OnNewIntent emite o evento
 *   "onShareReceived".
 */
class ShareReceiverModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ShareReceiver")

    Events("onShareReceived")

    OnNewIntent { intent ->
      val payload = extract(intent)
      if (payload != null) {
        clearExtras(intent)
        sendEvent("onShareReceived", payload)
      }
    }

    AsyncFunction("getShared") { promise: Promise ->
      val intent = (appContext.reactContext as? ReactApplicationContext)?.currentActivity?.intent
      val payload = extract(intent)
      if (payload != null) {
        intent?.let { clearExtras(it) }
      }
      promise.resolve(payload)
    }
  }

  /** Extrai texto e arquivos do intent de compartilhamento (ou null se não for um). */
  private fun extract(intent: Intent?): Map<String, Any?>? {
    if (intent == null) return null
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null

    val context = appContext.reactContext ?: return null
    val type = intent.type ?: ""

    val text = intent.getStringExtra(Intent.EXTRA_TEXT)

    val uris = mutableListOf<Uri>()
    if (action == Intent.ACTION_SEND_MULTIPLE) {
      @Suppress("DEPRECATION")
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.add(it) }
    }
    // Fallback: alguns apps (Android moderno) mandam via ClipData
    if (uris.isEmpty()) {
      intent.clipData?.let { clip ->
        for (i in 0 until clip.itemCount) {
          clip.getItemAt(i).uri?.let { uris.add(it) }
        }
      }
    }

    val files = uris.mapNotNull { uri ->
      try {
        val name = queryName(context.contentResolver, uri)
          ?: "compartilhado-${System.currentTimeMillis()}"
        val safeName = name.replace(Regex("[^\\w.\\- ]"), "_")
        val dir = File(context.cacheDir, "shared")
        dir.mkdirs()
        val dest = File(dir, safeName)
        context.contentResolver.openInputStream(uri)?.use { input ->
          FileOutputStream(dest).use { output -> input.copyTo(output) }
        } ?: return@mapNotNull null
        val mime = context.contentResolver.getType(uri) ?: type.ifEmpty { "application/octet-stream" }
        mapOf(
          "uri" to Uri.fromFile(dest).toString(),
          "name" to safeName,
          "mime" to mime
        )
      } catch (e: Exception) {
        null
      }
    }

    if (text.isNullOrBlank() && files.isEmpty()) return null
    return mapOf("text" to text, "files" to files)
  }

  /** Nome de exibição de um content:// via ContentResolver (OpenableColumns). */
  private fun queryName(resolver: ContentResolver, uri: Uri): String? {
    try {
      resolver.query(uri, null, null, null, null)?.use { cursor ->
        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (idx >= 0 && cursor.moveToFirst()) {
          cursor.getString(idx)?.let { return it }
        }
      }
    } catch (e: Exception) {
      // sem permissão pro displayName — segue pro fallback
    }
    return null
  }

  /** Limpa o intent pra não reprocessar no próximo resume. */
  private fun clearExtras(intent: Intent) {
    try {
      intent.removeExtra(Intent.EXTRA_TEXT)
      intent.removeExtra(Intent.EXTRA_STREAM)
      intent.clipData = null
    } catch (e: Exception) {
      // best effort
    }
  }
}
