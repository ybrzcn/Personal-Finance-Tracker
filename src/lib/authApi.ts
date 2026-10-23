import { httpRequest, type HttpOptions } from "./httpApi";
import { createPasskey, getPasskey, type PasskeyCreateOptions } from "./passkey";
import { isMobile, isTauri } from "./platform";
import { t } from "./i18n";

export interface User {
  id: string;
  email: string;
}

interface SessionResponse {
  token: string;
  user: User;
  recoveryCode?: string;
  totpDisabled?: boolean;
  passkeysRemoved?: number;
}

/** Oturum açan işlemlerin sonucu; masaüstü token'ı saklar (web'de oturum HttpOnly çerezdedir). */
export interface Session {
  user: User;
  token: string;
  recoveryCode?: string;
  /** Kurtarmada iki aşamalı doğrulama kapatıldı */
  totpDisabled?: boolean;
  /** Kurtarmada silinen passkey sayısı */
  passkeysRemoved?: number;
}

/** Şifre doğru, doğrulama uygulaması kodu bekleniyor */
export interface TotpChallenge {
  mfa: "totp";
  ticket: string;
}

export interface PasskeyInfo {
  id: string;
  name: string;
  /** Unix saniye */
  createdAt: number;
  lastUsed: number | null;
}

export interface Security {
  totp: boolean;
  passkeys: PasskeyInfo[];
}

export interface TotpSetup {
  ticket: string;
  secret: string;
  uri: string;
  /** QR kodu (SVG) */
  qr: string;
}

export type AuthApi = ReturnType<typeof createAuthApi>;

/** finans-server hesap işlemleri. Web: aynı köken + çerez; masaüstü: `baseUrl` + Bearer token. */
export function createAuthApi(opts: HttpOptions = {}) {
  const device = isMobile ? "mobil" : isTauri ? "masaüstü" : "web";
  const r = <T>(method: string, path: string, body?: unknown) => httpRequest<T>(method, path, body, opts);
  const session = (s: SessionResponse): Session => ({ user: s.user, token: s.token, recoveryCode: s.recoveryCode, totpDisabled: s.totpDisabled, passkeysRemoved: s.passkeysRemoved });
  return {
    register: async (email: string, password: string) => session(await r("POST", "/api/auth/register", { email, password, device })),
    /** İki aşamalı doğrulama açıksa oturum yerine kod adımı döner */
    async login(email: string, password: string): Promise<Session | TotpChallenge> {
      const res = await r<SessionResponse | TotpChallenge>("POST", "/api/auth/login", { email, password, device, mfa: true });
      return "mfa" in res ? res : session(res);
    },
    loginTotp: async (ticket: string, code: string) => session(await r("POST", "/api/auth/login/totp", { ticket, code })),
    /** Tarayıcıda kayıtlı passkey ile şifresiz giriş */
    async loginPasskey(): Promise<Session> {
      const o = await r<{ ticket: string; challenge: string; rpId: string }>("POST", "/api/auth/passkey/options");
      const a = await getPasskey(o.challenge, o.rpId);
      return session(await r("POST", "/api/auth/passkey/login", { ticket: o.ticket, ...a, device }));
    },
    security: () => r<Security>("GET", "/api/me/security"),
    totpSetup: (password: string) => r<TotpSetup>("POST", "/api/me/totp/setup", { password }),
    totpEnable: (ticket: string, code: string) => r<void>("POST", "/api/me/totp/enable", { ticket, code }),
    totpDisable: (password: string, code: string) => r<void>("POST", "/api/me/totp/disable", { password, code }),
    /** Doğrulama uygulaması açıksa `code` de gerekir */
    async addPasskey(password: string, name: string, code = ""): Promise<PasskeyInfo> {
      const o = await r<PasskeyCreateOptions & { ticket: string }>("POST", "/api/me/passkeys/options", { password, code });
      const c = await createPasskey(o);
      return r<PasskeyInfo>("POST", "/api/me/passkeys", { ticket: o.ticket, name, ...c });
    },
    deletePasskey: (id: string, password: string) => r<void>("DELETE", `/api/me/passkeys/${encodeURIComponent(id)}`, { password }),
    recover: async (email: string, recoveryCode: string, newPassword: string) =>
      session(await r("POST", "/api/auth/recover", { email, recoveryCode, newPassword, device })),
    logout: () => r<void>("POST", "/api/auth/logout"),
    /** Oturum yoksa (401) null. Ağ hatasında "Sunucuya ulaşılamıyor…" fırlatır. */
    async me(): Promise<User | null> {
      const token = opts.getToken?.();
      const res = await fetch(`${opts.baseUrl ?? ""}/api/me`, {
        credentials: "same-origin",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }).catch(() => {
        throw "Sunucuya ulaşılamıyor. Bağlantınızı kontrol edin.";
      });
      if (res.status === 401) return null;
      if (!res.ok) throw t("Sunucu hatası ({status}).", { status: res.status });
      return (await res.json()) as User;
    },
    changePassword: (currentPassword: string, newPassword: string) =>
      r<void>("POST", "/api/auth/change-password", { currentPassword, newPassword }),
    deleteAccount: (password: string) => r<void>("DELETE", "/api/me", { password }),
    /** Adreste Finans sunucusu var mı (ilk açılışta adres doğrulaması). */
    async health(): Promise<boolean> {
      try {
        const res = await fetch(`${opts.baseUrl ?? ""}/api/health`);
        return res.ok && (await res.json())?.ok === true;
      } catch {
        return false;
      }
    },
  };
}

/** Web (aynı köken). */
export const authApi = createAuthApi();
