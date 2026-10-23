import { useState, type FormEvent } from "react";
import { errorMessage } from "../lib/api";
import type { AuthApi } from "../lib/authApi";
import { t } from "../lib/i18n";
import { useUI } from "../state/ui";
import { Modal } from "./Modal";

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
      {error}
    </p>
  );
}

/** Şifre değiştirme; başarıda diğer cihazlardaki oturumlar kapanır (sunucu). */
export function ChangePasswordDialog({ auth, onClose }: { auth: AuthApi; onClose(): void }) {
  const { toast } = useUI();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [next2, setNext2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (next !== next2) {
      setError(t("Yeni şifreler aynı değil."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.changePassword(current, next);
      toast(t("Şifre değiştirildi. Diğer cihazlardaki oturumlar kapatıldı."));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("Şifreyi değiştir")}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn-primary" disabled={busy || !current || !next} onClick={() => void submit()}>
            {busy ? "…" : t("Değiştir")}
          </button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <ErrorText error={error} />
        <div>
          <label className="label" htmlFor="cp-current">
            {t("Mevcut şifre")}
          </label>
          <input id="cp-current" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cp-next">
            {t("Yeni şifre")}
          </label>
          <input id="cp-next" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          <p className="mt-1 text-xs text-zinc-500">{t("En az 8 karakter.")}</p>
        </div>
        <div>
          <label className="label" htmlFor="cp-next2">
            {t("Yeni şifre (tekrar)")}
          </label>
          <input id="cp-next2" className="input" type="password" autoComplete="new-password" value={next2} onChange={(e) => setNext2(e.target.value)} />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Hesabı ve sunucudaki tüm veriyi kalıcı olarak siler; ardından `onDeleted` (oturumu kapatıp giriş ekranına döner). */
export function DeleteAccountDialog({
  auth,
  email,
  localNote,
  onClose,
  onBackup,
  onDeleted,
}: {
  auth: AuthApi;
  email: string;
  /** Masaüstü: bu cihazdaki verinin kalacağını belirt */
  localNote?: boolean;
  onClose(): void;
  onBackup(): void;
  onDeleted(): Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.deleteAccount(password);
      await onDeleted();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("Hesabı sil")}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn-danger" disabled={busy || !password} onClick={() => void submit()}>
            {busy ? "…" : t("Hesabı kalıcı olarak sil")}
          </button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <p className="text-sm">
          {t("{email} hesabı ve sunucudaki tüm verisi (işlemler, hesaplar, kategoriler, bütçeler, ayarlar) {deleted}. Bu işlem geri alınamaz.")
            .split(/(\{email\}|\{deleted\})/)
            .map((part, i) =>
              part === "{email}" ? (
                <strong key={i}>{email}</strong>
              ) : part === "{deleted}" ? (
                <strong key={i}>{t("kalıcı olarak silinir")}</strong>
              ) : (
                part
              ),
            )}
          {localNote && ` ${t("Bu cihazdaki yerel veri silinmez.")}`}
        </p>
        <p className="text-sm">
          {t("Silmeden önce")}{" "}
          <button type="button" className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={onBackup}>
            {t("JSON yedeği indir")}
          </button>
          .
        </p>
        <ErrorText error={error} />
        <div>
          <label className="label" htmlFor="del-password">
            {t("Onaylamak için şifren")}
          </label>
          <input id="del-password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
