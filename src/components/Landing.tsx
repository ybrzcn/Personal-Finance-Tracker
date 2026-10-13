import { CalendarRange, ChevronDown, Download, FileUp, Github, PiggyBank, Server, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { detectPlatform, downloadUrl, PLATFORM_ORDER, PLATFORMS, REPO_URL, type PlatformKey } from "../lib/downloads";
import { PlatformIcon } from "./PlatformIcons";

const FEATURES = [
  { icon: FileUp, title: "Ekstreni yükle", text: "Bankadan indirdiğin Excel, PDF ya da CSV ekstreleri harcamalarına kategorilenerek eklenir." },
  { icon: CalendarRange, title: "Ödemelerini planla", text: "Kart ekstreleri, krediler ve maaş günleriyle hangi ödemenin hangi maaştan çıkacağını gör." },
  { icon: PiggyBank, title: "Bütçe ve borç planı", text: "Kategori limitleri, abonelik maliyetleri ve borçlarını en az faizle kapatma sırası." },
  { icon: Server, title: "Verin sende", text: "Masaüstünde yalnız bu bilgisayarda ya da kendi sunucunda; açık kaynak ve ücretsiz." },
];

function hashPlatform(): PlatformKey | null {
  const key = location.hash.replace(/^#indir-?/, "") as PlatformKey;
  return PLATFORM_ORDER.includes(key) ? key : null;
}

/** Sunucunun ana sayfası (oturum yokken): tanıtım, web'e giriş ve masaüstü indirmeleri. */
export function Landing({ onLogin, onRegister }: { onLogin(): void; onRegister(): void }) {
  // #indir-windows gibi bir bağlantı o platformu açar (README'den doğrudan indirme bölümüne); yoksa ziyaretçinin işletim sistemi
  const [open, setOpen] = useState<PlatformKey | null>(() => hashPlatform() ?? detectPlatform());
  useEffect(() => {
    if (location.hash.startsWith("#indir")) document.getElementById("indir")?.scrollIntoView();
  }, []);

  return (
    <div className="min-h-full bg-zinc-50 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] dark:bg-zinc-950">
      <header className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-4 sm:px-6">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm">
          <Wallet size={18} />
        </div>
        <span className="font-semibold">Finans</span>
        <nav className="ml-auto flex items-center gap-1">
          <a className="btn-ghost" href={REPO_URL} target="_blank" rel="noopener noreferrer">
            <Github size={16} /> <span className="hidden sm:inline">GitHub</span>
          </a>
          <button className="btn-secondary" onClick={onLogin}>
            Giriş yap
          </button>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-4 sm:px-6">
        <section className="py-10 text-center sm:py-16">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">Kişisel finansını tek yerde yönet</h1>
          <p className="mx-auto mt-4 max-w-2xl text-base text-zinc-600 sm:text-lg dark:text-zinc-400">
            Hesaplar, kredi kartları, ekstreler, bütçe, ödeme takvimi ve borç planı. Masaüstünde, web'de ve kendi sunucunda çalışan açık
            kaynak bir uygulama.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <button className="btn-primary px-5 py-2.5" onClick={onLogin}>
              Web'de kullan
            </button>
            <button className="btn-secondary px-5 py-2.5" onClick={onRegister}>
              Hesap oluştur
            </button>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Özellikler">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="card p-4">
              <Icon size={20} className="text-indigo-500" />
              <h2 className="mt-2 text-sm font-semibold">{title}</h2>
              <p className="mt-1 text-sm text-zinc-500">{text}</p>
            </div>
          ))}
        </section>

        <section id="indir" className="scroll-mt-4 py-12" aria-labelledby="download-title">
          <h2 id="download-title" className="text-center text-2xl font-semibold tracking-tight">
            Masaüstü uygulamasını indir
          </h2>
          <p className="mt-2 text-center text-sm text-zinc-500">Verin yalnız bilgisayarında kalır; istersen hesabınla sunucuya bağlarsın.</p>

          <div className="mt-6 grid grid-cols-3 gap-2 sm:gap-3">
            {PLATFORM_ORDER.map((key) => {
              const active = open === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-expanded={active}
                  aria-controls={active ? `downloads-${key}` : undefined}
                  onClick={() => setOpen(active ? null : key)}
                  className={`flex flex-col items-center gap-2 rounded-2xl border px-2 py-4 transition sm:flex-row sm:justify-center sm:gap-3 sm:py-5 ${
                    active
                      ? "border-indigo-400 bg-white shadow-sm dark:border-indigo-500/60 dark:bg-zinc-900"
                      : "border-zinc-200 hover:border-zinc-300 hover:bg-white dark:border-zinc-800 dark:hover:bg-zinc-900"
                  }`}
                >
                  <span className="grid h-11 w-11 place-items-center rounded-xl border border-zinc-200 dark:border-zinc-700">
                    <PlatformIcon platform={key} />
                  </span>
                  <span className="text-sm font-semibold sm:text-lg">{PLATFORMS[key].name}</span>
                  <ChevronDown size={16} className={`text-zinc-400 transition ${active ? "rotate-180" : ""}`} aria-hidden />
                </button>
              );
            })}
          </div>

          {open && <DownloadPanel platform={open} />}
        </section>
      </main>

      <footer className="border-t border-zinc-200 py-6 text-center text-xs text-zinc-500 dark:border-zinc-800">
        MIT lisanslı açık kaynak ·{" "}
        <a className="hover:underline" href={REPO_URL} target="_blank" rel="noopener noreferrer">
          GitHub
        </a>{" "}
        ·{" "}
        <a className="hover:underline" href={`${REPO_URL}#self-host`} target="_blank" rel="noopener noreferrer">
          Kendi sunucunu kur
        </a>
      </footer>
    </div>
  );
}

function DownloadPanel({ platform }: { platform: PlatformKey }) {
  const p = PLATFORMS[platform];
  return (
    <div id={`downloads-${platform}`} className="card mt-3 p-5 sm:p-6" role="region" aria-label={`${p.name} indirmeleri`}>
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-xl border border-zinc-200 dark:border-zinc-700">
          <PlatformIcon platform={platform} size={24} />
        </span>
        <h3 className="text-xl font-semibold">{p.name}</h3>
      </div>
      <p className="mt-4 font-medium">{p.primary.label}</p>
      <p className="text-sm text-zinc-500">{p.primary.description}</p>
      <a className="btn-primary mt-4 w-full py-2.5 tracking-wide" href={downloadUrl(p.primary.file)}>
        <Download size={16} /> {p.name} için indir
      </a>
      <p className="mt-3 text-xs text-zinc-500">{p.note}</p>

      {p.others.length > 0 && (
        <>
          <p className="mt-6 border-b border-zinc-200 pb-2 text-[11px] font-medium uppercase tracking-[0.15em] text-zinc-500 dark:border-zinc-800">
            {p.name} için diğer dosyalar
          </p>
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {p.others.map((item) => (
              <li key={item.id}>
                <a href={downloadUrl(item.file)} className="group flex items-center gap-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{item.label}</span>
                    <span className="block text-sm text-zinc-500">{item.description}</span>
                    <span className="block truncate font-mono text-xs text-zinc-400">{item.file}</span>
                  </span>
                  <Download size={18} className="shrink-0 text-zinc-400 group-hover:text-indigo-500" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
