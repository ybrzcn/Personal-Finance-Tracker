import { X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

interface Props {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}

// Açık pencerelerin sırası: Esc yalnız en üstteki pencereyi kapatır (onay penceresi altındaki formu kapatmasın)
const openModals: object[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, footer, width = "max-w-md" }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Formda bir alan değiştiyse arka plana tıklamak pencereyi kapatmaz (girilenler kaybolmasın)
  const dirty = useRef(false);
  // Telefonda klavye açılınca görünür alan küçülür; alttan açılan pencere klavyenin üstünde kalsın
  const [viewport, setViewport] = useState<CSSProperties | undefined>(undefined);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () =>
      setViewport(window.innerWidth < 768 ? { top: vv.offsetTop, height: vv.height, bottom: "auto" } : undefined);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  useEffect(() => {
    const token = {};
    openModals.push(token);
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== token) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab" && panelRef.current) {
        // Odak tuzağı: Tab pencerenin dışına çıkmaz
        const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    // İlk form alanına odaklan
    const panel = panelRef.current;
    const first =
      panel?.querySelector<HTMLElement>("[data-autofocus]") ??
      panel?.querySelector<HTMLElement>("input, select, textarea");
    first?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      openModals.splice(openModals.indexOf(token), 1);
      // Kapanınca odak pencereyi açan düğmeye döner
      if (opener && document.contains(opener)) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    // Telefonda alttan açılan tam genişlik sayfa, geniş ekranda ortada pencere
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-4" style={viewport}>
      <div className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[2px] animate-fade-in" onClick={() => !dirty.current && onClose()} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onInput={() => (dirty.current = true)}
        onChange={() => (dirty.current = true)}
        className={`card relative flex max-h-[92%] w-full flex-col rounded-b-none md:max-h-[calc(100vh-2rem)] md:rounded-b-2xl ${width} animate-pop-in shadow-xl`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Kapat">
            <X size={18} />
          </button>
        </div>
        {/* Uzun formlarda başlık ve düğmeler sabit kalır, içerik kayar */}
        <div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-zinc-200 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-zinc-800">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
