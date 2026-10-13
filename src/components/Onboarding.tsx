import { Cloud, HardDrive, Loader2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { Api } from "../lib/api";
import { createAuthApi } from "../lib/authApi";
import { normalizeServerUrl, type Mode } from "../lib/client";
import { localDataCount, serverDataCount } from "../lib/transfer";
import { Shell } from "./AuthScreen";

const linkCls = "text-indigo-600 hover:underline dark:text-indigo-400";

/** İlk açılış: hesabın tutulacağı sunucunun adresi; "Şimdilik hesapsız devam et" ile yalnız yerel kullanım. */
export function ServerStep({ initial, onDone, onSkip }: { initial: string; onDone(url: string): void; onSkip(): void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let url: string;
    try {
      url = normalizeServerUrl(value);
    } catch (err) {
      setError(String(err));
      return;
    }
    setBusy(true);
    const ok = await createAuthApi({ baseUrl: url }).health();
    setBusy(false);
    if (ok) onDone(url);
    else setError("Bu adreste Finans sunucusu bulunamadı. Adresi ve internet bağlantını kontrol et.");
  };

  return (
    <Shell>
      <h1 className="text-lg font-semibold">Finans'a hoş geldin</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Hesabın bir Finans sunucusunda tutulur. Verilerini bu cihazda tutmayı seçersen sunucuya veri gönderilmez.
      </p>
      <form className="mt-4 space-y-3" onSubmit={submit}>
        {error && (
          <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {error}
          </p>
        )}
        <div>
          <label className="label" htmlFor="server-url">
            Sunucu adresi
          </label>
          <input
            id="server-url"
            className="input"
            inputMode="url"
            autoComplete="url"
            placeholder="https://finans.ornek.com"
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <p className="mt-1 text-xs text-zinc-500">Kendi sunucunu kurduysan onun adresini yaz.</p>
        </div>
        <button className="btn-primary w-full justify-center" type="submit" disabled={busy}>
          {busy ? "Kontrol ediliyor…" : "Devam"}
        </button>
      </form>
      <div className="mt-4 border-t border-zinc-200 pt-4 text-center text-sm dark:border-zinc-800">
        <button className={linkCls} onClick={onSkip}>
          Şimdilik hesapsız devam et
        </button>
        <p className="mt-1 text-xs text-zinc-500">Veriler yalnız bu cihazda kalır; hesabı sonra Ayarlar'dan bağlayabilirsin.</p>
      </div>
    </Shell>
  );
}

/** Hesap açıldıktan / giriş yapıldıktan sonra: veri nerede dursun? */
export function ModeChoice({
  email,
  server,
  onChoose,
}: {
  email: string;
  /** Seçilen sunucunun veri istemcisi (sayım ve taşıma için) */
  server: Api;
  /** `migrate`: sunucu seçildiğinde bu cihazdaki veri sunucuya taşınsın mı */
  onChoose(mode: Mode, migrate: boolean): Promise<void>;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const [remote, setRemote] = useState<number | null>(null);
  const [pendingServer, setPendingServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    localDataCount().then(setLocal).catch(() => setLocal(0));
    // Sayılamazsa bilinmiyor (-1): üzerine yazma uyarısı yine gösterilir
    serverDataCount(server).then(setRemote).catch(() => setRemote(-1));
  }, [server]);

  const choose = async (mode: Mode, migrate: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await onChoose(mode, migrate);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const card =
    "flex w-full items-start gap-3 rounded-xl border border-zinc-200 p-4 text-left transition hover:border-indigo-400 hover:bg-indigo-50/40 disabled:opacity-60 dark:border-zinc-800 dark:hover:bg-indigo-500/5";

  return (
    <Shell>
      <h1 className="text-lg font-semibold">Veri nerede dursun?</h1>
      <p className="mt-1 text-sm text-zinc-500">{email} hesabıyla giriş yapıldı. Bunu sonradan Ayarlar'dan değiştirebilirsin.</p>
      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          {error}
        </p>
      )}
      {local === null || remote === null ? (
        <div className="grid h-32 place-items-center text-zinc-400">
          <Loader2 className="animate-spin" />
        </div>
      ) : !pendingServer ? (
        <div className="mt-4 space-y-3">
          <button className={card} disabled={busy} onClick={() => void choose("local", false)}>
            <HardDrive className="mt-0.5 shrink-0 text-indigo-500" size={20} />
            <span>
              <span className="block font-medium">Bu cihazda</span>
              <span className="block text-sm text-zinc-500">
                Veriler yalnız bu bilgisayarda; internet gerekmez. Sonradan sunucuya taşıyabilirsin.
                {local > 0 && ` Mevcut verin (${local} işlem) olduğu gibi kalır.`}
              </span>
            </span>
          </button>
          <button className={card} disabled={busy} onClick={() => (local > 0 ? setPendingServer(true) : void choose("server", false))}>
            <Cloud className="mt-0.5 shrink-0 text-indigo-500" size={20} />
            <span>
              <span className="block font-medium">Sunucuda</span>
              <span className="block text-sm text-zinc-500">Web'den ve diğer cihazlardan aynı veriye eriş; internet gerekir.</span>
            </span>
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <p className="text-sm">Bu cihazda veri var. Sunucuda hangisiyle devam edilsin?</p>
          <button className={card} disabled={busy} onClick={() => void choose("server", true)}>
            <span>
              <span className="block font-medium">Bu cihazdaki veriyi sunucuya taşı</span>
              <span className="block text-sm text-zinc-500">
                Bu cihazdaki dosya yedek olarak kalır.
                {remote !== 0 && (
                  <strong className="text-rose-600 dark:text-rose-400">
                    {remote > 0
                      ? ` Sunucudaki mevcut veri (${remote} işlem) silinip bununla değiştirilir.`
                      : " Sunucudaki veri kontrol edilemedi; varsa silinip bununla değiştirilir."}
                  </strong>
                )}
              </span>
            </span>
          </button>
          <button className={card} disabled={busy} onClick={() => void choose("server", false)}>
            <span>
              <span className="block font-medium">Sunucudaki veriyle başla</span>
              <span className="block text-sm text-zinc-500">Bu cihazdaki veriye dokunulmaz; istersen sonra Ayarlar'dan taşıyabilirsin.</span>
            </span>
          </button>
          <button className={`${linkCls} text-sm`} disabled={busy} onClick={() => setPendingServer(false)}>
            Geri
          </button>
        </div>
      )}
      {busy && <p className="mt-3 text-center text-sm text-zinc-500">Hazırlanıyor…</p>}
    </Shell>
  );
}
