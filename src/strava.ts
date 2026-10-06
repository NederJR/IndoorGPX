// Integração com o Strava: OAuth (via popup) e envio de atividades.
//
// O app não tem servidor, então cada usuário cria seu próprio "API Application" no Strava
// (https://www.strava.com/settings/api) e informa Client ID e Client Secret nas configurações.
// Credenciais e tokens ficam apenas no localStorage deste navegador.

const AUTH_URL = 'https://www.strava.com/oauth/authorize';
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const DEAUTH_URL = 'https://www.strava.com/oauth/deauthorize';
const API = 'https://www.strava.com/api/v3';
const STORAGE_KEY = 'indoorgpx.strava';
const SCOPE = 'activity:write';

export const OAUTH_CHANNEL = 'indoorgpx-strava-oauth';
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const POPUP_POLL_MS = 500;
/** Após o popup fechar, aguarda um pouco: a mensagem do callback pode chegar logo depois. */
const POPUP_CLOSE_GRACE_MS = 1500;
const UPLOAD_POLL_MS = 2000;
const UPLOAD_TIMEOUT_MS = 120 * 1000;

export interface StravaConfig {
  clientId: string;
  clientSecret: string;
}

interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch em segundos. */
  expiresAt: number;
  athleteName: string;
}

interface Stored {
  config?: StravaConfig;
  tokens?: StravaTokens;
}

export interface OAuthResult {
  code?: string;
  scope?: string;
  state?: string;
  error?: string;
}

export interface UploadResult {
  activityId: number;
  url: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StravaError extends Error {}

export class Strava {
  private data: Stored = {};
  private pendingAuth?: { state: string; resolve: (r: OAuthResult) => void; reject: (e: Error) => void };

  constructor() {
    try {
      this.data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    } catch {
      this.data = {};
    }
    // O popup de autorização devolve o resultado por este canal.
    if ('BroadcastChannel' in window) {
      new BroadcastChannel(OAUTH_CHANNEL).onmessage = (e: MessageEvent<OAuthResult>) => {
        if (this.pendingAuth && e.data?.state === this.pendingAuth.state) this.pendingAuth.resolve(e.data);
      };
    }
  }

  get config(): StravaConfig {
    return this.data.config ?? { clientId: '', clientSecret: '' };
  }

  get configured(): boolean {
    return !!(this.data.config?.clientId && this.data.config?.clientSecret);
  }

  get connecting(): boolean {
    return !!this.pendingAuth;
  }

  get connected(): boolean {
    return !!this.data.tokens;
  }

  get athleteName(): string {
    return this.data.tokens?.athleteName ?? '';
  }

  setConfig(config: StravaConfig) {
    const changed = config.clientId !== this.data.config?.clientId;
    this.data.config = { clientId: config.clientId.trim(), clientSecret: config.clientSecret.trim() };
    // Tokens pertencem ao app anterior.
    if (changed) delete this.data.tokens;
    this.save();
  }

  /** Abre o popup de autorização do Strava e troca o código por tokens. */
  async connect(): Promise<void> {
    if (!this.configured) throw new StravaError('Informe o Client ID e o Client Secret do seu app Strava.');
    if (!/^\d+$/.test(this.config.clientId)) throw new StravaError('O Client ID deve conter apenas números.');
    // Uma nova tentativa substitui a anterior.
    this.cancelConnect();
    const state = crypto.randomUUID();
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: new URL('strava-callback.html', location.href).href,
      approval_prompt: 'auto',
      scope: SCOPE,
      state,
    });
    const popup = window.open(`${AUTH_URL}?${params}`, 'strava-auth', 'width=600,height=760');
    if (!popup) throw new StravaError('O navegador bloqueou o popup. Permita popups para este site.');

