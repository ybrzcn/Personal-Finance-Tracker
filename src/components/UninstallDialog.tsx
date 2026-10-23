import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage, tauriApi, type UninstallPlan } from "../lib/api";
import { isMac } from "../lib/platform";
import { Modal } from "./Modal";
import { lang, t } from "../lib/i18n";

// Onay kelimesi arayüz dilinde (İngilizcede DELETE)
const CONFIRM_WORD = t("SİL");

const REMOVAL_TEXT: Record<UninstallPlan["appRemoval"], string> = {
  bundle: t("Uygulamanın kendisi (Finans.app) de silinir."),
  uninstaller: t("Ardından Windows kaldırıcısı sessizce çalıştırılır ve program dosyaları silinir."),
  appImage: t("Uygulamanın kendisi (AppImage dosyası) de silinir."),
  manual: t(
    "Uygulama bir paket yöneticisiyle kurulduğu için program dosyalarını sistemden kaldırman gerekir (ör. Ayarlar → Uygulamalar ya da sudo apt remove finans).",
  ),
  development: t("Geliştirme sürümünde kaldırma devre dışıdır (verilerin korunur); liste yalnız bilgi amaçlıdır. Dağıtım sürümünde çalışır."),
};

/**
 * Uygulamayı izsiz kaldırma: veritabanı, otomatik yedekler, ayarlar, önbellekler ve (mümkünse) uygulamanın kendisi.
 * Geri alınamaz; "SİL" yazılmadan başlatılamaz.
 */
export function UninstallDialog({ onClose, onBackup }: { onClose(): void; onBackup(): void }) {
  const [plan, setPlan] = useState<UninstallPlan | null>(null);
  const [includeCustom, setIncludeCustom] = useState(true);
  const [word, setWord] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Sunucu modunda da yerel uygulama kaldırılır (etkin veri katmanı değil)
    tauriApi.uninstallPlan().then(setPlan).catch((e) => setError(errorMessage(e)));
  }, []);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await tauriApi.uninstallApp(includeCustom);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const confirmHint = t("Onaylamak için {word} yaz").split("{word}");
  const ready = word.trim().toLocaleUpperCase(lang) === CONFIRM_WORD && !!plan && !busy;

  return (
    <Modal
      title={t("Uygulamayı kaldır")}
      width="max-w-xl"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} data-autofocus>
            {t("Vazgeç")}
          </button>
          <button type="button" className="btn-danger" disabled={!ready} onClick={() => void run()}>
            <Trash2 size={16} /> {t("Her şeyi sil ve kaldır")}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p>
          {t("Finans kapanır ve bu bilgisayardaki")} <strong>{t("tüm verisi kalıcı olarak silinir")}</strong>
          {t(": hesaplar, işlemler, bütçeler, otomatik yedekler, ayarlar ve önbellekler. Bu işlem geri alınamaz.")}
        </p>
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          {t("Verilerini saklamak istiyorsan önce yedek al.")}{" "}
          <button type="button" className="font-semibold underline underline-offset-2" onClick={onBackup}>
            {t("JSON yedeği al")}
          </button>
        </div>

        {plan ? (
          <>
            <div>
              <div className="label">{t("Silinecekler")}</div>
              <ul className="max-h-40 space-y-1 overflow-auto rounded-lg bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-800">
                {plan.dataPaths.map((p) => (
                  <li key={p} className="break-all">
                    {p}
                  </li>
                ))}
                {plan.appPath && <li className="break-all">{plan.appPath}</li>}
              </ul>
              <p className="mt-1.5 text-xs text-zinc-500">{REMOVAL_TEXT[plan.appRemoval]}</p>
            </div>
            {plan.customDatabase.length > 0 && (
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={includeCustom} onChange={(e) => setIncludeCustom(e.target.checked)} />
                <span>
                  {t("Seçtiğim veritabanı dosyasını da sil")}
                  <span className="block break-all font-mono text-xs text-zinc-500">{plan.customDatabase.join(", ")}</span>
                </span>
              </label>
            )}
            <p className="text-xs text-zinc-500">
              {isMac
                ? t("Kendi seçtiğin klasörlere kaydettiğin yedek dosyaları (JSON, CSV, veritabanı kopyaları) silinmez; istersen onları Finder'dan kendin silebilirsin.")
                : t(
                    "Kendi seçtiğin klasörlere kaydettiğin yedek dosyaları (JSON, CSV, veritabanı kopyaları) silinmez; istersen onları dosya yöneticisinden kendin silebilirsin.",
                  )}
            </p>
          </>
        ) : (
          !error && <p className="text-zinc-500">{t("Silinecekler hazırlanıyor…")}</p>
        )}

        <div>
          <label className="label" htmlFor="uninstall-confirm">
            {confirmHint[0]}
            <strong>{CONFIRM_WORD}</strong>
            {confirmHint[1]}
          </label>
          <input
            id="uninstall-confirm"
            className="input max-w-[10rem]"
            autoComplete="off"
            value={word}
            onChange={(e) => setWord(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
