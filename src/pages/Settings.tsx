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
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { PageHeader } from "../components/common";
import { makeDefaultAccount } from "../lib/accounts";
import { api, DEFAULT_CATEGORIES, errorMessage, type DatabaseInfo } from "../lib/api";
import { createBackup, mergeCsvRows, parseBackup } from "../lib/backup";
import { CsvImportDialog } from "../components/CsvImportDialog";
import { UninstallDialog } from "../components/UninstallDialog";
import { clearErrors, getErrors } from "../lib/errorLog";
import { parseTransactionsCsv, transactionsToCsv, type CsvParseResult } from "../lib/csv";
import { SAVED_HINT, openTextFile, pickDatabaseFile, pickDatabaseSavePath, revealInFolder, saveTextFile } from "../lib/fileio";
import { newId } from "../lib/id";
import { todayISO } from "../lib/format";
import { backend, isMac, isMobile, isTauri, modKey } from "../lib/platform";
import { ChangePasswordDialog, DeleteAccountDialog } from "../components/AccountDialogs";
import { downloadServerToLocal, moveLocalToServer, serverDataCount } from "../lib/transfer";
import { useAuth } from "../state/auth";
import { useData } from "../state/data";
import { useSettings, type ThemePref } from "../state/settings";
import { useUI } from "../state/ui";

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-zinc-500">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
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
  { value: "light", label: "Açık", icon: Sun },
  { value: "system", label: "Sistem", icon: Monitor },
  { value: "dark", label: "Koyu", icon: Moon },
];

