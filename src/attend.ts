/** One row of `GET /api/v1/events/:event/participants/roster` (withdrawn/rejected are excluded by Attend). */
export interface RosterEntry {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  slack_user_id: string | null;
  /** invited | in_progress | awaiting_guardian | complete */
  status: string | null;
}

export interface AttendEvent {
  id: string;
  name: string;
  slug: string;
}

export interface TokenState {
  token: string;
  /** ISO 8601, known once the token has been rotated at least once. */
  expiresAt: string | null;
  /** SHA-256 of the ATTEND_TOKEN secret this chain of tokens started from. */
  seedHash: string;
}

export interface TokenStore {
  loadToken(): Promise<TokenState | null>;
  saveToken(state: TokenState): Promise<void>;
}

export class AttendError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/** Attend sends X-Token-Refresh-Recommended in a token's last 3 days; rotate by then at the latest. */
const REFRESH_WITHIN_MS = 3 * 24 * 60 * 60 * 1000;
const USER_AGENT = "attend-slack-notifications (+https://github.com/ingoau/attend-slack-notifications)";

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Minimal Attend API client authenticated with a mobile token.
 *
 * Mobile tokens live 14 days and are rotated with `POST /api/v1/session/refresh`, which revokes
 * the old token immediately. The current token therefore lives in [store] (saved before anything
 * else happens), and ATTEND_TOKEN is only the seed: it is adopted on first run, and again whenever
 * the secret is changed, so pasting a fresh token is how you recover a lost session.
 */
export class AttendClient {
  private state: TokenState | null = null;
  /** Set when a response asked for a rotation. */
  private refreshRecommended = false;

  constructor(
    private readonly baseUrl: string,
    private readonly seedToken: string,
    private readonly store: TokenStore,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  /** Loads the current token, switching to ATTEND_TOKEN if that secret has changed. */
  async init(): Promise<{ adoptedSeed: boolean }> {
    const seedHash = await sha256Hex(this.seedToken);
    const stored = await this.store.loadToken();
    if (stored && stored.seedHash === seedHash) {
      this.state = stored;
      return { adoptedSeed: false };
    }
    this.state = { token: this.seedToken, expiresAt: null, seedHash };
    await this.store.saveToken(this.state);
    return { adoptedSeed: true };
  }

  get expiresAt(): string | null {
    return this.state?.expiresAt ?? null;
  }

  private get current(): TokenState {
    if (!this.state) throw new Error("AttendClient.init() must be called first");
    return this.state;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.current.token}`,
        "User-Agent": USER_AGENT,
      },
    });
    const text = await res.text();
    if (!res.ok) throw new AttendError(res.status, errorMessage(res.status, text));
    if (res.headers.get("X-Token-Refresh-Recommended") === "true") this.refreshRecommended = true;
    return JSON.parse(text) as T;
  }

  async roster(event: string): Promise<RosterEntry[]> {
    const body = await this.get<{ participants: RosterEntry[] }>(
      `/events/${encodeURIComponent(event)}/participants/roster`,
    );
    return body.participants ?? [];
  }

  async events(): Promise<AttendEvent[]> {
    const body = await this.get<{ events: AttendEvent[] }>("/events");
    return body.events ?? [];
  }

  /** True when the token should be rotated now. */
  get needsRefresh(): boolean {
    if (this.refreshRecommended) return true;
    const expiresAt = this.state?.expiresAt;
    return expiresAt != null && Date.parse(expiresAt) - Date.now() < REFRESH_WITHIN_MS;
  }

  /**
   * Rotates the token and persists the new one before returning. Throws AttendError if Attend
   * refuses (the token is already dead); a network error leaves the old token in place.
   */
  async refresh(): Promise<void> {
    const old = this.current;
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/session/refresh`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${old.token}`,
        "User-Agent": USER_AGENT,
      },
      body: "{}",
    });
    const text = await res.text();
    if (!res.ok) throw new AttendError(res.status, `Token refresh failed: ${errorMessage(res.status, text)}`);
    const body = JSON.parse(text) as { token?: string; expires_at?: string };
    if (!body.token) throw new AttendError(res.status, "Token refresh returned no token");
    // The old token is already revoked server-side: save the new one before doing anything else.
    this.state = { token: body.token, expiresAt: body.expires_at ?? null, seedHash: old.seedHash };
    await this.store.saveToken(this.state);
    this.refreshRecommended = false;
  }
}

function errorMessage(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    const msg = parsed.error ?? parsed.message;
    if (msg) return `${msg} (HTTP ${status})`;
  } catch {
    // not JSON
  }
  const trimmed = text.trim();
  return trimmed && trimmed.length < 200 && !trimmed.startsWith("<") ? `${trimmed} (HTTP ${status})` : `HTTP ${status}`;
}
