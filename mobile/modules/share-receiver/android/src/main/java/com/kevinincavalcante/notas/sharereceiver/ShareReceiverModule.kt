package com.kevinincavalcante.notas.sharereceiver

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/**
 * Recebe compartilhamentos de outros apps ("Compartilhar → Notas").
 *
 * - ACTION_SEND / ACTION_SEND_MULTIPLE chegam no MainActivity (intent filters
 *   no AndroidManifest). Aqui extraímos EXTRA_TEXT, EXTRA_SUBJECT e EXTRA_STREAM/ClipData,
 *   copiamos os arquivos de content:// pro cache do app e devolvemos ao JS.
 * - Cold start: JS chama getShared() no mount (e OnActivityEntersForeground cobre
 *   qualquer janela entre o mount do módulo e a Activity pronta).
 * - App já aberto (launchMode singleTask): OnNewIntent emite o evento
 *   "onShareReceived".
 *
 * Fila com ACK (não perder share no cold start):
 * - Usa appContext.currentActivity (compatível com New Architecture / Bridgeless;
 *   reactContext as? ReactApplicationContext retornava null no cold start).
 * - Antes do JS confirmar com ack(), o payload fica em `pending` (no processo) e
 *   é entregue no getShared() ou via sendEvent quando o listener existir.
 */
class ShareReceiverModule : Module() {
  /**
   * Estado do PROCESSO, fora da instância: uma Activity recriada cria outro
   * module, mas a fila entregue-e-não-confirmada precisa sobreviver.
   */
  private companion object {
    val queueLock = Any()
    val pending = mutableListOf<Map<String, Any?>>()
    /** Entrega direta pro JS (setado onSubscriber; limpado no OnDestroy). */
    @Volatile
    var READY: ((Map<String, Any?>) -> Unit)? = null
  }

  override fun definition() = ModuleDefinition {
    Name("ShareReceiver")

    Events("onShareReceived")

    // O JS só chega aqui quando registra o listener do módulo (addListener):
    // a partir daí OnNewIntent/OnActivityEntersForeground entregam direto.
    OnStartObserving("onShareReceived") {
      READY = { sendEvent("onShareReceived", it) }
    }

    OnDestroy {
      READY = null
    }

    OnNewIntent { intent ->
      val payload = synchronized(queueLock) {
        extract(intent)?.also { clearExtras(intent) }
      }
      if (payload != null) emit(payload)
    }

    OnActivityEntersForeground {
      consumeActivityIntent()?.let { emit(it) }
    }

    AsyncFunction("getShared") { promise: Promise ->
      // No cold start, move o intent da Activity para `pending` (com lock)
      // para nunca perder nem duplicar enquanto aguarda ack().
      consumeActivityIntent()?.let { payload ->
        synchronized(queueLock) {
          pending.add(payload)
        }
      }
      val out: List<Map<String, Any?>> = synchronized(queueLock) {
        pending.toList()
      }
      promise.resolve(out)
    }

    // JS já transformou os shares em nota → pode limpar a fila e o intent
    AsyncFunction("ack") {
      synchronized(queueLock) {
        pending.clear()
      }
      appContext.currentActivity?.intent?.let { clearExtras(it) }
    }
  }

  private fun consumeActivityIntent(): Map<String, Any?>? {
    return synchronized(queueLock) {
      val activity = appContext.currentActivity ?: return@synchronized null
      val intent = activity.intent ?: return@synchronized null
      val payload = extract(intent) ?: return@synchronized null
      clearExtras(intent)
      payload
    }
  }

  /**
   * Guarda o payload na fila e entrega ao JS — direto se o listener já existe,
   * ou aguardando o próximo getShared().
   */
  private fun emit(payload: Map<String, Any?>) {
    synchronized(queueLock) {
      pending.add(payload)
    }
    val ready = READY ?: return
    try {
      ready(payload)
    } catch (_: Exception) {
      // continua na fila; sai no próximo getShared
    }
  }

  /** Extrai texto, título/assunto e arquivos do intent de compartilhamento (ou null se não for um). */
  private fun extract(intent: Intent?): Map<String, Any?>? {
    if (intent == null) return null
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null

    val context = appContext.reactContext ?: appContext.currentActivity ?: return null
    val type = intent.type ?: ""

    val text = intent.getStringExtra(Intent.EXTRA_TEXT)
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)

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

    val batchPrefix = System.currentTimeMillis()
    val files = uris.mapIndexedNotNull { index, uri ->
      try {
        val name = queryName(context.contentResolver, uri)
          ?: "compartilhado-$batchPrefix-$index"
        val safeName = name.replace(Regex("[^\\w.\\- ]"), "_").ifBlank { "arquivo-$index" }
        val dir = File(context.cacheDir, "shared")
        dir.mkdirs()
        // Prefixo único evita sobrescrever arquivos de shares anteriores com mesmo nome
        val dest = File(dir, "$batchPrefix-$index-$safeName")
        context.contentResolver.openInputStream(uri)?.use { input ->
          FileOutputStream(dest).use { output -> input.copyTo(output) }
        } ?: return@mapIndexedNotNull null
        val mime = context.contentResolver.getType(uri) ?: type.ifEmpty { "application/octet-stream" }
        mapOf(
          "uri" to Uri.fromFile(dest).toString(),
          "name" to safeName,
          "mime" to mime
        )
      } catch (_: Exception) {
        null
      }
    }

    if (text.isNullOrBlank() && files.isEmpty() && subject.isNullOrBlank()) return null
    return mapOf(
      "id" to UUID.randomUUID().toString(),
      "text" to text,
      "subject" to subject,
      "files" to files
    )
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
    } catch (_: Exception) {
      // sem permissão pro displayName — segue pro fallback
    }
    return null
  }

  /** Limpa o intent pra não reprocessar no próximo resume. */
  private fun clearExtras(intent: Intent) {
    try {
      intent.removeExtra(Intent.EXTRA_TEXT)
      intent.removeExtra(Intent.EXTRA_SUBJECT)
      intent.removeExtra(Intent.EXTRA_STREAM)
      intent.clipData = null
      intent.action = Intent.ACTION_MAIN
    } catch (_: Exception) {
      // best effort
    }
  }
}
