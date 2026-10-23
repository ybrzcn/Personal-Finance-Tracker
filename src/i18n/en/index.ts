// İngilizce çeviriler: anahtar Türkçe metin, değer İngilizcesi. Parçalar ayrı dosyalarda (aynı anahtar iki parçada olmasın).
// `messages.json`: Rust'tan ve sunucudan gelen metinler (hata, etiket); `{ad}` yer tutuculu kalıplar olabilir. tm() yalnız
// buna bakar; aynı Türkçe metin arayüzde başka anlamda geçiyorsa (ör. "Düzenli gider" tek kayıt / toplam) iki dosyada da olabilir.
import common from "./common.json";
import forms from "./forms.json";
import messages from "./messages.json";
import pagesA from "./pages-a.json";
import pagesB from "./pages-b.json";
import settings from "./settings.json";

export const en: Record<string, string> = { ...messages, ...common, ...forms, ...pagesA, ...pagesB, ...settings };
export const enMessages: Record<string, string> = messages;
