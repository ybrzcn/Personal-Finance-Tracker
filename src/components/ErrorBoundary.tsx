import { AlertTriangle, Bug, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { logError } from "../lib/errorLog";
import { ErrorReportDialog } from "./ErrorReportDialog";

interface State {
  error: Error | null;
  reporting: boolean;
}

/** Beklenmeyen bir arayüz hatasında boş/siyah ekran yerine hata mesajı ve yeniden yükleme sunar. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, reporting: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Arayüz hatası:", error, info.componentStack);
    const withStack = Object.assign(new Error(error.message), { stack: `${error.stack ?? ""}\n${info.componentStack ?? ""}` });
    logError(withStack, "arayüz");
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="card w-full max-w-md p-6 text-center">
          <AlertTriangle className="mx-auto mb-3 text-rose-500" />
          <p className="font-medium">Beklenmeyen bir hata oluştu</p>
          <p className="mt-1 text-sm text-zinc-500">Verileriniz güvende; yeniden yükleyerek devam edebilirsiniz.</p>
          <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-zinc-100 p-2 text-left text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {error.message}
          </pre>
          <div className="mt-4 flex justify-center gap-2">
            <button className="btn-secondary" onClick={() => this.setState({ reporting: true })}>
              <Bug size={16} /> Hatayı bildir
            </button>
            <button className="btn-primary" onClick={() => location.reload()}>
              <RotateCcw size={16} /> Yeniden yükle
            </button>
          </div>
          {this.state.reporting && <ErrorReportDialog page="arayüz hatası" onClose={() => this.setState({ reporting: false })} />}
        </div>
      </div>
    );
  }
}
