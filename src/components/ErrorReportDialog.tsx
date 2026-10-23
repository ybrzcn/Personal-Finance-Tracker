import { ClipboardCopy, Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, tauriApi } from "../lib/api";
import { isTauri } from "../lib/platform";
import { buildReport, getErrors, type ReportInfo } from "../lib/errorLog";
import { saveTextFile } from "../lib/fileio";
import { todayISO } from "../lib/format";
import { Modal } from "./Modal";
import { t } from "../lib/i18n";

/**
 * Hata bildirimi: kullanıcı ne yaptığını yazar; rapor (sürüm, sistem, son hatalar) panoya kopyalanır veya
 * dosyaya kaydedilir. Finansal veri eklenmez. Sağlayıcılar dışında (ErrorBoundary) da çalışır.
 */
export function ErrorReportDialog({ page, onClose }: { page: string; onClose(): void }) {
  const [description, setDescription] = useState("");
  const [info, setInfo] = useState<ReportInfo>({ version: "?", os: "?", arch: "?", schemaVersion: null, page });
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const errors = useMemo(() => getErrors(), []);

  useEffect(() => {
    // Masaüstünde sunucu modunda da uygulamanın kendi sürüm/sistem bilgisi
    (isTauri ? tauriApi : api)
      .appInfo()
      .then((a) => setInfo({ ...a, page }))
      .catch(() => {});
  }, [page]);

  const report = buildReport(description, info, errors);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setStatus({ ok: true, text: t("Rapor panoya kopyalandı. E-posta veya mesaja yapıştırıp iletebilirsin.") });
    } catch {
      setStatus({ ok: false, text: t("Panoya kopyalanamadı; aşağıdaki metni seçip kopyala ya da dosyaya kaydet.") });
    }
  };
  const save = async () => {
    try {
      if (await saveTextFile(`finans-hata-raporu-${todayISO()}.txt`, report, { name: t("Metin"), extensions: ["txt"] }))
        setStatus({ ok: true, text: t("Rapor kaydedildi. Dosyayı geliştiriciye iletebilirsin.") });
    } catch (e) {
      setStatus({ ok: false, text: errorMessage(e) });
    }
  };

  return (
    <Modal
      title={t("Hata bildir")}
      width="max-w-xl"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("Kapat")}
          </button>
          <button type="button" className="btn-secondary" onClick={() => void save()}>
            <Download size={16} /> {t("Dosyaya kaydet")}
          </button>
          <button type="button" className="btn-primary" onClick={() => void copy()}>
            <ClipboardCopy size={16} /> {t("Kopyala")}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="report-desc">
            {t("Ne yapıyordun, ne oldu?")}
          </label>
          <textarea
            id="report-desc"
            data-autofocus
            className="input min-h-24"
            placeholder={t("Örn. İşlemler sayfasında nakit avans eklerken 'Ekle'ye bastım, pencere kapanmadı.")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <p className="text-xs text-zinc-500">
          {t(
            "Rapora uygulama sürümü, işletim sistemi ve son {n} hata eklenir. Hesapların, tutarların ve işlemlerin eklenmez. Göndermeden önce aşağıdan kontrol edebilirsin.",
            { n: Math.min(errors.length, 10) },
          )}
        </p>
        <details className="text-xs">
          <summary className="cursor-pointer font-medium">{t("Raporu göster")}</summary>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-100 p-3 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {report}
          </pre>
        </details>
        {status && (
          <p
            role={status.ok ? "status" : "alert"}
            className={`rounded-lg px-3 py-2 text-sm ${
              status.ok
                ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300"
                : "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300"
            }`}
          >
            {status.text}
          </p>
        )}
      </div>
    </Modal>
  );
}
