// Açılış betiği (index.html'deki satır içi scriptler; CSP 'script-src self' ile uyumlu olsun diye ayrı dosya).
// Tema yanıp sönmesini (flash) önlemek için React yüklenmeden önce uygula
try {
  var s = JSON.parse(localStorage.getItem("finans-settings") || "{}");
  var t = s.theme || "system";
  if (t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.classList.add("dark");
  }
} catch (e) {}
// Uygulama yüklenemezse siyah ekran yerine hatayı göster (ör. eksik modül, beklenmeyen hata)
(function () {
  function show(msg) {
    var root = document.getElementById("root");
    if (!root || (root.children.length && !document.getElementById("boot-msg"))) return;
    root.innerHTML =
      '<div style="font:14px -apple-system,system-ui,sans-serif;color:#f4f4f5;background:#18181b;max-width:640px;margin:15vh auto;padding:20px;border-radius:12px;border:1px solid #3f3f46">' +
      "<strong>Finans açılamadı</strong><p style=\"color:#a1a1aa\">Sayfayı yenileyip tekrar deneyin; sorun sürerse bu metni geliştiriciye iletin.</p>" +
      '<pre style="white-space:pre-wrap;color:#fda4af;font-size:12px">' +
      String(msg).replace(/[<&]/g, function (c) { return c === "<" ? "&lt;" : "&amp;"; }) +
      "</pre></div>";
  }
  window.addEventListener("error", function (e) { show((e.error && e.error.stack) || e.message || e); });
  window.addEventListener("unhandledrejection", function (e) { show((e.reason && e.reason.stack) || e.reason); });
  // 20 sn içinde arayüz gelmezse
  setTimeout(function () { if (document.getElementById("boot-msg")) show("Arayüz 20 saniyede yüklenemedi. İnternet bağlantınızı kontrol edip sayfayı yenileyin."); }, 20000);
})();
