import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installErrorLog } from "./lib/errorLog";
import { AuthGate } from "./state/auth";
import { DataProvider } from "./state/data";
import { SettingsProvider } from "./state/settings";
import { UIProvider } from "./state/ui";
import "./index.css";

// Yakalanmamış hatalar "Hata bildir" raporu için yerelde kaydedilir
installErrorLog();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthGate>
        <DataProvider>
          <SettingsProvider>
            <UIProvider>
              <App />
            </UIProvider>
          </SettingsProvider>
        </DataProvider>
      </AuthGate>
    </ErrorBoundary>
  </React.StrictMode>,
);
