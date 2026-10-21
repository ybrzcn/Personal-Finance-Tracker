import { tauriApi, type Api, type DataSet } from "./api";
import { APP_SETTING_KEYS, type AppDataSettings } from "./types";

async function readAll(source: Api): Promise<{ data: DataSet; settings: Partial<AppDataSettings> }> {
  const [categories, accounts, transactions, recurring, budgets, goals, tags, settings] = await Promise.all([
    source.listCategories(),
    source.listAccounts(),
    source.listTransactions(),
    source.listRecurring(),
    source.listBudgets(),
    source.listGoals(),
    source.listTags(),
    source.getSettings(),
  ]);
  return { data: { categories, accounts, transactions, recurring, budgets, goals, tags }, settings };
}

async function writeAll(target: Api, { data, settings }: Awaited<ReturnType<typeof readAll>>) {
  await target.restore(data);
  for (const key of APP_SETTING_KEYS) {
    if (settings[key] !== undefined) await target.setSetting(key, settings[key] as never);
  }
}

/** Sunucudaki işlem sayısı (üzerine yazmadan önce uyarmak için; yeni hesapta varsayılan hesap sayılmaz). */
export async function serverDataCount(server: Api): Promise<number> {
  return (await server.listTransactions()).length;
}

/** Bu cihazdaki işlem sayısı. */
export async function localDataCount(): Promise<number> {
  return (await tauriApi.listTransactions()).length;
}

/** Yerel veriyi (ayarlarla) sunucudakinin yerine yazar. Yerel dosya değişmez. */
export async function moveLocalToServer(server: Api): Promise<{ transactions: number }> {
  const all = await readAll(tauriApi);
  await writeAll(server, all);
  return { transactions: all.data.transactions.length };
}

/** Sunucudaki veriyi bu cihaza indirir; önce yerel veritabanının yedeği alınır. */
export async function downloadServerToLocal(server: Api): Promise<{ backupPath: string | null; transactions: number }> {
  const all = await readAll(server);
  const backupPath = await tauriApi.backupDatabase();
  await writeAll(tauriApi, all);
  return { backupPath, transactions: all.data.transactions.length };
}
