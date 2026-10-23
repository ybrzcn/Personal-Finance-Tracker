import { CloudOff, Loader2, Lock, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { MIN_PASSPHRASE, syncApi, type SyncRemote } from "../lib/sync";
import { useData } from "../state/data";
import { useSync } from "../state/sync";
import { useUI } from "../state/ui";
import { locale, t, tc, tm } from "../lib/i18n";
import { Modal } from "./Modal";

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
      {tm(error)}
    </p>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Uçtan uca şifreli eşitleme (masaüstü/mobil, veri bu cihazdayken). */
export function SyncSettings() {
  const { confirm, toast } = useUI();
  const sync = useSync();
  const [remote, setRemote] = useState<SyncRemote | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"enable" | "link" | "passphrase" | "delete" | null>(null);

  const loadRemote = useCallback(() => {
    setRemoteError(null);
    syncApi
      .remote()
      .then(setRemote)
      .catch((e) => setRemoteError(String(e)));
  }, []);
  const linked = !!sync.info?.linked;
  useEffect(loadRemote, [loadRemote, linked]);

  const unlink = async () => {
    const yes = await confirm({
      title: t("Bu cihazda eşitleme kapatılsın mı?"),
      message: t("Bu cihazdaki veri yerinde kalır ve artık öbür cihazlarla eşitlenmez. Sunucudaki şifreli kopya ve öbür cihazlar etkilenmez."),
      // "Kapat" sözlükte "Close"; burada eşitlemeyi kapatmak
      confirmLabel: tc("eylem", "Kapat"),
    });
    if (!yes) return;
    try {
      await syncApi.unlink();
      await sync.refresh();
      toast(t("Bu cihazda eşitleme kapatıldı."));
    } catch (e) {
      setRemoteError(String(e));
    }
  };

  let body;
  if (linked) {
    body = (
      <>
        <div className="flex items-start gap-3">
          <Lock size={18} className="mt-0.5 shrink-0 text-emerald-500" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">
              {t("Bu cihaz eşitleniyor")}{" "}
              <span className="ml-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                {/* "Açık" sözlükte tema adı (Light); burada durum */}
                {tc("durum", "Açık")}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-zinc-500" aria-live="polite">
              {sync.running
                ? t("Eşitleniyor…")
                : sync.info?.lastSync
                  ? `${t("Son eşitleme: {time}", { time: when(sync.info.lastSync) })}${remote ? ` · ${t("sunucuda {size} şifreli veri", { size: sizeLabel(remote.bytes) })}` : ""}`
                  : t("Henüz eşitlenmedi.")}
            </p>
            {sync.lastReport && sync.lastReport.conflicts > 0 && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                {t("Son eşitlemede {n} kayıt iki cihazda birden değiştirilmişti; bu cihazdaki hali tutuldu.", { n: sync.lastReport.conflicts })}
              </p>
            )}
          </div>
          <button className="btn-secondary shrink-0" onClick={() => void sync.syncNow()} disabled={sync.running}>
            <RefreshCw size={14} className={sync.running ? "animate-spin" : ""} /> {t("Şimdi eşitle")}
          </button>
        </div>
        <ErrorText error={sync.error} />
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={() => setDialog("passphrase")}>
            {t("Eşitleme parolasını değiştir…")}
          </button>
          <button className="btn-secondary" onClick={() => void unlink()}>
            {t("Bu cihazda kapat")}
          </button>
          <button className="btn-ghost ml-auto text-rose-600 dark:text-rose-400" onClick={() => setDialog("delete")}>
            {t("Sunucudaki kopyayı sil…")}
          </button>
        </div>
      </>
    );
  } else if (remoteError) {
    body = (
      <div className="space-y-2">
        <ErrorText error={remoteError} />
        <button className="btn-secondary" onClick={loadRemote}>
          {t("Tekrar dene")}
        </button>
      </div>
    );
  } else if (!remote) {
    body = (
      <p className="flex items-center gap-2 text-sm text-zinc-500">
        <Loader2 size={14} className="animate-spin" /> {t("Sunucuya bakılıyor…")}
      </p>
    );
  } else if (remote.enabled) {
    body = (
      <>
        <div className="flex items-start gap-3">
          <CloudOff size={18} className="mt-0.5 shrink-0 text-zinc-400" />
          <p className="min-w-0 flex-1 text-sm text-zinc-600 dark:text-zinc-400">
            {remote.updatedAt
              ? t("Bu hesapta eşitleme açık (son değişiklik {time}), bu cihaz bağlı değil. Bağlamak için eşitleme parolası gerekir.", {
                  time: when(new Date(remote.updatedAt * 1000).toISOString()),
                })
              : t("Bu hesapta eşitleme açık, bu cihaz bağlı değil. Bağlamak için eşitleme parolası gerekir.")}
          </p>
          <button className="btn-primary shrink-0" onClick={() => setDialog("link")}>
            {t("Bu cihazı bağla…")}
          </button>
        </div>
        <button className="btn-ghost text-xs text-rose-600 dark:text-rose-400" onClick={() => setDialog("delete")}>
          {t("Parolayı unuttum: sunucudaki kopyayı sil…")}
        </button>
      </>
    );
  } else {
    body = (
      <div className="flex items-start gap-3">
        <CloudOff size={18} className="mt-0.5 shrink-0 text-zinc-400" />
        <p className="min-w-0 flex-1 text-sm text-zinc-600 dark:text-zinc-400">
          {t("Veriler bu cihazda kalır; öbür cihazlarınla sunucu üzerinden şifreli olarak eşitlenir. Şifreleme cihazda yapılır, sunucu verini okuyamaz.")}
        </p>
        <button className="btn-primary shrink-0" onClick={() => setDialog("enable")}>
          {t("Eşitlemeyi aç…")}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sync.detached && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          {t("Eşitleme başka bir cihazdan kapatıldı ya da sıfırlandı; bu cihaz ayrıldı. Bu cihazdaki veri yerinde.")}
        </p>
      )}
      {body}
      <p className="text-xs text-zinc-500">{t("Belge ekleri ve borç planı, analiz ayarları da eşitlenir. Web arayüzü bu veriyi göremez.")}</p>
      {dialog === "enable" && <EnableDialog onClose={() => setDialog(null)} />}
      {dialog === "link" && <LinkDialog onClose={() => setDialog(null)} />}
      {dialog === "passphrase" && <PassphraseDialog onClose={() => setDialog(null)} />}
      {dialog === "delete" && (
        <DeleteRemoteDialog
          onClose={() => setDialog(null)}
          onDone={() => {
            void sync.refresh();
            loadRemote();
          }}
        />
      )}
    </div>
  );
}

