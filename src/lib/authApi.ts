import { httpRequest, type HttpOptions } from "./httpApi";
import { isMobile, isTauri } from "./platform";

export interface User {
  id: string;
  email: string;
}

interface SessionResponse {
  token: string;
  user: User;
  recoveryCode?: string;
}

/** Oturum açan işlemlerin sonucu; masaüstü token'ı saklar (web'de oturum HttpOnly çerezdedir). */
export interface Session {
  user: User;
  token: string;
  recoveryCode?: string;
}

export type AuthApi = ReturnType<typeof createAuthApi>;

/** finans-server hesap işlemleri. Web: aynı köken + çerez; masaüstü: `baseUrl` + Bearer token. */
export function createAuthApi(opts: HttpOptions = {}) {
  const device = isMobile ? "mobil" : isTauri ? "masaüstü" : "web";
  const r = <T>(method: string, path: string, body?: unknown) => httpRequest<T>(method, path, body, opts);
  const session = (s: SessionResponse): Session => ({ user: s.user, token: s.token, recoveryCode: s.recoveryCode });
  return {
    register: async (email: string, password: string) => session(await r("POST", "/api/auth/register", { email, password, device })),
    login: async (email: string, password: string) => session(await r("POST", "/api/auth/login", { email, password, device })),
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
      if (!res.ok) throw `Sunucu hatası (${res.status}).`;
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