    const result = await new Promise<OAuthResult>((resolve, reject) => {
      let closedAt = 0;
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(poll);
        if (this.pendingAuth?.state === state) this.pendingAuth = undefined;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new StravaError('Tempo esgotado aguardando a autorização.'));
      }, AUTH_TIMEOUT_MS);
      // Com Client ID errado o Strava mostra um erro no popup e nunca volta; detectamos o fechamento.
      const poll = setInterval(() => {
        if (!popup.closed) return;
        closedAt ||= Date.now();
        if (Date.now() - closedAt < POPUP_CLOSE_GRACE_MS) return;
        cleanup();
        reject(new StravaError('A janela do Strava foi fechada antes de concluir. Confira o Client ID e tente de novo.'));
      }, POPUP_POLL_MS);
      this.pendingAuth = {
        state,
        resolve: (r) => {
          cleanup();
          resolve(r);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      };
    });

    if (result.error || !result.code) {
      throw new StravaError(result.error === 'access_denied' ? 'Autorização negada no Strava.' : `Erro do Strava: ${result.error}`);
    }
    if (!result.scope?.split(',').includes(SCOPE)) {
      throw new StravaError('A permissão para enviar atividades não foi concedida. Marque a opção na tela do Strava.');
    }
    await this.requestToken({ grant_type: 'authorization_code', code: result.code });
  }

  /** Cancela uma autorização em andamento. */
  cancelConnect() {
    this.pendingAuth?.reject(new StravaError('Conexão cancelada.'));
  }

  async disconnect() {
    const token = this.data.tokens?.accessToken;
    delete this.data.tokens;
    this.save();
    if (token) {
      await fetch(DEAUTH_URL, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    }
  }

  /** Envia um arquivo TCX e aguarda o Strava processá-lo. */
  async uploadTcx(
    tcx: string,
    meta: { name: string; description: string; externalId: string },
    onProgress?: (message: string) => void,
  ): Promise<UploadResult> {
    const form = new FormData();
    form.append('file', new Blob([tcx], { type: 'application/xml' }), `${meta.externalId}.tcx`);
    form.append('data_type', 'tcx');
    form.append('name', meta.name);
    form.append('description', meta.description);
    form.append('trainer', '1');
    form.append('external_id', meta.externalId);

    onProgress?.('Enviando arquivo…');
    let upload = await this.api<UploadStatus>('/uploads', { method: 'POST', body: form });

    onProgress?.('Processando no Strava…');
    const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
    while (!upload.activity_id && !upload.error) {
      if (Date.now() > deadline) throw new StravaError('O Strava demorou demais para processar. Confira no site.');
      await sleep(UPLOAD_POLL_MS);
      upload = await this.api<UploadStatus>(`/uploads/${upload.id_str}`);
    }
    if (upload.error) {
      const duplicate = upload.error.match(/duplicate of .*?(\d+)/i);
      if (duplicate) throw new StravaError(`Esta atividade já existe no Strava (id ${duplicate[1]}).`);
      throw new StravaError(`Strava recusou o arquivo: ${upload.error}`);
    }

    const activityId = upload.activity_id!;
    // Marca como pedal virtual; se falhar, a atividade continua válida.
    await this.api(`/activities/${activityId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sport_type: 'VirtualRide', trainer: true }),
    }).catch((err) => console.warn('Strava: não foi possível definir VirtualRide', err));

    return { activityId, url: `https://www.strava.com/activities/${activityId}` };
  }

  private async api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.validAccessToken();
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      delete this.data.tokens;
      this.save();
      throw new StravaError('Sessão do Strava expirada ou revogada. Conecte novamente nas configurações.');
    }
    if (res.status === 429) throw new StravaError('Limite de requisições do Strava atingido. Tente em alguns minutos.');
    const body = await res.json().catch(() => ({}));
    // Uploads com erro de processamento vêm com status 200 e campo "error"; demais erros, status HTTP.
    if (!res.ok && !(body as UploadStatus).error) {
      throw new StravaError(`Erro ${res.status} do Strava: ${(body as { message?: string }).message ?? res.statusText}`);
    }
    return body as T;
  }

  private async validAccessToken(): Promise<string> {
    const tokens = this.data.tokens;
    if (!tokens) throw new StravaError('Conecte sua conta Strava nas configurações (⚙).');
    if (tokens.expiresAt - 60 > Date.now() / 1000) return tokens.accessToken;
    await this.requestToken({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    return this.data.tokens!.accessToken;
  }

  private async requestToken(grant: Record<string, string>) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...grant }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (grant.grant_type === 'refresh_token') {
        delete this.data.tokens;
        this.save();
      }
      throw new StravaError(
        res.status === 400 || res.status === 401
          ? 'Client ID/Secret inválidos ou autorização expirada.'
          : `Erro ${res.status} ao autenticar no Strava.`,
      );
    }
    const athlete = body.athlete ?? {};
    this.data.tokens = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_at,
      athleteName: athlete.firstname
        ? `${athlete.firstname} ${athlete.lastname ?? ''}`.trim()
        : (this.data.tokens?.athleteName ?? 'Atleta'),
    };
    this.save();
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // armazenamento indisponível
    }
  }
}

interface UploadStatus {
  id: number;
  id_str: string;
  status: string;
  error: string | null;
  activity_id: number | null;
}
