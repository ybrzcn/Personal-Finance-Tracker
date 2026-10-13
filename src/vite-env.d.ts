/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "http": web derlemesi (finans-server API'si); boş: masaüstü veya geliştirme */
  readonly VITE_BACKEND?: string;
  /** Masaüstü/mobil ilk açılışta hazır gelen resmi sunucu adresi */
  readonly VITE_DEFAULT_SERVER_URL?: string;
}
