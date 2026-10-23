import {
  AlertTriangle,
  Database,
  DatabaseBackup,
  FilePlus2,
  FolderInput,
  RotateCcw,
  FileDown,
  FileJson,
  FileSpreadsheet,
  FileUp,
  FolderOpen,
  Keyboard,
  Monitor,
  Moon,
  Sun,
  type LucideIcon,
  Bug,
  Trash2,
  Download,
  RefreshCw,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { PageHeader } from "../components/common";
import { api, errorMessage, type DatabaseInfo } from "../lib/api";
import type { CsvParseResult } from "../lib/types";
import { CsvImportDialog } from "../components/CsvImportDialog";
import { UninstallDialog } from "../components/UninstallDialog";
import { clearErrors, getErrors } from "../lib/errorLog";
import { SAVED_HINT, openTextFile, pickDatabaseFile, pickDatabaseSavePath, revealInFolder, saveTextFile } from "../lib/fileio";
import { todayISO } from "../lib/format";
import { backend, isMac, isMobile, isTauri, modKey } from "../lib/platform";
import { ChangePasswordDialog, DeleteAccountDialog } from "../components/AccountDialogs";
import { SecuritySettings } from "../components/SecuritySettings";
import { SyncSettings } from "../components/SyncSettings";
import { lang, locale, setLang, t, type Lang } from "../lib/i18n";
import { rich } from "../lib/rich";
import { useSync } from "../state/sync";
import { downloadServerToLocal, moveLocalToServer, serverDataCount } from "../lib/transfer";
import { useAuth } from "../state/auth";
import { useData } from "../state/data";
import { useSettings, type ThemePref } from "../state/settings";
import { useUI } from "../state/ui";
import { updatesEnabled, useUpdates } from "../state/updates";
import { openReleases } from "../lib/updater";

/** Dil adları kendi dillerinde (çevrilmez) */
const LANGS: [Lang, string][] = [
  ["tr", "Türkçe"],
  ["en", "English"],
];

const SYNC_WARNING = t("Şifreli eşitleme açık: bu değişiklik eşitlenen öbür cihazlara da gider (oradaki veriler de değişir).");

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-zinc-500">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Masaüstü: kurulu sürüm ve uygulama içi güncelleme */
function UpdatesSection() {
  const { update, phase, percent, error, lastChecked, check, install } = useUpdates();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    api
      .appInfo()
      .then((i) => setVersion(i.version))
      .catch(() => {});
  }, []);
  const working = phase === "downloading" || phase === "installing";
  const status = working
    ? phase === "installing"
      ? t("Kuruluyor; uygulama yeniden başlayacak…")
      : percent === null
        ? t("İndiriliyor…")
        : t("İndiriliyor %{v}", { v: percent })
    : phase === "checking"
      ? t("Denetleniyor…")
      : update
        ? t("Finans {v} hazır.", { v: update.version })
        : lastChecked
          ? t("Güncel (son denetim {time}).", { time: lastChecked.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) })
          : t("Yeni sürümler uygulama açıkken kendiliğinden denetlenir.");
  return (
    <Section title={t("Güncellemeler")} description={version ? t("Kurulu sürüm: {v}", { v: version }) : undefined}>
      <div className="flex flex-wrap items-center gap-3">
        {update && !working ? (
          update.canInstall ? (
            <button className="btn-primary" onClick={() => void install()}>
              <Download size={16} /> {t("Güncelle ve yeniden başlat")}
            </button>
          ) : (
            <button className="btn-primary" onClick={() => void openReleases()}>
              <Download size={16} /> {t("İndirme sayfasını aç")}
            </button>
          )
        ) : (
          <button className="btn-secondary" onClick={() => void check()} disabled={phase !== "idle"}>
            <RefreshCw size={16} className={phase === "checking" ? "animate-spin" : ""} /> {t("Güncellemeleri denetle")}
          </button>
        )}
        <span className="text-xs text-zinc-500">{status}</span>
      </div>
      {update && !update.canInstall && !working && (
        <p className="mt-2 text-xs text-zinc-500">{t("Bu kurulum (taşınabilir, MSI ya da paket yöneticisi) kendini güncelleyemiyor.")}</p>
      )}
      {error && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </Section>
  );
}

