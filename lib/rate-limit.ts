/**
 * Rate limiter simples em memória (janela deslizante).
 *
 * Suficiente para um app de usuário único: limita brute-force no login.
 * O estado vive no processo — reiniciar o servidor zera os contadores.
 */
interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  /** Segundos até a próxima tentativa ser liberada (para Retry-After). */
  retryAfterSeconds: number;
}

/**
 * @param key       Identificador do cliente (ex: IP)
 * @param limit     Máximo de tentativas dentro da janela
 * @param windowMs  Tamanho da janela em milissegundos
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key) || { timestamps: [] };

  // Descarta tentativas fora da janela
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

  if (bucket.timestamps.length >= limit) {
    const oldest = bucket.timestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    buckets.set(key, bucket);
    return { allowed: false, retryAfterSeconds };
  }

  bucket.timestamps.push(now);
  buckets.set(key, bucket);

  // Limpeza oportunista: evita crescimento descontrolado do Map
  if (buckets.size > 1000) {
    for (const [k, b] of buckets) {
      if (b.timestamps.every((t) => now - t >= windowMs)) {
        buckets.delete(k);
      }
    }
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/** Extrai o IP do cliente a partir dos headers de proxy comuns (fazendo fallback para o peer). */
export function getClientIp(request: Request): string {
  const headers = request.headers;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return headers.get("x-real-ip") || "unknown";
}
