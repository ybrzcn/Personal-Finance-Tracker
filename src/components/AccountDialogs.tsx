import { useState, type FormEvent } from "react";
import type { AuthApi } from "../lib/authApi";
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
      setError("Yeni şifreler aynı değil.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.changePassword(current, next);
      toast("Şifre değiştirildi. Diğer cihazlardaki oturumlar kapatıldı.");
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Şifreyi değiştir"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn-primary" disabled={busy || !current || !next} onClick={() => void submit()}>
            {busy ? "…" : "Değiştir"}
          </button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <ErrorText error={error} />
        <div>
          <label className="label" htmlFor="cp-current">
            Mevcut şifre
          </label>
          <input id="cp-current" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cp-next">
            Yeni şifre
          </label>
          <input id="cp-next" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          <p className="mt-1 text-xs text-zinc-500">En az 8 karakter.</p>
        </div>
        <div>
          <label className="label" htmlFor="cp-next2">
            Yeni şifre (tekrar)
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
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Hesabı sil"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn-danger" disabled={busy || !password} onClick={() => void submit()}>
            {busy ? "…" : "Hesabı kalıcı olarak sil"}
          </button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <p className="text-sm">
          <strong>{email}</strong> hesabı ve sunucudaki tüm verisi (işlemler, hesaplar, kategoriler, bütçeler, ayarlar){" "}
          <strong>kalıcı olarak silinir</strong>. Bu işlem geri alınamaz.
          {localNote && " Bu cihazdaki yerel veri silinmez."}
        </p>
        <p className="text-sm">
          Silmeden önce{" "}
          <button type="button" className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={onBackup}>
            JSON yedeği indir
          </button>
          .
        </p>
        <ErrorText error={error} />
        <div>
          <label className="label" htmlFor="del-password">
            Onaylamak için şifren
          </label>
          <input id="del-password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
