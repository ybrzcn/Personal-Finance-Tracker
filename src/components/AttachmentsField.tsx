import { Camera, Download, FileText, Paperclip, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { saveBinaryFile } from "../lib/fileio";
import { formatDate } from "../lib/format";
import { isMobile } from "../lib/platform";
import type { Attachment, ReceiptHint } from "../lib/types";
import { useAttachmentCounts } from "../state/attachments";
import { useSettings } from "../state/settings";

const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_COUNT = 10;

const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Belge satırı */
const Row = ({ name, size, date, pdf, onOpen, onRemove }: { name: string; size: number; date?: string; pdf: boolean; onOpen(): void; onRemove(): void }) => (
  <li className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm dark:border-zinc-800">
    {pdf ? <FileText size={15} className="shrink-0 text-rose-500" /> : <Paperclip size={15} className="shrink-0 text-zinc-400" />}
    <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={onOpen} title={name}>
      {name}
    </button>
    <span className="shrink-0 text-xs tabular-nums text-zinc-500">
      {sizeLabel(size)}
      {date ? ` · ${formatDate(date.slice(0, 10))}` : " · kaydedilince yüklenecek"}
    </span>
    <button type="button" className="icon-btn" title="Kaldır" aria-label={`${name} kaldır`} onClick={onRemove}>
      <Trash2 size={14} />
    </button>
  </li>
);

/**
 * İşlemin belgeleri (fiş, fatura): kayıtlı işlemde seçilen dosya hemen yüklenir; yeni işlemde `pending`'de bekler ve
 * işlem kaydedilince yüklenir. PDF seçilince belgedeki toplam ve tarih öneri olarak `onHint` ile bildirilir.
 */
export function AttachmentsField({
  transactionId,
  pending,
  onPending,
  onHint,
}: {
  transactionId: string | null;
  pending: File[];
  onPending(files: File[]): void;
  onHint(hint: ReceiptHint, name: string): void;
}) {
  const { reload } = useAttachmentCounts();
  const [saved, setSaved] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<{ name: string; url: string; pdf: boolean; a?: Attachment; file?: File } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const hintSeq = useRef(0);

  useEffect(() => {
    if (!transactionId) return;
    api
      .listAttachments(transactionId)
      .then(setSaved)
      .catch((e) => setError(errorMessage(e)));
  }, [transactionId]);
  // Escape yalnız önizlemeyi kapatır (formun penceresine ulaşmaz)
  useEffect(() => {
    if (!view) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setView(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [view]);
  // Kapatılan önizlemenin adresi bırakılır
  useEffect(
    () => () => {
      if (view) URL.revokeObjectURL(view.url);
    },
    [view],
  );

  const count = saved.length + pending.length;
  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    const list = [...files];
    const tooBig = list.find((f) => f.size > MAX_BYTES);
    if (tooBig) return setError(`${tooBig.name}: dosya 10 MB'tan büyük olamaz.`);
    if (count + list.length > MAX_COUNT) return setError("Bir işleme en çok 10 belge eklenebilir.");
    // PDF'ten öneri (yalnız ilk PDF; metni olmayan PDF'te sessizce geçilir)
    const pdf = list.find((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
    if (pdf) {
      // Art arda seçimde yalnız son PDF'in önerisi gösterilir
      const n = ++hintSeq.current;
      api
        .parseReceipt(pdf)
        .then((h) => n === hintSeq.current && (h.amount !== null || h.date !== null) && onHint(h, pdf.name))
        .catch(() => {});
    }
    if (!transactionId) return onPending([...pending, ...list]);
    setBusy(true);
    try {
      const added: Attachment[] = [];
      for (const f of list) added.push(await api.addAttachment(transactionId, f));
      setSaved((xs) => [...xs, ...added]);
      reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const open = async (a: Attachment) => {
    try {
      const blob = await api.attachmentContent(a);
      setView({ name: a.name, url: URL.createObjectURL(blob), pdf: a.mime === "application/pdf", a });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const openPending = (f: File) => setView({ name: f.name, url: URL.createObjectURL(f), pdf: f.type === "application/pdf", file: f });
  const remove = async (a: Attachment) => {
    try {
      await api.deleteAttachment(a.id);
      setSaved((xs) => xs.filter((x) => x.id !== a.id));
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const download = async () => {
    if (!view) return;
    try {
      const blob = view.a ? await api.attachmentContent(view.a) : view.file!;
      await saveBinaryFile(view.name, blob);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="label mb-0">Belgeler</span>
        <div className="flex gap-1">
          {isMobile && (
            <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy || count >= MAX_COUNT} onClick={() => cameraRef.current?.click()}>
              <Camera size={14} /> Fotoğraf çek
            </button>
          )}
          <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy || count >= MAX_COUNT} onClick={() => fileRef.current?.click()}>
            <Paperclip size={14} /> {busy ? "Yükleniyor…" : "Belge ekle"}
          </button>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        aria-label="Belge seç"
        onChange={(e) => {
          void pick(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void pick(e.target.files);
          e.target.value = "";
        }}
      />
      {count > 0 ? (
        <ul className="mt-1.5 space-y-1">
          {saved.map((a) => (
            <Row key={a.id} name={a.name} size={a.size} date={a.createdAt} pdf={a.mime === "application/pdf"} onOpen={() => void open(a)} onRemove={() => void remove(a)} />
          ))}
          {pending.map((f, i) => (
            <Row
              key={`${f.name}-${i}`}
              name={f.name}
              size={f.size}
              pdf={f.type === "application/pdf"}
              onOpen={() => openPending(f)}
              onRemove={() => onPending(pending.filter((_, k) => k !== i))}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-zinc-500">Fiş ya da fatura (fotoğraf veya PDF, en çok 10 MB). PDF'teki toplam ve tarih öneri olarak gelir.</p>
      )}
      {error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{error}</p>}

      {view && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-black/80 p-4" role="dialog" aria-label={view.name}>
          <div className="mb-2 flex items-center gap-2 text-white">
            <span className="min-w-0 flex-1 truncate text-sm">{view.name}</span>
            {!isMobile && (
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => void download()}>
                <Download size={14} /> Kaydet
              </button>
            )}
            <button type="button" className="icon-btn text-white" aria-label="Kapat" onClick={() => setView(null)}>
              <X size={18} />
            </button>
          </div>
          {view.pdf ? (
            <iframe title={view.name} src={view.url} className="min-h-0 flex-1 rounded-lg bg-white" />
          ) : (
            <img src={view.url} alt={view.name} className="mx-auto min-h-0 max-w-full flex-1 object-contain" />
          )}
        </div>
      )}
    </div>
  );
}

/** Yeni işlem kaydedildikten sonra bekleyen belgeleri yükler; hata olursa yüklenemeyenlerin adları döner */
export async function uploadPending(transactionId: string, files: File[]): Promise<string[]> {
  const failed: string[] = [];
  for (const f of files) {
    try {
      await api.addAttachment(transactionId, f);
    } catch {
      failed.push(f.name);
    }
  }
  return failed;
}

/** Öneri satırı: "Belgede ₺X · tarih — Uygula" */
export function ReceiptHintBar({ hint, name, onApply, onDismiss }: { hint: ReceiptHint; name: string; onApply(): void; onDismiss(): void }) {
  const { formatMoney } = useSettings();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-800 dark:bg-indigo-500/10 dark:text-indigo-300">
      <FileText size={14} />
      <span className="min-w-0 flex-1">
        {name}: {hint.amount !== null && <strong>{formatMoney(hint.amount)}</strong>}
        {hint.amount !== null && hint.date && " · "}
        {hint.date && formatDate(hint.date)}
      </span>
      <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={onApply}>
        Uygula
      </button>
      <button type="button" className="icon-btn" aria-label="Öneriyi kapat" onClick={onDismiss}>
        <X size={14} />
      </button>
    </div>
  );
}