export function SettingsPage() {
  const { categories, accounts, transactions, categoryById, accountById, snapshot, latest, restore, reload } = useData();
  const { settings, update } = useSettings();
  const { confirm, toast, openStatementImport, setAccountFilter, openErrorReport } = useUI();
  const [uninstalling, setUninstalling] = useState(false);
  const { user, logout, mode, serverUrl, auth, server, switchMode, connectAccount } = useAuth();
  const [accountDialog, setAccountDialog] = useState<"password" | "delete" | null>(null);
  const web = backend === "http";
  const desktop = backend === "tauri";
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
    api.databaseInfo().then(setDb).catch(() => setDb({ path: "Bilinmiyor", isDefault: true }));
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
      const { debtBudget, debtBudgetOverrides, debtRules, debtCells, subscriptionOverrides, forecastCategoryIds } = settings;
      const json = JSON.stringify(
        createBackup(snapshot(), { debtBudget, debtBudgetOverrides, debtRules, debtCells }, { subscriptionOverrides, forecastCategoryIds }),
        null,
        2,
      );
      if (await saveTextFile(`finans-yedek-${todayISO()}.json`, json, { name: "JSON Yedek", extensions: ["json"] }))
        toast(`Yedek başarıyla kaydedildi.${SAVED_HINT}`);
    });

  const exportCsv = () =>
    run(async () => {
      const csv = transactionsToCsv(transactions, categoryById, accountById);
      if (await saveTextFile(`finans-islemler-${todayISO()}.csv`, csv, { name: "CSV", extensions: ["csv"] }))
        toast(`${transactions.length} işlem CSV olarak dışa aktarıldı.${SAVED_HINT}`);
    });

  const importJson = () =>
    run(async () => {
      const file = await openTextFile({ name: "JSON Yedek", extensions: ["json"] });
      if (!file) return;
      const backup = parseBackup(file.contents);
      const ok = await confirm({
        title: "Yedekten geri yükle",
        message: (
          <>
            <p>
              Mevcut verileriniz (<strong>{transactions.length} işlem</strong>, <strong>{accounts.length} hesap</strong>,{" "}
              <strong>{categories.length} kategori</strong>) silinecek ve <strong>{file.name}</strong> dosyasındaki verilerle değiştirilecek:
            </p>
            <p className="mt-2">
              <strong>{backup.transactions.length} işlem</strong>, <strong>{backup.accounts.length} hesap</strong>,{" "}
              <strong>{backup.categories.length} kategori</strong>
            </p>
            <p className="mt-2 text-xs text-zinc-500">İpucu: Devam etmeden önce mevcut verinin yedeğini almak isteyebilirsiniz.</p>
          </>
        ),
        confirmLabel: "Geri yükle",
        danger: true,
      });
      if (!ok) return;
      await restore(backup);
      // Borç planı ayarları yedekte varsa onlar da geri yüklenir (eski yedeklerde yoksa mevcutlar kalır)
      // Ayarlar yazılamazsa run() hatayı gösterir; başarı mesajı çıkmaz
      if (backup.debtPlan) await update(backup.debtPlan);
      if (backup.analysis) await update(backup.analysis);
      toast(backup.debtPlan || backup.analysis ? "Yedek, ayarlarıyla (borç planı, analiz) birlikte geri yüklendi." : "Yedek başarıyla geri yüklendi.");
    });

  const importCsv = () =>
    run(async () => {
      const file = await openTextFile({ name: "CSV", extensions: ["csv"] });
      if (!file) return;
      const parsed = parseTransactionsCsv(file.contents);
      if (!parsed.rows.length) throw "İçe aktarılacak geçerli satır bulunamadı.";
      setPendingCsv({ ...parsed, name: file.name });
    });

  const confirmCsv = (accountId: string) => {
    const pending = pendingCsv;
    setPendingCsv(null);
    if (!pending) return;
    void run(async () => {
      const fresh = await latest();
      const merged = mergeCsvRows(pending.rows, fresh, accountId);
      await restore({ ...fresh, categories: merged.categories, transactions: merged.transactions });
      const added = merged.transactions.length - fresh.transactions.length;
      const notes = [
        merged.createdCategories > 0 ? `${merged.createdCategories} yeni kategori` : "",
        merged.skippedTransfers > 0 ? `${merged.skippedTransfers} transfer atlandı (hedef hesap bulunamadı)` : "",
      ].filter(Boolean);
      toast(`${added} işlem içe aktarıldı.${notes.length ? ` ${notes.join(", ")}.` : ""}`);
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
      toast(`Veritabanı yedeği kaydedildi: ${fileName(path)}`);
    });

  const openDb = () =>
    run(async () => {
      const path = await pickDatabaseFile();
      if (!path) return;
      await afterSwitch(await api.openDatabase(path, false), `${fileName(path)} açıldı.`);
    });

  const newDb = () =>
    run(async () => {
      const path = await pickDatabaseSavePath("finans-yeni.db");
      if (!path) return;
      await afterSwitch(await api.openDatabase(path, true), `Yeni veritabanı oluşturuldu: ${fileName(path)}`);
    });

  const defaultDb = () =>
    run(async () => {
      await afterSwitch(await api.useDefaultDatabase(), "Varsayılan veritabanına dönüldü.");
    });

  const moveToServer = () =>
    run(async () => {
      if (!server) return;
      const remote = await serverDataCount(server);
      const ok = await confirm({
        title: "Verileri sunucuya taşı",
        message: (
          <>
            <p>
              Bu cihazdaki <strong>{transactions.length} işlem</strong> ve <strong>{accounts.length} hesap</strong> sunucuya yüklenecek; uygulama
              bundan sonra sunucudaki veriyle çalışacak. Bu cihazdaki veritabanı dosyası yedek olarak kalır.
            </p>
            {remote > 0 && (
              <p className="mt-2 font-medium text-rose-600 dark:text-rose-400">Sunucuda zaten {remote} işlem var; silinip bu cihazdaki veriyle değiştirilecek.</p>
            )}
          </>
        ),
        confirmLabel: "Taşı",
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
        title: "Bu cihaza indir",
        message: (
          <p>
            Sunucudaki veri bu cihaza indirilecek ve uygulama bundan sonra yerel veriyle (internetsiz) çalışacak. Bu cihazdaki eski yerel veri önce
            yedeklenip sunucudaki veriyle değiştirilir. Sunucudaki veri silinmez.
          </p>
        ),
        confirmLabel: "İndir",
      });
      if (!ok) return;
      await downloadServerToLocal(server);
      await switchMode("local");
    });

  const resetData = () =>
    run(async () => {
      const ok = await confirm({
        title: "Tüm verileri sıfırla",
        message: (
          <>
            <p>
              <strong>{transactions.length} işlem</strong>, <strong>{accounts.length} hesap</strong>, düzenli gelir/giderler, bütçeler ve
              özel kategoriler ile borç planı ve analiz ayarları <strong>kalıcı olarak silinecek</strong>. Uygulama varsayılan kategoriler ve boş bir "Genel Hesap" ile baştan
              başlayacak.
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              {localDb && isTauri
                ? "Silmeden önce veri klasörüne otomatik bir yedek dosyası (finans.db.sifirlama-oncesi-…bak) kaydedilir. Tema ve para birimi ayarları korunur."
                : "Silmeden önce JSON yedeği almanız önerilir. Tema ayarı korunur."}
            </p>
          </>
        ),
        confirmLabel: "Evet, sıfırla",
        danger: true,
      });
      if (!ok) return;
      const backupPath = await api.backupDatabase();
      await restore({
        categories: DEFAULT_CATEGORIES.map((c) => ({ ...c, id: newId() })),
        accounts: [makeDefaultAccount(todayISO())],
        transactions: [],
        recurring: [],
        budgets: [],
      });
      // Borç planı kuralları ve analiz düzeltmeleri silinen hesaplara/kategorilere bağlıydı
      await update({
        debtBudget: 0,
        debtBudgetOverrides: {},
        debtRules: {},
        debtCells: {},
        subscriptionOverrides: {},
        forecastCategoryIds: null,
      });
      setAccountFilter("all");
      try {
        localStorage.removeItem("finans-last-account");
      } catch {
        /* yoksay */
      }
      toast(backupPath ? `Veriler sıfırlandı. Yedek: ${backupPath.split(/[\\/]/).pop()}` : "Veriler sıfırlandı.");
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
      <PageHeader title="Ayarlar" subtitle="Görünüm, yedekleme ve veri yönetimi" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {web && user && (
          <Section title="Hesap" description="Verileriniz sunucuda bu hesaba bağlı olarak saklanır.">
            <AccountRow email={user.email} />
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn-secondary" onClick={() => setAccountDialog("password")}>
                Şifreyi değiştir
              </button>
              <button className="btn-secondary" onClick={() => void logout()}>
                Çıkış yap
              </button>
              <button className="btn-ghost ml-auto text-rose-600 dark:text-rose-400" onClick={() => setAccountDialog("delete")}>
                Hesabı sil…
              </button>
            </div>
          </Section>
        )}
        {desktop && !user && (
          <Section title="Hesap" description="Hesapsız kullanıyorsun; veriler yalnız bu cihazda.">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Bir hesap bağlarsan verilerini istediğin zaman sunucuya taşıyıp web'den ve diğer cihazlardan kullanabilirsin. Bağlanınca bu cihazdaki
              veri olduğu gibi kalır.
            </p>
            <button className="btn-primary mt-3" onClick={() => void connectAccount()} disabled={busy}>
              Hesap oluştur / giriş yap
            </button>
          </Section>
        )}
        {desktop && user && (
          <Section title="Hesap" description={serverUrl ? `Sunucu: ${serverUrl}` : undefined}>
            <AccountRow email={user.email} />
            <div className="mt-3 flex items-center gap-2 text-sm">
              <span className="text-zinc-500">Veri yeri:</span>
              <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                {mode === "server" ? "Sunucuda" : "Bu cihazda"}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {mode === "server" ? (
                <button className="btn-secondary" onClick={downloadToDevice} disabled={busy}>
                  Bu cihaza indir…
                </button>
              ) : (
                <button className="btn-secondary" onClick={moveToServer} disabled={busy}>
                  Verilerimi sunucuya taşı…
                </button>
              )}
              <button className="btn-secondary" onClick={() => setAccountDialog("password")}>
                Şifreyi değiştir
              </button>
              <button className="btn-secondary" onClick={() => void logout()} title="Bu cihazdaki veri silinmez">
                Çıkış yap
              </button>
              <button className="btn-ghost ml-auto text-rose-600 dark:text-rose-400" onClick={() => setAccountDialog("delete")}>
                Hesabı sil…
              </button>
            </div>
          </Section>
        )}
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
        <Section title="Görünüm">
          <div className="space-y-4">
            <div>
              <span className="label">Tema</span>
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
          </div>
        </Section>

        {localDb && desktopOnly && (
        <Section title="Veritabanı" description="Tüm veriler yalnızca bu bilgisayarda, yerel bir SQLite veritabanı dosyasında saklanır.">
          <div className="flex items-center gap-2 rounded-lg bg-zinc-100 px-3 py-2.5 dark:bg-zinc-800/60">
            <Database size={16} className="shrink-0 text-zinc-500" />
            <code className="min-w-0 flex-1 select-text truncate text-xs" title={location}>
              {location || "…"}
            </code>
            {isTauri && (
              <button className="btn-ghost shrink-0 px-2 py-1 text-xs" onClick={() => run(() => revealInFolder(location))}>
                <FolderOpen size={14} /> {isMac ? "Finder'da göster" : "Klasörü aç"}
              </button>
            )}
          </div>
          {db?.fallbackFrom && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              Seçili veritabanı ({db.fallbackFrom}) açılışta bulunamadı veya açılamadı; şu an varsayılan veritabanı kullanılıyor.
              Dosyaya yeniden erişilebiliyorsa "Veritabanı aç" ile seçin, aksi halde girdiğiniz kayıtlar varsayılan veritabanına
              yazılır.
            </p>
          )}
          <p className="mt-2 text-xs text-zinc-500">
            {db && !db.isDefault && <span className="font-medium text-indigo-600 dark:text-indigo-400">Seçili veritabanı kullanılıyor · </span>}
            {transactions.length} işlem · {accounts.length} hesap · {categories.length} kategori
          </p>
          {isTauri && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn-secondary" onClick={saveDbCopy} disabled={busy} title="Veritabanının tam kopyasını istediğiniz yere kaydedin">
                <DatabaseBackup size={16} /> Yedek al
              </button>
              <button className="btn-secondary" onClick={openDb} disabled={busy} title="Başka bir Finans veritabanı dosyasıyla çalışın">
                <FolderInput size={16} /> Veritabanı aç
              </button>
              <button className="btn-secondary" onClick={newDb} disabled={busy} title="Seçtiğiniz konumda boş bir veritabanı oluşturun">
                <FilePlus2 size={16} /> Yeni veritabanı
              </button>
              {db && !db.isDefault && (
                <button className="btn-ghost" onClick={defaultDb} disabled={busy}>
                  <RotateCcw size={16} /> Varsayılana dön
                </button>
              )}
            </div>
          )}
          {isTauri && (
            <p className="mt-2 text-xs text-zinc-500">
              Yedek dosyasını "Veritabanı aç" ile açarak geri dönebilirsiniz. Seçtiğiniz veritabanı sonraki açılışlarda da kullanılır.
            </p>
          )}
        </Section>
        )}

        <Section
          title="Yedekleme ve Aktarım"
          description="Verilerinizi kaybetmemek için düzenli olarak JSON yedeği almanız önerilir."
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ActionTile icon={FileJson} title="JSON Yedeği Al" description="Tüm işlemleri, hesapları, kategorileri ve borç planı ayarlarını tek dosyaya kaydet." onClick={exportJson} busy={busy} />
            <ActionTile icon={FileUp} title="JSON Yedekten Geri Yükle" description="Mevcut verinin yerine yedeği yükle." onClick={importJson} busy={busy} />
            <ActionTile icon={FileSpreadsheet} title="CSV Dışa Aktar" description="İşlemleri Excel / Numbers için dışa aktar." onClick={exportCsv} busy={busy} />
            <ActionTile
              icon={FileUp}
              title="Banka / Kart Ekstresi İçe Aktar"
              description="Excel, PDF veya CSV ekstreyi hesaba aktar, kategorileri otomatik öner."
              onClick={() => openStatementImport()}
              busy={busy}
            />
            <ActionTile
              icon={FileDown}
              title="Finans CSV'sini İçe Aktar"
              description="Bu uygulamadan dışa aktarılan CSV'yi geri ekler. Banka ekstresi için üstteki ekstre aktarımını kullanın."
              onClick={importCsv}
              busy={busy}
            />
          </div>
        </Section>

        {/* Web'de tarayıcı ⌘N/⌘1–9 gibi kısayolları kendisi kullanır; mobilde klavye yok */}
        {!isMobile && !web && (
        <Section title="Klavye Kısayolları">
          <ul className="space-y-2 text-sm">
            {[
              [`${modKey} N`, "Yeni işlem"],
              [`${modKey} 1 – 8`, "Sayfalar arasında geçiş"],
              [`${modKey} B`, "Menüyü daralt / genişlet"],
              ["Esc", "Pencereyi / formu kapat"],
              ["Enter", "Formu kaydet"],
              [isMac ? "⌘ Q" : "Alt F4", "Uygulamadan çık"],
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

        <Section title="Destek" description="Bir sorunla karşılaştığında hatayı rapor olarak kopyalayıp geliştiriciye iletebilirsin.">
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-secondary" onClick={openErrorReport}>
              <Bug size={16} /> Hata bildir
            </button>
            <span className="text-xs text-zinc-500">
              {errorCount > 0 ? `Kayıtlı ${errorCount} hata var.` : "Kayıtlı hata yok."} Rapora finansal verilerin eklenmez.
            </span>
            {errorCount > 0 && (
              <button
                className="btn-ghost px-2 py-1 text-xs"
                onClick={() => {
                  clearErrors();
                  setErrorCount(0);
                }}
              >
                Hata kaydını temizle
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
              <h2 className="text-sm font-semibold">Verileri Sıfırla</h2>
              <p className="mt-0.5 text-sm text-zinc-500">
                Tüm işlemleri, hesapları, bütçeleri ve düzenli kayıtları siler; uygulamayı ilk kurulum haline döndürür.{" "}
                {localDb && isTauri ? "Silmeden önce otomatik yedek alınır." : "Silmeden önce JSON yedeği almanız önerilir."}
              </p>
            </div>
            <button className="btn-danger" onClick={resetData} disabled={busy}>
              Verileri sıfırla
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
              <h2 className="text-sm font-semibold">Uygulamayı Kaldır</h2>
              <p className="mt-0.5 text-sm text-zinc-500">
                Finans'ı ve bu bilgisayardaki tüm verisini (veritabanı, otomatik yedekler, ayarlar, önbellekler) iz bırakmadan siler.
              </p>
            </div>
            <button className="btn-danger" onClick={() => setUninstalling(true)} disabled={busy}>
              Kaldır…
            </button>
          </div>
        </section>
        )}
        {uninstalling && <UninstallDialog onClose={() => setUninstalling(false)} onBackup={exportJson} />}
      </div>
    </>
  );
}