function AccountRow({ email }: { email: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-zinc-100 px-3 py-2.5 text-sm dark:bg-zinc-800/60">
      <span className="min-w-0 flex-1 truncate" title={email}>
        {email}
      </span>
    </div>
  );
}

function ActionTile({
  icon: Icon,
  title,
  description,
  onClick,
  busy,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick(): void;
  busy?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="flex items-start gap-3 rounded-xl border border-zinc-200 p-4 text-left transition hover:border-indigo-300 hover:bg-indigo-50/40 disabled:opacity-50 dark:border-zinc-800 dark:hover:border-indigo-500/40 dark:hover:bg-indigo-500/5"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
        <Icon size={18} />
      </span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-zinc-500">{description}</span>
      </span>
    </button>
  );
}

const THEME_OPTIONS: { value: ThemePref; label: string; icon: LucideIcon }[] = [
  { value: "light", label: t("Açık"), icon: Sun },
  { value: "system", label: t("Sistem"), icon: Monitor },
  { value: "dark", label: t("Koyu"), icon: Moon },
];

export function SettingsPage() {
  const { categories, accounts, transactions, latest, restore, reload } = useData();
  const { settings, update } = useSettings();
  const { confirm, toast, openStatementImport, setAccountFilter, openErrorReport } = useUI();
  const [uninstalling, setUninstalling] = useState(false);
  const { user, logout, mode, serverUrl, auth, server, switchMode, connectAccount } = useAuth();
  const [accountDialog, setAccountDialog] = useState<"password" | "delete" | null>(null);
  const web = backend === "http";
  const desktop = backend === "tauri";
  const sync = useSync();
  const synced = sync.available && !!sync.info?.linked;
  // Masaüstü sunucu modunda yerel veritabanı dosyası kullanılmaz
  const localDb = !web && mode !== "server";
  // Veritabanı dosyası seçme/kopyalama ve uygulamayı kaldırma yalnız masaüstünde
  const desktopOnly = !web && !isMobile;
  const [errorCount, setErrorCount] = useState(() => getErrors().length);
  const [busy, setBusy] = useState(false);
  const [db, setDb] = useState<DatabaseInfo | null>(null);
  const location = db?.path ?? "";
  const [pendingCsv, setPendingCsv] = useState<(CsvParseResult & { name: string }) | null>(null);

  useEffect(() => {
    api.databaseInfo().then(setDb).catch(() => setDb({ path: t("Bilinmiyor"), isDefault: true }));
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const exportJson = () =>
    run(async () => {
      const json = await api.exportBackup();
      if (await saveTextFile(`finans-yedek-${todayISO()}.json`, json, { name: t("JSON Yedek"), extensions: ["json"] }))
        toast(`${t("Yedek başarıyla kaydedildi.")}${SAVED_HINT}`);
    });

  const exportCsv = () =>
    run(async () => {
      const csv = await api.exportCsv(null);
      if (await saveTextFile(`finans-islemler-${todayISO()}.csv`, csv, { name: "CSV", extensions: ["csv"] }))
        toast(`${t("{n} işlem CSV olarak dışa aktarıldı.", { n: transactions.length })}${SAVED_HINT}`);
    });

  const importJson = () =>
    run(async () => {
      const file = await openTextFile({ name: t("JSON Yedek"), extensions: ["json"] });
      if (!file) return;
      const backup = await api.parseBackup(file.contents);
      const ok = await confirm({
        title: t("Yedekten geri yükle"),
        message: (
          <>
            <p>
              {t("Mevcut verileriniz")} (<strong>{t("{n} işlem", { n: transactions.length })}</strong>,{" "}
              <strong>{t("{n} hesap", { n: accounts.length })}</strong>, <strong>{t("{n} kategori", { n: categories.length })}</strong>){" "}
              {rich(t("silinecek ve {file} dosyasındaki verilerle değiştirilecek:"), { file: <strong>{file.name}</strong> })}
            </p>
            <p className="mt-2">
              <strong>{t("{n} işlem", { n: backup.transactions.length })}</strong>, <strong>{t("{n} hesap", { n: backup.accounts.length })}</strong>,{" "}
              <strong>{t("{n} kategori", { n: backup.categories.length })}</strong>
              {backup.goals?.length ? <>, <strong>{t("{n} hedef", { n: backup.goals.length })}</strong></> : null}
              {backup.tags?.length ? <>, <strong>{t("{n} etiket", { n: backup.tags.length })}</strong></> : null}
            </p>
            {synced && <p className="mt-2 font-medium text-amber-700 dark:text-amber-300">{SYNC_WARNING}</p>}
            <p className="mt-2 text-xs text-zinc-500">
              {t(
                "İpucu: Devam etmeden önce mevcut verinin yedeğini almak isteyebilirsiniz. JSON yedek işlem belgelerini (fiş, fatura) içermez; yedekte de bulunan işlemlerin belgeleri korunur.",
              )}
            </p>
          </>
        ),
        confirmLabel: t("Geri yükle"),
        danger: true,
      });
      if (!ok) return;
      await restore({ ...backup, goals: backup.goals ?? [], tags: backup.tags ?? [] });
      // Borç planı ayarları yedekte varsa onlar da geri yüklenir (eski yedeklerde yoksa mevcutlar kalır)
      // Ayarlar yazılamazsa run() hatayı gösterir; başarı mesajı çıkmaz
      if (backup.debtPlan) await update(backup.debtPlan);
      if (backup.analysis) await update(backup.analysis);
      if (backup.categoryRules) await update({ categoryRules: backup.categoryRules });
      toast(
        backup.debtPlan || backup.analysis || backup.categoryRules
          ? t("Yedek, ayarlarıyla (borç planı, analiz, kategori kuralları) birlikte geri yüklendi.")
          : t("Yedek başarıyla geri yüklendi."),
      );
    });

  const importCsv = () =>
    run(async () => {
      const file = await openTextFile({ name: "CSV", extensions: ["csv"] });
      if (!file) return;
      const parsed = await api.parseCsv(file.contents);
      if (!parsed.rows.length) throw t("İçe aktarılacak geçerli satır bulunamadı.");
      setPendingCsv({ ...parsed, name: file.name });
    });

  const confirmCsv = (accountId: string) => {
    const pending = pendingCsv;
    setPendingCsv(null);
    if (!pending) return;
    void run(async () => {
      const merged = await api.mergeCsv(pending.rows, accountId);
      const fresh = await latest();
      await restore({
        ...fresh,
        categories: [...fresh.categories, ...merged.newCategories],
        transactions: [...fresh.transactions, ...merged.newTransactions],
      });
      const added = merged.newTransactions.length;
      const notes = [
        merged.createdCategories > 0 ? t("{n} yeni kategori", { n: merged.createdCategories }) : "",
        merged.skippedTransfers > 0 ? t("{n} transfer atlandı (hedef hesap bulunamadı)", { n: merged.skippedTransfers }) : "",
        merged.skippedFx > 0 ? t("{n} döviz/altın işlemi atlandı (miktar ya da kur yok)", { n: merged.skippedFx }) : "",
      ].filter(Boolean);
      toast(`${t("{n} işlem içe aktarıldı.", { n: added })}${notes.length ? ` ${notes.join(", ")}.` : ""}`);
    });
  };

  const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

  const afterSwitch = async (info: DatabaseInfo, message: string) => {
    setDb(info);
    setAccountFilter("all");
    await reload();
    toast(message);
  };

  const saveDbCopy = () =>
    run(async () => {
      const path = await pickDatabaseSavePath(`finans-yedek-${todayISO()}.db`);
      if (!path) return;
      await api.saveDatabaseCopy(path);
      toast(t("Veritabanı yedeği kaydedildi: {name}", { name: fileName(path) }));
    });

  const openDb = () =>
    run(async () => {
      const path = await pickDatabaseFile();
      if (!path) return;
      await afterSwitch(await api.openDatabase(path, false), t("{name} açıldı.", { name: fileName(path) }));
    });

  const newDb = () =>
    run(async () => {
      const path = await pickDatabaseSavePath("finans-yeni.db");
      if (!path) return;
      await afterSwitch(await api.openDatabase(path, true), t("Yeni veritabanı oluşturuldu: {name}", { name: fileName(path) }));
    });

  const defaultDb = () =>
    run(async () => {
      await afterSwitch(await api.useDefaultDatabase(), t("Varsayılan veritabanına dönüldü."));
    });

  const moveToServer = () =>
    run(async () => {
      if (!server) return;
      const remote = await serverDataCount(server);
      const ok = await confirm({
        title: t("Verileri sunucuya taşı"),
        message: (
          <>
            <p>
              {t("Bu cihazdaki")} <strong>{t("{n} işlem", { n: transactions.length })}</strong> {t("ve")}{" "}
              <strong>{t("{n} hesap", { n: accounts.length })}</strong>{" "}
              {t(
                "sunucuya yüklenecek; uygulama bundan sonra sunucudaki veriyle çalışacak. Bu cihazdaki veritabanı dosyası yedek olarak kalır.",
              )}
            </p>
            {remote > 0 && (
              <p className="mt-2 font-medium text-rose-600 dark:text-rose-400">
                {t("Sunucuda zaten {n} işlem var; silinip bu cihazdaki veriyle değiştirilecek.", { n: remote })}
              </p>
            )}
          </>
        ),
        confirmLabel: t("Taşı"),
        danger: remote > 0,
      });
      if (!ok) return;
      await moveLocalToServer(server);
      await switchMode("server");
    });

  const downloadToDevice = () =>
    run(async () => {
      if (!server) return;
      const ok = await confirm({
        title: t("Bu cihaza indir"),
        message: (
          <p>
            {t(
              "Sunucudaki veri bu cihaza indirilecek ve uygulama bundan sonra yerel veriyle (internetsiz) çalışacak. Bu cihazdaki eski yerel veri önce yedeklenip sunucudaki veriyle değiştirilir. Sunucudaki veri silinmez.",
            )}
          </p>
        ),
        confirmLabel: t("İndir"),
      });
      if (!ok) return;
      await downloadServerToLocal(server);
      await switchMode("local");
    });

  const resetData = () =>
    run(async () => {
      const ok = await confirm({
        title: t("Tüm verileri sıfırla"),
        message: (
          <>
            <p>
              <strong>{t("{n} işlem", { n: transactions.length })}</strong>, <strong>{t("{n} hesap", { n: accounts.length })}</strong>,{" "}
              {t("düzenli gelir/giderler, bütçeler ve özel kategoriler ile borç planı ve analiz ayarları")}{" "}
              <strong>{t("kalıcı olarak silinecek")}</strong>.{" "}
              {t('Uygulama varsayılan kategoriler ve boş bir "Genel Hesap" ile baştan başlayacak.')}
            </p>
            {synced && <p className="mt-2 font-medium text-amber-700 dark:text-amber-300">{SYNC_WARNING}</p>}
            <p className="mt-2 text-xs text-zinc-500">
              {localDb && isTauri
                ? t("Silmeden önce veri klasörüne otomatik bir yedek dosyası (finans.db.sifirlama-oncesi-…bak) kaydedilir. Tema ve para birimi ayarları korunur.")
                : t("Silmeden önce JSON yedeği almanız önerilir. Tema ayarı korunur.")}
            </p>
          </>
        ),
        confirmLabel: t("Evet, sıfırla"),
        danger: true,
      });
      if (!ok) return;
      const backupPath = await api.backupDatabase();
      // Varsayılan kategoriler ve boş "Genel Hesap" Rust'tan
      const seed = await api.resetSeed();
      await restore({
        categories: seed.categories,
        accounts: seed.accounts,
        transactions: [],
        recurring: [],
        budgets: [],
        goals: [],
        tags: [],
      });
      // Borç planı kuralları, analiz düzeltmeleri ve kategori kuralları silinen hesaplara/kategorilere bağlıydı
      await update({
        debtBudget: 0,
        debtBudgetOverrides: {},
        debtRules: {},
        debtCells: {},
        subscriptionOverrides: {},
        forecastCategoryIds: null,
        categoryRules: [],
      });
      setAccountFilter("all");
      try {
        localStorage.removeItem("finans-last-account");
      } catch {
        /* yoksay */
      }
      toast(backupPath ? t("Veriler sıfırlandı. Yedek: {name}", { name: backupPath.split(/[\\/]/).pop() ?? "" }) : t("Veriler sıfırlandı."));
    });

  return (
    <>
      {pendingCsv && (
        <CsvImportDialog
          fileName={pendingCsv.name}
          rowCount={pendingCsv.rows.length}
          skipped={pendingCsv.skipped}
          hasAccountColumn={pendingCsv.hasAccountColumn}
          accounts={accounts}
          onConfirm={confirmCsv}
          onClose={() => setPendingCsv(null)}
        />
      )}
      <PageHeader title={t("Ayarlar")} subtitle={t("Görünüm, yedekleme ve veri yönetimi")} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {web && user && (
          <Section title={t("Hesap")} description={t("Verileriniz sunucuda bu hesaba bağlı olarak saklanır.")}>
            <AccountRow email={user.email} />
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn-secondary" onClick={() => setAccountDialog("password")}>
                {t("Şifreyi değiştir")}
              </button>
              <button className="btn-secondary" onClick={() => void logout()}>
                {t("Çıkış yap")}
              </button>
              <button className="btn-ghost ml-auto text-rose-600 dark:text-rose-400" onClick={() => setAccountDialog("delete")}>
                {t("Hesabı sil…")}
              </button>
            </div>
          </Section>
        )}
        {desktop && !user && (
          <Section title={t("Hesap")} description={t("Hesapsız kullanıyorsun; veriler yalnız bu cihazda.")}>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {t(
                "Bir hesap bağlarsan verilerini istediğin zaman sunucuya taşıyıp web'den ve diğer cihazlardan kullanabilirsin. Bağlanınca bu cihazdaki veri olduğu gibi kalır.",
              )}
            </p>
            <button className="btn-primary mt-3" onClick={() => void connectAccount()} disabled={busy}>
              {t("Hesap oluştur / giriş yap")}
            </button>
          </Section>
        )}
        {desktop && user && (
          <Section title={t("Hesap")} description={serverUrl ? t("Sunucu: {url}", { url: serverUrl }) : undefined}>
            <AccountRow email={user.email} />
            <div className="mt-3 flex items-center gap-2 text-sm">
              <span className="text-zinc-500">{t("Veri yeri:")}</span>
              <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                {mode === "server" ? t("Sunucuda") : t("Bu cihazda")}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {mode === "server" ? (
                <button className="btn-secondary" onClick={downloadToDevice} disabled={busy}>
                  {t("Bu cihaza indir…")}
                </button>
              ) : (
                <button className="btn-secondary" onClick={moveToServer} disabled={busy}>
                  {t("Verilerimi sunucuya taşı…")}
                </button>
              )}
              <button className="btn-secondary" onClick={() => setAccountDialog("password")}>
                {t("Şifreyi değiştir")}
              </button>
              <button className="btn-secondary" onClick={() => void logout()} title={t("Bu cihazdaki veri silinmez")}>
                {t("Çıkış yap")}
              </button>
              <button className="btn-ghost ml-auto text-rose-600 dark:text-rose-400" onClick={() => setAccountDialog("delete")}>
                {t("Hesabı sil…")}
              </button>
            </div>
          </Section>
        )}
        {desktop && user && mode === "local" && (
          <Section title={t("Şifreli eşitleme")} description={t("Cihazların arasında uçtan uca şifreli; sunucu verini okuyamaz.")}>
            <SyncSettings />
          </Section>
        )}
        {user && auth && (
          <Section title={t("Giriş güvenliği")} description={t("İki aşamalı doğrulama ve şifresiz giriş.")}>
            <SecuritySettings auth={auth} />
          </Section>
        )}
        {desktop && mode !== "server" && <EvdsKeySection />}
        {accountDialog === "password" && auth && <ChangePasswordDialog auth={auth} onClose={() => setAccountDialog(null)} />}
        {accountDialog === "delete" && user && auth && (
          <DeleteAccountDialog
            auth={auth}
            email={user.email}
            localNote={desktop}
            onClose={() => setAccountDialog(null)}
            onBackup={exportJson}
            onDeleted={logout}
          />
        )}
        <Section title={t("Görünüm")}>
          <div className="space-y-4">
            <div>
              <span className="label">{t("Tema")}</span>
              <div className="grid grid-cols-3 gap-2">
                {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    onClick={() => update({ theme: value })}
                    aria-pressed={settings.theme === value}
                    className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
                      settings.theme === value
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                        : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60"
                    }`}
                  >
                    <Icon size={16} /> {label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="label">{t("Dil")}</span>
              <div className="grid grid-cols-2 gap-2">
                {LANGS.map(([value, label]) => (
                  <button
                    key={value}
                    lang={value}
                    onClick={() => value !== lang && setLang(value)}
                    aria-pressed={lang === value}
                    className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
                      lang === value
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                        : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Section>

        {localDb && desktopOnly && (
        <Section title={t("Veritabanı")} description={t("Tüm veriler yalnızca bu bilgisayarda, yerel bir SQLite veritabanı dosyasında saklanır.")}>
          <div className="flex items-center gap-2 rounded-lg bg-zinc-100 px-3 py-2.5 dark:bg-zinc-800/60">
            <Database size={16} className="shrink-0 text-zinc-500" />
            <code className="min-w-0 flex-1 select-text truncate text-xs" title={location}>
              {location || "…"}
            </code>
            {isTauri && (
              <button className="btn-ghost shrink-0 px-2 py-1 text-xs" onClick={() => run(() => revealInFolder(location))}>
                <FolderOpen size={14} /> {isMac ? t("Finder'da göster") : t("Klasörü aç")}
              </button>
            )}
          </div>
          {db?.fallbackFrom && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              {t(
                'Seçili veritabanı ({path}) açılışta bulunamadı veya açılamadı; şu an varsayılan veritabanı kullanılıyor. Dosyaya yeniden erişilebiliyorsa "Veritabanı aç" ile seçin, aksi halde girdiğiniz kayıtlar varsayılan veritabanına yazılır.',
                { path: db.fallbackFrom },
              )}
            </p>
          )}
          <p className="mt-2 text-xs text-zinc-500">
            {db && !db.isDefault && <span className="font-medium text-indigo-600 dark:text-indigo-400">{t("Seçili veritabanı kullanılıyor")} · </span>}
            {t("{n} işlem", { n: transactions.length })} · {t("{n} hesap", { n: accounts.length })} · {t("{n} kategori", { n: categories.length })}
          </p>
          {isTauri && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn-secondary" onClick={saveDbCopy} disabled={busy} title={t("Veritabanının tam kopyasını istediğiniz yere kaydedin")}>
                <DatabaseBackup size={16} /> {t("Yedek al")}
              </button>
              <button className="btn-secondary" onClick={openDb} disabled={busy} title={t("Başka bir Finans veritabanı dosyasıyla çalışın")}>
                <FolderInput size={16} /> {t("Veritabanı aç")}
              </button>
              <button className="btn-secondary" onClick={newDb} disabled={busy} title={t("Seçtiğiniz konumda boş bir veritabanı oluşturun")}>
                <FilePlus2 size={16} /> {t("Yeni veritabanı")}
              </button>
              {db && !db.isDefault && (
                <button className="btn-ghost" onClick={defaultDb} disabled={busy}>
                  <RotateCcw size={16} /> {t("Varsayılana dön")}
                </button>
              )}
            </div>
          )}
          {isTauri && (
            <p className="mt-2 text-xs text-zinc-500">
              {t('Yedek dosyasını "Veritabanı aç" ile açarak geri dönebilirsiniz. Seçtiğiniz veritabanı sonraki açılışlarda da kullanılır.')}
            </p>
          )}
        </Section>
        )}

        <Section
          title={t("Yedekleme ve Aktarım")}
          description={t("Verilerinizi kaybetmemek için düzenli olarak JSON yedeği almanız önerilir.")}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ActionTile icon={FileJson} title={t("JSON Yedeği Al")} description={t("Tüm işlemleri, hesapları, kategorileri ve borç planı ayarlarını tek dosyaya kaydet.")} onClick={exportJson} busy={busy} />
            <ActionTile icon={FileUp} title={t("JSON Yedekten Geri Yükle")} description={t("Mevcut verinin yerine yedeği yükle.")} onClick={importJson} busy={busy} />
            <ActionTile icon={FileSpreadsheet} title={t("CSV Dışa Aktar")} description={t("İşlemleri Excel / Numbers için dışa aktar.")} onClick={exportCsv} busy={busy} />
            <ActionTile
              icon={FileUp}
              title={t("Banka / Kart Ekstresi İçe Aktar")}
              description={t("Excel, PDF veya CSV ekstreyi hesaba aktar, kategorileri otomatik öner.")}
              onClick={() => openStatementImport()}
              busy={busy}
            />
            <ActionTile
              icon={FileDown}
              title={t("Finans CSV'sini İçe Aktar")}
              description={t("Bu uygulamadan dışa aktarılan CSV'yi geri ekler. Banka ekstresi için üstteki ekstre aktarımını kullanın.")}
              onClick={importCsv}
              busy={busy}
            />
          </div>
        </Section>

        {/* Web'de tarayıcı ⌘N/⌘1–9 gibi kısayolları kendisi kullanır; mobilde klavye yok */}
        {!isMobile && !web && (
        <Section title={t("Klavye Kısayolları")}>
          <ul className="space-y-2 text-sm">
            {[
              [`${modKey} N`, t("Yeni işlem")],
              [`${modKey} 1 – 8`, t("Sayfalar arasında geçiş")],
              [`${modKey} B`, t("Menüyü daralt / genişlet")],
              ["Esc", t("Pencereyi / formu kapat")],
              ["Enter", t("Formu kaydet")],
              [isMac ? "⌘ Q" : "Alt F4", t("Uygulamadan çık")],
            ].map(([k, label]) => (
              <li key={k} className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-zinc-600 dark:text-zinc-300">
                  <Keyboard size={14} className="text-zinc-400" /> {label}
                </span>
                <kbd className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs font-medium dark:border-zinc-700 dark:bg-zinc-800">
                  {k}
                </kbd>
              </li>
            ))}
          </ul>
        </Section>
        )}

        {updatesEnabled && <UpdatesSection />}

        <Section title={t("Destek")} description={t("Bir sorunla karşılaştığında hatayı rapor olarak kopyalayıp geliştiriciye iletebilirsin.")}>
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-secondary" onClick={openErrorReport}>
              <Bug size={16} /> {t("Hata bildir")}
            </button>
            <span className="text-xs text-zinc-500">
              {errorCount > 0 ? t("Kayıtlı {n} hata var.", { n: errorCount }) : t("Kayıtlı hata yok.")} {t("Rapora finansal verilerin eklenmez.")}
            </span>
            {errorCount > 0 && (
              <button
                className="btn-ghost px-2 py-1 text-xs"
                onClick={() => {
                  clearErrors();
                  setErrorCount(0);
                }}
              >
                {t("Hata kaydını temizle")}
              </button>
            )}
          </div>
        </Section>

        <section className="card border-rose-200 p-5 xl:col-span-2 dark:border-rose-900/60">
          <div className="flex flex-wrap items-center gap-4">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400">
              <AlertTriangle size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">{t("Verileri Sıfırla")}</h2>
              <p className="mt-0.5 text-sm text-zinc-500">
                {t("Tüm işlemleri, hesapları, bütçeleri ve düzenli kayıtları siler; uygulamayı ilk kurulum haline döndürür.")}{" "}
                {localDb && isTauri ? t("Silmeden önce otomatik yedek alınır.") : t("Silmeden önce JSON yedeği almanız önerilir.")}
              </p>
            </div>
            <button className="btn-danger" onClick={resetData} disabled={busy}>
              {t("Verileri sıfırla")}
            </button>
          </div>
        </section>

        {desktopOnly && (
        <section className="card border-rose-200 p-5 xl:col-span-2 dark:border-rose-900/60">
          <div className="flex flex-wrap items-center gap-4">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400">
              <Trash2 size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">{t("Uygulamayı Kaldır")}</h2>
              <p className="mt-0.5 text-sm text-zinc-500">
                {t("Finans'ı ve bu bilgisayardaki tüm verisini (veritabanı, otomatik yedekler, ayarlar, önbellekler) iz bırakmadan siler.")}
              </p>
            </div>
            <button className="btn-danger" onClick={() => setUninstalling(true)} disabled={busy}>
              {t("Kaldır…")}
            </button>
          </div>
        </section>
        )}
        {uninstalling && <UninstallDialog onClose={() => setUninstalling(false)} onBackup={exportJson} />}
      </div>
    </>
  );
}

/** Masaüstü yerel mod: TÜFE için EVDS anahtarı (yalnız bu cihazın ayar dosyasında; anahtarın kendisi geri okunmaz). */
function EvdsKeySection() {
  const [set, setSet] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api.evdsKeySet().then(setSet, () => setSet(false));
  }, []);
  const save = async (value: string | null) => {
    setMsg(null);
    try {
      await api.setEvdsKey(value);
      setSet(value !== null);
      setKey("");
      setMsg(value ? t("Anahtar kaydedildi.") : t("Anahtar silindi."));
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };
  // Adres cümlenin ortasında; dile göre yeri değişir
  const evdsHint = t("Anahtar ücretsizdir: {site} adresinde üye olun, Profil → API Anahtarı.").split("{site}");
  return (
    <Section
      title={t("Enflasyon verisi (TÜFE)")}
      description={t("Kâr/Zarar sayfasında enflasyon karşılaştırması için TCMB EVDS API anahtarı. Anahtar yalnız bu cihazda saklanır.")}
    >
      <p className="text-sm text-zinc-600 dark:text-zinc-300">
        {t("Durum:")} {set === null ? "…" : set ? t("anahtar girildi") : t("anahtar yok")}
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        {evdsHint[0]}
        <span className="select-all font-medium">evds3.tcmb.gov.tr</span>
        {evdsHint[1]}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input className="input max-w-xs" placeholder={t("API anahtarı")} value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn-primary" disabled={!key.trim()} onClick={() => void save(key.trim())}>
          {t("Kaydet")}
        </button>
        {set && (
          <button className="btn-secondary" onClick={() => void save(null)}>
            {t("Sil")}
          </button>
        )}
      </div>
      {msg && <p className="mt-2 text-xs text-zinc-500">{msg}</p>}
    </Section>
  );
}
