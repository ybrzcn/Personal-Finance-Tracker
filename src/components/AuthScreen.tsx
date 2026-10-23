import { Check, Copy, Download, KeyRound, Wallet } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { authApi as webAuth, type AuthApi, type Session } from "../lib/authApi";
import { saveTextFile } from "../lib/fileio";
import { passkeySupported } from "../lib/passkey";
import { isMobile } from "../lib/platform";
import { t, tm } from "../lib/i18n";

type View = "login" | "register" | "recover" | "totp";

/** Web: giriş, kayıt ve kurtarma kodu ile şifre sıfırlama. Kayıt/kurtarmadan sonra kurtarma kodu gösterilir. */
export function AuthScreen({
  auth = webAuth,
  notice,
  header,
  initialView = "login",
  onBack,
  onDone,
}: {
  /** Açılış görünümü (tanıtım sayfasından "Hesap oluştur" ile gelince kayıt) */
  initialView?: "login" | "register";
  /** Web: tanıtım sayfasına dönüş */
  onBack?: () => void;
  /** Masaüstünde seçilen sunucunun istemcisi; web'de varsayılan */
  auth?: AuthApi;
  notice: string | null;
  /** Formun üstünde ek satır (masaüstü: seçili sunucu) */
  header?: ReactNode;
  onDone(session: Session): void;
}) {
  const [view, setView] = useState<View>(initialView);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [code, setCode] = useState("");
  const [otp, setOtp] = useState("");
  // Şifre doğru; doğrulama uygulaması kodu bekleniyor
  const [ticket, setTicket] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Kayıt/kurtarma sonrası gösterilecek yeni kurtarma kodu (onaylanınca uygulamaya geçilir)
  const [issued, setIssued] = useState<{ session: Session; renewed: boolean } | null>(null);

  if (issued) {
    return (
      <Shell>
        <RecoveryCodeView
          code={issued.session.recoveryCode ?? ""}
          renewed={issued.renewed}
          totpDisabled={!!issued.session.totpDisabled}
          passkeysRemoved={issued.session.passkeysRemoved ?? 0}
          onContinue={() => onDone(issued.session)}
        />
      </Shell>
    );
  }

  const go = (v: View) => {
    setView(v);
    setError(null);
    setPassword("");
    setPassword2("");
    setOtp("");
    setTicket(null);
  };

  const passkey = async () => {
    setError(null);
    setBusy(true);
    try {
      onDone(await auth.loginPasskey());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if ((view === "register" || view === "recover") && password !== password2) {
      setError(t("Şifreler aynı değil."));
      return;
    }
    setBusy(true);
    try {
      if (view === "login") {
        const res = await auth.login(email, password);
        if ("mfa" in res) {
          setTicket(res.ticket);
          setOtp("");
          setView("totp");
        } else {
          onDone(res);
        }
      } else if (view === "totp") {
        try {
          onDone(await auth.loginTotp(ticket ?? "", otp));
        } catch (err) {
          // Bilet düştüyse (süre ya da deneme sınırı) şifre adımına dönülür
          if (String(err).includes("süresi doldu")) go("login");
          throw err;
        }
      } else if (view === "register") {
        setIssued({ session: await auth.register(email, password), renewed: false });
      } else {
        setIssued({ session: await auth.recover(email, code, password), renewed: true });
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const title = view === "login" ? t("Giriş yap") : view === "register" ? t("Hesap oluştur") : view === "totp" ? t("Doğrulama kodu") : t("Şifremi unuttum");
  return (
    <Shell>
      {header}
      {onBack && (
        <button className="mb-3 text-xs text-zinc-500 hover:underline" onClick={onBack}>
          ← {t("Ana sayfa")}
        </button>
      )}
      <h1 className="text-lg font-semibold">{title}</h1>
      {view === "recover" && (
        <p className="mt-1 text-sm text-zinc-500">
          {t(
            "Kayıt olurken verilen kurtarma koduyla yeni şifre belirleyebilirsin. İki aşamalı doğrulama kapanır ve passkey'ler silinir; sonra Ayarlar'dan yeniden ekleyebilirsin.",
          )}
        </p>
      )}
      {notice && view === "login" && <p role="status" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">{tm(notice)}</p>}
      <form className="mt-4 space-y-3" onSubmit={submit}>
        {error && (
          <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {tm(error)}
          </p>
        )}
        {view === "totp" ? (
          <div>
            <p className="mb-3 text-sm text-zinc-500">{t("Doğrulama uygulamandaki (Google Authenticator, 1Password vb.) 6 haneli Finans kodunu gir.")}</p>
            <label className="label" htmlFor="auth-otp">
              {t("Kod")}
            </label>
            <input
              id="auth-otp"
              className="input text-center font-mono text-lg tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              autoFocus
              required
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
            />
          </div>
        ) : (
          <div>
            <label className="label" htmlFor="auth-email">
              {t("E-posta")}
            </label>
            <input
              id="auth-email"
              className="input"
              type="email"
              autoComplete={view === "login" && passkeySupported ? "username webauthn" : "username"}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        )}
        {view === "recover" && (
          <div>
            <label className="label" htmlFor="auth-code">
              {t("Kurtarma kodu")}
            </label>
            <input
              id="auth-code"
              className="input font-mono uppercase"
              autoComplete="off"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
        )}
        {view !== "totp" && (
          <div>
            <label className="label" htmlFor="auth-password">
              {view === "login" ? t("Şifre") : t("Yeni şifre")}
            </label>
            <input
              id="auth-password"
              className="input"
              type="password"
              autoComplete={view === "login" ? "current-password" : "new-password"}
              minLength={view === "login" ? undefined : 8}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {view !== "login" && <p className="mt-1 text-xs text-zinc-500">{t("En az 8 karakter.")}</p>}
          </div>
        )}
        {(view === "register" || view === "recover") && (
          <div>
            <label className="label" htmlFor="auth-password2">
              {t("Yeni şifre (tekrar)")}
            </label>
            <input
              id="auth-password2"
              className="input"
              type="password"
              autoComplete="new-password"
              required
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
            />
          </div>
        )}
        <button className="btn-primary w-full justify-center" type="submit" disabled={busy}>
          {busy ? "…" : view === "login" ? t("Giriş yap") : view === "register" ? t("Hesap oluştur") : view === "totp" ? t("Doğrula") : t("Şifreyi sıfırla")}
        </button>
      </form>
      {view === "login" && passkeySupported && (
        <button className="btn-secondary mt-2 w-full justify-center" disabled={busy} onClick={() => void passkey()}>
          <KeyRound size={15} /> {t("Passkey ile giriş")}
        </button>
      )}
      <div className="mt-4 flex flex-wrap justify-between gap-2 text-sm">
        {view === "login" ? (
          <>
            <button className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => go("register")}>
              {t("Hesap oluştur")}
            </button>
            <button className="text-zinc-500 hover:underline" onClick={() => go("recover")}>
              {t("Şifremi unuttum")}
            </button>
          </>
        ) : view === "totp" ? (
          <>
            <button className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => go("login")}>
              {t("Girişe dön")}
            </button>
            <button
              className="text-zinc-500 hover:underline"
              onClick={() => go("recover")}
              title={t("Kurtarma koduyla yeni şifre belirlenir ve iki aşamalı doğrulama kapanır")}
            >
              {t("Koda erişemiyorum")}
            </button>
          </>
        ) : (
          <button className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => go("login")}>
            {t("Girişe dön")}
          </button>
        )}
      </div>
    </Shell>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 text-lg font-semibold">
          <Wallet className="text-indigo-500" /> Finans
        </div>
        <div className="card p-6">{children}</div>
      </div>
    </div>
  );
}

function RecoveryCodeView({
  code,
  renewed,
  totpDisabled,
  passkeysRemoved,
  onContinue,
}: {
  code: string;
  renewed: boolean;
  totpDisabled: boolean;
  passkeysRemoved: number;
  onContinue(): void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  // Kod onaylanmadan sayfa yenilenir/kapatılırsa tarayıcı uyarsın (oturum açık olduğu için kod bir daha görünmez)
  useEffect(() => {
    if (saved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saved]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      /* pano izni yoksa kullanıcı elle seçip kopyalar */
    }
  };
  const download = () =>
    void saveTextFile(
      "finans-kurtarma-kodu.txt",
      `${t("Finans kurtarma kodu")}\n\n${code}\n\n${t("Şifreni unutursan bu kodla yeni şifre belirleyebilirsin.")}\n`,
      { name: t("Metin"), extensions: ["txt"] },
    );

  return (
    <>
      <h1 className="text-lg font-semibold">{t("Kurtarma kodun")}</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {t("Şifreni unutursan hesabını yalnız bu kodla kurtarabilirsin. Kod")} <strong>{t("bir daha gösterilmez")}</strong>
        {t(": sayfayı yenilersen veya kapatırsan kaybolur, şimdi kaydet.")}
        {renewed && ` ${t("Eski kurtarma kodun artık geçersiz.")}`}
      </p>
      {(totpDisabled || passkeysRemoved > 0) && (
        <p role="status" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          {[totpDisabled && t("İki aşamalı doğrulama kapatıldı"), passkeysRemoved > 0 && t("{n} passkey silindi", { n: passkeysRemoved })]
            .filter(Boolean)
            .join(", ")}
          . {t("Ayarlar → Giriş güvenliği'nden yeniden ekleyebilirsin.")}
        </p>
      )}
      <p className="mt-4 select-all rounded-xl border border-zinc-200 bg-zinc-50 py-4 text-center font-mono text-lg tracking-wider dark:border-zinc-700 dark:bg-zinc-800/60">
        {code}
      </p>
      <div className="mt-3 flex gap-2">
        <button className="btn-secondary flex-1 justify-center" onClick={() => void copy()}>
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? t("Kopyalandı") : t("Kopyala")}
        </button>
        {/* Mobilde dosya Belgeler'e (Dosyalar uygulamasında herkese görünür) düşerdi; orada yalnız kopyalama */}
        {!isMobile && (
          <button className="btn-secondary flex-1 justify-center" onClick={download}>
            <Download size={15} /> {t("İndir")}
          </button>
        )}
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        {t("Kodu güvenli bir yere kaydettim")}
      </label>
      <button className="btn-primary mt-4 w-full justify-center" disabled={!saved} onClick={onContinue}>
        {t("Devam")}
      </button>
    </>
  );
}
