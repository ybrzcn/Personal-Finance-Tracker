import { Download, Loader2, X } from "lucide-react";
import { openReleases } from "../lib/updater";
import { updatesEnabled, useUpdates } from "../state/updates";

/** Yeni sürüm uyarısı (masaüstü): sağ altta; "Sonra" o sürüm için gizler, Ayarlar'dan yine kurulabilir */
export function UpdateNotice() {
  if (!updatesEnabled) return null;
  return <Notice />;
}

function Notice() {
  const { update, phase, percent, error, dismissed, install, dismiss } = useUpdates();
  if (!update || (dismissed && phase === "idle")) return null;
  const working = phase === "downloading" || phase === "installing";

  return (
    <div
      role="status"
      className="card fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-50 w-[min(22rem,calc(100vw-2rem))] p-4 shadow-lg md:bottom-4"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
          <Download size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Finans {update.version} hazır</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Şu an {update.currentVersion} kullanıyorsun.{" "}
            <button className="underline hover:text-zinc-700 dark:hover:text-zinc-300" onClick={() => void openReleases()}>
              Yenilikler
            </button>
          </p>
        </div>
        {!working && (
          <button className="icon-btn -mr-1 -mt-1" title="Sonra" aria-label="Sonra" onClick={dismiss}>
            <X size={16} />
          </button>
        )}
      </div>

      {working ? (
        <div className="mt-3 space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className={`h-full rounded-full bg-emerald-500 ${percent === null ? "w-1/3 animate-pulse" : ""}`}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
          <p className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Loader2 size={12} className="animate-spin" />
            {phase === "installing" ? "Kuruluyor; uygulama yeniden başlayacak…" : `İndiriliyor${percent === null ? "…" : ` %${percent}`}`}
          </p>
        </div>
      ) : update.canInstall ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => void install()}>
            Güncelle ve yeniden başlat
          </button>
          <button className="btn-ghost px-3 py-1.5 text-xs" onClick={dismiss}>
            Sonra
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-zinc-500">Bu kurulum kendini güncelleyemiyor; yeni sürümü indirip kurman gerekiyor.</p>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => void openReleases()}>
              İndirme sayfasını aç
            </button>
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={dismiss}>
              Sonra
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
}
