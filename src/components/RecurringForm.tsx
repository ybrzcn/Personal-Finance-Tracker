import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, errorMessage } from "../lib/api";
import { amountToInput, decimalToInput, formatDate, formatDateShort, formatMonthYear, parseAmount, parseQuantity, todayISO, ZERO_AMOUNT } from "../lib/format";
import { isForeign, isFund, qtyDecimals, qtyRule, unitOf } from "../lib/fx";
import { t } from "../lib/i18n";
import type { AmountChange, CategoryType, MonthException, RecurringDraft, RecurringItem, RecurringPreview, WeekendShift } from "../lib/types";
import { useSettings } from "../state/settings";
import { useData } from "../state/data";
import { useFormPreview } from "../state/formPreview";
import { useRates } from "../state/rates";
import { useUI } from "../state/ui";
import { MoneyInput } from "./common";
import { Modal } from "./Modal";

interface Props {
  item?: RecurringItem;
  defaultType?: CategoryType;
  onClose(): void;
  onSaved(message: string): void;
}

export function RecurringForm({ item, defaultType = "income", onClose, onSaved }: Props) {
  const { accounts, categories, addRecurring, updateRecurring, deleteRecurring } = useData();
  const { confirm } = useUI();
  const [type, setType] = useState<CategoryType>(item?.type ?? defaultType);
  const [name, setName] = useState(item?.name ?? (defaultType === "income" ? "Maaş" : ""));
  const today = todayISO();
  const [history, setHistory] = useState<AmountChange[]>(item?.history ?? []);
  // Tutar alanı, kullanıcı dokunmadıysa Rust'tan gelen bugünkü tutarla (düzenlenen geçmişe göre) dolar. Geçmişi olmayan kayıtta
  // bugünkü tutar kayıtlı tutarın kendisidir; geçmişi olanda önizleme gelene kadar boş
  const [amount, setAmount] = useState(item && !item.history?.length ? amountToInput(item.amount) : "");
  const amountTouched = useRef(false);
  // Düzenlemede tutar değişirse: belirli tarihten itibaren mi, yoksa tüm aylar için düzeltme mi?
  const [changeMode, setChangeMode] = useState<"from" | "all">("from");
  // Varsayılan (Rust): bu ayın yatışı geçtiyse değişiklik gelecek aydan başlar
  const [changeFrom, setChangeFrom] = useState(item ? "" : today);
  const changeFromTouched = useRef(false);
  const { formatMoney } = useSettings();
  const [exceptions, setExceptions] = useState<MonthException[]>(item?.exceptions ?? []);
  const [exMonth, setExMonth] = useState(today.slice(0, 7));
  const [exAmount, setExAmount] = useState("");
  const [exNote, setExNote] = useState("");
  // İstisna alanlarına bir şey girildi ama "Ekle"ye basılmadıysa Kaydet onu da kaydeder
  const [exDirty, setExDirty] = useState(false);
  const monthOptions = useMemo(() => {
    const base = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 1);
    return Array.from({ length: 37 }, (_, i) => {
      const d = new Date(base.getFullYear(), base.getMonth() - 12 + i, 1);
      return { value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: formatMonthYear(d) };
    });
  }, [today]);
  const monthLabel = (m: string) => formatMonthYear(new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1));
  /** Taslak istisnayı listeye uygular; geçersizse null döner. */
  const withDraft = (list: MonthException[]): MonthException[] | null => {
    // Boş tutar sessizce "o ay yok" (0) sayılmasın
    const v = exAmount.trim() ? parseAmount(exAmount) : null;
    if (v === null || v < 0) {
      setError(t("Bu ayki tutarı yazın (o ay hiç yoksa 0)."));
      return null;
    }
    return [...list.filter((x) => x.month !== exMonth), { month: exMonth, amount: v, note: exNote.trim() }].sort((a, b) =>
      a.month.localeCompare(b.month),
    );
  };
  const addException = () => {
    const next = withDraft(exceptions);
    if (!next) return;
    setError(null);
    setExceptions(next);
    setExNote("");
    setExDirty(false);
  };
  const exKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addException();
    }
  };
  const draft = (fn: () => void) => {
    fn();
    setExDirty(true);
    setError(null);
  };
  const [day, setDay] = useState(String(item?.day ?? ""));
  // Hatalı alan: kırmızı çerçeve ve odak
  const [errorField, setErrorField] = useState<string | null>(null);
  const fail = (message: string, field: string) => {
    setError(message);
    setErrorField(field);
    requestAnimationFrame(() => document.getElementById(field)?.focus());
  };
  const bad = (field: string) => (errorField === field ? "border-rose-500 focus:border-rose-500 focus:ring-rose-500/20" : "");
  const [accountId, setAccountId] = useState(item?.accountId ?? accounts.find((a) => a.kind === "bank" && !a.archived && !isFund(a.currency) && !a.subtype)?.id ?? "");
  // Yeni maaşta kategori "Maaş" ile gelir
  const [categoryId, setCategoryId] = useState(
    item?.categoryId ?? (defaultType === "income" ? (categories.find((c) => c.type === "income" && c.name === "Maaş")?.id ?? "") : ""),
  );
  const [active, setActive] = useState(item?.active ?? true);
  const [coversPrev, setCoversPrev] = useState(item?.coversPreviousMonth ?? false);
  const [weekendShift, setWeekendShift] = useState<WeekendShift>(item?.weekendShift ?? "none");
  const [autoPost, setAutoPost] = useState(item?.autoPost ?? false);
  // Yeni kayıt bugünden başlar: uygulamanın kullanılmadığı geçmiş aylara plan yazılmaz
  const [startDate, setStartDate] = useState(item ? (item.startDate ?? "") : today);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Döviz/altın hesabında miktar kendi biriminde; TL tutarı planlar için güncel alışla tahmin edilir
  const { rates } = useRates();
  const cur = accounts.find((a) => a.id === accountId)?.currency ?? "TRY";
  const foreign = isForeign(cur);
  const unitLabel = unitOf(cur) === "currency" ? cur : unitOf(cur) === "gram" ? t("gram") : t("adet");
  const [qty, setQty] = useState(item?.origAmount != null ? decimalToInput(item.origAmount) : "");
  const qtyVal = foreign ? parseQuantity(qty, qtyDecimals(cur)) : null;
  // Miktar yazılınca TL tutarı güncel alışla (Rust) önerilir
  const qtyEdited = useRef(false);
  const onQty = (v: string) => {
    setQty(v);
    setError(null);
    qtyEdited.current = true;
  };

  const value = parseAmount(amount);
  // Önizleme hesapları Rust'ta (finans-core::forms)
  const dayNum = Number.parseInt(day, 10);
  const previewDraft: RecurringDraft = {
    item: item ? { amount: item.amount, day: item.day, weekendShift: item.weekendShift ?? "none", history } : null,
    day: Number.isNaN(dayNum) ? null : dayNum,
    weekendShift,
    currency: cur,
    qty: qtyVal,
    buyRate: rates.get(cur)?.buy ?? null,
    amount: value,
    changeMode,
    changeFrom: changeFrom || null,
  };
  const { preview, source, latest } = useFormPreview(previewDraft, api.previewRecurring);
  const currentAmount = preview?.currentAmount ?? null;
  const amountChanged = preview?.amountChanged ?? false;
  useEffect(() => {
    if (!preview) return;
    if (preview.currentAmount !== null && !amountTouched.current) setAmount(amountToInput(preview.currentAmount));
    if (preview.changeFromDefault && !changeFromTouched.current) setChangeFrom(preview.changeFromDefault);
    // Öneri, yazılan son miktarın hesabıysa tutara yazılır
    if (qtyEdited.current && preview.qtyAmount !== null && source?.qty === qtyVal) {
      qtyEdited.current = false;
      amountTouched.current = true;
      setAmount(amountToInput(preview.qtyAmount));
    }
  }, [preview, source, qtyVal]);
  // Önümüzdeki aylarda hafta sonuna denk gelip kayan tarihler (ör. 10 Eki Cumartesi → 9 Eki Cuma)
  const moves = preview?.weekendMoves ?? null;
  const weekendNote = !moves
    ? null
    : moves.length
      ? t("Önümüzdeki 6 ayda: {list}", { list: moves.map((m) => `${formatDateShort(m.from)} → ${formatDateShort(m.to)}`).join(", ") })
      : t("Önümüzdeki 6 ayda hafta sonuna denk gelen gün yok.");
  const futureChanges = useMemo(() => history.filter((h) => h.from > today), [history, today]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Miktar yazılıp öneri henüz gelmediyse tutar son miktarın hesabından; düzenlemede tutara dokunulduysa
    // tutar ve geçmiş de son girdinin hesabından (Rust)
    let val = value;
    let from = changeFrom;
    let fresh: RecurringPreview | null = null;
    // Beklerken gelen önizleme bayrağı sıfırlayabilir: kayıt başındaki hâli esas
    const pendingQty = qtyEdited.current;
    if (pendingQty || (item && amountTouched.current)) {
      try {
        const first = await latest(previewDraft);
        if (pendingQty && first.qtyAmount !== null) {
          val = first.qtyAmount;
          qtyEdited.current = false;
          amountTouched.current = true;
          setAmount(amountToInput(val));
        }
        if (!from && !changeFromTouched.current && first.changeFromDefault) {
          from = first.changeFromDefault;
          setChangeFrom(from);
        }
        if (item && amountTouched.current)
          fresh = val === value && from === changeFrom ? first : await latest({ ...previewDraft, amount: val, changeFrom: from || null });
      } catch (err) {
        setErrorField(null);
        return setError(t("Hesap yapılamadı: {error}", { error: errorMessage(err) }));
      }
    }
    const amountChanged = fresh?.amountChanged ?? false;
    const d = Number.parseInt(day, 10);
    if (!name.trim()) return fail(t("Bir ad yazın (ör. Maaş)."), "rec-name");
    if (foreign && !(qtyVal && qtyVal > 0)) return fail(t("Miktar girin ({unit}, {rule}).", { unit: unitLabel, rule: qtyRule(cur) }), "rec-qty");
    if (val === null || val <= 0) return fail(t("Geçerli bir tutar girin (ör. 62.000,00)."), "rec-amount");
    if (!(d >= 1 && d <= 31)) return fail(t("Ayın günü 1 ile 31 arasında olmalı."), "rec-day");
    if (item && amountChanged && changeMode === "from" && !from)
      return fail(t("Yeni tutarın geçerli olacağı tarihi seçin."), "rec-change-from");
    const finalExceptions = exDirty ? withDraft(exceptions) : exceptions;
    if (!finalExceptions) return;
    setSaving(true);
    setError(null);
    let amounts: Pick<RecurringItem, "amount" | "history"> = { amount: val, history: [] };
    if (item) amounts = fresh?.amounts ?? { amount: item.amount, history };
    const payload = {
      name,
      type,
      ...amounts,
      exceptions: finalExceptions,
      coversPreviousMonth: type === "income" && coversPrev,
      weekendShift,
      startDate: startDate || null,
      day: d,
      accountId: accountId || null,
      categoryId: categoryId || null,
      active,
      sortOrder: item?.sortOrder ?? 0,
      origAmount: foreign ? qtyVal : null,
      autoPost: autoPost && !!accountId,
    };
    try {
      if (item) {
        await updateRecurring({ ...payload, id: item.id });
        onSaved(t("Kayıt güncellendi."));
      } else {
        await addRecurring(payload);
        onSaved(type === "income" ? t("Düzenli gelir eklendi.") : t("Düzenli gider eklendi."));
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!item) return;
    const ok = await confirm({
      title: t("{name} silinsin mi?", { name: item.name }),
      message: t("Düzenli kayıt, tutar geçmişi ve aya özel istisnalarıyla birlikte silinir. Girilmiş işlemler silinmez."),
      confirmLabel: t("Sil"),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteRecurring(item.id);
      onSaved(t("Kayıt silindi."));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal
      title={item ? t("Düzenli Kaydı Düzenle") : type === "income" ? t("Düzenli Gelir") : t("Düzenli Gider")}
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          {item && (
            <button type="button" className="btn-ghost mr-auto text-rose-600" onClick={remove}>
              <Trash2 size={15} /> {t("Sil")}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("Vazgeç")}
          </button>
          <button type="submit" form="rec-form" className="btn-primary" disabled={saving}>
            {item ? t("Kaydet") : t("Ekle")}
          </button>
        </>
      }
    >
      <form id="rec-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800/70">
          {(["income", "expense"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setType(k);
                setCategoryId("");
              }}
              className={`rounded-lg py-1.5 text-sm font-medium transition ${
                type === k ? "bg-white shadow-sm dark:bg-zinc-900" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {k === "income" ? t("Gelir (maaş vb.)") : t("Gider (kira, fatura…)")}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="label" htmlFor="rec-name">
              {t("Ad")}
            </label>
            <input
              id="rec-name"
              data-autofocus
              className={`input ${bad("rec-name")}`}
              aria-invalid={errorField === "rec-name" || undefined}
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="rec-amount">
              {foreign ? t("Tahmini TL tutarı") : t("Tutar")}
            </label>
            <MoneyInput
              id="rec-amount"
              className={bad("rec-amount")}
              aria-invalid={errorField === "rec-amount" || undefined}
              placeholder={ZERO_AMOUNT}
              value={amount}
              onValueChange={(v) => {
                // Elle yazılan tutarı sonradan gelen miktar önerisi ezmez
                qtyEdited.current = false;
                amountTouched.current = true;
                setAmount(v);
                setError(null);
              }}
            />
          </div>
          <div>
            <label className="label" htmlFor="rec-day">
              {t("Ayın kaçında")}
            </label>
            <input
              id="rec-day"
              type="number"
              min={1}
              max={31}
              className={`input ${bad("rec-day")}`}
              aria-invalid={errorField === "rec-day" || undefined}
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="rec-weekend">
              {t("Hafta sonuna denk gelirse")}
            </label>
            <select
              id="rec-weekend"
              className="input"
              value={weekendShift}
              onChange={(e) => setWeekendShift(e.target.value as WeekendShift)}
            >
              <option value="none">{t("Aynı gün")}</option>
              <option value="before">{type === "income" ? t("Önceki Cuma (ör. maaş Cuma yatar)") : t("Önceki Cuma (Cuma ödenir)")}</option>
              <option value="after">{t("Sonraki Pazartesi")}</option>
            </select>
            {weekendShift !== "none" && weekendNote && <p className="mt-1 text-xs text-zinc-500">{weekendNote}</p>}
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="rec-start">
              {t("Başlangıç tarihi")}
            </label>
            <input id="rec-start" type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            <p className="mt-1 text-xs text-zinc-500">
              {startDate
                ? t("{date} öncesindeki aylara (bütçe, ödeme takvimi) yansımaz.", { date: formatDate(startDate) })
                : t("Boş bırakılırsa geçmiş tüm aylara uygulanır.")}
            </p>
          </div>
          <div>
            <label className="label" htmlFor="rec-account">
              {t("Hesap")}
            </label>
            <select id="rec-account" className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">—</option>
              {accounts
                // Fon hesabına düzenli gelir/gider bağlanamaz
                .filter((a) => (!a.archived || a.id === accountId) && !isFund(a.currency))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </div>
          {foreign && (
            <div>
              <label className="label" htmlFor="rec-qty">
                {t("Miktar ({unit})", { unit: unitLabel })}
              </label>
              <input
                id="rec-qty"
                className={`input tabular-nums ${bad("rec-qty")}`}
                aria-invalid={errorField === "rec-qty" || undefined}
                inputMode="decimal"
                autoComplete="off"
                value={qty}
                onChange={(e) => onQty(e.target.value)}
              />
              <p className="mt-1 text-xs text-zinc-500">{t("TL tutarı planlar için güncel alış kuruyla tahmin edilir; kayıt girilirken o günün kuru kullanılır.")}</p>
            </div>
          )}
          <div>
            <label className="label" htmlFor="rec-category">
              {t("Kategori")}
            </label>
            <select id="rec-category" className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{t("Kategorisiz")}</option>
              {categories
                .filter((c) => c.type === type)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        {item && amountChanged && (
          <section className="space-y-2 rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 dark:border-indigo-500/30 dark:bg-indigo-500/5">
            <span className="label mb-0">
              {t("Tutar {from} → {to}. Bu değişiklik:", { from: formatMoney(currentAmount ?? 0), to: formatMoney(value ?? 0) })}
            </span>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" checked={changeMode === "from"} onChange={() => setChangeMode("from")} />
              <span>{t("şu tarihten itibaren geçerli (zam / artış)")}</span>
              <input
                id="rec-change-from"
                type="date"
                className={`input ml-auto w-40 py-1 ${bad("rec-change-from")}`}
                value={changeFrom}
                disabled={changeMode !== "from"}
                onChange={(e) => {
                  changeFromTouched.current = true;
                  setChangeFrom(e.target.value);
                }}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" checked={changeMode === "all"} onChange={() => setChangeMode("all")} />
              <span>{t("tüm aylar için düzeltme (yanlış girmiştim)")}</span>
            </label>
            <p className="text-xs text-zinc-500">
              {changeMode === "from"
                ? !changeFrom
                  ? t("Yeni tutarın geçerli olacağı tarihi seçin.")
                  : `${t("{date} öncesi aylar eski tutarla, sonrası yeni tutarla hesaplanır. İleri bir tarih seçerek gelecekteki zammı önceden girebilirsiniz.", {
                      date: formatDate(changeFrom),
                    })}${
                      type === "income" && coversPrev
                        ? ` ${t("Önceki ayın karşılığı olan gelirde tarih maaşın ait olduğu aydır (Ocak maaşı = 10 Şubat'ta yatan).")}`
                        : ""
                    }`
                : t("Geçmiş aylar dahil tüm hesaplar yeni tutarla yapılır; değişiklik geçmişi silinir.")}
            </p>
          </section>
        )}

        {item && history.length > 0 && (
          <section className="space-y-1.5">
            <span className="label mb-0">{t("Tutar geçmişi")}</span>
            <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
              <li className="flex items-center justify-between px-3 py-1.5 text-zinc-500">
                <span>{t("Başlangıç tutarı")}</span>
                <span className="tabular-nums">{formatMoney(item.amount)}</span>
              </li>
              {history.map((h) => (
                <li key={h.from} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="flex-1">
                    {t("{date}'den itibaren", { date: formatDate(h.from) })}
                    {h.from > today && (
                      <span className="ml-1.5 rounded-full bg-indigo-50 px-1.5 text-[10px] font-medium text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
                        {t("gelecek")}
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums">{formatMoney(h.amount)}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("Bu değişikliği kaldır")}
                    aria-label={t("Değişikliği kaldır")}
                    onClick={() => {
                      setHistory(history.filter((x) => x.from !== h.from));
                      // Tutar alanı yeni geçmişe göre bugünkü tutarla (Rust) dolar; gelene kadar boş
                      amountTouched.current = false;
                      setAmount("");
                    }}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
            {futureChanges.length > 0 && (
              <p className="text-xs text-zinc-500">{t("Ödeme takvimi gelecekteki değişiklikleri ilgili aylardan itibaren kullanır.")}</p>
            )}
          </section>
        )}

        {item && (
          <details className="space-y-2" open={exceptions.length > 0 || exDirty}>
            <summary className="cursor-pointer text-sm font-medium">{t("Tek aylık fark ekle (ücretsiz izin, ikramiye…)")}</summary>
            <div className="mt-2">
              <span className="label mb-0">{t("Bu aya özel")}</span>
              <p className="text-xs text-zinc-500">
                {type === "income"
                  ? `${t("Ücretsiz izin, eksik maaş veya ikramiye gibi tek aylık farklar için. 0 = o ay hiç yatmayacak.")}${
                      coversPrev ? ` ${t("Ay, maaşın ait olduğu aydır (Kasım = 10 Aralık'ta yatan Kasım maaşı).")}` : ""
                    }`
                  : t("Tek aylık farklı tutar için. 0 = o ay ödenmeyecek.")}
              </p>
            </div>
            {exceptions.length > 0 && (
              <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
                {exceptions.map((e) => (
                  <li key={e.month} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="w-32 shrink-0 capitalize">{monthLabel(e.month)}</span>
                    <input
                      className="input min-w-0 flex-1 py-1 text-xs"
                      placeholder={t("Sebep (ör. Ücretsiz izin)")}
                      maxLength={60}
                      aria-label={t("{month} sebebi", { month: monthLabel(e.month) })}
                      value={e.note === "Yatmayacak" ? "" : e.note}
                      onChange={(ev) => {
                        const note = ev.target.value;
                        setExceptions((xs) => xs.map((x) => (x.month === e.month ? { ...x, note } : x)));
                      }}
                    />
                    <span className={`tabular-nums ${e.amount === 0 ? "font-medium text-rose-600 dark:text-rose-400" : ""}`}>
                      {e.amount === 0 ? t("Yok") : formatMoney(e.amount)}
                    </span>
                    <button
                      type="button"
                      className="icon-btn"
                      title={t("İstisnayı kaldır")}
                      aria-label={t("İstisnayı kaldır")}
                      onClick={() => setExceptions((xs) => xs.filter((x) => x.month !== e.month))}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="grid grid-cols-[1fr_8rem] gap-2">
              <select
                className="input py-1.5 capitalize"
                value={exMonth}
                onChange={(e) => draft(() => setExMonth(e.target.value))}
                aria-label={t("Ay")}
              >
                {monthOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                className="input py-1.5 tabular-nums"
                inputMode="decimal"
                aria-label={t("Bu ayki tutar (0 = yok)")}
                title={t("Bu ayki tutar (0 = yok)")}
                placeholder={t("Tutar")}
                value={exAmount}
                onChange={(e) => draft(() => setExAmount(e.target.value))}
                onKeyDown={exKey}
              />
              <input
                className="input py-1.5"
                placeholder={type === "income" ? t("Not (ör. Ücretsiz izin)") : t("Not")}
                maxLength={60}
                value={exNote}
                onChange={(e) => draft(() => setExNote(e.target.value))}
                onKeyDown={exKey}
              />
              <button type="button" className="btn-secondary px-2.5 py-1.5 text-xs" onClick={addException}>
                <Plus size={14} /> {t("Ekle")}
              </button>
            </div>
            {exDirty && exAmount.trim() && (
              <p className="text-xs text-indigo-600 dark:text-indigo-400">
                {t("{month} için {amount} kaydederken eklenecek.", {
                  month: monthLabel(exMonth),
                  amount: (parseAmount(exAmount) ?? 0) === 0 ? `"${t("yok")}"` : formatMoney(parseAmount(exAmount) ?? 0),
                })}
              </p>
            )}
          </details>
        )}

        {type === "income" && (
          <fieldset className="space-y-1.5 text-sm">
            <legend className="label mb-1">{t("Bu ödeme hangi ayın geliri?")}</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="rec-covers" checked={!coversPrev} onChange={() => setCoversPrev(false)} />
              {t("Yattığı ayın (ör. 10 Ekim'de yatan → Ekim)")}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="rec-covers" checked={coversPrev} onChange={() => setCoversPrev(true)} />
              {t("Bir önceki ayın (ör. 10 Ekim'de yatan → Eylül maaşı)")}
            </label>
          </fieldset>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          {t("Aktif (ödeme takviminde kullan)")}
        </label>
        <label className={`flex items-start gap-2 text-sm ${accountId ? "" : "opacity-50"}`}>
          <input type="checkbox" className="mt-0.5" checked={autoPost && !!accountId} disabled={!accountId} onChange={(e) => setAutoPost(e.target.checked)} />
          <span>
            {t("Günü gelince işlem olarak otomatik kaydet")}
            <span className="block text-xs text-zinc-500">
              {accountId
                ? t("Ödeme günü gelince plan tutarıyla bu hesaba eklenir; ödemeyi o günlerde elle girdiyseniz eklenmez. Açıldığı aydan başlar, sildiğiniz otomatik işlem geri gelmez.")
                : t("Otomatik kayıt için hesap seçin.")}
            </span>
          </span>
        </label>
        {error && (
          <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
