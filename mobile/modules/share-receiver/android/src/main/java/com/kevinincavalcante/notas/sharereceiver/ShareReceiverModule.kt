package com.kevinincavalcante.notas.sharereceiver

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
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
   *
   * `captureIntent` é estático para que `MainActivity.onCreate` / `onNewIntent`
   * capturem o compartilhamento imediatamente, mesmo antes de o ReactContext
   * ou `loadAppReady` terminarem de subir.
   */
  companion object {
    private const val TAG = "ShareReceiver"
    private val queueLock = Any()
    private val pending = mutableListOf<Map<String, Any?>>()

    /** Entrega direta pro JS (setado em OnStartObserving; limpo em OnStopObserving/OnDestroy). */
    @Volatile
    private var READY: ((Map<String, Any?>) -> Unit)? = null

    /**
     * Extrai, limpa o intent e enfileira em `pending` de forma atômica
     * (evita corrida entre OnActivityEntersForeground e getShared).
     */
    @JvmStatic
    @JvmOverloads
    fun captureIntent(context: Context, intent: Intent?, emitEvent: Boolean = true): Boolean {
      val payload = synchronized(queueLock) {
        val extracted = extract(context, intent) ?: return@synchronized null
        if (intent != null) clearExtras(intent)
        pending.add(extracted)
        Log.i(TAG, "captureIntent: queued id=${extracted["id"]} pending=${pending.size}")
        extracted
      } ?: return false

      if (emitEvent) {
        val ready = READY
        if (ready != null) {
          try {
            ready(payload)
          } catch (e: Exception) {
            Log.w(TAG, "emit failed, stays in pending: ${e.message}")
          }
        } else {
          Log.i(TAG, "captureIntent: READY=null, awaiting getShared/OnStartObserving")
        }
      }
      return true
    }

    /** Extrai texto, título/assunto e arquivos do intent de compartilhamento (ou null se não for um). */
    private fun extract(context: Context, intent: Intent?): Map<String, Any?>? {
      if (intent == null) return null
      val action = intent.action
      if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null

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

  override fun definition() = ModuleDefinition {
    Name("ShareReceiver")

    Events("onShareReceived")

    // O JS só chega aqui quando registra o listener do módulo (addListener):
    // a partir daí OnNewIntent/OnActivityEntersForeground entregam direto.
    OnStartObserving("onShareReceived") {
      READY = { sendEvent("onShareReceived", it) }
      // Drena qualquer item que chegou entre getShared() e startObserving()
      val snapshot = synchronized(queueLock) { pending.toList() }
      Log.i(TAG, "OnStartObserving: READY set, pending=${snapshot.size}")
      for (item in snapshot) {
        try {
          sendEvent("onShareReceived", item)
        } catch (_: Exception) {
          // segue em pending; sai no próximo getShared()
        }
      }
    }

    OnStopObserving("onShareReceived") {
      READY = null
      Log.i(TAG, "OnStopObserving: READY cleared")
    }

    OnActivityDestroys {
      READY = null
    }

    OnDestroy {
      READY = null
    }

    OnNewIntent { intent ->
      val context = appContext.reactContext ?: appContext.currentActivity
      if (context != null) {
        captureIntent(context, intent)
      }
    }

    OnActivityEntersForeground {
      val activity = appContext.currentActivity
      if (activity != null) {
        captureIntent(activity, activity.intent)
      }
    }

    AsyncFunction("getShared") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity != null) {
        captureIntent(activity, activity.intent, emitEvent = false)
      }
      val out: List<Map<String, Any?>> = synchronized(queueLock) {
        pending.toList()
      }
      Log.i(TAG, "getShared -> ${out.size} item(s)")
      promise.resolve(out)
    }

    // JS já transformou os shares em nota → remove apenas os ids confirmados (ou tudo se vazio)
    AsyncFunction("ack") { ids: List<String>? ->
      synchronized(queueLock) {
        if (ids.isNullOrEmpty()) {
          pending.clear()
        } else {
          val idSet = ids.toSet()
          pending.removeAll { it["id"] in idSet }
        }
        Log.i(TAG, "ack(${ids?.size ?: -1}) -> remaining=${pending.size}")
      }
      appContext.currentActivity?.intent?.let { clearExtras(it) }
    }
  }
}
