import { AlertTriangle, Loader2 } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AuthScreen } from "../components/AuthScreen";
import { Landing } from "../components/Landing";
import { ModeChoice, ServerStep } from "../components/Onboarding";
import { setApi, tauriApi, type Api } from "../lib/api";
import { authApi, createAuthApi, type AuthApi, type Session, type User } from "../lib/authApi";
import { DEFAULT_SERVER_URL, loadClientConfig, saveClientConfig, type ClientConfig, type Mode } from "../lib/client";
import { createHttpApi, UNAUTHORIZED_EVENT } from "../lib/httpApi";
import { clearErrors } from "../lib/errorLog";
import { backend } from "../lib/platform";

/** Çıkışta bu cihazda kalan kişisel izler temizlenir (ortak bilgisayarda bir sonraki kullanıcı görmesin). */
function clearLocalTraces() {
  clearErrors();
  try {
    localStorage.removeItem("finans-last-account");
  } catch {
    /* yoksay */
  }
}
import { moveLocalToServer } from "../lib/transfer";

interface AuthCtx {
  /** Oturumdaki kullanıcı; hesapsız yerel kullanımda null */
  user: User | null;
  /** "web": tarayıcı; "local"/"server": masaüstü veri yeri; null: sağlayıcı dışında (varsayılan bağlam) */
  mode: "web" | Mode | null;
  serverUrl: string | null;
  /** Hesap işlemleri (şifre değiştir, hesabı sil) için istemci; hesap yoksa null */
  auth: AuthApi | null;
  /** Seçili sunucunun veri istemcisi (masaüstü: taşıma/indirme için); hesap yoksa null */
  server: Api | null;
  logout(): Promise<void>;
  /** Masaüstü: veri yerini değiştirir ve uygulamayı yeniden yükler */
  switchMode(mode: Mode): Promise<void>;
  /** Masaüstü hesapsız kullanımda: ilk açılış akışını (sunucu + hesap) başlatır */
  connectAccount(): Promise<void>;
}

const noop = async () => {};
const AuthContext = createContext<AuthCtx>({
  user: null,
  mode: null,
  serverUrl: null,
  auth: null,
  server: null,
  logout: noop,
  switchMode: noop,
  connectAccount: noop,
});

export function useAuth() {
  return useContext(AuthContext);
}

/**
 * Uygulama ancak oturum (ya da masaüstünde hesapsız yerel kullanım seçimi) hazır olunca görünür;
 * veri sağlayıcıları ancak o zaman bağlanır.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  if (backend === "http") return <WebGate>{children}</WebGate>;
  return <DesktopGate>{children}</DesktopGate>;
}

function Spinner() {
  return (
    <div className="grid h-full place-items-center text-zinc-400" role="status" aria-label="Yükleniyor">
      <Loader2 className="animate-spin" />
    </div>
  );
}

function ErrorCard({ title, message, actions }: { title: string; message: string; actions: ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-4">
      <div className="card max-w-sm p-6 text-center">
        <AlertTriangle className="mx-auto mb-3 text-rose-500" />
        <p className="font-medium">{title}</p>
        <p className="mt-1 break-words text-sm text-zinc-500">{message}</p>
        <div className="mt-4 flex justify-center gap-2">{actions}</div>
      </div>
    </div>
  );
}

/**
 * Oturum düşünce uygulama kapatılmadan üstte giriş ekranı açılır: açık form ve sayfa korunur.
 * Aynı hesapla girilirse kalınan yerden devam edilir; başka hesapla girilirse uygulama yeniden yüklenir.
 */
function ReauthOverlay({
  auth,
  currentUserId,
  onDone,
  onSwitchAccount,
}: {
  auth?: AuthApi;
  currentUserId: string | null;
  onDone(session: Session): Promise<void> | void;
  /** Başka hesapla girildiğinde: yalnız kalıcı kayıt (bellekteki istemci güncellenmez), ardından yeniden yükleme */
  onSwitchAccount(session: Session): Promise<void> | void;
}) {
  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-zinc-50 dark:bg-zinc-950" role="dialog" aria-modal="true" aria-label="Tekrar giriş">
      <AuthScreen
        auth={auth}
        notice="Oturumunuz sona erdi. Tekrar giriş yapınca kaldığınız yerden devam edersiniz."
        onDone={async (session) => {
          if (currentUserId && session.user.id !== currentUserId) {
            // Başka hesap: önceki hesabın bellekteki verisi yeni hesaba hiç yazılmasın; önce kalıcı kaydet, hemen yeniden yükle
            await onSwitchAccount(session);
            location.reload();
            return;
          }
          await onDone(session);
        }}
      />
    </div>
  );
}

/** Oturum düşünce (başka cihazda çıkış, hesap silindi, süre doldu) çağrılır. */
function useUnauthorized(handler: () => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const on = () => ref.current();
    window.addEventListener(UNAUTHORIZED_EVENT, on);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, on);
  }, []);
}

