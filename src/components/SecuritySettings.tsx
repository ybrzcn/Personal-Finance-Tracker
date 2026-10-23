import { KeyRound, Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AuthApi, PasskeyInfo, Security, TotpSetup } from "../lib/authApi";
import { formatDate } from "../lib/format";
import { defaultPasskeyName, passkeySupported } from "../lib/passkey";
import { useUI } from "../state/ui";
import { t, tc, tm } from "../lib/i18n";
import { Modal } from "./Modal";

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
      {tm(error)}
    </p>
  );
}

const unixDate = (s: number) => formatDate(new Date(s * 1000).toISOString().slice(0, 10));

/** Doğrulama uygulaması kodu ve passkey'ler (sunucu hesabı). */
export function SecuritySettings({ auth }: { auth: AuthApi }) {
  const [sec, setSec] = useState<Security | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"totp-on" | "totp-off" | "passkey" | null>(null);
  const [removing, setRemoving] = useState<PasskeyInfo | null>(null);

  const load = useCallback(() => {
    auth
      .security()
      .then((s) => {
        setSec(s);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [auth]);
  useEffect(load, [load]);

  if (!sec) return error ? <ErrorText error={error} /> : <p className="text-sm text-zinc-500">{t("Yükleniyor…")}</p>;
  return (
    <div className="space-y-4">
      <ErrorText error={error} />
      <div className="flex items-start gap-3">
        <Smartphone size={18} className="mt-0.5 shrink-0 text-zinc-400" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {t("Doğrulama uygulaması")}{" "}
            <span
              className={`ml-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                sec.totp ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
              }`}
            >
              {/* "Açık" sözlükte tema adı (Light); burada durum */}
              {sec.totp ? tc("durum", "Açık") : tc("durum", "Kapalı")}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">{t("Girişte şifreden sonra telefonundaki uygulamanın 6 haneli kodu da istenir.")}</p>
        </div>
        <button className="btn-secondary shrink-0" onClick={() => setDialog(sec.totp ? "totp-off" : "totp-on")}>
          {sec.totp ? t("Kapat…") : t("Aç…")}
        </button>
      </div>
      <div className="flex items-start gap-3">
        <KeyRound size={18} className="mt-0.5 shrink-0 text-zinc-400" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Passkey</div>
          <p className="mt-0.5 text-xs text-zinc-500">
            {passkeySupported
              ? t("Şifre yazmadan parmak izi, yüz ya da cihaz PIN'iyle giriş.")
              : t("Şifre yazmadan parmak izi, yüz ya da cihaz PIN'iyle giriş. Passkey eklemek ve kullanmak için Finans'ı tarayıcıda aç.")}
          </p>
          {sec.passkeys.length > 0 && (
            <ul className="mt-2 space-y-1">
              {sec.passkeys.map((p) => (
                <li key={p.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm dark:border-zinc-800">
                  <span className="min-w-0 flex-1 truncate" title={p.name}>
                    {p.name}
                  </span>
                  <span className="shrink-0 text-xs text-zinc-500">
                    {p.lastUsed ? t("son giriş {date}", { date: unixDate(p.lastUsed) }) : t("eklendi {date}", { date: unixDate(p.createdAt) })}
                  </span>
                  <button className="icon-btn" title={t("Sil")} aria-label={t("{name} sil", { name: p.name })} onClick={() => setRemoving(p)}>
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {passkeySupported && (
          <button className="btn-secondary shrink-0" onClick={() => setDialog("passkey")}>
            {t("Ekle…")}
          </button>
        )}
      </div>
      {dialog === "totp-on" && <TotpEnableDialog auth={auth} onClose={() => setDialog(null)} onDone={load} />}
      {dialog === "totp-off" && <TotpDisableDialog auth={auth} onClose={() => setDialog(null)} onDone={load} />}
      {dialog === "passkey" && <PasskeyAddDialog auth={auth} totp={sec.totp} onClose={() => setDialog(null)} onDone={load} />}
      {removing && <PasskeyDeleteDialog auth={auth} passkey={removing} onClose={() => setRemoving(null)} onDone={load} />}
    </div>
  );
}

type DialogProps = { auth: AuthApi; onClose(): void; onDone(): void };

/** İki adım: şifre → QR kodu ve ilk kod (doğru kod girilene kadar açılmaz). */
function TotpEnableDialog({ auth, onClose, onDone }: DialogProps) {
  const { toast } = useUI();
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const disabled = busy || (setup ? code.trim().length < 6 : !password);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      if (!setup) {
        setSetup(await auth.totpSetup(password));
        setPassword("");
      } else {
        await auth.totpEnable(setup.ticket, code);
        toast(t("İki aşamalı doğrulama açıldı. Diğer cihazlardaki oturumlar kapatıldı."));
        onDone();
        onClose();
      }
    } catch (err) {
      const msg = String(err);
      // Kurulum süresi dolduysa baştan (yeni anahtar verilir; uygulamaya eklenen eski kayıt silinmeli)
      if (setup && msg.includes("süresi doldu")) {
        setSetup(null);
        setCode("");
      }
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("Doğrulama uygulamasını aç")}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            {t("Vazgeç")}
          </button>
          <button className="btn-primary" disabled={disabled} onClick={() => void submit()}>
            {busy ? "…" : setup ? t("Aç") : t("Devam")}
          </button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <ErrorText error={error} />
        {!setup ? (
          <div>
            <label className="label" htmlFor="totp-pw">
              {t("Şifre")}
            </label>
            <input id="totp-pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        ) : (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {t("Doğrulama uygulamasında (Google Authenticator, Microsoft Authenticator, 1Password vb.) bu QR kodunu tara ya da anahtarı elle gir.")}
            </p>
            <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qr)}`} alt={t("QR kodu")} className="mx-auto h-48 w-48 rounded-lg bg-white p-1" />
            <p className="select-all break-all rounded-lg bg-zinc-100 px-3 py-2 text-center font-mono text-sm tracking-wider dark:bg-zinc-800/60">{setup.secret}</p>
            <div>
              <label className="label" htmlFor="totp-code">
                {t("Uygulamadaki 6 haneli kod")}
              </label>
              <input
                id="totp-code"
                className="input text-center font-mono text-lg tracking-[0.3em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <p className="text-xs text-zinc-500">{t("Telefonunu kaybedersen kurtarma kodunla yeni şifre belirleyebilirsin; bu durumda iki aşamalı doğrulama kapanır.")}</p>
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function TotpDisableDialog({ auth, onClose, onDone }: DialogProps) {
  const { toast } = useUI();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const disabled = busy || !password || code.trim().length < 6;
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      await auth.totpDisable(password, code);
      toast(t("İki aşamalı doğrulama kapatıldı."));
      onDone();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("Doğrulama uygulamasını kapat")}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            {t("Vazgeç")}
          </button>
          <button className="btn-danger" disabled={disabled} onClick={() => void submit()}>
            {busy ? "…" : t("Doğrulamayı kapat")}
          </button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <ErrorText error={error} />
        <div>
          <label className="label" htmlFor="totp-off-pw">
            {t("Şifre")}
          </label>
          <input id="totp-off-pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="totp-off-code">
            {t("Uygulamadaki 6 haneli kod")}
          </label>
          <input
            id="totp-off-code"
            className="input text-center font-mono text-lg tracking-[0.3em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function PasskeyAddDialog({ auth, totp, onClose, onDone }: DialogProps & { totp: boolean }) {
  const { toast } = useUI();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultPasskeyName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const disabled = busy || !password || (totp && code.trim().length < 6);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      await auth.addPasskey(password, name, code);
      toast(t("Passkey eklendi; diğer cihazlardaki oturumlar kapatıldı. Giriş ekranında \"Passkey ile giriş\"i kullanabilirsin."));
      onDone();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("Passkey ekle")}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            {t("Vazgeç")}
          </button>
          <button className="btn-primary" disabled={disabled} onClick={() => void submit()}>
            {busy ? "…" : t("Ekle")}
          </button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <ErrorText error={error} />
        <div>
          <label className="label" htmlFor="pk-name">
            {t("Ad")}
          </label>
          <input id="pk-name" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          <p className="mt-1 text-xs text-zinc-500">{t("Hangi cihaz ya da parola yöneticisi olduğunu ayırt etmek için.")}</p>
        </div>
        <div>
          <label className="label" htmlFor="pk-pw">
            {t("Şifre")}
          </label>
          <input id="pk-pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {totp && (
          <div>
            <label className="label" htmlFor="pk-code">
              {t("Uygulamadaki 6 haneli kod")}
            </label>
            <input
              id="pk-code"
              className="input text-center font-mono text-lg tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
        )}
        <p className="text-xs text-zinc-500">{t("Ekle'ye basınca tarayıcı parmak izi, yüz ya da cihaz PIN'i isteyecek.")}</p>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function PasskeyDeleteDialog({ auth, passkey, onClose, onDone }: DialogProps & { passkey: PasskeyInfo }) {
  const { toast } = useUI();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const disabled = busy || !password;
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      await auth.deletePasskey(passkey.id, password);
      toast(t("Passkey silindi."));
      onDone();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("Passkey silinsin mi?")}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            {t("Vazgeç")}
          </button>
          <button className="btn-danger" disabled={disabled} onClick={() => void submit()}>
            {busy ? "…" : t("Passkey'i sil")}
          </button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <ErrorText error={error} />
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {t('"{name}" ile artık giriş yapılamaz. Cihazdaki kaydı ayrıca cihazın parola yöneticisinden silebilirsin.', { name: passkey.name })}
        </p>
        <div>
          <label className="label" htmlFor="passkey-del-pw">
            {t("Şifre")}
          </label>
          <input id="passkey-del-pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
