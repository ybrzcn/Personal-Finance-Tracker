import { createContext } from "react";
import type { DataCtx } from "./data";
import type { SettingsCtx } from "./settings";
import type { UICtx } from "./ui";

/*
 * Context nesneleri ayrı modülde: Vite canlı güncellemede (HMR) data/ui/settings modüllerini yeniden
 * çalıştırsa bile bu modül (yalnızca tip içe aktardığı için) yeniden çalışmaz ve context kimliği
 * sabit kalır. Aksi halde sağlayıcı eski, tüketici yeni context'i arar ve uygulama boş ekranda kalır.
 */
export const DataContext = createContext<DataCtx | null>(null);
export const UIContext = createContext<UICtx | null>(null);
export const SettingsContext = createContext<SettingsCtx | null>(null);