// ---------------------------------------------------------------------------
// Web: oturum HttpOnly çerezde
// ---------------------------------------------------------------------------

function WebGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const [screen, setScreen] = useState<"landing" | "login" | "register">("landing");

  const check = useCallback(() => {
    setChecking(true);
    setError(null);
    authApi
      .me()
      .then(setUser)
      .catch((e) => setError(String(e)))
      .finally(() => setChecking(false));
  }, []);

  useEffect(check, [check]);

  // Uygulama açıkken oturum düşerse (yalnız oturum açıkken anlamlı)
  useUnauthorized(() => setReauth(true));

  const ctx = useMemo<AuthCtx>(
    () => ({
      user,
      mode: "web",
      serverUrl: null,
      auth: authApi,
      server: null,
      async logout() {
        await authApi.logout().catch(() => {});
        clearLocalTraces();
        // Bellekteki tüm veri temizlensin
        location.reload();
      },
      switchMode: noop,
      connectAccount: noop,
    }),
    [user],
  );

  if (checking) return <Spinner />;
  if (error) {
    return (
      <ErrorCard
        title={error.startsWith("Sunucuya ulaşılamıyor") ? "Sunucuya bağlanılamadı" : "Sunucu hatası"}
        message={error}
        actions={
          <button className="btn-primary" onClick={check}>
            Tekrar dene
          </button>
        }
      />
    );
  }
  if (!user) {
    // Oturum yokken önce tanıtım sayfası; giriş/kayıt oradan
    if (screen === "landing") return <Landing onLogin={() => setScreen("login")} onRegister={() => setScreen("register")} />;
    return (
      <AuthScreen key={screen} notice={null} initialView={screen} onBack={() => setScreen("landing")} onDone={(session) => setUser(session.user)} />
    );
  }
  return (
    <AuthContext.Provider value={ctx}>
      {children}
      {reauth && <ReauthOverlay currentUserId={user.id} onDone={() => setReauth(false)} onSwitchAccount={() => clearLocalTraces()} />}
    </AuthContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Masaüstü: sunucu adresi + token config.json'da; veri yeri yerel ya da sunucu
// ---------------------------------------------------------------------------

type Step =
  | { kind: "loading" }
  | { kind: "server" }
  | { kind: "auth"; notice: string | null }
  | { kind: "mode" }
  | { kind: "unreachable"; message: string }
  | { kind: "ready"; user: User | null };

function DesktopGate({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ClientConfig>({});
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [loadError, setLoadError] = useState<string | null>(null);
  // Token her istekte güncel config'ten okunur
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = config.token ?? null;

  const opts = useMemo(
    () => (config.serverUrl ? { baseUrl: config.serverUrl, getToken: () => tokenRef.current } : null),
    [config.serverUrl],
  );
  const auth = useMemo(() => (opts ? createAuthApi(opts) : null), [opts]);
  const server = useMemo(() => (opts ? createHttpApi(opts) : null), [opts]);

  const save = useCallback(async (next: ClientConfig) => {
    await saveClientConfig(next);
    setConfig(next);
  }, []);

  /** Yapılandırmaya göre hangi adımın gösterileceğine karar verir. */
  const resolve = useCallback(
    async (c: ClientConfig) => {
      if (!c.token) {
        if (c.mode === "local") {
          setApi(tauriApi);
          setStep({ kind: "ready", user: null });
        } else {
          setStep(c.serverUrl ? { kind: "auth", notice: null } : { kind: "server" });
        }
        return;
      }
      if (!c.mode) {
        setStep({ kind: "mode" });
        return;
      }
      const user: User | null = c.userId && c.userEmail ? { id: c.userId, email: c.userEmail } : null;
      if (c.mode === "local") {
        // Yerel modda açılışta sunucuya bağlanılmaz (internet gerekmez)
        setApi(tauriApi);
        setStep({ kind: "ready", user });
        return;
      }
      const o = { baseUrl: c.serverUrl ?? "", getToken: () => c.token ?? null };
      try {
        const me = await createAuthApi(o).me();
        if (!me) {
          const cleared = { ...c, token: null };
          await saveClientConfig(cleared);
          setConfig(cleared);
          setStep({ kind: "auth", notice: "Oturumunuz sona erdi, tekrar giriş yapın." });
          return;
        }
        setApi(createHttpApi({ baseUrl: c.serverUrl ?? "", getToken: () => tokenRef.current }));
        setStep({ kind: "ready", user: me });
      } catch (e) {
        setStep({ kind: "unreachable", message: String(e) });
      }
    },
    [],
  );

  useEffect(() => {
    loadClientConfig()
      .then((c) => {
        setConfig(c);
        return resolve(c);
      })
      .catch((e) => setLoadError(String(e)));
  }, [resolve]);

  // Sunucu modunda oturum düşerse aynı sunucuya tekrar giriş
  // Oturum düşünce (sunucu modunda veri istekleri; yerel modda taşıma/hesap işlemleri) uygulama kapanmadan
  // üstte giriş ekranı açılır; token yapılandırmadan silinir
  const [reauth, setReauth] = useState(false);
  useUnauthorized(() => {
    if (!config.token) return;
    const cleared = { ...config, token: null };
    void saveClientConfig(cleared).then(() => setConfig(cleared));
    setReauth(true);
  });

  const logout = useCallback(async () => {
    if (auth && config.token) await auth.logout().catch(() => {});
    clearLocalTraces();
    // Yerel veri kalır; sonraki açılışta giriş ekranı
    await saveClientConfig({ serverUrl: config.serverUrl ?? null });
    location.reload();
  }, [auth, config]);

  const ctx = useMemo<AuthCtx>(
    () => ({
      user: step.kind === "ready" ? step.user : null,
      mode: (config.mode as Mode | undefined) ?? null,
      serverUrl: config.serverUrl ?? null,
      auth: config.token ? auth : null,
      server: config.token ? server : null,
      logout,
      async switchMode(mode) {
        await saveClientConfig({ ...config, mode });
        location.reload();
      },
      async connectAccount() {
        await saveClientConfig({ serverUrl: config.serverUrl ?? null, mode: null });
        location.reload();
      },
    }),
    [step, config, auth, server, logout],
  );

  if (loadError) {
    return <ErrorCard title="Ayarlar okunamadı" message={loadError} actions={<button className="btn-primary" onClick={() => location.reload()}>Tekrar dene</button>} />;
  }

  switch (step.kind) {
    case "loading":
      return <Spinner />;
    case "server":
      return (
        <ServerStep
          initial={config.serverUrl || DEFAULT_SERVER_URL}
          onDone={(url) => {
            // Sunucu değişince eski hesap ve veri yeri seçimi geçersiz
            const next = url === config.serverUrl ? config : { serverUrl: url };
            void save({ ...next, serverUrl: url }).then(() => setStep({ kind: "auth", notice: null }));
          }}
          onSkip={() => {
            const next = { ...config, mode: "local" as const, token: null };
            void save(next).then(() => resolve(next));
          }}
        />
      );
    case "auth":
      if (!auth) return <Spinner />;
      return (
        <AuthScreen
          auth={auth}
          notice={step.notice}
          header={
            <p className="mb-3 truncate text-xs text-zinc-500">
              Sunucu: {config.serverUrl} ·{" "}
              <button className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setStep({ kind: "server" })}>
                Değiştir
              </button>{" "}
              ·{" "}
              <button
                className="text-indigo-600 hover:underline dark:text-indigo-400"
                onClick={() => {
                  const next = { serverUrl: config.serverUrl ?? null, mode: "local" as const };
                  void save(next).then(() => resolve(next));
                }}
              >
                Hesapsız devam et
              </button>
            </p>
          }
          onDone={(session: Session) => {
            const next = { ...config, token: session.token, userId: session.user.id, userEmail: session.user.email };
            void save(next).then(() => resolve(next));
          }}
        />
      );
    case "mode":
      return server ? (
        <ModeChoice
          email={config.userEmail ?? ""}
          server={server}
          onChoose={async (mode, migrate) => {
            if (migrate) await moveLocalToServer(server);
            const next = { ...config, mode };
            await save(next);
            await resolve(next);
          }}
        />
      ) : (
        <Spinner />
      );
    case "unreachable":
      return (
        <ErrorCard
          title="Sunucuya ulaşılamıyor"
          message={`${config.serverUrl ?? ""} — ${step.message}`}
          actions={
            <>
              <button className="btn-primary" onClick={() => void resolve(config)}>
                Tekrar dene
              </button>
              <button className="btn-secondary" onClick={() => void logout()}>
                Çıkış yap
              </button>
            </>
          }
        />
      );
    case "ready":
      return (
        <AuthContext.Provider value={ctx}>
          {children}
          {reauth && auth && (
            <ReauthOverlay
              auth={auth}
              currentUserId={config.userId ?? null}
              onDone={async (session) => {
                await save({ ...config, token: session.token, userId: session.user.id, userEmail: session.user.email });
                setReauth(false);
              }}
              onSwitchAccount={async (session) => {
                // Bellekteki token güncellenmez (setConfig yok): yeniden yüklemeye kadar eski hesabın verisi yeni hesaba gidemez.
                // Veri yeri seçimi yeni hesap için yeniden sorulur.
                clearLocalTraces();
                await saveClientConfig({ serverUrl: config.serverUrl ?? null, token: session.token, userId: session.user.id, userEmail: session.user.email });
              }}
            />
          )}
        </AuthContext.Provider>
      );
  }
}
