/** Texto de uma pagina; page=null quando a fonte nao tem paginacao (TXT, MD, URL). */
export type Page = { page: number | null; text: string };
export type Extracted = { pages: Page[]; pageCount: number | null; title?: string };

export type Chunk = {
  ordinal: number;
  page: number | null;
  section: string | null;
  content: string;
  tokenCount: number;
};

/** Categoria do erro: e o que o usuario ve em documents.error; o detalhe tecnico vai so para o log. */
export type ErrorCode =
  | 'unsupported_type'
  | 'corrupt_file'
  | 'unsafe_file'
  | 'no_text'
  | 'url_blocked'
  | 'fetch_failed'
  | 'too_large'
  | 'timeout'
  | 'provider_error'
  | 'internal';

export const USER_MESSAGES: Record<ErrorCode, string> = {
  unsupported_type: 'Tipo de arquivo não suportado.',
  corrupt_file: 'Arquivo corrompido ou inválido.',
  unsafe_file: 'Arquivo rejeitado por motivos de segurança.',
  no_text: 'Não foi possível extrair texto do documento (pode ser um PDF escaneado).',
  url_blocked: 'Esta URL não é permitida.',
  fetch_failed: 'Não foi possível baixar a página.',
  too_large: 'Documento grande demais para processar.',
  timeout: 'O processamento demorou demais e foi cancelado.',
  provider_error: 'O provedor de embeddings está indisponível ou recusou a requisição. Tente reprocessar mais tarde.',
  internal: 'Erro interno ao processar o documento. Tente novamente mais tarde.',
};

/** Erro com categoria; `message` e o detalhe tecnico (nunca mostrar ao usuario). Repete com backoff, exceto PermanentError. */
export class IngestError extends Error {
  constructor(
    readonly code: ErrorCode,
    detail: string,
  ) {
    super(detail);
  }
}

/** Erro sem sentido tentar de novo (tipo nao suportado, documento sem texto, limite excedido). */
export class PermanentError extends IngestError {
  constructor(detail: string, code: ErrorCode = 'internal') {
    super(code, detail);
  }
}

export const errorCode = (e: unknown): ErrorCode => (e instanceof IngestError ? e.code : 'internal');
/** Texto seguro para o usuario (documents.error). */
export const userMessage = (e: unknown): string => USER_MESSAGES[errorCode(e)];

/** Tetos contra expansao (PDF gigante, zip bomb, texto enorme). Defaults sensatos; o worker os recebe de packages/config. */
export type IngestLimits = {
  maxPages: number;
  maxChunks: number;
  /** Bytes descomprimidos somados de um DOCX. */
  maxDocxBytes: number;
  /** Razao descomprimido/comprimido aceita num DOCX (so vale acima de 1 MB descomprimido). */
  maxDocxRatio: number;
};

export const DEFAULT_LIMITS: IngestLimits = {
  maxPages: 500,
  maxChunks: 5000,
  maxDocxBytes: 100 * 1024 * 1024,
  maxDocxRatio: 100,
};
