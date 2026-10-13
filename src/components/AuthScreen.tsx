import { Check, Copy, Download, Wallet } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { authApi as webAuth, type AuthApi, type Session } from "../lib/authApi";
import { saveTextFile } from "../lib/fileio";
import { isMobile } from "../lib/platform";

type View = "login" | "register" | "recover";

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Kayıt/kurtarma sonrası gösterilecek yeni kurtarma kodu (onaylanınca uygulamaya geçilir)
  const [issued, setIssued] = useState<{ session: Session; renewed: boolean } | null>(null);

  if (issued) {
    return (
      <Shell>
        <RecoveryCodeView code={issued.session.recoveryCode ?? ""} renewed={issued.renewed} onContinue={() => onDone(issued.session)} />
      </Shell>
    );
  }

  const go = (v: View) => {
    setView(v);
    setError(null);
    setPassword("");
    setPassword2("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (view !== "login" && password !== password2) {
      setError("Şifreler aynı değil.");
      return;
    }
    setBusy(true);
    try {
      if (view === "login") {
        onDone(await auth.login(email, password));
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

  const title = view === "login" ? "Giriş yap" : view === "register" ? "Hesap oluştur" : "Şifremi unuttum";
  return (
    <Shell>
      {header}
      {onBack && (
        <button className="mb-3 text-xs text-zinc-500 hover:underline" onClick={onBack}>
          ← Ana sayfa
        </button>
      )}
      <h1 className="text-lg font-semibold">{title}</h1>
      {view === "recover" && (
        <p className="mt-1 text-sm text-zinc-500">Kayıt olurken verilen kurtarma koduyla yeni şifre belirleyebilirsin.</p>
      )}
      {notice && view === "login" && <p role="status" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">{notice}</p>}
      <form className="mt-4 space-y-3" onSubmit={submit}>
        {error && (
          <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {error}
          </p>
        )}
        <div>
          <label className="label" htmlFor="auth-email">
            E-posta
          </label>
          <input id="auth-email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {view === "recover" && (
          <div>
            <label className="label" htmlFor="auth-code">
              Kurtarma kodu
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
        <div>
          <label className="label" htmlFor="auth-password">
            {view === "login" ? "Şifre" : "Yeni şifre"}
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
          {view !== "login" && <p className="mt-1 text-xs text-zinc-500">En az 8 karakter.</p>}
        </div>
        {view !== "login" && (
          <div>
            <label className="label" htmlFor="auth-password2">
              Yeni şifre (tekrar)
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
          {busy ? "…" : view === "login" ? "Giriş yap" : view === "register" ? "Hesap oluştur" : "Şifreyi sıfırla"}
        </button>
      </form>
      <div className="mt-4 flex flex-wrap justify-between gap-2 text-sm">
        {view === "login" ? (
          <>
            <button className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => go("register")}>
              Hesap oluştur
            </button>
            <button className="text-zinc-500 hover:underline" onClick={() => go("recover")}>
              Şifremi unuttum
            </button>
          </>
        ) : (
          <button className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => go("login")}>
            Girişe dön
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

function RecoveryCodeView({ code, renewed, onContinue }: { code: string; renewed: boolean; onContinue(): void }) {
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
      `Finans kurtarma kodu\n\n${code}\n\nŞifreni unutursan bu kodla yeni şifre belirleyebilirsin.\n`,
      { name: "Metin", extensions: ["txt"] },
    );

  return (
    <>
      <h1 className="text-lg font-semibold">Kurtarma kodun</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Şifreni unutursan hesabını yalnız bu kodla kurtarabilirsin. Kod <strong>bir daha gösterilmez</strong>: sayfayı yenilersen veya kapatırsan kaybolur, şimdi kaydet.
        {renewed && " Eski kurtarma kodun artık geçersiz."}
      </p>
      <p className="mt-4 select-all rounded-xl border border-zinc-200 bg-zinc-50 py-4 text-center font-mono text-lg tracking-wider dark:border-zinc-700 dark:bg-zinc-800/60">
        {code}
      </p>
      <div className="mt-3 flex gap-2">
        <button className="btn-secondary flex-1 justify-center" onClick={() => void copy()}>
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Kopyalandı" : "Kopyala"}
        </button>
        {/* Mobilde dosya Belgeler'e (Dosyalar uygulamasında herkese görünür) düşerdi; orada yalnız kopyalama */}
        {!isMobile && (
          <button className="btn-secondary flex-1 justify-center" onClick={download}>
            <Download size={15} /> İndir
          </button>
        )}
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        Kodu güvenli bir yere kaydettim
      </label>
      <button className="btn-primary mt-4 w-full justify-center" disabled={!saved} onClick={onContinue}>
        Devam
      </button>
    </>
  );
}