function useSubmit(action: () => Promise<void>, disabled: boolean) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (disabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, submit };
}

function PassphraseFields({ value, repeat, onValue, onRepeat, label }: { value: string; repeat: string; onValue(v: string): void; onRepeat(v: string): void; label: string }) {
  return (
    <>
      <div>
        <label className="label" htmlFor="sync-pass">
          {label}
        </label>
        <input id="sync-pass" className="input" type="password" autoComplete="new-password" value={value} onChange={(e) => onValue(e.target.value)} />
        <p className="mt-1 text-xs text-zinc-500">{t("En az {n} karakter. Hesap şifrenden farklı olsun; sunucuya hiç gönderilmez.", { n: MIN_PASSPHRASE })}</p>
      </div>
      <div>
        <label className="label" htmlFor="sync-pass2">
          {t("Parola (tekrar)")}
        </label>
        <input id="sync-pass2" className="input" type="password" autoComplete="new-password" value={repeat} onChange={(e) => onRepeat(e.target.value)} />
        {repeat && value !== repeat && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{t("Parolalar aynı değil.")}</p>}
      </div>
    </>
  );
}

function EnableDialog({ onClose }: { onClose(): void }) {
  const { toast } = useUI();
  const sync = useSync();
  const [pass, setPass] = useState("");
  const [repeat, setRepeat] = useState("");
  const disabled = [...pass].length < MIN_PASSPHRASE || pass !== repeat;
  const { error, busy, submit } = useSubmit(async () => {
    // Yarıda kalsa da (ör. anahtar yüklendi, ilk tur başarısız) durum güncel görünsün
    const r = await syncApi.enable(pass).finally(() => sync.refresh());
    await sync.applied(r);
    toast(t("Eşitleme açıldı; bu cihazın verisi şifrelenip sunucuya yüklendi."));
    onClose();
  }, disabled);
  return (
    <Modal
      title={t("Şifreli eşitlemeyi aç")}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            {t("Vazgeç")}
          </button>
          <button className="btn-primary" disabled={disabled || busy} onClick={() => void submit()}>
            {busy ? t("Şifreleniyor…") : t("Eşitlemeyi aç")}
          </button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <ErrorText error={error} />
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {t("Veriler bu cihazda şifrelenip sunucuya öyle gider. Öbür cihazlarını bu eşitleme parolasıyla bağlarsın.")}
        </p>
        <PassphraseFields value={pass} repeat={repeat} onValue={setPass} onRepeat={setRepeat} label={t("Eşitleme parolası")} />
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          {t(
            "Parolayı unutursan ve hiçbir cihaz bağlı kalmazsa sunucudaki kopya açılamaz (cihazlardaki veri yerinde kalır). Bağlı bir cihazdan parolayı her zaman değiştirebilirsin.",
          )}
        </p>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function LinkDialog({ onClose }: { onClose(): void }) {
  const { toast } = useUI();
  const sync = useSync();
  const { transactions } = useData();
  const [pass, setPass] = useState("");
  // Veri olan cihazda varsayılan birleştirmek (yanlışlıkla silinmesin); boş cihazda sunucudakini almak
  const [replace, setReplace] = useState(transactions.length === 0);
  const disabled = !pass;
  const { error, busy, submit } = useSubmit(async () => {
    const r = await syncApi.link(pass, replace).finally(() => sync.refresh());
    await sync.applied(r.report);
    toast(
      r.backupPath
        ? t("Bu cihaz bağlandı. Önceki yerel veri yedeklendi: {name}", { name: r.backupPath.split(/[\\/]/).pop() ?? "" })
        : t("Bu cihaz bağlandı."),
    );
    onClose();
  }, disabled);
  return (
    <Modal
      title={t("Bu cihazı bağla")}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            {t("Vazgeç")}
          </button>
          <button className="btn-primary" disabled={disabled || busy} onClick={() => void submit()}>
            {busy ? t("Bağlanıyor…") : t("Bağla")}
          </button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <ErrorText error={error} />
        <div>
          <label className="label" htmlFor="sync-link-pass">
            {t("Eşitleme parolası")}
          </label>
          <input id="sync-link-pass" className="input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </div>
        <fieldset className="space-y-2 text-sm">
          <legend className="label">{t("Bu cihazdaki veri ({count})", { count: t("{n} işlem", { n: transactions.length }) })}</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="sync-mode" className="mt-1" checked={replace} onChange={() => setReplace(true)} />
            <span>
              <span className="font-medium">{t("Sunucudakiyle değiştir")}</span>
              <span className="block text-xs text-zinc-500">{t("Önce bu cihazın veritabanı yedeklenir. Yeni (boş) cihaz için önerilir.")}</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="sync-mode" className="mt-1" checked={!replace} onChange={() => setReplace(false)} />
            <span>
              <span className="font-medium">{t("Birleştir")}</span>
              <span className="block text-xs text-zinc-500">
                {t('İki taraftaki kayıtlar bir arada tutulur; aynı adlı kategoriler birleşir, aynı adlı hesaplardan birinin adına "(2)" eklenir.')}
              </span>
            </span>
          </label>
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function PassphraseDialog({ onClose }: { onClose(): void }) {
  const { toast } = useUI();
  const [pass, setPass] = useState("");
  const [repeat, setRepeat] = useState("");
  const disabled = [...pass].length < MIN_PASSPHRASE || pass !== repeat;
  const { error, busy, submit } = useSubmit(async () => {
    await syncApi.changePassphrase(pass);
    toast(t("Eşitleme parolası değişti. Bağlı cihazlar etkilenmez; yeni cihazı yeni parolayla bağla."));
    onClose();
  }, disabled);
  return (
    <Modal
      title={t("Eşitleme parolasını değiştir")}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            {t("Vazgeç")}
          </button>
          <button className="btn-primary" disabled={disabled || busy} onClick={() => void submit()}>
            {busy ? "…" : t("Parolayı değiştir")}
          </button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <ErrorText error={error} />
        <PassphraseFields value={pass} repeat={repeat} onValue={setPass} onRepeat={setRepeat} label={t("Yeni eşitleme parolası")} />
        <p className="text-xs text-zinc-500">
          {t(
            "Veri anahtarı değişmez; eski parola yalnız yeni cihaz bağlamakta geçersiz olur. Anahtarı tamamen yenilemek için sunucudaki kopyayı silip eşitlemeyi yeniden aç.",
          )}
        </p>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function DeleteRemoteDialog({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const { toast } = useUI();
  const [password, setPassword] = useState("");
  const disabled = !password;
  const { error, busy, submit } = useSubmit(async () => {
    await syncApi.deleteRemote(password);
    toast(t("Sunucudaki şifreli kopya silindi; eşitleme kapandı. Cihazlardaki veri yerinde."));
    onDone();
    onClose();
  }, disabled);
  return (
    <Modal
      title={t("Sunucudaki şifreli kopyayı sil")}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            {t("Vazgeç")}
          </button>
          <button className="btn-danger" disabled={disabled || busy} onClick={() => void submit()}>
            {busy ? "…" : t("Kopyayı sil")}
          </button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <ErrorText error={error} />
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {t(
            "Sunucudaki şifreli veri ve belgeler silinir, eşitleme bütün cihazlarda kapanır. Cihazlardaki veri silinmez; istersen sonra yeni bir parolayla yeniden açabilirsin.",
          )}
        </p>
        <div>
          <label className="label" htmlFor="sync-del-pw">
            {t("Hesap şifresi")}
          </label>
          <input id="sync-del-pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
