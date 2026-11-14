/**
 * Tipos do protocolo de sync (docs/SYNC.md) — arquivo PURO, sem imports
 * de runtime. Serve pros três lados sem arrastar código de servidor
 * (fs, aws-sdk) pro bundle do celular:
 *
 *   - lib/sync.ts (motor server) re-exporta tudo daqui;
 *   - lib/sync-core.ts (cliente das réplicas) importa os tipos daqui;
 *   - mobile (Expo) consome via lib/sync-core.
 */

export interface PushedNote {
  id: string;
  title: string;
  body: string;
  color: string;
  is_pinned: number | boolean;
  is_archived: number | boolean;
  /** 1 = nota do cofre (title/body/versionaes chegam como ciphertext) */
  is_vault?: number | boolean;
  created_at: number;
  updated_at: number;
}

export interface PushedAttachment {
  id: string;
  note_id: string;
  storage_key: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  duration_seconds: number | null;
  created_at: number;
}

export interface PushedTombstone {
  id: string;
  deleted_at: number;
}

export interface PushedVersion {
  id: string;
  note_id: string;
  title: string;
  body: string;
  created_at: number;
}

/** Linha única do material do cofre (envelope da DEK) — sincroniza como entidade. */
export interface PushedVaultMeta {
  id: string;
  salt: string;
  iterations: number;
  kdf: string;
  wrapped_dek: string;
  updated_at: number;
}

export interface SyncPush {
  notes?: PushedNote[];
  attachments?: PushedAttachment[];
  /** ids de anexos apagados na réplica que enviou */
  attachments_removed?: string[];
  tombstones?: PushedTombstone[];
  /** versões do histórico com created_at >= versions_watermark */
  versions?: PushedVersion[];
  /** material do cofre (linha única) — push por LWW de updated_at */
  vault_meta?: PushedVaultMeta[];
  /** maior created_at de versão que a réplica que envia já viu (0 = bootstrap) */
  versions_watermark?: number;
}

export interface SyncResult {
  cursor: number;
  conflicts: string[];
}
