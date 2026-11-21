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
 *   no AndroidManifest). Aqui extraímos EXTRA_TEXT, EXTRA_SUBJECT e EXTRA_STREAM/ClipData,
 *   copiamos os arquivos de content:// pro cache do app e devolvemos ao JS.
 * - Cold start: JS chama getShared() no mount.
 * - App já aberto (launchMode singleTask): OnNewIntent emite o evento
 *   "onShareReceived".
 *
 * Fila com ACK (não perder share no cold start):
 * - Antes do JS pedir (getShared), OnNewIntent só ENFILEIRA — nada de
 *   sendEvent: com o app morto o listener JS pode ainda não existir e o
 *   evento sumia (a nota nunca era criada; só a 2ª tentativa funcionava).
 * - Se o listener falhar mesmo depois do cold start, o payload fica na fila
 *   e é reentregue no próximo getShared — nunca é descartado em silêncio.
 * - O intent só é limpo no ack() (JS montou as notas) ou quando um novo
 *   share chega; antes disso uma Activity recriada ainda o encontra.
 */
class ShareReceiverModule : Module() {
  /**
   * Estado do PROCESSO, fora da instância: uma Activity recriada cria outro
   * module, mas a fila entregue-e-não-confirmada precisa sobreviver.
   */
  private companion object {
    val pending = mutableListOf<Map<String, Any?>>()
    /** A fila já foi soberana nesta execução do app? */
    var listMode = false
    /** Entrega direta pro JS (setado onSubscriber; limpado no OnDestroy). */
    var READY: ((Map<String, Any?>) -> Unit)? = null
  }

  override fun definition() = ModuleDefinition {
    Name("ShareReceiver")

    Events("onShareReceived")

    // O JS só chega aqui quando registra o listener do módulo (addListener):
    // a partir daí OnNewIntent entrega direto, com sendEvent.
    OnStartObserving("onShareReceived") {
      READY = { sendEvent("onShareReceived", it) }
    }

    OnDestroy {
      READY = null
      listMode = false
    }

    OnNewIntent { intent ->
      val payload = extract(intent)
      if (payload != null) emit(payload)
    }

    AsyncFunction("getShared") { promise: Promise ->
      // Lista os payloads sem ack (Map pode virar ReadableMap na ponte —
      // o JS normaliza) e, no cold start, também o intent da Activity.
      val out: MutableList<Any?> = mutableListOf()
      out.addAll(pending)
      if (!listMode) {
        listMode = true
        extract(currentActivity()?.intent)?.let { out.add(it) }
      }
      promise.resolve(out)
    }

    // JS já transformou os shares em nota → pode limpar a fila e o intent
    AsyncFunction("ack") {
      pending.clear()
      currentActivity()?.intent?.let { clearExtras(it) }
    }
  }

  private fun currentActivity() =
    (appContext.reactContext as? ReactApplicationContext)?.currentActivity

  /**
   * Guarda o payload, limpa o intent (pra não reprocessar no próximo resume)
   * e entrega ao JS — direto se o listener já existe, ou pela fila.
   */
  private fun emit(payload: Map<String, Any?>) {
    currentActivity()?.intent?.let { clearExtras(it) }
    pending.add(payload)
    val ready = READY ?: return
    try {
      ready(payload)
    } catch (e: Exception) {
      // continua na fila; sai no próximo getShared
    }
  }

  /** Extrai texto, título/assunto e arquivos do intent de compartilhamento (ou null se não for um). */
  private fun extract(intent: Intent?): Map<String, Any?>? {
    if (intent == null) return null
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null

    val context = appContext.reactContext ?: return null
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

    if (text.isNullOrBlank() && files.isEmpty() && subject.isNullOrBlank()) return null
    return mapOf(
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
    } catch (e: Exception) {
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
    } catch (e: Exception) {
      // best effort
    }
  }
}
