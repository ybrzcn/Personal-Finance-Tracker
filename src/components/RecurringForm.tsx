import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, errorMessage } from "../lib/api";
import { amountToInput, formatDate, formatDateShort, formatMonthYear, parseAmount, parseQuantity, todayISO } from "../lib/format";
import { isForeign, isFund, qtyDecimals, qtyRule, unitOf } from "../lib/fx";
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
      setError("Bu ayki tutarı yazın (o ay hiç yoksa 0).");
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
  const [accountId, setAccountId] = useState(item?.accountId ?? accounts.find((a) => a.kind === "bank" && !a.archived && !isFund(a.currency))?.id ?? "");
  // Yeni maaşta kategori "Maaş" ile gelir
  const [categoryId, setCategoryId] = useState(
    item?.categoryId ?? (defaultType === "income" ? (categories.find((c) => c.type === "income" && c.name === "Maaş")?.id ?? "") : ""),
  );
  const [active, setActive] = useState(item?.active ?? true);
  const [coversPrev, setCoversPrev] = useState(item?.coversPreviousMonth ?? false);
  const [weekendShift, setWeekendShift] = useState<WeekendShift>(item?.weekendShift ?? "none");
  // Yeni kayıt bugünden başlar: uygulamanın kullanılmadığı geçmiş aylara plan yazılmaz
  const [startDate, setStartDate] = useState(item ? (item.startDate ?? "") : today);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Döviz/altın hesabında miktar kendi biriminde; TL tutarı planlar için güncel alışla tahmin edilir
  const { rates } = useRates();
  const cur = accounts.find((a) => a.id === accountId)?.currency ?? "TRY";
  const foreign = isForeign(cur);
  const unitLabel = unitOf(cur) === "currency" ? cur : unitOf(cur) === "gram" ? "gram" : "adet";
  const [qty, setQty] = useState(item?.origAmount != null ? String(item.origAmount).replace(".", ",") : "");
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
      ? `Önümüzdeki 6 ayda: ${moves.map((m) => `${formatDateShort(m.from)} → ${formatDateShort(m.to)}`).join(", ")}`
      : "Önümüzdeki 6 ayda hafta sonuna denk gelen gün yok.";
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
        return setError(`Hesap yapılamadı: ${errorMessage(err)}`);
      }
    }
    const amountChanged = fresh?.amountChanged ?? false;
    const d = Number.parseInt(day, 10);
    if (!name.trim()) return fail("Bir ad yazın (ör. Maaş).", "rec-name");
    if (foreign && !(qtyVal && qtyVal > 0)) return fail(`Miktar girin (${unitLabel}, ${qtyRule(cur)}).`, "rec-qty");
    if (val === null || val <= 0) return fail("Geçerli bir tutar girin (ör. 62.000,00).", "rec-amount");
    if (!(d >= 1 && d <= 31)) return fail("Ayın günü 1 ile 31 arasında olmalı.", "rec-day");
    if (item && amountChanged && changeMode === "from" && !from)
      return fail("Yeni tutarın geçerli olacağı tarihi seçin.", "rec-change-from");
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
    };
    try {
      if (item) {
        await updateRecurring({ ...payload, id: item.id });
        onSaved("Kayıt güncellendi.");
      } else {
        await addRecurring(payload);
        onSaved(type === "income" ? "Düzenli gelir eklendi." : "Düzenli gider eklendi.");
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
      title: `${item.name} silinsin mi?`,
      message: "Düzenli kayıt, tutar geçmişi ve aya özel istisnalarıyla birlikte silinir. Girilmiş işlemler silinmez.",
      confirmLabel: "Sil",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteRecurring(item.id);
      onSaved("Kayıt silindi.");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal
      title={item ? "Düzenli Kaydı Düzenle" : type === "income" ? "Düzenli Gelir" : "Düzenli Gider"}
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          {item && (
            <button type="button" className="btn-ghost mr-auto text-rose-600" onClick={remove}>
              <Trash2 size={15} /> Sil
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>
            Vazgeç
          </button>
          <button type="submit" form="rec-form" className="btn-primary" disabled={saving}>
            {item ? "Kaydet" : "Ekle"}
          </button>
        </>
      }
    >
      <form id="rec-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800/70">
          {(["income", "expense"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setType(t);
                setCategoryId("");
              }}
              className={`rounded-lg py-1.5 text-sm font-medium transition ${
                type === t ? "bg-white shadow-sm dark:bg-zinc-900" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {t === "income" ? "Gelir (maaş vb.)" : "Gider (kira, fatura…)"}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="label" htmlFor="rec-name">
              Ad
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
              {foreign ? "Tahmini TL tutarı" : "Tutar"}
            </label>
            <MoneyInput
              id="rec-amount"
              className={bad("rec-amount")}
              aria-invalid={errorField === "rec-amount" || undefined}
              placeholder="0,00"
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
              Ayın kaçında
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
              Hafta sonuna denk gelirse
            </label>
            <select
              id="rec-weekend"
              className="input"
              value={weekendShift}
              onChange={(e) => setWeekendShift(e.target.value as WeekendShift)}
            >
              <option value="none">Aynı gün</option>
              <option value="before">Önceki Cuma ({type === "income" ? "ör. maaş Cuma yatar" : "Cuma ödenir"})</option>
              <option value="after">Sonraki Pazartesi</option>
            </select>
            {weekendShift !== "none" && weekendNote && <p className="mt-1 text-xs text-zinc-500">{weekendNote}</p>}
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="rec-start">
              Başlangıç tarihi
            </label>
            <input id="rec-start" type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            <p className="mt-1 text-xs text-zinc-500">
              {startDate
                ? `${formatDate(startDate)} öncesindeki aylara (bütçe, ödeme takvimi) yansımaz.`
                : "Boş bırakılırsa geçmiş tüm aylara uygulanır."}
            </p>
          </div>
          <div>
            <label className="label" htmlFor="rec-account">
              Hesap
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
                Miktar ({unitLabel})
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
              <p className="mt-1 text-xs text-zinc-500">TL tutarı planlar için güncel alış kuruyla tahmin edilir; kayıt girilirken o günün kuru kullanılır.</p>
            </div>
          )}
          <div>
            <label className="label" htmlFor="rec-category">
              Kategori
            </label>
            <select id="rec-category" className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Kategorisiz</option>
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
              Tutar {formatMoney(currentAmount ?? 0)} → {formatMoney(value ?? 0)}. Bu değişiklik:
            </span>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" checked={changeMode === "from"} onChange={() => setChangeMode("from")} />
              <span>şu tarihten itibaren geçerli (zam / artış)</span>
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
              <span>tüm aylar için düzeltme (yanlış girmiştim)</span>
            </label>
            <p className="text-xs text-zinc-500">
              {changeMode === "from"
                ? !changeFrom
                  ? "Yeni tutarın geçerli olacağı tarihi seçin."
                  : `${formatDate(changeFrom)} öncesi aylar eski tutarla, sonrası yeni tutarla hesaplanır. İleri bir tarih seçerek gelecekteki zammı önceden girebilirsiniz.${
                      type === "income" && coversPrev
                        ? " Önceki ayın karşılığı olan gelirde tarih maaşın ait olduğu aydır (Ocak maaşı = 10 Şubat'ta yatan)."
                        : ""
                    }`
                : "Geçmiş aylar dahil tüm hesaplar yeni tutarla yapılır; değişiklik geçmişi silinir."}
            </p>
          </section>
        )}

        {item && history.length > 0 && (
          <section className="space-y-1.5">
            <span className="label mb-0">Tutar geçmişi</span>
            <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
              <li className="flex items-center justify-between px-3 py-1.5 text-zinc-500">
                <span>Başlangıç tutarı</span>
                <span className="tabular-nums">{formatMoney(item.amount)}</span>
              </li>
              {history.map((h) => (
                <li key={h.from} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="flex-1">
                    {formatDate(h.from)}'den itibaren
                    {h.from > today && (
                      <span className="ml-1.5 rounded-full bg-indigo-50 px-1.5 text-[10px] font-medium text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
                        gelecek
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums">{formatMoney(h.amount)}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Bu değişikliği kaldır"
                    aria-label="Değişikliği kaldır"
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
              <p className="text-xs text-zinc-500">Ödeme takvimi gelecekteki değişiklikleri ilgili aylardan itibaren kullanır.</p>
            )}
          </section>
        )}

        {item && (
          <details className="space-y-2" open={exceptions.length > 0 || exDirty}>
            <summary className="cursor-pointer text-sm font-medium">Tek aylık fark ekle (ücretsiz izin, ikramiye…)</summary>
            <div className="mt-2">
              <span className="label mb-0">Bu aya özel</span>
              <p className="text-xs text-zinc-500">
                {type === "income"
                  ? `Ücretsiz izin, eksik maaş veya ikramiye gibi tek aylık farklar için. 0 = o ay hiç yatmayacak.${
                      coversPrev ? " Ay, maaşın ait olduğu aydır (Kasım = 10 Aralık'ta yatan Kasım maaşı)." : ""
                    }`
                  : "Tek aylık farklı tutar için. 0 = o ay ödenmeyecek."}
              </p>
            </div>
            {exceptions.length > 0 && (
              <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
                {exceptions.map((e) => (
                  <li key={e.month} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="w-32 shrink-0 capitalize">{monthLabel(e.month)}</span>
                    <input
                      className="input min-w-0 flex-1 py-1 text-xs"
                      placeholder="Sebep (ör. Ücretsiz izin)"
                      maxLength={60}
                      aria-label={`${monthLabel(e.month)} sebebi`}
                      value={e.note === "Yatmayacak" ? "" : e.note}
                      onChange={(ev) => {
                        const note = ev.target.value;
                        setExceptions((xs) => xs.map((x) => (x.month === e.month ? { ...x, note } : x)));
                      }}
                    />
                    <span className={`tabular-nums ${e.amount === 0 ? "font-medium text-rose-600 dark:text-rose-400" : ""}`}>
                      {e.amount === 0 ? "Yok" : formatMoney(e.amount)}
                    </span>
                    <button
                      type="button"
                      className="icon-btn"
                      title="İstisnayı kaldır"
                      aria-label="İstisnayı kaldır"
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
                aria-label="Ay"
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
                aria-label="Bu ayki tutar (0 = yok)"
                title="Bu ayki tutar (0 = yok)"
                placeholder="Tutar"
                value={exAmount}
                onChange={(e) => draft(() => setExAmount(e.target.value))}
                onKeyDown={exKey}
              />
              <input
                className="input py-1.5"
                placeholder={type === "income" ? "Not (ör. Ücretsiz izin)" : "Not"}
                maxLength={60}
                value={exNote}
                onChange={(e) => draft(() => setExNote(e.target.value))}
                onKeyDown={exKey}
              />
              <button type="button" className="btn-secondary px-2.5 py-1.5 text-xs" onClick={addException}>
                <Plus size={14} /> Ekle
              </button>
            </div>
            {exDirty && exAmount.trim() && (
              <p className="text-xs text-indigo-600 dark:text-indigo-400">
                {monthLabel(exMonth)} için {(parseAmount(exAmount) ?? 0) === 0 ? '"yok"' : formatMoney(parseAmount(exAmount) ?? 0)}{" "}
                kaydederken eklenecek.
              </p>
            )}
          </details>
        )}

        {type === "income" && (
          <fieldset className="space-y-1.5 text-sm">
            <legend className="label mb-1">Bu ödeme hangi ayın geliri?</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="rec-covers" checked={!coversPrev} onChange={() => setCoversPrev(false)} />
              Yattığı ayın (ör. 10 Ekim'de yatan → Ekim)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="rec-covers" checked={coversPrev} onChange={() => setCoversPrev(true)} />
              Bir önceki ayın (ör. 10 Ekim'de yatan → Eylül maaşı)
            </label>
          </fieldset>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Aktif (ödeme takviminde kullan)
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
