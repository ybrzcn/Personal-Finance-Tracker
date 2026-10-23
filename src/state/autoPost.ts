import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { t, tm } from "../lib/i18n";
import { useData } from "./data";
import { useToday } from "./today";
import { useUI } from "./ui";

/**
 * Otomatik kaydı açık düzenli kayıtların günü gelmiş ödemelerini işleme çevirir (Rust): açılışta, gün dönünce ve
 * kayıtlar değişince. Eklenen olursa işlemler yeniden okunur ve bildirilir. Eklenemeyen kayıt (hesap arşivli vb.)
 * oturumda bir kez bildirilir; ödemesi bekler ve sonraki çalışmalarda yeniden denenir. Ağ hatası sessiz.
 */
export function useAutoPost() {
  const { loading, recurring, reloadTransactions } = useData();
  const { toast } = useUI();
  const day = useToday();
  const running = useRef(false);
  // Çalışırken gelen değişiklik kaybolmasın: bitince bir kez daha
  const again = useRef(false);
  const [rerun, setRerun] = useState(0);
  const warned = useRef(new Set<string>());
  // Otomatik kayıtlı kayıtlar değişince (yeni açılan, düzenlenen) yeniden denenir
  const key = recurring
    .filter((r) => r.autoPost && r.active)
    .map((r) => `${r.id}:${r.day}:${r.accountId}:${r.weekendShift}:${r.startDate}`)
    .join(",");

  useEffect(() => {
    if (loading || !key) return;
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    api
      .autoPostRecurring()
      .then(async ({ created, failed }) => {
        if (created.length) {
          await reloadTransactions();
          toast(created.length === 1 ? t("{name} otomatik kaydedildi.", { name: created[0].description }) : t("{n} düzenli kayıt otomatik kaydedildi.", { n: created.length }));
        }
        for (const f of failed) {
          const k = `${f.recurringId}:${f.error}`;
          if (warned.current.has(k)) continue;
          warned.current.add(k);
          toast(t("{name} otomatik kaydedilemedi: {error}", { name: f.name, error: tm(f.error) }), "error");
        }
      })
      .catch(() => {})
      .finally(() => {
        running.current = false;
        if (again.current) {
          again.current = false;
          setRerun((n) => n + 1);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, key, day, rerun]);
}
